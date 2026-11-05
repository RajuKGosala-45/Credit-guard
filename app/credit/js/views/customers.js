import { escapeHTML, formatDate, formatMoney, formatPercent, statusClass } from '../utils.js';

export function renderCustomers(customers) {
  document.querySelector('#customer-count').textContent = `${customers.length} customers`;
  const host = document.querySelector('#customer-list');
  if (!customers.length) {
    host.innerHTML = '<tr><td colspan="7" class="empty-state">No customers found. Check the seeded customer data and reload.</td></tr>';
    return;
  }
  host.innerHTML = customers.map(customer => {
    const status = customer.status === 'HEALTHY' ? 'Healthy'
      : customer.status === 'MANUAL_REVIEW' ? 'Manual review' : customer.status.replace('_', ' ');
    const overdueFlag = customer.flags.includes('OVERDUE_RISK') ? ' · Overdue risk' : '';
    return `<tr class="customer-row" data-customer-id="${escapeHTML(customer.ID)}">
      <td><span class="customer-name">${escapeHTML(customer.name)}</span><br><span class="muted">${escapeHTML(customer.ID)} · Risk ${escapeHTML(customer.riskClass)}</span></td>
      <td>${escapeHTML(customer.country)}<br><span class="muted">${escapeHTML(customer.companyCode)}</span></td>
      <td>${escapeHTML(formatMoney(customer.exposure, customer.currency))}</td><td>${escapeHTML(formatMoney(customer.creditLimit, customer.currency))}</td>
      <td>${escapeHTML(formatPercent(customer.utilisation))}</td><td>${escapeHTML(formatMoney(customer.overdueAmount, customer.currency))}</td>
      <td><span class="chip ${statusClass(customer.status)}">${escapeHTML(status)}</span>${overdueFlag ? `<br><span class="muted">${escapeHTML(overdueFlag)}</span>` : ''}<br><button class="text-button" type="button" data-explain="${escapeHTML(customer.ID)}">Explain &amp; recommend</button></td>
    </tr>`;
  }).join('');
}

export function renderCustomerDetail(customer, payments = []) {
  const host = document.querySelector('#customer-detail');
  const flags = customer.flags.length ? customer.flags.join(', ') : 'None';
  const status = customer.status === 'MANUAL_REVIEW' ? 'Manual review'
    : customer.status === 'HEALTHY' ? 'Healthy' : customer.status.replace('_', ' ');
  const items = customer.openItems || [];
  host.innerHTML = `<div class="detail-heading"><div><p class="eyebrow">CUSTOMER DETAILS</p><h2>${escapeHTML(customer.name)} · ${escapeHTML(customer.ID)}</h2></div>
    <span class="chip ${statusClass(customer.status)}">${escapeHTML(status)}</span></div>
    <p class="muted">Risk ${escapeHTML(customer.riskClass)} · Last review ${escapeHTML(formatDate(customer.lastReviewDate))} · Flags: ${escapeHTML(flags)}</p>
    <p class="muted">Exposure ${escapeHTML(formatMoney(customer.exposure, customer.currency))} of ${escapeHTML(formatMoney(customer.creditLimit, customer.currency))} · ${escapeHTML(formatPercent(customer.utilisation))} utilised · ${escapeHTML(formatMoney(customer.overdueAmount, customer.currency))} overdue</p>
    <h3>Open items (${items.length})</h3>${items.length ? `<ul class="detail-items">${items.map(item =>
      `<li>${escapeHTML(item.type)} · ${escapeHTML(formatMoney(Number(item.amount), item.currency || customer.currency))} · Due ${escapeHTML(formatDate(item.dueDate))} · ${escapeHTML(item.isOverdue ? 'Overdue (by due date)' : item.status)}${item.creditConsuming ? '' : ' · excluded from exposure'}</li>`
    ).join('')}</ul>` : '<p class="empty-state">No open items for this customer.</p>'}
    <h3>Payment history${Array.isArray(payments) ? ` (${payments.length})` : ''}</h3>${Array.isArray(payments) && payments.length ? `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Posting date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${payments.map(payment =>
      `<tr><td>${escapeHTML(payment.reference)}</td><td>${escapeHTML(formatDate(payment.postingDate))}</td><td>${escapeHTML(formatMoney(payment.amount, payment.currency || customer.currency))}</td><td>${escapeHTML(payment.status)}</td></tr>`
    ).join('')}</tbody></table></div>` : Array.isArray(payments)
      ? '<p class="empty-state">No payment history is available for this customer.</p>'
      : '<p class="empty-state">Payment history is not available from this configured source.</p>'}`;
}

export async function handleCustomerClick(event, getCustomer, getPayments) {
  const explain = event.target.closest('[data-explain]');
  if (explain) return { explainId: explain.dataset.explain };
  const row = event.target.closest('[data-customer-id]');
  if (!row) return null;
  const customer = await getCustomer(row.dataset.customerId);
  const payments = customer.source ? null : await getPayments(row.dataset.customerId);
  renderCustomerDetail(customer, payments);
  return { customer };
}
