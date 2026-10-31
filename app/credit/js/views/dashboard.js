import { escapeHTML, formatINR, formatPercent, statusClass } from '../utils.js';

export function renderKpis(kpis) {
  const values = [
    ['Total exposure', formatINR(kpis.totalExposure), `${kpis.customerCount} customers`],
    ['Total credit limit', formatINR(kpis.totalLimit), 'Across five company codes'],
    ['Overall utilisation', formatPercent(kpis.overallUtilisation), 'Exposure ÷ total limit'],
    ['Customers breached', kpis.customersBreached, `${kpis.warningCustomers} approaching limit`]
  ];
  document.querySelector('#kpis').innerHTML = values.map(([label, value, note]) =>
    `<article class="kpi-card"><p class="kpi-label">${escapeHTML(label)}</p><p class="kpi-value">${escapeHTML(value)}</p><p class="kpi-note">${escapeHTML(note)}</p></article>`
  ).join('');
}

export function renderExposure(dashboard, group) {
  const rows = dashboard?.exposure?.[group] || [];
  const host = document.querySelector('#exposure-list');
  if (!rows.length) {
    host.innerHTML = '<p class="empty-state">No exposure data yet. Confirm customers and open items are seeded.</p>';
    return;
  }
  host.innerHTML = rows.map(row => {
    const percent = Number.isFinite(row.utilisation) ? row.utilisation * 100 : 100;
    const width = Math.min(100, Math.max(0, percent));
    const tone = percent > 100 ? 'breach' : percent >= 80 ? 'warning' : '';
    const noLimit = row.creditLimit === 0 && row.exposure > 0;
    return `<div class="exposure-row"><span class="exposure-label" title="${escapeHTML(row.label)}">${escapeHTML(row.label)}</span>
      <div class="bar-track" role="img" aria-label="${escapeHTML(formatPercent(row.utilisation))} utilised"><div class="bar-fill ${tone}" style="width:${width}%"></div></div>
      <span class="exposure-value">${escapeHTML(formatINR(row.exposure))} · ${noLimit ? 'No limit' : escapeHTML(formatPercent(row.utilisation))}</span></div>`;
  }).join('');
}

export function handleExposureGroup(event, dashboard, onChange) {
  const button = event.target.closest('[data-group]');
  if (!button) return;
  document.querySelectorAll('[data-group]').forEach(item => item.classList.toggle('selected', item === button));
  onChange(button.dataset.group);
  renderExposure(dashboard, button.dataset.group);
}
