const MAX_TURNS_PER_SESSION = 6;
const sessionStore = new Map();

function normalizeSessionKey(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return 'default-session';
  }
  return sessionId.trim();
}

function getSessionState(sessionId) {
  const key = normalizeSessionKey(sessionId);
  if (!sessionStore.has(key)) {
    sessionStore.set(key, {
      turns: [],
      lastIntent: null,
      lastCustomerIds: [],
      lastResultSetIds: [],
      lastFilters: {},
      lastPeriod: null,
      lastMetric: null
    });
  }
  return sessionStore.get(key);
}

function extractCustomerIdsFromHistory(history = []) {
  if (!Array.isArray(history) || !history.length) return [];
  const recent = history.slice(-MAX_TURNS_PER_SESSION * 2);
  const found = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const content = String(recent[i]?.content || recent[i]?.text || '');
    const matches = content.match(/\b(?:MS-)?C\d{3}\b/gi);
    if (matches && matches.length) {
      for (const m of matches) {
        const upper = m.toUpperCase().replace(/^MS-/, '');
        if (!found.includes(upper)) found.push(upper);
      }
      if (found.length > 0) break;
    }
  }
  return found;
}

function updateSessionContext(sessionId, turnSummary = {}) {
  const state = getSessionState(sessionId);
  const entry = {
    timestamp: new Date().toISOString(),
    intent: turnSummary.intent || state.lastIntent,
    customerIds: Array.isArray(turnSummary.customerIds) ? [...new Set(turnSummary.customerIds)] : [],
    resultSetIds: Array.isArray(turnSummary.resultSetIds) ? [...new Set(turnSummary.resultSetIds)] : [],
    filters: turnSummary.filters && typeof turnSummary.filters === 'object' ? { ...turnSummary.filters } : {},
    period: turnSummary.period || null,
    metric: turnSummary.metric || null
  };

  state.turns.push(entry);
  if (state.turns.length > MAX_TURNS_PER_SESSION) {
    state.turns.splice(0, state.turns.length - MAX_TURNS_PER_SESSION);
  }

  if (entry.intent && !['CLARIFY', 'OUT_OF_SCOPE'].includes(entry.intent)) {
    state.lastIntent = entry.intent;
  }
  if (entry.customerIds.length > 0) {
    state.lastCustomerIds = entry.customerIds;
  }
  if (entry.resultSetIds.length > 0) {
    state.lastResultSetIds = entry.resultSetIds;
    if (entry.customerIds.length === 0) {
      state.lastCustomerIds = entry.resultSetIds;
    }
  }
  if (Object.keys(entry.filters).length > 0) {
    state.lastFilters = entry.filters;
  }
  if (entry.period) {
    state.lastPeriod = entry.period;
  }
  if (entry.metric) {
    state.lastMetric = entry.metric;
  }

  return state;
}

function resolveConversationReferences(message, extracted = {}, { sessionId, history = [] } = {}) {
  const text = String(message || '').trim();
  const state = getSessionState(sessionId);
  const historyIds = extractCustomerIdsFromHistory(history);

  const availableResultIds = state.lastResultSetIds.length > 0
    ? state.lastResultSetIds
    : state.lastCustomerIds.length > 0
      ? state.lastCustomerIds
      : historyIds;

  const availableCustomerIds = state.lastCustomerIds.length > 0
    ? state.lastCustomerIds
    : availableResultIds;

  const hasExplicitCustomers = (Array.isArray(extracted.customerIds) && extracted.customerIds.length > 0)
    || (Array.isArray(extracted.customerNames) && extracted.customerNames.length > 0);

  const pluralPronounRegex = /\b(?:their|them|those|these|same\s+customers|those\s+customers|these\s+customers|the\s+above\s+customers)\b/i;
  const singularPronounRegex = /\b(?:that\s+customer|this\s+customer|this\s+account|that\s+account|for\s+it|its\s+(?:limit|exposure|overdue|invoices|payments|status|risk|utilisation|utilization)|increase\s+it|approve\s+it)\b/i;
  const compareFollowUpRegex = /^\s*(?:now\s+|and\s+|then\s+|also\s+)?compare\b/i;
  const countryFollowUpRegex = /^\s*(?:and\s+|what\s+about\s+|how\s+about\s+|now\s+)?(?:for|in)\s+(india|uae|singapore)\s*\??\s*$/i;
  const shortFollowUpRegex = /^\s*(?:and|now|what\s+about|how\s+about|show\s+their|compare\s+their|what\s+is\s+their)\b/i;

  let resolvedFromContext = false;
  let resolvedCustomerIds = Array.isArray(extracted.customerIds) ? [...extracted.customerIds] : [];
  let resolvedIntent = null;
  let resolvedFilters = { ...(extracted.filters || {}) };
  let resolvedCountries = Array.isArray(extracted.countries) ? [...extracted.countries] : [];
  let contextNote = null;

  // 1. "and for India?" / "what about UAE?" -> keep lastIntent, update country filter
  const countryFollowMatch = text.match(countryFollowUpRegex);
  if (countryFollowMatch && state.lastIntent) {
    const rawCountry = countryFollowMatch[1];
    const normalizedCountry = rawCountry.toUpperCase() === 'UAE'
      ? 'UAE'
      : rawCountry.charAt(0).toUpperCase() + rawCountry.slice(1).toLowerCase();
    resolvedCountries = [normalizedCountry];
    resolvedFilters = { ...state.lastFilters, countries: [normalizedCountry] };
    resolvedIntent = state.lastIntent;
    resolvedFromContext = true;
    contextNote = `Using: ${state.lastIntent} intent filtered to ${normalizedCountry} from previous answer`;
  }

  // 2. "now compare exposure" -> COMPARE over lastResultSetIds
  if (!hasExplicitCustomers && compareFollowUpRegex.test(text) && availableResultIds.length > 0) {
    resolvedCustomerIds = [...availableResultIds];
    resolvedIntent = 'COMPARE';
    resolvedFromContext = true;
    contextNote = `Using: ${resolvedCustomerIds.join(', ')} from previous answer`;
  }

  // 3. Plural pronouns ("their", "them", "those", "same customers") -> lastResultSetIds or lastCustomerIds
  if (!hasExplicitCustomers && !resolvedFromContext && pluralPronounRegex.test(text) && availableResultIds.length > 0) {
    resolvedCustomerIds = [...availableResultIds];
    resolvedFromContext = true;
    contextNote = `Using: ${resolvedCustomerIds.join(', ')} from previous answer`;
  }

  // 4. Singular pronoun ("that customer", "it", "this account") -> lastCustomerIds[0]
  if (!hasExplicitCustomers && !resolvedFromContext && singularPronounRegex.test(text) && availableCustomerIds.length > 0) {
    resolvedCustomerIds = [availableCustomerIds[0]];
    resolvedFromContext = true;
    contextNote = `Using: ${resolvedCustomerIds[0]} from previous answer`;
  }

  // 5. Short follow-up with no explicit entity and an active single customer in context
  if (!hasExplicitCustomers && !resolvedFromContext && shortFollowUpRegex.test(text) && availableCustomerIds.length === 1) {
    resolvedCustomerIds = [availableCustomerIds[0]];
    resolvedFromContext = true;
    contextNote = `Using: ${resolvedCustomerIds[0]} from previous answer`;
  }

  return {
    resolvedFromContext,
    customerIds: resolvedCustomerIds,
    countries: resolvedCountries,
    filters: resolvedFilters,
    inheritedIntent: resolvedIntent || state.lastIntent || null,
    inheritedPeriod: extracted.period || state.lastPeriod || null,
    inheritedMetric: (Array.isArray(extracted.metrics) && extracted.metrics[0]) || state.lastMetric || null,
    contextNote
  };
}

function clearSessionContext(sessionId) {
  if (!sessionId) {
    sessionStore.clear();
    return;
  }
  sessionStore.delete(normalizeSessionKey(sessionId));
}

module.exports = {
  MAX_TURNS_PER_SESSION,
  getSessionState,
  updateSessionContext,
  resolveConversationReferences,
  clearSessionContext
};
