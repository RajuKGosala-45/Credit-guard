const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCapServer, stopCapServer } = require('./support/cap-server');
const {
  generateDataset,
  writeDataset
} = require('../scripts/generate-sap-sim-data');
const {
  SOURCE_ID,
  SOURCE_NAME,
  SOURCE_TYPE,
  SUPPORTED_ENTITIES,
  createMockSapGeneratedConnector,
  getMockSapGeneratedSourceDefinition,
  isSapSimEnabled
} = require('../srv/integrations/mock-sap-generated/connector');

const os = require('node:os');

let server;
let tmpFixtureDir;
let runtimeExpectedPath;

const REQUIRED_CSVS = [
  'BUT000.csv',
  'UKMBP_CMS_SGM.csv',
  'UKM_ITEM.csv',
  'BSID.csv',
  'BSAD.csv',
  'VBAK.csv'
];

function ensureGeneratedDatasetOnDisk() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const outDir = path.join('db', 'sap-sim', 'data');
  tmpFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-sap-gen-test-'));
  runtimeExpectedPath = path.join(tmpFixtureDir, 'expected-results.json');

  const options = {
    seed: 42,
    customers: 300,
    today: todayIso,
    out: outDir,
    expectedOut: runtimeExpectedPath
  };
  const dataset = generateDataset(options);
  writeDataset(options, dataset);
  return todayIso;
}

test.before(async () => {
  const todayIso = ensureGeneratedDatasetOnDisk();
  server = await startCapServer({
    env: {
      CREDIT_GUARD_SAP_SIM_AS_OF_DATE: todayIso
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

test('Mock SAP Generated connector metadata, registration and production safety', async () => {
  const definition = getMockSapGeneratedSourceDefinition();
  assert.equal(definition.sourceId, SOURCE_ID);
  assert.equal(definition.sourceType, SOURCE_TYPE);
  assert.equal(definition.sourceName, SOURCE_NAME);
  assert.deepEqual(definition.supportedEntities, SUPPORTED_ENTITIES);

  const savedNodeEnv = process.env.NODE_ENV;
  const savedCdsEnv = process.env.CDS_ENV;
  const savedFlag = process.env.CREDIT_GUARD_SAP_SIM;

  try {
    delete process.env.NODE_ENV;
    delete process.env.CDS_ENV;
    delete process.env.CREDIT_GUARD_SAP_SIM;
    assert.equal(isSapSimEnabled(), true);

    process.env.NODE_ENV = 'production';
    assert.equal(isSapSimEnabled(), false);

    const connector = createMockSapGeneratedConnector();
    await assert.rejects(async () => {
      await connector.read({ source: {}, config: {}, entityType: 'CUSTOMER' });
    }, { statusCode: 403, category: 'source_disabled_in_production' });

    process.env.CREDIT_GUARD_SAP_SIM = 'true';
    assert.equal(isSapSimEnabled(), true);
  } finally {
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv; else delete process.env.NODE_ENV;
    if (savedCdsEnv !== undefined) process.env.CDS_ENV = savedCdsEnv; else delete process.env.CDS_ENV;
    if (savedFlag !== undefined) process.env.CREDIT_GUARD_SAP_SIM = savedFlag; else delete process.env.CREDIT_GUARD_SAP_SIM;
  }
});

test('Mock SAP Generated API routes enforce role access and synthetic labeling', async () => {
  const unauth = await request('/api/mock-sap-generated', { identity: null });
  assert.equal(unauth.response.status, 401);

  const getResult = await request('/api/mock-sap-generated');
  assert.equal(getResult.response.status, 200);
  assert.equal(getResult.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
  assert.equal(getResult.body.source.sourceId, SOURCE_ID);
  assert.deepEqual(getResult.body.supportedEntities, ['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'SALES_ORDER', 'PAYMENT']);

  const forbidden = await request('/api/mock-sap-generated/extract', {
    identity: 'requester',
    method: 'POST',
    body: {}
  });
  assert.equal(forbidden.response.status, 403);

  const badOptions = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: { path: '/untrusted/data' }
  });
  assert.equal(badOptions.response.status, 400);
  assert.equal(badOptions.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
});

test('Mock SAP Generated extraction ingests 300 BP dataset, persists connector quality issues, and projects atomically without altering demo rows', async () => {
  const initialCustomers = await request('/api/customers');
  assert.equal(initialCustomers.response.status, 200);
  assert.equal(initialCustomers.body.length, 13);

  const extract1 = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });

  assert.equal(extract1.response.status, 200);
  assert.equal(extract1.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
  assert.equal(extract1.body.status, 'SUCCEEDED_WITH_WARNINGS');
  assert.equal(extract1.body.snapshotPromoted, true);

  const counts = extract1.body.rowCounts;
  assert.equal(counts.CUSTOMER.valid, 300);
  assert.equal(counts.CREDIT_ACCOUNT.valid, 300);
  assert.equal(counts.INVOICE.valid, 533);
  assert.equal(counts.SALES_ORDER.valid, 179);
  assert.equal(counts.PAYMENT.valid, 1010);
  assert.equal(counts.complete, true);

  // Verify projection summary in rowCounts
  const proj1 = counts.mockSapGeneratedProjection;
  assert.ok(proj1);
  assert.equal(proj1.CUSTOMER.inserted, 299);
  assert.equal(proj1.CUSTOMER.quarantined, 1);
  assert.equal(proj1.INVOICE.inserted, 530);
  assert.equal(proj1.SALES_ORDER.inserted, 179);
  assert.equal(proj1.OPEN_ITEMS.inserted, 709);
  assert.equal(proj1.PAYMENT.inserted, 1010);
  assert.equal(proj1.CG_PAYMENT_HISTORY.inserted, 1010);
  assert.deepEqual(proj1.quarantinedCustomers, ['0001000009']);

  // Verify persisted quality issues in database
  const issueCodes = extract1.body.issues.map(i => i.code);
  assert.ok(issueCodes.includes('QUARANTINED_MIXED_CURRENCY'));
  assert.ok(issueCodes.includes('EXCLUDED_UNMODELED_CREDIT_MEMO'));
  assert.ok(issueCodes.includes('EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT'));
  assert.ok(issueCodes.includes('DUPLICATE_SOURCE_IDENTITY'));

  // Re-extraction replaces only generated customers' items/payments and preserves demo customers
  const extract2 = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(extract2.response.status, 200);
  const proj2 = extract2.body.rowCounts.mockSapGeneratedProjection;
  assert.equal(proj2.CUSTOMER.inserted, 0);
  assert.equal(proj2.CUSTOMER.alreadyPresent, 299);
  assert.equal(proj2.CUSTOMER.preservedCreditLimitDifferences, 0);
  assert.equal(proj2.OPEN_ITEMS.deletedPrior, 709);
  assert.equal(proj2.OPEN_ITEMS.inserted, 709);
  assert.equal(proj2.PAYMENT.deletedPrior, 1010);
  assert.equal(proj2.PAYMENT.inserted, 1010);
  assert.equal(proj2.CG_PAYMENT_HISTORY.deletedPrior, 1010);
  assert.equal(proj2.CG_PAYMENT_HISTORY.inserted, 1010);

  // Verify all 13 demo customers + 299 generated customers = 312 customers in portfolio
  const afterCustomers = await request('/api/customers');
  assert.equal(afterCustomers.response.status, 200);
  assert.equal(afterCustomers.body.length, 312);

  // Verify all 300 generated customers match the runtime expected-results.json
  const expected = JSON.parse(
    fs.readFileSync(runtimeExpectedPath, 'utf8').replace(/\r\n/g, '\n')
  );
  for (const [partnerId, exp] of Object.entries(expected.allCustomers)) {
    const actual = afterCustomers.body.find(c => c.ID === partnerId);
    if (exp.expectedOutcome === 'REJECTED_MIXED_CURRENCY') {
      assert.equal(actual, undefined, `Quarantined customer ${partnerId} must not be in credit.Customers`);
      continue;
    }
    assert.ok(actual, `Expected customer ${partnerId} to be projected`);
    assert.equal(actual.exposure, exp.exposure, `Exposure mismatch for ${partnerId}`);
    assert.equal(actual.overdueAmount, exp.overdueAmount, `Overdue mismatch for ${partnerId}`);
    assert.equal(actual.status, exp.status, `Status mismatch for ${partnerId}`);
    assert.deepEqual([...actual.flags].sort(), [...exp.flags].sort(), `Flags mismatch for ${partnerId}`);
    if (exp.utilisation === null) {
      assert.equal(actual.utilisation, null);
    } else {
      assert.ok(Math.abs(actual.utilisation - exp.utilisation) < 1e-6);
    }
  }
});
