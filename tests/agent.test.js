const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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

async function runProposal(input, db) {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'baseline-test-placeholder';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const result = calls === 1
      ? {
          content: [{
            type: 'tool_use',
            id: 'tool-call-1',
            name: 'prepare_limit_change',
            input
          }]
        }
      : { content: [{ type: 'text', text: 'Proposal processed.' }] };
    return { ok: true, json: async () => result };
  };

  try {
    return await chat('Create a limit proposal', db, undefined, requester);
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

test('AI proposal validation rejects a negative requested limit', async () => {
  const db = mockDatabase();
  await assert.rejects(runProposal({
    customer_id: 'C001',
    new_limit: -1,
    reason: 'Invalid negative limit'
  }, db), /positive requested limit/i);

  assert.equal(db.inserts.length, 0);
});

test('AI proposal validation rejects blank reasons', async () => {
  const db = mockDatabase();
  await assert.rejects(runProposal({
    customer_id: 'C001',
    new_limit: 1_100_000,
    reason: '   '
  }, db), /reason/i);

  assert.equal(db.inserts.length, 0);
});

test('AI proposal validation rejects reasons beyond the CDS limit', async () => {
  const db = mockDatabase();
  await assert.rejects(runProposal({
    customer_id: 'C001',
    new_limit: 1_100_000,
    reason: 'x'.repeat(501)
  }, db), /500 characters/i);

  assert.equal(db.inserts.length, 0);
});

test('AI proposal tools require a requester entitlement', async () => {
  const db = mockDatabase();
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'baseline-test-placeholder';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{
        type: 'tool_use',
        id: 'tool-call-1',
        name: 'prepare_limit_change',
        input: { customer_id: 'C001', new_limit: 1_100_000, reason: 'Attempt without permission' }
      }]
    })
  });

  try {
    await assert.rejects(
      chat('Create a proposal', db, undefined, reader),
      /permission to prepare/i
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
  assert.equal(db.inserts.length, 0);
});

test('AI proposal rejects unknown customers without inserting a request', async () => {
  const db = mockDatabase([]);
  await assert.rejects(runProposal({
    customer_id: 'C999',
    new_limit: 1_100_000,
    reason: 'Unknown customer'
  }, db), /was not found/);

  assert.equal(db.inserts.length, 0);
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
    { content: [{ type: 'tool_use', id: 'call-1', name: 'get_customer', input: { customer_id: 'C001' } }], toolCalls: [{ id: 'call-1', name: 'get_customer', input: { customer_id: 'C001' } }], text: '' },
    { content: [{ type: 'text', text: 'Customer analysis complete.' }], toolCalls: [], text: 'Customer analysis complete.' }
  ];
  const provider = { async complete() { return responses.shift(); } };
  const result = await chat('Analyze C001', db, undefined, requester, { provider });

  assert.equal(result.reply, 'Customer analysis complete.');
  assert.equal(result.execution.status, 'completed');
  assert.equal(result.execution.steps.length, 1);
  assert.equal(result.execution.steps[0].tool, 'get_customer');
  assert.equal(result.execution.steps[0].status, 'completed');
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

  const loopingProvider = {
    async complete() {
      const callId = randomUUID();
      const call = { id: callId, name: 'get_customer', input: { customer_id: 'C001' } };
      return { content: [call], toolCalls: [call], text: '' };
    }
  };
  await assert.rejects(
    chat('Keep looking', mockDatabase(), undefined, requester, {
      provider: loopingProvider,
      maxSteps: 2
    }),
    error => error.category === 'step_limit' && error.execution.status === 'failed'
  );
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
