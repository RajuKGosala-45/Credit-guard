import { escapeHTML, formatMoney, formatPercent, statusClass } from '../utils.js';

const dateTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
};

const customerNames = entities => new Map(
  (entities.CUSTOMER?.records || []).map(record => [record.KUNNR, record.NAME1])
);

function renderRecordTable(title, entityType, fields, entities, names) {
  const records = entities[entityType]?.records || [];
  return `<section class="card mock-sap-record-card">
    <h3>${escapeHTML(title)} <span class="muted">(${records.length})</span></h3>
    <div class="table-wrap"><table><thead><tr>${fields.map(([, label]) => `<th>${escapeHTML(label)}</th>`).join('')}</tr></thead><tbody>
      ${records.map(record => `<tr>${fields.map(([field]) => {
        const value = field === 'CUSTOMER_NAME'
          ? names.get(record.KUNNR) || record.KUNNR
          : record[field] ?? '—';
        return `<td>${escapeHTML(value)}</td>`;
      }).join('')}</tr>`).join('')}
    </tbody></table></div>
  </section>`;
}

function summarizeCounts(rowCounts = {}) {
  const entityTypes = ['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'PAYMENT'];
  return entityTypes.reduce((result, entityType) => {
    const counts = rowCounts[entityType] || {};
    result.retrieved += Number(counts.retrieved) || 0;
    result.successful += Number(counts.valid) || 0;
    result.failed += Math.max(0, (Number(counts.retrieved) || 0) - (Number(counts.valid) || 0));
    result.entities.push({ entityType, ...counts });
    return result;
  }, { retrieved: 0, successful: 0, failed: 0, entities: [] });
}

function renderRun(run) {
  const host = document.querySelector('#mock-sap-extraction-status');
  if (!run) {
    host.innerHTML = '<p class="empty-state">No extraction run has been recorded.</p>';
    return;
  }
  const counts = summarizeCounts(run.rowCounts || {});
  const projection = run.rowCounts?.mockProjection || {};
  const projectionRows = Object.entries(projection).map(([entityType, values]) => `
    <tr><td>${escapeHTML(entityType.replaceAll('_', ' '))}</td>
      <td>${escapeHTML(values.inserted ?? values.applied ?? 0)}</td>
      <td>${escapeHTML(values.alreadyPresent ?? 0)}</td>
    </tr>`).join('');
  const entityRows = counts.entities.map(entity => `
    <tr><td>${escapeHTML(entity.entityType.replaceAll('_', ' '))}</td>
      <td>${escapeHTML(entity.retrieved ?? 0)}</td>
      <td>${escapeHTML(entity.valid ?? 0)}</td>
      <td>${escapeHTML(Math.max(0, (Number(entity.retrieved) || 0) - (Number(entity.valid) || 0)))}</td>
      <td>${escapeHTML(entity.complete === true ? 'Complete' : 'Incomplete')}</td>
    </tr>`).join('');
  const issueRows = (run.issues || []).map(issue => `
    <li><span class="chip ${statusClass(issue.severity)}">${escapeHTML(issue.severity)}</span>
      ${escapeHTML(issue.code)} · ${escapeHTML(issue.message)}</li>`).join('');
  host.innerHTML = `<p><span class="chip ${statusClass(run.status)}">${escapeHTML(run.status)}</span>
    ${run.snapshotPromoted ? 'Canonical snapshot promoted.' : 'Canonical snapshot not promoted.'}</p>
    <dl class="mock-sap-run-meta">
      <div><dt>Started</dt><dd>${escapeHTML(dateTime(run.startedAt))}</dd></div>
      <div><dt>Completed</dt><dd>${escapeHTML(dateTime(run.completedAt))}</dd></div>
      <div><dt>Retrieved records</dt><dd>${escapeHTML(counts.retrieved)}</dd></div>
      <div><dt>Successful validation</dt><dd>${escapeHTML(counts.successful)}</dd></div>
      <div><dt>Failed validation</dt><dd>${escapeHTML(counts.failed)}</dd></div>
    </dl>
    <h3>Validation counts</h3>
    <div class="table-wrap"><table><thead><tr><th>Entity</th><th>Retrieved</th><th>Valid</th><th>Failed</th><th>Read complete</th></tr></thead><tbody>${entityRows}</tbody></table></div>
    ${projectionRows ? `<h3>Credit Guard business records</h3>
      <div class="table-wrap"><table><thead><tr><th>Entity</th><th>Added</th><th>Already present</th></tr></thead><tbody>${projectionRows}</tbody></table></div>` : ''}
    <h3>Validation issues</h3>
    ${issueRows ? `<ul class="mock-sap-issues">${issueRows}</ul>` : '<p class="muted">No validation issues were returned.</p>'}`;
}

export function renderMockSap(data, permissions = {}) {
  const source = data.source;
  const entities = data.entities || {};
  const names = customerNames(entities);
  document.querySelector('#mock-sap-source-name').textContent = source.sourceName;
  document.querySelector('#mock-sap-source-id').textContent = source.sourceId;
  document.querySelector('#mock-sap-registration').textContent = data.registered
    ? 'Registered source'
    : 'Built-in source · registers on first extraction';
  document.querySelector('#mock-sap-portfolio-source').textContent = data.portfolioSource === 'abap'
    ? 'Active portfolio source: ABAP (read-only). Mock extraction is stored in local CAP tables; the Simulator monitoring action explicitly analyzes those local records.'
    : 'Active portfolio source: local CAP database. Extracted Mock SAP records are included in Portfolio and Analysis.';
  document.querySelector('#mock-sap-records').innerHTML = [
    renderRecordTable('Customer master', 'CUSTOMER', [
      ['KUNNR', 'Customer ID'], ['NAME1', 'Name'], ['BUKRS', 'Company'], ['LAND1', 'Country'], ['CTLPC', 'Risk class']
    ], entities, names),
    renderRecordTable('Credit accounts', 'CREDIT_ACCOUNT', [
      ['CREDIT_ACCOUNT', 'Account ID'], ['CUSTOMER_NAME', 'Customer'], ['KLIMK', 'Credit limit'], ['WAERS', 'Currency']
    ], entities, names),
    renderRecordTable('Invoices / open items', 'INVOICE', [
      ['BELNR', 'Invoice'], ['CUSTOMER_NAME', 'Customer'], ['DMBTR', 'Outstanding'], ['WAERS', 'Currency'], ['ZFBDT', 'Due date'], ['STATUS', 'Status']
    ], entities, names),
    renderRecordTable('Payments', 'PAYMENT', [
      ['PAYMENT_ID', 'Payment'], ['CUSTOMER_NAME', 'Customer'], ['DMBTR', 'Amount'], ['WAERS', 'Currency'], ['BUDAT', 'Posting date'], ['STATUS', 'Status']
    ], entities, names)
  ].join('');
  renderRun(data.latestRun);
  const extractionButton = document.querySelector('#extract-mock-sap');
  extractionButton.hidden = permissions.canExtract !== true;
  extractionButton.disabled = source.enabled === false;
  document.querySelector('#run-mock-sap-monitoring').hidden = !(
    permissions.canMonitor === true && data.latestRun?.snapshotPromoted === true
  );
}

export function renderMockSapMonitoring(run) {
  const host = document.querySelector('#mock-sap-monitoring-results');
  if (!run) {
    host.innerHTML = '<p class="empty-state">No monitoring result is available yet.</p>';
    return;
  }
  const findings = run.findings || [];
  host.innerHTML = `<p><span class="chip ${statusClass(run.status)}">${escapeHTML(run.status)}</span>
    ${escapeHTML(run.source || 'CAP database')} · completed ${escapeHTML(dateTime(run.completedAt))}</p>
    ${findings.length ? `<div class="table-wrap"><table><thead><tr>
      <th>Customer</th><th>Severity</th><th>Conditions</th><th>Exposure</th><th>Credit limit</th><th>Utilisation</th><th>Overdue</th>
    </tr></thead><tbody>${findings.map(finding => `<tr>
      <td>${escapeHTML(finding.customerName)} (${escapeHTML(finding.customer_ID)})</td>
      <td><span class="chip ${statusClass(finding.severity)}">${escapeHTML(finding.severity)}</span></td>
      <td>${escapeHTML((finding.conditions || []).join(', ').replaceAll('_', ' '))}</td>
      <td>${escapeHTML(formatMoney(finding.exposure, finding.currency))}</td>
      <td>${escapeHTML(formatMoney(finding.creditLimit, finding.currency))}</td>
      <td>${escapeHTML(formatPercent(finding.utilisation))}</td>
      <td>${escapeHTML(formatMoney(finding.overdueAmount, finding.currency))}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">The backend returned no findings for this monitoring run.</p>'}`;
}
