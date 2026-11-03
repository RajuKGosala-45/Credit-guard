import { escapeHTML, formatDate, formatINR } from '../utils.js';

export function renderApprovals(requests) {
  const pending = requests.filter(request => request.status === 'Pending');
  const decided = requests.filter(request => request.status !== 'Pending');
  document.querySelector('#pending-count').textContent = String(pending.length);
  const host = document.querySelector('#approvals-list');
  const pendingHtml = pending.length ? pending.map(request => `<article class="approval-item">
    <div class="card-heading"><strong>${escapeHTML(request.customerName)} · ${escapeHTML(request.customer_ID)}</strong><span class="chip warning">${escapeHTML(request.approverLevel)}</span></div>
    <p>${escapeHTML(formatINR(Number(request.currentLimit)))} → <strong>${escapeHTML(formatINR(Number(request.requestedLimit)))}</strong></p>
    <p>${escapeHTML(request.reason)}</p><p class="muted">Requested by ${escapeHTML(request.requestedBy)} · ${escapeHTML(formatDate(request.createdAt))}</p>
    <div class="approval-actions"><button class="button primary" type="button" data-decision="Approved" data-request-id="${escapeHTML(request.ID)}">Approve</button>
    <button class="button danger" type="button" data-decision="Rejected" data-request-id="${escapeHTML(request.ID)}">Reject</button></div>
  </article>`).join('') : '<p class="empty-state">No pending requests. Submit a limit change from Portfolio when a customer needs review.</p>';
  const historyHtml = decided.length ? `<h2 class="history-heading">Decision history</h2>${decided.map(request =>
    `<article class="approval-item"><div class="card-heading"><strong>${escapeHTML(request.customerName)} · ${escapeHTML(request.customer_ID)}</strong><span class="chip ${request.status === 'Approved' ? 'healthy' : 'breach'}">${escapeHTML(request.status)}</span></div>
    <p>${escapeHTML(formatINR(Number(request.currentLimit)))} → ${escapeHTML(formatINR(Number(request.requestedLimit)))}</p>
    <p>${escapeHTML(request.reason)}</p><p class="muted">Decided by ${escapeHTML(request.decidedBy || '—')} · ${escapeHTML(formatDate(request.decidedAt))}</p></article>`
  ).join('')}` : '';
  host.innerHTML = `${pendingHtml}${historyHtml}`;
}

export async function handleApprovalClick(event, decide) {
  const button = event.target.closest('[data-decision]');
  if (!button) return null;
  const reason = window.prompt('Enter the business reason for this approval decision (1-500 characters).');
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
