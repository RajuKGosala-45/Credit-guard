import { escapeHTML, formatMoney, formatPercent, statusClass } from '../utils.js';

const dateTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
};

function renderCounts(summary, activeAlertCount) {
  const counts = summary || {};
  const values = [
    ['Customers monitored', counts.customersMonitored || 0],
    ['Warning', counts.warningCustomers || 0],
    ['At/over limit', counts.breachedCustomers || 0],
    ['Critical', counts.criticalCustomers || 0],
    ['Overdue', counts.overdueCustomers || 0],
    ['Overdue invoices', counts.overdueInvoiceCount || 0],
    ['Active alerts', activeAlertCount || 0]
  ];
  document.querySelector('#monitoring-kpis').innerHTML = values.map(([label, count]) =>
    `<article class="kpi-card"><p class="kpi-label">${escapeHTML(label)}</p><p class="kpi-value">${escapeHTML(count)}</p></article>`
  ).join('');
}

function renderAlerts(alerts, canOperate) {
  const host = document.querySelector('#monitoring-alerts');
  if (!alerts.length) {
    host.innerHTML = '<p class="empty-state">No active monitoring alerts.</p>';
    return;
  }
  host.innerHTML = alerts.map(alert => `
    <article class="monitoring-alert">
      <div>
        <span class="chip ${statusClass(alert.severity)}">${escapeHTML(alert.severity)}</span>
        <span class="chip ${statusClass(alert.status)}">${escapeHTML(alert.status)}</span>
        <strong>${escapeHTML(alert.customerName)}</strong>
        <span>${escapeHTML(alert.conditionKey.replaceAll('_', ' ').toLowerCase())}</span>
        <p class="muted">${escapeHTML(formatPercent(alert.utilisation))} utilisation · ${escapeHTML(formatMoney(alert.overdueAmount, alert.currency))} overdue · last seen ${escapeHTML(dateTime(alert.lastSeenAt))}</p>
      </div>
      ${canOperate ? `<div class="monitoring-actions">
        ${alert.status === 'ACTIVE' ? `<button class="button secondary" type="button" data-alert-action="acknowledge" data-alert-id="${escapeHTML(alert.ID)}">Acknowledge</button>` : ''}
        <button class="button secondary" type="button" data-alert-action="resolve" data-alert-id="${escapeHTML(alert.ID)}">Resolve</button>
      </div>` : ''}
    </article>
  `).join('');
}

function renderFindings(findings) {
  const host = document.querySelector('#monitoring-findings');
  if (!findings.length) {
    host.innerHTML = '<p class="empty-state">No customer findings are stored for the latest run.</p>';
    return;
  }
  host.innerHTML = `<table><thead><tr><th>Customer</th><th>Severity</th><th>Conditions</th><th>Exposure</th><th>Limit</th><th>Utilisation</th><th>Overdue</th></tr></thead><tbody>
    ${findings.map(finding => `<tr>
      <td>${escapeHTML(finding.customerName)} (${escapeHTML(finding.customer_ID)})</td>
      <td><span class="chip ${statusClass(finding.severity)}">${escapeHTML(finding.severity)}</span></td>
      <td>${escapeHTML((finding.conditions || []).join(', ').replaceAll('_', ' '))}</td>
      <td>${escapeHTML(formatMoney(finding.exposure, finding.currency))}</td>
      <td>${escapeHTML(formatMoney(finding.creditLimit, finding.currency))}</td>
      <td>${escapeHTML(formatPercent(finding.utilisation))}</td>
      <td>${escapeHTML(formatMoney(finding.overdueAmount, finding.currency))}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderHistory(runs, canOperate) {
  const host = document.querySelector('#monitoring-history');
  if (!runs.length) {
    host.innerHTML = '<p class="empty-state">No monitoring history is available.</p>';
    return;
  }
  host.innerHTML = `<table><thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Source</th><th>Customers</th><th>Freshness</th></tr></thead><tbody>
    ${runs.map(run => `<tr>
      <td>${escapeHTML(dateTime(run.startedAt))}</td>
      <td>${escapeHTML(run.runKind)}</td>
      <td><span class="chip ${statusClass(run.status)}">${escapeHTML(run.status)}</span></td>
      <td>${escapeHTML(run.source || '—')}</td>
      <td>${escapeHTML(run.summary?.customersMonitored ?? '—')}</td>
      <td>${escapeHTML(run.freshness || '—')}${canOperate && ['FAILED', 'PARTIAL', 'STALE'].includes(run.status)
        && run.recoveryStatus === 'AVAILABLE'
        ? ` <button class="button secondary" type="button" data-monitoring-recovery="${escapeHTML(run.id)}">Recover</button>`
        : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

export function renderMonitoring({ summary, runs, alerts, findings }) {
  const latest = summary.latestRun;
  const runSummary = latest?.summary;
  const canOperate = summary.canOperate === true;
  document.querySelector('#run-monitoring').hidden = !canOperate;
  renderCounts(runSummary, summary.activeAlertCount);
  const statusText = latest
    ? `Latest run ${latest.status} · ${latest.source || 'source unavailable'} · retrieved ${dateTime(latest.retrievedAt)} · source freshness ${latest.freshness || 'UNKNOWN'} · last successful ${dateTime(summary.lastSuccessfulAt)}`
    : 'No monitoring run is available yet.';
  document.querySelector('#monitoring-status').textContent = statusText;
  document.querySelector('#monitoring-error').textContent = latest
    && ['FAILED', 'PARTIAL', 'STALE'].includes(latest.status)
    ? `Latest monitoring run is ${latest.status.toLowerCase()}${latest.errorCategory ? ` (${latest.errorCategory})` : ''}. Review source availability and freshness before relying on findings.`
    : '';
  const advisoryText = latest?.advisorySummary
    || 'Run monitoring to see a deterministic portfolio summary.';
  const advisorySourceText = latest?.advisorySource === 'AI_ADVISORY'
    ? 'AI-assisted advisory; deterministic findings remain authoritative.'
    : latest?.advisorySource === 'DETERMINISTIC'
      ? 'Deterministic fallback summary; no external AI summary was used.'
      : '';
  document.querySelector('#monitoring-advisory').textContent = advisoryText;
  document.querySelector('#monitoring-advisory-source').textContent = advisorySourceText;
  renderAlerts(alerts, canOperate);
  renderFindings(findings);
  renderHistory(runs, canOperate);

  const overviewStatus = document.querySelector('#overview-monitoring-status');
  if (overviewStatus) overviewStatus.textContent = statusText;
  const overviewRisk = document.querySelector('#overview-risk-summary');
  if (overviewRisk) overviewRisk.textContent = advisoryText;
  const overviewSource = document.querySelector('#overview-risk-source');
  if (overviewSource) overviewSource.textContent = advisorySourceText;
  const overviewAlerts = document.querySelector('#overview-active-alerts');
  if (overviewAlerts) {
    overviewAlerts.innerHTML = !alerts.length
      ? '<p class="empty-state">No active monitoring alerts.</p>'
      : alerts.slice(0, 5).map(alert => `
        <article class="monitoring-alert">
          <div>
            <span class="chip ${statusClass(alert.severity)}">${escapeHTML(alert.severity)}</span>
            <span class="chip ${statusClass(alert.status)}">${escapeHTML(alert.status)}</span>
            <strong>${escapeHTML(alert.customerName)}</strong>
            <span>${escapeHTML(alert.conditionKey.replaceAll('_', ' ').toLowerCase())}</span>
            <p class="muted">${escapeHTML(formatPercent(alert.utilisation))} utilisation · ${escapeHTML(formatMoney(alert.overdueAmount, alert.currency))} overdue</p>
          </div>
        </article>
      `).join('');
  }
  const overviewFindings = document.querySelector('#overview-findings');
  if (overviewFindings) {
    overviewFindings.innerHTML = !findings.length
      ? '<p class="empty-state">No customer findings are stored for the latest run.</p>'
      : `<table><thead><tr><th>Customer</th><th>Severity</th><th>Exposure</th><th>Utilisation</th><th>Overdue</th></tr></thead><tbody>
        ${findings.slice(0, 6).map(finding => `<tr>
          <td>${escapeHTML(finding.customerName)} (${escapeHTML(finding.customer_ID)})</td>
          <td><span class="chip ${statusClass(finding.severity)}">${escapeHTML(finding.severity)}</span></td>
          <td>${escapeHTML(formatMoney(finding.exposure, finding.currency))}</td>
          <td>${escapeHTML(formatPercent(finding.utilisation))}</td>
          <td>${escapeHTML(formatMoney(finding.overdueAmount, finding.currency))}</td>
        </tr>`).join('')}
      </tbody></table>`;
  }
}

