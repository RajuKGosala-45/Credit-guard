import { escapeHTML, formatINR } from '../utils.js';

export function renderLimitRequestAvailability(session) {
  const readOnlySapSource = session?.creditLimitWorkflow === 'READ_ONLY';
  document.querySelector('#source-mode-notice').hidden = !readOnlySapSource;
  document.querySelector('#request-form').hidden =
    readOnlySapSource || !session?.permissions?.canRequest;
}

export function renderRequestCustomers(customers) {
  const select = document.querySelector('#request-customer');
  const previous = select.value;
  select.innerHTML = customers.map(customer =>
    `<option value="${escapeHTML(customer.ID)}">${escapeHTML(customer.name)} · ${escapeHTML(formatINR(customer.creditLimit))}</option>`
  ).join('');
  if (customers.some(customer => customer.ID === previous)) select.value = previous;
  if (!customers.length) select.innerHTML = '<option value="">No customers available</option>';
}

export async function handleRequestSubmit(event, createRequest) {
  event.preventDefault();
  const message = document.querySelector('#request-message');
  message.classList.remove('error');
  message.textContent = '';
  const payload = {
    customerId: document.querySelector('#request-customer').value,
    requestedLimit: Number(document.querySelector('#requested-limit').value),
    reason: document.querySelector('#request-reason').value.trim()
  };
  if (!payload.customerId || payload.requestedLimit <= 0 || !payload.reason) {
    message.classList.add('error');
    message.textContent = 'Select a customer, enter a positive limit, and provide a reason.';
    return null;
  }
  try {
    const request = await createRequest(payload);
    document.querySelector('#request-form').reset();
    const approver = request.approverLevel || request.approver_level || 'Credit Controller';
    const delta = request.delta_pct !== undefined ? ` (Delta: ${request.delta_pct}%)` : '';
    message.innerHTML = `
      <strong>Limit Request Submitted!</strong> Request ID: <code>${escapeHTML(request.ID || request.request_id)}</code><br>
      • Routed Authority: <strong>${escapeHTML(approver)}</strong>${delta}<br>
      • SAP S/4HANA Segment Target: <code>UKMBP_CMS_SGM.CREDIT_LIMIT</code> (verified: false)<br>
      • Await human-in-the-loop governance decision in <em>Limit Approvals</em>.
    `;
    return request;
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
    return null;
  }
}
