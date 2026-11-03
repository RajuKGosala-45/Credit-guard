import { escapeHTML } from '../utils.js';

export function renderChat(messages, execution = null) {
  const host = document.querySelector('#chat-messages');
  if (!messages.length) {
    host.innerHTML = '<p class="empty-state">Ask about exposure, flagged customers, or a customer ID such as C001. Without an API key, the assistant uses the same live data tools in offline demo mode.</p>';
    return;
  }
  host.innerHTML = messages.map(message =>
    `<div class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}">${escapeHTML(message.text)}</div>`
  ).join('');
  host.scrollTop = host.scrollHeight;
  renderExecution(execution);
}

function renderExecution(execution) {
  const host = document.querySelector('#agent-activity');
  if (!host) return;
  if (!execution) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  const steps = (execution.steps || []).map(step =>
    `<li><strong>${escapeHTML(step.tool)}</strong> · ${escapeHTML(step.status)} — ${escapeHTML(step.summary)}</li>`
  ).join('');
  const proposals = (execution.preparedActions || []).map(proposal => `<article class="approval-item">
    <strong>Approval required: ${escapeHTML(proposal.customerName)} · ${escapeHTML(proposal.customerId)}</strong>
    <p>${escapeHTML(proposal.reason)}</p>
    <p>${escapeHTML(String(proposal.currentLimit))} → ${escapeHTML(String(proposal.requestedLimit))} · Routed to ${escapeHTML(proposal.approverLevel)}</p>
    <button class="button primary" type="button" data-submit-proposal="true" data-proposal-index="${(execution.preparedActions || []).indexOf(proposal)}">Submit request for human approval</button>
  </article>`).join('');
  host.innerHTML = `<p class="muted">Execution ${escapeHTML(execution.status)} · ${steps ? 'Tool activity:' : 'No tools used.'}</p>${steps ? `<ol>${steps}</ol>` : ''}${proposals}`;
}

export async function handleChatSubmit(event, send, messages, documentContext, state) {
  event.preventDefault();
  const input = document.querySelector('#chat-input');
  const errorHost = document.querySelector('#chat-error');
  const message = input.value.trim();
  if (!message) return null;
  input.value = '';
  errorHost.textContent = '';
  messages.push({ role: 'user', text: message });
  renderChat(messages);
  try {
    const result = await send(message, documentContext, state.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    messages.push({ role: 'assistant', text: result.reply });
    renderChat(messages, result.execution);
    if (result.preparedActions?.length) {
      state.preparedActions = result.preparedActions;
    }
    return result;
  } catch (error) {
    errorHost.textContent = error.message;
    return null;
  }
}

export async function explainCustomer(customer, send, messages, documentContext, state) {
  const question = `Explain and recommend whether to increase the limit for ${customer.name} (${customer.ID}).`;
  messages.push({ role: 'user', text: question });
  renderChat(messages);
  try {
    const result = await send(question, documentContext, state.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    messages.push({ role: 'assistant', text: result.reply });
    renderChat(messages, result.execution);
  } catch (error) {
    document.querySelector('#chat-error').textContent = error.message;
  }
}
