const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { chat, createToolRegistry } = require('../srv/agent');

const customers = [
  {
    ID: 'C001',
    name: 'Aarav Components',
    country: 'India',
    companyCode: 'BS01',
    creditLimit: 1000,
    riskClass: 'C',
    lastReviewDate: '2026-02-01'
  },
  {
    ID: 'C002',
    name: 'Merlion Systems',
    country: 'Singapore',
    companyCode: 'BS02',
    creditLimit: 1000,
    riskClass: 'A',
    lastReviewDate: '2026-02-01'
  }
];

const openItems = [
  { ID: 'I001', customer_ID: 'C001', type: 'Invoice', amount: 700, status: 'Overdue', dueDate: '2000-01-01' },
  { ID: 'I002', customer_ID: 'C001', type: 'SalesOrder', amount: 500, status: 'Open', dueDate: '2099-01-01' },
  { ID: 'I003', customer_ID: 'C002', type: 'Invoice', amount: 950, status: 'Open', dueDate: '2099-01-01' }
];

const reader = new cds.User({ id: 'reader', roles: ['CreditReader'] });
const requester = new cds.User({
  id: 'requester',
  roles: ['CreditReader', 'CreditRequester']
});

function mockDatabase() {
  const inserts = [];
  return {
    inserts,
    async run(query) {
      if (query.SELECT) {
        const table = query.SELECT.from.ref[0];
        const selectedId = query.SELECT.where?.find(part => Object.hasOwn(part, 'val'))?.val;
        if (table === 'credit.Customers') {
          const rows = selectedId
            ? customers.filter(customer => customer.ID === selectedId)
            : customers;
          return rows.map(row => ({ ...row }));
        }
        if (table === 'credit.OpenItems') {
          const customerId = selectedId;
          const rows = customerId
            ? openItems.filter(item => item.customer_ID === customerId)
            : openItems;
          return rows.map(row => ({ ...row }));
        }
        if (table === 'credit.Payments') return [];
        if (table === 'credit.LimitRequests') return [];
      }

      if (query.INSERT) {
        inserts.push(...query.INSERT.entries);
        return [];
      }

      throw new Error(`Unexpected query: ${JSON.stringify(query)}`);
    }
  };
}

function providerWithTool(name, input, answer, onRequest = () => {}) {
  let firstCall = true;
  return {
    async complete(request) {
      onRequest(request);
      if (firstCall) {
        firstCall = false;
        const proposal = name === 'prepare_limit_change';
        const toolCall = {
          id: 'scenario-call',
          name: 'create_task_plan',
          input: {
            objective: 'Complete the requested Credit Guard analysis.',
            tasks: [{
              taskId: 'scenario-task',
              description: 'Run the registered Credit Guard operation.',
              toolName: name,
              toolInput: input,
              dependencies: [],
              taskType: proposal ? 'PROPOSAL' : 'READ_ONLY',
              completionCriteria: {
                description: 'Return the registered tool result.',
                requiredFields: proposal ? ['requiresHumanApproval', 'proposal'] : ['ID']
              }
            }]
          }
        };
        return {
          content: [{ type: 'tool_use', ...toolCall }],
          toolCalls: [toolCall],
          text: ''
        };
      }
      return {
        content: [{ type: 'text', text: answer }],
        toolCalls: [],
        text: answer
      };
    }
  };
}

function lastToolResult(messages) {
  const message = messages.findLast(entry =>
    entry.role === 'user' && typeof entry.content === 'string'
      && entry.content.includes('The validated plan execution has finished.'));
  assert.ok(message, 'Expected the agent to provide the tool result to the provider.');
  const execution = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
  return execution.results[0].result;
}

test('scenario 1: customer analysis uses the calculated customer tool and records execution', async () => {
  const db = mockDatabase();
  let lastRequest;
  const result = await chat('Analyse customer C001', db, undefined, reader, {
    provider: providerWithTool('get_customer', { customer_id: 'C001' }, 'C001 is over limit.', request => {
      lastRequest = request;
    })
  });

  const customer = lastToolResult(lastRequest.messages);
  assert.equal(customer.ID, 'C001');
  assert.equal(customer.exposure, 1200);
  assert.equal(customer.utilisation, 1.2);
  assert.equal(result.execution.steps[0].tool, 'get_customer');
  assert.equal(result.execution.status, 'completed');
});

test('scenario 2: customers above 90 percent utilization are filtered from calculated data', async () => {
  const tools = createToolRegistry(mockDatabase(), reader);
  const result = await tools.list_customers_over_threshold({ min_utilisation: 0.9 });

  assert.deepEqual(result.map(customer => customer.ID), ['C001', 'C002']);
  assert.ok(result.every(customer => customer.utilisation >= 0.9));
});

test('scenario 3: overdue high-risk customer is identifiable from risk fields and flags', async () => {
  const tools = createToolRegistry(mockDatabase(), reader);
  const customer = await tools.get_customer({ customer_id: 'C001' });

  assert.equal(customer.riskClass, 'C');
  assert.equal(customer.overdueAmount, 700);
  assert.ok(customer.overdueShare > 0.3);
  assert.ok(customer.flags.includes('OVERDUE_RISK'));
});

test('scenario 4: explanation is grounded in the customer exposure tool result', async () => {
  const db = mockDatabase();
  let lastRequest;
  const result = await chat('Explain why C001 exceeds its credit limit', db, undefined, reader, {
    provider: providerWithTool('get_customer', { customer_id: 'C001' }, 'Exposure is INR 1,200 against an INR 1,000 limit.', request => {
      lastRequest = request;
    })
  });

  const customer = lastToolResult(lastRequest.messages);
  assert.ok(customer.exposure > customer.creditLimit);
  assert.equal(customer.flags.includes('OVERDUE_RISK'), true);
  assert.match(result.reply, /1,200.*1,000/);
});

test('scenario 5: limit increase proposal is validated without creating a request', async () => {
  const db = mockDatabase();
  let lastRequest;
  const result = await chat('Prepare an increase proposal for C002 to 1200 because Confirmed contract renewal', db, undefined, requester, {
    provider: providerWithTool('prepare_limit_change', {
      customer_id: 'C002',
      new_limit: 1200,
      reason: 'Confirmed contract renewal'
    }, 'The proposal is ready for your review.', request => {
      lastRequest = request;
    })
  });

  const proposal = lastToolResult(lastRequest.messages);
  assert.equal(proposal.requiresHumanApproval, true);
  assert.equal(proposal.proposal.customerId, 'C002');
  assert.equal(proposal.proposal.approverLevel, 'Credit Controller');
  assert.equal(result.execution.approvalRequired, true);
  assert.equal(result.preparedActions.length, 1);
  assert.deepEqual(db.inserts, []);
});

test('scenario 6: submission requires a separate human action; agent exposes no decision tool', async () => {
  const db = mockDatabase();
  const tools = createToolRegistry(db, requester);
  let lastRequest;
  const result = await chat('Prepare a credit increase for C002 to 1200 because Confirmed contract renewal', db, undefined, requester, {
    provider: providerWithTool('prepare_limit_change', {
      customer_id: 'C002',
      new_limit: 1200,
      reason: 'Confirmed contract renewal'
    }, 'Please confirm before submitting this proposal.', request => {
      lastRequest = request;
    })
  });

  assert.match(result.reply, /confirm/i);
  assert.equal(result.execution.approvalRequired, true);
  assert.equal(Object.hasOwn(tools, 'submit_limit_request'), false);
  assert.equal(Object.hasOwn(tools, 'approve_limit_request'), false);
  assert.equal(Object.hasOwn(tools, 'reject_limit_request'), false);
  assert.equal(lastRequest.tools.some(tool => /submit|approve|reject/i.test(tool.name)), false);
  assert.deepEqual(db.inserts, []);
});
