const test = require('node:test');
const assert = require('node:assert/strict');
const { toolDefinitions } = require('../srv/agent');
const {
  MAX_PLAN_TASKS,
  PLAN_VERSION,
  validatePlan,
  validateTaskResult
} = require('../srv/agentPlan');

const now = '2026-11-04T10:00:00.000Z';

function readTask(taskId, overrides = {}) {
  return {
    taskId,
    description: 'Read customers at or above the requested utilization.',
    toolName: 'list_customers_over_threshold',
    toolInput: { min_utilisation: 0.8 },
    dependencies: [],
    taskType: 'READ_ONLY',
    requiredInputs: ['min_utilisation'],
    completionCriteria: {
      description: 'Return customers meeting the utilization threshold.',
      requiredFields: ['ID', 'utilisation']
    },
    status: 'PENDING',
    attemptCount: 0,
    ...overrides
  };
}

function proposalTask(taskId, overrides = {}) {
  return readTask(taskId, {
    description: 'Prepare a validated proposal for explicit user review.',
    toolName: 'prepare_limit_change',
    toolInput: {
      customer_id: 'C001',
      new_limit: 1200,
      reason: 'Contract renewal'
    },
    taskType: 'PROPOSAL',
    requiredInputs: ['customer_id', 'new_limit', 'reason'],
    completionCriteria: {
      description: 'Return a validated proposal without submitting it.',
      requiredFields: ['proposal', 'requiresHumanApproval']
    },
    ...overrides
  });
}

function makePlan(tasks = [readTask('read-customers')], overrides = {}) {
  return {
    planId: 'plan-001',
    version: PLAN_VERSION,
    objective: 'Review customers with high credit utilization.',
    status: 'DRAFT',
    tasks,
    createdAt: now,
    ...overrides
  };
}

function validate(plan, options = {}) {
  return validatePlan(plan, { toolDefinitions, ...options });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepts a valid versioned read-only and proposal plan with dependencies', () => {
  const plan = makePlan([
    readTask('read-customers'),
    proposalTask('prepare-follow-up', { dependencies: ['read-customers'] })
  ]);
  const result = validate(plan);

  assert.equal(result.planId, 'plan-001');
  assert.equal(result.version, 1);
  assert.equal(result.tasks[0].taskType, 'READ_ONLY');
  assert.equal(result.tasks[1].taskType, 'PROPOSAL');
  assert.deepEqual(result.tasks[1].dependencies, ['read-customers']);
  assert.notEqual(result.tasks, plan.tasks);
});

test('rejects missing plan and task fields', () => {
  const noCreatedAt = makePlan();
  delete noCreatedAt.createdAt;
  assert.throws(() => validate(noCreatedAt), /missing createdAt/);

  const noCriteria = makePlan([readTask('task-1')]);
  delete noCriteria.tasks[0].completionCriteria;
  assert.throws(() => validate(noCriteria), /missing completionCriteria/);

  const noToolName = makePlan([readTask('task-1')]);
  delete noToolName.tasks[0].toolName;
  assert.throws(() => validate(noToolName), /missing toolName/);
});

test('rejects invalid and duplicate plan or task identifiers', () => {
  assert.throws(() => validate(makePlan([readTask('not a valid ID')])), /Task ID is invalid/);
  assert.throws(() => validate(makePlan([readTask('task-1'), readTask('task-1')])), /Duplicate task ID/);
  assert.throws(() => validate(makePlan(), { maxTasks: 0 }), /Maximum task count/);
});

test('rejects unknown tools and invalid task types, task statuses, or plan statuses', () => {
  assert.throws(
    () => validate(makePlan([readTask('task-1', { toolName: 'run_sql' })])),
    /Unknown tool name/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { taskType: 'WRITE' })])),
    /invalid task type/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { status: 'DONE' })])),
    /invalid status/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1')], { status: 'UNKNOWN' })),
    /invalid status/
  );
});

test('rejects missing tool inputs, unsupported tool inputs, and invalid completion criteria', () => {
  assert.throws(
    () => validate(makePlan([readTask('task-1', { requiredInputs: [] })])),
    /omits a required input/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { requiredInputs: ['customer_password'] })])),
    /input not accepted/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { completionCriteria: { description: '' , requiredFields: [] } })])),
    /Completion criteria description/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', {
      completionCriteria: { description: 'Done', requiredFields: ['result', 'result'] }
    })])),
    /must not contain duplicates/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', {
      completionCriteria: { description: 'Done', requiredFields: [] }
    })])),
    /completion criteria unsupported/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', {
      completionCriteria: { description: 'Done', requiredFields: ['notAResultField'] }
    })])),
    /completion criteria unsupported/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', {
      toolName: 'get_customer',
      toolInput: { customer_id: '' },
      requiredInputs: ['customer_id']
    })])),
    /must be non-empty text/
  );
});

test('rejects nonexistent and circular dependencies', () => {
  assert.throws(
    () => validate(makePlan([readTask('task-1', { dependencies: ['missing-task'] })])),
    /nonexistent task/
  );
  assert.throws(
    () => validate(makePlan([
      readTask('task-1', { dependencies: ['task-2'] }),
      readTask('task-2', { dependencies: ['task-1'] })
    ])),
    /circular dependencies/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { dependencies: ['task-1'] })])),
    /cannot depend on itself/
  );
});

test('READY tasks require every dependency to be COMPLETED', () => {
  for (const status of ['PENDING', 'READY', 'RUNNING', 'FAILED', 'BLOCKED', 'SKIPPED']) {
    const prerequisite = readTask('prerequisite', { status });
    const dependent = readTask('dependent', {
      dependencies: ['prerequisite'],
      status: 'READY'
    });
    assert.throws(
      () => validate(makePlan([prerequisite, dependent])),
      /cannot be READY until all dependencies are COMPLETED/
    );
  }

  const readyRoot = readTask('root', { status: 'READY' });
  assert.equal(validate(makePlan([readyRoot])).tasks[0].status, 'READY');

  const completedPrerequisite = readTask('prerequisite', { status: 'COMPLETED' });
  const readyDependent = readTask('dependent', {
    dependencies: ['prerequisite'],
    status: 'READY'
  });
  assert.equal(validate(makePlan([completedPrerequisite, readyDependent])).tasks[1].status, 'READY');
});

test('validates bounded dynamic customer references and dependency outputs', () => {
  const threshold = readTask('threshold');
  const details = readTask('details', {
    toolName: 'get_customer',
    toolInput: {
      customer_id: { $fromTask: 'threshold', field: 'ID', mode: 'each' }
    },
    dependencies: ['threshold'],
    requiredInputs: ['customer_id'],
    completionCriteria: {
      description: 'Retrieve deterministic customer and invoice details.',
      requiredFields: ['ID', 'openItems']
    }
  });
  assert.equal(validate(makePlan([threshold, details])).tasks[1].toolName, 'get_customer');

  const invalidField = clone(details);
  invalidField.toolInput.customer_id.field = 'name';
  assert.throws(() => validate(makePlan([threshold, invalidField])), /field not guaranteed/);

  const proposalReference = proposalTask('proposal', {
    toolInput: {
      customer_id: { $fromTask: 'threshold', field: 'ID', mode: 'each' },
      new_limit: 1200,
      reason: 'Contract renewal'
    },
    dependencies: ['threshold']
  });
  assert.throws(() => validate(makePlan([threshold, proposalReference])), /explicitly provided/);
});

test('enforces configurable task-count bounds and the hard maximum', () => {
  const twoTasks = [readTask('task-1'), readTask('task-2')];
  assert.equal(validate(makePlan(twoTasks), { maxTasks: 2 }).tasks.length, 2);
  assert.throws(
    () => validate(makePlan(twoTasks), { maxTasks: 1 }),
    /between 1 and 1 tasks/
  );

  const overMaximum = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_value, index) =>
    readTask(`task-${index + 1}`));
  assert.throws(() => validate(makePlan(overMaximum)), /between 1 and 12 tasks/);
  assert.throws(() => validate(makePlan(), { maxTasks: MAX_PLAN_TASKS + 1 }), /Maximum task count/);
});

test('requires proposal classification for proposal tools and rejects proposal tools as read-only', () => {
  assert.throws(
    () => validate(makePlan([readTask('task-1', {
      toolName: 'prepare_limit_change',
      requiredInputs: ['customer_id', 'new_limit', 'reason']
    })])),
    /task type that does not match/
  );
  assert.throws(
    () => validate(makePlan([proposalTask('task-1', { toolName: 'get_customer' })])),
    /task type that does not match/
  );
  assert.equal(validate(makePlan([proposalTask('task-1')])).tasks[0].taskType, 'PROPOSAL');
});

test('plans cannot add permissions, executable instructions, or unknown contract fields', () => {
  for (const key of ['permissions', 'roles', 'authorization', 'sql', 'shell', 'code', 'functionName']) {
    const plan = makePlan();
    plan[key] = 'untrusted instruction';
    assert.throws(() => validate(plan), new RegExp(`unsupported field: ${key}`));
  }
  const taskPlan = makePlan([readTask('task-1', { sql: 'SELECT * FROM Customers' })]);
  assert.throws(() => validate(taskPlan), /unsupported field: sql/);
  assert.throws(() => validatePlan(makePlan()), /tool definitions are required/);
});

test('allows partial completion only when completed and incomplete tasks are both represented', () => {
  const partial = makePlan([
    readTask('task-1', { status: 'COMPLETED' }),
    readTask('task-2', { status: 'BLOCKED' })
  ], { status: 'PARTIALLY_COMPLETED' });
  assert.equal(validate(partial).status, 'PARTIALLY_COMPLETED');

  assert.throws(
    () => validate(makePlan([readTask('task-1')], { status: 'COMPLETED' })),
    /every task completed/
  );
  assert.throws(
    () => validate(makePlan([readTask('task-1', { status: 'COMPLETED' })], {
      status: 'PARTIALLY_COMPLETED'
    })),
    /both completed and incomplete/
  );
});

test('validates bounded task results and sanitized failure categories', () => {
  const plan = validate(makePlan());
  const success = validateTaskResult({
    taskId: 'read-customers',
    status: 'SUCCEEDED',
    summary: 'Retrieved qualifying customer summaries.',
    sourceInfo: { source: 'Credit Guard local database', retrievedAt: now },
    completedAt: now
  }, plan);
  assert.equal(success.status, 'SUCCEEDED');

  const failure = validateTaskResult({
    taskId: 'read-customers',
    status: 'FAILED',
    summary: 'Customer data could not be retrieved.',
    completedAt: now,
    errorCategory: 'source_unavailable'
  }, plan);
  assert.equal(failure.errorCategory, 'source_unavailable');
  assert.throws(() => validateTaskResult({
    taskId: 'read-customers',
    status: 'FAILED',
    summary: 'Failure.',
    completedAt: now
  }), /requires a sanitized error category/);
  assert.throws(() => validateTaskResult({
    taskId: 'read-customers',
    status: 'SUCCEEDED',
    summary: 'Success.',
    completedAt: now,
    errorCategory: 'raw_provider_body'
  }), /cannot contain an error category/);
  assert.throws(() => validateTaskResult({
    taskId: 'unknown-task',
    status: 'SUCCEEDED',
    summary: 'Success.',
    completedAt: now
  }, plan), /unknown task/);
  assert.throws(() => validateTaskResult({
    taskId: 'read-customers',
    status: 'SUCCEEDED',
    summary: 'Success.',
    completedAt: now,
    rawResult: { customer: 'unnecessary detail' }
  }), /unsupported field: rawResult/);
});

test('does not mutate the supplied plan while validating it', () => {
  const plan = makePlan();
  const before = clone(plan);
  validate(plan);
  assert.deepEqual(plan, before);
});
