const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimMonitoringRecovery,
  completeMonitoringRun,
  dispatchNotificationOutbox,
  MAX_MONITORING_ATTEMPTS
} = require('../srv/monitoringStore');

function matches(record, where = []) {
  for (let index = 0; index < where.length; index += 1) {
    const field = where[index]?.ref?.[0];
    if (!field) continue;
    const value = where[index + 2]?.val;
    if (record[field] !== value) return false;
    index += 2;
  }
  return true;
}

function database({ runs = [], outbox = [] } = {}) {
  return {
    runs,
    outbox,
    async run(query) {
      if (query.SELECT) {
        const table = query.SELECT.from.ref[0];
        const records = table === 'credit.MonitoringRuns' ? this.runs
          : table === 'credit.MonitoringNotificationOutbox' ? this.outbox : [];
        const where = query.SELECT.where || [];
        const rows = records.filter(record => matches(record, where));
        return query.SELECT.one ? rows[0] || null : rows;
      }
      if (query.UPDATE) {
        const table = query.UPDATE.entity.ref[0];
        const records = table === 'credit.MonitoringRuns' ? this.runs
          : table === 'credit.MonitoringNotificationOutbox' ? this.outbox : [];
        const updated = records.filter(record => matches(record, query.UPDATE.where));
        for (const record of updated) Object.assign(record, query.UPDATE.data);
        return updated.length;
      }
      throw new Error('Unexpected query in monitoring store test.');
    },
    async tx(callback) { return callback(this); }
  };
}

function completionDatabase({ runs = [], alerts = [], findings = [], events = [] } = {}) {
  const tables = {
    'credit.MonitoringRuns': runs,
    'credit.MonitoringAlerts': alerts,
    'credit.MonitoringFindings': findings,
    'credit.MonitoringAlertEvents': events
  };
  return {
    tables,
    async run(query) {
      if (query.SELECT) {
        const records = tables[query.SELECT.from.ref[0]] || [];
        const rows = records.filter(record => matches(record, query.SELECT.where || []));
        return query.SELECT.one ? rows[0] || null : rows;
      }
      if (query.UPDATE) {
        const records = tables[query.UPDATE.entity.ref[0]] || [];
        const changed = records.filter(record => matches(record, query.UPDATE.where));
        for (const record of changed) Object.assign(record, query.UPDATE.data);
        return changed.length;
      }
      if (query.INSERT) {
        const records = tables[query.INSERT.into.ref[0]];
        records.push(...query.INSERT.entries);
        return query.INSERT.entries.length;
      }
      if (query.DELETE) {
        const records = tables[query.DELETE.from.ref[0]] || [];
        const retained = records.filter(record => !matches(record, query.DELETE.where));
        tables[query.DELETE.from.ref[0]] = retained;
        return records.length - retained.length;
      }
      throw new Error('Unexpected query in monitoring completion test.');
    },
    async tx(callback) { return callback(this); }
  };
}

test('notification outbox retries transient delivery failures within a fixed bound', async () => {
  const record = {
    ID: 'outbox-1',
    alert_ID: 'alert-1',
    channel: 'IN_APP',
    status: 'PENDING',
    attemptCount: 0,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z'
  };
  const db = database({ outbox: [record] });
  let calls = 0;
  const first = await dispatchNotificationOutbox(db, {
    now: new Date('2026-11-04T00:00:00.000Z'),
    deliver: async () => {
      calls += 1;
      throw Object.assign(new Error('Sensitive transport details.'), { category: 'notification_unavailable' });
    }
  });
  assert.deepEqual(first, [{ id: 'outbox-1', status: 'PENDING' }]);
  assert.equal(record.attemptCount, 1);
  assert.equal(record.errorCategory, 'notification_unavailable');
  assert.ok(record.nextAttemptAt);
  assert.equal(record.status, 'PENDING');

  const beforeRetry = await dispatchNotificationOutbox(db, {
    now: new Date('2026-11-04T00:00:00.500Z'),
    deliver: async () => { calls += 1; return { delivered: true }; }
  });
  assert.deepEqual(beforeRetry, []);
  assert.equal(calls, 1);

  const second = await dispatchNotificationOutbox(db, {
    now: new Date('2026-11-04T00:00:02.000Z'),
    deliver: async () => { calls += 1; return { delivered: true }; }
  });
  assert.deepEqual(second, [{ id: 'outbox-1', status: 'DELIVERED' }]);
  assert.equal(record.attemptCount, 2);
  assert.equal(record.status, 'DELIVERED');
});

test('notification outbox moves exhausted deliveries to a terminal failure', async () => {
  const record = {
    ID: 'outbox-2',
    alert_ID: 'alert-2',
    channel: 'IN_APP',
    status: 'PENDING',
    attemptCount: 0,
    createdAt: '2026-11-04T00:00:00.000Z'
  };
  const db = database({ outbox: [record] });
  const result = await dispatchNotificationOutbox(db, {
    now: new Date('2026-11-04T00:00:00.000Z'),
    maxAttempts: 1,
    deliver: async () => {
      throw Object.assign(new Error('Private provider error.'), { category: 'notification_unavailable' });
    }
  });
  assert.deepEqual(result, [{ id: 'outbox-2', status: 'FAILED' }]);
  assert.equal(record.errorCategory, 'notification_unavailable');
  assert.equal(JSON.stringify(record).includes('Private provider error'), false);
});

test('failed runs can be claimed only once for bounded recovery', async () => {
  const run = {
    ID: 'run-1',
    status: 'FAILED',
    recoveryStatus: 'AVAILABLE',
    attemptCount: 1,
    leaseUntil: null
  };
  const db = database({ runs: [run] });
  const claims = await Promise.allSettled([
    claimMonitoringRecovery(db, run.ID, new Date('2026-11-04T00:00:00.000Z')),
    claimMonitoringRecovery(db, run.ID, new Date('2026-11-04T00:00:00.000Z'))
  ]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(item => item.status === 'rejected').length, 1);
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.recoveryStatus, 'ACTIVE');
  assert.equal(run.attemptCount, 2);
});

test('stale active runs are recoverable but uncertain active leases are not', async () => {
  const expired = {
    ID: 'run-stale',
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1,
    leaseUntil: '2026-11-03T23:00:00.000Z'
  };
  const recovered = await claimMonitoringRecovery(
    database({ runs: [expired] }),
    expired.ID,
    new Date('2026-11-04T00:00:00.000Z')
  );
  assert.equal(recovered.attemptCount, 2);
  assert.equal(expired.status, 'RUNNING');
  assert.ok(new Date(expired.leaseUntil) > new Date('2026-11-04T00:00:00.000Z'));

  const active = {
    ID: 'run-active',
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1,
    leaseUntil: '2026-11-04T01:00:00.000Z'
  };
  await assert.rejects(claimMonitoringRecovery(
    database({ runs: [active] }),
    active.ID,
    new Date('2026-11-04T00:00:00.000Z')
  ), error => error.statusCode === 409);
});

test('recovery cannot exceed the configured maximum attempt count', async () => {
  const run = {
    ID: 'run-max',
    status: 'FAILED',
    recoveryStatus: 'AVAILABLE',
    attemptCount: MAX_MONITORING_ATTEMPTS
  };
  await assert.rejects(claimMonitoringRecovery(
    database({ runs: [run] }),
    run.ID,
    new Date('2026-11-04T00:00:00.000Z')
  ), error => error.statusCode === 409);
});

test('a complete monitoring snapshot resolves acknowledged alerts whose conditions disappeared', async () => {
  const run = {
    ID: 'run-complete',
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1
  };
  const alert = {
    ID: 'alert-acknowledged',
    customer_ID: 'C001',
    conditionKey: 'WARNING',
    status: 'ACKNOWLEDGED'
  };
  const db = completionDatabase({ runs: [run], alerts: [alert] });
  await completeMonitoringRun(db, run.ID, {
    status: 'COMPLETED',
    source: 'CAP database',
    retrievedAt: '2026-11-04T00:00:00.000Z',
    sourceTimestamp: null,
    freshness: 'UNKNOWN',
    rulesVersion: '1',
    summary: { customersMonitored: 0 },
    findings: []
  }, 'monitor', new Date('2026-11-04T00:00:01.000Z'), 1);
  assert.equal(alert.status, 'RESOLVED');
  assert.equal(db.tables['credit.MonitoringAlertEvents'][0].eventType, 'RESOLVED');
});
