const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimNextMonitoringRun,
  completeMonitoringRun,
  createMonitoringRun,
  failMonitoringRun,
  getMonitoringRun,
  queueMonitoringRecovery,
  requeueMonitoringRun,
  MAX_MONITORING_ATTEMPTS
} = require('../srv/monitoringStore');
const {
  processNextMonitoringJob,
  startMonitoringWorker
} = require('../srv/monitoringWorker');
const { createMonitoringDatabase } = require('./support/transactional-monitoring-db');
const { UPDATE } = require('@sap/cds').ql;

function database() {
  const tables = {
    'credit.MonitoringRuns': [],
    'credit.MonitoringWorkerLocks': [],
    'credit.MonitoringFindings': [],
    'credit.MonitoringAlerts': [],
    'credit.MonitoringAlertEvents': [],
    'credit.MonitoringNotificationOutbox': []
  };
  return createMonitoringDatabase({ tables });
}

function queued(db, slotKey = 'manual:one', now = new Date('2026-11-04T00:00:00.000Z')) {
  return createMonitoringRun(db, {
    slotKey,
    runKind: slotKey.startsWith('scheduled:') ? 'SCHEDULED' : 'MANUAL',
    source: 'CAP database',
    triggeredBy: 'monitor',
    now
  });
}

function healthySnapshot() {
  return {
    source: 'CAP database',
    retrievedAt: new Date().toISOString(),
    sourceTimestamp: new Date().toISOString(),
    complete: true,
    customers: [{
      ID: 'C100',
      name: 'Synthetic Customer',
      creditLimit: 1000,
      exposure: 100,
      utilisation: 0.1,
      overdueAmount: 0,
      overdueShare: 0,
      flags: [],
      status: 'HEALTHY',
      currency: 'INR'
    }]
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('monitoring requests persist as queued and duplicate scheduler slots reuse one run', async () => {
  const db = database();
  const slot = 'scheduled:2026-11-04T00:00:00.000Z';
  const first = await queued(db, slot);
  const duplicate = await queued(db, slot);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.ID, first.run.ID);
  assert.equal(first.run.status, 'QUEUED');
  assert.equal(first.run.attemptCount, 0);
});

test('concurrent workers claim at most one portfolio run', async () => {
  const db = database();
  await queued(db);
  await queued(db, 'manual:two');
  const claims = await Promise.all([
    claimNextMonitoringRun(db, { now: new Date('2026-11-04T00:00:00.000Z') }),
    claimNextMonitoringRun(db, { now: new Date('2026-11-04T00:00:00.000Z') })
  ]);
  assert.equal(claims.filter(Boolean).length, 1, JSON.stringify({
    claims,
    runs: db.tables['credit.MonitoringRuns'],
    locks: db.tables['credit.MonitoringWorkerLocks']
  }));
  assert.equal(db.tables['credit.MonitoringRuns'].filter(run => run.status === 'RUNNING').length, 1);
});

test('transaction state is isolated until commit and restored after rollback', async () => {
  const db = database();
  const entry = await queued(db);
  const entered = deferred();
  const commit = deferred();
  const pending = db.tx(async tx => {
    await tx.run(UPDATE('credit.MonitoringRuns')
      .set({ status: 'RUNNING' }).where({ ID: entry.run.ID }));
    entered.resolve();
    await commit.promise;
  });
  await entered.promise;
  assert.equal((await getMonitoringRun(db, entry.run.ID)).status, 'QUEUED');
  commit.resolve();
  await pending;
  assert.equal((await getMonitoringRun(db, entry.run.ID)).status, 'RUNNING');

  await assert.rejects(db.tx(async tx => {
    await tx.run(UPDATE('credit.MonitoringRuns')
      .set({ status: 'FAILED' }).where({ ID: entry.run.ID }));
    throw new Error('injected transaction failure');
  }), /injected transaction failure/);
  assert.equal((await getMonitoringRun(db, entry.run.ID)).status, 'RUNNING');
});

test('a failed claim between lock and run updates rolls back both rows', async () => {
  const db = database();
  const entry = await queued(db);
  const interruptedDb = {
    run: db.run.bind(db),
    tx(callback) {
      return db.tx(tx => callback({
        run(query) {
          if (query.UPDATE?.entity?.ref?.[0] === 'credit.MonitoringRuns'
            && query.UPDATE.data?.status === 'RUNNING') {
            throw new Error('injected run-claim failure');
          }
          return tx.run(query);
        }
      }));
    }
  };
  await assert.rejects(
    claimNextMonitoringRun(interruptedDb),
    /injected run-claim failure/
  );
  const storedRun = await getMonitoringRun(db, entry.run.ID);
  const storedLock = await db.run(
    require('@sap/cds').ql.SELECT.one.from('credit.MonitoringWorkerLocks')
      .where({ ID: 'PORTFOLIO' })
  );
  assert.equal(storedRun.status, 'QUEUED');
  assert.equal(storedRun.attemptCount, 0);
  assert.equal(storedRun.workerToken, undefined);
  assert.equal(storedLock.run_ID, null);
  assert.equal(storedLock.claimToken, null);
});

test('null singleton lock fields permit the initial conditional claim', async () => {
  const db = database();
  const entry = await queued(db);
  db.tables['credit.MonitoringWorkerLocks'].push({
    ID: 'PORTFOLIO',
    run_ID: null,
    claimToken: null,
    leaseUntil: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  const claim = await claimNextMonitoringRun(db);
  assert.equal(claim.ID, entry.run.ID);
  assert.equal(claim.status, 'RUNNING');
  const lock = await db.run(
    require('@sap/cds').ql.SELECT.one.from('credit.MonitoringWorkerLocks')
      .where({ ID: 'PORTFOLIO' })
  );
  assert.equal(lock.run_ID, entry.run.ID);
  assert.equal(lock.claimToken, claim.workerToken);
});

test('reclaimed claim rejects stale completion, failure, and requeue without side effects', async () => {
  const db = database();
  const entry = await queued(db);
  const oldClaim = await claimNextMonitoringRun(db, {
    now: new Date('2026-11-04T00:00:00.000Z'),
    leaseMs: 1
  });
  const initialLock = db.tables['credit.MonitoringWorkerLocks'][0];
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  entry.run.leaseUntil = expiredAt;
  initialLock.leaseUntil = expiredAt;
  const currentClaim = await claimNextMonitoringRun(db, { now: new Date() });
  assert.notEqual(currentClaim.workerToken, oldClaim.workerToken);

  db.tables['credit.MonitoringFindings'].push({
    ID: 'existing-finding',
    run_ID: entry.run.ID
  });
  db.tables['credit.MonitoringAlerts'].push({
    ID: 'existing-alert',
    customer_ID: 'C100',
    conditionKey: 'BREACH',
    status: 'ACTIVE'
  });
  const result = {
    status: 'COMPLETED',
    complete: true,
    alertResolutionEligible: true,
    freshness: 'FRESH',
    source: 'CAP database',
    retrievedAt: new Date().toISOString(),
    sourceTimestamp: new Date().toISOString(),
    rulesVersion: '1',
    summary: { customersMonitored: 1 },
    findings: []
  };
  await assert.rejects(completeMonitoringRun(
    db,
    entry.run.ID,
    result,
    'monitor',
    new Date(),
    oldClaim.attemptCount,
    oldClaim.workerToken
  ), error => error.statusCode === 409);
  assert.equal(await failMonitoringRun(
    db,
    entry.run.ID,
    new Error('stale worker'),
    new Date(),
    oldClaim.attemptCount,
    oldClaim.workerToken
  ), null);
  assert.equal(await requeueMonitoringRun(
    db,
    entry.run.ID,
    new Date(),
    oldClaim.attemptCount,
    oldClaim.workerToken
  ), null);

  const storedRun = await getMonitoringRun(db, entry.run.ID);
  const storedLock = await db.run(
    require('@sap/cds').ql.SELECT.one.from('credit.MonitoringWorkerLocks')
      .where({ ID: 'PORTFOLIO' })
  );
  assert.equal(storedRun.status, 'RUNNING');
  assert.equal(storedRun.workerToken, currentClaim.workerToken);
  assert.equal(storedLock.claimToken, currentClaim.workerToken);
  assert.deepEqual(db.tables['credit.MonitoringFindings'].map(item => item.ID), ['existing-finding']);
  assert.equal(db.tables['credit.MonitoringAlerts'][0].status, 'ACTIVE');
  assert.equal(db.tables['credit.MonitoringAlertEvents'].length, 0);
});

test('a worker reclaims a run after its persisted lease expires', async () => {
  const db = database();
  const run = (await queued(db)).run;
  const oldToken = 'expired-worker-token';
  Object.assign(run, {
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1,
    workerToken: oldToken,
    leaseUntil: '2026-11-04T00:00:01.000Z'
  });
  db.tables['credit.MonitoringWorkerLocks'].push({
    ID: 'PORTFOLIO',
    run_ID: run.ID,
    claimToken: oldToken,
    leaseUntil: run.leaseUntil,
    updatedAt: '2026-11-04T00:00:00.000Z'
  });
  const claim = await claimNextMonitoringRun(db, {
    now: new Date('2026-11-04T00:00:02.000Z')
  });
  assert.equal(claim.ID, run.ID);
  assert.equal(claim.attemptCount, 2);
  assert.notEqual(claim.workerToken, oldToken);
  assert.equal(run.status, 'RUNNING');
});

test('worker restart recovery handles expired pre-worker running leases', async () => {
  const db = database();
  const run = (await queued(db)).run;
  Object.assign(run, {
    status: 'RUNNING',
    recoveryStatus: 'ACTIVE',
    attemptCount: 1,
    workerToken: null,
    leaseUntil: '2026-11-04T00:00:01.000Z'
  });
  const claim = await claimNextMonitoringRun(db, {
    now: new Date('2026-11-04T00:00:02.000Z')
  });
  assert.equal(claim.ID, run.ID);
  assert.equal(claim.attemptCount, 2);
  assert.equal(claim.status, 'RUNNING');
});

test('operator recovery queues an eligible run instead of bypassing worker claims', async () => {
  const db = database();
  const run = (await queued(db)).run;
  Object.assign(run, {
    status: 'FAILED',
    recoveryStatus: 'AVAILABLE',
    attemptCount: 1,
    completedAt: '2026-11-04T00:00:00.000Z'
  });
  db.tables['credit.MonitoringFindings'].push({
    ID: 'stale-finding',
    run_ID: run.ID
  });
  const recovery = await queueMonitoringRecovery(
    db,
    run.ID,
    new Date('2026-11-04T00:01:00.000Z')
  );
  assert.equal(recovery.status, 'QUEUED');
  assert.equal(run.status, 'QUEUED');
  assert.equal(run.attemptCount, 1);
  assert.equal(db.tables['credit.MonitoringFindings'].length, 0);
  const claim = await claimNextMonitoringRun(
    db,
    { now: new Date('2026-11-04T00:01:01.000Z') }
  );
  assert.equal(claim.ID, run.ID);
  assert.equal(claim.attemptCount, 2);
});

test('operator recovery is rejected after the bounded attempt count', async () => {
  const db = database();
  const run = (await queued(db)).run;
  Object.assign(run, {
    status: 'FAILED',
    recoveryStatus: 'AVAILABLE',
    attemptCount: MAX_MONITORING_ATTEMPTS
  });
  await assert.rejects(queueMonitoringRecovery(db, run.ID), error => error.statusCode === 409);
});

test('worker completes a durable job and releases its portfolio lease', async () => {
  const db = database();
  const entry = await queued(db);
  const result = await processNextMonitoringJob({
    db,
    provider: { async getSnapshot() { return healthySnapshot(); } },
    summaryProvider: null,
    now: () => new Date(),
    executionDeadlineMs: 1000
  });
  assert.equal(result.ID, entry.run.ID);
  assert.equal(result.status, 'COMPLETED');
  const stored = await getMonitoringRun(db, entry.run.ID);
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.workerToken, null);
  assert.equal(db.tables['credit.MonitoringWorkerLocks'][0].run_ID, null);
});

test('deadline cancellation prevents a late source response from completing the run', async () => {
  const db = database();
  const entry = await queued(db);
  let observedSignal;
  const result = await processNextMonitoringJob({
    db,
    provider: {
      async getSnapshot({ signal }) {
        observedSignal = signal;
        await new Promise(resolve => setTimeout(resolve, 40));
        return healthySnapshot();
      }
    },
    summaryProvider: null,
    executionDeadlineMs: 10
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCategory, 'monitoring_deadline_exceeded');
  assert.equal(observedSignal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  const stored = await getMonitoringRun(db, entry.run.ID);
  assert.equal(stored.status, 'FAILED');
  assert.equal(db.tables['credit.MonitoringFindings'].length, 0);
  assert.equal(db.tables['credit.MonitoringAlerts'].length, 0);
});

test('advisory timeout falls back without changing a completed deterministic run', async () => {
  const db = database();
  await queued(db);
  await processNextMonitoringJob({
    db,
    provider: { async getSnapshot() { return healthySnapshot(); } },
    summaryProvider: { async complete() { return new Promise(() => {}); } },
    executionDeadlineMs: 1000,
    advisoryTimeoutMs: 10
  });
  const stored = db.tables['credit.MonitoringRuns'][0];
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.advisorySource, 'DETERMINISTIC');
  assert.equal(stored.advisoryErrorCategory, 'monitoring_advisory_timeout');
  assert.equal(typeof stored.advisorySummary, 'string');
});

test('worker timeout configuration rejects invalid and excessive values', () => {
  const { normalizePositiveSetting } = require('../srv/monitoringWorker');
  for (const value of ['0', '-1', '1.5', 'not-a-number', '600001']) {
    assert.throws(() => normalizePositiveSetting(
      value, 120000, 600000, 'MONITORING_EXECUTION_DEADLINE_MS'
    ), /MONITORING_EXECUTION_DEADLINE_MS/);
  }
  assert.equal(normalizePositiveSetting(undefined, 120000, 600000, 'timeout'), 120000);
  assert.equal(normalizePositiveSetting('2000', 120000, 600000, 'timeout'), 2000);
});

test('worker shutdown with no active job drains immediately', async () => {
  const db = database();
  const stop = startMonitoringWorker(db, { pollIntervalMs: 30000 });
  const result = await stop();
  assert.deepEqual(result, { drained: true });
  assert.equal(db.tables['credit.MonitoringRuns'].length, 0);
});

test('shutdown before polling leaves queued jobs unclaimed and stops future claims', async () => {
  const db = database();
  const entry = await queued(db);
  const stop = startMonitoringWorker(db, { pollIntervalMs: 30000 });
  const result = await stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { drained: true });
  assert.equal((await getMonitoringRun(db, entry.run.ID)).status, 'QUEUED');
  assert.equal(db.tables['credit.MonitoringWorkerLocks'][0]?.run_ID ?? null, null);
});

test('shutdown aborts an active source read, requeues safely, and does not resolve alerts', async () => {
  const db = database();
  const entry = await queued(db);
  const second = await queued(db, 'manual:second', new Date(Date.now() + 60000));
  db.tables['credit.MonitoringAlerts'].push({
    ID: 'existing-alert',
    customer_ID: 'C100',
    conditionKey: 'BREACH',
    status: 'ACTIVE'
  });
  const started = deferred();
  let observedSignal;
  const stop = startMonitoringWorker(db, {
    pollIntervalMs: 30000,
    provider: {
      getSnapshot({ signal }) {
        observedSignal = signal;
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    }
  });
  await started.promise;
  const drained = await stop();
  assert.equal(drained.drained, true);
  assert.equal(observedSignal.aborted, true);
  const stored = await getMonitoringRun(db, entry.run.ID);
  assert.equal(stored.status, 'QUEUED');
  assert.equal(stored.workerToken, null);
  assert.equal(db.tables['credit.MonitoringAlerts'][0].status, 'ACTIVE');
  assert.equal(db.tables['credit.MonitoringRuns'].filter(run => run.attemptCount > 0).length, 1);
  assert.equal((await getMonitoringRun(db, second.run.ID)).status, 'QUEUED');

  const restarted = await processNextMonitoringJob({
    db,
    provider: { async getSnapshot() { return healthySnapshot(); } },
    summaryProvider: null,
    executionDeadlineMs: 1000
  });
  assert.equal(restarted.ID, entry.run.ID);
  assert.equal(restarted.status, 'COMPLETED');
  assert.equal(db.tables['credit.MonitoringAlerts'][0].status, 'RESOLVED');
});

test('shutdown during completion waits for the atomic completion transaction', async () => {
  const db = database();
  const entry = await queued(db);
  const completionEntered = deferred();
  const allowCompletion = deferred();
  const originalTx = db.tx.bind(db);
  let transactionCount = 0;
  db.tx = async callback => {
    transactionCount += 1;
    if (transactionCount === 2) {
      completionEntered.resolve();
      await allowCompletion.promise;
    }
    return originalTx(callback);
  };
  const stop = startMonitoringWorker(db, {
    pollIntervalMs: 30000,
    provider: { async getSnapshot() { return healthySnapshot(); } }
  });
  await completionEntered.promise;
  const draining = stop();
  allowCompletion.resolve();
  assert.deepEqual(await draining, { drained: true });
  const stored = await getMonitoringRun(db, entry.run.ID);
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(db.tables['credit.MonitoringWorkerLocks'][0].run_ID, null);
});

test('shutdown cancels advisory generation without delaying deterministic completion', async () => {
  const db = database();
  const first = await queued(db);
  await queued(db, 'manual:second');
  const advisoryStarted = deferred();
  const stop = startMonitoringWorker(db, {
    pollIntervalMs: 30000,
    provider: { async getSnapshot() { return healthySnapshot(); } },
    summaryProvider: {
      complete({ signal }) {
        advisoryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    }
  });
  await advisoryStarted.promise;
  assert.deepEqual(await stop(), { drained: true });
  const stored = await getMonitoringRun(db, first.run.ID);
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.advisorySummary || null, null);
  assert.equal(db.tables['credit.MonitoringRuns'][1].status, 'QUEUED');
});

test('drain timeout retains the lease and an expired-lease restart rejects stale completion', async () => {
  const db = database();
  const entry = await queued(db);
  const sourceStarted = deferred();
  const responseReturned = deferred();
  const sourceResult = deferred();
  const stop = startMonitoringWorker(db, {
    pollIntervalMs: 30000,
    shutdownDrainTimeoutMs: 15,
    provider: {
      getSnapshot() {
        sourceStarted.resolve();
        return sourceResult.promise.then(value => {
          responseReturned.resolve();
          return value;
        });
      }
    }
  });
  await sourceStarted.promise;
  const drained = await stop();
  assert.deepEqual(drained, { drained: false });
  const originalRun = db.tables['credit.MonitoringRuns'][0];
  const originalToken = originalRun.workerToken;
  assert.equal(originalRun.status, 'RUNNING');
  assert.ok(originalToken);
  assert.equal(db.tables['credit.MonitoringWorkerLocks'][0].run_ID, entry.run.ID);

  const expiredAt = new Date(Date.now() - 1000).toISOString();
  originalRun.leaseUntil = expiredAt;
  db.tables['credit.MonitoringWorkerLocks'][0].leaseUntil = expiredAt;
  const reclaimed = await claimNextMonitoringRun(db, { now: new Date() });
  assert.equal(reclaimed.ID, entry.run.ID);
  assert.notEqual(reclaimed.workerToken, originalToken);
  const reclaimedToken = reclaimed.workerToken;
  const staleCleanup = deferred();
  const originalTx = db.tx.bind(db);
  let txCalls = 0;
  db.tx = async callback => {
    txCalls += 1;
    if (txCalls === 1) staleCleanup.resolve();
    return originalTx(callback);
  };

  sourceResult.resolve(healthySnapshot());
  await responseReturned.promise;
  await staleCleanup.promise;
  await new Promise(resolve => setImmediate(resolve));
  const afterLateResponse = await getMonitoringRun(db, entry.run.ID);
  assert.equal(afterLateResponse.status, 'RUNNING');
  assert.equal(afterLateResponse.workerToken, reclaimedToken);
  assert.equal(db.tables['credit.MonitoringFindings'].length, 0);
  assert.equal(db.tables['credit.MonitoringAlerts'].length, 0);
});

test('shutdown drain timeout setting is bounded', () => {
  const { normalizePositiveSetting, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS } =
    require('../srv/monitoringWorker');
  assert.equal(normalizePositiveSetting(
    undefined, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS, 120000, 'drain'
  ), 8000);
  assert.throws(() => normalizePositiveSetting('120001', 8000, 120000, 'drain'), /drain/);
});
