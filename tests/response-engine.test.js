const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const cds = require('@sap/cds');
const {
  generateStructuredCreditResponse,
  classifyIntentDeterministically,
  calculateUtilisation,
  validateAndReconcileResponse,
  clearSessionContext
} = require('../srv/responseEngine');
const { executeMonitoringRun } = require('../srv/monitoringService');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');
let moduleSequence = 0;

async function loadBlockRenderer() {
  const utils = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utils).toString('base64')}`;
  let source = await fs.readFile(path.join(appRoot, 'views', 'blockRenderer.js'), 'utf8');
  source = source.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  return import(moduleUrl);
}

const readerUser = new cds.User({
  id: 'credit-reader-test',
  roles: ['CreditReader', 'CreditMonitor', 'CreditAdmin']
});

test('Response Engine 18-Query Matrix, Reconciliation & DOM Renderer Suite', async t => {
  await cds.test(path.join(__dirname, '..'));
  const db = cds.db;
  await executeMonitoringRun({ db, user: readerUser, runKind: 'MANUAL' });

  await t.test('1. LIST: "Show all customers" -> 1-line summary + customer table ONLY (no KPI cards, no chart)', async () => {
    clearSessionContext();
    const { intentPlan, structuredResponse } = await generateStructuredCreditResponse('Show all customers', {
      db,
      user: readerUser,
      sessionId: 's1'
    });

    assert.equal(intentPlan.primaryIntent, 'LIST');
    assert.equal(structuredResponse.intent.primary, 'LIST');
    const blockTypes = structuredResponse.blocks.map(b => b.type);
    assert.deepEqual(blockTypes, ['table']);
    assert.ok(!blockTypes.includes('metrics'), 'LIST must not render KPI metrics');
    assert.ok(!blockTypes.includes('chart'), 'LIST must not render a chart');
    assert.equal(structuredResponse.blocks[0].totalRows, 13);
  });

  await t.test('2. LIST (Filtered): "List customers with utilisation >= 80%" -> filtered table ONLY (6 customers)', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('List customers with utilisation >= 80%', {
      db,
      user: readerUser,
      sessionId: 's2'
    });

    assert.equal(structuredResponse.intent.primary, 'LIST');
    assert.deepEqual(structuredResponse.blocks.map(b => b.type), ['table']);
    const table = structuredResponse.blocks[0];
    assert.equal(table.totalRows, 6);
    const ids = table.rows.map(r => r.customerId).sort();
    assert.deepEqual(ids, ['C001', 'C002', 'C003', 'C004', 'C005', 'C013']);
    assert.match(structuredResponse.summary, /Found 6 customers/);
  });

  await t.test('3. COMPARE (Ranking): "Which customer has the highest credit utilisation?" -> hbar chart + compact table (no KPI row)', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Which customer has the highest credit utilisation?', {
      db,
      user: readerUser,
      sessionId: 's3'
    });

    assert.equal(structuredResponse.intent.primary, 'COMPARE');
    const blockTypes = structuredResponse.blocks.map(b => b.type);
    assert.ok(!blockTypes.includes('metrics'), 'COMPARE must not render full portfolio KPI row');
    assert.ok(blockTypes.includes('chart'));
    assert.ok(blockTypes.includes('table'));
    assert.match(structuredResponse.summary, /Aarav Components \(C001\)/);
    assert.match(structuredResponse.summary, /120\.0%/);

    const chart = structuredResponse.blocks.find(b => b.type === 'chart');
    assert.equal(chart.chartType, 'hbar');
    assert.equal(chart.series[0].data[0].highlight, true);
  });

  await t.test('4. COMPARE (Multi-entity): "Compare C001, C002 and C003 on exposure and limit" -> groupedBar chart + 3-row table + observations', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Compare C001, C002 and C003 on exposure and limit', {
      db,
      user: readerUser,
      sessionId: 's4'
    });

    assert.equal(structuredResponse.intent.primary, 'COMPARE');
    const chart = structuredResponse.blocks.find(b => b.type === 'chart');
    const table = structuredResponse.blocks.find(b => b.type === 'table');
    const obs = structuredResponse.blocks.find(b => b.type === 'observations');

    assert.equal(chart.chartType, 'groupedBar');
    assert.equal(chart.series.length, 2);
    assert.equal(table.totalRows, 3);
    assert.ok(obs.items.length >= 2);
  });

  await t.test('5. APPROVAL: "Can we approve a credit limit increase for C001 to ₹15,00,000?" -> profile + comparison + recommendation (executed: false)', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Can we approve a credit limit increase for C001 to ₹15,00,000?', {
      db,
      user: readerUser,
      sessionId: 's5'
    });

    assert.equal(structuredResponse.intent.primary, 'APPROVAL');
    const kv = structuredResponse.blocks.find(b => b.type === 'keyValue');
    const comp = structuredResponse.blocks.find(b => b.type === 'comparison');
    const rec = structuredResponse.blocks.find(b => b.type === 'recommendation');

    assert.ok(kv);
    assert.ok(comp);
    assert.ok(rec);
    assert.equal(rec.executed, false);
    assert.ok(Array.isArray(rec.policyChecks) && rec.policyChecks.length >= 3);
    const utilRow = comp.rows.find(r => r.metric.includes('Utilisation'));
    assert.equal(utilRow.projected, '80.0%');
  });

  await t.test('6. EXPOSURE: "Show total portfolio credit exposure by country" -> 4 KPI cards + donut chart + breakdown table + observations (all reconciling)', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Show total portfolio credit exposure by country', {
      db,
      user: readerUser,
      sessionId: 's6'
    });

    assert.equal(structuredResponse.intent.primary, 'EXPOSURE');
    const metrics = structuredResponse.blocks.find(b => b.type === 'metrics');
    const chart = structuredResponse.blocks.find(b => b.type === 'chart');
    const table = structuredResponse.blocks.find(b => b.type === 'table');

    assert.equal(metrics.items.length, 4);
    assert.equal(chart.chartType, 'donut');
    assert.equal(table.totalRows, 3);

    const tableExpSum = table.rows.reduce((sum, r) => sum + r.exposure, 0);
    const kpiExp = metrics.items.find(i => i.id === 'total-exposure').rawValue;
    assert.equal(tableExpSum, kpiExp);
    assert.equal(kpiExp, 6535000);
  });

  await t.test('7. RISK: "Identify high-risk customers and explain why" -> risk KPI counts + distribution chart + risk-ranked table with reasons + priority actions', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Identify high-risk customers and explain why', {
      db,
      user: readerUser,
      sessionId: 's7'
    });

    assert.equal(structuredResponse.intent.primary, 'RISK');
    const metrics = structuredResponse.blocks.find(b => b.type === 'metrics');
    const chart = structuredResponse.blocks.find(b => b.type === 'chart');
    const table = structuredResponse.blocks.find(b => b.type === 'table');
    const obs = structuredResponse.blocks.find(b => b.type === 'observations');

    assert.ok(metrics);
    assert.equal(chart.chartType, 'donut');
    assert.ok(table.columns.some(c => c.key === 'riskReason'));
    assert.ok(obs.items.length >= 2);
  });

  await t.test('8. TREND: "Show exposure trend over the last 6 months" -> honest limitation notice with no fabricated chart when <3 snapshots exist', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Show exposure trend over the last 6 months', {
      db,
      user: readerUser,
      sessionId: 's8'
    });

    assert.equal(structuredResponse.intent.primary, 'TREND');
    const blockTypes = structuredResponse.blocks.map(b => b.type);
    assert.deepEqual(blockTypes, ['notice']);
    assert.ok(!blockTypes.includes('chart'), 'Must not fabricate a historical line chart when <3 snapshots exist');
    assert.ok(structuredResponse.limitations.length >= 1);
  });

  await t.test('9. CUSTOMER_DETAIL: "Give full details for customer C001" -> profile + 4 KPIs + open items + payments + alerts + next steps', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Give full details for customer C001', {
      db,
      user: readerUser,
      sessionId: 's9'
    });

    assert.equal(structuredResponse.intent.primary, 'CUSTOMER_DETAIL');
    const blockTypes = structuredResponse.blocks.map(b => b.type);
    assert.ok(blockTypes.includes('keyValue'));
    assert.ok(blockTypes.includes('metrics'));
    assert.ok(blockTypes.includes('table'));
    assert.ok(blockTypes.includes('observations'));
    assert.match(structuredResponse.summary, /Aarav Components \(C001\)/);
    assert.match(structuredResponse.summary, /₹12,00,000/);
  });

  await t.test('10. MONITORING: "What active monitoring alerts need attention today?" -> severity-sorted alert cards + run timestamp', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('What active monitoring alerts need attention today?', {
      db,
      user: readerUser,
      sessionId: 's10'
    });

    assert.equal(structuredResponse.intent.primary, 'MONITORING');
    const alertsBlock = structuredResponse.blocks.find(b => b.type === 'alerts');
    assert.ok(alertsBlock);
    assert.ok(alertsBlock.items.length > 0);
    assert.equal(alertsBlock.items[0].severity, 'critical');
  });

  await t.test('11. PAYMENT_OVERDUE: "Which customers have overdue invoices and how old are they?" -> overdue table + ageing bucket chart + collection priorities', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Which customers have overdue invoices and how old are they?', {
      db,
      user: readerUser,
      sessionId: 's11'
    });

    assert.equal(structuredResponse.intent.primary, 'PAYMENT_OVERDUE');
    const chart = structuredResponse.blocks.find(b => b.type === 'chart');
    const table = structuredResponse.blocks.find(b => b.type === 'table');
    const obs = structuredResponse.blocks.find(b => b.type === 'observations');

    assert.ok(chart);
    assert.equal(chart.series[0].data.length, 4);
    assert.equal(table.totalRows, 12);
    assert.ok(obs.items.length > 0);
  });

  await t.test('12. WHATIF: "What if C003 places a new order of ₹3,00,000?" -> current vs projected comparison + groupedBar chart + SIMULATION notice', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('What if C003 places a new order of ₹3,00,000?', {
      db,
      user: readerUser,
      sessionId: 's12'
    });

    assert.equal(structuredResponse.intent.primary, 'WHATIF');
    const notice = structuredResponse.blocks.find(b => b.type === 'notice');
    const comp = structuredResponse.blocks.find(b => b.type === 'comparison');
    const chart = structuredResponse.blocks.find(b => b.type === 'chart');

    assert.match(notice.title, /SIMULATION – no data changed/);
    assert.equal(comp.simulation, true);
    assert.equal(chart.valueKind, 'SIMULATED');
    const expRow = comp.rows.find(r => r.metric.includes('Exposure'));
    assert.equal(expRow.projected, '₹12,50,000');
  });

  await t.test('13. SAP_DATASOURCE: "What is the status of the SAP S/4HANA data source?" -> connector status card + table with SYNTHETIC_DEMO label', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('What is the status of the SAP S/4HANA data source?', {
      db,
      user: readerUser,
      sessionId: 's13'
    });

    assert.equal(structuredResponse.intent.primary, 'SAP_DATASOURCE');
    assert.match(structuredResponse.summary, /SYNTHETIC_DEMO|MOCK_SAP_SIMULATOR/);
    assert.notEqual(structuredResponse.dataProvenance.sourceType, 'LIVE_SAP');
  });

  await t.test('14. EXPLAIN: "How is credit utilisation calculated in Credit Guard?" -> formula + worked example + thresholds (no chart/table)', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('How is credit utilisation calculated in Credit Guard?', {
      db,
      user: readerUser,
      sessionId: 's14'
    });

    assert.equal(structuredResponse.intent.primary, 'EXPLAIN');
    const blockTypes = structuredResponse.blocks.map(b => b.type);
    assert.ok(!blockTypes.includes('chart'));
    assert.ok(!blockTypes.includes('table'));
    assert.ok(blockTypes.includes('text'));
    assert.ok(blockTypes.includes('keyValue'));
  });

  await t.test('15. Follow-up Context Resolution: after #2 ("List customers with utilisation >= 80%"), ask "Compare their exposure" -> COMPARE with resolvedFromContext: true over the 6 customers', async () => {
    clearSessionContext();
    await generateStructuredCreditResponse('List customers with utilisation >= 80%', {
      db,
      user: readerUser,
      sessionId: 's15'
    });

    const followUp = await generateStructuredCreditResponse('Compare their exposure', {
      db,
      user: readerUser,
      sessionId: 's15'
    });

    assert.equal(followUp.structuredResponse.intent.primary, 'COMPARE');
    assert.equal(followUp.structuredResponse.intent.resolvedFromContext, true);
    assert.match(followUp.structuredResponse.intent.contextNote, /Using: C001/);
    const table = followUp.structuredResponse.blocks.find(b => b.type === 'table');
    assert.equal(table.totalRows, 6);
  });

  await t.test('16. CLARIFY: "Approve limit increase" (no customer) -> CLARIFY intent, asks which customer and target limit, runs no tools', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Approve limit increase', {
      db,
      user: readerUser,
      sessionId: 's16'
    });

    assert.equal(structuredResponse.intent.primary, 'CLARIFY');
    assert.deepEqual(structuredResponse.dataProvenance.toolsInvoked, []);
    const notice = structuredResponse.blocks.find(b => b.type === 'notice');
    assert.match(notice.message, /customer/i);
  });

  await t.test('17. Unknown Customer: "Tell me about C999" -> structured not-found notice, zero fabricated numbers', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('Tell me about C999', {
      db,
      user: readerUser,
      sessionId: 's17'
    });

    assert.equal(structuredResponse.intent.primary, 'CUSTOMER_DETAIL');
    assert.deepEqual(structuredResponse.blocks.map(b => b.type), ['notice']);
    assert.match(structuredResponse.blocks[0].title, /C999 Not Found/);
  });

  await t.test('18. OUT_OF_SCOPE: "What is the weather in Mumbai?" -> polite refusal + 3 credit-domain suggestions', async () => {
    clearSessionContext();
    const { structuredResponse } = await generateStructuredCreditResponse('What is the weather in Mumbai?', {
      db,
      user: readerUser,
      sessionId: 's18'
    });

    assert.equal(structuredResponse.intent.primary, 'OUT_OF_SCOPE');
    assert.equal(structuredResponse.suggestedFollowUps.length, 3);
    assert.match(structuredResponse.summary, /Bluspring Enterprises credit/i);
  });

  await t.test('19. Zero-limit safety & reconciliation repair: creditLimit = 0 produces null utilisation ("N/A (no limit)") and flags "No limit set" if exposure > 0', async () => {
    const zeroWithExp = calculateUtilisation(250000, 0);
    assert.equal(zeroWithExp.utilisationPct, null);
    assert.equal(zeroWithExp.display, 'N/A (no limit)');
    assert.equal(zeroWithExp.flag, 'No limit set');

    const mismatchedCandidate = {
      schemaVersion: '1.0',
      intent: { primary: 'EXPOSURE', secondary: [], confidence: 0.9 },
      title: '### Mismatched Test',
      summary: 'Found **data**',
      blocks: [
        {
          type: 'metrics',
          items: [{
            id: 'total-exposure',
            label: 'Total Exposure',
            value: '₹99,99,999',
            rawValue: 9999999,
            unit: 'INR',
            valueKind: 'CALCULATED'
          }]
        },
        {
          type: 'table',
          columns: [{ key: 'exposure', label: 'Exposure', format: 'currency' }],
          rows: [
            { customerId: 'C001', creditLimit: 0, exposure: 500000, utilisationPct: Infinity, flags: '' }
          ]
        }
      ],
      dataProvenance: { sourceType: 'LIVE_SAP' }
    };

    const validated = validateAndReconcileResponse(mismatchedCandidate);
    assert.equal(validated.title, 'Mismatched Test');
    assert.equal(validated.summary, 'Found data');
    assert.equal(validated.dataProvenance.sourceType, 'SYNTHETIC_DEMO');
    const repairedMetric = validated.blocks.find(b => b.type === 'metrics').items[0];
    assert.equal(repairedMetric.rawValue, 500000);
    assert.equal(repairedMetric.value, '₹5,00,000');
    const repairedRow = validated.blocks.find(b => b.type === 'table').rows[0];
    assert.equal(repairedRow.utilisationPct, null);
    assert.equal(repairedRow.utilisationDisplay, 'N/A (no limit)');
    assert.match(repairedRow.flags, /No limit set/);
  });

  await t.test('20. Combined Intent: "List high-risk customers and explain why they are risky" -> LIST + RISK with table first and observations second', async () => {
    const plan = classifyIntentDeterministically('List high-risk customers and explain why they are risky', { sessionId: 's20' });
    assert.equal(plan.primaryIntent, 'LIST');
    assert.deepEqual(plan.secondaryIntents, ['RISK']);
    assert.deepEqual(plan.responseBlocks, ['table', 'observations']);
  });

  await t.test('21. DOM-safe blockRenderer builds structured elements without raw markdown or unescaped HTML', async () => {
    const { renderStructuredResponseDOM } = await loadBlockRenderer();
    const { structuredResponse } = await generateStructuredCreditResponse('Show total portfolio credit exposure by country', {
      db,
      user: readerUser,
      sessionId: 's21'
    });

    const node = renderStructuredResponseDOM(structuredResponse);
    const html = node.toHTML();
    assert.match(html, /Portfolio Credit Exposure Analysis/);
    assert.match(html, /DEMO DATA/);
    assert.match(html, /CALCULATED/);
    assert.match(html, /₹65,35,000/);
    assert.match(html, /re-show-details/);
    assert.doesNotMatch(html, /###|\*\*/);
  });

  await t.test('22. GREETING ("Hi,") returns 1-2 line friendly reply + 3 suggested chips with NO data cards or tables', async () => {
    const { renderStructuredResponseDOM } = await loadBlockRenderer();
    const { structuredResponse } = await generateStructuredCreditResponse('Hi,', {
      db,
      user: readerUser,
      sessionId: 's22'
    });

    assert.equal(structuredResponse.intent.primary, 'GREETING');
    assert.equal(structuredResponse.blocks.length, 0);
    assert.equal(structuredResponse.suggestedFollowUps.length, 3);

    const html = renderStructuredResponseDOM(structuredResponse).toHTML();
    assert.doesNotMatch(html, /<table/);
    assert.doesNotMatch(html, /re-show-details/);
    assert.match(html, /re-followup-chip/);
  });

  await t.test('23. DATA_SOURCES / CONNECTIVITY_STATUS ("Give me our data sources and connectivity status") returns SAP_DATASOURCE and not exposure analysis', async () => {
    const { structuredResponse } = await generateStructuredCreditResponse('Give me our data sources and connectivity status', {
      db,
      user: readerUser,
      sessionId: 's23'
    });

    assert.equal(structuredResponse.intent.primary, 'SAP_DATASOURCE');
    assert.ok(structuredResponse.headlineBullets.length >= 2);
    assert.doesNotMatch(structuredResponse.summary, /Total portfolio credit exposure/i);
  });

  await t.test('24. UTILISATION_LIST shorthand ("Customers above 80% utilisation") and country normalization ("IN" -> "India") match Credit Overview totals', async () => {
    const { structuredResponse: listRes } = await generateStructuredCreditResponse('Customers above 80% utilisation', {
      db,
      user: readerUser,
      sessionId: 's24a'
    });
    assert.equal(listRes.intent.primary, 'LIST');
    const tableBlock = listRes.blocks.find(b => b.type === 'table');
    assert.equal(tableBlock.rows.length, 6);
    assert.ok(listRes.headlineBullets.length > 0 && listRes.headlineBullets.length <= 5);

    const { structuredResponse: expRes } = await generateStructuredCreditResponse('Exposure by country', {
      db,
      user: readerUser,
      sessionId: 's24b'
    });
    assert.equal(expRes.intent.primary, 'EXPOSURE');
    const countryTable = expRes.blocks.find(b => b.type === 'table');
    const countryKeys = countryTable.rows.map(r => r.label || r.groupKey);
    assert.deepEqual(countryKeys, ['India', 'UAE', 'Singapore']);
    assert.ok(!countryKeys.includes('IN'));
    assert.match(expRes.summary, /13 customers/);
    assert.match(expRes.summary, /₹65,35,000/);
    assert.match(expRes.summary, /₹1,04,00,000/);
    assert.match(expRes.summary, /62\.8%/);
  });
});

