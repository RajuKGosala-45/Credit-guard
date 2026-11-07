const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { chat, meetsCompletionCriteria } = require('../srv/agent');

const reader = new cds.User({ id: 'reader', roles: ['CreditReader'] });
const requester = new cds.User({ id: 'requester', roles: ['CreditReader', 'CreditRequester'] });
const now = '2026-11-04T10:00:00.000Z';

function customer(id, creditLimit = 1000) {
  return {
    ID: id,
    name: `Customer ${id}`,
    country: 'India',
    companyCode: 'BS01',
    creditLimit,
    riskClass: 'A',
    lastReviewDate: '2026-02-01'
  };
}

function database(customers = [customer('C001')], { failOpenItems = false, calls = [] } = {}) {
  const items = customers.map((record, index) => ({
    ID: `I${String(index + 1).padStart(3, '0')}`,
    customer_ID: record.ID,
    type: 'Invoice',
    amount: 900,
    status: 'Open',
    dueDate: '2000-01-01'
  }));
  return {
    calls,
    async run(query) {
      if (!query.SELECT) throw new Error('Unexpected non-read query.');
      const table = query.SELECT.from.ref[0];
      const values = query.SELECT.where
        ?.filter(part => Object.hasOwn(part, 'val'))
        .map(part => part.val) || [];
      const selectedId = values.find(value => typeof value === 'string');
      calls.push({ table, selectedId });
      if (table === 'credit.Customers') {
        return selectedId
          ? customers.filter(record => record.ID === selectedId).map(record => ({ ...record }))
          : customers.map(record => ({ ...record }));
      }
      if (table === 'credit.OpenItems') {
        if (failOpenItems) throw new Error('Source unavailable.');
        return items.filter(item => !selectedId || item.customer_ID === selectedId).map(item => ({ ...item }));
      }
      if (table === 'credit.Payments') return [];
      if (table === 'credit.LimitRequests') return [];
      throw new Error(`Unexpected read from ${table}.`);
    }
  };
}

function task(taskId, toolName, toolInput, options = {}) {
  const proposal = toolName === 'prepare_limit_change';
  return {
    taskId,
    description: options.description || `Perform ${toolName}.`,
    toolName,
    toolInput,
    dependencies: options.dependencies || [],
    taskType: proposal ? 'PROPOSAL' : 'READ_ONLY',
    completionCriteria: {
      description: 'Return the registered tool output.',
      requiredFields: options.requiredFields
        || (proposal ? ['requiresHumanApproval', 'proposal'] : ['ID'])
    }
  };
}

function plan(tasks, extra = {}) {
  return {
    objective: 'Complete the requested Credit Guard analysis.',
    tasks,
    ...extra
  };
}

function providerFor(modelPlan, { finalText = 'Analysis complete.', onFinalRequest = () => {} } = {}) {
  return {
    async complete(request) {
      if (request.tools?.some(tool => tool.name === 'create_task_plan')) {
        const call = { id: 'planning-call', name: 'create_task_plan', input: modelPlan };
        return {
          content: [{ type: 'tool_use', ...call }],
          toolCalls: [call],
          text: ''
        };
      }
      onFinalRequest(request);
      return {
        content: [{ type: 'text', text: finalText }],
        toolCalls: [],
        text: finalText
      };
    }
  };
}

test('creates and executes a simple validated read-only plan', async () => {
  const result = await chat(
    'Explain customer C001',
    database(),
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('customer-detail', 'get_customer', { customer_id: 'C001' })
      ]))
    }
  );

  assert.equal(result.plan.status, 'COMPLETED');
  assert.equal(result.plan.tasks[0].status, 'COMPLETED');
  assert.equal(result.plan.tasks[0].attemptCount, 1);
  assert.equal(result.taskResults[0].status, 'SUCCEEDED');
  assert.match(result.reply, /Execution status: COMPLETED \(1\/1 tasks completed\)/);
  assert.equal(Object.hasOwn(result.plan.tasks[0], 'toolInput'), false);
  assert.equal(JSON.stringify(result.plan).includes('C001'), false);
  assert.equal(JSON.stringify(result.execution.plan).includes('C001'), false);
});

test('decomposes a portfolio request and runs dependent customer reads sequentially', async () => {
  const db = database([customer('C001'), customer('C002')]);
  const result = await chat(
    'Find customers above 80% utilization and identify overdue invoices.',
    db,
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('threshold', 'list_customers_over_threshold', { min_utilisation: 0.8 }, {
          requiredFields: ['ID', 'utilisation', 'overdueAmount']
        }),
        task('invoice-details', 'get_customer', {
          customer_id: { $fromTask: 'threshold', field: 'ID', mode: 'each' }
        }, {
          dependencies: ['threshold'],
          requiredFields: ['ID', 'openItems', 'overdueAmount']
        })
      ]))
    }
  );

  assert.equal(result.plan.status, 'COMPLETED');
  assert.deepEqual(result.plan.tasks.map(item => item.status), ['COMPLETED', 'COMPLETED']);
  assert.equal(result.plan.tasks[1].attemptCount, 2);
  assert.deepEqual(result.execution.steps.map(step => step.tool), [
    'list_customers_over_threshold',
    'get_customer',
    'get_customer'
  ]);
  assert.equal(result.execution.steps.every(step => step.status === 'completed'), true);
  assert.equal(result.taskResults[1].summary, 'Retrieved deterministic details for 2 customers.');
  assert.equal(result.execution.plan.tasks[1].dependencies[0], 'threshold');
});

test('resolves a customer name to its identity before retrieving financial detail', async () => {
  const result = await chat(
    'Give complete credit risk status for Customer C001.',
    database([customer('C001')]),
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('find-customer', 'search_customers', { query: 'Customer C001' }, {
          requiredFields: ['ID', 'name']
        }),
        task('customer-detail', 'get_customer', {
          customer_id: { $fromTask: 'find-customer', field: 'ID', mode: 'each' }
        }, {
          dependencies: ['find-customer'],
          requiredFields: ['ID', 'exposure', 'overdueAmount', 'openItems']
        })
      ]))
    }
  );

  assert.equal(result.plan.status, 'COMPLETED');
  assert.deepEqual(result.execution.steps.map(step => step.tool), ['search_customers', 'get_customer']);
  assert.deepEqual(result.modulesUsed, ['Customers', 'Invoices', 'Payments']);
});

test('executes independent read-only tasks sequentially in plan order', async () => {
  const result = await chat(
    'Analyze customers C001 and C002.',
    database([customer('C001'), customer('C002')]),
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('first-customer', 'get_customer', { customer_id: 'C001' }),
        task('second-customer', 'get_customer', { customer_id: 'C002' })
      ]))
    }
  );

  assert.deepEqual(result.execution.steps.map(step => step.tool), ['get_customer', 'get_customer']);
  assert.deepEqual(result.plan.tasks.map(item => item.status), ['COMPLETED', 'COMPLETED']);
  assert.deepEqual(result.plan.tasks.map(item => item.attemptCount), [1, 1]);
});

test('rejects unknown tools, invalid task types, cycles, and permission fields before execution', async () => {
  const invalidPlans = [
    plan([task('unknown', 'run_sql', {})]),
    plan([{
      ...task('bad-type', 'get_customer', { customer_id: 'C001' }),
      taskType: 'WRITE'
    }]),
    plan([
      task('first', 'get_customer', { customer_id: 'C001' }, { dependencies: ['second'] }),
      task('second', 'get_customer', { customer_id: 'C002' }, { dependencies: ['first'] })
    ]),
    { ...plan([task('permission', 'get_customer', { customer_id: 'C001' })]), permissions: ['CreditAdmin'] }
  ];

  for (const invalid of invalidPlans) {
    let toolCalls = 0;
    const result = await chat('Analyze customers', database(), undefined, reader, {
      provider: providerFor(invalid)
    });
    toolCalls += result.execution.steps.length;
    assert.equal(result.plan, null);
    assert.equal(result.execution.planStatus, 'REJECTED');
    assert.equal(toolCalls, 0);
  }
});

test('failed prerequisites block dependent tasks while independent tasks continue', async () => {
  const db = database([customer('C001')], { failOpenItems: true });
  const result = await chat(
    'Review customer utilization and exposure.',
    db,
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('threshold', 'list_customers_over_threshold', { min_utilisation: 0.8 }),
        task('dependent-detail', 'get_customer', {
          customer_id: { $fromTask: 'threshold', field: 'ID', mode: 'each' }
        }, { dependencies: ['threshold'] }),
        task('independent-detail', 'get_customer', { customer_id: 'C001' })
      ]))
    }
  );

  assert.equal(result.plan.tasks[0].status, 'FAILED');
  assert.equal(result.plan.tasks[1].status, 'BLOCKED');
  assert.equal(result.plan.tasks[2].status, 'FAILED');
  assert.equal(result.plan.status, 'BLOCKED');
  assert.equal(result.executionSummary.planStatus, 'BLOCKED');
  assert.equal(result.executionSummary.failed, 2);
  assert.equal(result.executionSummary.blocked, 1);
  assert.equal(result.execution.steps.filter(step => step.tool === 'get_customer').length, 1);
  assert.equal(result.taskResults.every(item => item.status === 'FAILED'), true);
});

test('enforces the global tool-call limit and reports partial fan-out honestly', async () => {
  const customers = [customer('C001'), customer('C002'), customer('C003')];
  const result = await chat(
    'Find all customers above 80% utilization and inspect their invoices.',
    database(customers),
    undefined,
    reader,
    {
      maxToolCalls: 2,
      provider: providerFor(plan([
        task('threshold', 'list_customers_over_threshold', { min_utilisation: 0.8 }, {
          requiredFields: ['ID']
        }),
        task('details', 'get_customer', {
          customer_id: { $fromTask: 'threshold', field: 'ID', mode: 'each' }
        }, {
          dependencies: ['threshold'],
          requiredFields: ['ID']
        })
      ]))
    }
  );

  assert.equal(result.plan.status, 'PARTIALLY_COMPLETED');
  assert.deepEqual(result.plan.tasks.map(item => item.status), ['COMPLETED', 'FAILED']);
  assert.equal(result.plan.tasks[1].attemptCount, 1);
  assert.equal(result.taskResults[1].errorCategory, 'tool_call_limit');
  assert.match(result.taskResults[1].summary, /1 of 3/);
  assert.match(result.reply, /PARTIALLY_COMPLETED/);
});

test('authorization remains enforced at execution and proposal inputs must be explicit', async () => {
  const proposal = task('proposal', 'prepare_limit_change', {
    customer_id: 'C001',
    new_limit: 1200,
    reason: 'Contract renewal'
  });
  const unauthorized = await chat(
    'Prepare a proposal for C001 to 1200 because Contract renewal',
    database(),
    undefined,
    reader,
    { provider: providerFor(plan([proposal])) }
  );
  assert.equal(unauthorized.plan.tasks[0].status, 'FAILED');
  assert.equal(unauthorized.taskResults[0].errorCategory, 'permission_denied');
  assert.deepEqual(unauthorized.preparedActions, []);

  const missingExplicitInputs = await chat(
    'Prepare a credit-limit proposal.',
    database(),
    undefined,
    requester,
    { provider: providerFor(plan([proposal])) }
  );
  assert.equal(missingExplicitInputs.plan.tasks[0].status, 'BLOCKED');
  assert.equal(missingExplicitInputs.plan.status, 'BLOCKED');
  assert.equal(missingExplicitInputs.plan.tasks[0].attemptCount, 0);
  assert.match(missingExplicitInputs.reply, /requested limit, and reason explicitly/i);
});

test('requests clarification when ranking criteria are undefined without running tools', async () => {
  const db = database();
  const result = await chat(
    'Rank high-risk customers.',
    db,
    undefined,
    reader,
    {
      provider: providerFor(plan([
        task('threshold', 'list_customers_over_threshold', { min_utilisation: 0.8 })
      ], { clarificationQuestion: 'Which high-risk ranking criteria should I apply?' }))
    }
  );

  assert.equal(result.plan.status, 'DRAFT');
  assert.equal(result.plan.tasks[0].status, 'PENDING');
  assert.match(result.reply, /which high-risk ranking criteria/i);
  assert.equal(result.execution.steps.length, 0);
  assert.equal(db.calls.length, 0);
});

test('does not invent a high-risk ranking when the model omits clarification', async () => {
  const provider = providerFor(plan([
    task('threshold', 'list_customers_over_threshold', { min_utilisation: 0.8 })
  ]), { finalText: 'Ranked using a newly invented score.'   });
  let modelCalls = 0;
  const monitoredProvider = {
    async complete(request) {
      modelCalls += 1;
      return provider.complete(request);
    }
  };
  const result = await chat(
    'Rank high-risk customers.',
    database(),
    undefined,
    reader,
    { provider: monitoredProvider }
  );

  assert.equal(result.plan.tasks[0].status, 'COMPLETED');
  assert.equal(modelCalls, 1);
  assert.match(result.reply, /No ranking was produced/);
  assert.match(result.reply, /Which existing deterministic field/);
  assert.doesNotMatch(result.reply, /newly invented score/i);
});

  test('retries transient read failures at most twice and records every attempt', async () => {
    const db = database();
    const run = db.run.bind(db);
    let failures = 1;
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.OpenItems' && failures-- > 0) {
        const error = new Error('Temporary private upstream detail.');
        error.code = 'ECONNRESET';
        throw error;
      }
      return run(query);
    };
    const delays = [];
    const result = await chat('Explain customer C001.', db, undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      sleepFn: async delay => delays.push(delay)
    });

    assert.equal(result.plan.tasks[0].status, 'COMPLETED');
    assert.equal(result.plan.tasks[0].attemptCount, 2);
    assert.deepEqual(delays, [100]);
    assert.deepEqual(result.execution.steps.map(step => step.outcome), ['failed', 'completed']);
    assert.equal(result.execution.steps.every(step =>
      !step.summary.includes('Temporary private upstream detail')), true);
  });

  test('retries an individual network timeout when the overall deadline allows it', async () => {
    const db = database();
    const run = db.run.bind(db);
    let failures = 1;
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.OpenItems' && failures-- > 0) {
        const error = new Error('Temporary request timeout.');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return run(query);
    };
    const result = await chat('Explain customer C001.', db, undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      sleepFn: async () => {}
    });
    assert.equal(result.plan.tasks[0].status, 'COMPLETED');
    assert.equal(result.plan.tasks[0].attemptCount, 2);
  });

  test('retries retryable HTTP failures up to the bounded maximum', async () => {
    const db = database();
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.Customers') {
        const error = new Error('Response body must not enter the execution result.');
        error.statusCode = 503;
        throw error;
      }
      return [];
    };
    const delays = [];
    const result = await chat('Explain customer C001.', db, undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      sleepFn: async delay => delays.push(delay)
    });

    assert.equal(result.plan.tasks[0].status, 'FAILED');
    assert.equal(result.plan.tasks[0].attemptCount, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.deepEqual(result.execution.steps.map(step => step.errorCategory), [
      'upstream_unavailable',
      'upstream_unavailable',
      'upstream_unavailable'
    ]);
    assert.equal(JSON.stringify(result).includes('Response body must not enter'), false);
  });

  test('retries HTTP 429, 500, 502, and 504 as transient read failures', async t => {
    for (const statusCode of [429, 500, 502, 504]) {
      await t.test(`HTTP ${statusCode}`, async () => {
        const db = database();
        db.run = async () => {
          const error = new Error('private upstream body');
          error.statusCode = statusCode;
          throw error;
        };
        const result = await chat('Explain customer C001.', db, undefined, reader, {
          provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
          sleepFn: async () => {}
        });
        assert.equal(result.plan.tasks[0].attemptCount, 3);
        assert.equal(result.plan.tasks[0].status, 'FAILED');
        assert.equal(JSON.stringify(result).includes('private upstream body'), false);
      });
    }
  });

  test('does not retry authentication or validation failures', async t => {
    for (const [label, failure] of [
      ['HTTP 401', Object.assign(new Error('private response body'), { statusCode: 401 })],
      ['HTTP 403', Object.assign(new Error('private response body'), { statusCode: 403 })],
      ['HTTP 400', Object.assign(new Error('private response body'), { statusCode: 400 })],
      ['wrapped ABAP HTTP 401', Object.assign(new Error('sanitized ABAP error'), {
        statusCode: 502,
        cause: { response: { status: 401 } }
      })],
      ['wrapped ABAP HTTP 400', Object.assign(new Error('sanitized ABAP error'), {
        statusCode: 502,
        cause: { response: { status: 400 } }
      })],
      ['invalid input', new TypeError('private input value')]
    ]) {
      await t.test(label, async () => {
        const db = database();
        db.run = async () => { throw failure; };
        const result = await chat('Explain customer C001.', db, undefined, reader, {
          provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
          sleepFn: async () => assert.fail('A permanent error must not be retried.')
        });
        assert.equal(result.plan.tasks[0].attemptCount, 1);
        assert.equal(result.plan.tasks[0].status, 'FAILED');
        if (label === 'wrapped ABAP HTTP 401') {
          assert.equal(result.taskResults[0].errorCategory, 'permission_denied');
        }
        if (label === 'wrapped ABAP HTTP 400') {
          assert.equal(result.taskResults[0].errorCategory, 'invalid_input');
        }
        assert.equal(JSON.stringify(result).includes('private response body'), false);
        assert.equal(JSON.stringify(result).includes('private input value'), false);
      });
    }
  });

  test('execution budget prevents a retry when no tool-call capacity remains', async () => {
    const db = database();
    db.run = async () => {
      const error = new Error('temporary');
      error.code = 'ECONNRESET';
      throw error;
    };
    const result = await chat('Explain customer C001.', db, undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      maxToolCalls: 1,
      sleepFn: async () => {}
    });

    assert.equal(result.plan.tasks[0].attemptCount, 1);
    assert.equal(result.taskResults[0].errorCategory, 'tool_call_limit');
  });

  test('overall deadline prevents a retry when insufficient time remains', async () => {
    const db = database();
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.OpenItems') {
        await new Promise(resolve => setTimeout(resolve, 80));
        const error = new Error('Delayed network failure.');
        error.code = 'ECONNRESET';
        throw error;
      }
      return query.SELECT?.from.ref[0] === 'credit.Customers' ? [customer('C001')] : [];
    };
    const result = await chat('Explain customer C001.', db, undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      timeoutMs: 200,
      sleepFn: async () => assert.fail('There is insufficient time for backoff and another attempt.')
    });
    assert.equal(result.plan.tasks[0].attemptCount, 1);
    assert.equal(result.plan.tasks[0].status, 'FAILED');
  });

  test('proposal operations are never retried after a transient server failure', async () => {
    const db = database();
    db.run = async () => {
      const error = new Error('private proposal backend detail');
      error.statusCode = 503;
      throw error;
    };
    const proposal = task('proposal', 'prepare_limit_change', {
      customer_id: 'C001',
      new_limit: 1200,
      reason: 'Contract renewal'
    });
    const result = await chat(
      'Prepare a proposal for C001 to 1200 because Contract renewal.',
      db,
      undefined,
      requester,
      {
        provider: providerFor(plan([proposal])),
        sleepFn: async () => assert.fail('Proposal operations must not be retried.')
      }
    );
    assert.equal(result.plan.tasks[0].attemptCount, 1);
    assert.equal(result.plan.tasks[0].status, 'FAILED');
    assert.equal(JSON.stringify(result).includes('private proposal backend detail'), false);
  });

  test('legitimate empty read-only lists are successful and clearly summarized', async t => {
    const cases = [
      {
        name: 'no customers above the threshold',
        toolName: 'list_customers_over_threshold',
        input: { min_utilisation: 0.8 },
        summary: 'Retrieved 0 customer summaries from the configured utilization threshold.'
      },
      {
        name: 'no exposure groups',
        toolName: 'exposure_by',
        input: { group: 'country' },
        requiredFields: ['label', 'exposure', 'creditLimit'],
        summary: 'Completed the authorized registered-tool operation.'
      },
      {
        name: 'no pending requests',
        toolName: 'list_limit_requests',
        input: { status: 'Pending' },
        summary: 'No pending credit-limit requests were found.'
      }
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const result = await chat(`Run ${scenario.name}.`, database([]), undefined, reader, {
          provider: providerFor(plan([task('empty-list', scenario.toolName, scenario.input, {
            requiredFields: scenario.requiredFields
          })]))
        });

        assert.equal(result.plan.tasks[0].status, 'COMPLETED');
        assert.equal(result.taskResults[0].status, 'SUCCEEDED');
        assert.equal(result.taskResults[0].summary, scenario.summary);
        assert.equal(result.executionSummary.completed, 1);
        assert.equal(result.executionSummary.failed, 0);
      });
    }
  });

  test('valid non-empty read-only list results remain successful', async () => {
    const db = database();
    const originalRun = db.run.bind(db);
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.LimitRequests') {
        return [{ ID: 'R001', status: 'Pending', customer_ID: 'C001' }];
      }
      return originalRun(query);
    };
    const result = await chat('List pending requests.', db, undefined, reader, {
      provider: providerFor(plan([
        task('pending-requests', 'list_limit_requests', { status: 'Pending' })
      ]))
    });

    assert.equal(result.plan.tasks[0].status, 'COMPLETED');
    assert.equal(result.taskResults[0].status, 'SUCCEEDED');
  });

  test('tool result validation rejects null, undefined, and malformed values', () => {
    const listTask = task('pending-requests', 'list_limit_requests', { status: 'Pending' });
    const validRow = { ID: 'R001', status: 'Pending', customer_ID: 'C001' };
    assert.equal(meetsCompletionCriteria(listTask, []), true);
    assert.equal(meetsCompletionCriteria(listTask, [validRow]), true);
    assert.equal(meetsCompletionCriteria(listTask, null), false);
    assert.equal(meetsCompletionCriteria(listTask, undefined), false);
    assert.equal(meetsCompletionCriteria(listTask, [null]), false);
    assert.equal(meetsCompletionCriteria(listTask, [{ ID: 'R001' }]), false);
    assert.equal(meetsCompletionCriteria(listTask, {}), false);
  });

  test('empty arrays are not accepted from tools whose result contract is an object', () => {
    const customerTask = task('customer-detail', 'get_customer', { customer_id: 'C001' });
    assert.equal(meetsCompletionCriteria(customerTask, []), false);
    assert.equal(meetsCompletionCriteria(customerTask, null), false);
  });

  test('an actual tool failure remains a failed task, not an empty success', async () => {
    const result = await chat(
      'Explain customer C001.',
      database([customer('C001')], { failOpenItems: true }),
      undefined,
      reader,
      {
        provider: providerFor(plan([
          task('customer-detail', 'get_customer', { customer_id: 'C001' })
        ]))
      }
    );

    assert.equal(result.plan.tasks[0].status, 'FAILED');
    assert.equal(result.taskResults[0].status, 'FAILED');
    assert.equal(result.executionSummary.failed, 1);
  });

  test('empty list results remain valid when resuming an eligible plan', async () => {
    const savedPlan = {
      planId: 'empty-recovery-plan',
      version: 1,
      objective: 'Check pending requests.',
      status: 'PARTIALLY_COMPLETED',
      createdAt: now,
      tasks: [
        {
          ...task('completed-read', 'get_customer', { customer_id: 'C001' }),
          requiredInputs: ['customer_id'],
          status: 'COMPLETED',
          attemptCount: 1,
          startedAt: now,
          completedAt: now
        },
        {
          ...task('pending-requests', 'list_limit_requests', { status: 'Pending' }),
          requiredInputs: ['status'],
          status: 'PENDING',
          attemptCount: 0
        }
      ]
    };
    const result = await chat('Resume the saved execution.', database(), undefined, reader, {
      executionId: 'empty-recovery-execution',
      resumePlan: savedPlan,
      taskResults: [{
        taskId: 'completed-read',
        status: 'SUCCEEDED',
        summary: 'Previously completed customer analysis.',
        completedAt: now
      }],
      provider: providerFor(null)
    });

    assert.deepEqual(result.plan.tasks.map(item => item.status), ['COMPLETED', 'COMPLETED']);
    assert.equal(result.taskResults[1].status, 'SUCCEEDED');
    assert.equal(result.taskResults[1].summary, 'No pending credit-limit requests were found.');
    assert.equal(result.executionSummary.completed, 2);
  });

  test('malformed registered-tool output is not marked successful', async () => {
    const db = database();
    const originalRun = db.run.bind(db);
    db.run = async query => {
      if (query.SELECT?.from.ref[0] === 'credit.LimitRequests') return [{ ID: 'R001' }];
      return originalRun(query);
    };
    const result = await chat('List pending requests.', db, undefined, reader, {
      provider: providerFor(plan([
        task('pending-requests', 'list_limit_requests', { status: 'Pending' })
      ]))
    });

    assert.equal(result.plan.tasks[0].status, 'FAILED');
    assert.equal(result.taskResults[0].status, 'FAILED');
    assert.equal(result.taskResults[0].errorCategory, 'invalid_result');
    assert.equal(result.executionSummary.failed, 1);
  });

  test('resumes eligible work without repeating completed tasks', async () => {
    const savedPlan = {
      planId: 'recovery-plan',
      version: 1,
      objective: 'Review two customers.',
      status: 'PARTIALLY_COMPLETED',
      createdAt: now,
      tasks: [
        {
          ...task('first-customer', 'get_customer', { customer_id: 'C001' }),
          requiredInputs: ['customer_id'],
          status: 'COMPLETED',
          attemptCount: 1,
          startedAt: now,
          completedAt: now
        },
        {
          ...task('second-customer', 'get_customer', { customer_id: 'C002' }),
          requiredInputs: ['customer_id'],
          status: 'PENDING',
          attemptCount: 0
        }
      ]
    };
    const db = database([customer('C001'), customer('C002')]);
    const result = await chat('Resume the saved execution.', db, undefined, reader, {
      executionId: 'saved-execution',
      resumePlan: savedPlan,
      taskResults: [{
        taskId: 'first-customer',
        status: 'SUCCEEDED',
        summary: 'Previously completed customer analysis.',
        completedAt: now
      }],
      provider: providerFor(null)
    });

    assert.equal(result.execution.id, 'saved-execution');
    assert.deepEqual(result.plan.tasks.map(item => item.status), ['COMPLETED', 'COMPLETED']);
    assert.deepEqual(result.plan.tasks.map(item => item.attemptCount), [1, 1]);
    assert.equal(
      db.calls.filter(call => call.table === 'credit.Customers' && call.selectedId === 'C002').length,
      1
    );
    assert.equal(result.executionSummary.completed, 2);
  });

  test('persists progress checkpoints while keeping execution responses minimized', async () => {
    const checkpoints = [];
    const result = await chat('Explain customer C001.', database(), undefined, reader, {
      provider: providerFor(plan([task('customer-detail', 'get_customer', { customer_id: 'C001' })])),
      executionStore: {
        async persist(execution) {
          checkpoints.push(structuredClone(execution));
          return { ID: execution.id, recoveryStatus: execution.status === 'running' ? 'ACTIVE' : 'NOT_AVAILABLE' };
        }
      }
    });

    assert.ok(checkpoints.length >= 5);
    assert.ok(checkpoints.some(checkpoint => checkpoint.recoveryPlan?.tasks[0].status === 'RUNNING'));
    assert.ok(checkpoints.some(checkpoint => checkpoint.steps.some(step => step.attempt === 1)));
    assert.equal(result.executionSummary.executionId, result.execution.id);
    assert.equal(Object.hasOwn(result.execution, 'recoveryPlan'), false);
    assert.equal(Object.hasOwn(result.execution, 'recoveryData'), false);
    assert.equal(JSON.stringify(result).includes('C001'), false);
  });
test('preserves partial execution state when the global timeout expires', async () => {
  const db = {
    async run() {
      return new Promise(() => {});
    }
  };
  await assert.rejects(
    chat('Analyze C001', db, undefined, reader, {
      provider: providerFor(plan([
        task('customer-detail', 'get_customer', { customer_id: 'C001' })
      ])),
      timeoutMs: 10
    }),
    error => error.category === 'execution_timeout'
      && error.execution.planStatus === 'FAILED'
      && error.execution.plan.tasks[0].status === 'FAILED'
      && error.execution.plan.tasks[0].attemptCount <= 1
      && error.execution.taskResults[0].errorCategory === 'execution_timeout'
  );
});
