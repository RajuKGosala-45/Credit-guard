const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { SAP_VERIFICATION_NOTE } = require('../srv/canonicalSchemaMetadata');
const {
  decideCanonicalLimitRequest,
  listEnrichedCanonicalLimitRequests,
  previewCanonicalLimitChange,
  promoteDraftLimitRequest,
  submitCanonicalLimitRequest,
  syncApprovedLimitRequestToSap
} = require('../srv/limitWorkflowService');
const {
  getBusinessPartnerCreditDossier
} = require('../srv/canonicalRepository');

test('previewCanonicalLimitChange calculates deterministic before/after utilization and SAP target metadata', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  // C001 has credit_limit = 1,000,000 and total_exposure = 1,200,000 (120% BREACH)
  const preview = await previewCanonicalLimitChange(db, {
    bpId: 'C001',
    requestedLimit: 1500000,
    referenceDate: '2026-11-09'
  });

  assert.equal(preview.bp_id, 'C001');
  assert.equal(preview.current_limit, 1000000);
  assert.equal(preview.requested_limit, 1500000);
  assert.equal(preview.delta_amount, 500000);
  assert.equal(preview.delta_pct, 50);
  assert.equal(preview.total_exposure, 1200000);
  assert.equal(preview.current_utilization_pct, 120);
  assert.equal(preview.projected_utilization_pct, 80);
  assert.equal(preview.current_threshold_status, 'BREACH');
  assert.equal(preview.projected_threshold_status, 'WARNING');
  assert.equal(preview.approver_level, 'Credit Controller');
  assert.equal(preview.sap_target.table, 'UKMBP_CMS_SGM');
  assert.equal(preview.sap_target.verified, false);
  assert.equal(preview.sap_target.verificationNote, SAP_VERIFICATION_NOTE);

  const highPreview = await previewCanonicalLimitChange(db, {
    bpId: 'C001',
    requestedLimit: 1600000,
    referenceDate: '2026-11-09'
  });
  assert.equal(highPreview.approver_level, 'Finance Head');
});

test('workflow state machine: DRAFT -> PENDING_APPROVAL -> APPROVED -> SYNCED_TO_SAP recalculates snapshot and enforces separation of duties', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  // 1. Create as DRAFT
  const draft = await submitCanonicalLimitRequest(db, {
    bpId: 'C001',
    requestedLimit: 1500000,
    justification: 'Q4 festive production order backlog requires ₹15L limit.',
    status: 'DRAFT',
    requestedBy: 'analyst_1'
  });
  assert.equal(draft.status, 'DRAFT');

  // 2. Promote DRAFT -> PENDING_APPROVAL
  const pending = await promoteDraftLimitRequest(db, draft.request_id, 'analyst_1');
  assert.equal(pending.status, 'PENDING_APPROVAL');

  // 3. Enforce separation of duties (requester cannot approve own request)
  await assert.rejects(
    () => decideCanonicalLimitRequest(db, draft.request_id, {
      decision: 'APPROVED',
      reason: 'Self approval attempt',
      approverId: 'analyst_1'
    }),
    /Separation of duties violation/
  );

  // 4. Approve by finance_head_1
  const approved = await decideCanonicalLimitRequest(db, draft.request_id, {
    decision: 'APPROVED',
    reason: 'Approved based on strong A risk class and confirmed order backlog.',
    approverId: 'finance_head_1',
    autoSyncToSap: false,
    referenceDate: '2026-11-09'
  });

  assert.equal(approved.request.status, 'APPROVED');
  assert.equal(approved.request.approved_by, 'finance_head_1');
  assert.ok(approved.updatedSnapshot);
  assert.equal(Number(approved.updatedSnapshot.credit_limit), 1500000);
  assert.equal(Number(approved.updatedSnapshot.utilization_pct), 80);
  assert.equal(approved.updatedSnapshot.threshold_status, 'WARNING');

  // 5. Sync approved limit request to SAP S/4HANA (UKMBP_CMS_SGM)
  const synced = await syncApprovedLimitRequestToSap(db, draft.request_id, {
    connectorType: 'MOCK_SAP'
  });
  assert.equal(synced.request.status, 'SYNCED_TO_SAP');
  assert.equal(synced.sapSync.sapReference.table, 'UKMBP_CMS_SGM');
  assert.equal(synced.sapSync.sapReference.verified, false);
  assert.equal(synced.sapSync.sapReference.verificationNote, SAP_VERIFICATION_NOTE);

  // Verify Business Partner dossier reflects the new credit limit
  const dossier = await getBusinessPartnerCreditDossier(db, 'C001', { referenceDate: '2026-11-09' });
  assert.equal(Number(dossier.creditSegment.credit_limit), 1500000);

  // 6. Test Rejection leaves credit limit unchanged
  const rejectReq = await submitCanonicalLimitRequest(db, {
    bpId: 'C002',
    requestedLimit: 1200000,
    justification: 'Expansion request for Desert Star Trading',
    status: 'PENDING_APPROVAL',
    requestedBy: 'analyst_1'
  });
  const rejected = await decideCanonicalLimitRequest(db, rejectReq.request_id, {
    decision: 'REJECTED',
    reason: 'Pending overdue invoice clearance on I004.',
    approverId: 'controller_1'
  });
  assert.equal(rejected.request.status, 'REJECTED');

  const c002Dossier = await getBusinessPartnerCreditDossier(db, 'C002', { referenceDate: '2026-11-09' });
  assert.equal(Number(c002Dossier.creditSegment.credit_limit), 800000);

  const enrichedList = await listEnrichedCanonicalLimitRequests(db);
  assert.ok(enrichedList.length >= 2);
});
