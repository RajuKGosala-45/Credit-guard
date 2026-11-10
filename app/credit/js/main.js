import * as api from './api.js';
import { state } from './state.js';
import { renderKpis, renderExposure, handleExposureGroup } from './views/dashboard.js';
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
    'Credit overview',
    'Review a controlled portfolio across five legal entities. Data freshness is not supplied by this local demo.'
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
  chat: [
    { id: 'sec-chat-control', label: 'AI Credit Control' },
    { id: 'sec-audit-memory', label: 'Audit & Memory' },
    { id: 'sec-enterprise-integration', label: 'Enterprise Integration' }
  ],
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
  home: []
};

function renderSectionShortcuts(tab) {
  const bar = document.querySelector('#section-shortcuts-bar');
  if (!bar) return;
  const sections = tabSections[tab] || [];
  if (sections.length === 0 || tab === 'home') {
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

document.querySelector('#section-shortcuts-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-target]');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const el = document.getElementById(targetId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.shortcut-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
});

function switchTab(tabName) {
  if (!tabName) return;
  state.currentTab = tabName;
  const isHome = tabName === 'home';

  const homeContainer = document.querySelector('#home-view-container');
  const appContainer = document.querySelector('#app-workspace-container');

  if (homeContainer) homeContainer.style.display = isHome ? 'block' : 'none';
  if (appContainer) appContainer.style.display = isHome ? 'none' : 'grid';

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
    panel.classList.toggle('active', panel.id === `${state.currentTab}-panel`);
  });

  if (state.currentTab === 'dashboard') {
    Promise.all([loadMonitoring(), loadPortfolio()]).catch(error => showError(error.message));
  }
  if (state.currentTab === 'analysis') {
    loadPortfolio().catch(error => showError(error.message));
  }
  if (state.currentTab === 'approvals') {
    loadApprovals().catch(error => showError(error.message));
  }
  if (state.currentTab === 'simulator') {
    loadMockSap().catch(error => {
      document.querySelector('#mock-sap-error').textContent = error.message;
      showError(error.message);
    });
  }
  if (state.currentTab === 'chat') {
    Promise.all([loadPortfolio(), loadAgentHistory()]).catch(error => showError(error.message));
  }
}

function canAttemptExecutionRecovery(execution) {
  if (execution.recoveryStatus === 'AVAILABLE') return true;
  if (!['ACTIVE', 'RECOVERING'].includes(execution.recoveryStatus)) return false;
  if (execution.plan?.tasks?.some(task => task.status === 'RUNNING')) return false;
  const updatedAt = Date.parse(execution.updatedAt || execution.startedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > 60000;
}

function refreshPortfolio() {
  renderKpis(state.dashboard.kpis);
  renderExposure(state.dashboard, state.exposureGroup);
  renderExposure(state.dashboard, 'customer', '#customer-exposure-list');
  renderCustomers(state.customers);
  renderRequestCustomers(state.customers);
  const lastUpdatedEl = document.querySelector('#last-updated');
  if (lastUpdatedEl) {
    const runTime = state.mockSap?.latestRun?.completedAt || state.mockSap?.latestRun?.startedAt;
    if (runTime) {
      const d = new Date(runTime);
      lastUpdatedEl.textContent = Number.isNaN(d.getTime()) ? runTime : d.toLocaleTimeString();
    } else {
      lastUpdatedEl.textContent = 'UNKNOWN';
    }
  }
}

async function loadPortfolio() {
  [state.dashboard, state.customers, state.mockSap] = await Promise.all([
    api.getDashboard(),
    api.getCustomers(),
    api.getMockSap().catch(() => null)
  ]);
  refreshPortfolio();
}

async function loadSession() {
  state.session = await api.getSession();
  renderLimitRequestAvailability(state.session);
  renderChat(state.chatMessages, state.agentExecution, state.session.permissions);
  await loadApprovals();
}

async function loadApprovals() {
  const requests = await api.getLimitRequests();
  state.requests = await Promise.all(requests.map(async request => ({
    ...request,
    auditHistory: request.status === 'Pending' ? [] : await api.getApprovalHistory(request.ID)
  })));
  renderApprovals(state.requests, state.session);
}

async function loadCustomerApprovalHistory(customerId) {
  const requests = await api.getLimitRequests();
  const decided = requests.filter(request =>
    request.customer_ID === customerId && request.status !== 'Pending');
  const histories = await Promise.all(decided.map(request => api.getApprovalHistory(request.ID)));
  return histories.flat();
}

let initialMonitoringBootstrapped = false;

async function loadMonitoring() {
  let [summary, runs, alerts] = await Promise.all([
    api.getMonitoringSummary(),
    api.getMonitoringRuns(),
    api.getMonitoringAlerts()
  ]);
  if (!summary.latestRun && summary.canOperate && !initialMonitoringBootstrapped) {
    initialMonitoringBootstrapped = true;
    try {
      const started = await api.runMonitoring();
      if (started.status === 'QUEUED' || started.status === 'RUNNING') {
        await api.waitForMonitoringRun(started.id);
      }
      [summary, runs, alerts] = await Promise.all([
        api.getMonitoringSummary(),
        api.getMonitoringRuns(),
        api.getMonitoringAlerts()
      ]);
    } catch {
      // Keep default monitoring summary if initial background run cannot complete
    }
  }
  renderMonitoring({
    summary,
    runs,
    alerts,
    findings: summary.latestRun?.findings || []
  });
}

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
  renderMockSap(state.mockSap, state.session?.permissions);
  if (!state.mockSapMonitoring) {
    document.querySelector('#mock-sap-monitoring-status').textContent =
      state.mockSap.latestRun?.snapshotPromoted
        ? 'Imported records are ready for an explicit monitoring run.'
        : 'Extract source data before running monitoring.';
  }
}

document.querySelector('.simulator-subtabs')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-sim-subtab]');
  if (!btn) return;
  const subtab = btn.dataset.simSubtab;
  document.querySelectorAll('.simulator-subtabs button').forEach(b => {
    b.classList.toggle('selected', b === btn);
  });
  document.querySelectorAll('.sim-subtab-pane').forEach(pane => {
    pane.style.display = pane.id === `sim-subtab-${subtab}` ? 'block' : 'none';
  });
  if (subtab === 'scheduler') {
    const schedulerHost = document.querySelector('#scheduler-workspace');
    if (schedulerHost && !schedulerHost.hasChildNodes()) {
      renderSchedulerPanel(schedulerHost).catch(() => {});
    } else {
      loadSchedulerStatus();
    }
  }
});

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

document.querySelector('#refresh-mock-sap').addEventListener('click', () =>
  loadMockSap().catch(error => {
    document.querySelector('#mock-sap-error').textContent = error.message;
    showError(error.message);
  }));
document.querySelector('#extract-mock-sap').addEventListener('click', async event => {
  const button = event.currentTarget;
  const progress = document.querySelector('#mock-sap-progress');
  const progressLabel = document.querySelector('#mock-sap-progress-label');
  const errorHost = document.querySelector('#mock-sap-error');
  button.disabled = true;
  errorHost.textContent = '';
  progress.hidden = false;
  progress.removeAttribute('value');
  progressLabel.hidden = false;
  progressLabel.textContent = 'Extraction request is running on the backend; record counts will appear when it returns.';
  try {
    await api.extractMockSap();
    state.mockSapMonitoring = null;
    renderMockSapMonitoring(null);
    await Promise.all([loadMockSap(), loadPortfolio()]);
  } catch (error) {
    errorHost.textContent = error.message;
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
    let run = await api.runMockSapMonitoring();
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

document.querySelector('#refresh-monitoring').addEventListener('click', () =>
  loadMonitoring().catch(error => showError(error.message)));
document.querySelector('#run-monitoring').addEventListener('click', async event => {
  const button = event.currentTarget;
  const error = document.querySelector('#monitoring-error');
  button.disabled = true;
  error.textContent = '';
  try {
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
    await loadMonitoring();
    if (completed.status === 'COMPLETED') await loadPortfolio();
    else error.textContent = `Monitoring ended with status ${completed.status}${completed.errorCategory ? ` (${completed.errorCategory})` : ''}.`;
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

document.querySelector('#home-open-ai-btn')?.addEventListener('click', () => {
  switchTab('chat');
});

document.querySelector('#home-quick-ai-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const input = document.querySelector('#home-quick-ai-input');
  const promptText = input?.value?.trim();
  if (!promptText) return;

  // 1. Switch to AI Credit Assistance main tab
  switchTab('chat');

  // 2. Activate AI Credit Control sub-tab shortcut
  const firstShortcutBtn = document.querySelector('#section-shortcuts-bar [data-target="sec-chat-control"]');
  if (firstShortcutBtn) {
    document.querySelectorAll('.shortcut-tab-btn').forEach(b => b.classList.remove('active'));
    firstShortcutBtn.classList.add('active');
  }

  // 3. Scroll directly to AI Credit Control section
  const controlSection = document.getElementById('sec-chat-control');
  if (controlSection) {
    controlSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 4. Transfer query into chat input and submit
  const chatInput = document.querySelector('#chat-input');
  if (chatInput) {
    chatInput.value = promptText;
    const chatForm = document.querySelector('#chat-form');
    if (chatForm) {
      chatForm.requestSubmit();
    }
  }

  input.value = '';
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
loadSession()
  .then(() => Promise.all([loadPortfolio(), loadMonitoring(), loadAgentHistory()]))
  .catch(error => showError(error.message));
