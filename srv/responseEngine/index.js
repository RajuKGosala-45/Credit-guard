const { classifyIntentDeterministically } = require('./intentClassifier');
const { orchestrateIntentData } = require('./toolOrchestrator');
const { composeStructuredResponse } = require('./responseComposer');
const { validateAndReconcileResponse } = require('./responseValidator');
const { updateSessionContext, clearSessionContext, getSessionState } = require('./conversationContext');
const calculators = require('./calculators');

async function generateStructuredCreditResponse(message, {
  db,
  user,
  sessionId,
  history = [],
  tools = {},
  executionOutputs = [],
  customerDataSource,
  portfolioCustomers
} = {}) {
  const effectiveSessionId = sessionId || user?.id || 'default-session';

  // Step 1: Resolve conversation context & classify intent
  const intentPlan = classifyIntentDeterministically(message, {
    sessionId: effectiveSessionId,
    history,
    portfolioCustomers
  });

  // Step 2: Orchestrate required read-only backend tools/services
  const data = await orchestrateIntentData(intentPlan, {
    db,
    user,
    tools,
    executionOutputs,
    customerDataSource
  });

  // Step 3: Compose structured response according to intent block recipe
  const rawStructured = composeStructuredResponse(intentPlan, data, {
    rawMessage: message
  });

  // Step 4: Validate, reconcile, and repair (with 1-retry + safe fallback)
  const validated = validateAndReconcileResponse(rawStructured, {
    intentPlan,
    provenance: data.provenance
  });

  // Step 5: Update conversation context for follow-up turns
  const resultSetIds = rawStructured._meta?.resultSetIds || [];
  delete validated._meta;

  updateSessionContext(effectiveSessionId, {
    intent: intentPlan.primaryIntent,
    customerIds: intentPlan.customerIds?.length ? intentPlan.customerIds : resultSetIds,
    resultSetIds,
    filters: intentPlan.filters,
    period: intentPlan.period,
    metric: intentPlan.metrics?.[0] || null
  });

  return {
    intentPlan,
    structuredResponse: validated
  };
}

module.exports = {
  generateStructuredCreditResponse,
  classifyIntentDeterministically,
  orchestrateIntentData,
  composeStructuredResponse,
  validateAndReconcileResponse,
  updateSessionContext,
  clearSessionContext,
  getSessionState,
  ...calculators
};
