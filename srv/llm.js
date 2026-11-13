const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const UNSUPPORTED_GEMINI_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'maxLength',
  'exclusiveMinimum',
  'minimum',
  'maximum',
  'minItems',
  'maxItems'
]);

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  const sanitized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_GEMINI_SCHEMA_KEYS.has(key)) continue;
    sanitized[key] = sanitizeGeminiSchema(value);
  }
  return sanitized;
}

function normalizeTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;

  const timeoutMs = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`LLM_TIMEOUT_MS must be a positive whole number no greater than ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function providerError(message, category, statusCode) {
  const error = new Error(message);
  error.category = category;
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

function normalizeResponse(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Array.isArray(result.content) || result.content.length === 0) {
    throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
  }

  const toolCalls = [];
  const textBlocks = [];
  for (const block of result.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw providerError('LLM provider returned an invalid response block.', 'provider_response_invalid');
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text);
      continue;
    }
    if (block.type === 'tool_use'
      && typeof block.id === 'string' && block.id.trim()
      && typeof block.name === 'string' && block.name.trim()
      && block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input)) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
      continue;
    }
    throw providerError('LLM provider returned an invalid response block.', 'provider_response_invalid');
  }

  return {
    content: result.content,
    text: textBlocks.join('\n'),
    toolCalls
  };
}

class AnthropicProvider {
  constructor({ apiKey, model, timeoutMs }) {
    if (!apiKey) throw new Error('Anthropic API key is required.');
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-5-5';
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
  }

  async complete({ messages, tools, system, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: this.model, max_tokens: 1200, system, tools, messages }),
        signal: controller.signal
      });
      if (!response || typeof response.ok !== 'boolean') {
        throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
      }

      if (!response.ok) {
        const statusCode = Number.isInteger(response.status) ? response.status : undefined;
        const category = statusCode === 401 || statusCode === 403
          ? 'provider_authentication'
          : statusCode === 429 ? 'rate_limited' : 'provider_error';
        throw providerError(
          statusCode ? `LLM provider returned HTTP ${statusCode}.` : 'LLM provider returned an HTTP error.',
          category,
          statusCode
        );
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw providerError('LLM provider returned invalid JSON.', 'provider_response_invalid');
      }
      return normalizeResponse(result);
    } catch (error) {
      if (timedOut) {
        throw providerError('LLM provider timed out.', 'provider_timeout');
      }
      if (signal?.aborted) throw signal.reason || error;
      if (error?.category) throw error;
      throw providerError('LLM provider is unavailable.', 'provider_unavailable');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

class GeminiProvider {
  #client;

  constructor({ apiKey, model, timeoutMs, client } = {}) {
    if (!apiKey) throw new Error('Gemini API key is required.');
    this.model = model || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    if (client) {
      this.#client = client;
    } else {
      const { GoogleGenAI } = require('@google/genai');
      this.#client = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    }
  }

  async complete({ messages, tools = [], tool_choice: toolChoice, system, signal, responseSchema, responseMimeType } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    try {
      const functionDeclarations = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: sanitizeGeminiSchema(tool.input_schema)
      }));
      const functionCallingConfig = toolChoice?.type === 'tool'
        ? {
          mode: 'ANY',
          allowedFunctionNames: [toolChoice.name]
        }
        : functionDeclarations.length ? { mode: 'AUTO' } : undefined;
      const response = await this.#client.models.generateContent({
        model: this.model,
        contents: messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(message.content ?? '') }]
        })),
        config: {
          systemInstruction: system,
          maxOutputTokens: 1200,
          abortSignal: controller.signal,
          automaticFunctionCalling: { disable: true },
          ...(responseSchema ? {
            responseMimeType: responseMimeType || 'application/json',
            responseSchema: sanitizeGeminiSchema(responseSchema)
          } : {}),
          ...(functionDeclarations.length ? {
            tools: [{ functionDeclarations }],
            ...(functionCallingConfig ? {
              toolConfig: { functionCallingConfig }
            } : {})
          } : {})
        }
      });

      const candidateParts = response?.candidates?.[0]?.content?.parts;
      const functionCalls = Array.isArray(response?.functionCalls)
        ? response.functionCalls
        : Array.isArray(candidateParts)
          ? candidateParts.map(part => part?.functionCall).filter(Boolean)
          : [];
      const text = Array.isArray(candidateParts)
        ? candidateParts.map(part => part?.text).filter(value => typeof value === 'string').join('\n')
        : typeof response?.text === 'string'
          ? response.text
          : '';
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const [index, call] of functionCalls.entries()) {
        if (typeof call?.name !== 'string' || !call.name.trim()
          || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
          throw providerError('LLM provider returned an invalid function call.', 'provider_response_invalid');
        }
        content.push({
          type: 'tool_use',
          id: typeof call.id === 'string' && call.id.trim() ? call.id : `gemini-call-${index + 1}`,
          name: call.name,
          input: call.args
        });
      }
      if (!content.length) {
        throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
      }
      return {
        content,
        text,
        toolCalls: content.filter(block => block.type === 'tool_use').map(block => ({
          id: block.id,
          name: block.name,
          input: block.input
        }))
      };
    } catch (error) {
      if (timedOut) {
        throw providerError('LLM provider timed out.', 'provider_timeout');
      }
      if (signal?.aborted) throw signal.reason || error;
      if (error?.category) throw error;
      const rawStatus = error?.status ?? error?.statusCode ?? error?.code;
      const status = Number(rawStatus);
      if (status === 401 || status === 403) {
        throw providerError('Gemini rejected the configured credentials.', 'provider_authentication', status);
      }
      if (status === 429) {
        throw providerError('Gemini rate limit was reached.', 'rate_limited', status);
      }
      if (status === 503 || status === 502) {
        throw providerError('Gemini is temporarily unavailable.', 'provider_unavailable', status);
      }
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        throw providerError('Gemini rejected the request.', 'provider_error', status);
      }
      if (Number.isInteger(status) && status >= 500) {
        throw providerError('Gemini is temporarily unavailable.', 'provider_unavailable', status);
      }
      if (error instanceof TypeError && /invalid (response|function call)/i.test(error.message)) {
        throw error;
      }
      throw providerError('LLM provider is unavailable.', 'provider_unavailable');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function createLlmProvider({ providerName = 'anthropic', apiKey, model, timeoutMs, client } = {}) {
  if (!['anthropic', 'gemini', 'offline'].includes(providerName)) {
    throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
  const validatedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (providerName === 'offline') return null;
  if (!apiKey) return null;
  if (providerName === 'gemini') {
    return new GeminiProvider({ apiKey, model, timeoutMs: validatedTimeoutMs, client });
  }
  return new AnthropicProvider({ apiKey, model, timeoutMs: validatedTimeoutMs });
}

async function testGeminiConnectivity({ apiKey, model, timeoutMs, provider, client } = {}) {
  const selectedProvider = provider || createLlmProvider({
    providerName: 'gemini',
    apiKey,
    model,
    timeoutMs,
    client
  });
  if (!selectedProvider) {
    return { ok: false, errorCategory: 'provider_not_configured' };
  }
  try {
    const response = await selectedProvider.complete({
      system: 'Reply with the single word OK. Do not call tools.',
      messages: [{ role: 'user', content: 'Connectivity check.' }],
      tools: []
    });
    if (response?.toolCalls?.length || typeof response?.text !== 'string' || !response.text.trim()) {
      return { ok: false, errorCategory: 'provider_response_invalid' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errorCategory: error?.category || 'provider_unavailable',
      ...(Number.isInteger(error?.statusCode) ? { statusCode: error.statusCode } : {})
    };
  }
}

const ROUTER_TIMEOUT_MS = 5000;
const ROUTER_MAX_RETRIES = 1;
const ROUTER_RETRY_DELAY_MS = 250;

const ALLOWED_ROUTER_INTENTS = Object.freeze([
  'GREETING',
  'HOW_ARE_YOU',
  'THANKS',
  'GOODBYE',
  'HELP',
  'OFF_TOPIC',
  'CLARIFY',
  'CUSTOMER_COUNT',
  'CUSTOMER_LIST',
  'UTILISATION_LIST',
  'HIGH_RISK_CUSTOMERS',
  'CUSTOMERS_NO_LIMIT',
  'CUSTOMER_EVALUATION',
  'LIMIT_REQUEST_DRAFT',
  'LIMIT_INCREASE_RECOMMENDATION',
  'EXPOSURE_BY_COUNTRY',
  'EXPOSURE_BY_COMPANY_CODE',
  'PORTFOLIO_SUMMARY',
  'CREDIT_OVERVIEW_SUMMARY',
  'OVERDUE_COLLECTIONS',
  'MONITORING_ALERTS',
  'MONITORING_ANALYSIS',
  'LIMIT_APPROVALS_STATUS',
  'DATA_SOURCES_STATUS',
  'DATA_EXTRACTION_TIMELINE',
  'CDS_ENTITIES_LIST',
  'MOCK_SAP_STAGING',
  'POLICY_EXPLANATION',
  'AUDIT_HISTORY',
  'WORKSPACE_NAVIGATION',
  'SCREEN_CONTEXT',
  'WORKSPACE_QUERY'
]);

const ALLOWED_ENTITY_ENUM = Object.freeze([
  'customers',
  'country_exposure',
  'company_code_exposure',
  'overview_kpis',
  'attention_items',
  'alerts',
  'findings',
  'monitoring_runs',
  'limit_drafts',
  'limit_requests',
  'connectors',
  'cds_entities',
  'extraction_runs',
  'scheduler_status',
  'mock_sap_staging',
  'audit_runs',
  'tab_navigation',
  'screen_context'
]);

const ALLOWED_OPERATION_ENUM = Object.freeze([
  'LIST',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_BY',
  'TOP_N',
  'DETAIL',
  'COMPARE',
  'EXPLAIN',
  'STATUS_SUMMARY',
  'NAVIGATE'
]);

const CANONICAL_COLUMN_ENUM = [
  'customer',
  'id',
  'name',
  'type',
  'mode',
  'freshness',
  'lastRetrieved',
  'country',
  'companyCode',
  'creditLimit',
  'exposure',
  'availableCredit',
  'utilisation',
  'overdue',
  'overdueInvoiceCount',
  'riskClass',
  'status',
  'severity',
  'requestedBy',
  'requestedLimit',
  'currentLimit',
  'approverLevel',
  'runTime',
  'source',
  'duration',
  'records',
  'entityName',
  'sapSource',
  'category'
];

const ROUTER_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...ALLOWED_ROUTER_INTENTS] },
    entity: { type: 'string', enum: [...ALLOWED_ENTITY_ENUM] },
    operation: { type: 'string', enum: [...ALLOWED_OPERATION_ENUM] },
    groupBy: { type: 'string' },
    targetTab: { type: 'string', enum: ['overview', 'dashboard', 'analysis', 'approvals', 'simulator', 'audit', 'chat'] },
    entities: {
      type: 'object',
      properties: {
        customerIds: { type: 'array', items: { type: 'string' } },
        customerId: { type: 'string' },
        companyCode: { type: 'string' },
        country: { type: 'string' },
        threshold: { type: 'number' },
        status: { type: 'string' },
        statuses: { type: 'array', items: { type: 'string' } },
        severity: { type: 'string' },
        metric: { type: 'string' }
      }
    },
    display: {
      type: 'object',
      properties: {
        columns: {
          type: 'object',
          properties: {
            include: { type: 'array', items: { type: 'string' } },
            exclude: { type: 'array', items: { type: 'string' } }
          }
        },
        sortBy: { type: 'string' },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
        format: { type: 'string', enum: ['table', 'summary', 'count', 'chart'] },
        timeRange: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' }
          }
        }
      }
    },
    confidence: { type: 'number' }
  },
  required: ['intent', 'entities', 'display', 'confidence']
};

function isRetryableCategory(category) {
  return ['provider_timeout', 'provider_unavailable', 'rate_limited'].includes(category);
}

function normalizeDisplayPlan(rawDisplay = {}) {
  const src = rawDisplay && typeof rawDisplay === 'object' ? rawDisplay : {};
  const rawCols = src.columns && typeof src.columns === 'object' ? src.columns : {};
  const normalizeColList = arr => (Array.isArray(arr)
    ? arr.map(c => String(c || '').trim()).filter(c => CANONICAL_COLUMN_ENUM.includes(c))
    : []);

  const include = normalizeColList(rawCols.include);
  const exclude = normalizeColList(rawCols.exclude);
  const sortDir = src.sortDir === 'asc' || src.sortDir === 'desc' ? src.sortDir : null;
  const limit = typeof src.limit === 'number' && Number.isInteger(src.limit) && src.limit > 0 ? src.limit : null;
  const format = ['table', 'summary', 'count', 'chart'].includes(src.format) ? src.format : 'table';
  const rawTime = src.timeRange && typeof src.timeRange === 'object' ? src.timeRange : null;
  const timeRange = rawTime && (rawTime.from || rawTime.to)
    ? { from: rawTime.from || null, to: rawTime.to || null }
    : null;

  return {
    columns: { include, exclude },
    sortBy: typeof src.sortBy === 'string' && src.sortBy.trim() ? src.sortBy.trim() : null,
    sortDir,
    limit,
    format,
    timeRange
  };
}

async function classifyIntentWithGemini({
  message,
  context = null,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.LLM_MODEL || DEFAULT_GEMINI_MODEL,
  timeoutMs = ROUTER_TIMEOUT_MS,
  maxRetries = ROUTER_MAX_RETRIES,
  provider,
  client
} = {}) {
  const question = String(message || '').trim();
  const emptyDisplay = normalizeDisplayPlan();
  if (!question) {
    return {
      usedGemini: false,
      intent: 'CLARIFY',
      entity: null,
      operation: 'EXPLAIN',
      groupBy: null,
      targetTab: null,
      entities: { customerIds: [], customerId: null, country: null, companyCode: null, threshold: null, status: null, statuses: [], severity: null, metric: null },
      display: emptyDisplay,
      confidence: 0,
      reason: 'empty_message'
    };
  }

  const selectedProvider = provider || createLlmProvider({
    providerName: 'gemini',
    apiKey,
    model,
    timeoutMs,
    client
  });
  if (!selectedProvider) {
    return {
      usedGemini: false,
      intent: null,
      entity: null,
      operation: null,
      groupBy: null,
      targetTab: null,
      entities: { customerIds: [], customerId: null, country: null, companyCode: null, threshold: null, status: null, statuses: [], severity: null, metric: null },
      display: emptyDisplay,
      confidence: 0,
      reason: 'provider_not_configured'
    };
  }

  const contextHint = context && context.intent
    ? `\nPrevious turn context: intent=${context.intent}, entity=${context.entity || 'none'}, entities=${JSON.stringify(context.entities || {})}. Current tab=${context.currentTab || 'chat'}, lastViewed=${context.lastViewed || 'overview'}. ONLY keep previous intent if the new query explicitly refines it (e.g. "and only India?", "sort by overdue", "those customers"). If the user asks a new topic, ignore previous context.`
    : '';

  const systemPrompt = [
    'You are the workspace query planner for Credit Guard (Bluspring Enterprises SAP credit limit & accounts receivable app).',
    'Return ONLY valid JSON: { intent, entity, operation, groupBy, targetTab, entities, display, confidence }.',
    `Registry entities (${ALLOWED_ENTITY_ENUM.join(', ')}):`,
    '- Credit Overview tab: overview_kpis, attention_items',
    '- Portfolio & Monitoring tab: monitoring_runs, alerts, findings, limit_drafts',
    '- Exposure Analysis tab: country_exposure, company_code_exposure, customers',
    '- Limit Approvals tab: limit_requests',
    '- SAP BTP & HANA CDS tab: connectors, cds_entities, extraction_runs, scheduler_status, mock_sap_staging',
    '- AI Audit History tab: audit_runs',
    '- Screen & navigation: screen_context ("what am I looking at?", "explain this screen"), tab_navigation ("Where can I see ...?")',
    `Operations: ${ALLOWED_OPERATION_ENUM.join(', ')}.`,
    'Synonym & typo rules:',
    '- "source id" / "sorceid" / "connector id" -> entity: connectors, display.columns.include: ["id"]',
    '- "ready to connect" / "standby" -> entities.status: "STANDBY", entities.statuses: ["STANDBY"]; "active"/"connected" -> "ACTIVE"',
    '- "credit limit with country wise" -> entity: country_exposure, operation: GROUP_BY, groupBy: "country", entities.metric: "creditLimit"',
    `- Map columns to canonical keys (${CANONICAL_COLUMN_ENUM.join(', ')}). "country code" and "company code" both map to "companyCode".`,
    '- Put removed columns ("without X" / "excluding X") in display.columns.exclude; put requested columns ("with X" / "along with X" / "only X" / "with id") in display.columns.include.',
    '- Normalize countries to India, UAE, Singapore, United States, United Kingdom, Germany.',
    '- NEVER invent numbers, counts, or IDs. Return JSON only.'
  ].join('\n') + contextHint;

  let lastErrorCategory = 'provider_unavailable';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, ROUTER_RETRY_DELAY_MS));
    }
    try {
      const response = await selectedProvider.complete({
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
        tools: [],
        responseMimeType: 'application/json',
        responseSchema: ROUTER_CLASSIFICATION_SCHEMA
      });
      const rawText = String(response?.text || '').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
      const intent = ALLOWED_ROUTER_INTENTS.includes(parsed?.intent) ? parsed.intent : 'CLARIFY';
      const entity = ALLOWED_ENTITY_ENUM.includes(parsed?.entity) ? parsed.entity : null;
      const operation = ALLOWED_OPERATION_ENUM.includes(parsed?.operation) ? parsed.operation : 'LIST';
      const groupBy = typeof parsed?.groupBy === 'string' && parsed.groupBy.trim() ? parsed.groupBy.trim() : null;
      const targetTab = typeof parsed?.targetTab === 'string' && parsed.targetTab.trim() ? parsed.targetTab.trim().toLowerCase() : null;
      const rawConf = Number(parsed?.confidence);
      const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.5;
      const rawEnt = parsed?.entities && typeof parsed.entities === 'object' ? parsed.entities : {};
      const customerIds = Array.isArray(rawEnt.customerIds)
        ? rawEnt.customerIds.map(id => String(id || '').trim().toUpperCase()).filter(Boolean)
        : [];
      if (typeof rawEnt.customerId === 'string' && rawEnt.customerId.trim()) {
        const cid = rawEnt.customerId.trim().toUpperCase();
        if (!customerIds.includes(cid)) customerIds.unshift(cid);
      }

      const statuses = Array.isArray(rawEnt.statuses)
        ? rawEnt.statuses.map(s => String(s || '').trim().toUpperCase()).filter(Boolean)
        : [];

      const entities = {
        customerIds,
        customerId: customerIds[0] || null,
        companyCode: typeof rawEnt.companyCode === 'string' && rawEnt.companyCode.trim() ? rawEnt.companyCode.trim().toUpperCase() : null,
        country: typeof rawEnt.country === 'string' && rawEnt.country.trim() ? rawEnt.country.trim() : null,
        threshold: typeof rawEnt.threshold === 'number' && Number.isFinite(rawEnt.threshold) ? rawEnt.threshold : null,
        status: typeof rawEnt.status === 'string' && rawEnt.status.trim() ? rawEnt.status.trim().toUpperCase() : null,
        statuses,
        severity: typeof rawEnt.severity === 'string' && rawEnt.severity.trim() ? rawEnt.severity.trim().toUpperCase() : null,
        metric: typeof rawEnt.metric === 'string' && rawEnt.metric.trim() ? rawEnt.metric.trim() : null
      };

      const display = normalizeDisplayPlan(parsed?.display);

      return { usedGemini: true, intent, entity, operation, groupBy, targetTab, entities, display, confidence };
    } catch (error) {
      lastErrorCategory = error?.category || 'provider_response_invalid';
      if (!isRetryableCategory(lastErrorCategory) || attempt >= maxRetries) {
        return {
          usedGemini: false,
          intent: null,
          entity: null,
          operation: null,
          groupBy: null,
          targetTab: null,
          entities: { customerIds: [], customerId: null, country: null, companyCode: null, threshold: null, status: null, statuses: [], severity: null, metric: null },
          display: emptyDisplay,
          confidence: 0,
          reason: lastErrorCategory
        };
      }
    }
  }
  return {
    usedGemini: false,
    intent: null,
    entity: null,
    operation: null,
    groupBy: null,
    targetTab: null,
    entities: { customerIds: [], customerId: null, country: null, companyCode: null, threshold: null, status: null, statuses: [], severity: null, metric: null },
    display: emptyDisplay,
    confidence: 0,
    reason: lastErrorCategory
  };
}

function extractNumericAndIdTokens(text) {
  const clean = String(text || '');
  const numbers = (clean.match(/\d+(?:[.,]\d+)*/g) || []).map(token => token.replace(/,/g, ''));
  const ids = (clean.match(/\b(?:MS-)?C\d{3}\b/gi) || []).map(token => token.toUpperCase());
  return { numbers: new Set(numbers), ids: new Set(ids) };
}

async function polishHeadlineWithGemini({
  question,
  intent,
  headline,
  facts = {},
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.LLM_MODEL || DEFAULT_GEMINI_MODEL,
  timeoutMs = ROUTER_TIMEOUT_MS,
  maxRetries = ROUTER_MAX_RETRIES,
  provider,
  client
} = {}) {
  const baseHeadline = String(headline || '').trim();
  if (!baseHeadline) return { polished: false, headline: baseHeadline, reason: 'empty_headline' };

  const selectedProvider = provider || createLlmProvider({
    providerName: 'gemini',
    apiKey,
    model,
    timeoutMs,
    client
  });
  if (!selectedProvider) {
    return { polished: false, headline: baseHeadline, reason: 'provider_not_configured' };
  }

  const allowedSource = `${baseHeadline} ${JSON.stringify(facts || {})}`;
  const allowedTokens = extractNumericAndIdTokens(allowedSource);

  const systemPrompt = [
    'Rewrite the provided single-sentence credit analytics headline to sound crisp and executive-friendly.',
    'STRICT RULES:',
    '1. Output ONLY ONE concise plain-text sentence (max 28 words, no markdown, no bullets).',
    '2. Keep EVERY number, percentage, currency value, count, customer ID, and status EXACTLY identical to the input.',
    '3. Do NOT invent, round, or infer any new number or customer name.'
  ].join('\n');

  const userPrompt = `Intent: ${intent}\nQuestion: ${String(question || '').trim()}\nHeadline: ${baseHeadline}\nFacts: ${JSON.stringify(facts || {})}`;

  let lastReason = 'provider_unavailable';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, ROUTER_RETRY_DELAY_MS));
    }
    try {
      const response = await selectedProvider.complete({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: []
      });
      const candidate = String(response?.text || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ');
      if (!candidate || candidate.length > 260 || candidate.includes('\n')) {
        return { polished: false, headline: baseHeadline, reason: 'invalid_headline_format' };
      }
      const candidateTokens = extractNumericAndIdTokens(candidate);
      for (const num of candidateTokens.numbers) {
        if (!allowedTokens.numbers.has(num)) {
          return { polished: false, headline: baseHeadline, reason: 'number_mismatch' };
        }
      }
      for (const id of candidateTokens.ids) {
        if (!allowedTokens.ids.has(id)) {
          return { polished: false, headline: baseHeadline, reason: 'id_mismatch' };
        }
      }
      return { polished: true, headline: candidate };
    } catch (error) {
      lastReason = error?.category || 'provider_unavailable';
      if (!isRetryableCategory(lastReason) || attempt >= maxRetries) {
        return { polished: false, headline: baseHeadline, reason: lastReason };
      }
    }
  }
  return { polished: false, headline: baseHeadline, reason: lastReason };
}

module.exports = {
  AnthropicProvider,
  GeminiProvider,
  createLlmProvider,
  testGeminiConnectivity,
  classifyIntentWithGemini,
  polishHeadlineWithGemini,
  ALLOWED_ROUTER_INTENTS,
  normalizeTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_GEMINI_MODEL,
  ROUTER_TIMEOUT_MS
};
