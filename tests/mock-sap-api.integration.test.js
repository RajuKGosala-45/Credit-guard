const test = require('node:test');
const assert = require('node:assert/strict');
const { startCapServer, stopCapServer } = require('./support/cap-server');

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
  return { response, body: await response.json() };
}

test('Mock SAP API extracts synthetic records, updates portfolio, and returns persisted monitoring findings', async () => {
  const sourceData = await request('/api/mock-sap');
  assert.equal(sourceData.response.status, 200);
  assert.match(sourceData.body.label, /SYNTHETIC MOCK SAP DATA/);
  assert.equal(sourceData.body.portfolioSource, 'local');
  assert.match(sourceData.body.source.sourceName, /Mock SAP Simulator/);
  assert.deepEqual(Object.fromEntries(Object.entries(sourceData.body.entities)
    .map(([type, value]) => [type, value.records.length])), {
    CUSTOMER: 4,
    CREDIT_ACCOUNT: 4,
    INVOICE: 6,
    PAYMENT: 4
  });

  const prematureMonitoring = await request('/api/mock-sap/monitoring', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(prematureMonitoring.response.status, 409);

  const forbidden = await request('/api/mock-sap/extract', {
    identity: 'requester',
    method: 'POST',
    body: {}
  });
  assert.equal(forbidden.response.status, 403);

  const extraction = await request('/api/mock-sap/extract', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(extraction.response.status, 200);
  assert.equal(extraction.body.sourceName, sourceData.body.source.sourceName);
  assert.equal(extraction.body.snapshotPromoted, true);
  assert.equal(extraction.body.rowCounts.mockProjection.CUSTOMER.inserted, 4);
  assert.equal(extraction.body.rowCounts.mockProjection.INVOICE.inserted, 6);
  assert.equal(extraction.body.rowCounts.mockProjection.PAYMENT.inserted, 4);
  const persistedSource = await request('/api/mock-sap');
  assert.equal(persistedSource.body.registered, true);
  assert.equal(persistedSource.body.latestRun.id, extraction.body.id);

  const dashboard = await request('/api/dashboard');
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.kpis.customerCount, 17);
  assert.equal(dashboard.body.exposure.customer.find(row =>
    row.label === 'Meridian Components (Mock)')?.exposure, 1200000);

  const queued = await request('/api/mock-sap/monitoring', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(queued.response.status, 202);
  let monitored = queued.body;
  for (let attempt = 0; attempt < 100 && ['QUEUED', 'RUNNING'].includes(monitored.status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await request(`/api/monitoring/runs/${encodeURIComponent(queued.body.id)}`);
    assert.equal(result.response.status, 200);
    monitored = result.body;
  }
  assert.equal(monitored.status, 'COMPLETED');
  const finding = monitored.findings.find(item => item.customer_ID === 'MS-C001');
  assert.ok(finding);
  assert.ok(finding.conditions.includes('CRITICAL'));
  assert.ok(finding.conditions.includes('OVERDUE_RISK'));
});
