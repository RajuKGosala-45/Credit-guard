import * as api from './api.js';
import { state } from './state.js';
import { renderKpis, renderExposure, handleExposureGroup } from './views/dashboard.js';
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
        await explainCustomer(customer, api.sendChat, state.chatMessages, state.documentContext);
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

document.querySelector('#approver-role').addEventListener('change', event => { state.approverRole = event.target.value; });
document.querySelector('#approvals-list').addEventListener('click', async event => {
  try {
    const decided = await handleApprovalClick(event, api.decideLimitRequest, state.approverRole);
    if (decided) {
      errorHost.hidden = true;
      await Promise.all([loadPortfolio(), loadApprovals()]);
    }
  } catch (error) { showError(error.message); }
});

document.querySelector('#chat-form').addEventListener('submit', event =>
  handleChatSubmit(event, api.sendChat, state.chatMessages, state.documentContext));

document.querySelector('#document-form').addEventListener('submit', event =>
  handleDocumentSubmit(event, api.analyzeDocument, state.chatMessages, context => {
    state.documentContext = context;
  }));
document.querySelector('#clear-document').addEventListener('click', () =>
  clearDocument(() => { state.documentContext = null; }));

renderChat(state.chatMessages);
loadPortfolio().catch(error => showError(error.message));
