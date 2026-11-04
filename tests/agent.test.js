const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { chat, createToolRegistry } = require('../srv/agent');

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

function mockDatabase(customers = [customer]) {
  const inserts = [];
  return {
    inserts,
    async run(query) {
      if (query.SELECT) {
        const table = query.SELECT.from.ref[0];
        if (table === 'credit.Customers') return customers.map(record => ({ ...record }));
        if (table === 'credit.OpenItems') return [];
      }

      if (query.INSERT) {
        inserts.push(...query.INSERT.entries);
        return [];
      }

      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
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

test('agent response retains existing public fields and adds a validated plan', async () => {
  const result = await chat('Explain C001', mockDatabase(), undefined, reader, {
    provider: {
      async complete() {
        return { content: [{ type: 'text', text: 'Customer analysis complete.' }] };
      }
    }
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'execution',
    'executionSummary',
    'offline',
    'plan',
    'preparedActions',
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
