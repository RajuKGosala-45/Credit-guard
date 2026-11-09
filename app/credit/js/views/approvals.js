import { escapeHTML, formatDate, formatINR } from '../utils.js';

export function renderApprovals(requests, session) {
  const pending = requests.filter(request => request.status === 'Pending');
  const decided = requests.filter(request => request.status !== 'Pending');
  document.querySelector('#pending-count').textContent = String(pending.length);
  const host = document.querySelector('#approvals-list');
  const canDecide = request => session?.creditLimitWorkflow !== 'READ_ONLY'
    && request.requestedBy !== session?.userId
    && (session?.permissions?.canApproveFinance
      || (request.approverLevel === 'Credit Controller'
        && session?.permissions?.canApproveController));
  const pendingHtml = pending.length ? pending.map(request => `<article class="approval-item">
    <div class="card-heading"><strong>${escapeHTML(request.customerName)} · ${escapeHTML(request.customer_ID)}</strong><span class="chip warning">${escapeHTML(request.approverLevel)}</span></div>
    <p>${escapeHTML(formatINR(Number(request.currentLimit)))} → <strong>${escapeHTML(formatINR(Number(request.requestedLimit)))}</strong></p>
    <p>${escapeHTML(request.reason)}</p><p class="muted">Requested by ${escapeHTML(request.requestedBy)} · ${escapeHTML(formatDate(request.createdAt))}</p>
    ${canDecide(request) ? `<div class="approval-actions">
      <input class="approval-reason-input" type="text" maxlength="500" data-reason-for="${escapeHTML(request.ID)}" aria-label="Decision reason for ${escapeHTML(request.customerName)}" placeholder="Enter decision reason (required)" value="Verified against SAP FSCM receivables &amp; payment history">
      <button class="button primary" type="button" data-decision="Approved" data-request-id="${escapeHTML(request.ID)}">Approve</button>
      <button class="button danger" type="button" data-decision="Rejected" data-request-id="${escapeHTML(request.ID)}">Reject</button>
    </div>` : ''}
  </article>`).join('') : '<p class="empty-state">No pending requests. Submit a limit change from Portfolio when a customer needs review.</p>';
  const historyHtml = decided.length ? `<h2 class="history-heading">Decision history</h2>${decided.map(request =>
    `<article class="approval-item"><div class="card-heading"><strong>${escapeHTML(request.customerName)} · ${escapeHTML(request.customer_ID)}</strong><span class="chip ${request.status === 'Approved' ? 'healthy' : 'breach'}">${escapeHTML(request.status)}</span></div>
    <p>${escapeHTML(formatINR(Number(request.currentLimit)))} → ${escapeHTML(formatINR(Number(request.requestedLimit)))}</p>
    <p>${escapeHTML(request.reason)}</p>${(request.auditHistory || []).map(event =>
      `<p class="muted">Decision ${escapeHTML(event.newStatus)} · Approver ${escapeHTML(event.approver_ID)} · ${escapeHTML(formatDate(event.timestamp))}<br>Reason: ${escapeHTML(event.decisionReason)}</p>`
    ).join('') || `<p class="muted">Decided by ${escapeHTML(request.decidedBy || '—')} · ${escapeHTML(formatDate(request.decidedAt))}</p>`}
    ${request.status === 'Approved' ? `
      <div style="margin-top: 0.5rem;">
        <button class="button secondary sync-sap-btn" type="button" data-sync-request-id="${escapeHTML(request.ID)}">
          ⚡ Sync to SAP S/4HANA (UKMBP_CMS_SGM)
        </button>
        <span class="muted" style="margin-left: 0.5rem; font-size: 0.85rem;">(verified: false · verify in SE11/SE16N)</span>
      </div>
    ` : ''}</article>`
  ).join('')}` : '';
  const readOnlyNotice = session?.creditLimitWorkflow === 'READ_ONLY'
    ? '<p class="notice read-only">SAP is connected in read-only mode. Approval and rejection actions are disabled; existing entries are local demo history and do not update SAP.</p>'
    : '';
  host.innerHTML = `${readOnlyNotice}${pendingHtml}${historyHtml}`;
}

export async function handleApprovalClick(event, decide) {
  const button = event.target.closest('[data-decision]');
  if (!button) return null;
  const container = button.closest('.approval-item') || document;
  const reasonInput = container.querySelector?.(`[data-reason-for="${button.dataset.requestId}"]`);
  const reason = reasonInput ? reasonInput.value : window.prompt('Enter the business reason for this approval decision (1-500 characters).');
  if (reason === null) return null;
  if (!reason.trim() || reason.trim().length > 500) {
    throw new Error('Enter a decision reason of 1-500 characters.');
  }
  button.disabled = true;
  try {
    return await decide(button.dataset.requestId, {
      decision: button.dataset.decision, reason: reason.trim()
    });
  } finally {
    button.disabled = false;
  }
}
