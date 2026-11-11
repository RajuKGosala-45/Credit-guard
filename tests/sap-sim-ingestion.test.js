const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { startCapServer, stopCapServer } = require('./support/cap-server');
const {
  generateDataset,
  writeDataset
} = require('../scripts/generate-sap-sim-data');
const { classifyCustomer } = require('../srv/rules');
const { createConfiguredConnectors } = require('../srv/configuredConnectors');
const {
  SOURCE_ID,
  createMockSapGeneratedConnector,
  isSapSimEnabled
} = require('../srv/integrations/mock-sap-generated/connector');

const os = require('node:os');

let server;
let runtimeTodayIso;
let expectedResults;
let tmpFixtureDir;

function normalizeLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function ensureDatasetForCurrentUtcDate() {
  runtimeTodayIso = new Date().toISOString().slice(0, 10);
  const outDir = path.join('db', 'sap-sim', 'data');
  tmpFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-sim-ingest-test-'));
  const expectedOut = path.join(tmpFixtureDir, 'expected-results.json');

  const options = {
    seed: 42,
    customers: 300,
    today: runtimeTodayIso,
    out: outDir,
    expectedOut
  };
  writeDataset(options, generateDataset(options));
  expectedResults = JSON.parse(normalizeLf(fs.readFileSync(expectedOut, 'utf8')));
}

test.before(async () => {
  ensureDatasetForCurrentUtcDate();
  server = await startCapServer({
    env: {
      CREDIT_GUARD_SAP_SIM_AS_OF_DATE: runtimeTodayIso
    }
  });
});

test.after(async () => {
  await stopCapServer(server);
  if (tmpFixtureDir) {
    fs.rmSync(tmpFixtureDir, { recursive: true, force: true });
  }
});

async function request(reqPath, { identity = 'reader', method = 'GET', body } = {}) {
  const headers = {};
  if (identity) {
    headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${server.origin}${reqPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let responseBody;
  try { responseBody = text ? JSON.parse(text) : null; }
  catch { responseBody = text; }
  return { response, body: responseBody };
}

test('Extraction, projection, and monitoring comparison across all 300 generated customers and 13 demo customers', async () => {
  // 1. Capture initial 13 demo customers before extraction
  const beforeCustomersRes = await request('/api/customers');
  assert.equal(beforeCustomersRes.response.status, 200);
  const initialDemoCustomers = beforeCustomersRes.body;
  assert.equal(initialDemoCustomers.length, 13);
  assert.deepEqual(
    initialDemoCustomers.map(c => c.ID).sort(),
    ['C001', 'C002', 'C003', 'C004', 'C005', 'C006', 'C007', 'C008', 'C009', 'C010', 'C011', 'C012', 'C013']
  );

  // 2. Run first extraction
  const extract1 = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(extract1.response.status, 200);
  assert.equal(extract1.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
  assert.equal(extract1.body.status, 'SUCCEEDED_WITH_WARNINGS');
  assert.equal(extract1.body.snapshotPromoted, true);

  // 3. Verify quality issues persisted in database
  // - Mixed-currency customer quarantined without failing the run
  // - Credit memo (DG) and payment on account (DZ) excluded with persisted quality issues
  // - Identical duplicate rows counted once and recorded as DUPLICATE_SOURCE_IDENTITY
  const issues = extract1.body.issues;
  const byCode = code => issues.filter(i => i.code === code);
  assert.equal(byCode('QUARANTINED_MIXED_CURRENCY').length, 1);
  assert.equal(byCode('QUARANTINED_MIXED_CURRENCY')[0].sourceRecordId, '0001000009');
  assert.equal(byCode('EXCLUDED_UNMODELED_CREDIT_MEMO').length, 1);
  assert.equal(byCode('EXCLUDED_UNMODELED_CREDIT_MEMO')[0].sourceRecordId, '100015');
  assert.equal(byCode('EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT').length, 1);
  assert.equal(byCode('EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT')[0].sourceRecordId, '100016');
  assert.equal(byCode('DUPLICATE_SOURCE_IDENTITY').length, 1);

  // 4. Verify projection counts and SalesOrder vs Invoice separation
  const proj1 = extract1.body.rowCounts.mockSapGeneratedProjection;
  assert.equal(proj1.CUSTOMER.inserted, 299);
  assert.equal(proj1.CUSTOMER.quarantined, 1);
  assert.equal(proj1.INVOICE.inserted, 530);
  assert.equal(proj1.SALES_ORDER.inserted, 179);
  assert.equal(proj1.OPEN_ITEMS.inserted, 709);
  assert.equal(proj1.PAYMENT.inserted, 1010);
  assert.equal(proj1.CG_PAYMENT_HISTORY.inserted, 1010);

  // Inspect customer 0001000014 (OPEN_SALES_ORDERS_COMM_TYP) detail to verify open sales orders are SalesOrder and never Invoice
  const soCustomerRes = await request('/api/customers/0001000014');
  assert.equal(soCustomerRes.response.status, 200);
  const soOpenItems = soCustomerRes.body.openItems;
  assert.equal(soOpenItems.length, 2);
  const soItem = soOpenItems.find(item => Number(item.amount) === 250000);
  const invItem = soOpenItems.find(item => Number(item.amount) === 150000);
  assert.ok(soItem);
  assert.equal(soItem.type, 'SalesOrder');
  assert.ok(invItem);
  assert.equal(invItem.type, 'Invoice');

  // Verify Scenario 13 (0001000013 IDENTICAL_DUPLICATE_ROWS) counted duplicate invoice once
  const dupCustomerRes = await request('/api/customers/0001000013');
  assert.equal(dupCustomerRes.response.status, 200);
  assert.equal(dupCustomerRes.body.openItems.length, 1);
  assert.equal(dupCustomerRes.body.exposure, 250000);

  // 5. Compare ALL 300 generated customers against expected-results.json
  const afterCustomersRes = await request('/api/customers');
  assert.equal(afterCustomersRes.response.status, 200);
  const allPortfolioCustomers = afterCustomersRes.body;
  assert.equal(allPortfolioCustomers.length, 312); // 13 demo + 299 generated

  const pinnedNow = new Date(`${runtimeTodayIso}T00:00:00.000Z`);

  for (const [partnerId, exp] of Object.entries(expectedResults.allCustomers)) {
    const actual = allPortfolioCustomers.find(c => c.ID === partnerId);
    if (exp.expectedOutcome === 'REJECTED_MIXED_CURRENCY') {
      assert.equal(actual, undefined, `Quarantined mixed-currency customer ${partnerId} must not be projected`);
      continue;
    }
    assert.ok(actual, `Generated customer ${partnerId} missing from portfolio`);
    assert.equal(actual.exposure, exp.exposure, `Exposure mismatch on ${partnerId}`);
    assert.equal(actual.overdueAmount, exp.overdueAmount, `Overdue amount mismatch on ${partnerId}`);
    assert.equal(actual.status, exp.status, `Status mismatch on ${partnerId}`);
    assert.deepEqual([...actual.flags].sort(), [...exp.flags].sort(), `Flags mismatch on ${partnerId}`);
    if (exp.utilisation === null) {
      assert.equal(actual.utilisation, null);
    } else {
      assert.ok(Math.abs(actual.utilisation - exp.utilisation) < 1e-6, `Utilisation mismatch on ${partnerId}`);
    }
  }

  // 6. Explicitly verify 80%, 100%, and 120% scenario customers match rules.js classifyCustomer with pinned date
  for (const [partnerId, expectedStatus, expectedFlags, expectedUtil] of [
    ['0001000001', 'WARNING', ['WARNING'], 0.8],
    ['0001000002', 'BREACH', ['BREACH'], 1.0],
    ['0001000003', 'BREACH', ['BREACH', 'CRITICAL'], 1.2]
  ]) {
    const detail = await request(`/api/customers/${partnerId}`);
    assert.equal(detail.response.status, 200);
    const directRuleEval = classifyCustomer(detail.body, detail.body.openItems, pinnedNow);
    assert.equal(detail.body.status, expectedStatus);
    assert.equal(directRuleEval.status, expectedStatus);
    assert.deepEqual([...detail.body.flags].sort(), [...expectedFlags].sort());
    assert.deepEqual([...directRuleEval.flags].sort(), [...expectedFlags].sort());
    assert.ok(Math.abs(detail.body.utilisation - expectedUtil) < 1e-6);
  }

  // 7. Re-extraction does not duplicate rows or alter the 13 demo customers
  const extract2 = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(extract2.response.status, 200);
  const proj2 = extract2.body.rowCounts.mockSapGeneratedProjection;
  assert.equal(proj2.CUSTOMER.inserted, 0);
  assert.equal(proj2.CUSTOMER.alreadyPresent, 299);
  assert.equal(proj2.OPEN_ITEMS.deletedPrior, 709);
  assert.equal(proj2.OPEN_ITEMS.inserted, 709);
  assert.equal(proj2.PAYMENT.deletedPrior, 1010);
  assert.equal(proj2.PAYMENT.inserted, 1010);
  assert.equal(proj2.CG_PAYMENT_HISTORY.deletedPrior, 1010);
  assert.equal(proj2.CG_PAYMENT_HISTORY.inserted, 1010);

  const afterReExtractCustomers = await request('/api/customers');
  assert.equal(afterReExtractCustomers.body.length, 312);
  const demoAfterReExtract = afterReExtractCustomers.body.filter(c => /^C\d{3}$/.test(c.ID));
  assert.deepEqual(demoAfterReExtract, initialDemoCustomers);
});

test('Production gate returns 403 and does not register the connector when NODE_ENV/CDS_ENV is production without CREDIT_GUARD_SAP_SIM=true', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCdsEnv = process.env.CDS_ENV;
  const savedFlag = process.env.CREDIT_GUARD_SAP_SIM;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.CDS_ENV;
    delete process.env.CREDIT_GUARD_SAP_SIM;

    assert.equal(isSapSimEnabled(), false);

    // Connector registration check in configuredConnectors
    const adapters = createConfiguredConnectors({});
    assert.equal(adapters.some(a => a.sourceType === 'MOCK_SAP_GENERATED'), false);

    // Connector read() throws 403
    const connector = createMockSapGeneratedConnector();
    await assert.rejects(async () => {
      await connector.read({ source: { sourceId: SOURCE_ID }, config: {}, entityType: 'CUSTOMER' });
    }, { statusCode: 403, category: 'source_disabled_in_production' });

    // CDS_ENV = production check
    delete process.env.NODE_ENV;
    process.env.CDS_ENV = 'production';
    assert.equal(isSapSimEnabled(), false);
    const adaptersCdsProd = createConfiguredConnectors({});
    assert.equal(adaptersCdsProd.some(a => a.sourceType === 'MOCK_SAP_GENERATED'), false);

    // Explicit opt-in with CREDIT_GUARD_SAP_SIM=true enables registration
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GUARD_SAP_SIM = 'true';
    assert.equal(isSapSimEnabled(), true);
    const adaptersOptIn = createConfiguredConnectors({});
    assert.equal(adaptersOptIn.some(a => a.sourceType === 'MOCK_SAP_GENERATED'), true);
  } finally {
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv; else delete process.env.NODE_ENV;
    if (savedCdsEnv !== undefined) process.env.CDS_ENV = savedCdsEnv; else delete process.env.CDS_ENV;
    if (savedFlag !== undefined) process.env.CREDIT_GUARD_SAP_SIM = savedFlag; else delete process.env.CREDIT_GUARD_SAP_SIM;
  }

  // Verify HTTP routes return 403 when server runs with NODE_ENV=production and no CREDIT_GUARD_SAP_SIM
  const os = require('node:os');
  const cdsModulePath = require.resolve('@sap/cds');
  const hookPath = path.join(os.tmpdir(), `sap-sim-prod-hook-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(
    hookPath,
    `const cds = require(${JSON.stringify(cdsModulePath)}); cds.on('listening', () => { process.env.NODE_ENV = 'production'; });\n`,
    'utf8'
  );
  const prodServer = await startCapServer({
    env: {
      NODE_OPTIONS: `--require ${JSON.stringify(hookPath)}`,
      CREDIT_GUARD_SAP_SIM: ''
    }
  });
  try {
    const authHeader = {
      authorization: `Basic ${Buffer.from('administrator:test').toString('base64')}`,
      'content-type': 'application/json'
    };
    const getRes = await fetch(`${prodServer.origin}/api/mock-sap-generated`, { headers: authHeader });
    assert.equal(getRes.status, 403);
    const getBody = await getRes.json();
    assert.equal(getBody.label, 'SYNTHETIC - NOT REAL SAP DATA');

    const postRes = await fetch(`${prodServer.origin}/api/mock-sap-generated/extract`, {
      method: 'POST',
      headers: authHeader,
      body: '{}'
    });
    assert.equal(postRes.status, 403);
    const postBody = await postRes.json();
    assert.equal(postBody.label, 'SYNTHETIC - NOT REAL SAP DATA');
  } finally {
    await stopCapServer(prodServer);
    fs.rmSync(hookPath, { force: true });
  }
});
