const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { getDatabaseHandle } = require('./hanaConnection');
const {
  createMonitoringRun,
  getMonitoringRun,
  listMonitoringFindings,
  listMonitoringRuns
} = require('./monitoringStore');
const { recalculateAllExposureSnapshots } = require('./canonicalRepository');

const DEFAULT_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_SCHEDULER_INTERVAL_MS = 20; // Allows sub-second intervals in automated unit tests
const MAX_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_INITIAL_DELAY_MS = 30000; // 30 seconds after startup

function normalizePositiveInteger(value, defaultValue, minValue, maxValue, name) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < minValue || parsed > maxValue) {
    throw new TypeError(`${name} must be a positive whole number between ${minValue} and ${maxValue}.`);
  }
  return parsed;
}

class AutonomousMonitoringScheduler {
  constructor(db, options = {}) {
    if (!db) throw new TypeError('AutonomousMonitoringScheduler requires a database instance.');
    this.rawDb = db;
    this.logger = options.logger || cds.log('autonomous-scheduler');

    this.intervalMs = normalizePositiveInteger(
      options.intervalMs ?? process.env.AUTONOMOUS_MONITORING_INTERVAL_MS,
      DEFAULT_SCHEDULER_INTERVAL_MS,
      MIN_SCHEDULER_INTERVAL_MS,
      MAX_SCHEDULER_INTERVAL_MS,
      'AUTONOMOUS_MONITORING_INTERVAL_MS'
    );

    this.initialDelayMs = normalizePositiveInteger(
      options.initialDelayMs ?? process.env.AUTONOMOUS_INITIAL_DELAY_MS,
      DEFAULT_INITIAL_DELAY_MS,
      0,
      MAX_SCHEDULER_INTERVAL_MS,
      'AUTONOMOUS_INITIAL_DELAY_MS'
    );

    this.autoRecalculate = options.autoRecalculate !== false;
    this.status = 'STOPPED';
    this.timer = null;
    this.initialTimer = null;
    this.activeExecution = null;
    this.stoppingPromise = null;

    // Operational telemetry
    this.lastRunAt = null;
    this.lastCompletedAt = null;
    this.nextRunAt = null;
    this.totalRuns = 0;
    this.successfulRuns = 0;
    this.failedRuns = 0;
    this.skippedRuns = 0;
    this.lastRunDurationMs = 0;
    this.lastRunStatus = 'NONE';
    this.lastRunError = null;
    this.lastRunDetails = null;
  }

  get db() {
    return getDatabaseHandle(this.rawDb);
  }

  getStatus() {
    return {
      status: this.status,
      intervalMs: this.intervalMs,
      intervalMinutes: Math.round((this.intervalMs / 60000) * 100) / 100,
      initialDelayMs: this.initialDelayMs,
      autoRecalculate: this.autoRecalculate,
      lastRunAt: this.lastRunAt,
      lastCompletedAt: this.lastCompletedAt,
      nextRunAt: this.nextRunAt,
      totalRuns: this.totalRuns,
      successfulRuns: this.successfulRuns,
      failedRuns: this.failedRuns,
      skippedRuns: this.skippedRuns,
      lastRunDurationMs: this.lastRunDurationMs,
      lastRunStatus: this.lastRunStatus,
      lastRunError: this.lastRunError,
      lastRunDetails: this.lastRunDetails ? { ...this.lastRunDetails } : null
    };
  }

  generateSlotKey(now = new Date(), force = false) {
    if (force) return `manual:force:${randomUUID()}`;
    const window = Math.floor(now.getTime() / this.intervalMs);
    return `scheduled:5m:${window}`;
  }

  async executeCycle({ force = false, referenceDate = '2026-11-09', triggeredBy = 'AUTONOMOUS_SCHEDULER' } = {}) {
    if (this.stoppingPromise) {
      return { status: 'SKIPPED', reason: 'SCHEDULER_STOPPING' };
    }

    if (this.activeExecution) {
      this.logger.info({ event: 'autonomous_cycle_skipped_concurrent', active: true });
      this.skippedRuns++;
      return { status: 'SKIPPED', reason: 'CONCURRENT_CYCLE_IN_PROGRESS' };
    }

    const startHr = process.hrtime.bigint();
    const now = new Date();
    this.lastRunAt = now.toISOString();
    this.lastRunStatus = 'EXECUTING';
    this.lastRunError = null;
    this.totalRuns++;

    const slotKey = this.generateSlotKey(now, force);

    const task = (async () => {
      try {
        this.logger.info({ event: 'autonomous_cycle_started', slotKey, force, triggeredBy });

        // 1. Create or claim slot in credit.MonitoringRuns with unique constraint protection
        const claimed = await createMonitoringRun(this.db, {
          slotKey,
          runKind: force ? 'MANUAL' : 'SCHEDULED',
          source: 'local',
          triggeredBy,
          now
        });

        if (!claimed.created && !force) {
          this.logger.info({ event: 'autonomous_cycle_slot_already_claimed', slotKey });
          this.skippedRuns++;
          this.lastRunStatus = 'SKIPPED';
          return {
            status: 'SKIPPED',
            reason: 'SLOT_ALREADY_CLAIMED',
            slotKey,
            runId: claimed.run.ID
          };
        }

        // 2. Deterministic FIN-FSCM-CR Exposure Recalculation across all BPs and Segments
        let snapshotCount = 0;
        let autonomousDecisions = null;
        if (this.autoRecalculate) {
          try {
            const snapshots = await recalculateAllExposureSnapshots(this.db, { referenceDate });
            snapshotCount = snapshots?.length || 0;
            this.logger.info({ event: 'autonomous_recalculation_completed', snapshotCount });
          } catch (recalcError) {
            this.logger.warn({
              event: 'autonomous_recalculation_warning',
              message: recalcError.message
            });
          }

          try {
            const { processPendingRequestsAutonomously } = require('./autonomousDecisionEngine');
            autonomousDecisions = await processPendingRequestsAutonomously(this.db, { referenceDate });
            this.logger.info({
              event: 'autonomous_decisions_completed',
              evaluated: autonomousDecisions.evaluated_count,
              autoApproved: autonomousDecisions.auto_approved_count,
              autoRejected: autonomousDecisions.auto_rejected_count,
              escalated: autonomousDecisions.escalated_to_human_count
            });
          } catch (decisionError) {
            this.logger.warn({
              event: 'autonomous_decisions_warning',
              message: decisionError.message
            });
          }
        }

        // The background monitoringWorker polls QUEUED runs and executes monitorPortfolio + notifications
        const runId = claimed.run.ID;
        const currentRun = await getMonitoringRun(this.db, runId);
        const findings = await listMonitoringFindings(this.db, runId);

        const endHr = process.hrtime.bigint();
        const durationMs = Number((endHr - startHr) / 1000000n);

        this.lastCompletedAt = new Date().toISOString();
        this.lastRunDurationMs = durationMs;
        this.lastRunStatus = 'SUCCESS';
        this.successfulRuns++;
        this.lastRunDetails = {
          slotKey,
          runId,
          snapshotCount,
          autonomousDecisions: autonomousDecisions
            ? {
                evaluated: autonomousDecisions.evaluated_count,
                autoApproved: autonomousDecisions.auto_approved_count,
                autoRejected: autonomousDecisions.auto_rejected_count,
                escalated: autonomousDecisions.escalated_to_human_count
              }
            : null,
          findingsCount: findings.length,
          runStatus: currentRun?.status || 'QUEUED',
          executedAt: this.lastCompletedAt
        };

        this.logger.info({
          event: 'autonomous_cycle_finished',
          slotKey,
          runId,
          durationMs,
          snapshotCount
        });

        return {
          status: 'SUCCESS',
          slotKey,
          runId,
          snapshotCount,
          autonomousDecisions: this.lastRunDetails.autonomousDecisions,
          durationMs,
          run: currentRun || claimed.run
        };
      } catch (error) {
        const endHr = process.hrtime.bigint();
        const durationMs = Number((endHr - startHr) / 1000000n);

        this.lastCompletedAt = new Date().toISOString();
        this.lastRunDurationMs = durationMs;
        this.lastRunStatus = 'FAILED';
        this.lastRunError = error.message;
        this.failedRuns++;

        this.logger.error({
          event: 'autonomous_cycle_failed',
          slotKey,
          durationMs,
          error: error.message
        });

        return {
          status: 'FAILED',
          slotKey,
          durationMs,
          error: error.message
        };
      }
    })();

    this.activeExecution = task;
    try {
      return await task;
    } finally {
      this.activeExecution = null;
      if (this.status === 'RUNNING') {
        this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      }
    }
  }

  start() {
    if (this.status === 'RUNNING') return this;
    this.status = 'RUNNING';
    this.logger.info({
      event: 'autonomous_scheduler_started',
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs
    });

    const scheduleNext = () => {
      this.timer = setTimeout(async () => {
        if (this.status !== 'RUNNING') return;
        await this.executeCycle().catch(() => {});
        if (this.status === 'RUNNING') scheduleNext();
      }, this.intervalMs);
      this.timer.unref();
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    };

    if (this.initialDelayMs > 0) {
      this.nextRunAt = new Date(Date.now() + this.initialDelayMs).toISOString();
      this.initialTimer = setTimeout(async () => {
        if (this.status !== 'RUNNING') return;
        await this.executeCycle().catch(() => {});
        if (this.status === 'RUNNING') scheduleNext();
      }, this.initialDelayMs);
      this.initialTimer.unref();
    } else {
      this.executeCycle().catch(() => {});
      scheduleNext();
    }

    return this;
  }

  async stop(drainTimeoutMs = 5000) {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.status = 'STOPPED';
    this.nextRunAt = null;

    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.activeExecution) {
      return { drained: true };
    }

    this.logger.info({ event: 'autonomous_scheduler_draining', drainTimeoutMs });
    let timeoutId;
    this.stoppingPromise = Promise.race([
      this.activeExecution.then(() => ({ drained: true })),
      new Promise(resolve => {
        timeoutId = setTimeout(() => {
          this.logger.warn({ event: 'autonomous_scheduler_drain_timeout' });
          resolve({ drained: false });
        }, drainTimeoutMs);
      })
    ]).finally(() => {
      clearTimeout(timeoutId);
      this.activeExecution = null;
      this.stoppingPromise = null;
    });

    return this.stoppingPromise;
  }
}

let defaultSchedulerInstance = null;

function startAutonomousScheduler(db, options = {}) {
  if (defaultSchedulerInstance) {
    defaultSchedulerInstance.stop().catch(() => {});
  }
  defaultSchedulerInstance = new AutonomousMonitoringScheduler(db, options);
  defaultSchedulerInstance.start();
  return () => defaultSchedulerInstance?.stop();
}

function getAutonomousSchedulerInstance() {
  return defaultSchedulerInstance;
}

module.exports = {
  AutonomousMonitoringScheduler,
  DEFAULT_SCHEDULER_INTERVAL_MS,
  MIN_SCHEDULER_INTERVAL_MS,
  getAutonomousSchedulerInstance,
  startAutonomousScheduler
};
