import { escapeHTML, formatMoney, formatPercent } from '../utils.js';

export function renderKpis(kpis) {
  const multiCurrency = Array.isArray(kpis.currencyTotals);
  const money = value => multiCurrency ? 'Multiple currencies' : formatMoney(value, kpis.currency);
  const values = [
    ['Total exposure', money(kpis.totalExposure), `${kpis.customerCount} customers`],
    ['Total credit limit', money(kpis.totalLimit), multiCurrency ? 'See the currency-specific totals' : 'Across five company codes'],
    ['Overall utilisation', multiCurrency ? 'Multiple currencies' : formatPercent(kpis.overallUtilisation), 'Exposure ÷ total limit'],
    ['Overdue invoices', kpis.overdueInvoiceCount || 0, `${kpis.overdueRiskCustomers || 0} customers with elevated overdue share`]
  ];
  if (multiCurrency) {
    values.push(...kpis.currencyTotals.map(row => [
      `${row.currency} totals`,
      formatMoney(row.totalExposure, row.currency),
      `${formatMoney(row.totalLimit, row.currency)} limit · ${formatMoney(row.availableCredit, row.currency)} available · ${formatPercent(row.overallUtilisation)} utilisation`
    ]));
  }
  document.querySelector('#kpis').innerHTML = values.map(([label, value, note]) =>
    `<article class="kpi-card"><p class="kpi-label">${escapeHTML(label)}</p><p class="kpi-value">${escapeHTML(value)}</p><p class="kpi-note">${escapeHTML(note)}</p></article>`
  ).join('');
}

export function renderExposure(dashboard, group, selector = '#exposure-list') {
  const rows = dashboard?.exposure?.[group] || [];
  const host = document.querySelector(selector);
  if (!rows.length) {
    host.innerHTML = '<p class="empty-state">No exposure data yet. Confirm customers and open items are seeded.</p>';
    return;
  }
  host.innerHTML = rows.map(row => {
    const percent = Number.isFinite(row.utilisation) ? row.utilisation * 100 : row.exposure > 0 ? 100 : 0;
    const width = Math.min(100, Math.max(0, percent));
    const noLimit = row.creditLimit === 0;
    const tone = noLimit ? '' : percent >= 100 ? 'breach' : percent >= 80 ? 'warning' : '';
    return `<div class="exposure-row"><span class="exposure-label" title="${escapeHTML(row.label)}">${escapeHTML(row.label)}</span>
      <div class="bar-track" role="img" aria-label="${escapeHTML(formatPercent(row.utilisation))} utilised"><div class="bar-fill ${tone}" style="width:${width}%"></div></div>
      <span class="exposure-value">${escapeHTML(formatMoney(row.exposure, row.currency))} · ${noLimit ? 'Manual review · no limit' : escapeHTML(formatPercent(row.utilisation))}</span></div>`;
  }).join('');
}

export function handleExposureGroup(event, dashboard, onChange) {
  const button = event.target.closest('[data-group]');
  if (!button) return;
  document.querySelectorAll('.analysis-exposure-groups [data-group]')
    .forEach(item => item.classList.toggle('selected', item === button));
  onChange(button.dataset.group);
  renderExposure(dashboard, button.dataset.group);
}
