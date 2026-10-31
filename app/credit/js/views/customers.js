import { escapeHTML, formatDate, formatINR, formatPercent, statusClass } from '../utils.js';

export function renderCustomers(customers) {
  document.querySelector('#customer-count').textContent = `${customers.length} customers`;
  const host = document.querySelector('#customer-list');
  if (!customers.length) {
    host.innerHTML = '<tr><td colspan="7" class="empty-state">No customers found. Check the seeded customer data and reload.</td></tr>';
    return;
  }
  host.innerHTML = customers.map(customer => {
    const status = customer.status === 'HEALTHY' ? 'Healthy' : customer.status.replace('_', ' ');
    const overdueFlag = customer.flags.includes('OVERDUE_RISK') ? ' · Overdue risk' : '';
    return `<tr class="customer-row" data-customer-id="${escapeHTML(customer.ID)}">
      <td><span class="customer-name">${escapeHTML(customer.name)}</span><br><span class="muted">${escapeHTML(customer.ID)} · Risk ${escapeHTML(customer.riskClass)}</span></td>
      <td>${escapeHTML(customer.country)}<br><span class="muted">${escapeHTML(customer.companyCode)}</span></td>
      <td>${escapeHTML(formatINR(customer.exposure))}</td><td>${escapeHTML(formatINR(customer.creditLimit))}</td>
      <td>${escapeHTML(formatPercent(customer.utilisation))}</td><td>${escapeHTML(formatINR(customer.overdueAmount))}</td>
      <td><span class="chip ${statusClass(customer.status)}">${escapeHTML(status)}</span>${overdueFlag ? `<br><span class="muted">${escapeHTML(overdueFlag)}</span>` : ''}<br><button class="text-button" type="button" data-explain="${escapeHTML(customer.ID)}">Explain &amp; recommend</button></td>
    </tr>`;
  }).join('');
}

export function renderCustomerDetail(customer) {
  const host = document.querySelector('#customer-detail');
  const flags = customer.flags.length ? customer.flags.join(', ') : 'None';
  const items = customer.openItems || [];
  host.innerHTML = `<div class="detail-heading"><div><p class="eyebrow">CUSTOMER DETAILS</p><h2>${escapeHTML(customer.name)} · ${escapeHTML(customer.ID)}</h2></div>
    <span class="chip ${statusClass(customer.status)}">${escapeHTML(customer.status)}</span></div>
    <p class="muted">Risk ${escapeHTML(customer.riskClass)} · Last review ${escapeHTML(formatDate(customer.lastReviewDate))} · Flags: ${escapeHTML(flags)}</p>
    <h3>Open items (${items.length})</h3>${items.length ? `<ul class="detail-items">${items.map(item =>
      `<li>${escapeHTML(item.type)} · ${escapeHTML(formatINR(Number(item.amount)))} · Due ${escapeHTML(formatDate(item.dueDate))} · ${escapeHTML(item.status)}</li>`
    ).join('')}</ul>` : '<p class="empty-state">No open items for this customer.</p>'}`;
}

export async function handleCustomerClick(event, getCustomer) {
  const explain = event.target.closest('[data-explain]');
  if (explain) return { explainId: explain.dataset.explain };
  const row = event.target.closest('[data-customer-id]');
  if (!row) return null;
  const customer = await getCustomer(row.dataset.customerId);
  renderCustomerDetail(customer);
  return { customer };
}
