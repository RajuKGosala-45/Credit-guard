const test = require('node:test');
const assert = require('node:assert/strict');
const { startCapServer, stopCapServer } = require('./support/cap-server');
const {
  SOURCE_ID,
  SOURCE_NAME,
  SOURCE_TYPE,
  SUPPORTED_ENTITIES,
  createMockSapGeneratedConnector,
  getMockSapGeneratedSourceDefinition,
  isSapSimEnabled
} = require('../srv/integrations/mock-sap-generated/connector');
const { projectMockSapGeneratedRecords } = require('../srv/integrations/mock-sap-generated/projection');

let server;

test.before(async () => {
  server = await startCapServer();
});

test.after(async () => {
  await stopCapServer(server);
});

async function request(path, { identity = 'reader', method = 'GET', body } = {}) {
  const headers = {};
  if (identity) {
    headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${server.origin}${path}`, {
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

  // Production safety checks
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

  // Extract requires CreditAdmin
  const forbidden = await request('/api/mock-sap-generated/extract', {
    identity: 'requester',
    method: 'POST',
    body: {}
  });
  assert.equal(forbidden.response.status, 403);

  // Extract rejects request options
  const badOptions = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: { path: '/untrusted/data' }
  });
  assert.equal(badOptions.response.status, 400);
  assert.equal(badOptions.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
});

test('Mock SAP Generated extraction ingests 300 BP dataset and identifies duplicate scenario', async () => {
  const extractResult = await request('/api/mock-sap-generated/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });

  assert.equal(extractResult.response.status, 200);
  assert.equal(extractResult.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
  assert.equal(extractResult.body.status, 'SUCCEEDED_WITH_WARNINGS');

  const counts = extractResult.body.rowCounts;
  assert.equal(counts.CUSTOMER.valid, 300);
  assert.equal(counts.CREDIT_ACCOUNT.valid, 300);
  assert.equal(counts.INVOICE.valid, 738);
  assert.equal(counts.SALES_ORDER.valid, 56);
  assert.equal(counts.PAYMENT.valid, 2);
  assert.equal(counts.complete, true);

  // Check quality issues recorded in ingestion issues
  const duplicateIssues = extractResult.body.issues.filter(i => i.code === 'DUPLICATE_SOURCE_IDENTITY');
  assert.equal(duplicateIssues.length, 1);
});
