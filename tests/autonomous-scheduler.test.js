const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  AutonomousMonitoringScheduler,
  DEFAULT_SCHEDULER_INTERVAL_MS,
  MIN_SCHEDULER_INTERVAL_MS,
  getAutonomousSchedulerInstance,
  startAutonomousScheduler
} = require('../srv/autonomousScheduler');

function createMockDb() {
  const runs = [];
  const monitoringRuns = [];
  return {
    runs,
    monitoringRuns,
    async run(query) {
      if (query.INSERT?.into?.ref?.[0] === 'credit.MonitoringRuns') {
        const entry = query.INSERT.entries[0];
        const existing = monitoringRuns.find(r => r.slotKey === entry.slotKey);
        if (existing) {
          const error = new Error('UNIQUE constraint failed: credit.MonitoringRuns.slotKey');
          error.code = 'SQLITE_CONSTRAINT';
          throw error;
        }
        monitoringRuns.push(entry);
        return 1;
      }
      if (query.SELECT?.from?.ref?.[0] === 'credit.MonitoringRuns') {
        const where = query.SELECT.where;
        if (where) {
          const slotVal = where.find(p => p.ref?.[0] === 'slotKey');
          const idVal = where.find(p => p.ref?.[0] === 'ID');
          if (slotVal) {
            const idx = where.indexOf(slotVal);
            const val = where[idx + 2]?.val;
            return monitoringRuns.find(r => r.slotKey === val) || null;
          }
          if (idVal) {
            const idx = where.indexOf(idVal);
            const val = where[idx + 2]?.val;
            return monitoringRuns.find(r => r.ID === val) || null;
          }
        }
        return monitoringRuns;
      }
      if (query.SELECT?.from?.ref?.[0] === 'credit.MonitoringFindings') {
        return [];
      }
      return [];
    }
  };
}

test('validates constructor parameters and boundaries', () => {
  assert.throws(
    () => new AutonomousMonitoringScheduler(null),
    /AutonomousMonitoringScheduler requires a database instance/
  );

  const db = createMockDb();
  const defaultSched = new AutonomousMonitoringScheduler(db);
  assert.equal(defaultSched.intervalMs, DEFAULT_SCHEDULER_INTERVAL_MS);
  assert.equal(defaultSched.initialDelayMs, 30000);

  assert.throws(
    () => new AutonomousMonitoringScheduler(db, { intervalMs: -1 }),
    /AUTONOMOUS_MONITORING_INTERVAL_MS must be a positive whole number/
  );

  assert.throws(
    () => new AutonomousMonitoringScheduler(db, { intervalMs: 5 }), // below MIN_SCHEDULER_INTERVAL_MS (20)
    /AUTONOMOUS_MONITORING_INTERVAL_MS must be a positive whole number/
  );
});

test('executes autonomous cycle, tracks telemetry, and prevents slot collisions', async () => {
  const db = createMockDb();
  const scheduler = new AutonomousMonitoringScheduler(db, {
    intervalMs: 1000,
    initialDelayMs: 0,
    autoRecalculate: false
  });

  // Cycle 1: Fresh execution
  const res1 = await scheduler.executeCycle({ force: false });
  assert.equal(res1.status, 'SUCCESS');
  assert.ok(res1.runId);
  assert.ok(res1.slotKey.startsWith('scheduled:5m:'));

  const status1 = scheduler.getStatus();
  assert.equal(status1.totalRuns, 1);
  assert.equal(status1.successfulRuns, 1);
  assert.equal(status1.lastRunStatus, 'SUCCESS');

  // Cycle 2: Same slot window without force should be cleanly skipped
  const res2 = await scheduler.executeCycle({ force: false });
  assert.equal(res2.status, 'SKIPPED');
  assert.equal(res2.reason, 'SLOT_ALREADY_CLAIMED');

  const status2 = scheduler.getStatus();
  assert.equal(status2.totalRuns, 2);
  assert.equal(status2.skippedRuns, 1);

  // Cycle 3: Force execution generates unique slot and succeeds
  const res3 = await scheduler.executeCycle({ force: true });
  assert.equal(res3.status, 'SUCCESS');
  assert.ok(res3.slotKey.startsWith('manual:force:'));

  const status3 = scheduler.getStatus();
  assert.equal(status3.totalRuns, 3);
  assert.equal(status3.successfulRuns, 2);
});

test('starts and periodically executes with graceful stop', async () => {
  const db = createMockDb();
  const scheduler = new AutonomousMonitoringScheduler(db, {
    intervalMs: 30,
    initialDelayMs: 10,
    autoRecalculate: false
  });

  scheduler.start();
  assert.equal(scheduler.status, 'RUNNING');
  assert.ok(scheduler.getStatus().nextRunAt);

  // Allow timers to fire
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.ok(scheduler.totalRuns >= 1);
  const stopOutcome = await scheduler.stop();
  assert.deepEqual(stopOutcome, { drained: true });
  assert.equal(scheduler.status, 'STOPPED');
  assert.equal(scheduler.nextRunAt, null);
});

test('factory startAutonomousScheduler registers singleton and cleans up', async () => {
  const db = createMockDb();
  const stopFn = startAutonomousScheduler(db, {
    intervalMs: 50,
    initialDelayMs: 0,
    autoRecalculate: false
  });

  const instance = getAutonomousSchedulerInstance();
  assert.ok(instance);
  assert.equal(instance.status, 'RUNNING');

  const stopOutcome = await stopFn();
  assert.deepEqual(stopOutcome, { drained: true });
  assert.equal(instance.status, 'STOPPED');
});
