const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { AgentController, chat, createToolRegistry } = require('../srv/agent');
const { GeminiProvider } = require('../srv/llm');

const customer = {
  ID: 'C001',
  name: 'Aarav Components',
  country: 'India',
  companyCode: 'BS01',
  creditLimit: 1_000_000,
  riskClass: 'A',
  lastReviewDate: '2026-03-15'
};
const requester = new cds.User({ id: 'requester', roles: ['CreditRequester', 'CreditReader'] });
const reader = new cds.User({ id: 'reader', roles: ['CreditReader'] });

function mockDatabase(customers = [customer], payments = []) {
  const inserts = [];
  return {
    inserts,
    async run(query) {
      if (query.SELECT) {
        const table = query.SELECT.from.ref[0];
        if (table === 'credit.Customers') {
          return query.SELECT.one
            ? customers.find(record => record.ID === query.SELECT.where?.[2]?.val) || customers[0] || null
            : customers.map(record => ({ ...record }));
        }
        if (table === 'credit.OpenItems') return [];
        if (table === 'credit.Payments') return payments.map(record => ({ ...record }));
      }

      if (query.INSERT) {
        inserts.push(...query.INSERT.entries);
        return [];
      }

      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    }
  };
}

function applicationDataDatabase() {
  const reads = [];
  const record = {
    ...customer,
    name: 'Merlion Systems',
    currency: 'INR',
    creditLimit: 1_000,
    riskClass: 'A'
  };
  const request = {
    ID: 'request-1',
    customer_ID: 'C001',
    currentLimit: 900,
    requestedLimit: 1_000,
    reason: 'Annual review',
    requestedBy: 'requester',
    status: 'Approved',
    approverLevel: 'Credit Controller',
    decidedBy: 'controller',
    createdAt: '2026-10-01T10:00:00.000Z',
    decidedAt: '2026-10-02T10:00:00.000Z'
  };
  const alert = {
    ID: 'alert-1',
    customer_ID: 'C001',
    customerName: 'Merlion Systems',
    severity: 'HIGH',
    conditionKey: 'OVERDUE_RISK',
    status: 'ACKNOWLEDGED',
    exposure: 900,
    creditLimit: 1_000,
    utilisation: 0.9,
    overdueAmount: 900,
    currency: 'INR',
    firstSeenAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: '2026-10-02T10:00:00.000Z'
  };
  const source = {
    sourceId: 'MOCK-S4-001',
    sourceName: 'Mock SAP Simulator',
    sourceType: 'MOCK_SAP_SIMULATOR',
    enabled: true,
    supportedEntities: JSON.stringify(['CUSTOMER', 'INVOICE', 'PAYMENT']),
    mappingVersion: '1',
    authenticationReference: 'credential:must-not-be-returned',
    configurationReference: 'config:must-not-be-returned',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z'
  };
  const ingestionRun = {
    ID: 'ingestion-1',
    sourceId: source.sourceId,
    status: 'COMPLETED',
    startedAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:01:00.000Z',
    retrievedAt: '2026-10-01T10:00:30.000Z',
    decisionEligible: true,
    snapshotPromoted: true,
    rowCounts: JSON.stringify({ CUSTOMER: { retrieved: 1, valid: 1 } }),
    errorCategory: null
  };
  const data = {
    'credit.Customers': [record],
    'credit.OpenItems': [{
      ID: 'invoice-1',
      customer_ID: 'C001',
      type: 'INVOICE',
      amount: 900,
      currency: 'INR',
      dueDate: '2000-01-01',
      status: 'OVERDUE'
    }],
    'credit.Payments': [{
      ID: 'payment-1',
      customer_ID: 'C001',
      reference: 'PAY-1',
      amount: 50,
      currency: 'INR',
      postingDate: '2026-10-02',
      status: 'POSTED'
    }],
    'credit.LimitRequests': [request],
    'credit.ApprovalHistory': [{
      ID: 'decision-1',
      request_ID: request.ID,
      approver_ID: 'controller',
      previousStatus: 'Pending',
      newStatus: 'Approved',
      decisionReason: 'Reviewed',
      timestamp: request.decidedAt
    }],
    'credit.MonitoringAlerts': [alert],
    'credit.MonitoringAlertEvents': [{
      ID: 'event-1',
      alert_ID: alert.ID,
      eventType: 'ACKNOWLEDGED',
      actor_ID: 'monitor',
      createdAt: alert.lastSeenAt,
      details: 'Reviewed'
    }],
    'credit.DataSources': [source],
    'credit.IngestionRuns': [ingestionRun],
    'credit.IngestionQualityIssues': [{
      ID: 'issue-1',
      ingestionRun_ID: ingestionRun.ID,
      code: 'OPTIONAL_FIELD_MISSING',
      severity: 'WARNING',
      entityType: 'CUSTOMER',
      sourceRecordId: 'sap-customer-1',
      field: 'RISK_CLASS',
      message: 'Optional risk class was not supplied.'
    }]
  };
  return {
    reads,
    async run(query) {
      if (!query.SELECT) throw new Error('Unexpected non-read query.');
      const table = query.SELECT.from.ref[0];
      reads.push(table);
      const rows = data[table];
      if (!rows) throw new Error(`Unexpected read from ${table}.`);
      return query.SELECT.one ? rows[0] || null : rows.map(row => ({ ...row }));
    }
  };
}

function plannedTask(toolName, toolInput, options = {}) {
  const isProposal = toolName === 'prepare_limit_change';
  return {
    taskId: options.taskId || 'task-1',
    description: options.description || 'Run the registered Credit Guard operation.',
    toolName,
    toolInput,
    dependencies: options.dependencies || [],
    taskType: isProposal ? 'PROPOSAL' : 'READ_ONLY',
    completionCriteria: {
      description: 'Return a result from the registered operation.',
      requiredFields: isProposal ? ['requiresHumanApproval', 'proposal'] : ['ID']
    }
  };
}

function planningCall(task) {
  return {
    type: 'tool_use',
    id: 'plan-call',
    name: 'create_task_plan',
    input: {
      objective: 'Complete the requested Credit Guard analysis.',
      tasks: [task]
    }
  };
}

function planningResponse(task) {
  const call = planningCall(task);
  return {
    content: [call],
    toolCalls: [{ id: call.id, name: call.name, input: call.input }],
    text: ''
  };
}

async function runProposal(input, db) {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'baseline-test-placeholder';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const result = calls === 1
      ? { content: [planningCall(plannedTask('prepare_limit_change', input))] }
      : { content: [{ type: 'text', text: 'Proposal processed.' }] };
    return { ok: true, json: async () => result };
  };

  try {
    return await chat(
      `Prepare a limit proposal for customer ${input.customer_id} to ${input.new_limit} because ${input.reason}`,
      db,
      undefined,
      requester
    );
  } finally {
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
}

test('AI prepares a validated pending request for explicit user confirmation', async () => {
  const db = mockDatabase();
  const result = await runProposal({
    customer_id: 'C001',
    new_limit: 1_200_000,
    reason: 'Contract renewal'
  }, db);

  assert.equal(db.inserts.length, 0);
  assert.equal(result.execution.approvalRequired, true);
  assert.deepEqual(result.preparedActions[0], {
    customerId: 'C001',
    customerName: 'Aarav Components',
    currentLimit: 1_000_000,
    requestedLimit: 1_200_000,
    reason: 'Contract renewal',
    approverLevel: 'Credit Controller'
  });
});

test('agent cannot prepare a local credit-limit proposal when configured for read-only ABAP', async () => {
  const db = {
    async run() {
      throw new Error('Read-only ABAP proposal must not query local customer records.');
    }
  };
  const tools = createToolRegistry(db, requester, { customerDataSource: 'abap' });

  await assert.rejects(
    tools.prepare_limit_change({
      customer_id: 'C001',
      new_limit: 1_200_000,
      reason: 'Contract extension'
    }),
    { statusCode: 409, message: /read-only mode/i }
  );
});

test('AI planning rejects a negative requested limit before execution', async () => {
  const db = mockDatabase();
  const result = await runProposal({
    customer_id: 'C001',
    new_limit: -1,
    reason: 'Invalid negative limit'
  }, db);

  assert.equal(db.inserts.length, 0);
  assert.equal(result.plan, null);
  assert.equal(result.execution.planStatus, 'REJECTED');
  assert.equal(result.execution.steps.length, 0);
});

test('AI proposal validation rejects blank reasons', async () => {
  const db = mockDatabase();
  const result = await runProposal({
    customer_id: 'C001',
    new_limit: 1_100_000,
    reason: '   '
  }, db);

  assert.equal(db.inserts.length, 0);
  assert.equal(result.plan, null);
  assert.equal(result.execution.planStatus, 'REJECTED');
  assert.equal(result.execution.steps.length, 0);
  assert.match(result.reply, /clarify the required customer, limit, or reason/i);
});

test('AI planning rejects reasons beyond the CDS limit before execution', async () => {
  const db = mockDatabase();
  const result = await runProposal({
    customer_id: 'C001',
    new_limit: 1_100_000,
    reason: 'x'.repeat(501)
  }, db);

  assert.equal(db.inserts.length, 0);
  assert.equal(result.plan, null);
  assert.equal(result.execution.planStatus, 'REJECTED');
  assert.equal(result.execution.steps.length, 0);
});

test('AI proposal tools require a requester entitlement', async () => {
  const db = mockDatabase();
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'baseline-test-placeholder';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        content: calls === 1
          ? [planningCall(plannedTask('prepare_limit_change', {
            customer_id: 'C001',
            new_limit: 1_100_000,
            reason: 'Attempt without permission'
          }))]
          : [{ type: 'text', text: 'Proposal processed.' }]
      })
    };
  };

  try {
    const result = await chat('Prepare a proposal for C001 to 1100000 because Attempt without permission', db, undefined, reader);
    assert.equal(result.plan.tasks[0].status, 'FAILED');
    assert.equal(result.taskResults[0].errorCategory, 'permission_denied');
  } finally {
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
  assert.equal(db.inserts.length, 0);
});

test('AI proposal rejects unknown customers without inserting a request', async () => {
  const db = mockDatabase([]);
  const result = await runProposal({
    customer_id: 'C999',
    new_limit: 1_100_000,
    reason: 'Unknown customer'
  }, db);

  assert.equal(db.inserts.length, 0);
  assert.equal(result.plan.tasks[0].status, 'FAILED');
  assert.equal(result.taskResults[0].errorCategory, 'not_found');
});

test('tool registry validates inputs and enforces reader and requester permissions', async () => {
  const tools = createToolRegistry(mockDatabase(), reader);
  await assert.rejects(
    tools.list_customers_over_threshold({ min_utilisation: NaN }),
    /between 0 and 10/
  );
  await assert.rejects(
    tools.get_customer({ customer_id: 'C001', sql: 'SELECT *' }),
    /Unexpected tool input/
  );
  await assert.rejects(
    tools.prepare_limit_change({
      customer_id: 'C001',
      new_limit: 1_100_000,
      reason: 'Unauthorized request attempt'
    }),
    /permission to prepare/i
  );
});

test('agent controller performs bounded multi-step tool execution and records summaries', async () => {
  const db = mockDatabase();
  const responses = [
    planningResponse(plannedTask('get_customer', { customer_id: 'C001' })),
    { content: [{ type: 'text', text: 'Customer analysis complete.' }] }
  ];
  const provider = { async complete() { return responses.shift(); } };
  const result = await chat('Analyze C001', db, undefined, requester, { provider });

  assert.match(result.reply, /Plan status: COMPLETED/);
  assert.equal(result.execution.status, 'completed');
  assert.equal(result.execution.steps.length, 1);
  assert.equal(result.execution.steps[0].tool, 'get_customer');
  assert.equal(result.execution.steps[0].status, 'completed');
  assert.equal(result.plan.status, 'COMPLETED');
  assert.equal(result.plan.tasks[0].status, 'COMPLETED');
});

test('customer context includes actual local payment records when available', async () => {
  const payment = {
    ID: 'PAY-C001-1',
    customer_ID: 'C001',
    amount: 25_000,
    currency: 'INR',
    postingDate: '2026-10-25'
  };
  const tools = createToolRegistry(mockDatabase([customer], [payment]), reader);
  const result = await tools.get_customer({ customer_id: 'C001' });
  assert.deepEqual(result.payments, [payment]);
});

test('authorized agent tools retrieve grounded customer, dashboard, approval, alert, and ingestion data', async () => {
  const db = applicationDataDatabase();
  const tools = createToolRegistry(db, reader);

  const matches = await tools.search_customers({ query: 'Merlion' });
  assert.deepEqual(matches, [{
    ID: 'C001',
    name: 'Merlion Systems',
    country: 'India',
    companyCode: 'BS01'
  }]);

  const detail = await tools.get_customer({ customer_id: matches[0].ID });
  assert.equal(detail.exposure, 900);
  assert.equal(detail.overdueAmount, 900);
  assert.equal(detail.payments.length, 1);

  const portfolio = await tools.get_portfolio_summary({});
  assert.equal(portfolio.portfolio.customerCount, 1);
  assert.equal(portfolio.portfolio.totalExposure, 900);
  assert.equal(portfolio.exposureByCountry[0].label, 'India');

  const approval = await tools.get_customer_approval_history({ customer_id: 'C001' });
  assert.equal(approval.requests[0].status, 'Approved');
  assert.equal(approval.requests[0].decisions[0].approver_ID, 'controller');

  const monitoring = await tools.get_monitoring_alerts({ status: 'ALL' });
  assert.equal(monitoring.alerts[0].events[0].action, 'ACKNOWLEDGED');
  assert.equal(monitoring.alerts[0].events[0].actorId, 'monitor');

  const ingestion = await tools.get_data_ingestion_status({});
  assert.equal(ingestion.sources[0].latestRun.status, 'COMPLETED');
  assert.equal(ingestion.sources[0].validationIssues[0].code, 'OPTIONAL_FIELD_MISSING');
  assert.equal(
    ingestion.syntheticMockSapFixture.recordCounts.CUSTOMER,
    require('../srv/integrations/mock-sap/fixtures.json').entities.CUSTOMER.records.length
  );
  assert.doesNotMatch(JSON.stringify(ingestion), /must-not-be-returned/);

  const simulator = await tools.get_mock_sap_records({ entity_type: 'CUSTOMER' });
  assert.match(simulator.source, /synthetic.*not a live SAP connection/i);
  assert.ok(simulator.records.every(sourceRecord => typeof sourceRecord.KUNNR === 'string'));
});

test('new cross-module reads remain role-gated and workflow preview does not execute actions', async () => {
  const limitedUser = new cds.User({ id: 'limited', roles: ['CreditRequester'] });
  const deniedTools = createToolRegistry(applicationDataDatabase(), limitedUser);
  await assert.rejects(deniedTools.get_data_ingestion_status({}), /permission/i);
  await assert.rejects(deniedTools.get_monitoring_alerts({ status: 'ALL' }), /permission/i);

  const db = applicationDataDatabase();
  const tools = createToolRegistry(db, reader);
  const preview = await tools.preview_credit_workflow({ workflow_id: 'mock_sap_risk_review' });
  assert.equal(preview.status, 'PREVIEW_ONLY');
  assert.equal(preview.executionAvailable, false);
  assert.equal(preview.requiresHumanConfirmation, true);
  assert.deepEqual(db.reads, []);
});

test('workflow creation requests produce a persisted preview plan without running its steps', async () => {
  const result = await chat(
    'Create a workflow to extract Mock SAP credit data, validate records, run monitoring, and prepare an alert report.',
    applicationDataDatabase(),
    undefined,
    reader,
    {
      provider: {
        async complete() {
          return {
            content: [{ type: 'text', text: 'Preview prepared.' }],
            toolCalls: [],
            text: 'Preview prepared.'
          };
        }
      }
    }
  );

  assert.equal(result.workflowPreview.workflowId, 'mock_sap_risk_review');
  assert.equal(result.workflowPreview.executionAvailable, false);
  assert.equal(result.workflowPreview.steps.length, 4);
  assert.equal(result.execution.steps.length, 1);
  assert.equal(result.execution.steps[0].tool, 'preview_credit_workflow');
  assert.match(result.reply, /no application records were read or changed/i);
});

test('agent response retains existing public fields and adds a validated plan', async () => {
  const result = await chat('Explain C001', mockDatabase(), undefined, reader, {
    provider: {
      async complete() {
        return { content: [{ type: 'text', text: 'Customer analysis complete.' }] };
      }
    }
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'dataSourcesUsed',
    'execution',
    'executionSummary',
    'modulesUsed',
    'offline',
    'plan',
    'preparedActions',
    'provider',
    'providerFallback',
    'providerFallbackReason',
    'reply',
    'taskResults'
  ]);
  assert.match(result.reply, /could not create a valid task plan/i);
  assert.equal(result.offline, false);
  assert.deepEqual(result.preparedActions, []);
  assert.equal(result.plan, null);
  assert.equal(result.execution.planStatus, 'REJECTED');
});

test('agent execution enforces a timeout and step limit', async () => {
  const hangingProvider = { complete: () => new Promise(() => {}) };
  await assert.rejects(
    chat('Never completes', mockDatabase(), undefined, requester, {
      provider: hangingProvider,
      timeoutMs: 5
    }),
    error => error.category === 'execution_timeout' && error.execution.status === 'failed'
  );

  let providerCalls = 0;
  const boundedProvider = {
    async complete() {
      providerCalls += 1;
      return providerCalls === 1
        ? planningResponse(plannedTask('get_customer', { customer_id: 'C001' }))
        : { content: [{ type: 'text', text: 'Customer details were retrieved.' }] };
    }
  };
  const bounded = await chat('Analyze C001', mockDatabase(), undefined, requester, {
    provider: boundedProvider,
    maxSteps: 1
  });
  assert.equal(providerCalls, 1);
  assert.match(bounded.reply, /Plan status: COMPLETED/);
});

test('provider failures are categorized without exposing credentials', async () => {
  const provider = {
    async complete() {
      const error = new Error('provider connection failed');
      error.category = 'provider_unavailable';
      throw error;
    }
  };
  const result = await chat('Explain C001', mockDatabase(), undefined, requester, { provider });
  assert.equal(result.offline, true);
  assert.equal(result.execution.providerFallback, true);
  assert.equal(result.execution.providerErrorCategory, 'provider_unavailable');
  assert.match(result.reply, /Aarav Components/);
});

test('agent selects configured Gemini provider and model without exposing its key', () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalModel = process.env.LLM_MODEL;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.LLM_PROVIDER = 'gemini';
  process.env.LLM_MODEL = 'gemini-test-model';
  process.env.GEMINI_API_KEY = 'agent-test-key';
  try {
    const controller = new AgentController({ db: mockDatabase(), user: reader });
    assert.ok(controller.provider instanceof GeminiProvider);
    assert.equal(controller.provider.model, 'gemini-test-model');
    assert.equal(JSON.stringify(controller.provider).includes('agent-test-key'), false);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = originalModel;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('Gemini recommendations cannot turn into a proposal without explicit user intent', async () => {
  const db = mockDatabase();
  const provider = {
    async complete() {
      return planningResponse(plannedTask('prepare_limit_change', {
        customer_id: 'C001',
        new_limit: 1_200_000,
        reason: 'Contract renewal'
      }));
    }
  };
  const result = await chat(
    'Recommend the next credit-control action for C001.',
    db,
    undefined,
    requester,
    { provider }
  );
  assert.equal(db.inserts.length, 0);
  assert.equal(result.execution.approvalRequired, false);
  assert.equal(result.preparedActions.length, 0);
  assert.equal(result.plan.tasks[0].status, 'BLOCKED');
});

test('offline mode records why provider fallback was used', async () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const result = await chat('Explain C001', mockDatabase(), undefined, reader);
    assert.equal(result.offline, true);
    assert.equal(result.execution.providerFallback, true);
    assert.equal(result.execution.providerErrorCategory, 'provider_not_configured');
    assert.match(result.reply, /Aarav Components/);
    assert.equal(JSON.stringify(result.execution).includes('C001'), false);
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
