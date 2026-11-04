const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  claimNextMonitoringRun,
  completeMonitoringRun,
  createMonitoringRun,
  failMonitoringRun,
  getMonitoringRun,
  requeueMonitoringRun
} = require('../srv/monitoringStore');

const hanaOptIn = process.env.CREDIT_GUARD_HANA_INTEGRATION === '1'
  && process.env.CREDIT_GUARD_HANA_TEST_DISPOSABLE === '1';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForLock(db) {
  return (await db.run(require('@sap/cds').ql.SELECT.one
    .from('credit.MonitoringWorkerLocks')
    .where({ ID: 'PORTFOLIO' }))) || null;
}

test('HANA monitoring concurrency requires explicitly enabled disposable HDI', {
  skip: hanaOptIn
    ? false
    : 'requires CREDIT_GUARD_HANA_INTEGRATION=1 and CREDIT_GUARD_HANA_TEST_DISPOSABLE=1'
}, async t => {
  const cds = require('@sap/cds');
  assert.ok(cds.env.profiles.includes('production'), 'Run with the production HANA profile.');
  assert.equal(cds.env.requires.db?.kind, 'hana', 'The configured CAP database must be HANA.');
  const db = await cds.connect.to('db');
  const runIds = new Set();
  const alertIds = new Set();
  const outboxIds = new Set();
  const activeClaims = new Map();

  const rememberRun = run => {
    runIds.add(run.ID);
    return run;
  };
  const createRun = async slotKey => {
    const result = await createMonitoringRun(db, {
      slotKey,
      runKind: slotKey.startsWith('scheduled:') ? 'SCHEDULED' : 'MANUAL',
      source: 'HANA integration test',
      triggeredBy: 'hana-integration-test'
    });
    rememberRun(result.run);
    return result;
  };
  const cleanup = async () => {
    for (const [runId, claim] of activeClaims) {
      await failMonitoringRun(
        db,
        runId,
        Object.assign(new Error('HANA integration cleanup.'), { category: 'test_cleanup' }),
        new Date(),
        claim.attemptCount,
        claim.workerToken
      );
    }
    const { DELETE } = cds.ql;
    for (const id of outboxIds) {
      await db.run(DELETE.from('credit.MonitoringNotificationOutbox').where({ ID: id }));
    }
    for (const id of alertIds) {
      await db.run(DELETE.from('credit.MonitoringAlertEvents').where({ alert_ID: id }));
      await db.run(DELETE.from('credit.MonitoringAlerts').where({ ID: id }));
    }
    for (const id of runIds) {
      await db.run(DELETE.from('credit.MonitoringFindings').where({ run_ID: id }));
      await db.run(DELETE.from('credit.MonitoringAlertEvents').where({ run_ID: id }));
      await db.run(DELETE.from('credit.MonitoringRuns').where({ ID: id }));
    }
    const lock = await waitForLock(db);
    if (lock) {
      assert.ok(!lock.run_ID || runIds.has(lock.run_ID), 'Refusing to remove a lock owned by another run.');
      await db.run(DELETE.from('credit.MonitoringWorkerLocks').where({ ID: 'PORTFOLIO' }));
    }
  };

  try {
    const { SELECT, DELETE, INSERT } = cds.ql;
    const runningRuns = await db.run(SELECT.from('credit.MonitoringRuns').where({ status: 'RUNNING' }));
    assert.equal(runningRuns.length, 0, 'Disposable HDI must not contain active monitoring runs.');
    const existingRuns = await db.run(SELECT.from('credit.MonitoringRuns'));
    assert.equal(existingRuns.length, 0, 'Use an empty, disposable HDI schema for this suite.');
    for (const entity of [
      'credit.MonitoringFindings',
      'credit.MonitoringAlerts',
      'credit.MonitoringAlertEvents',
      'credit.MonitoringNotificationOutbox'
    ]) {
      assert.equal((await db.run(SELECT.from(entity))).length, 0,
        `Disposable HDI must not contain existing ${entity} data.`);
    }
    const existingLock = await waitForLock(db);
    assert.ok(!existingLock?.run_ID, 'Disposable HDI must not have an active portfolio lock.');
    if (existingLock) {
      await db.run(DELETE.from('credit.MonitoringWorkerLocks').where({ ID: 'PORTFOLIO' }));
    }

    await t.test('concurrent singleton creation and claims produce one winner', async () => {
      const { run } = await createRun(`hana-claim:${randomUUID()}`);
      const bothTransactionsStarted = deferred();
      const connections = [];
      const concurrentDb = {
        run: db.run.bind(db),
        tx(callback) {
          return db.tx(async tx => {
            connections.push(tx.dbc);
            if (connections.length === 2) bothTransactionsStarted.resolve();
            const timeout = setTimeout(() => {
              bothTransactionsStarted.reject(new Error('HANA did not grant two concurrent connections.'));
            }, 15000);
            try {
              await bothTransactionsStarted.promise;
            } finally {
              clearTimeout(timeout);
            }
            return callback(tx);
          });
        }
      };
      const claims = await Promise.all([
        claimNextMonitoringRun(concurrentDb, { now: new Date(), leaseMs: 60000 }),
        claimNextMonitoringRun(concurrentDb, { now: new Date(), leaseMs: 60000 })
      ]);
      assert.notEqual(connections[0], connections[1],
        'Competing workers must hold independent HANA connections.');
      const winners = claims.filter(Boolean);
      assert.equal(winners.length, 1);
      const winner = winners[0];
      activeClaims.set(run.ID, winner);
      const storedRun = await getMonitoringRun(db, run.ID);
      const lock = await waitForLock(db);
      assert.equal(storedRun.status, 'RUNNING');
      assert.equal(storedRun.workerToken, winner.workerToken);
      assert.equal(lock.run_ID, run.ID);
      assert.equal(lock.claimToken, winner.workerToken);
      assert.equal(await failMonitoringRun(
        db, run.ID, new Error('test release'), new Date(), winner.attemptCount, winner.workerToken
      ) !== null, true);
      activeClaims.delete(run.ID);
    });

    await t.test('concurrent duplicate scheduled slots produce one durable job', async () => {
      const slotKey = `scheduled:${new Date().toISOString()}:${randomUUID()}`;
      const results = await Promise.all([createRun(slotKey), createRun(slotKey)]);
      assert.equal(results.filter(result => result.created).length, 1);
      assert.equal(results[0].run.ID, results[1].run.ID);
      const rows = await db.run(SELECT.from('credit.MonitoringRuns').where({ slotKey }));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'QUEUED');
      await db.run(DELETE.from('credit.MonitoringRuns').where({ ID: rows[0].ID }));
    });

    await t.test('failure between lock and run updates rolls back the claim', async () => {
      const { run } = await createRun(`hana-rollback:${randomUUID()}`);
      const failingDb = {
        run: db.run.bind(db),
        tx(callback) {
          return db.tx(tx => callback({
            run(query) {
              if (query.UPDATE?.entity?.ref?.[0] === 'credit.MonitoringRuns'
                && query.UPDATE.data?.status === 'RUNNING') {
                throw new Error('injected failure after lock update');
              }
              return tx.run(query);
            }
          }));
        }
      };
      await assert.rejects(claimNextMonitoringRun(failingDb), /injected failure/);
      const storedRun = await getMonitoringRun(db, run.ID);
      const lock = await waitForLock(db);
      assert.equal(storedRun.status, 'QUEUED');
      assert.equal(storedRun.attemptCount, 0);
      assert.equal(storedRun.workerToken, null);
      assert.ok(!lock?.run_ID);
      assert.equal(lock?.claimToken ?? null, null);
      await db.run(DELETE.from('credit.MonitoringRuns').where({ ID: run.ID }));
    });

    await t.test('reclaim during completion fences stale writes and rolls back alert effects', async () => {
      const { run } = await createRun(`hana-lease-race:${randomUUID()}`);
      const oldClaim = await claimNextMonitoringRun(db, {
        now: new Date(Date.now() - 60000),
        leaseMs: 1
      });
      assert.equal(oldClaim.ID, run.ID);
      activeClaims.set(run.ID, oldClaim);

      const alertId = randomUUID();
      alertIds.add(alertId);
      await db.run(INSERT.into('credit.MonitoringAlerts').entries({
        ID: alertId,
        customer_ID: `H${randomUUID().replace(/-/g, '').slice(0, 11)}`,
        customerName: 'Synthetic HANA concurrency fixture',
        conditionKey: 'WARNING',
        severity: 'MEDIUM',
        status: 'ACTIVE',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastRun_ID: run.ID,
        exposure: 100,
        creditLimit: 1000,
        overdueAmount: 0
      }));

      const enteredCompletion = deferred();
      const continueCompletion = deferred();
      const completionDb = {
        run: db.run.bind(db),
        tx(callback) {
          return db.tx(tx => callback({
            async run(query) {
              const rows = await tx.run(query);
              if (!enteredCompletion.settled
                && query.SELECT?.one
                && query.SELECT.from?.ref?.[0] === 'credit.MonitoringRuns') {
                enteredCompletion.settled = true;
                enteredCompletion.resolve();
                await continueCompletion.promise;
              }
              return rows;
            }
          }));
        }
      };
      const completion = completeMonitoringRun(completionDb, run.ID, {
        status: 'COMPLETED',
        complete: true,
        alertResolutionEligible: true,
        freshness: 'FRESH',
        source: 'HANA integration test',
        retrievedAt: new Date().toISOString(),
        sourceTimestamp: new Date().toISOString(),
        rulesVersion: '1',
        summary: { customersMonitored: 1 },
        findings: []
      }, 'hana-integration-test', new Date(), oldClaim.attemptCount, oldClaim.workerToken);

      await enteredCompletion.promise;
      const currentClaim = await claimNextMonitoringRun(db, {
        now: new Date(),
        leaseMs: 60000
      });
      assert.equal(currentClaim.ID, run.ID);
      assert.notEqual(currentClaim.workerToken, oldClaim.workerToken);
      activeClaims.set(run.ID, currentClaim);
      continueCompletion.resolve();
      await assert.rejects(completion);

      assert.equal(await failMonitoringRun(
        db, run.ID, new Error('stale failure'), new Date(),
        oldClaim.attemptCount, oldClaim.workerToken
      ), null);
      assert.equal(await requeueMonitoringRun(
        db, run.ID, new Date(), oldClaim.attemptCount, oldClaim.workerToken
      ), null);
      const storedRun = await getMonitoringRun(db, run.ID);
      const lock = await waitForLock(db);
      const alerts = await db.run(SELECT.from('credit.MonitoringAlerts').where({ ID: alertId }));
      const events = await db.run(SELECT.from('credit.MonitoringAlertEvents')
        .where({ alert_ID: alertId }));
      const findings = await db.run(SELECT.from('credit.MonitoringFindings')
        .where({ run_ID: run.ID }));
      assert.equal(storedRun.status, 'RUNNING');
      assert.equal(storedRun.workerToken, currentClaim.workerToken);
      assert.equal(lock.claimToken, currentClaim.workerToken);
      assert.equal(alerts[0].status, 'ACTIVE');
      assert.equal(events.length, 0);
      assert.equal(findings.length, 0);
    });
  } finally {
    await cleanup();
  }
});
