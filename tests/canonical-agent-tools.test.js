const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { SAP_VERIFICATION_NOTE } = require('../srv/canonicalSchemaMetadata');
const {
  CANONICAL_AGENT_TOOLS,
  executeCanonicalAgentTool,
  runCanonicalAgentQuery
} = require('../srv/canonicalAgentTools');

test('CANONICAL_AGENT_TOOLS defines all 4 deterministic FIN-FSCM-CR tools', () => {
  const names = CANONICAL_AGENT_TOOLS.map(t => t.name);
  assert.deepEqual(names, [
    'get_canonical_portfolio_exposure',
    'get_business_partner_dossier',
    'preview_canonical_limit_change',
    'get_connector_and_mapping_status'
  ]);
});

test('executeCanonicalAgentTool and runCanonicalAgentQuery return exact deterministic FIN-FSCM-CR metrics', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  // 1. Portfolio exposure tool
  const portfolio = await executeCanonicalAgentTool(db, 'get_canonical_portfolio_exposure', {});
  assert.equal(portfolio.summary.customersMonitored, 13);
  assert.equal(portfolio.summary.totalCreditLimit, 10400000);
  assert.equal(portfolio.summary.totalExposure, 6535000);

  // 2. Business Partner dossier tool
  const dossier = await executeCanonicalAgentTool(db, 'get_business_partner_dossier', { bpId: 'C001' });
  assert.equal(dossier.partner.bp_id, 'C001');
  assert.equal(Number(dossier.snapshot.total_exposure), 1200000);
  assert.equal(dossier.snapshot.threshold_status, 'BREACH');

  // 3. Limit change preview tool
  const preview = await executeCanonicalAgentTool(db, 'preview_canonical_limit_change', {
    bpId: 'C001',
    requestedLimit: 1500000
  });
  assert.equal(preview.projected_utilization_pct, 80);
  assert.equal(preview.projected_threshold_status, 'WARNING');
  assert.equal(preview.sap_target.verified, false);
  assert.equal(preview.sap_target.verificationNote, SAP_VERIFICATION_NOTE);

  // 4. Connector and mapping status tool
  const status = await executeCanonicalAgentTool(db, 'get_connector_and_mapping_status', {});
  assert.equal(status.sapVerificationDefault, false);
  assert.equal(status.sapVerificationNote, SAP_VERIFICATION_NOTE);
  assert.ok(status.sources.length >= 6);

  // 5. End-to-end runCanonicalAgentQuery for BP + limit simulation
  const queryRes = await runCanonicalAgentQuery(db, {
    question: 'Evaluate C001 and simulate raising credit limit to 1500000'
  });
  assert.equal(queryRes.sapVerificationDefault, false);
  assert.equal(queryRes.sapVerificationNote, SAP_VERIFICATION_NOTE);
  assert.equal(queryRes.executedTools.length, 2);
  assert.ok(queryRes.deterministicBriefing.includes('Aarav Components'));
  assert.ok(queryRes.deterministicBriefing.includes('80%'));
});
