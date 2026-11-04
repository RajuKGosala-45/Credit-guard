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
  if (identity) headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${server.origin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); }
  catch { result = text; }
  return { response, body: result };
}

test('monitoring routes enforce reader, operator, and scheduler identities', async () => {
  const anonymous = await request('/api/monitoring/summary', { identity: null });
  assert.equal(anonymous.response.status, 401);

  const readerRun = await request('/api/monitoring/runs', {
    identity: 'reader',
    method: 'POST'
  });
  assert.equal(readerRun.response.status, 403);

  const manual = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(manual.response.status, 200);
  assert.equal(manual.body.status, 'COMPLETED');
  assert.equal(manual.body.summary.customersMonitored, 12);
  assert.equal(manual.body.summary.breachedCustomers, 2);
  assert.equal(manual.body.source, 'CAP database');
  assert.equal(manual.body.freshness, 'UNKNOWN');

  const blockedJob = await request('/api/monitoring/jobs/run', {
    identity: 'monitor',
    method: 'POST',
    body: { scheduledFor: new Date().toISOString() }
  });
  assert.equal(blockedJob.response.status, 403);
});

test('scheduled executions are idempotent and preserve the first persisted result', async () => {
  const scheduledFor = new Date(Date.now() - 60_000).toISOString();
  const body = { scheduledFor };
  const first = await request('/api/monitoring/jobs/run', {
    identity: 'jobScheduler',
    method: 'POST',
    body
  });
  const second = await request('/api/monitoring/jobs/run', {
    identity: 'jobScheduler',
    method: 'POST',
    body
  });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(first.body.id, second.body.id);
  const history = await request('/api/monitoring/runs');
  assert.equal(history.response.status, 200);
  assert.equal(history.body.filter(run => run.id === first.body.id).length, 1);
});

test('monitoring findings and alerts are persisted, deduplicated, and auditable', async () => {
  const before = await request('/api/monitoring/alerts');
  const first = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  const firstAlerts = await request('/api/monitoring/alerts');
  assert.ok(firstAlerts.body.length > 0);

  const details = await request(`/api/monitoring/runs/${first.body.id}`, { identity: 'monitor' });
  assert.equal(details.response.status, 200);
  assert.ok(details.body.findings.length > 0);
  assert.equal(Object.hasOwn(details.body, 'triggeredBy'), false);
  const portfolioSummary = await request('/api/monitoring/summary', { identity: 'reader' });
  assert.ok(portfolioSummary.body.latestRun.findings.length > 0);
  const nonOwnerDetails = await request(`/api/monitoring/runs/${first.body.id}`, { identity: 'reader' });
  assert.equal(nonOwnerDetails.response.status, 403);
  const dashboardFindings = await request(`/api/monitoring/runs/${first.body.id}/findings`, { identity: 'monitor' });
  assert.equal(dashboardFindings.response.status, 200);
  assert.ok(dashboardFindings.body.length > 0);
  const nonOwnerFindings = await request(`/api/monitoring/runs/${first.body.id}/findings`, { identity: 'reader' });
  assert.equal(nonOwnerFindings.response.status, 403);

  const second = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  const after = await request('/api/monitoring/alerts');
  assert.equal(second.response.status, 200);
  assert.equal(after.body.length, firstAlerts.body.length);
  assert.equal(new Set(after.body.map(alert => `${alert.customer_ID}:${alert.conditionKey}`)).size, after.body.length);
  assert.ok(before.body.length <= after.body.length);

  const target = after.body[0];
  const forbidden = await request(`/api/monitoring/alerts/${target.ID}/acknowledge`, {
    identity: 'reader',
    method: 'POST'
  });
  assert.equal(forbidden.response.status, 403);

  const acknowledged = await request(`/api/monitoring/alerts/${target.ID}/acknowledge`, {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.body.status, 'ACKNOWLEDGED');
  const activeAfterAcknowledgement = await request('/api/monitoring/alerts');
  assert.ok(activeAfterAcknowledgement.body.some(alert => alert.ID === target.ID));

  const audit = await request(`/api/monitoring/alerts/${target.ID}`);
  assert.ok(audit.body.events.some(event => event.eventType === 'CREATED'));
  assert.ok(audit.body.events.some(event => event.eventType === 'ACKNOWLEDGED'));

  const resolved = await request(`/api/monitoring/alerts/${target.ID}/resolve`, {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.status, 'RESOLVED');
  const activeAfterResolution = await request('/api/monitoring/alerts');
  assert.equal(activeAfterResolution.body.some(alert => alert.ID === target.ID), false);
});

test('monitoring rejects malformed job slots and invalid alert status filters', async () => {
  const malformed = await request('/api/monitoring/jobs/run', {
    identity: 'jobScheduler',
    method: 'POST',
    body: { scheduledFor: 'not-a-date', extra: true }
  });
  assert.equal(malformed.response.status, 400);

  const alerts = await request('/api/monitoring/alerts?status=UNKNOWN');
  assert.equal(alerts.response.status, 400);
});

test('monitoring does not create, approve, or change credit requests', async () => {
  const requestsBefore = await request('/api/limit-requests?status=Pending');
  await request('/api/monitoring/runs', { identity: 'monitor', method: 'POST' });
  const requestsAfter = await request('/api/limit-requests?status=Pending');
  assert.deepEqual(requestsAfter.body, requestsBefore.body);
});
