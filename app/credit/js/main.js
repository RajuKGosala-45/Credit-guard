import * as api from './api.js';
import { state } from './state.js';
import { renderKpis, renderExposure, handleExposureGroup } from './views/dashboard.js';
import { renderMonitoring } from './views/monitoring.js';
import { renderCustomers, handleCustomerClick } from './views/customers.js';
import { renderRequestCustomers, handleRequestSubmit } from './views/limitRequest.js';
import { renderApprovals, handleApprovalClick } from './views/approvals.js';
import { renderChat, handleChatSubmit, explainCustomer } from './views/chat.js';
import { handleDocumentSubmit, clearDocument } from './views/document.js';

const errorHost = document.querySelector('#global-error');
function showError(message) {
  errorHost.hidden = false;
  errorHost.textContent = `${message} If the issue continues, restart the server and reload.`;
}

function refreshPortfolio() {
  renderKpis(state.dashboard.kpis);
  renderExposure(state.dashboard, state.exposureGroup);
  renderCustomers(state.customers);
  renderRequestCustomers(state.customers);
  document.querySelector('#last-updated').textContent = new Intl.DateTimeFormat('en-IN', { timeStyle: 'short' }).format(new Date());
}

async function loadPortfolio() {
  [state.dashboard, state.customers] = await Promise.all([api.getDashboard(), api.getCustomers()]);
  refreshPortfolio();
}

async function loadApprovals() {
  state.requests = await api.getLimitRequests();
  renderApprovals(state.requests);
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

document.querySelector('#refresh-monitoring').addEventListener('click', () =>
  loadMonitoring().catch(error => showError(error.message)));
document.querySelector('#run-monitoring').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api.runMonitoring();
    await loadMonitoring();
  } catch (error) {
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

document.querySelector('.tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  state.currentTab = button.dataset.tab;
  document.querySelectorAll('.tabs [data-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${state.currentTab}-panel`));
  if (state.currentTab === 'approvals') loadApprovals().catch(error => showError(error.message));
});

document.querySelector('.segmented').addEventListener('click', event =>
  handleExposureGroup(event, state.dashboard, group => { state.exposureGroup = group; }));

document.querySelector('#customer-list').addEventListener('click', async event => {
  try {
    const action = await handleCustomerClick(event, api.getCustomer);
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
document.querySelector('#agent-activity').addEventListener('click', async event => {
  const button = event.target.closest('[data-submit-proposal]');
  if (!button) return;
  const proposal = state.preparedActions?.[Number(button.dataset.proposalIndex)];
  if (!proposal) return;
  button.disabled = true;
  try {
    const request = await api.submitPreparedProposal(proposal);
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
    row.textContent = `${new Date(execution.startedAt).toLocaleString()} · ${execution.status} · ${execution.stepCount} step(s)`;
    host.append(row);
  }
  document.querySelector('#agent-memory-status').textContent = result.memoryEnabled
    ? 'Private conversation memory is enabled for this development profile.'
    : 'Conversation memory is disabled; execution summaries are retained.';
}
document.querySelector('#refresh-agent-history').addEventListener('click', () =>
  loadAgentHistory().catch(error => showError(error.message)));
document.querySelector('#agent-conversations-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-conversation-id]');
  if (!button) return;
  try {
    const conversation = await api.getAgentConversation(button.dataset.conversationId);
    state.conversationId = conversation.ID;
    state.chatMessages = conversation.messages.map(message => ({ role: message.role, text: message.content }));
    renderChat(state.chatMessages);
  } catch (error) { showError(error.message); }
});
document.querySelector('#clear-agent-history').addEventListener('click', async () => {
  try {
    await api.clearAgentConversation();
    state.conversationId = null;
    state.chatMessages = [];
    renderChat(state.chatMessages);
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

renderChat(state.chatMessages);
loadPortfolio().catch(error => showError(error.message));
loadMonitoring().catch(error => showError(error.message));
