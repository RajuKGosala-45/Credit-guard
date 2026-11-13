import { escapeHTML, formatMoney, formatPercent } from '../utils.js';

export const KPI_THRESHOLD_RULES = Object.freeze({
  exposure: 'Healthy: exposure <60% of total limit · Watch: 60–80% · Action needed: >80%',
  limit: 'Healthy: ≥25% available limit headroom · Watch: 10–25% headroom · Action needed: <10% headroom',
  utilisation: 'Healthy: <60% utilisation · Watch: 60–80% utilisation · Action needed: >80% utilisation',
  overdue: 'Healthy: 0 overdue invoices · Watch: 1–5 overdue invoices · Action needed: >5 overdue invoices'
});

const STATUS_META = Object.freeze({
  healthy: { tone: 'healthy', label: 'Healthy', icon: '✓' },
  watch: { tone: 'watch', label: 'Watch', icon: '▲' },
  action: { tone: 'action', label: 'Action needed', icon: '!' }
});

export function evaluateKpiStatus(metricKey, kpis = {}) {
  const util = Number(kpis.overallUtilisation);
  const finiteUtil = Number.isFinite(util) ? util : 0;
  const overdueCount = Number(kpis.overdueInvoiceCount) || 0;
  const manualReview = Number(kpis.manualReviewCustomers) || 0;

  if (metricKey === 'utilisation') {
    const status = finiteUtil > 0.8 ? STATUS_META.action : finiteUtil >= 0.6 ? STATUS_META.watch : STATUS_META.healthy;
    return { ...status, tooltip: KPI_THRESHOLD_RULES.utilisation };
  }

  if (metricKey === 'overdue') {
    const status = overdueCount > 5 ? STATUS_META.action : overdueCount >= 1 ? STATUS_META.watch : STATUS_META.healthy;
    return { ...status, tooltip: KPI_THRESHOLD_RULES.overdue };
  }

  if (metricKey === 'limit') {
    const headroom = 1 - finiteUtil;
    const status = headroom < 0.1 ? STATUS_META.action : (headroom < 0.25 || manualReview > 0) ? STATUS_META.watch : STATUS_META.healthy;
    return { ...status, tooltip: KPI_THRESHOLD_RULES.limit };
  }

  // Default: exposure relative to total limit
  const status = finiteUtil > 0.8 ? STATUS_META.action : finiteUtil >= 0.6 ? STATUS_META.watch : STATUS_META.healthy;
  return { ...status, tooltip: KPI_THRESHOLD_RULES.exposure };
}

export function buildPortfolioVerdict(kpis = {}) {
  const util = Number(kpis.overallUtilisation);
  const finiteUtil = Number.isFinite(util) ? util : 0;
  const overdueCount = Number(kpis.overdueInvoiceCount) || 0;
  const overdueCustomers = Number(kpis.overdueRiskCustomers) || 0;
  const breachedCustomers = Number(kpis.customersBreached) || 0;

  const utilDescriptor = finiteUtil > 0.8 ? 'high' : finiteUtil >= 0.6 ? 'moderate' : 'healthy';

  let tone = 'healthy';
  if (overdueCount > 5 || finiteUtil > 0.8 || breachedCustomers > 0) {
    tone = 'action';
  } else if (overdueCount >= 1 || finiteUtil >= 0.6) {
    tone = 'watch';
  }

  let reasonText = 'All customer accounts are within credit terms';
  if (overdueCount > 0) {
    reasonText = `${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'} across ${overdueCustomers} customer${overdueCustomers === 1 ? '' : 's'}`;
  } else if (breachedCustomers > 0) {
    reasonText = `${breachedCustomers} customer${breachedCustomers === 1 ? '' : 's'} exceed assigned credit limits`;
  }

  const meta = STATUS_META[tone];
  const text = tone === 'healthy'
    ? `Utilisation is ${formatPercent(finiteUtil)} (${utilDescriptor}). All customer accounts are within credit terms.`
    : `${meta.label}: ${reasonText}. Utilisation ${formatPercent(finiteUtil)} (${utilDescriptor}).`;

  return {
    tone,
    badgeLabel: meta.label,
    icon: meta.icon,
    text
  };
}

export function buildAttentionAlerts(dashboard = {}, requests = []) {
  const kpis = dashboard?.kpis || {};
  const companyRows = Array.isArray(dashboard?.exposure?.companyCode) ? dashboard.exposure.companyCode : [];
  const countryRows = Array.isArray(dashboard?.exposure?.country) ? dashboard.exposure.country : [];
  const alerts = [];

  const overdueCount = Number(kpis.overdueInvoiceCount) || 0;
  const overdueCustomers = Number(kpis.overdueRiskCustomers) || 0;
  if (overdueCount > 0) {
    const isSevere = overdueCount > 5;
    alerts.push({
      id: 'overdue-concentration',
      tone: isSevere ? 'action' : 'watch',
      badge: isSevere ? STATUS_META.action.label : STATUS_META.watch.label,
      icon: isSevere ? STATUS_META.action.icon : STATUS_META.watch.icon,
      priority: isSevere ? 95 : 65,
      headline: `Overdue concentration (${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'}, ${overdueCustomers} customer${overdueCustomers === 1 ? '' : 's'})`,
      reason: `${formatMoney(kpis.overdueAmount, kpis.currency || 'INR')} in past-due receivables requires collections and monitoring follow-up.`,
      targetTab: 'dashboard',
      targetLabel: 'View in Portfolio & Monitoring'
    });
  }

  const breachedCustomers = Number(kpis.customersBreached) || 0;
  const criticalCustomers = Number(kpis.criticalCustomers) || 0;
  if (breachedCustomers > 0) {
    alerts.push({
      id: 'limit-breaches',
      tone: 'action',
      badge: STATUS_META.action.label,
      icon: STATUS_META.action.icon,
      priority: 90,
      headline: `${breachedCustomers} customer${breachedCustomers === 1 ? '' : 's'} at or above 100% credit limit`,
      reason: criticalCustomers > 0
        ? `Includes ${criticalCustomers} critical account${criticalCustomers === 1 ? '' : 's'} at ≥120% utilisation requiring immediate credit review.`
        : 'Accounts have exhausted available credit headroom and require exposure review.',
      targetTab: 'analysis',
      targetLabel: 'View in Exposure Analysis'
    });
  }

  const highCompanyCodes = companyRows
    .filter(row => Number.isFinite(row.utilisation) && row.utilisation >= 0.8)
    .sort((a, b) => b.utilisation - a.utilisation);

  if (highCompanyCodes.length > 0) {
    const maxUtil = highCompanyCodes[0].utilisation;
    const isAction = maxUtil > 0.8;
    const summaryList = highCompanyCodes
      .slice(0, 3)
      .map(row => `${row.label} ${formatPercent(row.utilisation)}`)
      .join(', ');
    alerts.push({
      id: 'company-code-utilisation',
      tone: isAction ? 'action' : 'watch',
      badge: isAction ? STATUS_META.action.label : STATUS_META.watch.label,
      icon: isAction ? STATUS_META.action.icon : STATUS_META.watch.icon,
      priority: isAction ? 82 : 70,
      headline: `Company code with high utilisation (${summaryList})`,
      reason: `${highCompanyCodes.length} legal entit${highCompanyCodes.length === 1 ? 'y has' : 'ies have'} reached or exceeded the 80% utilisation threshold.`,
      targetTab: 'analysis',
      targetLabel: 'View in Exposure Analysis'
    });
  }

  const totalExposure = Number(kpis.totalExposure) || 0;
  if (countryRows.length > 0 && totalExposure > 0) {
    const sortedCountries = [...countryRows].sort((a, b) => (Number(b.exposure) || 0) - (Number(a.exposure) || 0));
    const topCountry = sortedCountries[0];
    const shareRatio = (Number(topCountry.exposure) || 0) / totalExposure;
    const countryUtil = Number(topCountry.utilisation) || 0;
    if (shareRatio >= 0.5 || countryUtil >= 0.65) {
      const sharePct = `${(shareRatio * 100).toFixed(1)}%`;
      alerts.push({
        id: 'country-concentration',
        tone: 'watch',
        badge: STATUS_META.watch.label,
        icon: STATUS_META.watch.icon,
        priority: 60,
        headline: `Country concentration (${topCountry.label} ${formatPercent(countryUtil)} utilisation · ${sharePct} of exposure)`,
        reason: `${formatMoney(topCountry.exposure, topCountry.currency || kpis.currency || 'INR')} across ${topCountry.customers} customer${topCountry.customers === 1 ? '' : 's'} is concentrated in ${topCountry.label}.`,
        targetTab: 'analysis',
        targetLabel: 'View in Exposure Analysis'
      });
    }
  }

  const pendingRequests = Array.isArray(requests)
    ? requests.filter(req => req && (req.status === 'Pending' || req.status === 'PENDING_APPROVAL'))
    : [];
  if (pendingRequests.length > 0) {
    const count = pendingRequests.length;
    alerts.push({
      id: 'pending-approvals',
      tone: 'watch',
      badge: STATUS_META.watch.label,
      icon: STATUS_META.watch.icon,
      priority: 55,
      headline: `Pending limit approvals (${count} request${count === 1 ? '' : 's'} awaiting decision)`,
      reason: 'Submitted credit limit change requests require Credit Controller or Finance Head review.',
      targetTab: 'approvals',
      targetLabel: 'View in Limit Approvals'
    });
  }

  return alerts
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);
}

export const OVERVIEW_SHORTCUTS = Object.freeze([
  {
    tab: 'dashboard',
    title: 'Portfolio & Monitoring',
    description: 'Run manual credit monitoring, inspect active alerts, and submit credit limit change requests.',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'
  },
  {
    tab: 'analysis',
    title: 'Exposure Analysis',
    description: 'Break down credit exposure and utilisation by country, company code, and customer.',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
  },
  {
    tab: 'approvals',
    title: 'Limit Approvals',
    description: 'Review pending credit limit requests and record authorized Credit Controller and Finance Head decisions.',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'
  },
  {
    tab: 'chat',
    title: 'AI Credit Assistance',
    description: 'Ask policy-grounded credit questions, evaluate customer risk, and simulate limit change scenarios.',
    icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z'
  }
]);

export function renderKpis(kpis) {
  if (!kpis) return;
  const multiCurrency = Array.isArray(kpis.currencyTotals);
  const money = value => multiCurrency ? 'Multiple currencies' : formatMoney(value, kpis.currency);

  const cardThemes = [
    'kpi-card--exposure',
    'kpi-card--limit',
    'kpi-card--utilisation',
    'kpi-card--overdue'
  ];

  const metricKeys = ['exposure', 'limit', 'utilisation', 'overdue'];

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
    kpiHost.innerHTML = values.map(([label, value, note], idx) => {
      const themeClass = cardThemes[idx % cardThemes.length];
      const metricKey = metricKeys[idx] || 'exposure';
      const status = evaluateKpiStatus(metricKey, kpis);
      return `
        <article class="kpi-card ${themeClass}">
          <div class="kpi-card-top">
            <p class="kpi-label">${escapeHTML(label)}</p>
            <span
              class="kpi-status-chip kpi-status-chip--${escapeHTML(status.tone)}"
              tabindex="0"
              title="${escapeHTML(status.tooltip)}"
              aria-label="${escapeHTML(`${label} status: ${status.label}. ${status.tooltip}`)}"
            >
              <span aria-hidden="true">${escapeHTML(status.icon)}</span>
              <span>${escapeHTML(status.label)}</span>
            </span>
          </div>
          <p class="kpi-value">${escapeHTML(value)}</p>
          <p class="kpi-note">${escapeHTML(note)}</p>
        </article>
      `;
    }).join('');
  }
}

export function renderCreditOverview(dashboard, requests = []) {
  if (!dashboard?.kpis) return;
  renderKpis(dashboard.kpis);

  const verdictHost = document.querySelector('#overview-health-verdict');
  if (verdictHost) {
    const verdict = buildPortfolioVerdict(dashboard.kpis);
    verdictHost.className = `overview-verdict-banner overview-verdict-banner--${verdict.tone}`;
    verdictHost.innerHTML = `
      <span class="overview-verdict-badge overview-verdict-badge--${escapeHTML(verdict.tone)}">
        <span aria-hidden="true">${escapeHTML(verdict.icon)}</span>
        <span>${escapeHTML(verdict.badgeLabel)}</span>
      </span>
      <p class="overview-verdict-text">${escapeHTML(verdict.text)}</p>
    `;
  }

  const alerts = buildAttentionAlerts(dashboard, requests);
  const countHost = document.querySelector('#overview-attention-count');
  if (countHost) {
    countHost.textContent = alerts.length > 0
      ? `${alerts.length} priority item${alerts.length === 1 ? '' : 's'}`
      : 'All clear';
  }

  const alertsHost = document.querySelector('#overview-attention-list');
  if (alertsHost) {
    if (!alerts.length) {
      alertsHost.innerHTML = `
        <div class="overview-empty-attention" role="status">
          <span class="overview-empty-icon" aria-hidden="true">✓</span>
          <div>
            <strong>No items need attention</strong>
            <p class="muted">All portfolio utilisation, overdue, and approval indicators are within healthy thresholds.</p>
          </div>
        </div>
      `;
    } else {
      alertsHost.innerHTML = alerts.map(alert => `
        <article class="overview-attention-card overview-attention-card--${escapeHTML(alert.tone)}">
          <div class="overview-attention-body">
            <span class="kpi-status-chip kpi-status-chip--${escapeHTML(alert.tone)}">
              <span aria-hidden="true">${escapeHTML(alert.icon)}</span>
              <span>${escapeHTML(alert.badge)}</span>
            </span>
            <div class="overview-attention-copy">
              <h3 class="overview-attention-headline">${escapeHTML(alert.headline)}</h3>
              <p class="overview-attention-reason muted">${escapeHTML(alert.reason)}</p>
            </div>
          </div>
          <button
            type="button"
            class="button secondary overview-attention-action"
            data-tab="${escapeHTML(alert.targetTab)}"
          >
            ${escapeHTML(alert.targetLabel)}
          </button>
        </article>
      `).join('');
    }
  }

  const shortcutsHost = document.querySelector('#overview-shortcuts');
  if (shortcutsHost) {
    shortcutsHost.innerHTML = OVERVIEW_SHORTCUTS.map(item => `
      <button
        type="button"
        class="overview-shortcut-card"
        data-tab="${escapeHTML(item.tab)}"
      >
        <span class="overview-shortcut-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">
            <path d="${escapeHTML(item.icon)}"></path>
          </svg>
        </span>
        <span class="overview-shortcut-content">
          <strong class="overview-shortcut-title">${escapeHTML(item.title)}</strong>
          <span class="overview-shortcut-desc muted">${escapeHTML(item.description)}</span>
        </span>
        <span class="overview-shortcut-arrow" aria-hidden="true">→</span>
      </button>
    `).join('');
  }
}

export function renderExposure(dashboard, group, selector = '#exposure-list') {
  const rows = dashboard?.exposure?.[group] || [];
  const host = document.querySelector(selector);
  if (!host) return;
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
