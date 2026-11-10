import { escapeHTML, formatMoney, formatPercent } from '../utils.js';

export function renderKpis(kpis) {
  const multiCurrency = Array.isArray(kpis.currencyTotals);
  const money = value => multiCurrency ? 'Multiple currencies' : formatMoney(value, kpis.currency);
  
  const cardStyles = [
    { bg: '#f0f6ff', border: '#bfdbfe', numColor: '#1d4ed8' }, // Total exposure (Blue)
    { bg: '#f0fdf4', border: '#bbf7d0', numColor: '#15803d' }, // Total credit limit (Green)
    { bg: '#f5f3ff', border: '#ddd6fe', numColor: '#6d28d9' }, // Overall utilisation (Violet)
    { bg: '#fff7ed', border: '#fed7aa', numColor: '#c2410c' }  // Overdue invoices (Orange/Red warning)
  ];

  const values = [
    ['Total exposure', money(kpis.totalExposure), `${kpis.customerCount} customers`],
    ['Total credit limit', money(kpis.totalLimit), multiCurrency ? 'See currency-specific totals' : 'Across five company codes'],
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

  const kpiHost = document.querySelector('#kpis');
  if (kpiHost) {
    kpiHost.style.cssText = 'display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem;';
    kpiHost.innerHTML = values.map(([label, value, note], idx) => {
      const style = cardStyles[idx % cardStyles.length];
      return `
        <article class="kpi-card" style="background: ${style.bg}; border: 1px solid ${style.border}; border-radius: 12px; padding: 1.25rem 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 0.4rem; transition: transform 0.2s ease, box-shadow 0.2s ease;">
          <p class="kpi-label" style="font-size: 0.95rem; font-weight: 600; color: #334155; margin: 0; line-height: 1.3;">${escapeHTML(label)}</p>
          <p class="kpi-value" style="font-size: 1.75rem; font-weight: 700; color: ${style.numColor}; margin: 0; line-height: 1.2;">${escapeHTML(value)}</p>
          <p class="kpi-note" style="font-size: 0.8rem; font-weight: 400; color: #64748b; margin: 0; line-height: 1.3;">${escapeHTML(note)}</p>
        </article>
      `;
    }).join('');
  }
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
