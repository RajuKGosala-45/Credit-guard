const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  claimExecutionRecovery,
  getExecution,
  getExecutionForRecovery,
  listExecutions,
  recordExecution
} = require('../srv/agentStore');

let db;
test.before(async () => {
  db = await cds.connect.to('sqlite::memory:');
  await cds.deploy('db/schema.cds').to(db);
});

test.after(async () => {
  await db.disconnect();
});

function plan(taskStatus = 'PENDING') {
  return {
    planId: 'persisted-plan',
    version: 1,
    objective: 'Review customer data.',
    status: 'PARTIALLY_COMPLETED',
    createdAt: '2026-11-04T10:00:00.000Z',
    tasks: [{
      taskId: 'customer-read',
      description: 'Read one customer record.',
      toolName: 'get_customer',
      toolInput: { customer_id: 'C001' },
      dependencies: [],
      taskType: 'READ_ONLY',
      requiredInputs: ['customer_id'],
      completionCriteria: {
        description: 'Return a validated customer record.',
        requiredFields: ['ID']
      },
      status: taskStatus,
      attemptCount: taskStatus === 'RUNNING' ? 1 : 0,
      ...(taskStatus === 'RUNNING' ? { startedAt: '2026-11-04T10:00:00.000Z' } : {})
    }]
  };
}

function execution(id, overrides = {}) {
  return {
    id,
    status: 'failed',
    startedAt: '2026-11-04T10:00:00.000Z',
    completedAt: '2026-11-04T10:00:01.000Z',
    steps: [{
      tool: 'get_customer',
      status: 'failed',
      outcome: 'failed',
      summary: 'Tool execution failed.',
      startedAt: '2026-11-04T10:00:00.000Z',
      completedAt: '2026-11-04T10:00:01.000Z',
      taskId: 'customer-read',
      attempt: 1,
      errorCategory: 'network_error'
    }],
    recoveryPlan: plan(),
    taskResults: [],
    recoveryData: { threshold: ['C001'] },
    ...overrides
  };
}

test('persists and reloads progress while hiding recovery-only data from reads', async () => {
  const record = execution('10000000-0000-4000-8000-000000000001');
  const saved = await recordExecution(db, 'owner-a', null, record);
  assert.equal(saved.recoveryStatus, 'AVAILABLE');

  const internal = await getExecutionForRecovery(db, 'owner-a', saved.ID);
  assert.equal(internal.plan.tasks[0].toolInput.customer_id, 'C001');
  assert.deepEqual(internal.recoveryData, { threshold: ['C001'] });

  const safe = await getExecution(db, 'owner-a', saved.ID);
  assert.equal(Object.hasOwn(safe, 'recoveryData'), false);
  assert.equal(Object.hasOwn(safe.plan.tasks[0], 'toolInput'), false);
  await assert.rejects(getExecution(db, 'owner-b', saved.ID), error => error.statusCode === 404);
});

test('updates each attempt outcome rather than leaving a stale persisted step', async () => {
  const record = execution('10000000-0000-4000-8000-000000000002');
  await recordExecution(db, 'owner-a', null, record);
  record.steps[0] = {
    ...record.steps[0],
    status: 'completed',
    outcome: 'completed',
    summary: 'Completed a read-only credit operation.',
    completedAt: '2026-11-04T10:00:02.000Z',
    errorCategory: null
  };
  await recordExecution(db, 'owner-a', null, record);

  const saved = await getExecution(db, 'owner-a', record.id);
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].outcome, 'completed');
  assert.equal(saved.steps[0].attempt, 1);
});

test('owner-scoped recovery claims allow only one concurrent claimant', async () => {
  const record = execution('10000000-0000-4000-8000-000000000003');
  await recordExecution(db, 'owner-a', null, record);
  const claims = await Promise.allSettled([
    claimExecutionRecovery(db, 'owner-a', record.id),
    claimExecutionRecovery(db, 'owner-a', record.id)
  ]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(item => item.status === 'rejected').length, 1);

  await assert.rejects(
    claimExecutionRecovery(db, 'owner-b', record.id),
    error => error.statusCode === 404
  );
});

test('a stale running task is marked for manual review instead of repeated', async () => {
  const record = execution('10000000-0000-4000-8000-000000000004', {
    status: 'running',
    completedAt: null,
    recoveryPlan: plan('RUNNING')
  });
  await recordExecution(db, 'owner-a', null, record);
  await db.run(cds.ql.UPDATE('credit.AgentExecutions')
    .set({ updatedAt: '2026-11-04T09:00:00.000Z' })
    .where({ ID: record.id }));

  await assert.rejects(
    claimExecutionRecovery(db, 'owner-a', record.id, new Date('2026-11-04T10:02:00.000Z')),
    error => error.statusCode === 409 && /manual review/i.test(error.message)
  );
  const saved = await getExecutionForRecovery(db, 'owner-a', record.id);
  assert.equal(saved.recoveryStatus, 'MANUAL_REVIEW');
  assert.equal(saved.planStatus, 'FAILED');
  assert.equal(saved.plan.status, 'FAILED');
});

test('stored proposal inputs are replaced with safe placeholders', async () => {
  const proposalPlan = plan();
  proposalPlan.tasks[0] = {
    ...proposalPlan.tasks[0],
    toolName: 'prepare_limit_change',
    toolInput: {
      customer_id: 'C001',
      new_limit: 1234567,
      reason: 'Sensitive renewal detail'
    },
    taskType: 'PROPOSAL',
    requiredInputs: ['customer_id', 'new_limit', 'reason']
  };
  const record = execution('10000000-0000-4000-8000-000000000005', {
    recoveryPlan: proposalPlan
  });
  await recordExecution(db, 'owner-a', null, record);

  const saved = await getExecutionForRecovery(db, 'owner-a', record.id);
  assert.deepEqual(saved.plan.tasks[0].toolInput, {
    customer_id: 'REDACTED',
    new_limit: 1,
    reason: 'REDACTED'
  });
  assert.equal(JSON.stringify(saved.plan).includes('Sensitive renewal detail'), false);
  assert.equal((await listExecutions(db, 'owner-a')).some(item => item.ID === record.id), true);
});

test('clarification drafts are not exposed as automatically recoverable work', async () => {
  const draftPlan = plan();
  draftPlan.status = 'DRAFT';
  const record = execution('10000000-0000-4000-8000-000000000006', {
    status: 'completed',
    recoveryPlan: draftPlan
  });
  const saved = await recordExecution(db, 'owner-a', null, record);
  assert.equal(saved.recoveryStatus, 'NOT_AVAILABLE');
  await assert.rejects(
    claimExecutionRecovery(db, 'owner-a', record.id),
    error => error.statusCode === 409
  );
});
