const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');
let moduleSequence = 0;

async function loadView(name) {
  const utils = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utils).toString('base64')}`;
  let source = await fs.readFile(path.join(appRoot, 'views', name), 'utf8');
  source = source.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  return import(moduleUrl);
}

function installDocument(t, selectors) {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: selector => selectors[selector] }
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  });
}

function element() {
  return {
    hidden: false,
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    replaceChildren() {}
  };
}

test('approval view hides ineligible decisions and renders persisted decision audit', async t => {
  const pending = {
    ID: 'request-1',
    customer_ID: 'C001',
    customerName: 'Aarav Components',
    status: 'Pending',
    approverLevel: 'Credit Controller',
    requestedBy: 'requester',
    currentLimit: 100000,
    requestedLimit: 120000,
    reason: 'Contract extension',
    createdAt: '2026-11-05T10:00:00.000Z'
  };
  const decided = {
    ...pending,
    ID: 'request-2',
    status: 'Approved',
    decidedBy: 'finance',
    decidedAt: '2026-11-05T11:00:00.000Z',
    auditHistory: [{
      newStatus: 'Approved',
      approver_ID: 'finance',
      decisionReason: '<reviewed & approved>',
      timestamp: '2026-11-05T11:00:00.000Z'
    }]
  };
  const host = element();
  const count = element();
  installDocument(t, { '#approvals-list': host, '#pending-count': count });
  const { renderApprovals } = await loadView('approvals.js');

  renderApprovals([pending, decided], {
    userId: 'reader',
    permissions: { canApproveController: false, canApproveFinance: false }
  });
  assert.doesNotMatch(host.innerHTML, /data-decision=/);
  assert.match(host.innerHTML, /Decision Approved/);
  assert.match(host.innerHTML, /Approver finance/);
  assert.match(host.innerHTML, /Reason: &lt;reviewed &amp; approved&gt;/);

  renderApprovals([pending], {
    userId: 'finance',
    permissions: { canApproveController: false, canApproveFinance: true }
  });
  assert.match(host.innerHTML, /data-decision="Approved"/);

  renderApprovals([pending], {
    userId: 'requester',
    permissions: { canApproveController: true, canApproveFinance: true }
  });
  assert.doesNotMatch(host.innerHTML, /data-decision=/);

  renderApprovals([pending], {
    userId: 'finance',
    creditLimitWorkflow: 'READ_ONLY',
    permissions: { canApproveController: true, canApproveFinance: true }
  });
  assert.doesNotMatch(host.innerHTML, /data-decision=/);
  assert.match(host.innerHTML, /SAP is connected in read-only mode/);
  assert.match(host.innerHTML, /do not update SAP/);
});

test('request form shows local workflow only and explains SAP read-only mode', async t => {
  const notice = element();
  const form = element();
  installDocument(t, {
    '#source-mode-notice': notice,
    '#request-form': form
  });
  const { renderLimitRequestAvailability } = await loadView('limitRequest.js');

  renderLimitRequestAvailability({
    creditLimitWorkflow: 'READ_ONLY',
    permissions: { canRequest: false }
  });
  assert.equal(notice.hidden, false);
  assert.equal(form.hidden, true);

  renderLimitRequestAvailability({
    creditLimitWorkflow: 'LOCAL_DEMO',
    permissions: { canRequest: true }
  });
  assert.equal(notice.hidden, true);
  assert.equal(form.hidden, false);
});

test('customer view displays approval history alongside payments and open items', async t => {
  const host = element();
  installDocument(t, { '#customer-detail': host });
  const { renderCustomerDetail } = await loadView('customers.js');
  renderCustomerDetail({
    ID: 'C001',
    name: 'Aarav Components',
    status: 'BREACH',
    riskClass: 'A',
    lastReviewDate: '2026-03-15',
    flags: ['BREACH'],
    exposure: 120000,
    creditLimit: 100000,
    utilisation: 1.2,
    overdueAmount: 20000,
    currency: 'INR',
    openItems: []
  }, [], [{
    newStatus: 'Rejected',
    approver_ID: 'controller',
    decisionReason: 'Insufficient supporting evidence',
    timestamp: '2026-11-05T12:00:00.000Z'
  }]);

  assert.match(host.innerHTML, /Credit-limit decision history/);
  assert.match(host.innerHTML, /Rejected/);
  assert.match(host.innerHTML, /controller/);
  assert.match(host.innerHTML, /Insufficient supporting evidence/);
});

test('monitoring view offers recovery only for eligible runs to operators', async t => {
  const selectors = {
    '#run-monitoring': element(),
    '#monitoring-kpis': element(),
    '#monitoring-status': element(),
    '#monitoring-error': element(),
    '#monitoring-advisory': element(),
    '#monitoring-advisory-source': element(),
    '#monitoring-alerts': element(),
    '#monitoring-findings': element(),
    '#monitoring-history': element()
  };
  installDocument(t, selectors);
  const { renderMonitoring } = await loadView('monitoring.js');
  const input = {
    summary: {
      latestRun: { status: 'FAILED', source: 'CAP database', recoveryStatus: 'AVAILABLE' },
      activeAlertCount: 0,
      canOperate: true
    },
    runs: [{
      id: 'run-1',
      status: 'FAILED',
      recoveryStatus: 'AVAILABLE',
      runKind: 'MANUAL',
      startedAt: '2026-11-05T10:00:00.000Z'
    }],
    alerts: [],
    findings: []
  };

  renderMonitoring(input);
  assert.match(selectors['#monitoring-history'].innerHTML, /data-monitoring-recovery="run-1"/);

  renderMonitoring({
    ...input,
    summary: { ...input.summary, canOperate: false }
  });
  assert.doesNotMatch(selectors['#monitoring-history'].innerHTML, /data-monitoring-recovery=/);
});

test('agent view hides proposal submission for users without request permission', async t => {
  const chat = element();
  const activity = element();
  installDocument(t, { '#chat-messages': chat, '#agent-activity': activity });
  const { renderChat } = await loadView('chat.js');
  const execution = {
    status: 'completed',
    steps: [],
    preparedActions: [{
      customerName: 'Aarav Components',
      customerId: 'C001',
      reason: 'Contract extension',
      currentLimit: 100000,
      requestedLimit: 120000,
      approverLevel: 'Credit Controller'
    }]
  };

  renderChat([{ role: 'assistant', text: 'Proposal prepared.' }], execution, { canRequest: false });
  assert.doesNotMatch(activity.innerHTML, /data-submit-proposal/);
  renderChat([{ role: 'assistant', text: 'Proposal prepared.' }], execution, { canRequest: true });
  assert.match(activity.innerHTML, /data-submit-proposal/);
});

test('assistant view labels provider and data provenance and renders workflow steps as preview-only', async t => {
  const chat = element();
  const activity = element();
  installDocument(t, { '#chat-messages': chat, '#agent-activity': activity });
  const { renderChat } = await loadView('chat.js');
  const preview = {
    name: 'Mock SAP credit-risk review',
    source: 'Synthetic Mock SAP Simulator; not a live SAP connection.',
    limitations: ['No workflow action is executed.'],
    steps: [{
      module: 'SAP Simulator',
      operation: 'POST /api/mock-sap/extract',
      dependsOn: [],
      requiredRoles: ['CreditAdmin'],
      confirmation: 'Explicit operator action',
      expectedResult: 'Persisted extraction run'
    }]
  };

  renderChat([{
    role: 'assistant',
    text: 'Preview prepared.',
    provider: 'offline',
    providerFallback: true,
    providerFallbackReason: 'provider_timeout',
    modulesUsed: ['Customers', 'Payments'],
    dataSourcesUsed: [{ name: 'Credit Guard CAP database' }]
  }], {
    status: 'completed',
    steps: [{ tool: 'preview_credit_workflow', status: 'completed', summary: 'Preview only.' }],
    preparedActions: [],
    workflowPreview: preview
  });

  assert.match(chat.innerHTML, /Offline fallback/);
  assert.match(chat.innerHTML, /Customers, Payments/);
  assert.match(chat.innerHTML, /Credit Guard CAP database/);
  assert.match(chat.innerHTML, /provider timeout/);
  assert.match(activity.innerHTML, /Preview only/);
  assert.match(activity.innerHTML, /CreditAdmin/);
  assert.match(activity.innerHTML, /No workflow action is executed/);
});

test('API helpers use authenticated existing audit and recovery routes', async t => {
  const source = await fs.readFile(path.join(appRoot, 'api.js'), 'utf8');
  const apiUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  const api = await import(apiUrl);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/credit/index.html') return new Response('<html></html>');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname: 'localhost' }
  });
  t.after(() => {
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  });

  await api.getSession();
  await api.getApprovalHistory('request/1');
  await api.recoverMonitoringRun('run/1');
  await api.getAgentExecution('execution/1');
  await api.recoverAgentExecution('execution/1');

  assert.deepEqual(calls.filter(call => call.url !== '/credit/index.html').map(call => [
    call.url,
    call.options.method
  ]), [
    ['/api/session', 'GET'],
    ['/api/limit-requests/request%2F1/history', 'GET'],
    ['/api/monitoring/runs/run%2F1/recover', 'POST'],
    ['/api/agent/executions/execution%2F1', 'GET'],
    ['/api/agent/executions/execution%2F1/recover', 'POST']
  ]);
});

test('credit-request API helper reuses a key across failure and rotates it after success', async t => {
  const source = await fs.readFile(path.join(appRoot, 'api.js'), 'utf8');
  const apiUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  const api = await import(apiUrl);
  const calls = [];
  const values = new Map();
  const originalStorage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    }
  });
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname: 'localhost' }
  });
  t.after(() => {
    if (originalStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: originalStorage });
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  });
  let submissionCount = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/credit/index.html') return new Response('');
    submissionCount += 1;
    if (submissionCount === 1) {
      return new Response(JSON.stringify({ error: 'Temporary server failure.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ID: `request-${submissionCount}` }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  });

  const payload = { customerId: 'C001', requestedLimit: 120000, reason: 'Retry safely' };
  await assert.rejects(api.createLimitRequest(payload, 'retry-test'), /Temporary server failure/);
  await api.createLimitRequest(payload, 'retry-test');
  await api.createLimitRequest(payload, 'retry-test');

  const keys = calls
    .filter(call => call.url === '/api/limit-requests')
    .map(call => new Headers(call.options.headers).get('Idempotency-Key'));
  assert.equal(keys.length, 3);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[1]);
});
