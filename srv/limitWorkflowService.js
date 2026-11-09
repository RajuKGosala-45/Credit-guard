const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const { routeApprover } = require('./rules');
const { createLimitRequestId } = require('./limitRequests');
const { SAP_VERIFICATION_NOTE } = require('./canonicalSchemaMetadata');
const {
  classifyThresholdStatus,
  roundCurrency
} = require('./exposureCalculator');
const { getDatabaseHandle } = require('./hanaConnection');
const {
  getBusinessPartnerCreditDossier,
  listBusinessPartners,
  listCanonicalLimitRequests,
  recalculateAllExposureSnapshots,
  seedCanonicalFromLegacyDemo,
  upsertCanonicalLimitRequest,
  upsertCreditSegment
} = require('./canonicalRepository');
const { getConnectorForType } = require('./connectors/connectorRegistry');

function buildDeterministicRiskSummary({
  partner,
  snapshot,
  currentLimit,
  requestedLimit,
  projectedUtilizationPct,
  projectedThresholdStatus,
  approverLevel
}) {
  const delta = roundCurrency(requestedLimit - currentLimit);
  const direction = delta >= 0 ? 'increase' : 'decrease';
  const deltaPct = currentLimit > 0
    ? roundCurrency((Math.abs(delta) / currentLimit) * 100)
    : 100;
  return [
    `Deterministic FIN-FSCM-CR Impact Assessment for ${partner.bp_name} (${partner.bp_id}, Segment ${snapshot.credit_segment}):`,
    `• Proposed ${direction}: ${currentLimit.toFixed(2)} ${partner.currency} → ${requestedLimit.toFixed(2)} ${partner.currency} (${delta >= 0 ? '+' : '-'}${deltaPct}%).`,
    `• Current Total Exposure: ${Number(snapshot.total_exposure).toFixed(2)} ${partner.currency} (Open Orders: ${Number(snapshot.open_orders_amount).toFixed(2)}, Open AR: ${Number(snapshot.open_ar_amount).toFixed(2)}, Overdue: ${Number(snapshot.overdue_amount).toFixed(2)}).`,
    `• Utilization Impact: ${Number(snapshot.utilization_pct).toFixed(2)}% (${snapshot.threshold_status}) → ${projectedUtilizationPct.toFixed(2)}% (${projectedThresholdStatus}).`,
    `• Composite Risk Score: ${snapshot.diagnostics?.composite_risk_score ?? 'N/A'}/100 | Required Authority: ${approverLevel}.`
  ].join('\n');
}

async function previewCanonicalLimitChange(rawDb, {
  bpId,
  creditSegment = 'MAIN',
  requestedLimit,
  referenceDate = '2026-11-09'
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const cleanBpId = String(bpId || '').trim();
  const limitNum = roundCurrency(requestedLimit);
  if (!cleanBpId) {
    const error = new TypeError('bpId is required for limit change preview.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(limitNum) || limitNum <= 0) {
    const error = new TypeError('requestedLimit must be a positive number.');
    error.statusCode = 400;
    throw error;
  }

  const dossier = await getBusinessPartnerCreditDossier(db, cleanBpId, { referenceDate });
  const currentLimit = roundCurrency(dossier.creditSegment.credit_limit);
  const totalExposure = roundCurrency(dossier.snapshot.total_exposure);
  const deltaAmount = roundCurrency(limitNum - currentLimit);
  const deltaPct = currentLimit > 0
    ? roundCurrency((deltaAmount / currentLimit) * 100)
    : 100;
  const projectedAvailableCredit = roundCurrency(limitNum - totalExposure);
  const projectedUtilizationPct = roundCurrency((totalExposure / limitNum) * 100);
  const projectedThresholdStatus = classifyThresholdStatus({
    utilizationPct: projectedUtilizationPct,
    creditLimit: limitNum,
    totalExposure,
    creditBlocked: Boolean(dossier.creditSegment.credit_blocked)
  });
  const approverLevel = routeApprover(currentLimit, limitNum);
  const deterministicRiskSummary = buildDeterministicRiskSummary({
    partner: dossier.partner,
    snapshot: dossier.snapshot,
    currentLimit,
    requestedLimit: limitNum,
    projectedUtilizationPct,
    projectedThresholdStatus,
    approverLevel
  });

  return {
    bp_id: cleanBpId,
    bp_name: dossier.partner.bp_name,
    company_code: dossier.partner.company_code,
    country_code: dossier.partner.country_code,
    credit_segment: creditSegment || dossier.creditSegment.credit_segment || 'MAIN',
    currency: dossier.partner.currency || 'INR',
    current_limit: currentLimit,
    requested_limit: limitNum,
    delta_amount: deltaAmount,
    delta_pct: deltaPct,
    total_exposure: totalExposure,
    current_available_credit: roundCurrency(dossier.snapshot.available_credit),
    projected_available_credit: projectedAvailableCredit,
    current_utilization_pct: roundCurrency(dossier.snapshot.utilization_pct),
    projected_utilization_pct: projectedUtilizationPct,
    current_threshold_status: dossier.snapshot.threshold_status,
    projected_threshold_status: projectedThresholdStatus,
    approver_level: approverLevel,
    composite_risk_score: dossier.diagnostics?.composite_risk_score ?? 0,
    deterministic_risk_summary: deterministicRiskSummary,
    sap_target: {
      table: 'UKMBP_CMS_SGM',
      field: 'CREDIT_LIMIT',
      odataService: 'API_CREDITMANAGEMENTACCOUNT_SRV',
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    }
  };
}

async function submitCanonicalLimitRequest(rawDb, {
  bpId,
  creditSegment = 'MAIN',
  requestedLimit,
  justification,
  aiRiskSummary = null,
  status = 'PENDING_APPROVAL',
  requestedBy = 'analyst',
  referenceDate = '2026-11-09'
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const cleanJustification = String(justification || '').trim();
  if (!cleanJustification || cleanJustification.length > 1000) {
    const error = new TypeError('Provide a justification between 1 and 1000 characters.');
    error.statusCode = 400;
    throw error;
  }
  const normalizedStatus = status === 'DRAFT' ? 'DRAFT' : 'PENDING_APPROVAL';
  const preview = await previewCanonicalLimitChange(db, {
    bpId,
    creditSegment,
    requestedLimit,
    referenceDate
  });

  const requestId = createLimitRequestId();
  const nowIso = new Date().toISOString();
  const canonicalRow = await upsertCanonicalLimitRequest(db, {
    request_id: requestId,
    bp_id: preview.bp_id,
    credit_segment: preview.credit_segment,
    company_code: preview.company_code,
    current_limit: preview.current_limit,
    requested_limit: preview.requested_limit,
    currency: preview.currency,
    justification: cleanJustification,
    ai_risk_summary: aiRiskSummary || preview.deterministic_risk_summary,
    status: normalizedStatus,
    requested_by: requestedBy,
    approved_by: null,
    sap_sync_status: 'NOT_SYNCED',
    created_at: nowIso,
    decided_at: null
  });

  // Mirror to legacy credit.LimitRequests table when submitted as PENDING_APPROVAL so legacy views remain synchronized
  if (normalizedStatus === 'PENDING_APPROVAL') {
    const existingLegacy = await db.run(
      SELECT.one.from('credit.LimitRequests').where({ ID: requestId })
    );
    if (!existingLegacy) {
      await db.run(INSERT.into('credit.LimitRequests').entries({
        ID: requestId,
        customer_ID: preview.bp_id,
        currentLimit: preview.current_limit,
        requestedLimit: preview.requested_limit,
        reason: cleanJustification.slice(0, 500),
        requestedBy,
        status: 'Pending',
        approverLevel: preview.approver_level,
        createdAt: nowIso
      }));
    }
  }

  return {
    ...canonicalRow,
    bp_name: preview.bp_name,
    approver_level: preview.approver_level,
    preview
  };
}

async function promoteDraftLimitRequest(rawDb, requestId, actorId = 'analyst') {
  const db = getDatabaseHandle(rawDb);
  const existing = (await listCanonicalLimitRequests(db)).find(r => r.request_id === requestId);
  if (!existing) {
    const error = new Error(`Limit request ${requestId} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  if (existing.status !== 'DRAFT') {
    const error = new Error(`Only DRAFT requests can be submitted for approval (current status: ${existing.status}).`);
    error.statusCode = 409;
    throw error;
  }
  const approverLevel = routeApprover(Number(existing.current_limit), Number(existing.requested_limit));
  const updated = await upsertCanonicalLimitRequest(db, {
    ...existing,
    status: 'PENDING_APPROVAL',
    requested_by: existing.requested_by || actorId
  });

  const existingLegacy = await db.run(
    SELECT.one.from('credit.LimitRequests').where({ ID: requestId })
  );
  if (!existingLegacy) {
    await db.run(INSERT.into('credit.LimitRequests').entries({
      ID: requestId,
      customer_ID: existing.bp_id,
      currentLimit: existing.current_limit,
      requestedLimit: existing.requested_limit,
      reason: String(existing.justification || '').slice(0, 500),
      requestedBy: existing.requested_by || actorId,
      status: 'Pending',
      approverLevel,
      createdAt: existing.created_at
    }));
  }

  return {
    ...updated,
    approver_level: approverLevel
  };
}

async function syncApprovedLimitRequestToSap(rawDb, requestId, { connectorType = 'MOCK_SAP' } = {}) {
  const db = getDatabaseHandle(rawDb);
  const existing = (await listCanonicalLimitRequests(db)).find(r => r.request_id === requestId);
  if (!existing) {
    const error = new Error(`Limit request ${requestId} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  if (existing.status !== 'APPROVED' && existing.status !== 'SYNCED_TO_SAP') {
    const error = new Error(`Only APPROVED limit requests can be synced to SAP (current status: ${existing.status}).`);
    error.statusCode = 409;
    throw error;
  }

  const connector = getConnectorForType(connectorType);
  const syncResult = typeof connector.pushCreditLimitChange === 'function'
    ? await connector.pushCreditLimitChange({}, existing)
    : {
        synced: true,
        status: 'SIMULATED_SAP_UKMBP_CMS_SGM',
        mode: connectorType,
        externalReference: `UKM-${requestId}`,
        sapReference: {
          table: 'UKMBP_CMS_SGM',
          field: 'CREDIT_LIMIT',
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      };

  const updated = await upsertCanonicalLimitRequest(db, {
    ...existing,
    status: 'SYNCED_TO_SAP',
    sap_sync_status: `${syncResult.status}:${syncResult.externalReference}`
  });

  return {
    request: updated,
    sapSync: syncResult
  };
}

async function decideCanonicalLimitRequest(rawDb, requestId, {
  decision,
  reason,
  approverId = 'controller',
  autoSyncToSap = false,
  referenceDate = '2026-11-09'
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const normalizedDecision = String(decision || '').toUpperCase().trim();
  const targetStatus = normalizedDecision === 'APPROVED' || normalizedDecision === 'APPROVE'
    ? 'APPROVED'
    : normalizedDecision === 'REJECTED' || normalizedDecision === 'REJECT'
      ? 'REJECTED'
      : null;

  if (!targetStatus) {
    const error = new TypeError('decision must be APPROVED or REJECTED.');
    error.statusCode = 400;
    throw error;
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    const error = new TypeError('Provide a decision reason between 1 and 500 characters.');
    error.statusCode = 400;
    throw error;
  }

  let requests = await listCanonicalLimitRequests(db);
  if (!requests.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    requests = await listCanonicalLimitRequests(db);
  }
  const existing = requests.find(r => r.request_id === requestId);
  if (!existing) {
    const error = new Error(`Limit request ${requestId} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  if (existing.status !== 'PENDING_APPROVAL') {
    const error = new Error(`Limit request ${requestId} has already been decided (${existing.status}).`);
    error.statusCode = 409;
    throw error;
  }
  if (existing.requested_by === approverId) {
    const error = new Error('Separation of duties violation: requester cannot approve or reject their own request.');
    error.statusCode = 403;
    throw error;
  }

  const nowIso = new Date().toISOString();
  const updated = await upsertCanonicalLimitRequest(db, {
    ...existing,
    status: targetStatus,
    approved_by: approverId,
    sap_sync_status: targetStatus === 'APPROVED' ? 'READY_FOR_SAP_SYNC' : 'NOT_APPLICABLE',
    decided_at: nowIso
  });

  // Update legacy credit.LimitRequests and credit.ApprovalHistory
  const legacyStatus = targetStatus === 'APPROVED' ? 'Approved' : 'Rejected';
  await db.run(
    UPDATE('credit.LimitRequests')
      .set({ status: legacyStatus, decidedBy: approverId, decidedAt: nowIso })
      .where({ ID: requestId })
  );
  await db.run(INSERT.into('credit.ApprovalHistory').entries({
    ID: randomUUID(),
    request_ID: requestId,
    requester_ID: existing.requested_by,
    approver_ID: approverId,
    previousStatus: 'Pending',
    newStatus: legacyStatus,
    decisionReason: cleanReason,
    timestamp: nowIso
  }));

  let updatedSnapshot = null;
  let sapSync = null;

  if (targetStatus === 'APPROVED') {
    await upsertCreditSegment(db, {
      bp_id: existing.bp_id,
      credit_segment: existing.credit_segment || 'MAIN',
      credit_limit: existing.requested_limit,
      currency: existing.currency || 'INR',
      source_id: 'WORKFLOW-APPROVED',
      updated_at: nowIso
    });
    await db.run(
      UPDATE('credit.Customers')
        .set({ creditLimit: existing.requested_limit })
        .where({ ID: existing.bp_id })
    );
    const snapshots = await recalculateAllExposureSnapshots(db, { referenceDate });
    updatedSnapshot = snapshots.find(s => s.bp_id === existing.bp_id) || null;

    if (autoSyncToSap) {
      const synced = await syncApprovedLimitRequestToSap(db, requestId);
      sapSync = synced.sapSync;
      return {
        request: synced.request,
        updatedSnapshot,
        sapSync
      };
    }
  }

  return {
    request: updated,
    updatedSnapshot,
    sapSync
  };
}

async function listEnrichedCanonicalLimitRequests(rawDb, { status = null, bpId = null } = {}) {
  const db = getDatabaseHandle(rawDb);
  let partners = await listBusinessPartners(db);
  if (!partners.length) {
    await seedCanonicalFromLegacyDemo(db);
    partners = await listBusinessPartners(db);
  }
  const partnerByBp = new Map(partners.map(p => [p.bp_id, p]));
  const rows = await listCanonicalLimitRequests(db, { status, bpId });

  return rows.map(row => {
    const partner = partnerByBp.get(row.bp_id) || {};
    const approverLevel = routeApprover(Number(row.current_limit || 0), Number(row.requested_limit || 0));
    return {
      ...row,
      bp_name: partner.bp_name || row.bp_id,
      country_code: partner.country_code || 'India',
      approver_level: approverLevel,
      sap_reference: {
        table: 'UKMBP_CMS_SGM',
        field: 'CREDIT_LIMIT',
        verified: false,
        verificationNote: SAP_VERIFICATION_NOTE
      }
    };
  });
}

module.exports = {
  buildDeterministicRiskSummary,
  decideCanonicalLimitRequest,
  listEnrichedCanonicalLimitRequests,
  previewCanonicalLimitChange,
  promoteDraftLimitRequest,
  submitCanonicalLimitRequest,
  syncApprovedLimitRequestToSap
};
