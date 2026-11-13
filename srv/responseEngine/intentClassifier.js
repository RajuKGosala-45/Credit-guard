const { resolveConversationReferences } = require('./conversationContext');

const VALID_INTENTS = Object.freeze([
  'GREETING',
  'LIST',
  'COMPARE',
  'APPROVAL',
  'EXPOSURE',
  'RISK',
  'TREND',
  'CUSTOMER_DETAIL',
  'MONITORING',
  'PAYMENT_OVERDUE',
  'WHATIF',
  'SAP_DATASOURCE',
  'EXPLAIN',
  'CLARIFY',
  'OUT_OF_SCOPE',
  'UNKNOWN'
]);

const KNOWN_CUSTOMERS = Object.freeze([
  { id: 'C001', name: 'Aarav Components', aliases: ['aarav', 'aarav components'] },
  { id: 'C002', name: 'Desert Star Trading', aliases: ['desert star', 'desert star trading'] },
  { id: 'C003', name: 'Merlion Systems', aliases: ['merlion', 'merlion systems'] },
  { id: 'C004', name: 'Indus Retail Group', aliases: ['indus', 'indus retail', 'indus retail group'] },
  { id: 'C005', name: 'Gulf Horizon LLC', aliases: ['gulf horizon', 'gulf horizon llc'] },
  { id: 'C006', name: 'Monsoon Logistics', aliases: ['monsoon', 'monsoon logistics'] },
  { id: 'C007', name: 'Lotus Industrial', aliases: ['lotus', 'lotus industrial'] },
  { id: 'C008', name: 'Pearl Coast Foods', aliases: ['pearl coast', 'pearl coast foods'] },
  { id: 'C009', name: 'Orchid Digital', aliases: ['orchid', 'orchid digital'] },
  { id: 'C010', name: 'Saffron Textiles', aliases: ['saffron', 'saffron textiles'] },
  { id: 'C011', name: 'Lion City Supplies', aliases: ['lion city', 'lion city supplies'] },
  { id: 'C012', name: 'Bluewater Services', aliases: ['bluewater', 'bluewater services'] },
  { id: 'C013', name: 'Northstar Components', aliases: ['northstar', 'northstar components'] }
]);

const KNOWN_CUSTOMER_IDS = new Set(KNOWN_CUSTOMERS.map(c => c.id));

const INTENT_BLOCKS = Object.freeze({
  GREETING: [],
  LIST: ['table'],
  COMPARE: ['chart', 'table', 'observations'],
  APPROVAL: ['keyValue', 'comparison', 'recommendation', 'chart'],
  EXPOSURE: ['metrics', 'chart', 'table', 'observations'],
  RISK: ['metrics', 'chart', 'table', 'observations'],
  TREND: ['metrics', 'chart', 'observations'],
  CUSTOMER_DETAIL: ['keyValue', 'metrics', 'table', 'alerts', 'observations'],
  MONITORING: ['alerts', 'observations'],
  PAYMENT_OVERDUE: ['metrics', 'chart', 'table', 'observations'],
  WHATIF: ['notice', 'comparison', 'chart', 'observations'],
  SAP_DATASOURCE: ['keyValue', 'table', 'observations'],
  EXPLAIN: ['text', 'keyValue', 'observations'],
  CLARIFY: ['notice', 'text'],
  OUT_OF_SCOPE: ['notice', 'text'],
  UNKNOWN: []
});

const INTENT_TOOLS = Object.freeze({
  GREETING: [],
  LIST: ['get_portfolio_summary'],
  COMPARE: ['get_portfolio_summary'],
  APPROVAL: ['get_customer', 'get_customer_approval_history', 'list_limit_requests'],
  EXPOSURE: ['get_portfolio_summary', 'exposure_by'],
  RISK: ['get_portfolio_summary', 'get_monitoring_analysis'],
  TREND: ['get_monitoring_analysis', 'get_portfolio_summary'],
  CUSTOMER_DETAIL: ['get_customer', 'get_customer_approval_history', 'get_monitoring_analysis'],
  MONITORING: ['get_monitoring_analysis', 'get_monitoring_alerts'],
  PAYMENT_OVERDUE: ['get_portfolio_summary', 'get_customer'],
  WHATIF: ['get_customer', 'get_portfolio_summary'],
  SAP_DATASOURCE: ['get_data_ingestion_status', 'get_mock_sap_records'],
  EXPLAIN: [],
  CLARIFY: [],
  OUT_OF_SCOPE: [],
  UNKNOWN: []
});

function parseMonetaryAmount(rawString) {
  if (!rawString) return null;
  const cleaned = String(rawString).replace(/₹|INR|Rs\.?|\s|,/gi, '').trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|crore|crores|cr|k|m)?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'lakh' || unit === 'lakhs' || unit === 'lac' || unit === 'lacs') return Math.round(base * 100000);
  if (unit === 'crore' || unit === 'crores' || unit === 'cr') return Math.round(base * 10000000);
  if (unit === 'k') return Math.round(base * 1000);
  if (unit === 'm') return Math.round(base * 1000000);
  return Math.round(base);
}

function extractEntities(message, portfolioCustomers = KNOWN_CUSTOMERS) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  // Extract customer IDs (including unknown ones like C999)
  const rawIdMatches = text.match(/\b(?:MS-)?C\d{3,4}\b/gi) || [];
  const allMentionedIds = [...new Set(rawIdMatches.map(id => id.toUpperCase().replace(/^MS-/, '')))];
  const knownIds = new Set([
    ...KNOWN_CUSTOMER_IDS,
    ...(Array.isArray(portfolioCustomers) ? portfolioCustomers.map(c => String(c.ID || c.id || '').toUpperCase()).filter(Boolean) : [])
  ]);

  const customerIds = [];
  const unknownCustomerIds = [];
  for (const id of allMentionedIds) {
    if (knownIds.has(id)) customerIds.push(id);
    else unknownCustomerIds.push(id);
  }

  // Extract customer names
  const customerNames = [];
  const catalog = Array.isArray(portfolioCustomers) && portfolioCustomers.length > 0
    ? portfolioCustomers.map(c => ({
        id: String(c.ID || c.id).toUpperCase(),
        name: String(c.name || c.customerName || ''),
        aliases: [
          String(c.name || c.customerName || '').toLowerCase(),
          String(c.name || c.customerName || '').toLowerCase().split(/\s+/)[0]
        ].filter(a => a && a.length >= 4)
      }))
    : KNOWN_CUSTOMERS;

  for (const entry of catalog) {
    const matchedAlias = (entry.aliases || []).some(alias => {
      if (!alias) return false;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
    });
    if (matchedAlias) {
      if (!customerNames.includes(entry.name)) customerNames.push(entry.name);
      if (!customerIds.includes(entry.id)) customerIds.push(entry.id);
    }
  }

  // Countries
  const countries = [];
  if (/\bindia\b/i.test(text)) countries.push('India');
  if (/\b(?:uae|united arab emirates|dubai)\b/i.test(text)) countries.push('UAE');
  if (/\bsingapore\b/i.test(text)) countries.push('Singapore');

  // Company codes
  const companyCodes = [];
  const codeMatches = text.match(/\b(?:BS0[1-5]|1000|2000|3000)\b/gi) || [];
  for (const code of codeMatches) {
    const upper = code.toUpperCase();
    if (!companyCodes.includes(upper)) companyCodes.push(upper);
  }

  // Metrics mentioned
  const metrics = [];
  if (/\b(?:exposure|receivables?|balance)\b/i.test(text)) metrics.push('exposure');
  if (/\b(?:credit\s*limit|limit)\b/i.test(text)) metrics.push('creditLimit');
  if (/\b(?:utili[sz]ation)\b/i.test(text)) metrics.push('utilisation');
  if (/\b(?:overdue|past\s*due|delinquen|ageing|aging)\b/i.test(text)) metrics.push('overdueAmount');
  if (/\b(?:available\s*credit|headroom)\b/i.test(text)) metrics.push('availableCredit');
  if (/\b(?:risk|breach|warning|severity)\b/i.test(text)) metrics.push('risk');

  // Period
  let period = null;
  const monthMatch = text.match(/\b(?:last|past|over\s+the\s+last)\s+(\d+)\s*months?\b/i);
  const dayMatch = text.match(/\b(?:last|past|over\s+the\s+last)\s+(\d+)\s*days?\b/i);
  if (monthMatch) period = `${monthMatch[1]}m`;
  else if (dayMatch) period = `${dayMatch[1]}d`;
  else if (/\b(?:6\s*months?|six\s*months?)\b/i.test(text)) period = '6m';
  else if (/\b(?:12\s*months?|one\s*year|1\s*year)\b/i.test(text)) period = '12m';
  else if (/\b(?:90\s*days?|quarter|q[1-4])\b/i.test(text)) period = '90d';
  else if (/\b(?:30\s*days?|month)\b/i.test(text)) period = '30d';

  // Filters
  const filters = {};
  const pctGeMatch = text.match(/(?:>=|≥|at\s+or\s+above|above|over|exceeding|greater\s+than|more\s+than)\s*(\d+(?:\.\d+)?)\s*%/i)
    || text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:or\s+more|or\s+higher|or\s+above|\+)/i);
  const pctLeMatch = text.match(/(?:<=|≤|below|under|less\s+than)\s*(\d+(?:\.\d+)?)\s*%/i);

  if (pctGeMatch) {
    filters.minUtilisationPct = Number(pctGeMatch[1]);
  } else if (/\b(?:high[\s-]*utili[sz]ation|over\s+threshold|80\s*%)\b/i.test(text)) {
    filters.minUtilisationPct = 80;
  }

  if (pctLeMatch) {
    filters.maxUtilisationPct = Number(pctLeMatch[1]);
  }

  if (/\b(?:breach|breached|over\s+limit|exceed(?:ing|ed)?\s+(?:their\s+)?(?:credit\s+)?limit|>=?\s*100\s*%)\b/i.test(text)
    && !/\b(?:warning|80\s*%)\b/i.test(text)) {
    filters.breachOnly = true;
  } else if (/\b(?:warning\s+zone|80\s*[–-]\s*99\s*%)\b/i.test(text)) {
    filters.status = 'WARNING';
  } else if (/\b(?:healthy\s+customers|normal\s+customers)\b/i.test(text)) {
    filters.status = 'HEALTHY';
  }

  if (/\b(?:flagged|at[\s-]*risk|attention)\b/i.test(text) && !filters.minUtilisationPct && !filters.breachOnly) {
    filters.flaggedOnly = true;
  }

  const topNMatch = text.match(/\btop\s+(\d+)\b/i);
  if (topNMatch) {
    filters.limit = Number(topNMatch[1]);
  }

  // Scenario parameters for APPROVAL / WHATIF
  const scenarioParams = {};
  const toLimitMatch = text.match(/\b(?:to|at|of)\s*(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:lakh|lakhs|lac|lacs|crore|crores|cr|k|m))?)\b/i);
  const orderMatch = text.match(/\b(?:new\s+order|additional\s+order|extra\s+order|places?\s+an?\s+order|new\s+invoice|exposure\s+increases?\s+by|adds?\s+exposure)\s+(?:of\s+|by\s+)?(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:lakh|lakhs|lac|lacs|crore|crores|cr|k|m))?)/i);
  const paymentMatch = text.match(/\b(?:pays?|payment\s+of|settles?|clears?\s+overdue\s+by)\s+(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:lakh|lakhs|lac|lacs|crore|crores|cr|k|m))?)/i);
  const pctIncreaseMatch = text.match(/\b(?:increase|raise|reduce|cut|lower)\s+(?:credit\s+)?limit\s+by\s+(\d+(?:\.\d+)?)\s*%/i);
  const deltaLimitMatch = text.match(/\b(?:increase|raise)\s+(?:credit\s+)?limit\s+by\s+(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:lakh|lakhs|lac|lacs|crore|crores|cr|k|m))?)/i);

  if (orderMatch) {
    const val = parseMonetaryAmount(orderMatch[1]);
    if (val !== null) scenarioParams.extraExposure = val;
  }
  if (paymentMatch) {
    const val = parseMonetaryAmount(paymentMatch[1]);
    if (val !== null) scenarioParams.paymentReceived = val;
  }
  if (pctIncreaseMatch) {
    const pct = Number(pctIncreaseMatch[1]);
    const isReduce = /\b(?:reduce|cut|lower)\b/i.test(pctIncreaseMatch[0]);
    scenarioParams.limitChangePct = isReduce ? -pct : pct;
  } else if (deltaLimitMatch && !/\b%/i.test(deltaLimitMatch[0])) {
    const val = parseMonetaryAmount(deltaLimitMatch[1]);
    if (val !== null) scenarioParams.deltaLimit = val;
  } else if (toLimitMatch && !orderMatch) {
    const val = parseMonetaryAmount(toLimitMatch[1]);
    if (val !== null && val >= 1000) scenarioParams.requestedLimit = val;
  }

  // Comparison dimension
  let comparisonDimension = null;
  if (/\bby\s+country|across\s+countries|country\s+breakdown\b/i.test(text)) {
    comparisonDimension = 'country';
  } else if (/\bby\s+company\s*code|across\s+company\s*codes|by\s+entity\b/i.test(text)) {
    comparisonDimension = 'companyCode';
  } else if (/\bby\s+risk\s*class|across\s+risk\s*classes\b/i.test(text)) {
    comparisonDimension = 'riskClass';
  } else if (customerIds.length >= 2 || /\bwhich\s+customer|top\s+customer|highest\s+.*customer|customers\b/i.test(text)) {
    comparisonDimension = 'customer';
  }

  return {
    customerIds,
    unknownCustomerIds,
    customerNames,
    countries,
    companyCodes,
    metrics,
    period,
    filters,
    scenarioParams,
    comparisonDimension
  };
}

function detectOutOfScope(message) {
  const text = String(message || '').trim();
  const hasCreditTerms = /\b(?:credit|exposure|limit|utili[sz]ation|invoice|overdue|payment|customer|portfolio|risk|breach|warning|alert|monitoring|sap|hana|btp|abap|odata|cds|connector|ingestion|approval|controller|finance|bluspring|c0\d\d|bs0\d)\b/i.test(text);
  if (hasCreditTerms) return false;

  const outOfScopePatterns = [
    /\b(?:weather|temperature|forecast|rain|sunny|climate)\b/i,
    /\b(?:recipe|cook|baking|restaurant|pizza|biryani|pasta|dinner)\b/i,
    /\b(?:movie|film|actor|netflix|cinema|song|music|lyrics|album)\b/i,
    /\b(?:football|cricket|ipl|world\s*cup|tennis|basketball|score|match)\b/i,
    /\b(?:election|president|prime\s*minister|politics|parliament|senate)\b/i,
    /\b(?:joke|poem|haiku|horoscope|astrology|zodiac|trivia|capital\s+of)\b/i,
    /\b(?:stock\s+price\s+of\s+apple|bitcoin|ethereum|crypto\s+trading)\b/i
  ];
  return outOfScopePatterns.some(pattern => pattern.test(text));
}

function detectExplainConcept(message) {
  const text = String(message || '').trim();
  if (/\butili[sz]ation\b/i.test(text)) return 'utilisation';
  if (/\b(?:available\s*credit|headroom)\b/i.test(text)) return 'available_credit';
  if (/\b(?:exposure|fscm|open\s*items)\b/i.test(text)) return 'exposure';
  if (/\b(?:policy|approver|routing|governance|controller|finance\s*head)\b/i.test(text)) return 'policy_routing';
  if (/\b(?:risk\s*score|risk\s*class|threshold|breach|warning)\b/i.test(text)) return 'risk_thresholds';
  return 'credit_guard_overview';
}

function mergeResponseBlocks(primaryIntent, secondaryIntents = []) {
  const primaryBlocks = INTENT_BLOCKS[primaryIntent] || ['text'];
  // Pure LIST must NEVER include KPI metrics or chart
  if (primaryIntent === 'LIST' && secondaryIntents.length === 0) {
    return ['table'];
  }
  const merged = [...primaryBlocks];
  for (const sec of secondaryIntents) {
    // If primary is LIST and secondary is RISK, only add observations so we don't violate the LIST no-KPI/no-chart rule unless RISK is primary
    if (primaryIntent === 'LIST' && sec === 'RISK') {
      if (!merged.includes('observations')) merged.push('observations');
      continue;
    }
    const secBlocks = INTENT_BLOCKS[sec] || [];
    for (const block of secBlocks) {
      if (!merged.includes(block)) {
        merged.push(block);
      }
    }
  }
  return merged;
}

function mergeRequiredTools(primaryIntent, secondaryIntents = []) {
  const tools = new Set(INTENT_TOOLS[primaryIntent] || []);
  for (const sec of secondaryIntents) {
    for (const t of (INTENT_TOOLS[sec] || [])) {
      tools.add(t);
    }
  }
  return [...tools];
}

function classifyIntentDeterministically(message, { sessionId, history = [], portfolioCustomers } = {}) {
  const text = String(message || '').trim();
  const rawEntities = extractEntities(text, portfolioCustomers);
  const contextResolution = resolveConversationReferences(text, rawEntities, { sessionId, history });

  const customerIds = contextResolution.customerIds;
  const unknownCustomerIds = rawEntities.unknownCustomerIds;
  const customerNames = rawEntities.customerNames;
  const countries = contextResolution.countries.length ? contextResolution.countries : rawEntities.countries;
  const companyCodes = rawEntities.companyCodes;
  const metrics = rawEntities.metrics;
  const period = contextResolution.inheritedPeriod || rawEntities.period;
  const filters = {
    ...rawEntities.filters,
    ...contextResolution.filters,
    ...(countries.length ? { countries } : {}),
    ...(companyCodes.length ? { companyCodes } : {})
  };
  const scenarioParams = rawEntities.scenarioParams;
  let comparisonDimension = rawEntities.comparisonDimension;

  // 0. Greeting / Small talk check (when no specific credit query or entity is included)
  const isGreetingOrSmallTalk = /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening|day)|greetings|howdy|yo|sup|how\s+are\s+you(?:\s+doing)?|how's\s+it\s+going|thank\s+you|thanks(?:\s+a\s+lot)?|who\s+are\s+you|what\s+can\s+you\s+do|help(?:\s+me)?)\s*[!.,?]?\s*$/i.test(text);
  if (isGreetingOrSmallTalk && customerIds.length === 0 && unknownCustomerIds.length === 0) {
    return {
      primaryIntent: 'GREETING',
      intentCategory: 'GREETING / SMALL_TALK',
      secondaryIntents: [],
      confidence: 0.99,
      customerIds: [],
      unknownCustomerIds: [],
      customerNames: [],
      countries: [],
      companyCodes: [],
      metrics: [],
      period: null,
      filters: {},
      comparisonDimension: null,
      requiredTools: [],
      responseBlocks: INTENT_BLOCKS.GREETING,
      resolvedFromContext: false,
      contextNote: null,
      scenarioParams: {},
      explainConcept: null
    };
  }

  // 1. Out-of-scope check
  if (detectOutOfScope(text)) {
    return {
      primaryIntent: 'OUT_OF_SCOPE',
      intentCategory: 'OUT_OF_SCOPE',
      secondaryIntents: [],
      confidence: 0.98,
      customerIds: [],
      unknownCustomerIds: [],
      customerNames: [],
      countries: [],
      companyCodes: [],
      metrics: [],
      period: null,
      filters: {},
      comparisonDimension: null,
      requiredTools: [],
      responseBlocks: INTENT_BLOCKS.OUT_OF_SCOPE,
      resolvedFromContext: false,
      contextNote: null,
      scenarioParams: {},
      explainConcept: null
    };
  }

  // 2. Ambiguous / missing required entities -> CLARIFY
  const isBareApprovalVerb = /^\s*(?:can\s+we\s+|should\s+we\s+|please\s+)?(?:approve|increase|raise|change|update|adjust|request)\s+(?:a\s+|the\s+)?(?:credit\s+)?limit(?:\s+increase|\s+change|\s+request)?\s*\??\s*$/i.test(text);
  const isBareCompareVerb = /^\s*(?:compare|compare\s+customers|compare\s+accounts)\s*\??\s*$/i.test(text);
  const isUndefinedRanking = /\b(?:rank|prioriti[sz]e|score)\s+(?:the\s+|our\s+|all\s+)?(?:customers|portfolio|accounts)\b/i.test(text)
    && !/\b(?:by|using|based\s+on|on)\s+(?:exposure|utili[sz]ation|overdue|credit\s+limit|limit|risk)/i.test(text);

  if ((isBareApprovalVerb && customerIds.length === 0 && unknownCustomerIds.length === 0)
    || (isBareCompareVerb && customerIds.length === 0 && !comparisonDimension)
    || isUndefinedRanking) {
    return {
      primaryIntent: 'CLARIFY',
      intentCategory: 'CLARIFY',
      secondaryIntents: [],
      confidence: 0.35,
      customerIds,
      unknownCustomerIds,
      customerNames,
      countries,
      companyCodes,
      metrics,
      period,
      filters,
      comparisonDimension,
      requiredTools: [],
      responseBlocks: INTENT_BLOCKS.CLARIFY,
      resolvedFromContext: false,
      contextNote: null,
      scenarioParams,
      clarificationReason: isUndefinedRanking
        ? 'Please specify the ranking metric (for example: credit utilisation %, total exposure, overdue amount, or composite risk severity).'
        : isBareCompareVerb
          ? 'Please specify which customers or dimensions (country, company code, or risk class) you would like to compare.'
          : 'Please specify the customer (for example C001 – Aarav Components) and the target credit limit in ₹ so I can evaluate the approval policy.'
    };
  }

  // 3. Unknown customer ID explicitly mentioned (e.g. C999)
  if (unknownCustomerIds.length > 0 && customerIds.length === 0) {
    return {
      primaryIntent: 'CUSTOMER_DETAIL',
      intentCategory: 'CUSTOMER_EVALUATION',
      secondaryIntents: [],
      confidence: 0.95,
      customerIds: [],
      unknownCustomerIds,
      customerNames,
      countries,
      companyCodes,
      metrics,
      period,
      filters,
      comparisonDimension,
      requiredTools: [],
      responseBlocks: ['notice'],
      resolvedFromContext: false,
      contextNote: null,
      scenarioParams
    };
  }

  // 4. Score intents based on linguistic & domain patterns
  const scores = new Map(VALID_INTENTS.map(intent => [intent, 0]));
  const addScore = (intent, pts) => scores.set(intent, (scores.get(intent) || 0) + pts);

  // SAP_DATASOURCE (DATA_SOURCES / CONNECTIVITY_STATUS)
  if (/\b(?:sap|s\/4hana|hana|btp|abap|odata|cds|connectors?|connectivity|connection\s*status|ingestion|data\s*sources?|sync\s*status|freshness|extract(?:ion)?|simulator|ukmbp_cms|knkk|bseg|but000)\b/i.test(text)) {
    addScore('SAP_DATASOURCE', 96);
  }

  // EXPLAIN (POLICY_EXPLANATION: conceptual questions without asking for live portfolio records)
  if (/\b(?:how\s+is\s+.*calculated|how\s+does\s+.*work|what\s+does\s+.*mean|what\s+is\s+the\s+(?:formula|policy)|explain\s+(?:the\s+|our\s+)?(?:formula|concept|policy|rules?|thresholds?|difference|meaning|calculation)|define\s+|credit\s+policy\s+rules?)\b/i.test(text)
    && customerIds.length === 0) {
    addScore('EXPLAIN', 95);
  }

  // TREND (historical / time-series)
  if (/\b(?:trend|over\s+time|month[\s-]*over[\s-]*month|historical|history\s+of\s+exposure|last\s+\d+\s*(?:months?|days?|quarters?)|past\s+\d+\s*(?:months?|days?)|6\s*months?|trajectory)\b/i.test(text)
    && !/\b(?:approval\s+history|payment\s+history)\b/i.test(text)) {
    addScore('TREND', 90);
  }

  // WHATIF (hypothetical scenario / simulation)
  if (/\b(?:what\s+if|what\s+happens\s+if|suppose|simulate|simulation|if\s+.*\s+(?:places|adds|orders|increases|reduces|pays)|hypothetical|impact\s+of\s+(?:a\s+)?new\s+order)\b/i.test(text)) {
    addScore('WHATIF', 95);
  }

  // APPROVAL (LIMIT_REQUEST_DRAFT: credit limit increase / eligibility / recommendation / pending requests)
  if (/\b(?:can\s+we\s+approve|should\s+we\s+(?:approve|increase|raise)|whether\s+to\s+increase|approve\s+a?\s*(?:credit\s+)?limit|limit\s+increase|increase\s+(?:the\s+)?(?:credit\s+)?limit|prepare\s+.*limit|draft\s+.*limit|eligibility\s+for\s+limit|pending\s+(?:credit[\s-]*)?limit\s+requests?|limit\s+approvals?)\b/i.test(text)) {
    addScore('APPROVAL', 90);
  }

  // MONITORING (MONITORING_ANALYSIS: active alerts, breaches today, monitoring runs/findings)
  if (/\b(?:monitoring\s+alerts?|active\s+alerts?|alerts?\s+(?:need|requiring)\s+attention|monitoring\s+(?:run|status|findings|summary|analysis)|analyze\s+(?:the\s+)?(?:latest\s+)?monitoring|what\s+alerts|acknowledged\s+alerts|resolved\s+alerts|flagged\s+today|new\s+breaches)\b/i.test(text)) {
    addScore('MONITORING', 92);
  }

  // PAYMENT_OVERDUE (OVERDUE_COLLECTIONS: overdue invoices, ageing buckets, payment behaviour, days past due)
  if (/\b(?:overdue\s+invoices?|overdue\s+collections?|collections?\s+actions?|collections?\s+risk|how\s+old\s+are\s+they|age?ing\s+bucket|days?\s+past\s+due|delinquent\s+invoices?|payment\s+behavio[u]?r|late\s+payments?|collection\s+priorit|unpaid\s+invoices?|open\s+invoices?\s+overdue)\b/i.test(text)) {
    addScore('PAYMENT_OVERDUE', 90);
  }

  // COMPARE (ranking, highest/lowest, compare X vs Y)
  if (/\b(?:compare|comparison|versus|\bvs\.?\b|which\s+customer\s+has\s+the\s+(?:highest|lowest|most|least|largest|biggest)|who\s+has\s+the\s+(?:highest|most|largest)|top\s+\d+\s+customers?\s+by|rank\s+customers?\s+by|highest\s+(?:credit\s+)?utili[sz]ation|highest\s+exposure)\b/i.test(text)) {
    addScore('COMPARE', 86);
    if (!comparisonDimension) comparisonDimension = 'customer';
  }

  // CUSTOMER_DETAIL (CUSTOMER_EVALUATION: single customer deep dive)
  if (customerIds.length === 1 && !contextResolution.resolvedFromContext) {
    if (/\b(?:detail|details|dossier|profile|full\s+details|evaluate|evaluation|tell\s+me\s+about|explain\s+c0\d\d|show\s+c0\d\d|overview\s+of\s+c0\d\d|open\s+items\s+for|payments\s+for|everything\s+about)\b/i.test(text)
      || text.split(/\s+/).length <= 5) {
      addScore('CUSTOMER_DETAIL', 88);
    } else {
      addScore('CUSTOMER_DETAIL', 55);
    }
  }

  // RISK (high-risk customers, risk distribution, why are they risky, breach/warning analysis)
  if (/\b(?:high[\s-]*risk|risk\s+(?:analysis|assessment|profile|distribution|summary|breakdown|evaluation|factors|flags)|why\s+(?:are\s+they|is\s+it)\s+risky|explain\s+why|risky\s+customers|credit\s+risk\s+across)\b/i.test(text)) {
    addScore('RISK', 84);
  }

  // EXPOSURE (EXPOSURE_BY_COUNTRY / COMPANY_CODE: portfolio exposure, total exposure, exposure by country / company code, available credit)
  if (/\b(?:total\s+(?:portfolio\s+)?(?:credit\s+)?exposure|portfolio\s+(?:exposure|summary|overview|totals|kpis)|exposure\s+by\s+(?:country|company\s*code|segment|customer)|country\s+exposure|company[\s-]*code\s+exposure|exposure\s+breakdown|concentration|overall\s+utili[sz]ation|available\s+credit\s+across)\b/i.test(text)) {
    addScore('EXPOSURE', 88);
  }

  // LIST (UTILISATION_LIST: show all customers, list customers, filter customers, "Customers above 80% utilisation")
  const hasCustomerFilterMention = /\b(?:customers?|accounts?|business\s+partners?)\s+(?:above|over|below|under|with|at|in|exceeding|having|>=|<=|>|<)\b/i.test(text)
    || /^\s*(?:all\s+|breached\s+|flagged\s+|warning\s+)?(?:customers?|accounts?|business\s+partners?)\b/i.test(text);
  if ((/^\s*(?:show|list|display|get|find|give\s+me|which\s+customers\s+are|who\s+are)\b/i.test(text) || hasCustomerFilterMention)
    && /\b(?:customers?|accounts?|business\s+partners?)\b/i.test(text)
    && !/\b(?:highest|lowest|compare|trend|overdue\s+invoices?\s+and\s+how\s+old|overdue\s+invoices?\s+and\s+high\s+exposure|collections?\s+actions?)\b/i.test(text)) {
    addScore('LIST', 87);
  }

  // Special case: "Identify high-risk customers and explain why" -> RISK primary
  if (/\b(?:identify|find|show)\s+high[\s-]*risk\s+customers\s+and\s+explain\s+why\b/i.test(text)) {
    addScore('RISK', 95);
  }

  // Special case: "List high-risk customers and explain why they are risky" -> LIST primary + RISK secondary
  if (/^\s*list\b/i.test(text) && /\b(?:high[\s-]*risk|risky)\b/i.test(text) && /\b(?:explain\s+why|why)\b/i.test(text)) {
    scores.set('LIST', 92);
    scores.set('RISK', 85);
    filters.highRiskOnly = true;
  }

  // Context-inherited intent fallback (e.g., "and for India?" or "Compare their exposure")
  const sortedIntents = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  let primaryIntent;
  let secondaryIntents = [];
  let confidence = 0.85;

  if (sortedIntents.length === 0) {
    if (contextResolution.resolvedFromContext && contextResolution.inheritedIntent) {
      primaryIntent = contextResolution.inheritedIntent;
      confidence = 0.82;
    } else if (customerIds.length === 1) {
      primaryIntent = 'CUSTOMER_DETAIL';
      confidence = 0.85;
    } else if (customerIds.length >= 2) {
      primaryIntent = 'COMPARE';
      comparisonDimension = 'customer';
      confidence = 0.85;
    } else {
      // Never fall back to a random analysis template; use UNKNOWN for unrecognized queries
      primaryIntent = 'UNKNOWN';
      confidence = 0.25;
    }
  } else {
    primaryIntent = sortedIntents[0][0];
    confidence = Math.min(0.98, Math.max(0.6, sortedIntents[0][1] / 100));
    secondaryIntents = sortedIntents
      .slice(1)
      .filter(([intent, score]) => score >= 75 && intent !== primaryIntent)
      .map(([intent]) => intent)
      .slice(0, 1);
  }

  // Refine filters based on chosen intent
  if (primaryIntent === 'RISK' && !filters.highRiskOnly && !filters.minUtilisationPct && !filters.breachOnly && customerIds.length === 0) {
    filters.flaggedOnly = false; // compute risk distribution across all customers, ranking high risk at top
  }

  if (primaryIntent === 'COMPARE' && !comparisonDimension) {
    if (countries.length >= 2 || /\bcountry|countries\b/i.test(text)) comparisonDimension = 'country';
    else if (companyCodes.length >= 2 || /\bcompany\s*code\b/i.test(text)) comparisonDimension = 'companyCode';
    else comparisonDimension = 'customer';
  }

  const INTENT_CATEGORY_MAP = {
    GREETING: 'GREETING / SMALL_TALK',
    SAP_DATASOURCE: 'DATA_SOURCES / CONNECTIVITY_STATUS',
    EXPOSURE: 'EXPOSURE_BY_COUNTRY / COMPANY_CODE',
    LIST: 'UTILISATION_LIST',
    PAYMENT_OVERDUE: 'OVERDUE_COLLECTIONS',
    CUSTOMER_DETAIL: 'CUSTOMER_EVALUATION',
    RISK: 'CUSTOMER_EVALUATION',
    APPROVAL: 'LIMIT_REQUEST_DRAFT',
    WHATIF: 'LIMIT_REQUEST_DRAFT',
    EXPLAIN: 'POLICY_EXPLANATION',
    MONITORING: 'MONITORING_ANALYSIS',
    COMPARE: 'UTILISATION_LIST',
    TREND: 'MONITORING_ANALYSIS',
    CLARIFY: 'UNKNOWN',
    OUT_OF_SCOPE: 'OUT_OF_SCOPE',
    UNKNOWN: 'UNKNOWN'
  };

  const responseBlocks = mergeResponseBlocks(primaryIntent, secondaryIntents);
  const requiredTools = mergeRequiredTools(primaryIntent, secondaryIntents);

  return {
    primaryIntent,
    intentCategory: INTENT_CATEGORY_MAP[primaryIntent] || primaryIntent,
    secondaryIntents,
    confidence,
    customerIds,
    unknownCustomerIds,
    customerNames,
    countries,
    companyCodes,
    metrics: metrics.length ? metrics : ['exposure', 'creditLimit', 'utilisation'],
    period: period || 'current',
    filters,
    comparisonDimension,
    requiredTools,
    responseBlocks,
    resolvedFromContext: contextResolution.resolvedFromContext,
    contextNote: contextResolution.contextNote,
    scenarioParams,
    explainConcept: primaryIntent === 'EXPLAIN' ? detectExplainConcept(text) : null
  };
}

module.exports = {
  VALID_INTENTS,
  KNOWN_CUSTOMERS,
  KNOWN_CUSTOMER_IDS,
  INTENT_BLOCKS,
  INTENT_TOOLS,
  parseMonetaryAmount,
  extractEntities,
  classifyIntentDeterministically
};
