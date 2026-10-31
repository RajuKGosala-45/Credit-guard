import { escapeHTML, formatINR } from '../utils.js';

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
    message.textContent = `Request submitted. Routed to ${request.approverLevel}. Await a human decision in Approvals.`;
    return request;
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
    return null;
  }
}
