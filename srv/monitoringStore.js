const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const MAX_MONITORING_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const WORKER_LOCK_ID = 'PORTFOLIO';
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
    complete: result.complete === true,
    alertResolutionEligible: result.alertResolutionEligible === true,
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
  now = new Date()
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
    status: 'QUEUED',
    source: source || null,
    startedAt,
    rulesVersion: '1',
    attemptCount: 0,
    recoveryStatus: 'AVAILABLE',
    leaseUntil: null,
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

async function ensureMonitoringWorkerLock(db, now = new Date()) {
  const query = SELECT.one.from('credit.MonitoringWorkerLocks').where({ ID: WORKER_LOCK_ID });
  if ((await db.run(query)) || null) return;
  try {
    await db.run(INSERT.into('credit.MonitoringWorkerLocks').entries({
      ID: WORKER_LOCK_ID,
      run_ID: null,
      claimToken: null,
      leaseUntil: new Date(0).toISOString(),
      updatedAt: now.toISOString()
    }));
  } catch (error) {
    if (!await db.run(query)) throw error;
  }
}

function workerLockWhere(lock) {
  return {
    ID: lock.ID,
    run_ID: lock.run_ID,
    claimToken: lock.claimToken,
    leaseUntil: lock.leaseUntil
  };
}

async function releaseMonitoringWorkerLock(tx, runId, claimToken, now) {
  const changed = await tx.run(UPDATE('credit.MonitoringWorkerLocks')
    .set({
      run_ID: null,
      claimToken: null,
      leaseUntil: new Date(0).toISOString(),
      updatedAt: now.toISOString()
    })
    .where({ ID: WORKER_LOCK_ID, run_ID: runId, claimToken }));
  if (changed !== 1) {
    const error = new Error('Monitoring worker claim is no longer active.');
    error.statusCode = 409;
    throw error;
  }
}

async function claimNextMonitoringRun(db, {
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError('Monitoring worker lease is invalid.');
  }
  await ensureMonitoringWorkerLock(db, now);
  return db.tx(async tx => {
    const lock = (await tx.run(SELECT.one.from('credit.MonitoringWorkerLocks')
      .where({ ID: WORKER_LOCK_ID }))) || null;
    if (!lock) throw new Error('Monitoring worker lock is unavailable.');

    const nowIso = now.toISOString();
    const lockIsActive = lock.run_ID
      && new Date(lock.leaseUntil).getTime() > now.getTime();
    if (lockIsActive) return null;

    const orphanedRuns = (await tx.run(SELECT.from('credit.MonitoringRuns')
      .where({ status: 'RUNNING' })
      .orderBy('startedAt asc')
      .limit(MAX_HISTORY)))
      .filter(run => !run.workerToken && run.leaseUntil
        && new Date(run.leaseUntil).getTime() <= now.getTime());
    for (const orphaned of orphanedRuns) {
      const exhausted = orphaned.attemptCount >= MAX_MONITORING_ATTEMPTS;
      await tx.run(UPDATE('credit.MonitoringRuns')
        .set({
          status: exhausted ? 'FAILED' : 'QUEUED',
          recoveryStatus: exhausted ? 'NOT_AVAILABLE' : 'AVAILABLE',
          startedAt: nowIso,
          completedAt: exhausted ? nowIso : null,
          errorCategory: 'worker_lease_expired',
          leaseUntil: null
        })
        .where({
          ID: orphaned.ID,
          status: 'RUNNING',
          attemptCount: orphaned.attemptCount,
          workerToken: null,
          leaseUntil: orphaned.leaseUntil
        }));
    }

    if (lock.run_ID) {
      const expiredRun = (await tx.run(SELECT.one.from('credit.MonitoringRuns')
        .where({ ID: lock.run_ID }))) || null;
      if (expiredRun?.status === 'RUNNING' && expiredRun.workerToken !== lock.claimToken) {
        const error = new Error('Expired monitoring claim does not match the run token.');
        error.statusCode = 409;
        throw error;
      }
      if (expiredRun?.status === 'RUNNING' && expiredRun.workerToken === lock.claimToken) {
        const exhausted = expiredRun.attemptCount >= MAX_MONITORING_ATTEMPTS;
        const changed = await tx.run(UPDATE('credit.MonitoringRuns')
          .set({
            status: exhausted ? 'FAILED' : 'QUEUED',
            recoveryStatus: exhausted ? 'NOT_AVAILABLE' : 'AVAILABLE',
            completedAt: exhausted ? nowIso : null,
            errorCategory: 'worker_lease_expired',
            leaseUntil: null,
            workerToken: null
          })
          .where({
            ID: expiredRun.ID,
            status: 'RUNNING',
            attemptCount: expiredRun.attemptCount,
            workerToken: lock.claimToken
          }));
        if (changed !== 1) return null;
      }
    }

    const queued = (await tx.run(SELECT.from('credit.MonitoringRuns')
      .where({ status: 'QUEUED' })
      .orderBy('startedAt asc')
      .limit(1)))[0] || null;
    if (!queued) {
      if (lock.run_ID) {
        await tx.run(UPDATE('credit.MonitoringWorkerLocks')
          .set({
            run_ID: null,
            claimToken: null,
            leaseUntil: new Date(0).toISOString(),
            updatedAt: nowIso
          })
          .where(workerLockWhere(lock)));
      }
      return null;
    }

    const claimToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const lockChanged = await tx.run(UPDATE('credit.MonitoringWorkerLocks')
      .set({ run_ID: queued.ID, claimToken, leaseUntil, updatedAt: nowIso })
      .where(workerLockWhere(lock)));
    if (lockChanged !== 1) return null;

    const attemptCount = queued.attemptCount + 1;
    const runChanged = await tx.run(UPDATE('credit.MonitoringRuns')
      .set({
        status: 'RUNNING',
        recoveryStatus: 'ACTIVE',
        attemptCount,
        leaseUntil,
        workerToken: claimToken,
        errorCategory: null,
        completedAt: null
      })
      .where({
        ID: queued.ID,
        status: 'QUEUED',
        attemptCount: queued.attemptCount
      }));
    if (runChanged !== 1) {
      await tx.run(UPDATE('credit.MonitoringWorkerLocks')
        .set({
          run_ID: null,
          claimToken: null,
          leaseUntil: new Date(0).toISOString(),
          updatedAt: nowIso
        })
        .where({ ID: WORKER_LOCK_ID, run_ID: queued.ID, claimToken }));
      return null;
    }
    return {
      ...queued,
      status: 'RUNNING',
      recoveryStatus: 'ACTIVE',
      attemptCount,
      leaseUntil,
      workerToken: claimToken
    };
  });
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

  const canResolveAlerts = result.alertResolutionEligible === true
    && result.status === 'COMPLETED'
    && result.complete === true
    && result.freshness === 'FRESH'
    && result.summary?.customersMonitored > 0;
  if (!canResolveAlerts) return;
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

async function completeMonitoringRun(
  db,
  runId,
  result,
  actorId,
  now = new Date(),
  attemptCount,
  workerToken,
  deadlineAt
) {
  return db.tx(async tx => {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      const error = new Error('Monitoring execution exceeded its configured deadline.');
      error.category = 'monitoring_deadline_exceeded';
      error.statusCode = 504;
      throw error;
    }
    const run = (await tx.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
    if (!run || run.status !== 'RUNNING' || run.recoveryStatus !== 'ACTIVE'
      || (attemptCount !== undefined && run.attemptCount !== attemptCount)
      || (workerToken !== undefined && run.workerToken !== workerToken)) {
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
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      const error = new Error('Monitoring execution exceeded its configured deadline.');
      error.category = 'monitoring_deadline_exceeded';
      error.statusCode = 504;
      throw error;
    }
    await synchronizeAlerts(tx, result, runId, actorId, now.toISOString());
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      const error = new Error('Monitoring execution exceeded its configured deadline.');
      error.category = 'monitoring_deadline_exceeded';
      error.statusCode = 504;
      throw error;
    }
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
        leaseUntil: null,
        workerToken: null
      })
      .where({
        ID: runId,
        status: 'RUNNING',
        recoveryStatus: 'ACTIVE',
        ...(attemptCount !== undefined ? { attemptCount } : {}),
        ...(workerToken !== undefined ? { workerToken } : {})
      }));
    if (changed !== 1) {
      const error = new Error('Monitoring run changed before completion could be committed.');
      error.statusCode = 409;
      throw error;
    }
    if (workerToken !== undefined) {
      await releaseMonitoringWorkerLock(tx, runId, workerToken, now);
    }
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      const error = new Error('Monitoring execution exceeded its configured deadline.');
      error.category = 'monitoring_deadline_exceeded';
      error.statusCode = 504;
      throw error;
    }
    return { ...run, status: result.status, completedAt, recoveryStatus };
  });
}

async function failMonitoringRun(db, runId, error, now = new Date(), attemptCount, workerToken) {
  return db.tx(async tx => {
    const run = (await tx.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
    if (!run) return null;
    const recoveryStatus = run.attemptCount < MAX_MONITORING_ATTEMPTS ? 'AVAILABLE' : 'NOT_AVAILABLE';
    const changed = await tx.run(UPDATE('credit.MonitoringRuns')
      .set({
        status: 'FAILED',
        completedAt: now.toISOString(),
        errorCategory: safeCategory(error),
        recoveryStatus,
        leaseUntil: null,
        workerToken: null
      })
      .where({
        ID: runId,
        status: 'RUNNING',
        recoveryStatus: 'ACTIVE',
        ...(attemptCount !== undefined ? { attemptCount } : {}),
        ...(workerToken !== undefined ? { workerToken } : {})
      }));
    if (changed !== 1) return null;
    if (workerToken !== undefined) {
      await releaseMonitoringWorkerLock(tx, runId, workerToken, now);
    }
    return { ...run, status: 'FAILED', errorCategory: safeCategory(error), recoveryStatus };
  });
}

async function requeueMonitoringRun(db, runId, now = new Date(), attemptCount, workerToken) {
  return db.tx(async tx => {
    const run = (await tx.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
    if (!run || run.status !== 'RUNNING' || run.recoveryStatus !== 'ACTIVE'
      || (attemptCount !== undefined && run.attemptCount !== attemptCount)
      || (workerToken !== undefined && run.workerToken !== workerToken)) {
      return null;
    }
    const exhausted = run.attemptCount >= MAX_MONITORING_ATTEMPTS;
    const changed = await tx.run(UPDATE('credit.MonitoringRuns')
      .set({
        status: exhausted ? 'FAILED' : 'QUEUED',
        recoveryStatus: exhausted ? 'NOT_AVAILABLE' : 'AVAILABLE',
        startedAt: exhausted ? run.startedAt : now.toISOString(),
        completedAt: exhausted ? now.toISOString() : null,
        errorCategory: exhausted ? 'worker_shutdown_attempts_exhausted' : null,
        leaseUntil: null,
        workerToken: null
      })
      .where({
        ID: runId,
        status: 'RUNNING',
        recoveryStatus: 'ACTIVE',
        ...(attemptCount !== undefined ? { attemptCount } : {}),
        ...(workerToken !== undefined ? { workerToken } : {})
      }));
    if (changed !== 1) return null;
    if (workerToken !== undefined) {
      await releaseMonitoringWorkerLock(tx, runId, workerToken, now);
    }
    return {
      ...run,
      status: exhausted ? 'FAILED' : 'QUEUED',
      recoveryStatus: exhausted ? 'NOT_AVAILABLE' : 'AVAILABLE',
      completedAt: exhausted ? now.toISOString() : null,
      errorCategory: exhausted ? 'worker_shutdown_attempts_exhausted' : null,
      leaseUntil: null,
      workerToken: null
    };
  });
}

async function queueMonitoringRecovery(db, runId, now = new Date()) {
  return db.tx(async tx => {
    const run = (await tx.run(SELECT.one.from('credit.MonitoringRuns').where({ ID: runId }))) || null;
    if (!run) {
      const error = new Error('Monitoring run was not found.');
      error.statusCode = 404;
      throw error;
    }
    if (!['FAILED', 'PARTIAL', 'STALE'].includes(run.status)
      || run.recoveryStatus !== 'AVAILABLE'
      || run.attemptCount >= MAX_MONITORING_ATTEMPTS) {
      const error = new Error('Monitoring run is not available for recovery.');
      error.statusCode = 409;
      throw error;
    }
    const changed = await tx.run(UPDATE('credit.MonitoringRuns')
      .set({
        status: 'QUEUED',
        recoveryStatus: 'AVAILABLE',
        startedAt: now.toISOString(),
        completedAt: null,
        retrievedAt: null,
        sourceTimestamp: null,
        freshness: null,
        summary: null,
        advisorySummary: null,
        advisorySource: null,
        advisoryErrorCategory: null,
        errorCategory: null,
        leaseUntil: null,
        workerToken: null
      })
      .where({
        ID: runId,
        status: run.status,
        recoveryStatus: 'AVAILABLE',
        attemptCount: run.attemptCount
      }));
    if (changed !== 1) {
      const error = new Error('Monitoring recovery is already in progress.');
      error.statusCode = 409;
      throw error;
    }
    await tx.run(DELETE.from('credit.MonitoringFindings').where({ run_ID: runId }));
    return {
      ...run,
      status: 'QUEUED',
      recoveryStatus: 'AVAILABLE',
      startedAt: now.toISOString(),
      completedAt: null,
      retrievedAt: null,
      sourceTimestamp: null,
      freshness: null,
      summary: null,
      advisorySummary: null,
      advisorySource: null,
      advisoryErrorCategory: null,
      errorCategory: null,
      leaseUntil: null,
      workerToken: null
    };
  });
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
  const result = await db.run(SELECT.one.from('credit.MonitoringRuns')
    .orderBy('startedAt desc'));
  return (Array.isArray(result) ? result[0] : result) || null;
}

async function latestSuccessfulMonitoringRun(db) {
  const result = await db.run(SELECT.one.from('credit.MonitoringRuns')
    .where({ status: 'COMPLETED' })
    .orderBy('completedAt desc'));
  return (Array.isArray(result) ? result[0] : result) || null;
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

module.exports = {
  ALERT_CONDITIONS,
  DEFAULT_LEASE_MS,
  MAX_MONITORING_ATTEMPTS,
  claimNextMonitoringRun,
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
  queueMonitoringRecovery,
  requeueMonitoringRun,
  saveMonitoringAdvisory,
  transitionMonitoringAlert
};
