const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const MAX_MONITORING_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_HISTORY = 100;
const ALERT_CONDITIONS = new Set([
  'CRITICAL',
  'BREACH',
  'WARNING',
  'OVERDUE_RISK',
  'NO_LIMIT',
  'STALE_REVIEW'
]);
const SEVERITY_RANK = Object.freeze({
  REVIEW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
});

function safeCategory(error) {
  const category = error?.category;
  return typeof category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(category)
    ? category : 'monitoring_source_error';
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.trim();
}

function runSummary(result) {
  return JSON.stringify({
    status: result.status,
    source: result.source,
    retrievedAt: result.retrievedAt,
    sourceTimestamp: result.sourceTimestamp,
    freshness: result.freshness,
    rulesVersion: result.rulesVersion,
    ...result.summary
  });
}

async function findRunBySlot(db, slotKey) {
  return (await db.run(SELECT.one.from('credit.MonitoringRuns').where({ slotKey }))) || null;
}

async function createMonitoringRun(db, {
  slotKey,
  runKind,
  source,
  triggeredBy,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS
}) {
  requireIdentifier(slotKey, 'Monitoring slot key');
  if (!['MANUAL', 'SCHEDULED', 'RECOVERY'].includes(runKind)) {
    throw new TypeError('Monitoring run kind is invalid.');
  }
  const actor = requireIdentifier(triggeredBy, 'Monitoring actor');
  const id = randomUUID();
  const startedAt = now.toISOString();
  const entry = {
    ID: id,
    slotKey,
    runKind,
    status: 'RUNNING',
    source: source || null,
    startedAt,
    rulesVersion: '1',
    attemptCount: 1,
    recoveryStatus: 'ACTIVE',
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    triggeredBy: actor
  };
  try {
    await db.run(INSERT.into('credit.MonitoringRuns').entries(entry));
    return { run: entry, created: true };
  } catch (error) {
    const existing = await findRunBySlot(db, slotKey);
    if (existing) return { run: existing, created: false };
    throw error;
  }
}

function alertValues(alert, finding, runId, now) {
  return {
    customerName: finding.customerName,
    severity: finding.severity,
    lastSeenAt: now,
    lastRun_ID: runId,
    currency: finding.currency,
    exposure: finding.exposure,
    creditLimit: finding.creditLimit,
    utilisation: finding.utilisation,
    overdueAmount: finding.overdueAmount,
    ...(alert.status === 'RESOLVED'
      ? {
        status: 'ACTIVE',
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null
      }
      : {})
  };
}

async function addAlertEvent(tx, { alertId, runId, type, actorId, now, details }) {
  await tx.run(INSERT.into('credit.MonitoringAlertEvents').entries({
    ID: randomUUID(),
    alert_ID: alertId,
    run_ID: runId || null,
    eventType: type,
    actor_ID: actorId,
    createdAt: now,
    details: details || null
  }));
}

async function addOutbox(tx, { alertId, runId, eventType, now }) {
  const idempotencyKey = `${alertId}:${runId}:${eventType}`;
  await tx.run(INSERT.into('credit.MonitoringNotificationOutbox').entries({
    ID: randomUUID(),
    idempotencyKey,
    alert_ID: alertId,
    channel: 'IN_APP',
    status: 'PENDING',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  }));
}

async function synchronizeAlerts(tx, result, runId, actorId, now) {
  const activeConditions = new Set();
  for (const finding of result.findings) {
    for (const condition of finding.conditions.filter(value => ALERT_CONDITIONS.has(value))) {
      const key = `${finding.customerId}\u0000${condition}`;
      activeConditions.add(key);
      const existing = (await tx.run(SELECT.one.from('credit.MonitoringAlerts')
        .where({ customer_ID: finding.customerId, conditionKey: condition }))) || null;
      if (!existing) {
        const alertId = randomUUID();
        await tx.run(INSERT.into('credit.MonitoringAlerts').entries({
          ID: alertId,
          customer_ID: finding.customerId,
          customerName: finding.customerName,
          conditionKey: condition,
          severity: finding.severity,
          status: 'ACTIVE',
          firstSeenAt: now,
          lastSeenAt: now,
          lastRun_ID: runId,
          currency: finding.currency,
          exposure: finding.exposure,
          creditLimit: finding.creditLimit,
          utilisation: finding.utilisation,
          overdueAmount: finding.overdueAmount
        }));
        await addAlertEvent(tx, {
          alertId, runId, type: 'CREATED', actorId, now, details: condition
        });
        await addOutbox(tx, { alertId, runId, eventType: 'CREATED', now });
        continue;
      }

      const reopened = existing.status === 'RESOLVED';
      const severityChanged = existing.severity !== finding.severity;
      await tx.run(UPDATE('credit.MonitoringAlerts')
        .set({
          ...alertValues(existing, finding, runId, now),
          ...(severityChanged ? { severity: finding.severity } : {})
        })
        .where({ ID: existing.ID, status: existing.status }));
      if (reopened) {
        await addAlertEvent(tx, {
          alertId: existing.ID, runId, type: 'REOPENED', actorId, now, details: condition
        });
        await addOutbox(tx, { alertId: existing.ID, runId, eventType: 'REOPENED', now });
      } else if (severityChanged) {
        const escalated = (SEVERITY_RANK[finding.severity] || 0)
          > (SEVERITY_RANK[existing.severity] || 0);
        const eventType = escalated ? 'ESCALATED' : 'UPDATED';
        await addAlertEvent(tx, {
          alertId: existing.ID, runId, type: eventType, actorId, now, details: condition
        });
        if (escalated) await addOutbox(tx, { alertId: existing.ID, runId, eventType, now });
      }
    }
  }

  if (result.status !== 'COMPLETED') return;
  const activeAlerts = await tx.run(SELECT.from('credit.MonitoringAlerts'));
  for (const alert of activeAlerts) {
    if (!['ACTIVE', 'ACKNOWLEDGED'].includes(alert.status)) continue;
    if (activeConditions.has(`${alert.customer_ID}\u0000${alert.conditionKey}`)) continue;
    await tx.run(UPDATE('credit.MonitoringAlerts')
      .set({ status: 'RESOLVED', resolvedAt: now, resolvedBy: actorId, lastRun_ID: runId })
      .where({ ID: alert.ID, status: alert.status }));
    await addAlertEvent(tx, {
      alertId: alert.ID, runId, type: 'RESOLVED', actorId, now, details: 'Condition no longer present'
    });
  }
}

async function completeMonitoringRun(db, runId, result, actorId, now = new Date(), attemptCount) {
  return db.tx(async tx => {
    const run = (await tx.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
    if (!run || run.status !== 'RUNNING' || run.recoveryStatus !== 'ACTIVE'
      || (attemptCount !== undefined && run.attemptCount !== attemptCount)) {
      const error = new Error('Monitoring run is not claimed for completion.');
      error.statusCode = 409;
      throw error;
    }
    await tx.run(DELETE.from('credit.MonitoringFindings').where({ run_ID: runId }));
    for (const finding of result.findings) {
      await tx.run(INSERT.into('credit.MonitoringFindings').entries({
        ID: randomUUID(),
        run_ID: runId,
        customer_ID: finding.customerId,
        customerName: finding.customerName,
        status: finding.status,
        severity: finding.severity,
        conditions: JSON.stringify(finding.conditions),
        exposure: finding.exposure,
        creditLimit: finding.creditLimit,
        utilisation: finding.utilisation,
        overdueAmount: finding.overdueAmount,
        overdueShare: finding.overdueShare,
        currency: finding.currency,
        source: finding.source,
        retrievedAt: finding.retrievedAt
      }));
    }
    await synchronizeAlerts(tx, result, runId, actorId, now.toISOString());
    const completedAt = now.toISOString();
    const recoveryStatus = result.status === 'COMPLETED' ? 'NOT_AVAILABLE' : 'AVAILABLE';
    const changed = await tx.run(UPDATE('credit.MonitoringRuns')
      .set({
        status: result.status,
        source: result.source,
        completedAt,
        retrievedAt: result.retrievedAt,
        sourceTimestamp: result.sourceTimestamp,
        freshness: result.freshness,
        rulesVersion: result.rulesVersion,
        summary: runSummary(result),
        errorCategory: null,
        recoveryStatus,
        leaseUntil: null
      })
      .where({
        ID: runId,
        status: 'RUNNING',
        recoveryStatus: 'ACTIVE',
        ...(attemptCount !== undefined ? { attemptCount } : {})
      }));
    if (changed !== 1) {
      const error = new Error('Monitoring run changed before completion could be committed.');
      error.statusCode = 409;
      throw error;
    }
    return { ...run, status: result.status, completedAt, recoveryStatus };
  });
}

async function failMonitoringRun(db, runId, error, now = new Date(), attemptCount) {
  const run = (await db.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
  if (!run) return null;
  const recoveryStatus = run.attemptCount < MAX_MONITORING_ATTEMPTS ? 'AVAILABLE' : 'NOT_AVAILABLE';
  const changed = await db.run(UPDATE('credit.MonitoringRuns')
    .set({
      status: 'FAILED',
      completedAt: now.toISOString(),
      errorCategory: safeCategory(error),
      recoveryStatus,
      leaseUntil: null
    })
    .where({
      ID: runId,
      status: 'RUNNING',
      recoveryStatus: 'ACTIVE',
      ...(attemptCount !== undefined ? { attemptCount } : {})
    }));
  if (changed !== 1) return null;
  return { ...run, status: 'FAILED', errorCategory: safeCategory(error), recoveryStatus };
}

async function saveMonitoringAdvisory(db, runId, { text, source, errorCategory = null }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000
    || !['AI_ADVISORY', 'DETERMINISTIC'].includes(source)) {
    throw new TypeError('Monitoring advisory summary is invalid.');
  }
  await db.run(UPDATE('credit.MonitoringRuns')
    .set({
      advisorySummary: text.trim(),
      advisorySource: source,
      advisoryErrorCategory: typeof errorCategory === 'string'
        && /^[a-z][a-z0-9_]{0,39}$/.test(errorCategory) ? errorCategory : null
    })
    .where({ ID: runId }));
}

async function getMonitoringRun(db, runId) {
  return (await db.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
}

async function latestMonitoringRun(db) {
  return (await db.run(SELECT.one.from('credit.MonitoringRuns')
    .orderBy('startedAt desc'))) || null;
}

async function latestSuccessfulMonitoringRun(db) {
  return (await db.run(SELECT.one.from('credit.MonitoringRuns')
    .where({ status: 'COMPLETED' })
    .orderBy('completedAt desc'))) || null;
}

async function listMonitoringRuns(db, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    throw new TypeError(`History limit must be between 1 and ${MAX_HISTORY}.`);
  }
  return db.run(SELECT.from('credit.MonitoringRuns').orderBy('startedAt desc').limit(limit));
}

async function listMonitoringFindings(db, runId) {
  return db.run(SELECT.from('credit.MonitoringFindings')
    .where({ run_ID: runId }).orderBy('severity desc, customer_ID asc'));
}

async function listMonitoringAlerts(db, status = 'ACTIVE') {
  if (!['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'ALL'].includes(status)) {
    throw new TypeError('Alert status is invalid.');
  }
  if (status === 'ACTIVE') {
    const [active, acknowledged] = await Promise.all([
      db.run(SELECT.from('credit.MonitoringAlerts').where({ status: 'ACTIVE' })),
      db.run(SELECT.from('credit.MonitoringAlerts').where({ status: 'ACKNOWLEDGED' }))
    ]);
    return [...active, ...acknowledged].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
  const query = SELECT.from('credit.MonitoringAlerts').orderBy('lastSeenAt desc');
  if (status !== 'ALL') query.where({ status });
  return db.run(query);
}

async function getMonitoringAlert(db, alertId) {
  return (await db.run(SELECT.one.from('credit.MonitoringAlerts').where({ ID: alertId }))) || null;
}

async function listMonitoringAlertEvents(db, alertId) {
  return db.run(SELECT.from('credit.MonitoringAlertEvents')
    .where({ alert_ID: alertId }).orderBy('createdAt asc'));
}

async function transitionMonitoringAlert(db, {
  alertId,
  action,
  actorId,
  now = new Date()
}) {
  if (!['ACKNOWLEDGED', 'RESOLVED'].includes(action)) throw new TypeError('Alert action is invalid.');
  const alert = (await db.run(SELECT.one.from('credit.MonitoringAlerts').where({ ID: alertId }))) || null;
  if (!alert) {
    const error = new Error('Monitoring alert was not found.');
    error.statusCode = 404;
    throw error;
  }
  if (alert.status === 'RESOLVED') {
    const error = new Error('A resolved monitoring alert cannot be changed.');
    error.statusCode = 409;
    throw error;
  }
  if (action === 'ACKNOWLEDGED' && alert.status === 'ACKNOWLEDGED') {
    const error = new Error('Monitoring alert is already acknowledged.');
    error.statusCode = 409;
    throw error;
  }
  const at = now.toISOString();
  return db.tx(async tx => {
    const values = action === 'ACKNOWLEDGED'
      ? { status: action, acknowledgedAt: at, acknowledgedBy: actorId }
      : { status: action, resolvedAt: at, resolvedBy: actorId };
    const changed = await tx.run(UPDATE('credit.MonitoringAlerts')
      .set(values).where({ ID: alertId, status: alert.status }));
    if (changed !== 1) {
      const error = new Error('Monitoring alert changed before this action could be applied.');
      error.statusCode = 409;
      throw error;
    }
    await addAlertEvent(tx, {
      alertId, runId: alert.lastRun_ID, type: action, actorId, now: at
    });
    return { ...alert, ...values };
  });
}

async function dispatchNotificationOutbox(db, {
  deliver = async ({ alertId }) => ({
    delivered: Boolean(await getMonitoringAlert(db, alertId))
  }),
  now = new Date(),
  maxAttempts = 3,
  limit = 50
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Outbox processing bounds are invalid.');
  }
  const pending = (await db.run(SELECT.from('credit.MonitoringNotificationOutbox')
    .where({ status: 'PENDING' }).orderBy('createdAt asc').limit(limit)))
    .filter(item => !item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now.getTime());
  const results = [];
  for (const item of pending) {
    const attemptCount = item.attemptCount + 1;
    try {
      const result = await deliver({ alertId: item.alert_ID, channel: item.channel });
      if (!result?.delivered) throw new Error('Notification was not delivered.');
      await db.run(UPDATE('credit.MonitoringNotificationOutbox')
        .set({
          status: 'DELIVERED',
          attemptCount,
          deliveredAt: now.toISOString(),
          updatedAt: now.toISOString(),
          errorCategory: null
        })
        .where({ ID: item.ID, status: 'PENDING' }));
      results.push({ id: item.ID, status: 'DELIVERED' });
    } catch (error) {
      const status = attemptCount >= maxAttempts ? 'FAILED' : 'PENDING';
      const delayMs = Math.min(60_000, 1000 * (2 ** (attemptCount - 1)));
      await db.run(UPDATE('credit.MonitoringNotificationOutbox')
        .set({
          status,
          attemptCount,
          nextAttemptAt: status === 'PENDING'
            ? new Date(now.getTime() + delayMs).toISOString() : null,
          updatedAt: now.toISOString(),
          errorCategory: safeCategory(error)
        })
        .where({ ID: item.ID, status: 'PENDING' }));
      results.push({ id: item.ID, status });
    }
  }
  return results;
}

async function claimMonitoringRecovery(db, runId, now = new Date(), leaseMs = DEFAULT_LEASE_MS) {
  const run = await getMonitoringRun(db, runId);
  if (!run) {
    const error = new Error('Monitoring run was not found.');
    error.statusCode = 404;
    throw error;
  }
  const staleRunning = run.status === 'RUNNING'
    && run.recoveryStatus === 'ACTIVE'
    && run.leaseUntil
    && new Date(run.leaseUntil).getTime() <= now.getTime();
  const recoverable = run.status === 'FAILED' || run.status === 'PARTIAL' || run.status === 'STALE';
  if ((!staleRunning && (!recoverable || run.recoveryStatus !== 'AVAILABLE'))
    || run.attemptCount >= MAX_MONITORING_ATTEMPTS) {
    const error = new Error('Monitoring run is not available for recovery.');
    error.statusCode = 409;
    throw error;
  }
  const attemptCount = run.attemptCount + 1;
  const changed = await db.run(UPDATE('credit.MonitoringRuns')
    .set({
      status: 'RUNNING',
      recoveryStatus: 'ACTIVE',
      attemptCount,
      startedAt: now.toISOString(),
      completedAt: null,
      errorCategory: null,
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString()
    })
    .where({
      ID: runId,
      status: run.status,
      recoveryStatus: run.recoveryStatus,
      attemptCount: run.attemptCount,
      ...(staleRunning ? { leaseUntil: run.leaseUntil } : {})
    }));
  if (changed !== 1) {
    const error = new Error('Monitoring recovery is already in progress.');
    error.statusCode = 409;
    throw error;
  }
  return { ...run, status: 'RUNNING', attemptCount, recoveryStatus: 'ACTIVE' };
}

module.exports = {
  ALERT_CONDITIONS,
  DEFAULT_LEASE_MS,
  MAX_MONITORING_ATTEMPTS,
  claimMonitoringRecovery,
  completeMonitoringRun,
  createMonitoringRun,
  dispatchNotificationOutbox,
  failMonitoringRun,
  getMonitoringRun,
  getMonitoringAlert,
  listMonitoringAlertEvents,
  latestMonitoringRun,
  latestSuccessfulMonitoringRun,
  listMonitoringAlerts,
  listMonitoringFindings,
  listMonitoringRuns,
  saveMonitoringAdvisory,
  transitionMonitoringAlert
};
