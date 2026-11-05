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

async function request(path, { identity = 'administrator', method = 'GET', body } = {}) {
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
  catch { responseBody = null; }
  return { status: response.status, body: responseBody };
}

const source = {
  sourceId: 'approved-rest',
  sourceName: 'Approved REST registry entry',
  sourceType: 'REST_API',
  enabled: true,
  supportedEntities: ['CUSTOMER'],
  mappingVersion: 'v1',
  authenticationReference: 'credential:credit-api',
  configurationReference: 'config:credit-api'
};

test('source registry routes require CreditAdmin and persist metadata references only', async () => {
  const denied = await request('/api/ingestion/sources', { identity: 'reader' });
  assert.equal(denied.status, 403);

  const created = await request('/api/ingestion/sources', { method: 'POST', body: source });
  assert.equal(created.status, 201);
  assert.equal(created.body.sourceId, source.sourceId);
  assert.equal(created.body.authenticationReference, source.authenticationReference);
  assert.equal(JSON.stringify(created.body).includes('token'), false);

  const listed = await request('/api/ingestion/sources');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].configurationReference, source.configurationReference);

  const disabled = await request(`/api/ingestion/sources/${source.sourceId}`, {
    method: 'PUT',
    body: { enabled: false }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.enabled, false);

  const disabledCredential = await request('/api/ingestion/sources', {
    method: 'POST',
    body: { ...source, sourceId: 'secret-attempt', apiKey: 'must-not-be-accepted' }
  });
  assert.equal(disabledCredential.status, 400);
});

test('ingestion status is readable and unconfigured sources create explicit failed audit runs', async () => {
  const created = await request('/api/ingestion/sources', {
    method: 'POST',
    body: { ...source, sourceId: 'status-source' }
  });
  assert.equal(created.status, 201);

  const denied = await request('/api/ingestion/sources/status-source/status', { identity: null });
  assert.equal(denied.status, 401);

  const status = await request('/api/ingestion/sources/status-source/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.sourceId, 'status-source');
  assert.equal(status.body.entities[0].entityType, 'CUSTOMER');
  assert.equal(status.body.entities[0].latestRun, undefined);

  const deniedRun = await request('/api/ingestion/sources/status-source/runs', {
    identity: 'reader',
    method: 'POST',
    body: { entityTypes: ['CUSTOMER'] }
  });
  assert.equal(deniedRun.status, 403);

  const unavailable = await request('/api/ingestion/sources/status-source/runs', {
    method: 'POST',
    body: { entityTypes: ['CUSTOMER'] }
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.errorCategory, 'source_configuration_unavailable');
  assert.ok(unavailable.body.runId);
  const failedRun = await request(`/api/ingestion/runs/${unavailable.body.runId}`);
  assert.equal(failedRun.status, 200);
  assert.equal(failedRun.body.status, 'FAILED');

  const invalid = await request('/api/ingestion/sources/status-source/runs', {
    method: 'POST',
    body: { entityTypes: ['CUSTOMER'], endpoint: 'https://untrusted.example' }
  });
  assert.equal(invalid.status, 400);
});
