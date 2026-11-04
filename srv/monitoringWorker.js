const {
  claimNextMonitoringRun,
  completeMonitoringRun,
  dispatchNotificationOutbox,
  failMonitoringRun,
  getMonitoringRun,
  requeueMonitoringRun,
  saveMonitoringAdvisory
} = require('./monitoringStore');
const { monitorPortfolio } = require('./monitoringService');
const {
  deterministicSummary,
  generateMonitoringSummary,
  safeSignals
} = require('./monitoringSummary');

const DEFAULT_EXECUTION_DEADLINE_MS = 120000;
const MAX_EXECUTION_DEADLINE_MS = 600000;
const DEFAULT_ADVISORY_TIMEOUT_MS = 10000;
const MAX_ADVISORY_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 8000;
const MAX_SHUTDOWN_DRAIN_TIMEOUT_MS = 120000;

function normalizePositiveSetting(value, defaultValue, maxValue, name) {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new TypeError(`${name} must be a positive whole number no greater than ${maxValue}.`);
  }
  return parsed;
}

function executionError(category, message) {
  const error = new Error(message);
  error.category = category;
  error.statusCode = category === 'monitoring_deadline_exceeded' ? 504 : 503;
  return error;
}

function safeErrorCategory(error) {
  return typeof error?.category === 'string'
    && /^[a-z][a-z0-9_]{0,39}$/.test(error.category)
    ? error.category : 'monitoring_worker_unavailable';
}

async function advisoryWithinDeadline(result, provider, timeoutMs, signal) {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  let timeout;
  let removeAbortListener = () => {};
  let timeoutResult;
  const timedOut = new Promise(resolve => {
    timeout = setTimeout(() => {
      const error = executionError('monitoring_advisory_timeout', 'Monitoring advisory timed out.');
      controller.abort(error);
      const signals = safeSignals(result);
      timeoutResult = {
        text: deterministicSummary(result.summary, signals.conditionCounts),
        source: 'DETERMINISTIC',
        errorCategory: 'monitoring_advisory_timeout'
      };
      resolve(timeoutResult);
    }, timeoutMs);
  });
  const cancelled = signal && new Promise(resolve => {
    const onAbort = () => {
      controller.abort(signal.reason);
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      generateMonitoringSummary(result, { provider, signal: controller.signal }).catch(error => {
        if (signal?.aborted) return null;
        if (controller.signal.aborted) return timeoutResult;
        throw error;
      }),
      timedOut,
      ...(cancelled ? [cancelled] : [])
    ]);
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
  }
}

async function processNextMonitoringJob({
  db,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient,
  provider,
  summaryProvider,
  deliverNotification,
  logger,
  now = () => new Date(),
  signal,
  executionDeadlineMs = normalizePositiveSetting(
    process.env.MONITORING_EXECUTION_DEADLINE_MS,
    DEFAULT_EXECUTION_DEADLINE_MS,
    MAX_EXECUTION_DEADLINE_MS,
    'MONITORING_EXECUTION_DEADLINE_MS'
  ),
  advisoryTimeoutMs = normalizePositiveSetting(
    process.env.MONITORING_ADVISORY_TIMEOUT_MS,
    DEFAULT_ADVISORY_TIMEOUT_MS,
    MAX_ADVISORY_TIMEOUT_MS,
    'MONITORING_ADVISORY_TIMEOUT_MS'
  )
} = {}) {
  if (!db) throw new TypeError('Monitoring worker requires a database.');
  const log = logger || require('@sap/cds').log('monitoring-worker');
  executionDeadlineMs = normalizePositiveSetting(
    executionDeadlineMs,
    DEFAULT_EXECUTION_DEADLINE_MS,
    MAX_EXECUTION_DEADLINE_MS,
    'MONITORING_EXECUTION_DEADLINE_MS'
  );
  advisoryTimeoutMs = normalizePositiveSetting(
    advisoryTimeoutMs,
    DEFAULT_ADVISORY_TIMEOUT_MS,
    MAX_ADVISORY_TIMEOUT_MS,
    'MONITORING_ADVISORY_TIMEOUT_MS'
  );
  const startedAt = now();
  const claimed = await claimNextMonitoringRun(db, {
    now: startedAt,
    leaseMs: executionDeadlineMs + 60000
  });
  if (!claimed) {
    if (signal?.aborted) return null;
    try {
      const outcomes = await dispatchNotificationOutbox(db, {
        deliver: deliverNotification,
        now: startedAt
      });
      const failures = outcomes.filter(item => item.status === 'FAILED').length;
      if (failures) log.warn({ event: 'monitoring_outbox_delivery_failed', failures });
    } catch (error) {
      log.warn({
        event: 'monitoring_outbox_processing_failed',
        category: safeErrorCategory(error)
      });
    }
    return null;
  }

  const controller = new AbortController();
  const shutdownError = executionError(
    'monitoring_worker_shutdown',
    'Monitoring execution was interrupted during worker shutdown.'
  );
  const abortForShutdown = () => {
    const reason = signal?.reason?.category ? signal.reason : shutdownError;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  signal?.addEventListener('abort', abortForShutdown, { once: true });
  if (signal?.aborted) abortForShutdown();
  const deadlineAt = Date.now() + executionDeadlineMs;
  const deadlineError = executionError(
    'monitoring_deadline_exceeded',
    'Monitoring execution exceeded its configured deadline.'
  );
  let deadlineTimer;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
      resolve({ deadline: true });
    }, executionDeadlineMs);
  });

  let result;
  let completed;
  try {
    const execution = (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const user = { id: claimed.triggeredBy, is: role => role === 'CreditReader' };
      result = await monitorPortfolio({
        db,
        user,
        source,
        abapClient,
        provider,
        now: now(),
        signal: controller.signal,
        deadlineAt
      });
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        throw controller.signal.reason || deadlineError;
      }
      completed = await completeMonitoringRun(
        db,
        claimed.ID,
        result,
        claimed.triggeredBy,
        now(),
        claimed.attemptCount,
        claimed.workerToken,
        deadlineAt
      );
      return completed;
    })();
    const settled = execution.then(
      value => ({ value }),
      error => ({ error })
    );
    const first = await Promise.race([settled, deadline]);
    const outcome = first.deadline ? await settled : first;
    if (outcome.error) throw outcome.error;
    completed = outcome.value;
  } catch (error) {
    const effectiveError = controller.signal.aborted ? controller.signal.reason || error : error;
    if (effectiveError?.category === 'monitoring_worker_shutdown') {
      const requeued = await requeueMonitoringRun(
        db,
        claimed.ID,
        now(),
        claimed.attemptCount,
        claimed.workerToken
      );
      return requeued || await getMonitoringRun(db, claimed.ID);
    }
    const safeError = effectiveError?.category
      ? effectiveError
      : executionError('monitoring_source_error', 'Monitoring source execution failed.');
    const failed = await failMonitoringRun(
      db,
      claimed.ID,
      safeError,
      now(),
      claimed.attemptCount,
      claimed.workerToken
    );
    return failed || await getMonitoringRun(db, claimed.ID);
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abortForShutdown);
  }

  const advisory = await advisoryWithinDeadline(
    result,
    summaryProvider,
    advisoryTimeoutMs,
    signal
  );
  if (!advisory) return completed;
  try {
    await saveMonitoringAdvisory(db, claimed.ID, advisory);
  } catch (error) {
    log.warn({
      event: 'monitoring_advisory_persistence_failed',
      category: safeErrorCategory(error)
    });
  }
  try {
    const outcomes = await dispatchNotificationOutbox(db, {
      deliver: deliverNotification,
      now: now()
    });
    const failures = outcomes.filter(item => item.status === 'FAILED').length;
    if (failures) log.warn({ event: 'monitoring_outbox_delivery_failed', failures });
  } catch (error) {
    log.warn({
      event: 'monitoring_outbox_processing_failed',
      category: safeErrorCategory(error)
    });
  }
  return completed;
}

function startMonitoringWorker(db, {
  logger,
  pollIntervalMs = normalizePositiveSetting(
    process.env.MONITORING_WORKER_POLL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    'MONITORING_WORKER_POLL_MS'
  ),
  shutdownDrainTimeoutMs = normalizePositiveSetting(
    process.env.MONITORING_WORKER_DRAIN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    MAX_SHUTDOWN_DRAIN_TIMEOUT_MS,
    'MONITORING_WORKER_DRAIN_TIMEOUT_MS'
  ),
  ...workerOptions
} = {}) {
  if (!db) throw new TypeError('Monitoring worker requires a database.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0
    || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new TypeError(`MONITORING_WORKER_POLL_MS must be a positive whole number no greater than ${MAX_POLL_INTERVAL_MS}.`);
  }
  const resolvedWorkerOptions = {
    ...workerOptions,
    executionDeadlineMs: normalizePositiveSetting(
      workerOptions.executionDeadlineMs === undefined
        ? process.env.MONITORING_EXECUTION_DEADLINE_MS
        : workerOptions.executionDeadlineMs,
      DEFAULT_EXECUTION_DEADLINE_MS,
      MAX_EXECUTION_DEADLINE_MS,
      'MONITORING_EXECUTION_DEADLINE_MS'
    ),
    advisoryTimeoutMs: normalizePositiveSetting(
      workerOptions.advisoryTimeoutMs === undefined
        ? process.env.MONITORING_ADVISORY_TIMEOUT_MS
        : workerOptions.advisoryTimeoutMs,
      DEFAULT_ADVISORY_TIMEOUT_MS,
      MAX_ADVISORY_TIMEOUT_MS,
      'MONITORING_ADVISORY_TIMEOUT_MS'
    )
  };
  shutdownDrainTimeoutMs = normalizePositiveSetting(
    shutdownDrainTimeoutMs,
    DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    MAX_SHUTDOWN_DRAIN_TIMEOUT_MS,
    'MONITORING_WORKER_DRAIN_TIMEOUT_MS'
  );
  let acceptingClaims = true;
  let activePoll;
  let activeController;
  let stopPromise;
  const log = logger || require('@sap/cds').log('monitoring-worker');
  resolvedWorkerOptions.logger = log;
  const poll = () => {
    if (!acceptingClaims || activePoll) return activePoll;
    const controller = new AbortController();
    activeController = controller;
    const task = (async () => {
      while (acceptingClaims) {
        const run = await processNextMonitoringJob({
          db,
          ...resolvedWorkerOptions,
          signal: controller.signal
        });
        if (!run || !acceptingClaims) break;
        log.info({ event: 'monitoring_job_finished', status: run.status });
      }
    })().catch(error => {
      log.warn({
        event: 'monitoring_worker_error',
        category: error?.category || 'monitoring_worker_unavailable'
      });
    });
    let wrappedTask;
    wrappedTask = task.finally(() => {
      if (activePoll === wrappedTask) {
        activePoll = null;
        activeController = null;
      }
    });
    activePoll = wrappedTask;
    return activePoll;
  };
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref();
  queueMicrotask(poll);
  return () => {
    if (stopPromise) return stopPromise;
    acceptingClaims = false;
    clearInterval(timer);
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(executionError(
        'monitoring_worker_shutdown',
        'Monitoring worker is shutting down.'
      ));
    }
    if (!activePoll) return Promise.resolve({ drained: true });
    let drainTimer;
    stopPromise = Promise.race([
      activePoll.then(() => ({ drained: true })),
      new Promise(resolve => {
        drainTimer = setTimeout(() => {
          log.warn({
            event: 'monitoring_worker_drain_timeout',
            timeoutMs: shutdownDrainTimeoutMs
          });
          resolve({ drained: false });
        }, shutdownDrainTimeoutMs);
      })
    ]).finally(() => clearTimeout(drainTimer));
    return stopPromise;
  };
}

module.exports = {
  DEFAULT_ADVISORY_TIMEOUT_MS,
  DEFAULT_EXECUTION_DEADLINE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  MAX_ADVISORY_TIMEOUT_MS,
  MAX_EXECUTION_DEADLINE_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_SHUTDOWN_DRAIN_TIMEOUT_MS,
  normalizePositiveSetting,
  processNextMonitoringJob,
  startMonitoringWorker
};
