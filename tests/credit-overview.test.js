const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');

async function loadDashboardModule() {
  const utils = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utils).toString('base64')}`;
  let source = await fs.readFile(path.join(appRoot, 'views', 'dashboard.js'), 'utf8');
  source = source.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

test('evaluateKpiStatus assigns Healthy, Watch, and Action needed chips with threshold rule tooltips', async () => {
  const { evaluateKpiStatus } = await loadDashboardModule();

  // Utilisation thresholds: <60% healthy, 60-80% watch, >80% action
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.45 }).tone, 'healthy');
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.45 }).label, 'Healthy');
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.628 }).tone, 'watch');
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.628 }).label, 'Watch');
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.85 }).tone, 'action');
  assert.equal(evaluateKpiStatus('utilisation', { overallUtilisation: 0.85 }).label, 'Action needed');
  assert.match(evaluateKpiStatus('utilisation', { overallUtilisation: 0.628 }).tooltip, /<60%.*60–80%.*>80%/);

  // Overdue thresholds: 0 healthy, 1-5 watch, >5 action
  assert.equal(evaluateKpiStatus('overdue', { overdueInvoiceCount: 0 }).tone, 'healthy');
  assert.equal(evaluateKpiStatus('overdue', { overdueInvoiceCount: 3 }).tone, 'watch');
  assert.equal(evaluateKpiStatus('overdue', { overdueInvoiceCount: 12 }).tone, 'action');
  assert.match(evaluateKpiStatus('overdue', { overdueInvoiceCount: 12 }).tooltip, /0 overdue.*1–5.*>5/);
});

test('buildPortfolioVerdict auto-generates 1-2 line verdict and matches overall severity', async () => {
  const { buildPortfolioVerdict } = await loadDashboardModule();

  const demoVerdict = buildPortfolioVerdict({
    overallUtilisation: 0.628365,
    overdueInvoiceCount: 12,
    overdueRiskCustomers: 10,
    customersBreached: 3
  });
  assert.equal(demoVerdict.tone, 'action');
  assert.equal(demoVerdict.badgeLabel, 'Action needed');
  assert.equal(
    demoVerdict.text,
    'Action needed: 12 overdue invoices across 10 customers. Utilisation 62.8% (moderate).'
  );

  const watchVerdict = buildPortfolioVerdict({
    overallUtilisation: 0.65,
    overdueInvoiceCount: 2,
    overdueRiskCustomers: 2,
    customersBreached: 0
  });
  assert.equal(watchVerdict.tone, 'watch');
  assert.match(watchVerdict.text, /Watch: 2 overdue invoices across 2 customers\. Utilisation 65\.0% \(moderate\)\./);

  const healthyVerdict = buildPortfolioVerdict({
    overallUtilisation: 0.42,
    overdueInvoiceCount: 0,
    overdueRiskCustomers: 0,
    customersBreached: 0
  });
  assert.equal(healthyVerdict.tone, 'healthy');
  assert.match(healthyVerdict.text, /Utilisation is 42\.0% \(healthy\)\./);
});

test('buildAttentionAlerts derives sorted top alerts and omits pending approvals when count is 0', async () => {
  const { buildAttentionAlerts } = await loadDashboardModule();

  const demoDashboard = {
    kpis: {
      currency: 'INR',
      totalExposure: 6535000,
      totalLimit: 10400000,
      overallUtilisation: 0.628365,
      overdueAmount: 2132500,
      customersBreached: 3,
      criticalCustomers: 1,
      overdueInvoiceCount: 12,
      overdueRiskCustomers: 10
    },
    exposure: {
      country: [
        { label: 'India', currency: 'INR', exposure: 3355000, creditLimit: 4500000, customers: 6, utilisation: 0.745555 }
      ],
      companyCode: [
        { label: 'BS03', currency: 'INR', exposure: 2160000, creditLimit: 2700000, customers: 3, utilisation: 0.8 },
        { label: 'BS01', currency: 'INR', exposure: 1550000, creditLimit: 1900000, customers: 3, utilisation: 0.815789 }
      ]
    }
  };

  // With 0 pending requests
  const alertsWithoutPending = buildAttentionAlerts(demoDashboard, []);
  assert.ok(alertsWithoutPending.length >= 3 && alertsWithoutPending.length <= 5);
  assert.equal(alertsWithoutPending[0].id, 'overdue-concentration');
  assert.equal(alertsWithoutPending[0].targetTab, 'dashboard');
  assert.equal(alertsWithoutPending.some(a => a.id === 'pending-approvals'), false);

  const companyAlert = alertsWithoutPending.find(a => a.id === 'company-code-utilisation');
  assert.ok(companyAlert);
  assert.match(companyAlert.headline, /BS01 81\.6%, BS03 80\.0%/);
  assert.equal(companyAlert.targetTab, 'analysis');

  const countryAlert = alertsWithoutPending.find(a => a.id === 'country-concentration');
  assert.ok(countryAlert);
  assert.match(countryAlert.headline, /India.*74\.6%/);
  assert.equal(countryAlert.targetTab, 'analysis');

  // With 2 pending requests
  const alertsWithPending = buildAttentionAlerts(demoDashboard, [
    { ID: 'r1', status: 'Pending' },
    { ID: 'r2', status: 'Pending' }
  ]);
  const pendingAlert = alertsWithPending.find(a => a.id === 'pending-approvals');
  assert.ok(pendingAlert);
  assert.match(pendingAlert.headline, /Pending limit approvals \(2 requests awaiting decision\)/);
  assert.equal(pendingAlert.targetTab, 'approvals');

  // Healthy portfolio produces 0 alerts
  const healthyAlerts = buildAttentionAlerts({
    kpis: {
      currency: 'INR',
      totalExposure: 1000000,
      totalLimit: 5000000,
      overallUtilisation: 0.2,
      overdueInvoiceCount: 0,
      customersBreached: 0
    },
    exposure: {
      country: [{ label: 'India', exposure: 400000, utilisation: 0.2, customers: 2 }],
      companyCode: [{ label: 'BS01', exposure: 400000, utilisation: 0.2, customers: 2 }]
    }
  }, []);
  assert.equal(healthyAlerts.length, 0);
});

test('renderCreditOverview populates KPI chips, verdict banner, attention cards, and 4 navigation shortcuts', async t => {
  const { renderCreditOverview } = await loadDashboardModule();
  const hosts = {
    '#kpis': { innerHTML: '' },
    '#overview-health-verdict': { innerHTML: '', className: '' },
    '#overview-attention-count': { textContent: '' },
    '#overview-attention-list': { innerHTML: '' },
    '#overview-shortcuts': { innerHTML: '' }
  };

  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: sel => hosts[sel] || null }
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  });

  renderCreditOverview({
    kpis: {
      currency: 'INR',
      totalExposure: 6535000,
      totalLimit: 10400000,
      overallUtilisation: 0.628365,
      overdueAmount: 2132500,
      customersBreached: 3,
      criticalCustomers: 1,
      overdueInvoiceCount: 12,
      overdueRiskCustomers: 10,
      customerCount: 13
    },
    exposure: {
      country: [{ label: 'India', currency: 'INR', exposure: 3355000, customers: 6, utilisation: 0.745555 }],
      companyCode: [{ label: 'BS01', currency: 'INR', exposure: 1550000, customers: 3, utilisation: 0.815789 }]
    }
  }, []);

  assert.match(hosts['#kpis'].innerHTML, /kpi-status-chip--watch/);
  assert.match(hosts['#kpis'].innerHTML, /kpi-status-chip--healthy/);
  assert.match(hosts['#kpis'].innerHTML, /kpi-status-chip--action/);
  assert.match(hosts['#overview-health-verdict'].innerHTML, /Action needed: 12 overdue invoices across 10 customers\. Utilisation 62\.8% \(moderate\)\./);
  assert.match(hosts['#overview-attention-list'].innerHTML, /View in Portfolio &amp; Monitoring/);
  assert.match(hosts['#overview-attention-list'].innerHTML, /View in Exposure Analysis/);
  assert.match(hosts['#overview-shortcuts'].innerHTML, /Portfolio &amp; Monitoring/);
  assert.match(hosts['#overview-shortcuts'].innerHTML, /Exposure Analysis/);
  assert.match(hosts['#overview-shortcuts'].innerHTML, /Limit Approvals/);
  assert.match(hosts['#overview-shortcuts'].innerHTML, /AI Credit Assistance/);
});

async function loadStateModule() {
  const source = await fs.readFile(path.join(appRoot, 'state.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

test('computeFreshnessState evaluates UNKNOWN, FRESH (<=6m), DELAYED (6-15m), STALE (>15m), and FAILED with last good data', async () => {
  const {
    computeFreshnessState,
    formatCountdownClock,
    AUTO_REFRESH_INTERVAL_MS
  } = await loadStateModule();

  assert.equal(AUTO_REFRESH_INTERVAL_MS, 300000);
  const now = new Date('2026-04-06T15:30:00.000Z').getTime();

  // 1. UNKNOWN before first extraction
  const unknownState = computeFreshnessState({
    lastSuccessfulAt: null,
    extractionStatus: 'IDLE',
    nextRunAt: null
  }, now);
  assert.equal(unknownState.status, 'UNKNOWN');
  assert.equal(unknownState.icon, '○');

  // 2. FRESH (just now & 2 min ago & 6 min boundary)
  const freshJustNow = computeFreshnessState({
    lastSuccessfulAt: new Date(now - 10_000).toISOString(),
    extractionStatus: 'SUCCESS',
    nextRunAt: new Date(now + 290_000).toISOString()
  }, now);
  assert.equal(freshJustNow.status, 'FRESH');
  assert.equal(freshJustNow.icon, '✓');
  assert.equal(freshJustNow.relativeText, 'Updated just now');
  assert.equal(freshJustNow.countdownShort, '4:50');

  const freshTwoMin = computeFreshnessState({
    lastSuccessfulAt: new Date(now - 2 * 60_000).toISOString(),
    extractionStatus: 'SUCCESS',
    nextRunAt: new Date(now + 180_000).toISOString()
  }, now);
  assert.equal(freshTwoMin.status, 'FRESH');
  assert.equal(freshTwoMin.relativeText, 'Updated 2 min ago');

  // 3. DELAYED (6 to 15 minutes)
  const delayedTenMin = computeFreshnessState({
    lastSuccessfulAt: new Date(now - 10 * 60_000).toISOString(),
    extractionStatus: 'SUCCESS',
    nextRunAt: new Date(now + 60_000).toISOString()
  }, now);
  assert.equal(delayedTenMin.status, 'DELAYED');
  assert.equal(delayedTenMin.icon, '▲');
  assert.equal(delayedTenMin.relativeText, 'Updated 10 min ago');

  // 4. STALE (> 15 minutes)
  const staleTwentyMin = computeFreshnessState({
    lastSuccessfulAt: new Date(now - 20 * 60_000).toISOString(),
    extractionStatus: 'SUCCESS',
    nextRunAt: new Date(now + 30_000).toISOString()
  }, now);
  assert.equal(staleTwentyMin.status, 'STALE');
  assert.equal(staleTwentyMin.icon, '!');
  assert.equal(staleTwentyMin.relativeText, 'Updated 20 min ago');

  // 5. FAILED shows FAILED badge and "last good data: <time>"
  const failedState = computeFreshnessState({
    lastSuccessfulAt: new Date(now - 5 * 60_000).toISOString(),
    extractionStatus: 'FAILED',
    nextRunAt: new Date(now + 120_000).toISOString()
  }, now);
  assert.equal(failedState.status, 'FAILED');
  assert.equal(failedState.icon, '!');
  assert.match(failedState.relativeText, /^last good data: /);
  assert.match(failedState.tooltip, /Source: CAP database \(demo\)\. Last retrieved: .*\. Auto-refresh every 5 minutes\. Status rules: Fresh <= 6 min, Delayed 6-15 min, Stale > 15 min\./);

  // Countdown formatting
  assert.equal(formatCountdownClock(new Date(now + 300_000).toISOString(), now, false), '5:00');
  assert.equal(formatCountdownClock(new Date(now + 300_000).toISOString(), now, true), '05:00');
});

test('index.html removes legacy static freshness disclaimer and defines shared freshness indicator + auto-run monitoring copy', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'app', 'credit', 'index.html'), 'utf8');
  assert.equal(html.includes('Data freshness is not supplied by this local demo'), false);
  assert.match(html, /id="freshness-indicator"/);
  assert.match(html, /id="freshness-tooltip"/);
  assert.match(html, /Monitoring runs automatically every 5 minutes and can also be started manually by an authorized operator\./);
  assert.match(html, /id="monitoring-autorun"/);
});

