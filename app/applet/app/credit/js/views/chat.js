import { escapeHTML } from '../utils.js';

function renderStructuredContent(sc) {
  if (!sc) return '';
  let html = '';

  // 1. KPI Summary Cards
  if (sc.kpis) {
    const k = sc.kpis;
    html += `
      <div class="kpi-grid" style="grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.75rem; margin-bottom: 1rem;">
        <div class="kpi-card" style="padding: 0.75rem; background: var(--color-canvas);">
          <span class="kpi-label" style="font-size: 0.75rem;">Total Customers</span>
          <p class="kpi-value" style="font-size: 1.15rem; margin: 0;">${escapeHTML(String(k.totalCustomers))}</p>
        </div>
        <div class="kpi-card" style="padding: 0.75rem; background: var(--color-canvas);">
          <span class="kpi-label" style="font-size: 0.75rem;">Total Credit Limit</span>
          <p class="kpi-value" style="font-size: 1.15rem; margin: 0;">${escapeHTML(String(k.totalCreditLimit))}</p>
        </div>
        <div class="kpi-card" style="padding: 0.75rem; background: var(--color-canvas);">
          <span class="kpi-label" style="font-size: 0.75rem;">Total Exposure</span>
          <p class="kpi-value" style="font-size: 1.15rem; margin: 0;">${escapeHTML(String(k.totalExposure))}</p>
        </div>
        <div class="kpi-card" style="padding: 0.75rem; background: var(--color-canvas);">
          <span class="kpi-label" style="font-size: 0.75rem;">Portfolio Utilisation</span>
          <p class="kpi-value" style="font-size: 1.15rem; margin: 0;">${escapeHTML(String(k.portfolioUtilisation))}</p>
        </div>
      </div>
    `;
  }

  // 2. Customer Profile Card
  if (sc.customerProfile) {
    const cp = sc.customerProfile;
    html += `
      <div style="background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 1rem; margin-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
          <div>
            <h4 style="margin: 0; font-size: 1.05rem; font-weight: 700;">${escapeHTML(cp.name)}</h4>
            <span style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-muted);">Customer ID: <code>${escapeHTML(cp.id)}</code> · Company: ${escapeHTML(cp.companyCode)} · Country: ${escapeHTML(cp.country)}</span>
          </div>
          <span class="chip ${cp.riskClass === 'CRITICAL' || cp.riskClass === 'Breach' ? 'breach' : cp.riskClass === 'WARNING' || cp.riskClass === 'Warning' ? 'warning' : 'healthy'}">${escapeHTML(cp.riskClass)}</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0.5rem; font-size: 0.85rem;">
          <div style="background: var(--color-white); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--color-border);">
            <span class="muted" style="font-size: 0.7rem; display: block;">Credit Limit</span>
            <strong>${escapeHTML(cp.creditLimit)}</strong>
          </div>
          <div style="background: var(--color-white); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--color-border);">
            <span class="muted" style="font-size: 0.7rem; display: block;">Total Exposure</span>
            <strong>${escapeHTML(cp.exposure)}</strong>
          </div>
          <div style="background: var(--color-white); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--color-border);">
            <span class="muted" style="font-size: 0.7rem; display: block;">Utilisation</span>
            <strong>${escapeHTML(cp.utilisation)}</strong>
          </div>
          <div style="background: var(--color-white); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--color-border);">
            <span class="muted" style="font-size: 0.7rem; display: block;">Overdue Amount</span>
            <strong style="color: #c5221f;">${escapeHTML(cp.overdueAmount)}</strong>
          </div>
        </div>
      </div>
    `;
  }

  // 3. Responsive Data Table
  if (sc.table && sc.table.rows && sc.table.rows.length > 0) {
    const { headers, rows } = sc.table;
    html += `
      <div class="table-wrap" style="margin-bottom: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); max-height: 350px; overflow-y: auto;">
        <table class="data-table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="position: sticky; top: 0; background: var(--color-canvas); z-index: 1;">
              ${headers.map(h => `<th style="padding: 0.5rem 0.75rem; text-align: left; border-bottom: 2px solid var(--color-border); font-weight: 600;">${escapeHTML(h)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, idx) => {
              const bg = idx % 2 === 1 ? 'background: rgba(248, 250, 252, 0.6);' : '';
              return `<tr style="${bg} border-bottom: 1px solid var(--color-border);">
                ${row.map(cell => `<td style="padding: 0.5rem 0.75rem; color: var(--color-ink);">${escapeHTML(String(cell))}</td>`).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // 4. Bar Chart
  if (sc.chart && sc.chart.values && sc.chart.values.length > 0) {
    const { title, labels, values } = sc.chart;
    const maxVal = Math.max(...values, 1);
    html += `
      <div style="background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 0.75rem; margin-bottom: 1rem;">
        <p style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem; color: var(--color-ink);">${escapeHTML(title)}</p>
        <div style="display: flex; flex-direction: column; gap: 0.4rem;">
          ${labels.map((lbl, idx) => {
            const val = values[idx];
            const pct = Math.min(100, (val / maxVal) * 100);
            return `
              <div style="display: grid; grid-template-columns: 8rem 1fr 6rem; align-items: center; gap: 0.5rem; font-size: 0.75rem;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${escapeHTML(String(lbl))}</span>
                <div style="background: #e2e8f0; height: 10px; border-radius: 5px; overflow: hidden;">
                  <div style="background: var(--color-blue); width: ${pct}%; height: 100%; border-radius: inherit;"></div>
                </div>
                <span style="font-family: var(--font-mono); text-align: right;">₹${Number(val).toLocaleString('en-IN')}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  return html;
}

function formatAssistantReply(text) {
  if (!text) return '';
  let cleanText = text
    .replace(/^###\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/---/g, '');

  let html = escapeHTML(cleanText);

  html = html.replace(/\b((?:MS-)?C\d{3})\b/g, '<code style="background: var(--color-blue-soft); color: var(--color-blue); padding: 0.1rem 0.3rem; border-radius: 4px; font-weight: 600;">$1</code>');
  html = html.replace(/\b(₹\s*[\d,]+(?:\.\d+)?|\bINR\s*[\d,]+(?:\.\d+)?)\b/g, '<strong style="color: var(--color-ink);">$1</strong>');
  html = html.replace(/\b(\d+(?:\.\d+)?%)\b/g, (match, pct) => {
    const val = parseFloat(pct);
    const cls = val >= 100 ? 'chip breach' : val >= 80 ? 'chip warning' : 'chip healthy';
    return `<span class="${cls}" style="display: inline-block; margin: 0 2px;">${pct}</span>`;
  });

  html = html.replace(/^\s*\*\s+(.*)$/gm, '<li style="margin-bottom: 0.35rem; color: var(--color-ink);">$1</li>');
  html = html.replace(/(<li.*<\/li>\n?)+/g, '<ul style="padding-left: 1.25rem; margin: 0.5rem 0;">$&</ul>');

  html = html.replace(/\n\n/g, '</p><p style="margin-top: 0.75rem; margin-bottom: 0;">');
  html = html.replace(/\n/g, '<br>');

  return `<div class="structured-assistant-reply" style="line-height: 1.5; font-size: 0.95rem;"><p style="margin: 0;">${html}</p></div>`;
}

export function renderChat(messages, execution = null, permissions = null) {
  const host = document.querySelector('#chat-messages');
  if (!messages.length) {
    host.innerHTML = '<p class="empty-state">Ask about exposure, flagged customers, or a customer ID such as C001. The assistant provides structured visual cards, tables, and analytics with full provenance.</p>';
    return;
  }
  host.innerHTML = messages.map(message => {
    const providerLabel = message.provider === 'offline' ? 'Offline fallback'
      : message.provider === 'gemini' ? 'Gemini AI'
        : message.provider === 'anthropic' ? 'Anthropic' : 'Configured provider';
    const provenance = message.role === 'assistant' && message.provider
      ? `<small class="chat-provenance" style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--color-border); font-size: 0.75rem;"><span class="chip ${message.provider === 'offline' ? 'review' : 'healthy'}">${escapeHTML(providerLabel)}</span>
        ${message.modulesUsed?.length ? `<span style="background: var(--color-canvas); padding: 0.1rem 0.4rem; border-radius: 4px;">Modules: ${escapeHTML(message.modulesUsed.join(', '))}</span>` : ''}
        ${message.dataSourcesUsed?.length ? `<span style="background: var(--color-canvas); padding: 0.1rem 0.4rem; border-radius: 4px;">Sources: ${escapeHTML(message.dataSourcesUsed.map(source => source.name).join(', '))}</span>` : ''}
        ${message.providerFallbackReason ? `<span style="color: var(--color-amber);">Fallback: ${escapeHTML(message.providerFallbackReason.replaceAll('_', ' '))}</span>` : ''}</small>`
      : '';
    const text = message.provider
      ? message.text.replace(/\n\nResponse provider: [^\n]*$/, '')
      : message.text;
    const visualContent = renderStructuredContent(message.structuredContent);
    const contentHtml = message.role === 'assistant'
      ? `${visualContent}${formatAssistantReply(text)}`
      : `<p style="margin: 0; font-weight: 500;">${escapeHTML(text)}</p>`;
    return `<div class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}" style="background: ${message.role === 'user' ? 'var(--color-blue-soft)' : 'var(--color-white)'}; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 0.75rem; box-shadow: var(--shadow-card);">${provenance}${contentHtml}</div>`;
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
    `<li style="margin-bottom: 0.35rem;"><strong>${escapeHTML(step.tool)}</strong> <span class="chip ${step.status === 'SUCCESS' ? 'healthy' : 'warning'}">${escapeHTML(step.status)}</span> — <span class="muted">${escapeHTML(step.summary)}</span></li>`
  ).join('');
  const proposals = (execution.preparedActions || []).map(proposal => `<article class="approval-item" style="border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem; background: var(--color-white);">
    <strong>Approval required: ${escapeHTML(proposal.customerName)} · <code>${escapeHTML(proposal.customerId)}</code></strong>
    <p class="muted" style="margin: 0.25rem 0;">${escapeHTML(proposal.reason)}</p>
    <p style="font-family: var(--font-mono); font-size: 0.85rem; margin: 0.25rem 0;">₹${escapeHTML(String(proposal.currentLimit))} → <strong>₹${escapeHTML(String(proposal.requestedLimit))}</strong> · Routed to <strong>${escapeHTML(proposal.approverLevel)}</strong></p>
    ${permissions?.canRequest ? `<button class="button primary" type="button" data-submit-proposal="true" data-proposal-index="${(execution.preparedActions || []).indexOf(proposal)}" style="margin-top: 0.5rem;">Submit request for human approval</button>` : ''}
  </article>`).join('');
  const preview = execution.workflowPreview;
  const workflow = preview ? `<section class="workflow-preview" style="background: var(--color-canvas); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem;">
    <h3 style="font-size: 1rem; margin-bottom: 0.25rem;">${escapeHTML(preview.name)} · Preview only</h3>
    <p class="muted" style="margin-bottom: 0.75rem;">${escapeHTML(preview.source)} No workflow steps have been executed.</p>
    <ol style="padding-left: 1.25rem;">${preview.steps.map(step => `<li style="margin-bottom: 0.5rem;">
      <strong>${escapeHTML(step.module)} · ${escapeHTML(step.operation)}</strong>
      <p class="workflow-step-details muted" style="margin: 0.15rem 0; font-size: 0.8rem;">Depends on: ${escapeHTML(step.dependsOn.length ? step.dependsOn.join(', ') : 'None')} · Roles: ${escapeHTML(step.requiredRoles.join(', '))} · Confirmation: ${escapeHTML(step.confirmation)}</p>
      <p class="workflow-step-details" style="margin: 0; font-size: 0.85rem;">Expected result: ${escapeHTML(step.expectedResult)}</p>
    </li>`).join('')}</ol>
    <ul class="workflow-limitations" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--color-muted);">${preview.limitations.map(limitation => `<li>${escapeHTML(limitation)}</li>`).join('')}</ul>
  </section>` : '';
  host.innerHTML = `<div style="background: var(--color-white); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem; box-shadow: var(--shadow-card);"><p style="font-weight: 600; margin-bottom: 0.5rem;">Execution Status: <span class="chip ${execution.status === 'COMPLETED' ? 'healthy' : 'warning'}">${escapeHTML(execution.status)}</span></p>${steps ? `<p class="muted" style="font-size: 0.85rem; margin-bottom: 0.25rem;">Tool Activity Trace:</p><ul style="padding-left: 1.25rem; font-size: 0.85rem;">${steps}</ul>` : '<p class="muted">No tools invoked for this response.</p>'}${workflow}${proposals}</div>`;
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
      providerFallbackReason: result.providerFallback ? result.providerFallbackReason : null,
      structuredContent: result.structuredContent || null
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
      providerFallbackReason: result.providerFallback ? result.providerFallbackReason : null,
      structuredContent: result.structuredContent || null
    });
    renderChat(messages, state.agentExecution, state.session?.permissions);
  } catch (error) {
    document.querySelector('#chat-error').textContent = error.message;
  } finally {
    if (status) status.textContent = '';
  }
}
