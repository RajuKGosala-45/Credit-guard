/**
 * Shared Application Store & Freshness Computation
 * ----------------------------------------------------------------------------
 * Single source of truth across all Credit Guard tabs (Credit Overview,
 * Portfolio & Monitoring, Exposure Analysis, Limit Approvals, SAP BTP & HANA CDS,
 * AI Credit Assistance, and AI Audit History).
 *
 * ARCHITECTURE NOTE:
 * In production, the 5-minute extraction and credit monitoring job should run
 * as a backend scheduled job (for example, an SAP BTP Job Scheduler / CAP cron
 * worker), with the frontend only polling or subscribing for the persisted
 * result. The frontend 5-minute interval is used only for this local demo.
 */

export const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 300000 ms (5 minutes)
export const FRESHNESS_EVAL_INTERVAL_MS = 30 * 1000;  // 30000 ms (30 seconds)
export const FRESH_MAX_AGE_MS = 6 * 60 * 1000;        // <= 6 minutes
export const DELAYED_MAX_AGE_MS = 15 * 60 * 1000;     // 6 to 15 minutes

export const MAX_EXTRACTION_RUNS = 50;

export const state = {
  currentTab: 'home',
  sidebarCollapsed: false,
  selectedCustomer: null,
  exposureGroup: 'country',
  session: null,

  // Central shared data store (single source of truth across all tabs)
  portfolioData: null,
  retrievedAt: null,
  lastSuccessfulAt: null,
  extractionStatus: 'IDLE', // 'IDLE' | 'RUNNING' | 'SUCCESS' | 'FAILED'
  lastError: null,
  nextRunAt: null,
  monitoringData: null,
  extractionRuns: [],
  v2Connectors: null,
  schedulerStatus: null,
  mockSapStagingCustomers: [],

  // Direct references to the shared portfolioData slices used by tab views
  dashboard: null,
  customers: [],
  requests: [],
  mockSap: null,
  mockSapMonitoring: null,
  agentExecution: null,
  documentContext: null,
  chatMessages: [],
  conversationId: null,
  geminiStatus: null
};

export function recordExtractionRun(run = {}, store = state) {
  if (!store || typeof store !== 'object') return null;
  if (!Array.isArray(store.extractionRuns)) store.extractionRuns = [];
  const finishedAt = run.finishedAt || run.completedAt || new Date().toISOString();
  const startedAt = run.startedAt || finishedAt;
  const sourceId = String(run.sourceId || 'CAP-HANA-CDS').trim();
  const sourceName = String(run.sourceName || sourceId).trim();
  const rawStatus = String(run.status || 'COMPLETED').toUpperCase();
  const status = rawStatus === 'FAILED' || rawStatus === 'ERROR' ? 'FAILED' : 'COMPLETED';
  const triggeredBy = String(run.triggeredBy || 'SCHEDULER').toUpperCase();
  const runId = run.runId || run.id || `${sourceId}:${finishedAt}:${triggeredBy}`;

  if (store.extractionRuns.some(existing =>
    existing.runId === runId
    || (existing.finishedAt === finishedAt && existing.sourceId === sourceId && existing.status === status && existing.triggeredBy === triggeredBy)
  )) {
    return null;
  }

  let durationMs = Number.isFinite(Number(run.durationMs)) ? Number(run.durationMs) : null;
  if (durationMs === null) {
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(finishedAt);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      durationMs = Math.max(0, endMs - startMs);
    }
  }

  const recordCounts = run.recordCounts && typeof run.recordCounts === 'object'
    ? { ...run.recordCounts }
    : (Number.isFinite(Number(run.recordCount)) ? { total: Number(run.recordCount) } : null);

  const entry = {
    runId,
    startedAt,
    finishedAt,
    durationMs,
    sourceId,
    sourceName,
    status,
    recordCounts,
    error: run.error ? String(run.error) : null,
    triggeredBy
  };

  store.extractionRuns.unshift(entry);
  if (store.extractionRuns.length > MAX_EXTRACTION_RUNS) {
    store.extractionRuns.length = MAX_EXTRACTION_RUNS;
  }
  return entry;
}

export function updateConnectorSyncTimestamp(sourceIds, timestampIso, store = state) {
  if (!store || typeof store !== 'object' || !sourceIds || !timestampIso) return;
  const targets = Array.isArray(sourceIds)
    ? sourceIds.map(id => String(id).trim().toUpperCase()).filter(Boolean)
    : [String(sourceIds).trim().toUpperCase()].filter(Boolean);
  if (targets.length === 0) return;

  const updateAllActive = targets.includes('ACTIVE');
  const targetSet = new Set(targets);
  const sources = store.v2Connectors?.sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const id = String(s.source_id || s.sourceId || s.id || '').trim().toUpperCase();
      const status = String(s.status || '').trim().toUpperCase();
      if ((updateAllActive && status === 'ACTIVE') || targetSet.has(id)) {
        s.last_sync_at = timestampIso;
        s.lastRetrieved = timestampIso;
      }
    }
  }
  if ((updateAllActive || targetSet.has('MOCK-SAP-FIN-FSCM') || targetSet.has('MOCK-S4-001')) && store.mockSap?.source) {
    store.mockSap.source.lastSyncedAt = timestampIso;
  }
}

export function formatTimestampDisplay(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(d);
}

export function formatCountdownClock(nextRunAt, nowMs = Date.now(), padMinutes = false) {
  if (!nextRunAt) return padMinutes ? '05:00' : '5:00';
  const targetMs = Date.parse(nextRunAt);
  if (Number.isNaN(targetMs)) return padMinutes ? '05:00' : '5:00';
  const remainingSec = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const minStr = padMinutes ? String(mins).padStart(2, '0') : String(mins);
  const secStr = String(secs).padStart(2, '0');
  return `${minStr}:${secStr}`;
}

export function computeFreshnessState(store = state, nowMs = Date.now()) {
  const lastSuccessMs = store?.lastSuccessfulAt ? Date.parse(store.lastSuccessfulAt) : NaN;
  const hasValidLastSuccess = Number.isFinite(lastSuccessMs);
  const ageMs = hasValidLastSuccess ? Math.max(0, nowMs - lastSuccessMs) : null;

  const countdownShort = formatCountdownClock(store?.nextRunAt, nowMs, false);
  const countdownPadded = formatCountdownClock(store?.nextRunAt, nowMs, true);
  const lastRetrievedFormatted = formatTimestampDisplay(store?.retrievedAt || store?.lastSuccessfulAt);

  const baseTooltip = `Source: CAP database (demo). Last retrieved: ${lastRetrievedFormatted}. Auto-refresh every 5 minutes. Status rules: Fresh <= 6 min, Delayed 6-15 min, Stale > 15 min.`;

  if (store?.extractionStatus === 'FAILED') {
    const lastGoodDisplay = hasValidLastSuccess
      ? formatTimestampDisplay(store.lastSuccessfulAt)
      : 'none';
    return {
      status: 'FAILED',
      tone: 'failed',
      icon: '!',
      ageMs,
      relativeText: `last good data: ${lastGoodDisplay}`,
      countdownShort,
      countdownPadded,
      tooltip: store.lastError ? `${baseTooltip} Last error: ${store.lastError}` : baseTooltip
    };
  }

  if (!hasValidLastSuccess) {
    return {
      status: 'UNKNOWN',
      tone: 'unknown',
      icon: '○',
      ageMs: null,
      relativeText: 'Waiting for initial extraction…',
      countdownShort,
      countdownPadded,
      tooltip: baseTooltip
    };
  }

  const ageMinutes = Math.max(0, Math.floor(ageMs / 60000));
  const relativeText = ageMinutes === 0
    ? 'Updated just now'
    : `Updated ${ageMinutes} min ago`;

  if (ageMs <= FRESH_MAX_AGE_MS) {
    return {
      status: 'FRESH',
      tone: 'fresh',
      icon: '✓',
      ageMs,
      relativeText,
      countdownShort,
      countdownPadded,
      tooltip: baseTooltip
    };
  }

  if (ageMs <= DELAYED_MAX_AGE_MS) {
    return {
      status: 'DELAYED',
      tone: 'delayed',
      icon: '▲',
      ageMs,
      relativeText,
      countdownShort,
      countdownPadded,
      tooltip: baseTooltip
    };
  }

  return {
    status: 'STALE',
    tone: 'stale',
    icon: '!',
    ageMs,
    relativeText,
    countdownShort,
    countdownPadded,
    tooltip: baseTooltip
  };
}
