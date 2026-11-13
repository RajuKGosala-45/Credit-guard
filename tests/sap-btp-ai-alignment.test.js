const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AutonomousMonitoringScheduler } = require('../srv/autonomousScheduler');
const mockSapFixtures = require('../srv/integrations/mock-sap/fixtures.json');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');
let seq = 0;

async function loadFrontendModules() {
  const utilsSrc = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utilsSrc).toString('base64')}#ut${seq += 1}`;

  const stateSrc = await fs.readFile(path.join(appRoot, 'state.js'), 'utf8');
  const stateUrl = `data:text/javascript;base64,${Buffer.from(stateSrc).toString('base64')}#st${seq += 1}`;

  let apiSrc = await fs.readFile(path.join(appRoot, 'api.js'), 'utf8');
  apiSrc = apiSrc.replaceAll("'./state.js'", `'${stateUrl}'`);
  const apiUrl = `data:text/javascript;base64,${Buffer.from(apiSrc).toString('base64')}#ap${seq += 1}`;

  let blockSrc = await fs.readFile(path.join(appRoot, 'views', 'blockRenderer.js'), 'utf8');
  blockSrc = blockSrc.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const blockUrl = `data:text/javascript;base64,${Buffer.from(blockSrc).toString('base64')}#br${seq += 1}`;

  let wsSrc = await fs.readFile(path.join(appRoot, 'views', 'workspaceContext.js'), 'utf8');
  wsSrc = wsSrc.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const wsUrl = `data:text/javascript;base64,${Buffer.from(wsSrc).toString('base64')}#ws${seq += 1}`;

  let chatSrc = await fs.readFile(path.join(appRoot, 'views', 'chat.js'), 'utf8');
  chatSrc = chatSrc.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  chatSrc = chatSrc.replaceAll("'./blockRenderer.js'", `'${blockUrl}'`);
  const chatUrl = `data:text/javascript;base64,${Buffer.from(chatSrc).toString('base64')}#ch${seq += 1}`;

  let mockSapViewSrc = await fs.readFile(path.join(appRoot, 'views', 'mockSap.js'), 'utf8');
  mockSapViewSrc = mockSapViewSrc.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const mockSapViewUrl = `data:text/javascript;base64,${Buffer.from(mockSapViewSrc).toString('base64')}#ms${seq += 1}`;

  let connectorsViewSrc = await fs.readFile(path.join(appRoot, 'views', 'connectorsView.js'), 'utf8');
  connectorsViewSrc = connectorsViewSrc.replaceAll("'../api.js'", `'${apiUrl}'`);
  connectorsViewSrc = connectorsViewSrc.replaceAll("'../state.js'", `'${stateUrl}'`);
  connectorsViewSrc = connectorsViewSrc.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const connectorsViewUrl = `data:text/javascript;base64,${Buffer.from(connectorsViewSrc).toString('base64')}#cv${seq += 1}`;

  const [stateMod, apiMod, wsMod, chatMod, mockSapMod, connectorsMod] = await Promise.all([
    import(stateUrl),
    import(apiUrl),
    import(wsUrl),
    import(chatUrl),
    import(mockSapViewUrl),
    import(connectorsViewUrl)
  ]);

  chatMod.setWorkspaceContextModule(wsMod.default || wsMod);
  return { stateMod, apiMod, wsMod, chatMod, mockSapMod, connectorsMod };
}

function build13CanonicalCustomers() {
  return [
    { ID: 'C001', name: 'Aarav Industrial Components Pvt Ltd', country: 'India', companyCode: 'BS01', creditLimit: 1200000, exposure: 1475000, utilisation: 1.229, overdueAmount: 425000, overdueInvoiceCount: 2, riskClass: 'High Risk', status: 'BREACH' },
    { ID: 'C002', name: 'Gulf Horizon Logistics LLC', country: 'UAE', companyCode: 'BS02', creditLimit: 1500000, exposure: 1530000, utilisation: 1.02, overdueAmount: 310000, overdueInvoiceCount: 1, riskClass: 'High Risk', status: 'BREACH' },
    { ID: 'C003', name: 'Meridian Pacific Trading Pte Ltd', country: 'Singapore', companyCode: 'BS03', creditLimit: 1100000, exposure: 1050000, utilisation: 0.955, overdueAmount: 180000, overdueInvoiceCount: 1, riskClass: 'Watchlist', status: 'WARNING' },
    { ID: 'C004', name: 'Deccan Precision Castings Ltd', country: 'India', companyCode: 'BS01', creditLimit: 900000, exposure: 765000, utilisation: 0.85, overdueAmount: 95000, overdueInvoiceCount: 1, riskClass: 'Watchlist', status: 'WARNING' },
    { ID: 'C005', name: 'Al Noor Engineering Supplies FZCO', country: 'UAE', companyCode: 'BS02', creditLimit: 800000, exposure: 660000, utilisation: 0.825, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'WARNING' },
    { ID: 'C006', name: 'Bharath Agri-Inputs Pvt Ltd', country: 'India', companyCode: 'BS04', creditLimit: 700000, exposure: 575000, utilisation: 0.821, overdueAmount: 75000, overdueInvoiceCount: 1, riskClass: 'Normal', status: 'WARNING' },
    { ID: 'C007', name: 'Kaveri Textile Mills Pvt Ltd', country: 'India', companyCode: 'BS01', creditLimit: 1000000, exposure: 520000, utilisation: 0.52, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C008', name: 'Emirates Steel Fabrication Co', country: 'UAE', companyCode: 'BS02', creditLimit: 1300000, exposure: 610000, utilisation: 0.469, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C009', name: 'Sentosa Marine Systems Pte Ltd', country: 'Singapore', companyCode: 'BS03', creditLimit: 1000000, exposure: 200000, utilisation: 0.2, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C010', name: 'Vindhya Pharma Distributors LLP', country: 'India', companyCode: 'BS04', creditLimit: 1000000, exposure: 200000, utilisation: 0.2, overdueAmount: 45000, overdueInvoiceCount: 1, riskClass: 'Normal', status: 'OK' },
    { ID: 'C011', name: 'Lion City Electronics Pte Ltd', country: 'Singapore', companyCode: 'BS05', creditLimit: 750000, exposure: 280000, utilisation: 0.373, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C012', name: 'Desert Crescent Foods LLC', country: 'UAE', companyCode: 'BS05', creditLimit: 1000000, exposure: 50000, utilisation: 0.05, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'Normal', status: 'OK' },
    { ID: 'C013', name: 'Narmada Infrastructure & Pipes Ltd', country: 'India', companyCode: 'BS01', creditLimit: 0, exposure: 210000, utilisation: null, overdueAmount: 60000, overdueInvoiceCount: 1, riskClass: 'C', status: 'MANUAL_REVIEW' }
  ];
}

function build7ConnectorsPayload(syncedAt) {
  return {
    mappingsCount: 15,
    sources: [
      { source_id: 'CAP-LOCAL-DB', source_name: 'CAP Local HANA CDS Repository', source_type: 'HANA_CDS', connection_config_ref: 'cds.db', status: 'ACTIVE', last_sync_at: syncedAt },
      { source_id: 'MOCK-SAP-FIN-FSCM', source_name: 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)', source_type: 'MOCK_SAP', connection_config_ref: 'mock-sap-v1', status: 'ACTIVE', last_sync_at: syncedAt },
      { source_id: 'SAP-S4HANA-CLOUD-ODATA', source_name: 'SAP S/4HANA Cloud OData (API_CREDIT_ACCOUNT_SRV)', source_type: 'SAP_ODATA', connection_config_ref: 'S4HC_CREDIT_DEST', status: 'ACTIVE', last_sync_at: null },
      { source_id: 'FILE-CSV-JSON-UPLOAD', source_name: 'Structured ERP File Connector (CSV/JSON/XML)', source_type: 'FILE', connection_config_ref: 'upload-staging', status: 'ACTIVE', last_sync_at: null },
      { source_id: 'SAP-BTP-DEST-ABAP', source_name: 'SAP BTP ABAP Environment Destination', source_type: 'SAP_BTP_DEST', connection_config_ref: 'ABAP_CREDIT_DEST', status: 'STANDBY', last_sync_at: null },
      { source_id: 'SAP-S4-FSCM-RFC', source_name: 'SAP S/4HANA FIN-FSCM RFC Connector', source_type: 'SAP_RFC', connection_config_ref: 'S4_FSCM_RFC', status: 'STANDBY', last_sync_at: null },
      { source_id: 'HANA-SLT-REPLICATION', source_name: 'SAP HANA SLT Replication Pipeline', source_type: 'HANA_SLT', connection_config_ref: 'SLT_PROD_SCHEMA', status: 'STANDBY', last_sync_at: null }
    ],
    sapCandidateODataServices: [
      { service: 'API_BUSINESS_PARTNER', entitySet: 'A_BusinessPartner' },
      { service: 'API_CREDIT_ACCOUNT_SRV', entitySet: 'A_CreditAccount' },
      { service: 'YY1_CUSTOMER_OPEN_ITEMS', entitySet: 'OpenItems' },
      { service: 'C_CREDIT_EXPOSURE_CDS', entitySet: 'CreditExposure' },
      { service: 'FSCM_CREDIT_DECISION_SRV', entitySet: 'CreditDecision' }
    ],
    hanaReplicatedTables: [
      { table: 'BUT000', description: 'Business Partner Master' },
      { table: 'UKMBP_CMS', description: 'SAP Credit Management Master' },
      { table: 'UKMBP_CMS_SGM', description: 'FSCM Credit Segment' },
      { table: 'UKM_ITEM', description: 'Credit Exposure Commitment Items' },
      { table: 'BSID', description: 'Open Customer Items' },
      { table: 'BSAD', description: 'Cleared Customer Items' },
      { table: 'ACDOCA', description: 'Universal Journal Entry Line Items' },
      { table: 'KNKK', description: 'Customer Master Credit Control Area Data' }
    ]
  };
}

test('Part 1: Connector Registry Alignment (7 connectors: 4 ACTIVE, 3 STANDBY, 15 mappings, 8 HANA tables, 5 OData, never-synced, SorceID, no 3-connector fallback)', async () => {
  const { chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();
  const syncedAt = '2026-11-12T10:00:00.000Z';

  const state = {
    retrievedAt: syncedAt,
    extractionStatus: 'SUCCESS',
    customers: build13CanonicalCustomers(),
    v2Connectors: build7ConnectorsPayload(syncedAt),
    mockSap: { source: { sourceId: 'MOCK-SAP-FIN-FSCM', sourceName: 'SAP S/4HANA Credit Simulator' }, entities: mockSapFixtures.entities }
  };

  // All 7 connectors (4 ACTIVE, 3 STANDBY)
  const rAll = chatMod.buildLocalStructuredResponse('Give me our data sources and connectivity status', state);
  const tAll = rAll.blocks.find(b => b.type === 'table');
  assert.equal(tAll.rows.length, 7);
  assert.match(rAll.summary, /7 registered connectors.*4 ACTIVE.*3 STANDBY/i);
  assert.match(rAll.summary, /15 field mappings/i);
  assert.match(rAll.summary, /8 HANA tables/i);
  assert.match(rAll.summary, /5 SAP candidate OData services/i);
  assert.equal(rAll.sourceTabLabel, 'SAP BTP & HANA CDS');
  assert.ok(rAll.dataAsOf);

  // SorceID query includes IDs across all 7
  const rId = chatMod.buildLocalStructuredResponse('Show me SorceID', state);
  const tId = rId.blocks.find(b => b.type === 'table');
  assert.equal(tId.rows.length, 7);
  assert.ok(tId.columns.some(c => c.key === 'id'));
  assert.ok(tId.rows.some(r => r.id === 'SAP-BTP-DEST-ABAP'));

  // Never-synced query returns only the 5 connectors with last_sync_at === null
  const rNever = chatMod.buildLocalStructuredResponse('Which connectors have never synced?', state);
  const tNever = rNever.blocks.find(b => b.type === 'table');
  assert.equal(tNever.rows.length, 5);
  assert.ok(tNever.rows.every(r => r.lastRetrieved === 'Never'));

  // CDS entities + field mappings + HANA tables
  const rCds = chatMod.buildLocalStructuredResponse('How many field mappings and HANA tables are configured?', state);
  assert.match(rCds.summary, /15 field mappings/i);
  assert.match(rCds.summary, /8 HANA replicated tables/i);
  assert.match(rCds.summary, /5 SAP candidate OData services/i);

  // When v2Connectors is absent, NO hardcoded 3-connector fallback appears!
  const emptyConnectorsState = { retrievedAt: syncedAt, customers: build13CanonicalCustomers() };
  const rEmpty = chatMod.buildLocalStructuredResponse('Give me our data sources and connectivity status', emptyConnectorsState);
  assert.match(rEmpty.summary, /has not loaded/i);
  assert.equal(rEmpty.blocks.some(b => b.type === 'table'), false);
});

test('Part 2 & 3: AutonomousScheduler status fields, no duplicate scheduler card IDs, and timeout/error/Retry handling', async () => {
  const sched = new AutonomousMonitoringScheduler({}, { intervalMs: 300000 });
  const initialStatus = sched.getStatus();
  assert.equal(initialStatus.state, 'IDLE');
  assert.equal(initialStatus.intervalMinutes, 5);
  assert.equal(initialStatus.lastCycleTime, null);
  assert.equal(initialStatus.nextCycleTime, null);
  assert.equal(initialStatus.lastResult, null);
  assert.equal(initialStatus.lastError, null);

  // Verify connectorsView.js defines attachSchedulerEvents and has NO duplicate #scheduler-status-grid in renderDataSourcesPanel
  const connectorsViewSrc = await fs.readFile(path.join(appRoot, 'views', 'connectorsView.js'), 'utf8');
  assert.match(connectorsViewSrc, /function attachSchedulerEvents\(container\)/);
  assert.match(connectorsViewSrc, /retry-scheduler-status-btn/);
  assert.match(connectorsViewSrc, /schedulerCycleInFlight/);
  // #scheduler-status-grid appears ONLY once as an ID definition inside renderSchedulerPanel
  const gridMatches = connectorsViewSrc.match(/id="scheduler-status-grid"/g) || [];
  assert.equal(gridMatches.length, 1);

  // Verify api.js enforces AbortController timeout
  const apiSrc = await fs.readFile(path.join(appRoot, 'api.js'), 'utf8');
  assert.match(apiSrc, /AbortController/);
  assert.match(apiSrc, /timeoutMs = 10000/);

  // Verify AI answers scheduler daemon queries accurately
  const { chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();
  const state = {
    retrievedAt: '2026-11-12T10:05:00.000Z',
    customers: build13CanonicalCustomers(),
    schedulerStatus: {
      state: 'RUNNING',
      status: 'RUNNING',
      intervalMinutes: 5,
      totalRuns: 4,
      successfulRuns: 3,
      failedRuns: 1,
      skippedRuns: 0,
      lastCycleTime: '2026-11-12T10:05:00.000Z',
      nextCycleTime: '2026-11-12T10:10:00.000Z',
      lastError: null
    }
  };
  const rSched = chatMod.buildLocalStructuredResponse('What is the scheduler daemon status?', state);
  assert.match(rSched.summary, /Autonomous Scheduler Daemon is RUNNING/i);
  assert.match(rSched.summary, /5-minute heartbeat/i);
  assert.equal(rSched.sourceTabLabel, 'SAP BTP & HANA CDS');
});

test('Part 4: Shared extractionRuns store (max 50), connector sync timestamps, and AI timeline alignment', async () => {
  const { stateMod, chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();
  stateMod.state.extractionRuns = [];
  stateMod.state.v2Connectors = build7ConnectorsPayload(null);

  for (let i = 0; i < 55; i += 1) {
    stateMod.recordExtractionRun({
      runId: `RUN-${i}`,
      startedAt: new Date(Date.now() - (60 - i) * 60000).toISOString(),
      finishedAt: new Date(Date.now() - (60 - i) * 60000 + 200).toISOString(),
      sourceId: 'CAP-HANA-CDS',
      sourceName: 'Credit Guard Auto-Refresh Pipeline',
      status: 'COMPLETED',
      recordCounts: { customers: 13 },
      triggeredBy: i % 2 === 0 ? 'SCHEDULER' : 'MANUAL'
    });
  }
  assert.equal(stateMod.state.extractionRuns.length, 50);

  const syncIso = '2026-11-12T11:30:00.000Z';
  stateMod.updateConnectorSyncTimestamp('MOCK-SAP-FIN-FSCM', syncIso);
  const updatedConn = stateMod.state.v2Connectors.sources.find(s => s.source_id === 'MOCK-SAP-FIN-FSCM');
  assert.equal(updatedConn.last_sync_at, syncIso);

  const timelineResp = chatMod.buildLocalStructuredResponse('Show me recent data extraction timelines', {
    ...stateMod.state,
    retrievedAt: syncIso,
    customers: build13CanonicalCustomers()
  });
  const table = timelineResp.blocks.find(b => b.type === 'table');
  assert.ok(table.rows.length >= 1);
  assert.equal(timelineResp.sourceTabLabel, 'SAP BTP & HANA CDS');
});

test('Part 5 & 6: Mock SAP Option A staging isolation (13 canonical active customers), normalized India country, and No limit set / N/A (no limit)', async () => {
  const { apiMod, chatMod, mockSapMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();

  const canonical13 = build13CanonicalCustomers();
  const contaminated17 = [
    ...canonical13,
    { ID: 'MS-C001', name: 'Meridian Components (Mock)', country: 'IN', companyCode: 'M001', creditLimit: 1000000, exposure: 1200000, overdueAmount: 400000, overdueInvoiceCount: 1, riskClass: 'C', status: 'BREACH' },
    { ID: 'MS-C002', name: 'Kaveri Industrial Supply (Mock)', country: 'IN', companyCode: 'M002', creditLimit: 2000000, exposure: 700000, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'B', status: 'OK' },
    { ID: 'MS-C003', name: 'Atlas Food Distribution (Mock)', country: 'IN', companyCode: 'M001', creditLimit: 500000, exposure: 400000, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'B', status: 'WARNING' },
    { ID: 'MS-C004', name: 'Northwind Field Services (Mock)', country: 'IN', companyCode: 'M003', creditLimit: 0, exposure: 75000, overdueAmount: 0, overdueInvoiceCount: 0, riskClass: 'C', status: 'MANUAL_REVIEW' }
  ];

  // Option A isolation separates MS-C* from active portfolio and recomputes KPIs for strictly 13 customers
  const { dashboard: isolatedDash, customers: isolatedCust, mockSapStagingCustomers } = apiMod.separateMockSapStagingPortfolio(
    { kpis: { customerCount: 17, totalExposure: 99999999, totalLimit: 99999999 }, exposure: {} },
    contaminated17
  );
  assert.equal(isolatedCust.length, 13);
  assert.equal(isolatedDash.kpis.customerCount, 13);
  assert.equal(mockSapStagingCustomers.length, 4);
  assert.ok(!isolatedCust.some(c => /^MS-C/i.test(c.ID)));

  // AI answers Mock SAP staging queries with normalized India, zero-limit formatting, and staging disclaimer
  const state = {
    retrievedAt: '2026-11-12T10:00:00.000Z',
    customers: isolatedCust,
    mockSapStagingCustomers,
    mockSap: {
      registered: true,
      source: { sourceId: 'MOCK-SAP-FIN-FSCM', sourceName: 'SAP S/4HANA Credit Simulator' },
      entities: mockSapFixtures.entities
    }
  };

  const rMockCust = chatMod.buildLocalStructuredResponse('Show mock SAP customers', state);
  assert.equal(rMockCust.intent.primary, 'MOCK_SAP_STAGING');
  assert.match(rMockCust.summary, /Synthetic staging data \(not in portfolio totals\)/i);
  assert.match(rMockCust.summary, /4 Mock SAP staging customers/i);
  const custRows = rMockCust.blocks.find(b => b.type === 'table').rows;
  assert.equal(custRows.length, 4);
  assert.ok(custRows.every(r => r.country === 'India'));
  const msc4 = custRows.find(r => r.ID === 'MS-C004');
  assert.equal(msc4.creditLimitDisplay, 'No limit set');
  assert.equal(msc4.utilisationDisplay, 'N/A (no limit)');

  const rMsC4 = chatMod.buildLocalStructuredResponse('Evaluate MS-C004', state);
  assert.equal(rMsC4.intent.primary, 'MOCK_SAP_STAGING');
  assert.match(rMsC4.summary, /Synthetic staging data \(not in portfolio totals\)/i);
  assert.match(rMsC4.summary, /Northwind Field Services \(Mock\) \(MS-C004\) in India/i);
  assert.match(rMsC4.summary, /No limit set/i);
  assert.match(rMsC4.summary, /N\/A \(no limit\)/i);

  const rMockInv = chatMod.buildLocalStructuredResponse('Show mock SAP invoices', state);
  assert.equal(rMockInv.blocks.find(b => b.type === 'table').rows.length, 6);

  const rMockAcc = chatMod.buildLocalStructuredResponse('Show mock SAP credit accounts', state);
  const accRows = rMockAcc.blocks.find(b => b.type === 'table').rows;
  assert.equal(accRows.length, 4);
  assert.equal(accRows.find(a => a.accountId === 'MS-CA004').creditLimitDisplay, 'No limit set');

  const rMockPay = chatMod.buildLocalStructuredResponse('Show mock SAP payments', state);
  assert.equal(rMockPay.blocks.find(b => b.type === 'table').rows.length, 4);

  // Confirm active portfolio count still stays 13!
  const rCount = chatMod.buildLocalStructuredResponse('How many customers are in Credit Guard?', state);
  assert.match(rCount.summary, /13 active customers/i);

  // Confirm mockSap.js view renders India and No limit set cleanly
  const elements = new Map();
  const makeHost = () => ({ innerHTML: '', textContent: '', hidden: false, disabled: false });
  const origDoc = globalThis.document;
  globalThis.document = {
    querySelector: sel => {
      if (!elements.has(sel)) elements.set(sel, makeHost());
      return elements.get(sel);
    }
  };
  try {
    mockSapMod.renderMockSap(state.mockSap, { canExtract: true });
    const tablesHtml = elements.get('#mock-sap-records').innerHTML;
    assert.match(tablesHtml, /India/);
    assert.doesNotMatch(tablesHtml, /<td>IN<\/td>/);
    assert.match(tablesHtml, /No limit set/);
    assert.match(elements.get('#mock-sap-portfolio-source').textContent, /synthetic staging/i);
  } finally {
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
  }
});

test('Part 7: Sort and Limit queries ("Lowest 3 utilisation", "Top 3 customers by exposure", "Top 5 customers by credit limit")', async () => {
  const { chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();

  const state = {
    retrievedAt: '2026-11-12T10:00:00.000Z',
    customers: build13CanonicalCustomers()
  };

  // "Lowest 3 utilisation" -> [C012 (5%), C009 (20%), C010 (20%)] (null-limit C013 sorted last, excluded from bottom 3!)
  const pLow = chatMod.classifyClientIntent('Lowest 3 utilisation', state);
  assert.equal(pLow.intent, 'CUSTOMER_LIST');
  assert.equal(pLow.display.sortBy, 'utilisationPct');
  assert.equal(pLow.display.sortDir, 'asc');
  assert.equal(pLow.display.limit, 3);
  const rLow = chatMod.buildLocalStructuredResponse('Lowest 3 utilisation', state, pLow);
  const lowRows = rLow.blocks.find(b => b.type === 'table').rows;
  assert.deepEqual(lowRows.map(r => r.ID), ['C012', 'C009', 'C010']);
  assert.match(rLow.summary, /Showing lowest 3 of 13 customers/i);

  // "Top 3 customers by exposure" -> [C002 (1.53M), C001 (1.475M), C003 (1.05M)]
  const pTopExp = chatMod.classifyClientIntent('Top 3 customers by exposure', state);
  assert.equal(pTopExp.display.sortBy, 'exposure');
  assert.equal(pTopExp.display.sortDir, 'desc');
  assert.equal(pTopExp.display.limit, 3);
  const rTopExp = chatMod.buildLocalStructuredResponse('Top 3 customers by exposure', state, pTopExp);
  const expRows = rTopExp.blocks.find(b => b.type === 'table').rows;
  assert.deepEqual(expRows.map(r => r.ID), ['C002', 'C001', 'C003']);

  // "Top 5 customers by credit limit" -> [C002 (1.5M), C008 (1.3M), C001 (1.2M), C003 (1.1M), C007 (1.0M)]
  const pTopLim = chatMod.classifyClientIntent('Top 5 customers by credit limit', state);
  assert.equal(pTopLim.display.sortBy, 'creditLimit');
  assert.equal(pTopLim.display.sortDir, 'desc');
  assert.equal(pTopLim.display.limit, 5);
  const rTopLim = chatMod.buildLocalStructuredResponse('Top 5 customers by credit limit', state, pTopLim);
  const limRows = rTopLim.blocks.find(b => b.type === 'table').rows;
  assert.equal(limRows.length, 5);
  assert.deepEqual(limRows.slice(0, 4).map(r => r.ID), ['C002', 'C008', 'C001', 'C003']);
  assert.equal(limRows[4].creditLimit, 1000000);
});

test('SAP BTP & HANA CDS Item 1: ACTIVE connectors update last_sync_at on cycle/extract and show Not yet synced vs Never (Not connected)', async () => {
  const { stateMod, chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();

  const initialSources = [
    { source_id: 'MOCK-SAP-FIN-FSCM', source_name: 'SAP S/4HANA Credit Simulator', source_type: 'MOCK_SAP', status: 'ACTIVE', last_sync_at: null },
    { source_id: 'FILE-CSV-JSON-UPLOAD', source_name: 'Structured ERP File Connector', source_type: 'FILE', status: 'ACTIVE', last_sync_at: null },
    { source_id: 'HANA-CLOUD-SLT', source_name: 'SAP HANA Cloud SLT', source_type: 'HANA', status: 'ACTIVE', last_sync_at: null },
    { source_id: 'SAP-BTP-DEST-ABAP', source_name: 'SAP BTP ABAP Destination', source_type: 'SAP_BTP_DEST', status: 'STANDBY', last_sync_at: null }
  ];

  // When never run: ACTIVE -> "Not yet synced", STANDBY -> "Not connected"
  const neverResp = chatMod.buildLocalStructuredResponse('Give me our data sources and connectivity status', {
    retrievedAt: null,
    customers: build13CanonicalCustomers(),
    v2Connectors: { sources: structuredClone(initialSources), mappingsCount: 15, hanaReplicatedTables: [], sapCandidateODataServices: [] }
  });
  const neverRows = neverResp.blocks.find(b => b.type === 'table').rows;
  assert.equal(neverRows.find(r => r.id === 'FILE-CSV-JSON-UPLOAD').freshness, 'Not yet synced');
  assert.equal(neverRows.find(r => r.id === 'HANA-CLOUD-SLT').freshness, 'Not yet synced');
  assert.equal(neverRows.find(r => r.id === 'SAP-BTP-DEST-ABAP').freshness, 'Not connected');

  // Extract data updates MOCK-SAP-FIN-FSCM and HANA-CLOUD-SLT without touching STANDBY
  stateMod.state.v2Connectors = { sources: structuredClone(initialSources) };
  const extractIso = '2026-11-12T12:00:00.000Z';
  stateMod.updateConnectorSyncTimestamp(['MOCK-SAP-FIN-FSCM', 'HANA-CLOUD-SLT'], extractIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'MOCK-SAP-FIN-FSCM').last_sync_at, extractIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'HANA-CLOUD-SLT').last_sync_at, extractIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'FILE-CSV-JSON-UPLOAD').last_sync_at, null);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'SAP-BTP-DEST-ABAP').last_sync_at, null);

  // Scheduler cycle updates all ACTIVE connectors (including FILE-CSV-JSON-UPLOAD) and leaves STANDBY null
  const cycleIso = '2026-11-12T12:05:00.000Z';
  stateMod.updateConnectorSyncTimestamp('ACTIVE', cycleIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'FILE-CSV-JSON-UPLOAD').last_sync_at, cycleIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'HANA-CLOUD-SLT').last_sync_at, cycleIso);
  assert.equal(stateMod.state.v2Connectors.sources.find(s => s.source_id === 'SAP-BTP-DEST-ABAP').last_sync_at, null);

  // Verify connectorsView.js distinguishes Not yet synced vs Never (Not connected)
  const connectorsViewSrc = await fs.readFile(path.join(appRoot, 'views', 'connectorsView.js'), 'utf8');
  assert.match(connectorsViewSrc, /Not yet synced/);
  assert.match(connectorsViewSrc, /Never \(Not connected\)/);
  assert.match(connectorsViewSrc, /Last Execution \(scheduler cycle\)/);
  assert.match(connectorsViewSrc, /Scheduler cycle duration:/);

  // Verify autonomousScheduler.js updates ACTIVE connectors in DB
  const schedulerSrc = await fs.readFile(path.join(__dirname, '..', 'srv', 'autonomousScheduler.js'), 'utf8');
  assert.match(schedulerSrc, /ensureDefaultEnterpriseSources/);
  assert.match(schedulerSrc, /status \|\| ''\)\.toUpperCase\(\) === 'ACTIVE'/);
});

test('SAP BTP & HANA CDS Items 2, 3, 4 & 5: Monitoring status & Registration from shared runs, unified Mock SAP ID, and Extraction duration label', async () => {
  const { mockSapMod, chatMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();

  const elements = new Map();
  const makeHost = () => ({ innerHTML: '', textContent: '', hidden: false, disabled: false });
  const origDoc = globalThis.document;
  globalThis.document = {
    querySelector: sel => {
      if (!elements.has(sel)) elements.set(sel, makeHost());
      return elements.get(sel);
    }
  };

  try {
    const baseData = {
      registered: false,
      portfolioSource: 'local',
      source: {
        sourceId: 'MOCK-S4-001',
        sourceName: 'Mock SAP Simulator (synthetic data only)',
        enabled: true
      },
      entities: mockSapFixtures.entities,
      latestRun: null
    };

    // Case A: Shared log is empty -> shows "Extract source data before running monitoring", "Built-in source · registers on first extraction", Run monitoring hidden
    mockSapMod.renderMockSap(baseData, { canExtract: true, canMonitor: true }, []);
    assert.equal(elements.get('#mock-sap-registration').textContent, 'Built-in source · registers on first extraction');
    assert.equal(elements.get('#mock-sap-monitoring-status').textContent, 'Extract source data before running monitoring.');
    assert.equal(elements.get('#run-mock-sap-monitoring').hidden, true);
    assert.equal(elements.get('#mock-sap-source-id').textContent, 'MOCK-SAP-FIN-FSCM (Simulator ID: MOCK-S4-001)');

    // Case B: Shared extraction run is COMPLETED -> "Registered source", Run monitoring enabled, status updated, and Extraction duration labeled
    const sharedRuns = [{
      runId: 'RUN-SHARED-1',
      startedAt: '2026-11-12T12:00:00.000Z',
      finishedAt: '2026-11-12T12:00:00.210Z',
      durationMs: 210,
      sourceId: 'CAP-HANA-CDS',
      sourceName: 'CAP database (demo)',
      status: 'COMPLETED',
      triggeredBy: 'SCHEDULER'
    }];
    mockSapMod.renderMockSap(baseData, { canExtract: true, canMonitor: true }, sharedRuns);
    assert.equal(elements.get('#mock-sap-registration').textContent, 'Registered source');
    assert.equal(elements.get('#run-mock-sap-monitoring').hidden, false);
    assert.equal(elements.get('#run-mock-sap-monitoring').disabled, false);
    assert.doesNotMatch(elements.get('#mock-sap-monitoring-status').textContent, /Extract source data before running monitoring/);
    assert.match(elements.get('#mock-sap-extraction-status').innerHTML, /<dt>Extraction duration<\/dt><dd>210 ms<\/dd>/);

    // Case C: Unified ID appears in connectorsView.js and AI answers (both DATA_SOURCES_STATUS and MOCK-S4-001 query)
    const connectorsViewSrc = await fs.readFile(path.join(appRoot, 'views', 'connectorsView.js'), 'utf8');
    assert.match(connectorsViewSrc, /Simulator ID: <code>MOCK-S4-001<\/code>/);

    const state = {
      retrievedAt: '2026-11-12T12:00:00.000Z',
      customers: build13CanonicalCustomers(),
      v2Connectors: build7ConnectorsPayload('2026-11-12T12:00:00.000Z'),
      mockSap: { ...baseData, registered: true }
    };
    const rAlias = chatMod.buildLocalStructuredResponse('What is MOCK-S4-001?', state);
    assert.equal(rAlias.intent.primary, 'DATA_SOURCES_STATUS');
    const mockRow = rAlias.blocks.find(b => b.type === 'table').rows.find(r => r.id === 'MOCK-SAP-FIN-FSCM');
    assert.ok(mockRow);
    assert.match(mockRow.name || mockRow.connector, /MOCK-S4-001/);
  } finally {
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
  }
});

test('Part 7: Field mappings count consistency, overdue consistency across AI and Credit Overview, and dynamic source badge', async () => {
  const { chatMod, wsMod } = await loadFrontendModules();
  chatMod.resetChatRouterState();

  const state = {
    retrievedAt: '2026-11-12T12:00:00.000Z',
    customers: build13CanonicalCustomers(),
    v2Connectors: build7ConnectorsPayload('2026-11-12T12:00:00.000Z'),
    dashboard: {
      kpis: {
        currency: 'INR',
        totalExposure: 6535000,
        totalLimit: 10400000,
        overallUtilisation: 0.628365,
        overdueAmount: 2132500,
        customersBreached: 3,
        criticalCustomers: 1,
        overdueInvoiceCount: 12,
        overdueRiskCustomers: 10,
        customerCount: 13
      }
    }
  };

  const wsAdapters = wsMod.getWorkspaceAdapters(state);
  const simulatorAdapter = wsAdapters.find(a => a.tabId === 'simulator');
  const simSnap = simulatorAdapter.getSnapshot();
  assert.equal(simSnap.mappingsCount, 15);

  const rOverdue = chatMod.buildLocalStructuredResponse('Overdue invoices', state);
  assert.match(rOverdue.summary, /10 of 13 customers hold ₹21,32,500 in overdue receivables across 12 past-due invoices/i);

  const rSources = chatMod.buildLocalStructuredResponse('Give me our data sources and connectivity status', state);
  assert.equal(rSources.sourceTabLabel, 'SAP BTP & HANA CDS');
});

