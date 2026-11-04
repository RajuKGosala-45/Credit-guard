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

function postJson(path, body, identity = 'requester') {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    identity
  });
}

test('dashboard API returns the established KPI and exposure contract', async () => {
  const { response, body } = await request('/api/dashboard');

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['exposure', 'kpis']);
  assert.deepEqual(Object.keys(body.kpis).sort(), [
    'currency',
    'customerCount',
    'customersBreached',
    'healthyCustomers',
    'manualReviewCustomers',
    'overallUtilisation',
    'overdueRiskCustomers',
    'totalExposure',
    'totalLimit',
    'warningCustomers'
  ]);
  assert.equal(body.kpis.totalExposure, 5_535_000);
  assert.equal(body.kpis.totalLimit, 9_400_000);
  assert.equal(body.kpis.customerCount, 12);
  assert.equal(body.kpis.customersBreached, 2);
  assert.ok(Math.abs(body.kpis.overallUtilisation - (5_535_000 / 9_400_000)) < 1e-12);

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

test('customer APIs return calculated summaries, details, and a 404 for unknown IDs', async () => {
  const list = await request('/api/customers');
  assert.equal(list.response.status, 200);
  assert.equal(list.body.length, 12);

  const customer = list.body.find(row => row.ID === 'C001');
  assert.ok(customer);
  assert.equal(customer.exposure, 1_200_000);
  assert.equal(customer.overdueAmount, 200_000);
  assert.equal(customer.utilisation, 1.2);
  assert.equal(customer.utilisationPercent, 120);
  assert.equal(customer.status, 'BREACH');

  const detail = await request('/api/customers/C001');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.ID, 'C001');
  assert.equal(detail.body.openItems.length, 3);
  assert.equal(detail.body.openItems.find(item => item.ID === 'I001').isOverdue, true);

  const missing = await request('/api/customers/NO-SUCH-CUSTOMER');
  assert.equal(missing.response.status, 404);
  assert.match(missing.body.error, /was not found/i);
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

test('chat API returns an offline assistant contract and validates empty messages', async () => {
  const chat = await postJson('/api/chat', { message: 'Explain C001' });
  assert.equal(chat.response.status, 200);
  assert.deepEqual(Object.keys(chat.body).sort(), [
    'conversationId', 'execution', 'executionSummary', 'memoryEnabled', 'offline', 'preparedActions', 'reply'
  ]);
  assert.equal(chat.body.offline, true);
  assert.equal(chat.body.memoryEnabled, true);
  assert.equal(chat.body.execution.status, 'completed');
  assert.equal(chat.body.executionSummary.executionId, chat.body.execution.ID);
  assert.ok(chat.body.execution.steps.some(step => step.tool === 'get_customer'));
  assert.match(chat.body.reply, /Aarav Components/);
  assert.match(chat.body.reply, /Offline demo mode/);

  const empty = await postJson('/api/chat', { message: '   ' });
  assert.equal(empty.response.status, 400);
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
  assert.equal(visible.body.value.length, 12);

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
