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
import { handleDocumentSubmit, clearDocument } from './views/document.js';
import { renderMockSap, renderMockSapMonitoring } from './views/mockSap.js';

const errorHost = document.querySelector('#global-error');
const pageCopy = Object.freeze({
  dashboard: ['Credit overview', 'Review the monitored portfolio, customer exposure, and credit-control requests.'],
  analysis: ['Portfolio analysis', 'Explore exposure by country, company code, and customer.'],
  approvals: ['Limit approvals', 'Review requests and record authorized human decisions.'],
  simulator: ['SAP simulator', 'Inspect synthetic Mock SAP source data and persisted extraction outcomes.'],
  chat: ['AI Credit Assistant', 'Ask cross-module questions using authorized Credit Guard data tools.']
});

function updatePageHeading(tab) {
  const [title, subtitle] = pageCopy[tab] || pageCopy.dashboard;
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#page-subtitle').textContent = subtitle;
}

function showError(message) {
  errorHost.hidden = false;
  errorHost.textContent = `${message} If the issue continues, restart the server and reload.`;
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
  document.querySelector('#last-updated').textContent = 'UNKNOWN';
}

async function loadPortfolio() {
  [state.dashboard, state.customers] = await Promise.all([api.getDashboard(), api.getCustomers()]);
  refreshPortfolio();
}

async function loadSession() {
  state.session = await api.getSession();
  renderLimitRequestAvailability(state.session);
  renderChat(state.chatMessages, state.agentExecution, state.session.permissions);
  if (state.currentTab === 'approvals') await loadApprovals();
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

async function loadMonitoring() {
  const [summary, runs, alerts] = await Promise.all([
    api.getMonitoringSummary(),
    api.getMonitoringRuns(),
    api.getMonitoringAlerts()
  ]);
  renderMonitoring({
    summary,
    runs,
    alerts,
    findings: summary.latestRun?.findings || []
  });
}

async function loadMockSap() {
  state.mockSap = await api.getMockSap();
  renderMockSap(state.mockSap, state.session?.permissions);
  if (!state.mockSapMonitoring) {
    document.querySelector('#mock-sap-monitoring-status').textContent =
      state.mockSap.latestRun?.snapshotPromoted
        ? 'Imported records are ready for an explicit monitoring run.'
        : 'Extract source data before running monitoring.';
  }
}

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

document.querySelector('.tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  state.currentTab = button.dataset.tab;
  updatePageHeading(state.currentTab);
  document.querySelectorAll('.tabs [data-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${state.currentTab}-panel`));
  if (state.currentTab === 'approvals') loadApprovals().catch(error => showError(error.message));
  if (state.currentTab === 'simulator') loadMockSap().catch(error => {
    document.querySelector('#mock-sap-error').textContent = error.message;
    showError(error.message);
  });
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
        state.currentTab = 'chat';
        document.querySelector('.tabs [data-tab="chat"]').click();
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
    const decided = await handleApprovalClick(event, api.decideLimitRequest);
    if (decided) {
      errorHost.hidden = true;
      await Promise.all([loadPortfolio(), loadApprovals()]);
    }
  } catch (error) { showError(error.message); }
});

document.querySelector('#chat-form').addEventListener('submit', event =>
  handleChatSubmit(event, api.sendChat, state.chatMessages, state.documentContext, state));
document.querySelector('#analyze-portfolio').addEventListener('click', () => {
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
document.querySelector('.tabs').addEventListener('click', event => {
  if (event.target.closest('[data-tab="chat"]')) loadAgentHistory().catch(error => showError(error.message));
});

document.querySelector('#document-form').addEventListener('submit', event =>
  handleDocumentSubmit(event, api.analyzeDocument, state.chatMessages, context => {
    state.documentContext = context;
  }));
document.querySelector('#clear-document').addEventListener('click', () =>
  clearDocument(() => { state.documentContext = null; }));

renderChat(state.chatMessages, null, state.session?.permissions);
loadSession()
  .then(() => Promise.all([loadPortfolio(), loadMonitoring()]))
  .catch(error => showError(error.message));
