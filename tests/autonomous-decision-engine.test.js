const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { SAP_VERIFICATION_NOTE } = require('../srv/canonicalSchemaMetadata');
const {
  DEFAULT_AUTONOMOUS_CREDIT_POLICY,
  evaluateCustomerAutonomousDecision,
  evaluatePortfolioAutonomousActions,
  processPendingRequestsAutonomously
} = require('../srv/autonomousDecisionEngine');
const {
  listCanonicalLimitRequests,
  seedCanonicalFromLegacyDemo
} = require('../srv/canonicalRepository');
const { submitCanonicalLimitRequest } = require('../srv/limitWorkflowService');

test('Autonomous Credit Decision Engine evaluates low-risk, high-value, and high-risk requests deterministically', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);
  await seedCanonicalFromLegacyDemo(db, { referenceDate: '2026-11-09' });

  // 1. Low-risk customer C007 (Lotus Industrial, Risk Class A, limit 600,000, exposure 300,000, 0 31+d overdue):
  // Proposing +10% (660,000, +60,000 INR) -> should AUTO_APPROVE
  const lowRiskEval = await evaluateCustomerAutonomousDecision(db, 'C007', {
    requestedLimit: 660000
  });
  assert.equal(lowRiskEval.decision, 'AUTO_APPROVE');
  assert.equal(lowRiskEval.matched_rule_id, 'RULE-AUTO-APPROVE-LOW-RISK');
  assert.equal(lowRiskEval.required_human_authority, 'Autonomous Policy Agent');
  assert.equal(lowRiskEval.sap_reference.verified, false);
  assert.equal(lowRiskEval.sap_reference.verificationNote, SAP_VERIFICATION_NOTE);

  // 2. High-value increase on C007 (+40%, 840,000, +240,000 INR) -> exceeds 15% and 150,000 INR caps -> ESCALATE_TO_HUMAN
  const highValueEval = await evaluateCustomerAutonomousDecision(db, 'C007', {
    requestedLimit: 840000
  });
  assert.equal(highValueEval.decision, 'ESCALATE_TO_HUMAN');
  assert.equal(highValueEval.matched_rule_id, 'RULE-ESCALATE-AUTHORITY-THRESHOLD');
  assert.equal(highValueEval.required_human_authority, 'Credit Controller');

  // 3. Breached customer C001 (120% utilization):
  // Proposing 1,600,000 (+60%, +600,000 INR) -> ESCALATE_TO_HUMAN (Finance Head)
  const c001Eval = await evaluateCustomerAutonomousDecision(db, 'C001', {
    requestedLimit: 1600000
  });
  assert.equal(c001Eval.decision, 'ESCALATE_TO_HUMAN');
  assert.equal(c001Eval.required_human_authority, 'Finance Head');

  // 4. Auto-Reject when custom policy classifies Risk Class C (e.g., C005) as auto-rejectable
  const strictRejectEval = await evaluateCustomerAutonomousDecision(db, 'C005', {
    requestedLimit: 1200000,
    policy: {
      ...DEFAULT_AUTONOMOUS_CREDIT_POLICY,
      autoRejectRiskClasses: ['C', 'D', 'E']
    }
  });
  assert.equal(strictRejectEval.decision, 'AUTO_REJECT');
  assert.equal(strictRejectEval.matched_rule_id, 'RULE-REJECT-HIGH-RISK-CLASS');
});

test('processPendingRequestsAutonomously auto-approves low-risk requests, syncs to SAP, and escalates large requests', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);
  await seedCanonicalFromLegacyDemo(db, { referenceDate: '2026-11-09' });

  // Submit a low-risk request for C007 (+10%: 600,000 -> 660,000)
  const lowRiskReq = await submitCanonicalLimitRequest(db, {
    bpId: 'C007',
    requestedLimit: 660000,
    justification: 'Routine seasonal volume buffer (+10%)',
    requestedBy: 'requester'
  });

  // Submit a high-value request for C001 (+50%: 1,000,000 -> 1,500,000)
  const highValueReq = await submitCanonicalLimitRequest(db, {
    bpId: 'C001',
    requestedLimit: 1500000,
    justification: 'Major contract expansion (+50%)',
    requestedBy: 'requester'
  });

  const sweepResult = await processPendingRequestsAutonomously(db, {
    autoSyncToSap: true
  });

  assert.equal(sweepResult.evaluated_count, 2);
  assert.equal(sweepResult.auto_approved_count, 1);
  assert.equal(sweepResult.escalated_to_human_count, 1);

  const updatedRequests = await listCanonicalLimitRequests(db);
  const c007After = updatedRequests.find(r => r.request_id === lowRiskReq.request_id);
  const c001After = updatedRequests.find(r => r.request_id === highValueReq.request_id);

  assert.equal(c007After.status, 'SYNCED_TO_SAP');
  assert.equal(c007After.approved_by, 'AUTONOMOUS_POLICY_AGENT');

  // High-value request remains PENDING_APPROVAL for human Finance Head
  assert.equal(c001After.status, 'PENDING_APPROVAL');
});

test('evaluatePortfolioAutonomousActions scans all 13 Business Partners and classifies actions', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);
  await seedCanonicalFromLegacyDemo(db, { referenceDate: '2026-11-09' });

  const scan = await evaluatePortfolioAutonomousActions(db, {
    autoCreateAndExecute: false
  });

  assert.equal(scan.total_partners_scanned, 13);
  assert.ok(scan.flagged_partners_count >= 5);
  assert.ok(scan.auto_approvable_count >= 1);
  assert.ok(scan.human_escalation_count >= 1);
});
