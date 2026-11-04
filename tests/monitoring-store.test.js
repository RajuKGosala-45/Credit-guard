const test = require('node:test');
const assert = require('node:assert/strict');
const {
  completeMonitoringRun,
  dispatchNotificationOutbox,
  failMonitoringRun,
  requeueMonitoringRun
} = require('../srv/monitoringStore');
const { createMonitoringDatabase } = require('./support/transactional-monitoring-db');

function database({ runs = [], outbox = [] } = {}) {
  const db = createMonitoringDatabase({
    tables: {
      'credit.MonitoringRuns': runs,
      'credit.MonitoringWorkerLocks': [],
      'credit.MonitoringFindings': [],
      'credit.MonitoringAlerts': [],
      'credit.MonitoringAlertEvents': [],
      'credit.MonitoringNotificationOutbox': outbox
    }
  });
  db.runs = runs;
  db.outbox = outbox;
  return db;
}

function completionDatabase({ runs = [], alerts = [], findings = [], events = [] } = {}) {
  return createMonitoringDatabase({
    tables: {
      'credit.MonitoringRuns': runs,
      'credit.MonitoringWorkerLocks': [],
      'credit.MonitoringFindings': findings,
      'credit.MonitoringAlerts': alerts,
      'credit.MonitoringAlertEvents': events,
      'credit.MonitoringNotificationOutbox': []
    }
  });
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

function alertForResolution(id, status) {
  return {
    ID: id,
    customer_ID: `C-${id}`,
    conditionKey: 'WARNING',
    status
  };
}

async function completeMonitoringResult(result, alerts) {
  const run = {
    ID: 'run-complete',
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1
  };
  const db = completionDatabase({ runs: [run], alerts });
  await completeMonitoringRun(db, run.ID, {
    ...result,
    source: 'CAP database',
    retrievedAt: '2026-11-04T00:00:00.000Z',
    rulesVersion: '1',
    summary: { customersMonitored: 1, ...result.summary },
    findings: result.findings || []
  }, 'monitor', new Date('2026-11-04T00:00:01.000Z'), 1);
  return db;
}

test('unknown, stale, partial, failed, and empty snapshots preserve active and acknowledged alerts', async () => {
  const ineligibleResults = [
    {
      status: 'COMPLETED',
      complete: true,
      freshness: 'UNKNOWN',
      alertResolutionEligible: false,
      summary: { customersMonitored: 1 }
    },
    {
      status: 'STALE',
      complete: true,
      freshness: 'STALE',
      alertResolutionEligible: false,
      summary: { customersMonitored: 1 }
    },
    {
      status: 'PARTIAL',
      complete: false,
      freshness: 'FRESH',
      alertResolutionEligible: false,
      summary: { customersMonitored: 1 }
    },
    {
      status: 'COMPLETED',
      complete: true,
      freshness: 'FRESH',
      alertResolutionEligible: false,
      summary: { customersMonitored: 0 }
    }
  ];

  for (const result of ineligibleResults) {
    const active = alertForResolution('active', 'ACTIVE');
    const acknowledged = alertForResolution('acknowledged', 'ACKNOWLEDGED');
    const db = await completeMonitoringResult(result, [active, acknowledged]);
    assert.equal(active.status, 'ACTIVE', `${result.status}/${result.freshness} changed ACTIVE alert`);
    assert.equal(acknowledged.status, 'ACKNOWLEDGED', `${result.status}/${result.freshness} changed ACKNOWLEDGED alert`);
    assert.equal(db.tables['credit.MonitoringAlertEvents'].length, 0);
    assert.equal(JSON.parse(db.tables['credit.MonitoringRuns'][0].summary).alertResolutionEligible, false);
  }
});

test('failed retrieval marks its run failed without changing existing alerts', async () => {
  const run = {
    ID: 'run-failed',
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1
  };
  const active = alertForResolution('active', 'ACTIVE');
  const acknowledged = alertForResolution('acknowledged', 'ACKNOWLEDGED');
  const db = completionDatabase({ runs: [run], alerts: [active, acknowledged] });

  await failMonitoringRun(
    db,
    run.ID,
    new Error('Source unavailable.'),
    new Date('2026-11-04T00:00:01.000Z'),
    1
  );

  assert.equal(run.status, 'FAILED');
  assert.equal(active.status, 'ACTIVE');
  assert.equal(acknowledged.status, 'ACKNOWLEDGED');
  assert.equal(db.tables['credit.MonitoringAlertEvents'].length, 0);
});

test('fresh complete non-empty snapshots resolve absent active and acknowledged alert conditions', async () => {
  const active = alertForResolution('active', 'ACTIVE');
  const acknowledged = alertForResolution('acknowledged', 'ACKNOWLEDGED');
  const db = await completeMonitoringResult({
    status: 'COMPLETED',
    complete: true,
    freshness: 'FRESH',
    alertResolutionEligible: true,
    summary: { customersMonitored: 2 },
    findings: []
  }, [active, acknowledged]);

  assert.equal(active.status, 'RESOLVED');
  assert.equal(acknowledged.status, 'RESOLVED');
  const summary = JSON.parse(db.tables['credit.MonitoringRuns'][0].summary);
  assert.equal(summary.complete, true);
  assert.equal(summary.alertResolutionEligible, true);
  assert.equal(db.tables['credit.MonitoringAlertEvents'].length, 2);
  assert.ok(db.tables['credit.MonitoringAlertEvents'].every(event => event.eventType === 'RESOLVED'));
});

test('store requires every resolution condition even if eligibility metadata is inconsistent', async () => {
  const alert = alertForResolution('active', 'ACTIVE');
  await completeMonitoringResult({
    status: 'COMPLETED',
    complete: true,
    freshness: 'UNKNOWN',
    alertResolutionEligible: true,
    summary: { customersMonitored: 2 }
  }, [alert]);
  assert.equal(alert.status, 'ACTIVE');
});
