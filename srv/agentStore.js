const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const MEMORY_ENABLED = process.env.AGENT_MEMORY_ENABLED === 'true';
const MAX_CONVERSATION_MESSAGES = 12;
const RECOVERY_STALE_MS = 60000;

function validateConversationId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new TypeError('Conversation ID is invalid.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function storagePlan(plan) {
  if (!plan) return null;
  return {
    ...plan,
    tasks: plan.tasks.map(task => task.taskType === 'PROPOSAL'
      ? {
        ...task,
        toolInput: {
          customer_id: 'REDACTED',
          new_limit: 1,
          reason: 'REDACTED'
        }
      }
      : task)
  };
}

async function getOrCreateConversation(db, ownerId, requestedId) {
  if (!MEMORY_ENABLED) return null;
  const conversationId = validateConversationId(requestedId);
  if (conversationId) {
    const existing = (await db.run(SELECT.from('credit.AgentConversations')
      .where({ ID: conversationId, owner_ID: ownerId })))[0];
    if (!existing) {
      const error = new Error('Conversation was not found.');
      error.statusCode = 404;
      throw error;
    }
    return conversationId;
  }

  const ID = randomUUID();
  const now = new Date().toISOString();
  await db.run(INSERT.into('credit.AgentConversations').entries({
    ID, owner_ID: ownerId, createdAt: now, updatedAt: now
  }));
  return ID;
}

async function loadConversationMessages(db, conversationId, ownerId) {
  if (!MEMORY_ENABLED || !conversationId) return [];
  const query = SELECT.from('credit.AgentMessages')
    .where({ conversation_ID: conversationId, owner_ID: ownerId })
    .orderBy('createdAt desc')
    .limit(MAX_CONVERSATION_MESSAGES);
  return (await db.run(query)).reverse().map(({ role, content }) => ({ role, content }));
}

async function saveConversationTurn(db, conversationId, ownerId, userText, assistantText) {
  if (!MEMORY_ENABLED || !conversationId) return;
  const now = new Date().toISOString();
  await db.tx(async tx => {
    await tx.run(INSERT.into('credit.AgentMessages').entries([
      { ID: randomUUID(), conversation_ID: conversationId, owner_ID: ownerId, role: 'user', content: userText, createdAt: now },
      { ID: randomUUID(), conversation_ID: conversationId, owner_ID: ownerId, role: 'assistant', content: assistantText, createdAt: now }
    ]));
    await tx.run(UPDATE('credit.AgentConversations')
      .set({ updatedAt: now })
      .where({ ID: conversationId, owner_ID: ownerId }));
  });
}

async function listConversations(db, ownerId) {
  if (!MEMORY_ENABLED) return [];
  const conversations = await db.run(SELECT.from('credit.AgentConversations')
    .where({ owner_ID: ownerId }).orderBy('updatedAt desc').limit(50));
  const results = [];
  for (const conversation of conversations) {
    const latest = (await db.run(SELECT.from('credit.AgentMessages')
      .where({ conversation_ID: conversation.ID, owner_ID: ownerId })
      .orderBy('createdAt desc').limit(1)))[0];
    results.push({ ...conversation, preview: latest?.content.slice(0, 160) || '' });
  }
  return results;
}

async function readConversation(db, ownerId, conversationId) {
  const requestedId = validateConversationId(conversationId);
  const conversation = (await db.run(SELECT.from('credit.AgentConversations')
    .where({ ID: requestedId, owner_ID: ownerId })))[0];
  if (!conversation) {
    const error = new Error('Conversation was not found.');
    error.statusCode = 404;
    throw error;
  }
  const messages = await db.run(SELECT.from('credit.AgentMessages')
    .where({ conversation_ID: requestedId, owner_ID: ownerId })
    .orderBy('createdAt asc'));
  return { ...conversation, messages };
}

async function clearConversations(db, ownerId, conversationId) {
  if (conversationId) {
    const requestedId = validateConversationId(conversationId);
    const existing = (await db.run(SELECT.from('credit.AgentConversations')
      .where({ ID: requestedId, owner_ID: ownerId })))[0];
    if (!existing) {
      const error = new Error('Conversation was not found.');
      error.statusCode = 404;
      throw error;
    }
    await db.tx(async tx => {
      await tx.run(DELETE.from('credit.AgentMessages')
        .where({ conversation_ID: requestedId, owner_ID: ownerId }));
      await tx.run(DELETE.from('credit.AgentConversations')
        .where({ ID: requestedId, owner_ID: ownerId }));
    });
    return 1;
  }

  const owned = await db.run(SELECT.from('credit.AgentConversations')
    .where({ owner_ID: ownerId }));
  await db.tx(async tx => {
    for (const conversation of owned) {
      await tx.run(DELETE.from('credit.AgentMessages')
        .where({ conversation_ID: conversation.ID, owner_ID: ownerId }));
      await tx.run(DELETE.from('credit.AgentConversations')
        .where({ ID: conversation.ID, owner_ID: ownerId }));
    }
  });
  return owned.length;
}

async function recordExecution(db, userId, conversationId, execution) {
  const executionId = execution.id || execution.ID || randomUUID();
  const steps = execution.steps || [];
  const plan = execution.recoveryPlan || execution.plan || null;
  const incompleteTasks = plan?.tasks?.filter(task =>
    ['PENDING', 'READY'].includes(task.status)) || [];
  const hasSafeRecovery = ['completed', 'failed'].includes(execution.status)
    && ['IN_PROGRESS', 'PARTIALLY_COMPLETED', 'BLOCKED', 'FAILED'].includes(plan?.status)
    && incompleteTasks.some(task => task.taskType === 'READ_ONLY')
    && !plan.tasks.some(task => task.status === 'RUNNING');
  await db.tx(async tx => {
    const existing = (await tx.run(SELECT.from('credit.AgentExecutions')
      .where({ ID: executionId, user_ID: userId })))[0];
    const progress = {
      user_ID: userId,
      conversation_ID: conversationId || null,
      status: execution.status,
      stepCount: steps.length,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt || null,
      errorCategory: execution.errorCategory || null,
      providerFallback: execution.providerFallback === true,
      providerErrorCategory: execution.providerErrorCategory || null,
      planId: plan?.planId || null,
      planVersion: plan?.version || null,
      planStatus: execution.planStatus || plan?.status || null,
      planData: plan ? JSON.stringify(storagePlan(plan)) : null,
      taskResults: Array.isArray(execution.taskResults) ? JSON.stringify(execution.taskResults) : null,
      recoveryData: execution.recoveryData ? JSON.stringify(execution.recoveryData) : null,
      recoveryStatus: execution.status === 'running'
        ? 'ACTIVE'
        : execution.recoveryStatus === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW'
          : hasSafeRecovery ? 'AVAILABLE' : 'NOT_AVAILABLE',
      updatedAt: new Date().toISOString()
    };
    if (existing) {
      await tx.run(UPDATE('credit.AgentExecutions')
        .set(progress)
        .where({ ID: executionId, user_ID: userId }));
    } else {
      await tx.run(INSERT.into('credit.AgentExecutions').entries({
        ID: executionId,
        ...progress
      }));
    }

    const storedSteps = await tx.run(SELECT.from('credit.AgentExecutionSteps')
      .where({ execution_ID: executionId }));
    for (const [index, step] of steps.entries()) {
      const sequence = index + 1;
      const values = {
        toolName: step.tool,
        status: step.status,
        summary: String(step.summary || '').slice(0, 500),
        startedAt: step.startedAt,
        completedAt: step.completedAt || null,
        taskId: step.taskId || null,
        attempt: Number.isSafeInteger(step.attempt) ? step.attempt : null,
        outcome: step.outcome || step.status,
        errorCategory: step.errorCategory || null
      };
      if (storedSteps.some(stored => stored.sequence === sequence)) {
        await tx.run(UPDATE('credit.AgentExecutionSteps')
          .set(values)
          .where({ execution_ID: executionId, sequence }));
      } else {
        await tx.run(INSERT.into('credit.AgentExecutionSteps').entries({
          ID: randomUUID(),
          execution_ID: executionId,
          sequence,
          ...values
        }));
      }
    }
  });
  return {
    ...execution,
    id: executionId,
    ID: executionId,
    recoveryStatus: execution.status === 'running'
      ? 'ACTIVE'
      : execution.recoveryStatus === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW'
        : hasSafeRecovery ? 'AVAILABLE' : 'NOT_AVAILABLE'
  };
}

async function listExecutions(db, userId) {
  const executions = await db.run(SELECT.from('credit.AgentExecutions')
    .where({ user_ID: userId }).orderBy('startedAt desc').limit(50));
  const results = [];
  for (const execution of executions) {
    const steps = await db.run(SELECT.from('credit.AgentExecutionSteps')
      .where({ execution_ID: execution.ID }).orderBy('sequence asc'));
    const {
      planData,
      taskResults: taskResultsData,
      recoveryData: recoveryDataValue,
      ...safeExecution
    } = execution;
    results.push({
      ...safeExecution,
      plan: safePlanFromStorage(planData),
      taskResults: parseStoredJson(taskResultsData, []),
      steps
    });
  }
  return results;
}

function parseStoredJson(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function safePlanFromStorage(value) {
  const plan = parseStoredJson(value);
  if (!plan || !Array.isArray(plan.tasks)) return null;
  return {
    ...plan,
    tasks: plan.tasks.map(({ toolInput, ...task }) => task)
  };
}

async function getExecutionForRecovery(db, userId, executionId) {
  const execution = (await db.run(SELECT.from('credit.AgentExecutions')
    .where({ ID: executionId, user_ID: userId })))[0];
  if (!execution) {
    const error = new Error('Execution was not found or is unavailable.');
    error.statusCode = 404;
    throw error;
  }
  return {
    ...execution,
    plan: parseStoredJson(execution.planData),
    taskResults: parseStoredJson(execution.taskResults, []),
    recoveryData: parseStoredJson(execution.recoveryData, {})
  };
}

async function claimExecutionRecovery(db, userId, executionId, now = new Date()) {
  const execution = await getExecutionForRecovery(db, userId, executionId);
  if (execution.recoveryStatus === 'ACTIVE' || execution.recoveryStatus === 'RECOVERING') {
    const updatedAt = new Date(execution.updatedAt || execution.startedAt).getTime();
    if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt <= RECOVERY_STALE_MS) {
      const error = new Error('Execution is still active and cannot be recovered yet.');
      error.statusCode = 409;
      throw error;
    }
    const runningTask = execution.plan?.tasks?.some(task => task.status === 'RUNNING');
    const previousStatus = execution.recoveryStatus;
    const nextStatus = runningTask ? 'MANUAL_REVIEW' : 'RECOVERING';
    const completedTasks = execution.plan?.tasks?.filter(task =>
      task.status === 'COMPLETED').length || 0;
    const planStatus = completedTasks
      ? 'PARTIALLY_COMPLETED'
      : execution.plan?.tasks?.some(task => task.status === 'BLOCKED') ? 'BLOCKED' : 'FAILED';
    const changed = await db.run(UPDATE('credit.AgentExecutions')
      .set({
        recoveryStatus: nextStatus,
        ...(runningTask ? { planStatus } : {}),
        ...(runningTask && execution.plan
          ? { planData: JSON.stringify({ ...execution.plan, status: planStatus }) }
          : {}),
        updatedAt: now.toISOString()
      })
      .where({
        ID: executionId,
        user_ID: userId,
        recoveryStatus: previousStatus,
        updatedAt: execution.updatedAt
      }));
    if (changed !== 1) {
      const error = new Error('Execution recovery is already in progress.');
      error.statusCode = 409;
      throw error;
    }
    if (runningTask) {
      const error = new Error('A task has an uncertain prior outcome and requires manual review.');
      error.statusCode = 409;
      throw error;
    }
    execution.recoveryStatus = 'RECOVERING';
    return execution;
  }
  if (execution.recoveryStatus !== 'AVAILABLE') {
    const error = new Error('Execution is not available for automatic recovery.');
    error.statusCode = 409;
    throw error;
  }
  const changed = await db.run(UPDATE('credit.AgentExecutions')
    .set({ recoveryStatus: 'RECOVERING', updatedAt: now.toISOString() })
    .where({
      ID: executionId,
      user_ID: userId,
      recoveryStatus: 'AVAILABLE'
    }));
  if (changed !== 1) {
    const error = new Error('Execution recovery is already in progress.');
    error.statusCode = 409;
    throw error;
  }
  return execution;
}

async function getExecution(db, userId, executionId) {
  const execution = (await db.run(SELECT.from('credit.AgentExecutions')
    .where({ ID: executionId, user_ID: userId })))[0];
  if (!execution) {
    const error = new Error('Execution was not found.');
    error.statusCode = 404;
    throw error;
  }
  const steps = await db.run(SELECT.from('credit.AgentExecutionSteps')
    .where({ execution_ID: executionId }).orderBy('sequence asc'));
  const {
    planData,
    taskResults: taskResultsData,
    recoveryData: recoveryDataValue,
    ...safeExecution
  } = execution;
  return {
    ...safeExecution,
    plan: safePlanFromStorage(planData),
    taskResults: parseStoredJson(taskResultsData, []),
    steps
  };
}

async function clearAgentHistory(db, ownerId) {
  const conversations = await db.run(SELECT.from('credit.AgentConversations')
    .where({ owner_ID: ownerId }));
  const executions = await db.run(SELECT.from('credit.AgentExecutions')
    .where({ user_ID: ownerId }));
  await db.tx(async tx => {
    for (const conversation of conversations) {
      await tx.run(DELETE.from('credit.AgentMessages')
        .where({ conversation_ID: conversation.ID, owner_ID: ownerId }));
      await tx.run(DELETE.from('credit.AgentConversations')
        .where({ ID: conversation.ID, owner_ID: ownerId }));
    }
    for (const execution of executions) {
      await tx.run(DELETE.from('credit.AgentExecutionSteps')
        .where({ execution_ID: execution.ID }));
      await tx.run(DELETE.from('credit.AgentExecutions')
        .where({ ID: execution.ID, user_ID: ownerId }));
    }
  });
  return { conversations: conversations.length, executions: executions.length };
}

module.exports = {
  MEMORY_ENABLED,
  clearAgentHistory,
  clearConversations,
  claimExecutionRecovery,
  getExecution,
  getExecutionForRecovery,
  getOrCreateConversation,
  listConversations,
  listExecutions,
  loadConversationMessages,
  readConversation,
  recordExecution,
  RECOVERY_STALE_MS,
  saveConversationTurn,
  validateConversationId
};
