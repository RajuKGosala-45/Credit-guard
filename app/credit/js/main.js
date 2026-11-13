import * as api from './api.js';
import {
  AUTO_REFRESH_INTERVAL_MS,
  FRESHNESS_EVAL_INTERVAL_MS,
  computeFreshnessState,
  recordExtractionRun,
  state,
  updateConnectorSyncTimestamp
} from './state.js';
import { renderKpis, renderCreditOverview, renderExposure, handleExposureGroup } from './views/dashboard.js';
import { renderMonitoring } from './views/monitoring.js';
import { renderCustomers, handleCustomerClick } from './views/customers.js';
import {
  renderLimitRequestAvailability,
  renderRequestCustomers,
  handleRequestSubmit
} from './views/limitRequest.js';
import { renderApprovals, handleApprovalClick } from './views/approvals.js';
import { renderChat, handleChatSubmit, explainCustomer } from './views/chat.js';
import { renderMockSap, renderMockSapMonitoring } from './views/mockSap.js';
import { renderDataSourcesPanel, renderSchedulerPanel, loadSchedulerStatus } from './views/connectorsView.js';

const errorHost = document.querySelector('#global-error');
const pageCopy = Object.freeze({
  chat: [
    'AI Credit Assistance',
    'Ask policy-grounded credit questions, evaluate customer risk, draft limit change proposals, and inspect agent execution history.'
  ],
  overview: [
    'Credit overview',
    'Summary of portfolio credit exposure, utilisation health, and priority items requiring attention.'
  ],
  dashboard: [
    'Portfolio & Monitoring',
    'Run manual credit monitoring, inspect active alerts and customer findings, and submit credit limit change requests.'
  ],
  analysis: [
    'Exposure Analysis',
    'Review credit exposure by country, company code, and customer across the accounts receivable portfolio.'
  ],
  approvals: [
    'Limit Approvals',
    'Review pending credit limit requests and record authorized Credit Controller and Finance Head decisions.'
  ],
  simulator: [
    'SAP BTP & HANA CDS',
    'Inspect synthetic SAP S/4HANA source entities, canonical CAP / HANA ingestion runs, and deterministic monitoring.'
  ],
  audit: [
    'AI Audit History',
    'Review agent execution history, memory, and enterprise connector status.'
  ]
});

function updatePageHeading(tab) {
  const [title, subtitle] = pageCopy[tab] || pageCopy.chat;
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#page-subtitle').textContent = subtitle;
}

function showError(message) {
  errorHost.hidden = false;
  errorHost.textContent = `${message} If the issue continues, restart the server and reload.`;
}

const tabSections = {
  chat: [],
  overview: [],
  dashboard: [
    { id: 'sec-monitoring', label: 'Manual Credit Monitoring' },
    { id: 'sec-limit-request', label: 'Request Limit Change' }
  ],
  analysis: [
    { id: 'sec-exposure-analysis', label: 'Exposure Analysis' },
    { id: 'sec-ar-portfolio', label: 'Accounts Receivable Portfolio' }
  ],
  approvals: [
    { id: 'sec-autonomous-engine', label: 'Autonomous Policy Engine' },
    { id: 'sec-human-approvals', label: 'Limit Change Approvals' }
  ],
  simulator: [
    { id: 'sec-connectors', label: 'Connectors & Schema Discovery' },
    { id: 'sec-scheduler', label: 'Autonomous Scheduler Daemon' },
    { id: 'sec-sap-integration', label: 'SAP S/4HANA & FSCM Integration' }
  ],
  audit: [
    { id: 'sec-audit-memory', label: 'Audit & Memory' },
    { id: 'sec-enterprise-integration', label: 'Enterprise Integration' },
    { id: 'sec-execution-status', label: 'Execution Status' }
  ],
  home: []
};

function renderSectionShortcuts(tab) {
  const bar = document.querySelector('#section-shortcuts-bar');
  if (!bar) return;
  const sections = tabSections[tab] || [];
  if (sections.length === 0 || tab === 'home' || tab === 'chat') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = sections.map((sec, idx) => `
    <button type="button" class="shortcut-tab-btn ${idx === 0 ? 'active' : ''}" data-target="${sec.id}" style="background: transparent; border: none; padding: 0.4rem 0.8rem; font-size: 0.9rem; font-weight: 600; color: #475569; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; white-space: nowrap;">
      ${sec.label}
    </button>
  `).join('');
}

function scrollWorkspaceToSection(el) {
  if (!el) return;
  const wsMain = document.querySelector('.workspace-main');
  if (wsMain) {
    const shortcutBar = document.querySelector('#section-shortcuts-bar');
    const stickyOffset = shortcutBar && shortcutBar.offsetHeight ? shortcutBar.offsetHeight + 16 : 56;
    const mainRect = wsMain.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const targetTop = wsMain.scrollTop + (elRect.top - mainRect.top) - stickyOffset;
    wsMain.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function switchAuditSubtab(targetId) {
  const sections = {
    'sec-audit-memory': document.querySelector('#sec-audit-memory'),
    'sec-enterprise-integration': document.querySelector('#sec-enterprise-integration'),
    'sec-execution-status': document.querySelector('#sec-execution-status')
  };

  const activeId = sections[targetId] ? targetId : 'sec-audit-memory';

  Object.entries(sections).forEach(([id, el]) => {
    if (el) {
      el.style.display = id === activeId ? 'block' : 'none';
    }
  });

  document.querySelectorAll('#section-shortcuts-bar .shortcut-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === activeId);
  });
}

document.querySelector('#section-shortcuts-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-target]');
  if (!btn) return;
  const targetId = btn.dataset.target;
  if (state.currentTab === 'audit') {
    switchAuditSubtab(targetId);
    return;
  }
  const el = document.getElementById(targetId);
  if (el) {
    scrollWorkspaceToSection(el);
    document.querySelectorAll('.shortcut-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
});

function switchTab(tabName) {
  if (!tabName) return;
  if (tabName === 'audit-history' || tabName === 'ai-audit-history') tabName = 'audit';
  state.currentTab = tabName;
  const isHome = tabName === 'home';

  const homeContainer = document.querySelector('#home-view-container');
  const appContainer = document.querySelector('#app-workspace-container');
  const wsMain = document.querySelector('.workspace-main');

  if (homeContainer) {
    homeContainer.style.display = isHome ? 'flex' : 'none';
    homeContainer.scrollTop = 0;
  }
  if (appContainer) appContainer.style.display = isHome ? 'none' : 'grid';
  if (wsMain) wsMain.scrollTop = 0;

  if (!isHome) {
    updatePageHeading(state.currentTab);
    renderSectionShortcuts(state.currentTab);
  } else {
    renderSectionShortcuts('home');
  }

  document.querySelectorAll('[data-tab]').forEach(tab => {
    const isActive = tab.dataset.tab === state.currentTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    const isActive = panel.id === `${state.currentTab}-panel`;
    panel.classList.toggle('active', isActive);
    panel.style.removeProperty('display');
  });

  if (state.currentTab === 'overview' || state.currentTab === 'dashboard' || state.currentTab === 'analysis' || state.currentTab === 'approvals' || state.currentTab === 'chat') {
    if (state.portfolioData) {
      refreshPortfolio();
      if (state.monitoringData) {
        renderMonitoring({
          ...state.monitoringData,
          sharedState: buildSharedMonitoringState()
        });
      }
    } else if (state.extractionStatus === 'IDLE') {
      runExtractionAndMonitoringCycle({ trigger: 'tab-switch' }).catch(error => showError(error.message));
    }
  }
  if (state.currentTab === 'simulator') {
    loadMockSap().catch(error => {
      document.querySelector('#mock-sap-error').textContent = error.message;
      showError(error.message);
    });
  }
  if (state.currentTab === 'audit') {
    switchAuditSubtab('sec-audit-memory');
    loadAgentHistory().catch(error => showError(error.message));
  }
}

window.switchTab = switchTab;
window.switchAuditSubtab = switchAuditSubtab;

function canAttemptExecutionRecovery(execution) {
  if (execution.recoveryStatus === 'AVAILABLE') return true;
  if (!['ACTIVE', 'RECOVERING'].includes(execution.recoveryStatus)) return false;
  if (execution.plan?.tasks?.some(task => task.status === 'RUNNING')) return false;
  const updatedAt = Date.parse(execution.updatedAt || execution.startedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > 60000;
}

function buildSharedMonitoringState(nowMs = Date.now()) {
  const freshness = computeFreshnessState(state, nowMs);
  return {
    source: state.portfolioData?.source || 'CAP database (demo)',
    retrievedAt: state.retrievedAt,
    lastSuccessfulAt: state.lastSuccessfulAt,
    freshnessStatus: freshness.status,
    countdownPadded: freshness.countdownPadded
  };
}

function renderFreshnessIndicator(nowMs = Date.now()) {
  const freshness = computeFreshnessState(state, nowMs);
  const badgeEl = document.querySelector('#freshness-badge');
  const iconEl = document.querySelector('#freshness-icon');
  const statusEl = document.querySelector('#last-updated');
  const relativeEl = document.querySelector('#freshness-relative');
  const countdownEl = document.querySelector('#freshness-countdown');
  const tooltipEl = document.querySelector('#freshness-tooltip');
  const autoRunEl = document.querySelector('#monitoring-autorun');

  if (badgeEl) {
    badgeEl.className = `freshness-badge freshness-badge--${freshness.tone}`;
  }
  if (iconEl) {
    iconEl.textContent = freshness.icon;
  }
  if (statusEl) {
    statusEl.textContent = freshness.status;
  }
  if (relativeEl) {
    relativeEl.textContent = freshness.relativeText;
  }
  if (countdownEl) {
    countdownEl.textContent = `Next refresh in ${freshness.countdownShort}`;
  }
  if (tooltipEl) {
    tooltipEl.textContent = freshness.tooltip;
  }
  if (autoRunEl) {
    autoRunEl.textContent = `Auto-run: ON · next run in ${freshness.countdownPadded}`;
  }
}

function applyPortfolioDataToStore(payload) {
  state.portfolioData = payload;
  state.retrievedAt = payload.retrievedAt;
  state.lastSuccessfulAt = payload.retrievedAt;
  state.extractionStatus = 'SUCCESS';
  state.lastError = null;
  state.dashboard = payload.dashboard;
  state.customers = payload.customers;
  state.requests = payload.requests;
  state.mockSap = payload.mockSap;
  state.mockSapStagingCustomers = payload.mockSapStagingCustomers || [];
  if (payload.v2Connectors) state.v2Connectors = payload.v2Connectors;
  if (payload.schedulerStatus) state.schedulerStatus = payload.schedulerStatus;
  refreshPortfolio();
}

function refreshPortfolio() {
  if (state.dashboard) {
    renderCreditOverview(state.dashboard, state.requests);
    renderExposure(state.dashboard, state.exposureGroup);
    renderExposure(state.dashboard, 'customer', '#customer-exposure-list');
  }
  if (Array.isArray(state.customers) && state.customers.length) {
    renderCustomers(state.customers);
    renderRequestCustomers(state.customers);
  }
  if (Array.isArray(state.requests) && state.session) {
    renderApprovals(state.requests, state.session);
  }
  renderFreshnessIndicator();
}

async function loadPortfolio() {
  const payload = await api.fetchPortfolioData();
  applyPortfolioDataToStore(payload);
  return payload;
}

async function loadSession() {
  state.session = await api.getSession();
  renderLimitRequestAvailability(state.session);
  renderChat(state.chatMessages, state.agentExecution, state.session.permissions);
  if (Array.isArray(state.requests) && state.requests.length) {
    renderApprovals(state.requests, state.session);
  }
}

async function loadApprovals() {
  const requests = await api.getLimitRequests();
  state.requests = await Promise.all(requests.map(async request => ({
    ...request,
    auditHistory: request.status === 'Pending' ? [] : await api.getApprovalHistory(request.ID)
  })));
  if (state.portfolioData) {
    state.portfolioData.requests = state.requests;
  }
  renderApprovals(state.requests, state.session);
  if (state.dashboard) {
    renderCreditOverview(state.dashboard, state.requests);
  }
}

async function loadCustomerApprovalHistory(customerId) {
  const requests = await api.getLimitRequests();
  const decided = requests.filter(request =>
    request.customer_ID === customerId && request.status !== 'Pending');
  const histories = await Promise.all(decided.map(request => api.getApprovalHistory(request.ID)));
  return histories.flat();
}

async function loadMonitoring({ triggerRun = false } = {}) {
  let [summary, runs, alerts] = await Promise.all([
    api.getMonitoringSummary(),
    api.getMonitoringRuns(),
    api.getMonitoringAlerts()
  ]);
  const shouldTriggerMonitoringRun = summary.canOperate && (triggerRun || !summary.latestRun);
  if (shouldTriggerMonitoringRun) {
    try {
      const started = await api.runMonitoring();
      if (started.status === 'QUEUED' || started.status === 'RUNNING') {
        await api.waitForMonitoringRun(started.id, {
          onStatus: current => {
            const statusEl = document.querySelector('#monitoring-status');
            if (statusEl) {
              statusEl.textContent = `Monitoring run ${current.status.toLowerCase()} · waiting for a terminal result.`;
            }
          }
        });
      }
      [summary, runs, alerts] = await Promise.all([
        api.getMonitoringSummary(),
        api.getMonitoringRuns(),
        api.getMonitoringAlerts()
      ]);
    } catch {
      // Retain existing monitoring summary if background run cannot complete
    }
  }
  state.monitoringData = {
    summary,
    runs,
    alerts,
    findings: summary.latestRun?.findings || []
  };
  renderMonitoring({
    ...state.monitoringData,
    sharedState: buildSharedMonitoringState()
  });
  return state.monitoringData;
}

/**
 * ARCHITECTURE NOTE:
 * In production, the 5-minute extraction and monitoring cycle should run as a
 * backend scheduled job (for example, an SAP BTP Job Scheduler or CAP cron job),
 * with the frontend only polling or subscribing for the result. The frontend
 * timer below is used only for this demo.
 */
let autoRefreshIntervalId = null;
let freshnessEvalIntervalId = null;
let countdownTickIntervalId = null;

function resetAutoRefreshCountdown(nowMs = Date.now()) {
  state.nextRunAt = new Date(nowMs + AUTO_REFRESH_INTERVAL_MS).toISOString();
  if (autoRefreshIntervalId !== null) {
    clearInterval(autoRefreshIntervalId);
  }
  autoRefreshIntervalId = setInterval(() => {
    runExtractionAndMonitoringCycle({ trigger: 'scheduled' }).catch(() => {});
  }, AUTO_REFRESH_INTERVAL_MS);
  renderFreshnessIndicator(nowMs);
}

async function runExtractionAndMonitoringCycle({ trigger = 'scheduled' } = {}) {
  if (state.extractionStatus === 'RUNNING') {
    return null;
  }
  state.extractionStatus = 'RUNNING';
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const triggeredBy = trigger === 'manual-refresh' ? 'MANUAL' : 'SCHEDULER';
  try {
    // Step 1: Extract deterministic portfolio data via central data service
    const payload = await api.fetchPortfolioData();
    // Step 2: Update retrievedAt, lastSuccessfulAt, and shared store
    applyPortfolioDataToStore(payload);
    recordExtractionRun({
      startedAt,
      finishedAt: payload.retrievedAt,
      durationMs: Date.now() - startMs,
      sourceId: 'CAP-HANA-CDS',
      sourceName: payload.source || 'CAP database (demo)',
      status: 'COMPLETED',
      recordCounts: { customers: payload.customers?.length ?? 0 },
      triggeredBy
    });
    updateConnectorSyncTimestamp('ACTIVE', payload.retrievedAt);
    errorHost.hidden = true;
    // Step 3: Automatically run monitoring logic on the refreshed data
    await loadMonitoring({ triggerRun: true });
    // Refresh simulator panels if user is viewing SAP BTP & HANA CDS
    if (state.currentTab === 'simulator') {
      const connectorsHost = document.querySelector('#connectors-workspace');
      if (connectorsHost && connectorsHost.hasChildNodes()) {
        renderDataSourcesPanel(connectorsHost).catch(() => {});
      }
      if (state.mockSap) {
        renderMockSap(state.mockSap, state.session?.permissions, state.extractionRuns, {
          preserveMonitoringStatus: Boolean(state.mockSapMonitoring)
        });
      }
    }
    // Step 4: Update nextRunAt
    resetAutoRefreshCountdown();
    return payload;
  } catch (error) {
    // On failure: keep previous data intact, set FAILED, record error, and retry on next cycle
    state.extractionStatus = 'FAILED';
    state.lastError = error.message || 'Data extraction failed.';
    recordExtractionRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      sourceId: 'CAP-HANA-CDS',
      sourceName: 'CAP database (demo)',
      status: 'FAILED',
      recordCounts: null,
      error: state.lastError,
      triggeredBy
    });
    resetAutoRefreshCountdown();
    if (state.monitoringData) {
      renderMonitoring({
        ...state.monitoringData,
        sharedState: buildSharedMonitoringState()
      });
    }
    showError(`Data extraction failed (${state.lastError}). Retaining last known good portfolio data.`);
    if (trigger === 'manual-refresh') {
      throw error;
    }
    return null;
  }
}

function startAppLevelScheduler() {
  cleanupAppLevelScheduler();
  resetAutoRefreshCountdown();

  freshnessEvalIntervalId = setInterval(() => {
    renderFreshnessIndicator();
    if (state.monitoringData) {
      renderMonitoring({
        ...state.monitoringData,
        sharedState: buildSharedMonitoringState()
      });
    }
  }, FRESHNESS_EVAL_INTERVAL_MS);

  countdownTickIntervalId = setInterval(() => {
    renderFreshnessIndicator();
  }, 1000);
}

function cleanupAppLevelScheduler() {
  if (autoRefreshIntervalId !== null) {
    clearInterval(autoRefreshIntervalId);
    autoRefreshIntervalId = null;
  }
  if (freshnessEvalIntervalId !== null) {
    clearInterval(freshnessEvalIntervalId);
    freshnessEvalIntervalId = null;
  }
  if (countdownTickIntervalId !== null) {
    clearInterval(countdownTickIntervalId);
    countdownTickIntervalId = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const nextMs = state.nextRunAt ? Date.parse(state.nextRunAt) : 0;
    if (!nextMs || Date.now() >= nextMs) {
      runExtractionAndMonitoringCycle({ trigger: 'visibility-catchup' }).catch(() => {});
    } else {
      renderFreshnessIndicator();
    }
  }
});

window.addEventListener('beforeunload', cleanupAppLevelScheduler);
window.creditGuardState = state;
window.setSimulatedExtractionFailure = api.setSimulatedExtractionFailure;
window.triggerPortfolioRefresh = () => runExtractionAndMonitoringCycle({ trigger: 'manual-refresh' });
window.renderFreshnessIndicator = renderFreshnessIndicator;

async function loadMockSap() {
  const connectorsHost = document.querySelector('#connectors-workspace');
  if (connectorsHost && !connectorsHost.hasChildNodes()) {
    renderDataSourcesPanel(connectorsHost).catch(() => {});
  }
  const schedulerHost = document.querySelector('#scheduler-workspace');
  if (schedulerHost && !schedulerHost.hasChildNodes()) {
    renderSchedulerPanel(schedulerHost).catch(() => {});
  }
  state.mockSap = await api.getMockSap();
  renderMockSap(state.mockSap, state.session?.permissions, state.extractionRuns, {
    preserveMonitoringStatus: Boolean(state.mockSapMonitoring)
  });
}

document.querySelector('#ai-welcome-board')?.addEventListener('click', event => {
  const promptCard = event.target.closest('[data-agent-prompt]');
  if (promptCard) {
    const promptText = promptCard.dataset.agentPrompt;
    const input = document.querySelector('#chat-input');
    if (input && promptText) {
      input.value = promptText;
      document.querySelector('#chat-form').requestSubmit();
    }
  }
});

document.querySelector('#refresh-mock-sap').addEventListener('click', async event => {
  const button = event.currentTarget;
  const originalText = button.textContent || 'Reload simulator data';
  const errorEl = document.querySelector('#mock-sap-error');
  const msgEl = document.querySelector('#mock-sap-action-message');
  button.disabled = true;
  button.textContent = 'Reloading…';
  if (errorEl) errorEl.textContent = '';
  if (msgEl) {
    msgEl.textContent = 'Reloading SAP S/4HANA simulator records…';
    msgEl.className = 'form-message';
  }
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  try {
    await loadMockSap();
    const connectorsHost = document.querySelector('#connectors-workspace');
    if (connectorsHost) await renderDataSourcesPanel(connectorsHost).catch(() => {});
    const finishedAt = new Date().toISOString();
    const customerCount = state.mockSap?.entities?.CUSTOMER?.records?.length ?? 4;
    recordExtractionRun({
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      sourceId: 'MOCK-SAP-FIN-FSCM',
      sourceName: state.mockSap?.source?.sourceName || 'SAP S/4HANA FIN-FSCM-CR Seed Simulator',
      status: 'COMPLETED',
      recordCounts: { customers: customerCount },
      triggeredBy: 'MANUAL'
    });
    if (msgEl) {
      msgEl.textContent = `Simulator data reloaded (${customerCount} staging customers refreshed at ${new Date(finishedAt).toLocaleTimeString()}).`;
      msgEl.className = 'form-message success';
    }
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
    if (msgEl) {
      msgEl.textContent = '';
      msgEl.className = 'form-message';
    }
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
document.querySelector('#extract-mock-sap').addEventListener('click', async event => {
  const button = event.currentTarget;
  const progress = document.querySelector('#mock-sap-progress');
  const progressLabel = document.querySelector('#mock-sap-progress-label');
  const errorEl = document.querySelector('#mock-sap-error');
  const msgEl = document.querySelector('#mock-sap-action-message');
  button.disabled = true;
  if (errorEl) errorEl.textContent = '';
  if (msgEl) {
    msgEl.textContent = '';
    msgEl.className = 'form-message';
  }
  progress.hidden = false;
  progress.removeAttribute('value');
  progressLabel.hidden = false;
  progressLabel.textContent = 'Extraction request is running on the backend; record counts will appear when it returns.';
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  try {
    const extractResult = await api.extractMockSap();
    const finishedAt = extractResult?.completedAt || new Date().toISOString();
    const durationMs = Date.now() - startMs;
    recordExtractionRun({
      runId: extractResult?.id || `MOCK-SAP-EXTRACT:${finishedAt}`,
      startedAt: extractResult?.startedAt || startedAt,
      finishedAt,
      durationMs,
      sourceId: 'MOCK-SAP-FIN-FSCM',
      sourceName: extractResult?.sourceName || 'SAP S/4HANA FIN-FSCM-CR Seed Simulator',
      status: String(extractResult?.status || 'COMPLETED').toUpperCase(),
      recordCounts: extractResult?.rowCounts || null,
      triggeredBy: 'MANUAL'
    });
    updateConnectorSyncTimestamp(['MOCK-SAP-FIN-FSCM', 'HANA-CLOUD-SLT'], finishedAt);
    state.mockSapMonitoring = null;
    renderMockSapMonitoring(null);
    await Promise.all([loadMockSap(), loadPortfolio()]);
    const connectorsHost = document.querySelector('#connectors-workspace');
    if (connectorsHost) await renderDataSourcesPanel(connectorsHost).catch(() => {});
    const schedulerHost = document.querySelector('#scheduler-workspace');
    if (schedulerHost) await loadSchedulerStatus(schedulerHost).catch(() => {});
    if (msgEl) {
      msgEl.textContent = `Mock SAP staging extraction completed in ${durationMs} ms (active 13-customer portfolio totals preserved).`;
      msgEl.className = 'form-message success';
    }
  } catch (error) {
    recordExtractionRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      sourceId: 'MOCK-SAP-FIN-FSCM',
      sourceName: 'SAP S/4HANA FIN-FSCM-CR Seed Simulator',
      status: 'FAILED',
      error: error.message,
      triggeredBy: 'MANUAL'
    });
    if (errorEl) errorEl.textContent = error.message;
    showError(error.message);
    try { await loadMockSap(); }
    catch (refreshError) { showError(refreshError.message); }
  } finally {
    progress.hidden = true;
    progressLabel.hidden = true;
    button.disabled = false;
  }
});
document.querySelector('#run-mock-sap-monitoring').addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.querySelector('#mock-sap-monitoring-status');
  button.disabled = true;
  try {
    let run = state.mockSap?.latestRun?.snapshotPromoted === true
      ? await api.runMockSapMonitoring()
      : await api.runMonitoring();
    if (run.status === 'QUEUED' || run.status === 'RUNNING') {
      run = await api.waitForMonitoringRun(run.id, {
        onStatus: current => {
          status.textContent = `Backend monitoring run ${current.status.toLowerCase()}.`;
        }
      });
    }
    state.mockSapMonitoring = await api.getMonitoringRun(run.id);
    renderMockSapMonitoring(state.mockSapMonitoring);
    status.textContent = `Monitoring returned ${run.status} from the existing Credit Guard engine.`;
    await loadMonitoring();
    if (run.status === 'COMPLETED') await loadPortfolio();
  } catch (error) {
    status.textContent = `Monitoring could not be completed: ${error.message}`;
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#refresh-monitoring').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  document.querySelector('#monitoring-error').textContent = '';
  try {
    await runExtractionAndMonitoringCycle({ trigger: 'manual-refresh' });
  } catch (error) {
    document.querySelector('#monitoring-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#run-monitoring').addEventListener('click', async event => {
  const button = event.currentTarget;
  const error = document.querySelector('#monitoring-error');
  button.disabled = true;
  error.textContent = '';
  try {
    resetAutoRefreshCountdown();
    const run = await api.runMonitoring();
    let completed = run;
    if (run.status === 'QUEUED' || run.status === 'RUNNING') {
      completed = await api.waitForMonitoringRun(run.id, {
        onStatus: current => {
          document.querySelector('#monitoring-status').textContent =
            `Monitoring run ${current.status.toLowerCase()} · waiting for a terminal result.`;
        }
      });
    }
    await loadMonitoring({ triggerRun: false });
    if (completed.status === 'COMPLETED') await loadPortfolio();
    else error.textContent = `Monitoring ended with status ${completed.status}${completed.errorCategory ? ` (${completed.errorCategory})` : ''}.`;
    resetAutoRefreshCountdown();
  } catch (error) {
    document.querySelector('#monitoring-error').textContent = error.message;
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#monitoring-alerts').addEventListener('click', async event => {
  const button = event.target.closest('[data-alert-action]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.alertAction === 'acknowledge') {
      await api.acknowledgeMonitoringAlert(button.dataset.alertId);
    } else {
      await api.resolveMonitoringAlert(button.dataset.alertId);
    }
    await loadMonitoring();
  } catch (error) {
    showError(error.message);
    button.disabled = false;
  }
});
document.querySelector('#monitoring-history').addEventListener('click', async event => {
  const button = event.target.closest('[data-monitoring-recovery]');
  if (!button || !state.session?.permissions.canMonitor) return;
  button.disabled = true;
  const status = document.querySelector('#monitoring-status');
  const error = document.querySelector('#monitoring-error');
  error.textContent = '';
  try {
    const queued = await api.recoverMonitoringRun(button.dataset.monitoringRecovery);
    status.textContent = `Monitoring recovery ${queued.status.toLowerCase()} · waiting for a terminal result.`;
    const completed = ['QUEUED', 'RUNNING'].includes(queued.status)
      ? await api.waitForMonitoringRun(queued.id, {
        onStatus: run => {
          status.textContent = `Monitoring recovery ${run.status.toLowerCase()} · waiting for a terminal result.`;
        }
      })
      : queued;
    await loadMonitoring();
    status.textContent = `Monitoring recovery finished with status ${completed.status}.`;
  } catch (error) {
    document.querySelector('#monitoring-error').textContent = error.message;
    showError(error.message);
    button.disabled = false;
  }
});

function openAiCreditAssistanceWorkspace(promptText = '') {
  switchTab('chat');

  const firstShortcutBtn = document.querySelector('#section-shortcuts-bar [data-target="sec-chat-control"]');
  if (firstShortcutBtn) {
    document.querySelectorAll('.shortcut-tab-btn').forEach(b => b.classList.remove('active'));
    firstShortcutBtn.classList.add('active');
  }

  const chatInput = document.querySelector('#chat-input');
  if (chatInput) {
    chatInput.focus({ preventScroll: true });
    if (promptText) {
      chatInput.value = promptText;
      const chatForm = document.querySelector('#chat-form');
      if (chatForm) {
        chatForm.requestSubmit();
      }
    }
  }
}

document.querySelector('#home-open-ai-btn')?.addEventListener('click', () => {
  openAiCreditAssistanceWorkspace();
});

document.querySelector('#home-quick-ai-input')?.addEventListener('click', () => {
  const input = document.querySelector('#home-quick-ai-input');
  const promptText = input?.value?.trim() || '';
  if (input) input.value = '';
  openAiCreditAssistanceWorkspace(promptText);
});

document.querySelector('#home-quick-ai-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const input = document.querySelector('#home-quick-ai-input');
  const promptText = input?.value?.trim() || '';
  if (input) input.value = '';
  openAiCreditAssistanceWorkspace(promptText);
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  event.preventDefault();
  switchTab(button.dataset.tab);
});

document.querySelector('.analysis-exposure-groups').addEventListener('click', event =>
  handleExposureGroup(event, state.dashboard, group => { state.exposureGroup = group; }));

document.querySelector('#customer-list').addEventListener('click', async event => {
  try {
    const action = await handleCustomerClick(
      event,
      api.getCustomer,
      api.getCustomerPayments,
      loadCustomerApprovalHistory
    );
    if (action?.explainId) {
      const customer = state.customers.find(item => item.ID === action.explainId);
      if (customer) {
        state.selectedCustomer = customer;
        switchTab('chat');
        await explainCustomer(customer, api.sendChat, state.chatMessages, state.documentContext, state);
      }
    } else if (action?.customer) {
      state.selectedCustomer = action.customer;
    }
  } catch (error) { showError(error.message); }
});

document.querySelector('#request-form').addEventListener('submit', async event => {
  const request = await handleRequestSubmit(event, api.createLimitRequest);
  if (request) {
    try { await loadApprovals(); }
    catch (error) { showError(error.message); }
  }
});

document.querySelector('#approvals-list').addEventListener('click', async event => {
  try {
    const syncBtn = event.target.closest('.sync-sap-btn');
    if (syncBtn) {
      const requestId = syncBtn.dataset.syncRequestId || syncBtn.dataset.requestId;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing to SAP…';
      try {
        await api.syncV2LimitRequestToSap(requestId);
        await Promise.all([loadPortfolio(), loadApprovals()]);
      } catch (err) {
        showError(`SAP Sync failed: ${err.message}`);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '⚡ Sync to SAP S/4HANA (UKMBP_CMS_SGM)';
      }
      return;
    }
    const decided = await handleApprovalClick(event, api.decideLimitRequest);
    if (decided) {
      errorHost.hidden = true;
      await Promise.all([loadPortfolio(), loadApprovals()]);
    }
  } catch (error) { showError(error.message); }
});

document.querySelector('#scan-autonomous-portfolio-btn')?.addEventListener('click', async event => {
  const btn = event.currentTarget;
  const resultsEl = document.querySelector('#autonomous-decision-results');
  const msgEl = document.querySelector('#autonomous-decision-message');
  btn.disabled = true;
  if (msgEl) {
    msgEl.textContent = 'Scanning all Business Partners against FIN-FSCM-AUTONOMOUS-POLICY-V1…';
    msgEl.className = 'form-message';
  }
  try {
    const scan = await api.scanV2PortfolioAutonomousActions({ autoCreateAndExecute: false });
    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="kpi-grid" style="margin-bottom: 1rem;">
          <div class="kpi-card"><span class="kpi-label">BPs Scanned</span><span class="kpi-value">${scan.total_partners_scanned}</span><span class="kpi-subtext">${scan.flagged_partners_count} Flagged</span></div>
          <div class="kpi-card"><span class="kpi-label">Auto-Approvable</span><span class="kpi-value" style="color: #0b8043;">${scan.auto_approvable_count}</span><span class="kpi-subtext">Low-Risk Within Policy</span></div>
          <div class="kpi-card"><span class="kpi-label">Auto-Rejectable</span><span class="kpi-value" style="color: #c5221f;">${scan.auto_rejectable_count}</span><span class="kpi-subtext">Severe Risk Guardrail</span></div>
          <div class="kpi-card"><span class="kpi-label">Human Escalation</span><span class="kpi-value" style="color: #b06000;">${scan.human_escalation_count}</span><span class="kpi-subtext">Controller / Finance Head</span></div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Business Partner</th>
                <th>Current → Proposed Limit</th>
                <th>Utilisation</th>
                <th>Autonomous Decision</th>
                <th>Policy Rule</th>
                <th>Governance Authority</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              ${(scan.recommendations || []).map(r => `
                <tr>
                  <td><strong>${r.bp_name}</strong> (<code>${r.bp_id}</code>)</td>
                  <td>₹${Number(r.current_limit).toLocaleString('en-IN')} → <strong>₹${Number(r.proposed_limit).toLocaleString('en-IN')}</strong></td>
                  <td>${r.current_utilization_pct}% (${r.threshold_status})</td>
                  <td><span class="chip ${r.decision === 'AUTO_APPROVE' ? 'healthy' : r.decision === 'AUTO_REJECT' ? 'breach' : 'warning'}">${r.decision}</span></td>
                  <td><code>${r.matched_rule_id}</code></td>
                  <td>${r.required_human_authority}</td>
                  <td><small class="muted">${r.explanation}</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    if (msgEl) {
      msgEl.textContent = `Portfolio scan completed (${scan.policy_id}): ${scan.auto_approvable_count} auto-approvable, ${scan.auto_rejectable_count} auto-rejectable, ${scan.human_escalation_count} escalated to human authority.`;
      msgEl.className = 'form-message success';
    }
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = `Portfolio scan failed: ${err.message}`;
      msgEl.className = 'form-message error';
    }
  } finally {
    btn.disabled = false;
  }
});

document.querySelector('#run-autonomous-pending-btn')?.addEventListener('click', async event => {
  const btn = event.currentTarget;
  const msgEl = document.querySelector('#autonomous-decision-message');
  btn.disabled = true;
  if (msgEl) {
    msgEl.textContent = 'Executing autonomous policy sweep across pending and draft limit requests…';
    msgEl.className = 'form-message';
  }
  try {
    const res = await api.processV2PendingAutonomousRequests({ autoSyncToSap: true });
    if (msgEl) {
      msgEl.textContent = `Autonomous Sweep Complete (${res.policy_id}): Evaluated ${res.evaluated_count} requests · Auto-Approved & Synced: ${res.auto_approved_count} · Auto-Rejected: ${res.auto_rejected_count} · Escalated to Human: ${res.escalated_to_human_count}.`;
      msgEl.className = 'form-message success';
    }
    await Promise.all([loadPortfolio(), loadApprovals()]);
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = `Autonomous sweep failed: ${err.message}`;
      msgEl.className = 'form-message error';
    }
  } finally {
    btn.disabled = false;
  }
});

document.querySelector('#chat-form').addEventListener('submit', event =>
  handleChatSubmit(event, api.sendChat, state.chatMessages, state.documentContext, state));
document.querySelector('#analyze-portfolio').addEventListener('click', async () => {
  try { await loadMonitoring(); } catch {}
  const input = document.querySelector('#chat-input');
  input.value = 'Analyze the latest monitoring run, explain each high-risk customer, and summarize portfolio exposure and overdue invoices.';
  document.querySelector('#chat-form').requestSubmit();
});
document.querySelector('#agent-activity').addEventListener('click', async event => {
  const button = event.target.closest('[data-submit-proposal]');
  if (!button || !state.session?.permissions.canRequest) return;
  const proposal = state.preparedActions?.[Number(button.dataset.proposalIndex)];
  if (!proposal) return;
  button.disabled = true;
  try {
    const request = await api.submitPreparedProposal(
      proposal,
      `proposal:${state.agentExecution?.ID || 'current'}:${button.dataset.proposalIndex}`
    );
    button.textContent = `Submitted for ${request.approverLevel} approval`;
    const notice = document.createElement('p');
    notice.className = 'form-message';
    notice.textContent = 'A human approver must still decide this request.';
    button.after(notice);
    await loadApprovals();
  } catch (error) {
    button.disabled = false;
    showError(error.message);
  }
});

async function loadAgentHistory() {
  const result = await api.getAgentHistory();
  const host = document.querySelector('#agent-history-list');
  const conversationsHost = document.querySelector('#agent-conversations-list');
  host.replaceChildren();
  conversationsHost.replaceChildren();
  for (const conversation of result.conversations) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'text-button';
    button.type = 'button';
    button.dataset.conversationId = conversation.ID;
    button.textContent = `${new Date(conversation.updatedAt).toLocaleString()} · ${conversation.preview || 'Conversation'}`;
    row.append(button);
    conversationsHost.append(row);
  }
  for (const execution of result.executions) {
    const row = document.createElement('li');
    row.dataset.executionId = execution.ID;
    const summary = document.createElement('span');
    summary.textContent = `${new Date(execution.startedAt).toLocaleString()} · ${execution.status} · ${execution.planStatus || 'No plan'} · Recovery ${execution.recoveryStatus || 'NOT_AVAILABLE'} · ${execution.stepCount} step(s)`;
    row.append(summary);
    for (const task of execution.taskResults || []) {
      const taskSummary = document.createElement('p');
      taskSummary.textContent = `${task.status}: ${task.summary}`;
      row.append(taskSummary);
    }
    if (canAttemptExecutionRecovery(execution)) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.type = 'button';
      button.dataset.recoverExecution = execution.ID;
      button.textContent = execution.recoveryStatus === 'AVAILABLE'
        ? 'Recover read-only work' : 'Check stale execution';
      row.append(button);
    } else if (execution.recoveryStatus === 'MANUAL_REVIEW') {
      const manualReview = document.createElement('p');
      manualReview.textContent = 'Recovery requires manual review; no task was repeated.';
      row.append(manualReview);
    } else if (['ACTIVE', 'RECOVERING'].includes(execution.recoveryStatus)
      && execution.plan?.tasks?.some(task => task.status === 'RUNNING')
      && Date.now() - Date.parse(execution.updatedAt || execution.startedAt) > 60000) {
      const manualReview = document.createElement('p');
      manualReview.textContent = 'An earlier task has an uncertain outcome; automatic recovery is blocked. Verify its result manually.';
      row.append(manualReview);
    }
    host.append(row);
  }
  document.querySelector('#agent-memory-status').textContent = result.memoryEnabled
    ? 'Private conversation memory is enabled for this development profile.'
    : 'Conversation memory is disabled; execution summaries are retained.';
}
document.querySelector('#refresh-agent-history').addEventListener('click', () =>
  loadAgentHistory().catch(error => showError(error.message)));
document.querySelector('#agent-history-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-recover-execution]');
  if (!button) return;
  button.disabled = true;
  try {
    await api.getAgentExecution(button.dataset.recoverExecution);
    await api.recoverAgentExecution(button.dataset.recoverExecution);
    const execution = await api.getAgentExecution(button.dataset.recoverExecution);
    const summary = button.parentElement.querySelector('span');
    summary.textContent = `${new Date(execution.startedAt).toLocaleString()} · ${execution.status} · ${execution.planStatus || 'No plan'} · Recovery ${execution.recoveryStatus || 'NOT_AVAILABLE'} · ${execution.stepCount} step(s)`;
    const outcome = document.createElement('p');
    outcome.setAttribute('role', 'status');
    outcome.textContent = execution.recoveryStatus === 'MANUAL_REVIEW'
      ? 'Recovery requires manual review; no uncertain task was repeated.'
      : `Recovery finished: ${execution.status} · ${execution.planStatus || 'No plan'} · ${execution.recoveryStatus || 'NOT_AVAILABLE'}.`;
    button.after(outcome);
    if (execution.recoveryStatus !== 'AVAILABLE') button.remove();
    await loadAgentHistory();
  } catch (error) {
    showError(error.message);
    try {
      const execution = await api.getAgentExecution(button.dataset.recoverExecution);
      const summary = button.parentElement.querySelector('span');
      summary.textContent = `${new Date(execution.startedAt).toLocaleString()} · ${execution.status} · ${execution.planStatus || 'No plan'} · Recovery ${execution.recoveryStatus || 'NOT_AVAILABLE'} · ${execution.stepCount} step(s)`;
      if (execution.recoveryStatus !== 'AVAILABLE') {
        const outcome = document.createElement('p');
        outcome.setAttribute('role', 'status');
        outcome.textContent = execution.recoveryStatus === 'MANUAL_REVIEW'
          ? 'Recovery requires manual review; no uncertain task was repeated.'
          : `Recovery is ${execution.recoveryStatus || 'unavailable'}; no further action was taken.`;
        button.after(outcome);
        button.remove();
      } else {
        button.disabled = false;
      }
      await loadAgentHistory();
    } catch (refreshError) {
      showError(refreshError.message);
      button.disabled = false;
    }
  }
});
document.querySelector('#agent-conversations-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-conversation-id]');
  if (!button) return;
  try {
    const conversation = await api.getAgentConversation(button.dataset.conversationId);
    state.conversationId = conversation.ID;
    state.chatMessages = conversation.messages.map(message => ({ role: message.role, text: message.content }));
    renderChat(state.chatMessages, null, state.session?.permissions);
  } catch (error) { showError(error.message); }
});
document.querySelector('#clear-agent-history').addEventListener('click', async () => {
  try {
    await api.clearAgentConversation();
    state.conversationId = null;
    state.chatMessages = [];
    renderChat(state.chatMessages, null, state.session?.permissions);
    await loadAgentHistory();
  } catch (error) { showError(error.message); }
});

document.querySelector('#jump-connectors-btn')?.addEventListener('click', () => {
  switchTab('simulator');
});

updatePageHeading(state.currentTab);
renderSectionShortcuts(state.currentTab);
renderChat(state.chatMessages, null, state.session?.permissions);
startAppLevelScheduler();
loadSession()
  .then(() => Promise.all([
    runExtractionAndMonitoringCycle({ trigger: 'initial-load' }),
    loadAgentHistory()
  ]))
  .catch(error => showError(error.message));
