const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startCapServer, stopCapServer } = require('./support/cap-server');

let server;

test.before(async () => {
  server = await startCapServer();
});

test.after(async () => {
  await stopCapServer(server);
});

async function request(path, options) {
  const identity = options?.identity === undefined ? 'requester' : options.identity;
  const fetchOptions = { ...options };
  delete fetchOptions.identity;
  fetchOptions.headers = { ...fetchOptions.headers };
  if (identity) {
    fetchOptions.headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  }
  const response = await fetch(`${server.origin}${path}`, fetchOptions);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = text; }
  return { response, body };
}

function postJson(path, body, identity = 'requester', idempotencyKey = randomUUID()) {
  const headers = { 'content-type': 'application/json' };
  if (path === '/api/limit-requests' && idempotencyKey !== null) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    identity
  });
}

async function requestFrom(serverInstance, path, identity, options = {}) {
  const headers = { ...options.headers };
  if (identity) {
    headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  }
  const response = await fetch(`${serverInstance.origin}${path}`, { ...options, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = text; }
  return { response, body };
}

test('dashboard API returns the established KPI and exposure contract', async () => {
  const { response, body } = await request('/api/dashboard');

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['exposure', 'kpis']);
  assert.deepEqual(Object.keys(body.kpis).sort(), [
    'availableCredit',
    'criticalCustomers',
    'currency',
    'customerCount',
    'customersBreached',
    'healthyCustomers',
    'manualReviewCustomers',
    'overallUtilisation',
    'overdueAmount',
    'overdueInvoiceCount',
    'overdueRiskCustomers',
    'totalExposure',
    'totalLimit',
    'warningCustomers'
  ]);
  assert.equal(body.kpis.totalExposure, 6_535_000);
  assert.equal(body.kpis.totalLimit, 10_400_000);
  assert.equal(body.kpis.availableCredit, '3865000.00');
  assert.equal(body.kpis.customerCount, 13);
  assert.equal(body.kpis.customersBreached, 3);
  assert.equal(body.kpis.warningCustomers, 3);
  assert.equal(body.kpis.criticalCustomers, 1);
  assert.equal(body.kpis.overdueInvoiceCount, 12);
  assert.ok(Math.abs(body.kpis.overallUtilisation - (6_535_000 / 10_400_000)) < 1e-12);

  for (const group of ['country', 'companyCode', 'customer']) {
    assert.ok(Array.isArray(body.exposure[group]));
    assert.equal(
      body.exposure[group].reduce((sum, row) => sum + row.exposure, 0),
      body.kpis.totalExposure
    );
    assert.ok(body.exposure[group].every(row =>
      Number.isFinite(row.exposure)
      && Number.isFinite(row.creditLimit)
      && Number.isInteger(row.customers)
    ));
  }
});

test('health endpoints are unauthenticated and report application readiness', async () => {
  const live = await request('/health/live', { identity: null });
  assert.equal(live.response.status, 200);
  assert.deepEqual(live.body, { status: 'live' });

  const ready = await request('/health/ready', { identity: null });
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body, { status: 'ready' });
});

test('session capabilities reflect authenticated roles used by the demo UI', async () => {
  const anonymous = await request('/api/session', { identity: null });
  assert.equal(anonymous.response.status, 401);

  const reader = await request('/api/session', { identity: 'reader' });
  assert.equal(reader.response.status, 200);
  assert.equal(reader.body.userId, 'reader');
  assert.deepEqual(reader.body.permissions, {
    canExtract: false,
    canRequest: false,
    canApproveController: false,
    canApproveFinance: false,
    canMonitor: false
  });

  const controller = await request('/api/session', { identity: 'controller' });
  assert.equal(controller.body.permissions.canRequest, true);
  assert.equal(controller.body.permissions.canApproveController, true);
  assert.equal(controller.body.permissions.canApproveFinance, false);

  const finance = await request('/api/session', { identity: 'finance' });
  assert.equal(finance.body.permissions.canApproveFinance, true);
  assert.equal(finance.body.permissions.canMonitor, false);

  const monitor = await request('/api/session', { identity: 'monitor' });
  assert.equal(monitor.body.permissions.canRequest, false);
  assert.equal(monitor.body.permissions.canMonitor, true);
});

test('SAP read-only mode reports unavailable workflow capabilities and blocks direct submissions', async t => {
  const abapServer = await startCapServer({
    env: { CREDIT_GUARD_AGENT_DATA_SOURCE: 'abap' },
    probePath: '/api/session'
  });
  t.after(() => stopCapServer(abapServer));

  const session = await requestFrom(abapServer, '/api/session', 'requester');
  assert.equal(session.response.status, 200);
  assert.equal(session.body.creditLimitWorkflow, 'READ_ONLY');
  assert.equal(session.body.permissions.canRequest, false);
  assert.equal(session.body.permissions.canApproveController, false);
  assert.equal(session.body.permissions.canApproveFinance, false);

  const blocked = await requestFrom(abapServer, '/api/limit-requests', 'requester', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID()
    },
    body: JSON.stringify({
      customerId: 'C001',
      requestedLimit: 1_100_000,
      reason: 'Must not become an SAP limit change'
    })
  });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /read-only mode/i);

  const unauthorized = await requestFrom(abapServer, '/api/limit-requests', 'reader', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID()
    },
    body: JSON.stringify({
      customerId: 'C001',
      requestedLimit: 1_100_000,
      reason: 'Reader remains unauthorized'
    })
  });
  assert.equal(unauthorized.response.status, 403);

  const requests = await requestFrom(abapServer, '/api/limit-requests', 'reader');
  assert.equal(requests.response.status, 200);
  const monitoring = await requestFrom(abapServer, '/api/monitoring/summary', 'reader');
  assert.equal(monitoring.response.status, 200);
});

test('customer APIs return calculated summaries, details, and a 404 for unknown IDs', async () => {
  const list = await request('/api/customers');
  assert.equal(list.response.status, 200);
  assert.equal(list.body.length, 13);

  const customer = list.body.find(row => row.ID === 'C001');
  assert.ok(customer);
  assert.equal(customer.exposure, 1_200_000);
  assert.equal(customer.overdueAmount, 200_000);
  assert.equal(customer.utilisation, 1.2);
  assert.equal(customer.utilisationPercent, 120);
  assert.equal(customer.status, 'BREACH');
  assert.equal(customer.flags.includes('CRITICAL'), true);

  const detail = await request('/api/customers/C001');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.ID, 'C001');
  assert.equal(detail.body.openItems.length, 3);
  assert.equal(detail.body.openItems.find(item => item.ID === 'I001').isOverdue, true);

  const paymentHistory = await request('/api/customers/C001/payments');
  assert.equal(paymentHistory.response.status, 200);
  assert.equal(paymentHistory.body.length, 1);
  assert.equal(paymentHistory.body[0].reference, 'PAY-2026-1001');
  assert.equal(paymentHistory.body[0].currency, 'INR');

  const noPayments = await request('/api/customers/NO-SUCH-CUSTOMER/payments');
  assert.equal(noPayments.response.status, 404);

  const missing = await request('/api/customers/NO-SUCH-CUSTOMER');
  assert.equal(missing.response.status, 404);
  assert.match(missing.body.error, /was not found/i);
});

test('offline assistant grounds portfolio analysis in monitoring findings and prepares human-reviewed proposals', async () => {
  const beforeRun = await postJson('/api/chat', {
    message: 'Analyze the latest monitoring run and explain the high-risk customers.'
  });
  assert.equal(beforeRun.response.status, 200);
  assert.match(beforeRun.body.reply, /No monitoring run is available/i);
  assert.match(beforeRun.body.reply, /No monitoring results were invented/i);

  const started = await postJson('/api/monitoring/runs', {}, 'monitor');
  assert.equal(started.response.status, 202);
  let run = started.body;
  for (let attempt = 0; attempt < 200 && ['QUEUED', 'RUNNING'].includes(run.status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const response = await request(`/api/monitoring/runs/${run.id}`);
    run = response.body;
  }
  assert.equal(run.status, 'COMPLETED');

  const analysis = await postJson('/api/chat', {
    message: 'Analyze the latest monitoring run and explain the high-risk customers.'
  });
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.body.offline, true);
  assert.match(analysis.body.reply, /Northstar Components \(C013\)/);
  assert.match(analysis.body.reply, /Aarav Components \(C001\)/);
  assert.match(analysis.body.reply, /C001\): CRITICAL/);
  assert.match(analysis.body.reply, /C013\): HIGH/);
  assert.match(analysis.body.reply, /13 customers/);
  assert.match(analysis.body.reply, /12 overdue invoices/);
  assert.match(analysis.body.reply, /available 3865000\.00/);
  assert.match(analysis.body.reply, /no credit limit, posting, alert, or business transaction was changed/i);
  const analysisStep = analysis.body.execution.steps.find(step => step.tool === 'get_monitoring_analysis');
  assert.ok(analysisStep);
  assert.match(analysisStep.summary, /CAP database/);
  assert.doesNotMatch(analysisStep.summary, /ABAP/);

  const proposal = await postJson('/api/chat', {
    message: 'Prepare a credit limit request for C003 to INR 1,200,000 because renewed supply contract.'
  }, 'requester');
  assert.equal(proposal.response.status, 200);
  assert.equal(proposal.body.preparedActions.length, 1);
  assert.equal(proposal.body.preparedActions[0].customerId, 'C003');
  assert.equal(proposal.body.preparedActions[0].requestedLimit, 1_200_000);
  assert.match(proposal.body.reply, /has not been submitted or applied/i);
  assert.equal((await request('/api/limit-requests?status=Pending')).body.length, 0);
});

test('offline assistant answers customer-name and extraction questions with explicit module provenance', async () => {
  const customer = await postJson('/api/chat', {
    message: 'Give me the complete credit risk status of Aarav Components.'
  }, 'reader');
  assert.equal(customer.response.status, 200);
  assert.match(customer.body.reply, /Aarav Components \(C001\)/);
  assert.ok(customer.body.modulesUsed.includes('Customers'));
  assert.ok(customer.body.modulesUsed.includes('Payments'));
  assert.ok(customer.body.dataSourcesUsed.some(source => source.name === 'Credit Guard CAP database'));

  const extraction = await postJson('/api/chat', {
    message: 'Did the latest Mock SAP extraction complete successfully?'
  }, 'reader');
  assert.equal(extraction.response.status, 200);
  assert.match(extraction.body.reply, /No source has been registered|no extraction run is recorded/i);
  assert.match(extraction.body.reply, /fixture counts/i);
  assert.match(extraction.body.reply, /not live SAP data/i);
  assert.ok(extraction.body.modulesUsed.includes('Data ingestion'));
  assert.ok(extraction.body.modulesUsed.includes('SAP Simulator'));
});

test('API requires a CAP-authenticated identity and enforces reader/requester roles', async () => {
  const uiLogin = await request('/credit/', { identity: null });
  assert.equal(uiLogin.response.status, 401);
  assert.match(uiLogin.response.headers.get('www-authenticate'), /Basic/i);

  const anonymous = await request('/api/dashboard', { identity: null });
  assert.equal(anonymous.response.status, 401);

  const reader = await request('/api/dashboard', { identity: 'reader' });
  assert.equal(reader.response.status, 200);

  const readerWrite = await postJson('/api/limit-requests', {
    customerId: 'C001',
    requestedLimit: 1_100_000,
    reason: 'Reader cannot request'
  }, 'reader');
  assert.equal(readerWrite.response.status, 403);
});

test('request API rejects invalid fields and unknown customers without creating requests', async () => {
  const invalidRequests = [
    { customerId: 'C001', requestedLimit: 0, reason: 'Reason' },
    { customerId: 'C001', requestedLimit: -1, reason: 'Reason' },
    { customerId: 'C001', requestedLimit: null, reason: 'Reason' },
    { customerId: 'C001', requestedLimit: 'not-a-number', reason: 'Reason' },
    { customerId: 'C001', reason: 'Missing requested limit' },
    { customerId: 'C001', requestedLimit: 1 },
    { customerId: 'C001', requestedLimit: 1, reason: '   ' },
    { customerId: '', requestedLimit: 1, reason: 'Reason' }
  ];

  for (const payload of invalidRequests) {
    const result = await postJson('/api/limit-requests', payload);
    assert.equal(result.response.status, 400, JSON.stringify(payload));
  }

  const missing = await postJson('/api/limit-requests', {
    customerId: 'NO-SUCH-CUSTOMER',
    requestedLimit: 1,
    reason: 'Reason'
  });
  assert.equal(missing.response.status, 404);

  const requests = await request('/api/limit-requests');
  assert.equal(requests.response.status, 200);
  assert.deepEqual(requests.body, []);
});

test('valid request API creates a Pending request with routing and list contract', async () => {
  const created = await postJson('/api/limit-requests', {
    customerId: 'C003',
    requestedLimit: 1_200_000,
    reason: 'Approved contract renewal',
    requestedBy: 'Forged identity'
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.body.customer_ID, 'C003');
  assert.equal(created.body.currentLimit, 1_000_000);
  assert.equal(created.body.requestedLimit, 1_200_000);
  assert.equal(created.body.status, 'Pending');
  assert.equal(created.body.approverLevel, 'Credit Controller');
  assert.ok(created.body.ID);
  assert.ok(created.body.ID.length <= 12);
  assert.equal(created.body.requestedBy, 'requester');

  const list = await request('/api/limit-requests?status=Pending');
  assert.equal(list.response.status, 200);
  const listedRequest = list.body.find(row => row.ID === created.body.ID);
  assert.ok(listedRequest);
  assert.equal(listedRequest.customerName, 'Merlion Systems');
});

test('limit-request idempotency replays the same request and preserves its single audit event', async () => {
  const key = `request-${randomUUID()}`;
  const payload = {
    customerId: 'C005',
    requestedLimit: 700_000,
    reason: 'Idempotent approval request'
  };
  const first = await postJson('/api/limit-requests', payload, 'requester', key);
  const replay = await postJson('/api/limit-requests', payload, 'requester', key);

  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.body.ID, first.body.ID);

  const decision = await postJson(
    `/api/limit-requests/${first.body.ID}/decision`,
    { decision: 'Rejected', reason: 'Reviewed after the original submission' },
    'finance'
  );
  assert.equal(decision.response.status, 200);

  const replayAfterDecision = await postJson('/api/limit-requests', payload, 'requester', key);
  assert.equal(replayAfterDecision.response.status, 201);
  assert.equal(replayAfterDecision.body.ID, first.body.ID);
  assert.equal(replayAfterDecision.body.status, 'Rejected');
  const history = await request(`/api/limit-requests/${first.body.ID}/history`);
  assert.equal(history.body.length, 1);
});

test('limit-request idempotency rejects a materially different payload for the same key', async () => {
  const key = `request-${randomUUID()}`;
  const first = await postJson('/api/limit-requests', {
    customerId: 'C006',
    requestedLimit: 800_000,
    reason: 'Original request'
  }, 'requester', key);
  const conflict = await postJson('/api/limit-requests', {
    customerId: 'C006',
    requestedLimit: 850_000,
    reason: 'Changed request'
  }, 'requester', key);

  assert.equal(first.response.status, 201);
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.body.error, /different request/i);
});

test('different idempotency keys permit separate requests with identical business data', async () => {
  const payload = {
    customerId: 'C007',
    requestedLimit: 900_000,
    reason: 'Separate legitimate submission'
  };
  const first = await postJson('/api/limit-requests', payload, 'requester', `request-${randomUUID()}`);
  const second = await postJson('/api/limit-requests', payload, 'requester', `request-${randomUUID()}`);

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.notEqual(second.body.ID, first.body.ID);
});

test('concurrent identical limit-request submissions create one durable request', async () => {
  const key = `request-${randomUUID()}`;
  const payload = {
    customerId: 'C008',
    requestedLimit: 950_000,
    reason: 'Concurrent retry'
  };
  const results = await Promise.all([
    postJson('/api/limit-requests', payload, 'requester', key),
    postJson('/api/limit-requests', payload, 'requester', key)
  ]);

  assert.deepEqual(results.map(result => result.response.status), [201, 201]);
  assert.equal(results[0].body.ID, results[1].body.ID);
  assert.equal(results.filter(result => result.response.headers.get('idempotency-replayed') === 'true').length, 1);
});

test('limit-request idempotency is authorization-gated and scoped to the requester', async () => {
  const key = `request-${randomUUID()}`;
  const payload = {
    customerId: 'C009',
    requestedLimit: 1_000_000,
    reason: 'Requester-owned submission'
  };
  const first = await postJson('/api/limit-requests', payload, 'requester', key);
  const unauthorized = await postJson('/api/limit-requests', payload, 'reader', key);
  const otherRequester = await postJson('/api/limit-requests', payload, 'analyst', key);
  const replay = await postJson('/api/limit-requests', payload, 'requester', key);

  assert.equal(first.response.status, 201);
  assert.equal(unauthorized.response.status, 403);
  assert.equal(otherRequester.response.status, 201);
  assert.notEqual(otherRequester.body.ID, first.body.ID);
  assert.equal(replay.body.ID, first.body.ID);
});

test('failed validation does not reserve a key, and a committed retry replays safely', async () => {
  const key = `request-${randomUUID()}`;
  const invalid = await postJson('/api/limit-requests', {
    customerId: 'C010',
    requestedLimit: 0,
    reason: 'Invalid initial attempt'
  }, 'requester', key);
  const validPayload = {
    customerId: 'C010',
    requestedLimit: 1_050_000,
    reason: 'Retry after a rejected initial attempt'
  };
  const firstValid = await postJson('/api/limit-requests', validPayload, 'requester', key);
  const replay = await postJson('/api/limit-requests', validPayload, 'requester', key);
  const missingKey = await postJson('/api/limit-requests', validPayload, 'requester', null);

  assert.equal(invalid.response.status, 400);
  assert.equal(firstValid.response.status, 201);
  assert.equal(replay.body.ID, firstValid.body.ID);
  assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
  assert.equal(missingKey.response.status, 400);
});

test('approval and rejection transitions preserve limits and reject duplicate decisions', async () => {
  const approvedRequest = await postJson('/api/limit-requests', {
    customerId: 'C001',
    requestedLimit: 2_000_000,
    reason: 'Approved by finance'
  });
  assert.equal(approvedRequest.response.status, 201);
  assert.equal(approvedRequest.body.approverLevel, 'Finance Head');

  const forbidden = await postJson(
    `/api/limit-requests/${approvedRequest.body.ID}/decision`,
    { decision: 'Approved', role: 'Finance Head', decidedBy: 'Forged Finance' },
    'controller'
  );
  assert.equal(forbidden.response.status, 403);

  const approved = await postJson(
    `/api/limit-requests/${approvedRequest.body.ID}/decision`,
    { decision: 'Approved', reason: 'Finance approval after contract review', role: 'Credit Controller', decidedBy: 'Forged Actor' },
    'finance'
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, 'Approved');
  assert.equal(approved.body.decidedBy, 'finance');
  const approvalHistory = await request(`/api/limit-requests/${approvedRequest.body.ID}/history`);
  assert.equal(approvalHistory.response.status, 200);
  assert.equal(approvalHistory.body.length, 1);
  assert.equal(approvalHistory.body[0].approver_ID, 'finance');
  assert.equal(approvalHistory.body[0].decisionReason, 'Finance approval after contract review');

  const duplicate = await postJson(
    `/api/limit-requests/${approvedRequest.body.ID}/decision`,
    { decision: 'Rejected', reason: 'Duplicate decision attempt', role: 'Finance Head' },
    'finance'
  );
  assert.equal(duplicate.response.status, 409);

  const customer = await request('/api/customers/C001');
  assert.equal(customer.body.creditLimit, 2_000_000);

  const rejectedRequest = await postJson('/api/limit-requests', {
    customerId: 'C004',
    requestedLimit: 550_000,
    reason: 'Reject without changing limit'
  });
  assert.equal(rejectedRequest.response.status, 201);

  const rejected = await postJson(
    `/api/limit-requests/${rejectedRequest.body.ID}/decision`,
    { decision: 'Rejected', reason: 'Rejected after risk assessment', role: 'Finance Head', decidedBy: 'Forged Actor' },
    'controller'
  );
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.status, 'Rejected');

  const afterReject = await request('/api/customers/C004');
  assert.equal(afterReject.body.creditLimit, 500_000);
});

test('concurrent decisions transition a request once and create an immutable audit record', async () => {
  const created = await postJson('/api/limit-requests', {
    customerId: 'C005',
    requestedLimit: 700_000,
    reason: 'Concurrent approval test'
  }, 'requester');
  assert.equal(created.response.status, 201);

  const decide = () => postJson(
    `/api/limit-requests/${created.body.ID}/decision`,
    { decision: 'Approved', reason: 'Reviewed concurrently' },
    'finance'
  );
  const results = await Promise.all([decide(), decide()]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);

  const history = await request(`/api/limit-requests/${created.body.ID}/history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].request_ID, created.body.ID);
  assert.equal(history.body[0].requester_ID, 'requester');
  assert.equal(history.body[0].approver_ID, 'finance');
  assert.equal(history.body[0].previousStatus, 'Pending');
  assert.equal(history.body[0].newStatus, 'Approved');
  assert.equal(history.body[0].decisionReason, 'Reviewed concurrently');
  assert.equal(history.body[0].timestamp, results.find(result =>
    result.response.status === 200).body.decidedAt);

  const unauthorizedMutation = await request('/odata/v4/credit/ApprovalHistory', {
    method: 'DELETE',
    identity: 'administrator'
  });
  assert.ok(unauthorizedMutation.response.status >= 400);
});

test('request decisions require a bounded audit reason', async () => {
  const created = await postJson('/api/limit-requests', {
    customerId: 'C007',
    requestedLimit: 410_000,
    reason: 'Decision reason validation'
  });
  const missingReason = await postJson(
    `/api/limit-requests/${created.body.ID}/decision`,
    { decision: 'Rejected' },
    'controller'
  );
  assert.equal(missingReason.response.status, 400);

  const longReason = await postJson(
    `/api/limit-requests/${created.body.ID}/decision`,
    { decision: 'Rejected', reason: 'x'.repeat(501) },
    'controller'
  );
  assert.equal(longReason.response.status, 400);

  const unchanged = await request(`/api/limit-requests/${created.body.ID}/history`);
  assert.deepEqual(unchanged.body, []);

});

test('requesters cannot decide their own requests', async () => {
  const created = await postJson('/api/limit-requests', {
    customerId: 'C006',
    requestedLimit: 510_000,
    reason: 'Self-approval separation test'
  }, 'controller');
  assert.equal(created.response.status, 201);

  const decision = await postJson(
    `/api/limit-requests/${created.body.ID}/decision`,
    { decision: 'Approved', reason: 'Requester attempted self-approval' },
    'controller'
  );
  assert.equal(decision.response.status, 403);
  assert.match(decision.body.error, /requester cannot/i);
});

test('decision endpoint validates decision, role, and request existence', async () => {
  const invalidDecision = await postJson('/api/limit-requests/missing/decision', {
    decision: 'Maybe',
    role: 'Finance Head'
  });
  assert.equal(invalidDecision.response.status, 400);

  const invalidRole = await postJson('/api/limit-requests/missing/decision', {
    decision: 'Approved',
    role: 'Administrator'
  });
  assert.equal(invalidRole.response.status, 404);

  const missing = await postJson('/api/limit-requests/missing/decision', {
    decision: 'Approved',
    role: 'Finance Head'
  });
  assert.equal(missing.response.status, 404);
});

test('Gemini connectivity endpoint is authenticated and safely reports missing configuration', async () => {
  const anonymous = await request('/api/ai/gemini/connectivity', {
    method: 'POST',
    identity: null
  });
  assert.equal(anonymous.response.status, 401);

  const connectivity = await postJson('/api/ai/gemini/connectivity', {});
  assert.equal(connectivity.response.status, 503);
  assert.deepEqual(Object.keys(connectivity.body).sort(), [
    'diagnostic', 'model', 'ok', 'provider'
  ]);
  assert.equal(connectivity.body.ok, false);
  assert.equal(connectivity.body.provider, 'gemini');
  assert.equal(connectivity.body.diagnostic, 'GEMINI_API_KEY is not configured.');
  assert.equal(JSON.stringify(connectivity.body).includes('gemini-test-key'), false);
});

test('chat API returns an offline assistant contract and validates empty messages', async () => {
  const chat = await postJson('/api/chat', { message: 'Explain C001' });
  assert.equal(chat.response.status, 200);
  assert.deepEqual(Object.keys(chat.body).sort(), [
    'conversationId', 'dataSourcesUsed', 'execution', 'executionSummary', 'memoryEnabled',
    'modulesUsed', 'offline', 'preparedActions', 'provider', 'providerFallback',
    'providerFallbackReason', 'reply', 'structuredResponse'
  ]);
  assert.equal(chat.body.offline, true);
  assert.equal(chat.body.provider, 'offline');
  assert.ok(chat.body.modulesUsed.includes('Customers'));
  assert.ok(chat.body.dataSourcesUsed.some(source => source.name === 'Credit Guard CAP database'));
  assert.equal(chat.body.memoryEnabled, true);
  assert.equal(chat.body.execution.status, 'completed');
  assert.equal(chat.body.executionSummary.executionId, chat.body.execution.ID);
  assert.ok(chat.body.execution.steps.some(step => step.tool === 'get_customer'));
  assert.match(chat.body.reply, /Aarav Components/);
  assert.match(chat.body.reply, /Offline demo mode/);

  const empty = await postJson('/api/chat', { message: '   ' });
  assert.equal(empty.response.status, 400);
});

test('workflow requests return a persisted preview and do not execute extraction or monitoring', async () => {
  const preview = await postJson('/api/chat', {
    message: 'Create a workflow to extract Mock SAP credit data, validate records, run monitoring, and prepare an alert report.'
  }, 'reader');

  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.provider, 'offline');
  assert.equal(preview.body.workflowPreview.status, 'PREVIEW_ONLY');
  assert.equal(preview.body.workflowPreview.executionAvailable, false);
  assert.equal(preview.body.workflowPreview.steps.length, 4);
  assert.deepEqual(preview.body.execution.steps.map(step => step.tool), ['preview_credit_workflow']);
  assert.match(preview.body.reply, /no application records were read or changed/i);

  const history = await request(`/api/agent/executions/${preview.body.execution.ID}`, {
    identity: 'reader'
  });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.steps[0].toolName, 'preview_credit_workflow');
  assert.equal(history.body.steps[0].status, 'completed');
});

test('conversation history and execution logs are isolated by authenticated user and can be cleared', async () => {
  const firstTurn = await postJson('/api/chat', { message: 'Explain C001' }, 'requester');
  assert.equal(firstTurn.response.status, 200);
  const conversationId = firstTurn.body.conversationId;
  assert.ok(conversationId);

  const ownerRead = await request(`/api/agent/conversations/${conversationId}`, { identity: 'requester' });
  assert.equal(ownerRead.response.status, 200);
  assert.equal(ownerRead.body.messages.length, 2);

  const otherUserRead = await request(`/api/agent/conversations/${conversationId}`, { identity: 'reader' });
  assert.equal(otherUserRead.response.status, 404);
  const otherUserDelete = await request(`/api/agent/conversations/${conversationId}`, {
    method: 'DELETE',
    identity: 'reader'
  });
  assert.equal(otherUserDelete.response.status, 404);

  const ownerHistory = await request('/api/agent/history', { identity: 'requester' });
  assert.equal(ownerHistory.response.status, 200);
  assert.ok(ownerHistory.body.executions.some(item => item.ID === firstTurn.body.execution.ID));
  assert.ok(ownerHistory.body.conversations.some(item => item.ID === conversationId));

  const executionId = firstTurn.body.execution.ID;
  const execution = await request(`/api/agent/executions/${executionId}`, { identity: 'requester' });
  assert.equal(execution.response.status, 200);
  assert.equal(execution.body.ID, executionId);
  assert.equal(Object.hasOwn(execution.body, 'recoveryData'), false);
  assert.equal(Object.hasOwn(execution.body, 'planData'), false);

  const anotherUsersExecution = await request(`/api/agent/executions/${executionId}`, { identity: 'reader' });
  assert.equal(anotherUsersExecution.response.status, 404);
  const unavailableRecovery = await request(`/api/agent/executions/${executionId}/recover`, {
    method: 'POST',
    identity: 'requester'
  });
  assert.equal(unavailableRecovery.response.status, 409);

  const cleared = await request(`/api/agent/conversations/${conversationId}`, {
    method: 'DELETE',
    identity: 'requester'
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.deleted, 1);
  const afterClear = await request(`/api/agent/conversations/${conversationId}`, { identity: 'requester' });
  assert.equal(afterClear.response.status, 404);
});

test('document analysis API accepts UTF-8 text and rejects unsupported extensions', async () => {
  const form = new FormData();
  form.append('document', new Blob(['Credit risk review for customer C001.']), 'review.txt');
  const analyzed = await request('/api/documents/analyze', { method: 'POST', body: form });

  assert.equal(analyzed.response.status, 200);
  assert.equal(analyzed.body.filename, 'review.txt');
  assert.equal(analyzed.body.text, 'Credit risk review for customer C001.');
  assert.equal(analyzed.body.extractedCharacters, analyzed.body.text.length);
  assert.equal(analyzed.body.truncated, false);
  assert.equal(analyzed.body.offline, true);
  assert.equal(typeof analyzed.body.reply, 'string');
  assert.equal(analyzed.body.executionSummary.planStatus, null);

  const unsupportedForm = new FormData();
  unsupportedForm.append('document', new Blob(['This file is unsupported.']), 'review.exe');
  const unsupported = await request('/api/documents/analyze', {
    method: 'POST',
    body: unsupportedForm
  });
  assert.equal(unsupported.response.status, 422);
  assert.match(unsupported.body.error, /Unsupported file type/i);
});

test('request API rejects reasons beyond the CDS limit', async () => {
  const result = await postJson('/api/limit-requests', {
    customerId: 'C001',
    requestedLimit: 1_000_001,
    reason: 'x'.repeat(501)
  });

  assert.equal(result.response.status, 400);
});

test('request API IDs fit the CDS String(12) key width', async () => {
  const result = await postJson('/api/limit-requests', {
    customerId: 'C012',
    requestedLimit: 1_200_001,
    reason: 'Identifier width baseline'
  });

  assert.equal(result.response.status, 201);
  assert.equal(result.body.ID.length, 12);
});

test('OData requires reader scope and rejects generic writes', async () => {
  const unauthenticated = await request('/odata/v4/credit/Customers', { identity: null });
  assert.equal(unauthenticated.response.status, 401);

  const visible = await request('/odata/v4/credit/Customers', { identity: 'reader' });
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.value.length, 13);

  const blockedUpdate = await request('/odata/v4/credit/Customers/C001', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creditLimit: 1 }),
    identity: 'finance'
  });
  assert.ok(blockedUpdate.response.status >= 400);

  const blockedCreate = await request('/odata/v4/credit/Customers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ID: 'C999', name: 'Unauthorized' }),
    identity: 'finance'
  });
  assert.ok(blockedCreate.response.status >= 400);

  const blockedDelete = await request("/odata/v4/credit/Customers('C001')", {
    method: 'DELETE',
    identity: 'finance'
  });
  assert.ok(blockedDelete.response.status >= 400);

  const stillPresent = await request("/odata/v4/credit/Customers('C001')", { identity: 'reader' });
  assert.equal(stillPresent.response.status, 200);
  assert.equal(stillPresent.body.ID, 'C001');
});
