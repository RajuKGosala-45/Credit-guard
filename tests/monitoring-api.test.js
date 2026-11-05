const test = require('node:test');
const assert = require('node:assert/strict');
const { startCapServer, stopCapServer } = require('./support/cap-server');
const { latestMonitoringRun, latestSuccessfulMonitoringRun } = require('../srv/monitoringStore');

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

async function waitForTerminalRun(runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await request(`/api/monitoring/runs/${runId}`);
    if (!['QUEUED', 'RUNNING'].includes(result.body.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Monitoring run ${runId} did not reach a terminal state.`);
}

test('latest monitoring lookups normalize empty single-row results', async () => {
  const emptyDb = { async run() { return []; } };

  assert.equal(await latestMonitoringRun(emptyDb), null);
  assert.equal(await latestSuccessfulMonitoringRun(emptyDb), null);
});

test('monitoring routes enforce reader, operator, and scheduler identities', async () => {
  const anonymousReadPaths = [
    '/api/monitoring/summary',
    '/api/monitoring/runs',
    '/api/monitoring/runs/latest',
    '/api/monitoring/runs/unknown-run',
    '/api/monitoring/runs/unknown-run/findings',
    '/api/monitoring/alerts',
    '/api/monitoring/alerts/unknown-alert'
  ];
  for (const path of anonymousReadPaths) {
    const anonymous = await request(path, { identity: null });
    assert.equal(anonymous.response.status, 401, `${path} must require authentication`);
  }

  const anonymousWritePaths = [
    ['/api/monitoring/runs', {}],
    ['/api/monitoring/jobs/run', { scheduledFor: new Date().toISOString() }],
    ['/api/monitoring/runs/unknown-run/recover', {}],
    ['/api/monitoring/alerts/unknown-alert/acknowledge', {}],
    ['/api/monitoring/alerts/unknown-alert/resolve', {}]
  ];
  for (const [path, body] of anonymousWritePaths) {
    const anonymous = await request(path, { identity: null, method: 'POST', body });
    assert.equal(anonymous.response.status, 401, `${path} must require authentication`);
  }

  const readerRun = await request('/api/monitoring/runs', {
    identity: 'reader',
    method: 'POST',
    body: { role: 'CreditAdmin', user: 'administrator' }
  });
  assert.equal(readerRun.response.status, 403);

  const manual = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(manual.response.status, 202);
  assert.ok(['QUEUED', 'RUNNING'].includes(manual.body.status));
  manual.body = (await waitForTerminalRun(manual.body.id)).body;
  assert.equal(manual.body.status, 'COMPLETED');
  assert.equal(manual.body.summary.customersMonitored, 13);
  assert.equal(manual.body.summary.breachedCustomers, 3);
  assert.equal(manual.body.summary.criticalCustomers, 1);
  assert.equal(manual.body.summary.overdueInvoiceCount, 12);
  assert.equal(manual.body.source, 'CAP database');
  assert.equal(manual.body.freshness, 'UNKNOWN');
  assert.equal(Object.hasOwn(manual.body, 'triggeredBy'), false);

  const readerManualRun = await request(`/api/monitoring/runs/${manual.body.id}`, {
    identity: 'reader'
  });
  assert.equal(readerManualRun.response.status, 200);
  assert.ok(readerManualRun.body.findings.length > 0);
  assert.equal(Object.hasOwn(readerManualRun.body, 'triggeredBy'), false);
  const readerManualFindings = await request(`/api/monitoring/runs/${manual.body.id}/findings`, {
    identity: 'reader'
  });
  assert.equal(readerManualFindings.response.status, 200);
  assert.ok(readerManualFindings.body.length > 0);
  const readerLatest = await request('/api/monitoring/runs/latest', { identity: 'reader' });
  assert.equal(readerLatest.response.status, 200);
  const readerHistory = await request('/api/monitoring/runs', { identity: 'reader' });
  assert.ok(readerHistory.body.some(run => run.id === manual.body.id));

  const blockedJob = await request('/api/monitoring/jobs/run', {
    identity: 'monitor',
    method: 'POST',
    body: { scheduledFor: new Date().toISOString() }
  });
  assert.equal(blockedJob.response.status, 403);

  const adminJob = await request('/api/monitoring/jobs/run', {
    identity: 'administrator',
    method: 'POST',
    body: { scheduledFor: new Date().toISOString() }
  });
  assert.equal(adminJob.response.status, 403);

  const readerRecovery = await request(`/api/monitoring/runs/${manual.body.id}/recover`, {
    identity: 'reader',
    method: 'POST',
    body: { role: 'CreditMonitor', user: 'monitor' }
  });
  assert.equal(readerRecovery.response.status, 403);
  const operatorRecovery = await request(`/api/monitoring/runs/${manual.body.id}/recover`, {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(operatorRecovery.response.status, 409);
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

  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);
  assert.equal(second.body.duplicate, true);
  assert.equal(first.body.id, second.body.id);
  const history = await request('/api/monitoring/runs');
  assert.equal(history.response.status, 200);
  assert.equal(history.body.filter(run => run.id === first.body.id).length, 1);
  assert.equal(Object.hasOwn(first.body, 'triggeredBy'), false);
  const readerDetails = await request(`/api/monitoring/runs/${first.body.id}`, { identity: 'reader' });
  assert.equal(readerDetails.response.status, 200);
  assert.equal(Object.hasOwn(readerDetails.body, 'triggeredBy'), false);
});

test('monitoring findings and alerts are persisted, deduplicated, and auditable', async () => {
  const before = await request('/api/monitoring/alerts');
  const first = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(first.response.status, 202);
  first.body = (await waitForTerminalRun(first.body.id)).body;
  const firstAlerts = await request('/api/monitoring/alerts');
  assert.ok(firstAlerts.body.length > 0);
  const alertConditions = new Set(firstAlerts.body.map(alert => alert.conditionKey));
  for (const condition of ['WARNING', 'BREACH', 'CRITICAL', 'OVERDUE_RISK']) {
    assert.ok(alertConditions.has(condition), `expected a ${condition} alert`);
  }

  const details = await request(`/api/monitoring/runs/${first.body.id}`, { identity: 'monitor' });
  assert.equal(details.response.status, 200);
  assert.ok(details.body.findings.length > 0);
  assert.equal(Object.hasOwn(details.body, 'triggeredBy'), false);
  const portfolioSummary = await request('/api/monitoring/summary', { identity: 'reader' });
  assert.ok(portfolioSummary.body.latestRun.findings.length > 0);
  assert.equal(Object.hasOwn(portfolioSummary.body.latestRun, 'triggeredBy'), false);
  const sharedDetails = await request(`/api/monitoring/runs/${first.body.id}`, { identity: 'reader' });
  assert.equal(sharedDetails.response.status, 200);
  assert.ok(sharedDetails.body.findings.length > 0);
  const dashboardFindings = await request(`/api/monitoring/runs/${first.body.id}/findings`, { identity: 'reader' });
  assert.equal(dashboardFindings.response.status, 200);
  assert.ok(dashboardFindings.body.length > 0);
  const alertDetails = await request(`/api/monitoring/alerts/${firstAlerts.body[0].ID}`, {
    identity: 'reader'
  });
  assert.equal(alertDetails.response.status, 200);

  const second = await request('/api/monitoring/runs', {
    identity: 'monitor',
    method: 'POST'
  });
  assert.equal(second.response.status, 202);
  second.body = (await waitForTerminalRun(second.body.id)).body;
  const after = await request('/api/monitoring/alerts');
  assert.equal(second.response.status, 202);
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
    identity: 'administrator',
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

  const readerAcknowledge = await request('/api/monitoring/alerts/unknown-alert/acknowledge', {
    identity: 'reader',
    method: 'POST'
  });
  assert.equal(readerAcknowledge.response.status, 403);
  const readerResolve = await request('/api/monitoring/alerts/unknown-alert/resolve', {
    identity: 'reader',
    method: 'POST'
  });
  assert.equal(readerResolve.response.status, 403);
});

test('monitoring does not create, approve, or change credit requests', async () => {
  const requestsBefore = await request('/api/limit-requests?status=Pending');
  await request('/api/monitoring/runs', { identity: 'monitor', method: 'POST' });
  const requestsAfter = await request('/api/limit-requests?status=Pending');
  assert.deepEqual(requestsAfter.body, requestsBefore.body);
});
