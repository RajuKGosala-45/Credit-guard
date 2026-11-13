const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  classifyIntentWithGemini,
  polishHeadlineWithGemini,
  ALLOWED_ROUTER_INTENTS,
  ROUTER_TIMEOUT_MS
} = require('../srv/llm');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');
let moduleSeq = 0;

async function loadChatModules() {
  const utils = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utils).toString('base64')}`;

  let blockSource = await fs.readFile(path.join(appRoot, 'views', 'blockRenderer.js'), 'utf8');
  blockSource = blockSource.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const blockUrl = `data:text/javascript;base64,${Buffer.from(blockSource).toString('base64')}#br${moduleSeq += 1}`;

  let wsSource = await fs.readFile(path.join(appRoot, 'views', 'workspaceContext.js'), 'utf8');
  wsSource = wsSource.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const wsUrl = `data:text/javascript;base64,${Buffer.from(wsSource).toString('base64')}#ws${moduleSeq += 1}`;

  let chatSource = await fs.readFile(path.join(appRoot, 'views', 'chat.js'), 'utf8');
  chatSource = chatSource.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  chatSource = chatSource.replaceAll("'./blockRenderer.js'", `'${blockUrl}'`);
  const chatUrl = `data:text/javascript;base64,${Buffer.from(chatSource).toString('base64')}#ch${moduleSeq += 1}`;

  const [blockMod, wsMod, chatMod] = await Promise.all([import(blockUrl), import(wsUrl), import(chatUrl)]);
  if (typeof chatMod.setWorkspaceContextModule === 'function') {
    chatMod.setWorkspaceContextModule(wsMod.default || wsMod);
  }
  return { ...blockMod, ...wsMod, ...chatMod };
}

function createFakeNode(tagName) {
  const attributes = {};
  const listeners = {};
  const node = {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    _text: '',
    setAttribute(key, value) {
      attributes[key] = String(value);
    },
    getAttribute(key) {
      return attributes[key];
    },
    appendChild(child) {
      if (!child) return child;
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const n of nodes) {
        if (n) this.appendChild(n);
      }
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn({ target: this, preventDefault() {} });
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = cur => {
        for (const c of cur.children || []) {
          if (matchesSelector(c, selector)) results.push(c);
          visit(c);
        }
      };
      visit(this);
      return results;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    get textContent() {
      return [this._text, ...this.children.map(c => c.textContent)].filter(Boolean).join(' ');
    },
    set textContent(v) {
      this._text = String(v ?? '');
      this.children = [];
    },
    toHTML() {
      const cls = this.className ? ` class="${this.className}"` : '';
      const attrStr = Object.entries(attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
      const inner = [this._text, ...this.children.map(c => c.toHTML())].join('');
      return `<${this.tagName.toLowerCase()}${cls}${attrStr}>${inner}</${this.tagName.toLowerCase()}>`;
    }
  };
  return node;
}

function matchesSelector(node, selector) {
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const inside = selector.slice(1, -1);
    const [k, rawV] = inside.split('=');
    const val = rawV ? rawV.replace(/^["']|["']$/g, '') : null;
    const actual = node.getAttribute(k);
    return val === null ? actual !== undefined : actual === val;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function installFakeDom(t, extraSelectors = {}) {
  const originalDocument = globalThis.document;
  const selectors = { ...extraSelectors };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: tag => createFakeNode(tag),
      addEventListener() {},
      querySelector: sel => selectors[sel] || null
    }
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  });
  return selectors;
}

function createSamplePortfolioState() {
  const customers = [
    { ID: 'C001', name: 'Aarav Industrial Components Pvt Ltd', country: 'India', companyCode: 'BS01', creditLimit: 1200000, exposure: 1475000, utilisation: 1.229, overdueAmount: 425000, overdueInvoiceCount: 2, riskClass: 'High Risk', status: 'BREACH' },
    { ID: 'C002', name: 'Gulf Horizon Logistics LLC', country: 'UAE', companyCode: 'BS02', creditLimit: 1500000, exposure: 1530000, utilisation: 1.02, overdueAmount: 310000, overdueInvoiceCount: 1, riskClass: 'High Risk', status: 'BREACH' },
    { ID: 'C003', name: 'Meridian Pacific Trading Pte Ltd', country: 'Singapore', companyCode: 'BS03', creditLimit: 1100000, exposure: 1050000, utilisation: 0.955, overdueAmount: 180000, overdueInvoiceCount: 1, riskClass: 'Watchlist', status: 'WARNING' },
    { ID: 'C004', name: 'Deccan Precision Castings Ltd', country: 'India', companyCode: 'BS01', creditLimit: 900000, exposure: 765000, utilisation: 0.85, overdueAmount: 95000, overdueInvoiceCount: 1, riskClass: 'Watchlist', status: 'WARNING' },
    { ID: 'C005', name: 'Al Noor Engineering Supplies FZCO', country: 'UAE', companyCode: 'BS02', creditLimit: 800000, exposure: 660000, utilisation: 0.825, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'WARNING' },
    { ID: 'C006', name: 'Bharath Agri-Inputs Pvt Ltd', country: 'India', companyCode: 'BS04', creditLimit: 700000, exposure: 575000, utilisation: 0.821, overdueAmount: 75000, overdueInvoiceCount: 1, riskClass: 'Normal', status: 'WARNING' },
    { ID: 'C007', name: 'Kaveri Textile Mills Pvt Ltd', country: 'India', companyCode: 'BS01', creditLimit: 1000000, exposure: 520000, utilisation: 0.52, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C008', name: 'Emirates Steel Fabrication Co', country: 'UAE', companyCode: 'BS02', creditLimit: 1300000, exposure: 610000, utilisation: 0.469, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C009', name: 'Sentosa Marine Systems Pte Ltd', country: 'Singapore', companyCode: 'BS03', creditLimit: 950000, exposure: 410000, utilisation: 0.432, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C010', name: 'Vindhya Pharma Distributors LLP', country: 'India', companyCode: 'BS04', creditLimit: 850000, exposure: 350000, utilisation: 0.412, overdueAmount: 45000, overdueInvoiceCount: 1, riskClass: 'Normal', status: 'OK' },
    { ID: 'C011', name: 'Lion City Electronics Pte Ltd', country: 'Singapore', companyCode: 'BS05', creditLimit: 750000, exposure: 280000, utilisation: 0.373, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C012', name: 'Desert Crescent Foods LLC', country: 'UAE', companyCode: 'BS05', creditLimit: 600000, exposure: 190000, utilisation: 0.317, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C013', name: 'Narmada Infrastructure & Pipes Ltd', country: 'India', companyCode: 'BS01', creditLimit: 0, exposure: 210000, utilisation: null, overdueAmount: 60000, overdueInvoiceCount: 1, riskClass: 'C', status: 'MANUAL_REVIEW' }
  ];

  return {
    retrievedAt: new Date().toISOString(),
    extractionStatus: 'SUCCESS',
    customers,
    approvals: [
      { ID: 'REQ-01', customer_ID: 'C001', customerName: 'Aarav Industrial Components Pvt Ltd', currentLimit: 1200000, requestedLimit: 1650000, status: 'Pending', approverLevel: 'Finance Head', reason: 'Seasonal order surge' }
    ],
    monitoringData: {
      summary: {
        breachCount: 2,
        warningCount: 4,
        latestRun: { status: 'COMPLETED', completedAt: new Date().toISOString() }
      },
      alerts: [
        { severity: 'CRITICAL', customerId: 'C001', title: 'Credit limit breached at 122.9%', description: 'Exposure exceeds limit by INR 2,75,000', status: 'OPEN', recommendedAction: 'Hold new dispatches or escalate increase' },
        { severity: 'WARNING', customerId: 'C003', title: 'High utilisation warning at 95.5%', description: 'Approaching hard limit threshold', status: 'OPEN', recommendedAction: 'Collect overdue invoice INV-301' }
      ]
    },
    mockSap: {
      sources: [{ sourceName: 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)', latestRun: { status: 'COMPLETED', completedAt: new Date().toISOString() } }],
      fixtureCounts: { CUSTOMER: 13, CREDIT_ACCOUNT: 13, INVOICE: 19, PAYMENT: 10 }
    },
    v2Connectors: {
      mappingsCount: 15,
      sources: [
        { source_id: 'CAP-HANA-CDS', source_name: 'Credit Guard CAP / HANA CDS Store', source_type: 'HANA_CDS', status: 'ACTIVE', last_sync_at: new Date().toISOString() },
        { source_id: 'MOCK-SAP-FIN-FSCM', source_name: 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)', source_type: 'MOCK_SAP', status: 'DEMO', last_sync_at: new Date().toISOString() },
        { source_id: 'SAP-BTP-DEST-ABAP', source_name: 'SAP BTP ABAP Environment Destination', source_type: 'SAP_BTP_DEST', status: 'STANDBY', last_sync_at: null }
      ]
    }
  };
}

// --- 1. Server-Side Layer A Gemini Classifier & Headline Polish Tests ---

test('classifyIntentWithGemini parses JSON intent schema and retries once on timeout', async () => {
  assert.equal(ROUTER_TIMEOUT_MS, 5000);
  let calls = 0;
  const mockProvider = {
    async complete(req) {
      calls += 1;
      assert.equal(req.responseMimeType, 'application/json');
      assert.ok(ALLOWED_ROUTER_INTENTS.includes('CUSTOMER_LIST'));
      if (calls === 1) {
        const err = new Error('timeout');
        err.category = 'provider_timeout';
        throw err;
      }
      return {
        text: JSON.stringify({
          intent: 'CUSTOMER_LIST',
          entities: { country: 'India', companyCode: 'bs01', customerId: 'c001' },
          display: {
            columns: { include: ['country', 'companyCode'], exclude: [] },
            sortBy: 'exposure',
            sortDir: 'desc',
            limit: 5,
            format: 'table',
            timeRange: null
          },
          confidence: 0.91
        })
      };
    }
  };

  const result = await classifyIntentWithGemini({
    message: 'show Indian customers in bs01 along with country and company code top 5',
    provider: mockProvider
  });

  assert.equal(calls, 2);
  assert.equal(result.usedGemini, true);
  assert.equal(result.intent, 'CUSTOMER_LIST');
  assert.equal(result.confidence, 0.91);
  assert.equal(result.entities.country, 'India');
  assert.equal(result.entities.companyCode, 'BS01');
  assert.equal(result.entities.customerId, 'C001');
  assert.deepEqual(result.display.columns.include, ['country', 'companyCode']);
  assert.deepEqual(result.display.columns.exclude, []);
  assert.equal(result.display.sortBy, 'exposure');
  assert.equal(result.display.sortDir, 'desc');
  assert.equal(result.display.limit, 5);
  assert.equal(result.display.format, 'table');
});

test('classifyIntentWithGemini handles missing API key without throwing', async () => {
  const result = await classifyIntentWithGemini({
    message: 'List customers',
    apiKey: ''
  });
  assert.equal(result.usedGemini, false);
  assert.equal(result.reason, 'provider_not_configured');
});

test('polishHeadlineWithGemini accepts faithful rewrites and rejects invented numbers or IDs', async () => {
  const faithful = await polishHeadlineWithGemini({
    question: 'How many customers?',
    intent: 'CUSTOMER_COUNT',
    headline: 'There are 13 active customers (0 inactive) in Credit Guard.',
    facts: { active: 13, inactive: 0 },
    provider: {
      async complete() {
        return { text: 'Credit Guard tracks 13 active customers with 0 inactive accounts across all entities.' };
      }
    }
  });
  assert.equal(faithful.polished, true);

  const hallucinatedNumber = await polishHeadlineWithGemini({
    question: 'How many customers?',
    intent: 'CUSTOMER_COUNT',
    headline: 'There are 13 active customers (0 inactive) in Credit Guard.',
    facts: { active: 13, inactive: 0 },
    provider: {
      async complete() {
        return { text: 'Credit Guard tracks 15 active customers across India and UAE.' };
      }
    }
  });
  assert.equal(hallucinatedNumber.polished, false);
  assert.equal(hallucinatedNumber.reason, 'number_mismatch');

  const hallucinatedId = await polishHeadlineWithGemini({
    question: 'Evaluate C001',
    intent: 'CUSTOMER_EVALUATION',
    headline: 'Aarav Industrial (C001) is at 122.9% utilisation.',
    facts: { customerId: 'C001', utilisation: 122.9 },
    provider: {
      async complete() {
        return { text: 'Customer C999 is at 122.9% utilisation.' };
      }
    }
  });
  assert.equal(hallucinatedId.polished, false);
  assert.ok(['id_mismatch', 'number_mismatch'].includes(hallucinatedId.reason));
});

// --- 2. Typo Tolerance & Client Classifier Checklist Tests ---

test('typo tolerance normalizes messy queries accurately', async () => {
  const { normalizeQueryWithTypoTolerance } = await loadChatModules();
  assert.equal(normalizeQueryWithTypoTolerance('List out all customers and thier exposers in sources').normalizedText,
    'list out all customers and their exposures in sources');
  assert.equal(normalizeQueryWithTypoTolerance('Are you ate breakfst?').normalizedText,
    'are you ate breakfast');
  assert.equal(normalizeQueryWithTypoTolerance('customrs above 80% utilzation').normalizedText,
    'customers above 80% utilisation');
});

test('all 11 acceptance checklist prompts classify to the expected intent with accurate data and badges', async t => {
  const {
    classifyClientIntent,
    buildLocalStructuredResponse,
    renderChat,
    resetChatRouterState
  } = await loadChatModules();
  resetChatRouterState();

  const host = createFakeNode('div');
  installFakeDom(t, { '#chat-messages': host });
  const state = createSamplePortfolioState();

  // Checklist 1: "Hi"
  const c1 = classifyClientIntent('Hi', state);
  assert.equal(c1.intent, 'GREETING');
  const r1 = buildLocalStructuredResponse('Hi', state, c1);
  renderChat([{ role: 'user', text: 'Hi' }, { role: 'assistant', text: r1.summary, structuredResponse: r1 }]);
  let html1 = host.toHTML();
  assert.doesNotMatch(html1, /Calculated from portfolio data|Gemini-polished|Offline fallback|DEMO DATA/);
  assert.equal(host.querySelectorAll('.re-followup-chip').length, 3);

  // Checklist 2: "What can you do for me?"
  const c2 = classifyClientIntent('What can you do for me?', state);
  assert.equal(c2.intent, 'HELP');
  const r2 = buildLocalStructuredResponse('What can you do for me?', state, c2);
  renderChat([{ role: 'assistant', text: r2.summary, structuredResponse: r2 }]);
  assert.doesNotMatch(host.toHTML(), /Calculated from portfolio data|Gemini-polished|Offline fallback|DEMO DATA/);
  assert.equal(host.querySelectorAll('.re-help-group-item').length, 4);
  assert.equal(host.querySelectorAll('.re-followup-chip').length, 6);

  // Checklist 3: "Are you ate breakfast?"
  const c3 = classifyClientIntent('Are you ate breakfast?', state);
  assert.equal(c3.intent, 'OFF_TOPIC');
  const r3 = buildLocalStructuredResponse('Are you ate breakfast?', state, c3);
  renderChat([{ role: 'assistant', text: r3.summary, structuredResponse: r3 }]);
  assert.match(r3.summary, /credit and receivables topics/i);
  assert.doesNotMatch(host.toHTML(), /Calculated from portfolio data|DEMO DATA/);
  assert.equal(host.querySelectorAll('.re-followup-chip').length, 4);

  // Checklist 4: "Suggest a good movie"
  const c4 = classifyClientIntent('Suggest a good movie', state);
  assert.equal(c4.intent, 'OFF_TOPIC');
  const r4 = buildLocalStructuredResponse('Suggest a good movie', state, c4);
  renderChat([{ role: 'assistant', text: r4.summary, structuredResponse: r4 }]);
  assert.doesNotMatch(host.toHTML(), /Calculated from portfolio data|DEMO DATA/);

  // Checklist 5: "How many customer are there in Credit guard"
  const c5 = classifyClientIntent('How many customer are there in Credit guard', state);
  assert.equal(c5.intent, 'CUSTOMER_COUNT');
  const r5 = buildLocalStructuredResponse('How many customer are there in Credit guard', state, c5);
  assert.match(r5.summary, /13 active customers \(0 inactive\)/);
  renderChat([{ role: 'assistant', text: r5.summary, structuredResponse: r5, localCalculation: true, provider: 'local' }]);
  const html5 = host.toHTML();
  assert.match(html5, /Calculated from portfolio data/);
  assert.match(html5, /DEMO DATA/);
  assert.doesNotMatch(html5, /Offline fallback|Gemini-polished/);

  // Checklist 6a: "List customers" (no column modifier) -> default 8 columns, 10 initial rows + Show all 13 button
  const c6 = classifyClientIntent('List customers', state);
  assert.equal(c6.intent, 'CUSTOMER_LIST');
  const r6 = buildLocalStructuredResponse('List customers', state, c6);
  const table6 = r6.blocks.find(b => b.type === 'table');
  assert.equal(table6.rows.length, 13);
  assert.deepEqual(table6.columns.map(c => c.label), [
    'Customer', 'ID', 'Country', 'Company Code', 'Credit Limit', 'Exposure', 'Utilisation', 'Status'
  ]);
  renderChat([{ role: 'assistant', text: r6.summary, structuredResponse: r6, localCalculation: true, provider: 'local' }]);
  assert.equal(host.querySelectorAll('.ai-table-row').length, 10);
  const showAllBtn = host.querySelector('[data-show-all-toggle="true"]');
  assert.ok(showAllBtn);
  assert.match(showAllBtn.textContent, /Show all 13/);
  showAllBtn.click();
  assert.equal(host.querySelectorAll('.ai-table-row').length, 13);

  // Checklist 6b: "List out customers along with credit limit" -> Customer, ID, Credit Limit (13 rows)
  const c6b = classifyClientIntent('List out customers along with credit limit', state);
  assert.equal(c6b.intent, 'CUSTOMER_LIST');
  const r6b = buildLocalStructuredResponse('List out customers along with credit limit', state, c6b);
  const table6b = r6b.blocks.find(b => b.type === 'table');
  assert.equal(table6b.rows.length, 13);
  assert.deepEqual(table6b.columns.map(c => c.label), ['Customer', 'ID', 'Credit Limit']);

  // Checklist 7: Follow-up "and only India?" right after #6 -> 6 India rows
  const c7 = classifyClientIntent('and only India?', state, { intent: c6.intent, entities: c6.entities });
  assert.equal(c7.intent, 'CUSTOMER_LIST');
  assert.equal(c7.entities.country, 'India');
  assert.equal(c7.resolvedFromContext, true);
  const r7 = buildLocalStructuredResponse('and only India?', state, c7);
  const table7 = r7.blocks.find(b => b.type === 'table');
  assert.equal(table7.rows.length, 6);
  assert.ok(table7.rows.every(row => row.country === 'India'));

  // Checklist 8: "List out all customers and thier exposers in sources" -> CUSTOMER_LIST (not DATA_SOURCES_STATUS)
  const c8 = classifyClientIntent('List out all customers and thier exposers in sources', state);
  assert.equal(c8.intent, 'CUSTOMER_LIST');
  const r8 = buildLocalStructuredResponse('List out all customers and thier exposers in sources', state, c8);
  assert.equal(r8.blocks.find(b => b.type === 'table').rows.length, 13);

  // Checklist 9: "Customers above 80% utilisation" -> Found 6, ALL 6 rendered immediately above fold
  const c9 = classifyClientIntent('Customers above 80% utilisation', state);
  assert.equal(c9.intent, 'UTILISATION_LIST');
  const r9 = buildLocalStructuredResponse('Customers above 80% utilisation', state, c9);
  assert.match(r9.summary, /Found 6 customers at or above 80% utilisation/);
  assert.equal(r9.blocks.find(b => b.type === 'table').rows.length, 6);
  renderChat([{ role: 'assistant', text: r9.summary, structuredResponse: r9, localCalculation: true, provider: 'local' }]);
  assert.equal(host.querySelectorAll('.ai-table-row').length, 6);

  // Checklist 10: "Overdue invoices"
  const c10 = classifyClientIntent('Overdue invoices', state);
  assert.equal(c10.intent, 'OVERDUE_COLLECTIONS');
  const r10 = buildLocalStructuredResponse('Overdue invoices', state, c10);
  const overdueTable = r10.blocks.find(b => b.type === 'table');
  assert.equal(overdueTable.rows.length, 7);
  assert.match(r10.summary, /7 of 13 customers hold .* in overdue receivables/);

  // Checklist 11: "Give me our data sources and connectivity status"
  const c11 = classifyClientIntent('Give me our data sources and connectivity status', state);
  assert.equal(c11.intent, 'DATA_SOURCES_STATUS');
  const r11 = buildLocalStructuredResponse('Give me our data sources and connectivity status', state, c11);
  assert.equal(r11.blocks.find(b => b.type === 'table').rows.length, 3);
  renderChat([{ role: 'assistant', text: r11.summary, structuredResponse: r11, localCalculation: true, headlinePolished: true }]);
  const html11 = host.toHTML();
  assert.match(html11, /Gemini-polished/);
  assert.doesNotMatch(html11, /Calculated from portfolio data/);
  assert.doesNotMatch(html11, /Offline fallback/);
});

// --- 3. Two-Layer Router End-to-End Integration in handleChatSubmit ---

test('handleChatSubmit escalates low-confidence query to Layer A Gemini router and falls back to CLARIFY gracefully', async t => {
  const {
    handleChatSubmit,
    setGeminiRouterAdapters,
    resetChatRouterState
  } = await loadChatModules();
  resetChatRouterState();

  const chatHost = createFakeNode('div');
  const input = { value: 'Any troubling balances slipping past safety?', focus() {} };
  const errorHost = { textContent: '' };
  const statusHost = { textContent: '' };
  const submitButton = { disabled: false };

  installFakeDom(t, {
    '#chat-messages': chatHost,
    '#chat-input': input,
    '#chat-error': errorHost,
    '#chat-status': statusHost,
    '#chat-form button[type="submit"]': submitButton
  });

  const state = createSamplePortfolioState();
  const messages = [];

  // 3a. Gemini classifies ambiguous phrasing -> HIGH_RISK_CUSTOMERS -> renders deterministic portfolio table
  setGeminiRouterAdapters({
    async postJson(url) {
      if (url === '/api/ai/classify-intent') {
        return { usedGemini: true, intent: 'HIGH_RISK_CUSTOMERS', entities: {}, confidence: 0.88 };
      }
      return { polished: false };
    }
  });

  const resA = await handleChatSubmit({ preventDefault() {} }, null, messages, null, state);
  assert.equal(resA.structuredResponse.intent.primary, 'HIGH_RISK_CUSTOMERS');
  assert.match(chatHost.toHTML(), /Calculated from portfolio data/);

  // 3b. When both local classifier and Gemini are uncertain -> CLARIFY with ZERO data badges & 3 suggestions
  resetChatRouterState();
  input.value = 'xqvz credit blah';
  setGeminiRouterAdapters({
    async postJson(url) {
      if (url === '/api/ai/classify-intent') {
        return { usedGemini: false, intent: null, entities: {}, confidence: 0, reason: 'provider_not_configured' };
      }
      return null;
    }
  });

  const resB = await handleChatSubmit({ preventDefault() {} }, null, messages, null, state);
  assert.equal(resB.structuredResponse.intent.primary, 'CLARIFY');
  assert.equal(messages[messages.length - 1].providerFallback, false);
  const clarifyCardHtml = chatHost.children[chatHost.children.length - 1].toHTML();
  assert.match(clarifyCardHtml, /Did you mean:/);
  assert.doesNotMatch(clarifyCardHtml, /Offline fallback|Calculated from portfolio data|Gemini-polished|DEMO DATA/);

  setGeminiRouterAdapters(null);
});

// --- 4. Query Plan, Column-Aware Table, Extraction Timeline & Honesty Check Tests ---

test('Query Plan test suite covers all 7 column/sort/limit/timeline/follow-up cases and honesty check', async t => {
  const {
    classifyClientIntent,
    buildLocalStructuredResponse,
    verifyResponseAgainstPlan,
    renderChat,
    resetChatRouterState
  } = await loadChatModules();
  resetChatRouterState();

  const host = createFakeNode('div');
  installFakeDom(t, { '#chat-messages': host });
  const state = createSamplePortfolioState();

  // Case 1: "Give me customers along with country and country code"
  const p1 = classifyClientIntent('Give me customers along with country and country code', state);
  assert.equal(p1.intent, 'CUSTOMER_LIST');
  assert.deepEqual(p1.display.columns.include, ['country', 'companyCode']);
  assert.equal(p1.display.countryCodeAliasUsed, true);
  const r1 = buildLocalStructuredResponse('Give me customers along with country and country code', state, p1);
  const tbl1 = r1.blocks.find(b => b.type === 'table');
  assert.deepEqual(tbl1.columns.map(c => c.label), ['Customer', 'ID', 'Country', 'Company Code']);
  assert.equal(tbl1.rows.length, 13);
  assert.match(r1.planNote, /Country code = company code \(BSxx\)/);
  assert.match(r1.summary, /Showing 13 customers.*country and company code/i);
  renderChat([{ role: 'assistant', text: r1.summary, structuredResponse: r1, localCalculation: true, provider: 'local' }]);
  assert.match(host.toHTML(), /Country code = company code \(BSxx\)/);
  assert.equal(host.querySelectorAll('.ai-table-row').length, 10);
  host.querySelector('[data-show-all-toggle="true"]').click();
  assert.equal(host.querySelectorAll('.ai-table-row').length, 13);

  // Case 2: "Show me customers only without country, country code"
  const p2 = classifyClientIntent('Show me customers only without country, country code', state, p1);
  assert.equal(p2.intent, 'CUSTOMER_LIST');
  assert.ok(!p2.resolvedFromContext);
  assert.deepEqual(p2.display.columns.exclude, ['country', 'companyCode']);
  const r2 = buildLocalStructuredResponse('Show me customers only without country, country code', state, p2);
  const tbl2 = r2.blocks.find(b => b.type === 'table');
  assert.deepEqual(tbl2.columns.map(c => c.label), ['Customer', 'ID', 'Credit Limit', 'Exposure', 'Utilisation', 'Status']);
  assert.equal(tbl2.rows.length, 13);

  // Case 3: "Show me recent data extraction timelines" right after a customer list -> NO "Follow-up applied"
  const stateWithRuns = {
    ...state,
    monitoringData: {
      ...state.monitoringData,
      runs: [
        { startedAt: new Date(Date.now() - 300000).toISOString(), completedAt: new Date(Date.now() - 298000).toISOString(), status: 'COMPLETED', customerCount: 13, source: 'Monitoring Scheduler' },
        { startedAt: new Date(Date.now() - 600000).toISOString(), completedAt: new Date(Date.now() - 597000).toISOString(), status: 'COMPLETED', customerCount: 13, source: 'Monitoring Scheduler' }
      ]
    }
  };
  const p3 = classifyClientIntent('Show me recent data extraction timelines', stateWithRuns, p2);
  assert.equal(p3.intent, 'DATA_EXTRACTION_TIMELINE');
  assert.ok(!p3.resolvedFromContext);
  const r3 = buildLocalStructuredResponse('Show me recent data extraction timelines', stateWithRuns, p3);
  assert.ok(!r3.intent.resolvedFromContext);
  assert.ok(!r3.intent.contextNote);
  const tbl3 = r3.blocks.find(b => b.type === 'table');
  assert.deepEqual(tbl3.columns.map(c => c.label), ['Run time', 'Source/connector', 'Status', 'Duration', 'Records']);
  assert.ok(tbl3.rows.length >= 2 && tbl3.rows.length <= 10);
  renderChat([{ role: 'assistant', text: r3.summary, structuredResponse: r3, localCalculation: true, provider: 'local' }]);
  assert.doesNotMatch(host.toHTML(), /Follow-up applied/);

  // Case 3b: Extraction timelines when only session runs exist (no persisted scheduler runs)
  resetChatRouterState();
  const sessionOnlyState = {
    retrievedAt: new Date().toISOString(),
    extractionStatus: 'SUCCESS',
    customers: state.customers
  };
  const p3b = classifyClientIntent('Show me recent data extraction timelines', sessionOnlyState);
  const r3b = buildLocalStructuredResponse('Show me recent data extraction timelines', sessionOnlyState, p3b);
  assert.match(r3b.planNote, /Only current session extraction runs/i);
  assert.equal(r3b.blocks.find(b => b.type === 'table').rows.length, 1);

  // Case 4: "List customers with only name and exposure"
  const p4 = classifyClientIntent('List customers with only name and exposure', state);
  assert.equal(p4.intent, 'CUSTOMER_LIST');
  assert.equal(p4.display.columnMode, 'only');
  const r4 = buildLocalStructuredResponse('List customers with only name and exposure', state, p4);
  const tbl4 = r4.blocks.find(b => b.type === 'table');
  assert.deepEqual(tbl4.columns.map(c => c.label), ['Customer', 'Exposure']);
  assert.equal(tbl4.rows.length, 13);

  // Case 5: "Top 3 customers by exposure"
  const p5 = classifyClientIntent('Top 3 customers by exposure', state);
  assert.equal(p5.intent, 'CUSTOMER_LIST');
  assert.equal(p5.display.sortBy, 'exposure');
  assert.equal(p5.display.sortDir, 'desc');
  assert.equal(p5.display.limit, 3);
  const r5 = buildLocalStructuredResponse('Top 3 customers by exposure', state, p5);
  const tbl5 = r5.blocks.find(b => b.type === 'table');
  assert.equal(tbl5.rows.length, 3);
  assert.equal(tbl5.rows[0].ID, 'C002');
  assert.equal(tbl5.rows[1].ID, 'C001');
  assert.equal(tbl5.rows[2].ID, 'C003');
  assert.match(r5.summary, /Showing top 3 of 13 customers/);

  // Case 6: "Customers in UAE sorted by utilisation"
  const p6 = classifyClientIntent('Customers in UAE sorted by utilisation', state);
  assert.equal(p6.intent, 'CUSTOMER_LIST');
  assert.equal(p6.entities.country, 'UAE');
  assert.equal(p6.display.sortBy, 'utilisationPct');
  assert.equal(p6.display.sortDir, 'desc');
  const r6 = buildLocalStructuredResponse('Customers in UAE sorted by utilisation', state, p6);
  const tbl6 = r6.blocks.find(b => b.type === 'table');
  assert.equal(tbl6.rows.length, 4);
  assert.ok(tbl6.rows.every(r => r.country === 'UAE'));
  assert.deepEqual(tbl6.rows.map(r => r.ID), ['C002', 'C005', 'C008', 'C012']);

  // Case 7: "and only India?" immediately after a customer list -> Follow-up applied + 6 India rows
  const pBase = classifyClientIntent('List customers', state);
  const p7 = classifyClientIntent('and only India?', state, { intent: pBase.intent, entities: pBase.entities, display: pBase.display });
  assert.equal(p7.intent, 'CUSTOMER_LIST');
  assert.equal(p7.resolvedFromContext, true);
  assert.match(p7.contextNote, /Follow-up applied/);
  assert.equal(p7.entities.country, 'India');
  const r7 = buildLocalStructuredResponse('and only India?', state, p7);
  const tbl7 = r7.blocks.find(b => b.type === 'table');
  assert.equal(tbl7.rows.length, 6);
  assert.ok(tbl7.rows.every(r => r.country === 'India'));

  // Case 8: Honesty check verifyResponseAgainstPlan rejects violated columns/limits
  assert.equal(verifyResponseAgainstPlan(p1, r2).valid, false);
  assert.equal(verifyResponseAgainstPlan(p2, r1).valid, false);
  assert.equal(verifyResponseAgainstPlan(p5, r4).valid, false);
  assert.equal(verifyResponseAgainstPlan(p1, r1).valid, true);
});

// --- 5. Workspace Context Adapters, All 10 Required Prompts, Navigation & Live Cache Tests ---

function createFullWorkspaceState() {
  const base = createSamplePortfolioState();
  return {
    ...base,
    currentTab: 'chat',
    lastViewed: 'overview',
    requests: [
      {
        ID: 'REQ-01',
        customer_ID: 'C001',
        customerName: 'Aarav Industrial Components Pvt Ltd',
        currentLimit: 1200000,
        requestedLimit: 1650000,
        status: 'Pending',
        approverLevel: 'Finance Head',
        requestedBy: 'Ravi Nair (AR Controller)',
        reason: 'Seasonal order surge',
        createdAt: '2026-11-12T10:15:00.000Z'
      },
      {
        ID: 'REQ-02',
        customer_ID: 'C003',
        customerName: 'Meridian Pacific Trading Pte Ltd',
        currentLimit: 1100000,
        requestedLimit: 1300000,
        status: 'Approved',
        approverLevel: 'Credit Controller',
        requestedBy: 'Priya Menon',
        reason: 'Annual contract expansion',
        decidedBy: 'Finance Lead',
        decidedAt: '2026-11-11T14:20:00.000Z',
        createdAt: '2026-11-11T09:00:00.000Z'
      }
    ],
    monitoringData: {
      ...base.monitoringData,
      runs: [
        {
          ID: 'MON-101',
          startedAt: new Date(Date.now() - 300000).toISOString(),
          completedAt: new Date(Date.now() - 297000).toISOString(),
          status: 'COMPLETED',
          customerCount: 13,
          breachedCount: 2,
          warningCount: 4,
          criticalCount: 1,
          source: 'Monitoring & Portfolio Scheduler'
        }
      ],
      findings: [
        { ID: 'F-01', severity: 'CRITICAL', customerId: 'C001', title: 'Limit breached > 120%', detail: 'Aarav Industrial exceeds limit at 122.9%' }
      ]
    },
    v2Connectors: {
      sources: [
        { id: 'SRC-CAP-LOCAL', name: 'Credit Guard CAP / HANA CDS Store', type: 'CAP_HANA', status: 'ACTIVE', freshness: 'Fresh (1m ago)', lastRetrieved: base.retrievedAt },
        { id: 'SRC-SAP-SIM', name: 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)', type: 'SAP_SIMULATOR', status: 'DEMO', freshness: 'Fresh (1m ago)', lastRetrieved: base.retrievedAt },
        { id: 'SRC-BTP-ABAP', name: 'SAP BTP ABAP Environment Destination', type: 'SAP_BTP_DEST', status: 'STANDBY', freshness: 'On-demand', lastRetrieved: 'Standby' }
      ],
      hanaReplicatedTables: [
        { table: 'UKMBP_CMS_SGM', description: 'SAP FSCM Credit Segment', recordCount: 13 }
      ],
      sapCandidateODataServices: [
        { service: 'API_CREDIT_ACCOUNT_SRV', entitySet: 'A_CreditAccount' }
      ]
    },
    agentHistory: {
      memoryEnabled: true,
      conversations: [{ ID: 'CONV-1' }],
      executions: [
        {
          ID: 'EXEC-10',
          startedAt: new Date(Date.now() - 180000).toISOString(),
          status: 'COMPLETED',
          planStatus: 'COMPLETED',
          stepCount: 2,
          recoveryStatus: 'NOT_AVAILABLE',
          taskResults: [{ summary: 'Evaluated C001 credit profile and exposure headroom' }]
        }
      ]
    }
  };
}

test('Workspace Context Registry answers all 10 required workspace questions + tab-aware features accurately', async t => {
  const {
    classifyClientIntent,
    buildLocalStructuredResponse,
    getWorkspaceAdapters,
    renderChat,
    resetChatRouterState
  } = await loadChatModules();
  resetChatRouterState();

  const host = createFakeNode('div');
  const analysisTabBtn = createFakeNode('button');
  analysisTabBtn.setAttribute('data-tab', 'analysis');
  let tabSwitchedTo = null;
  analysisTabBtn.addEventListener('click', () => {
    tabSwitchedTo = 'analysis';
  });

  installFakeDom(t, {
    '#chat-messages': host,
    '[data-tab="analysis"]': analysisTabBtn
  });
  const state = createFullWorkspaceState();

  // Verify all 7 read-only adapters exist
  const adapters = getWorkspaceAdapters(state);
  assert.deepEqual(
    adapters.map(a => a.tabId).sort(),
    ['analysis', 'approvals', 'audit', 'customers', 'dashboard', 'overview', 'simulator']
  );

  // 1. "Credit limit with country wise" -> grouped by country, Credit Limit column comes FIRST after Country
  const q1 = 'Credit limit with country wise';
  const p1 = classifyClientIntent(q1, state);
  assert.equal(p1.intent, 'EXPOSURE_BY_COUNTRY');
  assert.equal(p1.entity, 'country_exposure');
  assert.equal(p1.operation, 'GROUP_BY');
  assert.equal(p1.entities.metric, 'creditLimit');
  const r1 = buildLocalStructuredResponse(q1, state, p1);
  const t1 = r1.blocks.find(b => b.type === 'table');
  assert.deepEqual(t1.columns.map(c => c.key), ['groupKey', 'creditLimit', 'exposure', 'availableCredit', 'utilisationPct', 'customerCount', 'status']);
  assert.equal(t1.rows.length, 3);
  assert.equal(r1.sourceTabLabel, 'Exposure Analysis');

  // 2. "how many data sources ready to connect" -> exact STANDBY count (1), table collapsed above fold
  const q2 = 'how many data sources ready to connect';
  const p2 = classifyClientIntent(q2, state);
  assert.equal(p2.intent, 'DATA_SOURCES_STATUS');
  assert.equal(p2.entity, 'connectors');
  assert.equal(p2.operation, 'COUNT');
  assert.deepEqual(p2.entities.statuses, ['STANDBY']);
  const r2 = buildLocalStructuredResponse(q2, state, p2);
  assert.match(r2.summary, /^1 of 3 data source is standby/i);
  assert.equal(r2.showTableAboveFold, false);
  assert.equal(r2.blocks.find(b => b.type === 'table').rows.length, 1);

  // 3. "Show me all data sources and active, standby status" -> ACTIVE + STANDBY connectors + total registered context
  const q3 = 'Show me all data sources and active, standby status';
  const p3 = classifyClientIntent(q3, state);
  assert.equal(p3.intent, 'DATA_SOURCES_STATUS');
  assert.equal(p3.entity, 'connectors');
  assert.deepEqual(p3.entities.statuses.sort(), ['ACTIVE', 'STANDBY']);
  const r3 = buildLocalStructuredResponse(q3, state, p3);
  const t3 = r3.blocks.find(b => b.type === 'table');
  assert.equal(t3.rows.length, 2);
  assert.ok(t3.rows.every(row => ['ACTIVE', 'STANDBY'].includes(row.status)));
  assert.match(r3.summary, /Showing 2 data sources \((?:active & standby|standby & active)\)/i);

  // 4. "Show me SorceID" -> resolves typo to connectors + Source ID column (NOT CLARIFY / OFF_TOPIC)
  const q4 = 'Show me SorceID';
  const p4 = classifyClientIntent(q4, state);
  assert.equal(p4.intent, 'DATA_SOURCES_STATUS');
  assert.equal(p4.entity, 'connectors');
  assert.ok(p4.display.columns.include.includes('id'));
  const r4 = buildLocalStructuredResponse(q4, state, p4);
  const t4 = r4.blocks.find(b => b.type === 'table');
  assert.ok(t4.columns.some(c => c.key === 'id'));
  assert.equal(t4.rows.length, 3);

  // 5. "SAP BTP & HANA sources with id's" -> connector rows with Source ID column
  const q5 = "SAP BTP & HANA sources with id's";
  const p5 = classifyClientIntent(q5, state);
  assert.equal(p5.intent, 'DATA_SOURCES_STATUS');
  assert.equal(p5.entity, 'connectors');
  assert.ok(p5.display.columns.include.includes('id'));
  const r5 = buildLocalStructuredResponse(q5, state, p5);
  const t5 = r5.blocks.find(b => b.type === 'table');
  assert.ok(t5.columns.some(c => c.key === 'id'));
  assert.ok(t5.rows.length >= 2);
  assert.equal(r5.sourceTabLabel, 'SAP BTP & HANA CDS');

  // 6. "How many pending limit approvals?" -> COUNT = 1 matching sidebar badge
  const q6 = 'How many pending limit approvals?';
  const p6 = classifyClientIntent(q6, state);
  assert.equal(p6.intent, 'LIMIT_APPROVALS_STATUS');
  assert.equal(p6.entity, 'limit_requests');
  assert.equal(p6.operation, 'COUNT');
  assert.equal(p6.entities.status, 'Pending');
  const r6 = buildLocalStructuredResponse(q6, state, p6);
  assert.match(r6.summary, /1 pending limit approval request/i);
  assert.equal(r6.sourceTabLabel, 'Limit Approvals');

  // 7. "Which alerts are critical?" -> ONLY critical alerts (C001)
  const q7 = 'Which alerts are critical?';
  const p7 = classifyClientIntent(q7, state);
  assert.equal(p7.intent, 'MONITORING_ALERTS');
  assert.equal(p7.entity, 'alerts');
  assert.equal(p7.entities.severity, 'CRITICAL');
  const r7 = buildLocalStructuredResponse(q7, state, p7);
  const t7 = r7.blocks.find(b => b.type === 'table');
  assert.equal(t7.rows.length, 1);
  assert.equal(t7.rows[0].customerId, 'C001');
  assert.equal(t7.rows[0].severity, 'CRITICAL');
  assert.equal(r7.sourceTabLabel, 'Portfolio & Monitoring');

  // 8. "Summarize Credit Overview" -> KPIs + verdict + attention items
  const q8 = 'Summarize Credit Overview';
  const p8 = classifyClientIntent(q8, state);
  assert.equal(p8.intent, 'CREDIT_OVERVIEW_SUMMARY');
  assert.equal(p8.entity, 'overview_kpis');
  assert.equal(p8.targetTab, 'overview');
  const r8 = buildLocalStructuredResponse(q8, state, p8);
  assert.match(r8.summary, /Credit Overview/i);
  assert.ok(r8.blocks.some(b => b.type === 'metrics'));
  assert.equal(r8.sourceTabLabel, 'Credit Overview');

  // 9. "Where can I see country-wise exposure?" -> navigation response + clickable Open Exposure Analysis button
  const q9 = 'Where can I see country-wise exposure?';
  const p9 = classifyClientIntent(q9, state);
  assert.equal(p9.intent, 'WORKSPACE_NAVIGATION');
  assert.equal(p9.targetTab, 'analysis');
  const r9 = buildLocalStructuredResponse(q9, state, p9);
  assert.equal(r9.navigationAction?.tabId, 'analysis');
  assert.equal(r9.navigationAction?.label, 'Open Exposure Analysis');
  renderChat([{ role: 'assistant', text: r9.summary, structuredResponse: r9, localCalculation: true, provider: 'local' }]);
  const navBtn = host.querySelector('[data-open-tab="analysis"]');
  assert.ok(navBtn);
  navBtn.click();
  assert.equal(tabSwitchedTo, 'analysis');
  assert.match(host.toHTML(), /Source: Exposure Analysis · Data as of/);

  // 10. "What is on the Limit Approvals tab?" -> tab summary + queue + Open Limit Approvals button
  const q10 = 'What is on the Limit Approvals tab?';
  const p10 = classifyClientIntent(q10, state);
  assert.equal(p10.intent, 'LIMIT_APPROVALS_STATUS');
  assert.equal(p10.targetTab, 'approvals');
  const r10 = buildLocalStructuredResponse(q10, state, p10);
  assert.match(r10.summary, /1 pending, 1 approved, and 0 rejected/i);
  assert.equal(r10.navigationAction?.tabId, 'approvals');

  // Extra cross-tab workspace checks
  const rReq = buildLocalStructuredResponse('Who requested the last limit change?', state);
  assert.match(rReq.summary, /Ravi Nair \(AR Controller\)/);
  assert.match(rReq.summary, /REQ-01/);

  const rMon = buildLocalStructuredResponse('Show monitoring status', state);
  assert.equal(rMon.intent.primary, 'MONITORING_ANALYSIS');
  assert.match(rMon.summary, /Monitoring status is COMPLETED/i);

  const rCds = buildLocalStructuredResponse('Show CDS entities', state);
  assert.equal(rCds.intent.primary, 'CDS_ENTITIES_LIST');
  assert.ok(rCds.blocks.find(b => b.type === 'table').rows.length >= 4);

  const rScreen = buildLocalStructuredResponse('What am I looking at?', { ...state, lastViewed: 'dashboard' });
  assert.equal(rScreen.intent.primary, 'SCREEN_CONTEXT');
  assert.match(rScreen.summary, /Portfolio & Monitoring/);

  const rDelta = buildLocalStructuredResponse('What changed since the last refresh?', state);
  assert.equal(rDelta.intent.primary, 'CREDIT_OVERVIEW_SUMMARY');
  assert.equal(rDelta.sourceTabLabel, 'Credit Overview');
});

test('Cache invalidates automatically when shared store retrievedAt refreshes', async t => {
  const {
    handleChatSubmit,
    resetChatRouterState
  } = await loadChatModules();
  resetChatRouterState();

  const chatHost = createFakeNode('div');
  const input = { value: 'How many pending limit approvals?', focus() {} };
  const errorHost = { textContent: '' };
  const statusHost = { textContent: '' };
  const submitButton = { disabled: false };

  installFakeDom(t, {
    '#chat-messages': chatHost,
    '#chat-input': input,
    '#chat-error': errorHost,
    '#chat-status': statusHost,
    '#chat-form button[type="submit"]': submitButton
  });

  const state = createFullWorkspaceState();
  const messages = [];

  const first = await handleChatSubmit({ preventDefault() {} }, null, messages, null, state);
  assert.match(first.reply, /1 pending limit approval request/i);

  // Simulate background 5-minute refresh updating retrievedAt & adding a pending request
  state.retrievedAt = '2026-11-12T23:55:00.000Z';
  state.requests.push({
    ID: 'REQ-03',
    customer_ID: 'C002',
    customerName: 'Gulf Horizon Logistics LLC',
    currentLimit: 1500000,
    requestedLimit: 1850000,
    status: 'Pending',
    approverLevel: 'Finance Head',
    requestedBy: 'Credit Ops',
    reason: 'New contract'
  });
  input.value = 'How many pending limit approvals?';
  const second = await handleChatSubmit({ preventDefault() {} }, null, messages, null, state);
  assert.match(second.reply, /2 pending limit approval requests/i);
  assert.equal(second.structuredResponse.dataAsOf, '2026-11-12 23:55:00');
});


