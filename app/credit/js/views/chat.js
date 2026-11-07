import { escapeHTML } from '../utils.js';

export function renderChat(messages, execution = null, permissions = null) {
  const host = document.querySelector('#chat-messages');
  if (!messages.length) {
    host.innerHTML = '<p class="empty-state">Ask about exposure, flagged customers, or a customer ID such as C001. Without an API key, the assistant uses the same live data tools in offline demo mode.</p>';
    return;
  }
  host.innerHTML = messages.map(message => {
    const providerLabel = message.provider === 'offline' ? 'Offline fallback'
      : message.provider === 'gemini' ? 'Gemini'
        : message.provider === 'anthropic' ? 'Anthropic' : 'Configured provider';
    const provenance = message.role === 'assistant' && message.provider
      ? `<small class="chat-provenance"><span class="chip ${message.provider === 'offline' ? 'review' : 'healthy'}">${escapeHTML(providerLabel)}</span>
        ${message.modulesUsed?.length ? `<span>Modules: ${escapeHTML(message.modulesUsed.join(', '))}</span>` : ''}
        ${message.dataSourcesUsed?.length ? `<span>Sources: ${escapeHTML(message.dataSourcesUsed.map(source => source.name).join(', '))}</span>` : ''}
        ${message.providerFallbackReason ? `<span>Fallback reason: ${escapeHTML(message.providerFallbackReason.replaceAll('_', ' '))}</span>` : ''}</small>`
      : '';
    const text = message.provider
      ? message.text.replace(/\n\nResponse provider: [^\n]*$/, '')
      : message.text;
    return `<div class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}">${provenance}${escapeHTML(text)}</div>`;
  }).join('');
  host.scrollTop = host.scrollHeight;
  renderExecution(execution, permissions);
}

function renderExecution(execution, permissions) {
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
    ${permissions?.canRequest ? `<button class="button primary" type="button" data-submit-proposal="true" data-proposal-index="${(execution.preparedActions || []).indexOf(proposal)}">Submit request for human approval</button>` : ''}
  </article>`).join('');
  const preview = execution.workflowPreview;
  const workflow = preview ? `<section class="workflow-preview">
    <h3>${escapeHTML(preview.name)} · Preview only</h3>
    <p class="muted">${escapeHTML(preview.source)} No workflow steps have been executed.</p>
    <ol>${preview.steps.map(step => `<li>
      <strong>${escapeHTML(step.module)} · ${escapeHTML(step.operation)}</strong>
      <p class="workflow-step-details">Depends on: ${escapeHTML(step.dependsOn.length ? step.dependsOn.join(', ') : 'None')} · Required roles: ${escapeHTML(step.requiredRoles.join(', '))} · Confirmation: ${escapeHTML(step.confirmation)}</p>
      <p class="workflow-step-details">Expected result: ${escapeHTML(step.expectedResult)}</p>
    </li>`).join('')}</ol>
    <ul class="workflow-limitations">${preview.limitations.map(limitation => `<li>${escapeHTML(limitation)}</li>`).join('')}</ul>
  </section>` : '';
  host.innerHTML = `<p class="muted">Execution ${escapeHTML(execution.status)} · ${steps ? 'Tool activity:' : 'No tools used.'}</p>${steps ? `<ol>${steps}</ol>` : ''}${workflow}${proposals}`;
}

export async function handleChatSubmit(event, send, messages, documentContext, state) {
  event.preventDefault();
  const input = document.querySelector('#chat-input');
  const errorHost = document.querySelector('#chat-error');
  const message = input.value.trim();
  if (!message) return null;
  input.value = '';
  errorHost.textContent = '';
  const status = document.querySelector('#chat-status');
  const submitButton = document.querySelector('#chat-form button[type="submit"]');
  if (status) status.textContent = 'Retrieving authorized application data and preparing an answer…';
  if (submitButton) submitButton.disabled = true;
  messages.push({ role: 'user', text: message });
  renderChat(messages);
  try {
    const result = await send(message, documentContext, state.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    state.agentExecution = result.execution
      ? { ...result.execution, ...(result.workflowPreview ? { workflowPreview: result.workflowPreview } : {}) }
      : null;
    messages.push({
      role: 'assistant',
      text: result.reply,
      provider: result.provider,
      modulesUsed: result.modulesUsed,
      dataSourcesUsed: result.dataSourcesUsed,
      providerFallbackReason: result.providerFallback ? result.providerFallbackReason : null
    });
    renderChat(messages, state.agentExecution, state.session?.permissions);
    if (result.preparedActions?.length) {
      state.preparedActions = result.preparedActions;
    }
    return result;
  } catch (error) {
    errorHost.textContent = error.message;
    return null;
  } finally {
    if (status) status.textContent = '';
    if (submitButton) submitButton.disabled = false;
  }
}

export async function explainCustomer(customer, send, messages, documentContext, state) {
  const question = `Explain and recommend whether to increase the limit for ${customer.name} (${customer.ID}).`;
  const status = document.querySelector('#chat-status');
  if (status) status.textContent = 'Retrieving authorized customer, payment, and monitoring data…';
  messages.push({ role: 'user', text: question });
  renderChat(messages, null, state.session?.permissions);
  try {
    const result = await send(question, documentContext, state.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    state.agentExecution = result.execution || null;
    messages.push({
      role: 'assistant',
      text: result.reply,
      provider: result.provider,
      modulesUsed: result.modulesUsed,
      dataSourcesUsed: result.dataSourcesUsed,
      providerFallbackReason: result.providerFallback ? result.providerFallbackReason : null
    });
    renderChat(messages, state.agentExecution, state.session?.permissions);
  } catch (error) {
    document.querySelector('#chat-error').textContent = error.message;
  } finally {
    if (status) status.textContent = '';
  }
}
