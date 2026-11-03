const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const MEMORY_ENABLED = process.env.AGENT_MEMORY_ENABLED === 'true';
const MAX_CONVERSATION_MESSAGES = 12;

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
  const executionId = randomUUID();
  const steps = execution.steps || [];
  await db.tx(async tx => {
    await tx.run(INSERT.into('credit.AgentExecutions').entries({
      ID: executionId,
      user_ID: userId,
      conversation_ID: conversationId || null,
      status: execution.status,
      stepCount: steps.length,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      errorCategory: execution.errorCategory || null,
      providerFallback: execution.providerFallback === true,
      providerErrorCategory: execution.providerErrorCategory || null
    }));
    if (steps.length) {
      await tx.run(INSERT.into('credit.AgentExecutionSteps').entries(steps.map((step, index) => ({
        ID: randomUUID(),
        execution_ID: executionId,
        sequence: index + 1,
        toolName: step.tool,
        status: step.status,
        summary: step.summary.slice(0, 500),
        startedAt: step.startedAt,
        completedAt: step.completedAt
      }))));
    }
  });
  return { ...execution, ID: executionId };
}

async function listExecutions(db, userId) {
  const executions = await db.run(SELECT.from('credit.AgentExecutions')
    .where({ user_ID: userId }).orderBy('startedAt desc').limit(50));
  const results = [];
  for (const execution of executions) {
    const steps = await db.run(SELECT.from('credit.AgentExecutionSteps')
      .where({ execution_ID: execution.ID }).orderBy('sequence asc'));
    results.push({ ...execution, steps });
  }
  return results;
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
  getOrCreateConversation,
  listConversations,
  listExecutions,
  loadConversationMessages,
  readConversation,
  recordExecution,
  saveConversationTurn,
  validateConversationId
};
