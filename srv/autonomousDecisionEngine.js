const cds = require('@sap/cds');
const { SAP_VERIFICATION_NOTE } = require('./canonicalSchemaMetadata');
const { roundCurrency, classifyThresholdStatus } = require('./exposureCalculator');
const { getDatabaseHandle } = require('./hanaConnection');
const {
  getBusinessPartnerCreditDossier,
  listBusinessPartners,
  listCanonicalLimitRequests,
  seedCanonicalFromLegacyDemo
} = require('./canonicalRepository');
const {
  decideCanonicalLimitRequest,
  promoteDraftLimitRequest,
  submitCanonicalLimitRequest
} = require('./limitWorkflowService');
const { routeApprover } = require('./rules');

const DEFAULT_AUTONOMOUS_CREDIT_POLICY = Object.freeze({
  policyId: 'FIN-FSCM-AUTONOMOUS-POLICY-V1',
  version: '1.0.0',
  autoApproveMaxDeltaPct: 15,
  autoApproveMaxDeltaAmount: 150000,
  autoApproveAllowedRiskClasses: ['A', 'B'],
  autoApproveMaxOverdueRatioPct: 5,
  autoApproveMaxCompositeRiskScore: 55,
  autoApproveRequireZero90PlusAgeing: true,
  autoRejectRiskClasses: ['D', 'E'],
  autoRejectMin90PlusOverdueAmount: 50000,
  autoRejectMinOverdueRatioPct: 35,
  autoSyncApprovedToSap: true
});

function resolvePolicy(customPolicy = {}) {
  return {
    ...DEFAULT_AUTONOMOUS_CREDIT_POLICY,
    ...(customPolicy && typeof customPolicy === 'object' ? customPolicy : {})
  };
}

/**
 * Deterministically evaluates a proposed credit limit change for a Business Partner
 * against the active enterprise credit policy.
 * Never uses LLM output for financial math or policy pass/fail rules.
 */
async function evaluateCustomerAutonomousDecision(rawDb, bpId, {
  requestedLimit,
  policy: customPolicy = {},
  referenceDate = '2026-11-09'
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const policy = resolvePolicy(customPolicy);
  const cleanBpId = String(bpId || '').trim();
  if (!cleanBpId) {
    const error = new TypeError('bpId is required for autonomous credit evaluation.');
    error.statusCode = 400;
    throw error;
  }

  const dossier = await getBusinessPartnerCreditDossier(db, cleanBpId, { referenceDate });
  const partner = dossier.partner;
  const snap = dossier.snapshot;
  const diag = dossier.diagnostics || {};

  const currentLimit = roundCurrency(snap.credit_limit || 0);
  const totalExposure = roundCurrency(snap.total_exposure || 0);
  const overdueAmount = roundCurrency(snap.overdue_amount || 0);
  const delinquent30PlusAmount = roundCurrency(
    Number(snap.ageing_31_60 || 0) + Number(snap.ageing_61_90 || 0) + Number(snap.ageing_90_plus || 0)
  );
  const ageing90Plus = roundCurrency(snap.ageing_90_plus || 0);
  const compositeRiskScore = Number(diag.composite_risk_score ?? 0);
  const riskClass = String(diag.risk_class || partner.risk_class || 'B').toUpperCase().trim();
  const isBlocked = Boolean(partner.is_blocked || snap.threshold_status === 'BLOCKED');

  // If no requestedLimit is provided, compute a deterministic recommended target limit
  let targetLimit = Number(requestedLimit);
  if (!Number.isFinite(targetLimit) || targetLimit <= 0) {
    if (totalExposure > currentLimit) {
      // Propose covering exposure plus 10% operating headroom, rounded to nearest 10,000
      targetLimit = Math.ceil((totalExposure * 1.1) / 10000) * 10000;
    } else if (snap.utilization_pct >= 80) {
      // Propose a 10% buffer increase for warning/critical accounts
      targetLimit = Math.ceil((currentLimit * 1.1) / 10000) * 10000;
    } else {
      targetLimit = currentLimit;
    }
  }
  targetLimit = roundCurrency(targetLimit);

  const deltaAmount = roundCurrency(targetLimit - currentLimit);
  const deltaPct = currentLimit > 0
    ? roundCurrency((deltaAmount / currentLimit) * 100)
    : 100;
  const absDeltaPct = Math.abs(deltaPct);
  const absDeltaAmount = Math.abs(deltaAmount);

  // Delinquent overdue ratio measures 31+ days past-due balance relative to exposure
  const overdueRatioPct = totalExposure > 0
    ? roundCurrency((delinquent30PlusAmount / totalExposure) * 100)
    : 0;

  const projectedUtilizationPct = targetLimit > 0
    ? roundCurrency((totalExposure / targetLimit) * 100)
    : (totalExposure > 0 ? 999.99 : 0);

  const projectedThresholdStatus = classifyThresholdStatus({
    utilizationPct: projectedUtilizationPct,
    creditLimit: targetLimit,
    totalExposure,
    creditBlocked: isBlocked
  });

  const requiredHumanAuthority = routeApprover(currentLimit, targetLimit);

  // Deterministic policy checks
  const checks = {
    notBlocked: !isBlocked,
    allowedRiskClassForAutoApprove: policy.autoApproveAllowedRiskClasses.includes(riskClass),
    notAutoRejectRiskClass: !policy.autoRejectRiskClasses.includes(riskClass),
    withinDeltaPctLimit: deltaAmount <= 0 || absDeltaPct <= policy.autoApproveMaxDeltaPct,
    withinDeltaAmountLimit: deltaAmount <= 0 || absDeltaAmount <= policy.autoApproveMaxDeltaAmount,
    withinOverdueRatioLimit: overdueRatioPct <= policy.autoApproveMaxOverdueRatioPct,
    notSevereOverdueRatio: overdueRatioPct < policy.autoRejectMinOverdueRatioPct,
    zero90PlusAgeing: !policy.autoApproveRequireZero90PlusAgeing || ageing90Plus === 0,
    notSevere90PlusAgeing: ageing90Plus < policy.autoRejectMin90PlusOverdueAmount,
    withinCompositeRiskScore: compositeRiskScore <= policy.autoApproveMaxCompositeRiskScore
  };

  let decision = 'ESCALATE_TO_HUMAN';
  let matchedRuleId = 'RULE-ESCALATE-GOVERNANCE';
  const reasons = [];

  // 1. Check Auto-Reject conditions first (strict risk guardrails)
  if (isBlocked && deltaAmount > 0) {
    decision = 'AUTO_REJECT';
    matchedRuleId = 'RULE-REJECT-BLOCKED-BP';
    reasons.push(`Business Partner ${cleanBpId} is currently blocked in credit control.`);
  } else if (!checks.notAutoRejectRiskClass && deltaAmount > 0) {
    decision = 'AUTO_REJECT';
    matchedRuleId = 'RULE-REJECT-HIGH-RISK-CLASS';
    reasons.push(`Risk Class ${riskClass} is ineligible for credit limit increases under policy ${policy.policyId}.`);
  } else if (!checks.notSevere90PlusAgeing && deltaAmount > 0) {
    decision = 'AUTO_REJECT';
    matchedRuleId = 'RULE-REJECT-SEVERE-90PLUS-AR';
    reasons.push(`90+ days overdue balance (${ageing90Plus.toFixed(2)} ${partner.currency}) exceeds maximum tolerance (${policy.autoRejectMin90PlusOverdueAmount.toFixed(2)}).`);
  } else if (!checks.notSevereOverdueRatio && deltaAmount > 0) {
    decision = 'AUTO_REJECT';
    matchedRuleId = 'RULE-REJECT-EXCESSIVE-OVERDUE-RATIO';
    reasons.push(`31+ days delinquent share of exposure (${overdueRatioPct}%) exceeds auto-rejection ceiling (${policy.autoRejectMinOverdueRatioPct}%).`);
  } else if (
    // 2. Check Auto-Approve conditions (all safety and delta guardrails satisfied)
    checks.notBlocked &&
    checks.allowedRiskClassForAutoApprove &&
    checks.withinDeltaPctLimit &&
    checks.withinDeltaAmountLimit &&
    checks.withinOverdueRatioLimit &&
    checks.zero90PlusAgeing &&
    checks.withinCompositeRiskScore
  ) {
    decision = 'AUTO_APPROVE';
    matchedRuleId = 'RULE-AUTO-APPROVE-LOW-RISK';
    reasons.push(
      `All autonomous approval criteria satisfied under ${policy.policyId}: Risk Class ${riskClass}, delta ${deltaPct >= 0 ? '+' : ''}${deltaPct}% (${deltaAmount.toFixed(2)} ${partner.currency}) within ≤${policy.autoApproveMaxDeltaPct}% / ≤${policy.autoApproveMaxDeltaAmount}, 31+d overdue ratio ${overdueRatioPct}% (≤${policy.autoApproveMaxOverdueRatioPct}%), composite risk score ${compositeRiskScore}/100 (≤${policy.autoApproveMaxCompositeRiskScore}).`
    );
  } else {
    // 3. Escalate to Human Authority with detailed diagnostic breakdown
    decision = 'ESCALATE_TO_HUMAN';
    matchedRuleId = 'RULE-ESCALATE-AUTHORITY-THRESHOLD';
    if (!checks.withinDeltaPctLimit) {
      reasons.push(`Limit change percentage (${deltaPct >= 0 ? '+' : ''}${deltaPct}%) exceeds autonomous cap (${policy.autoApproveMaxDeltaPct}%).`);
    }
    if (!checks.withinDeltaAmountLimit) {
      reasons.push(`Limit change amount (${absDeltaAmount.toFixed(2)} ${partner.currency}) exceeds autonomous cap (${policy.autoApproveMaxDeltaAmount.toFixed(2)}).`);
    }
    if (!checks.allowedRiskClassForAutoApprove) {
      reasons.push(`Risk Class ${riskClass} requires human review (autonomous approval limited to ${policy.autoApproveAllowedRiskClasses.join(', ')}).`);
    }
    if (!checks.withinOverdueRatioLimit) {
      reasons.push(`31+d delinquent overdue ratio (${overdueRatioPct}%) exceeds autonomous threshold (${policy.autoApproveMaxOverdueRatioPct}%).`);
    }
    if (!checks.withinCompositeRiskScore) {
      reasons.push(`Composite risk score (${compositeRiskScore}/100) exceeds autonomous threshold (${policy.autoApproveMaxCompositeRiskScore}/100).`);
    }
    if (!checks.zero90PlusAgeing) {
      reasons.push(`Account has ${ageing90Plus.toFixed(2)} ${partner.currency} in 90+ days ageing bucket.`);
    }
    reasons.push(`Routed to human authority: ${requiredHumanAuthority}.`);
  }

  return {
    bp_id: cleanBpId,
    bp_name: partner.bp_name,
    company_code: partner.company_code,
    country_code: partner.country_code,
    credit_segment: snap.credit_segment || 'MAIN',
    currency: partner.currency || 'INR',
    policy_id: policy.policyId,
    decision,
    matched_rule_id: matchedRuleId,
    required_human_authority: decision === 'AUTO_APPROVE' ? 'Autonomous Policy Agent' : requiredHumanAuthority,
    explanation: reasons.join(' '),
    reasons,
    evidence: {
      current_limit: currentLimit,
      requested_limit: targetLimit,
      delta_amount: deltaAmount,
      delta_pct: deltaPct,
      total_exposure: totalExposure,
      current_utilization_pct: roundCurrency(snap.utilization_pct || 0),
      projected_utilization_pct: projectedUtilizationPct,
      current_threshold_status: snap.threshold_status,
      projected_threshold_status: projectedThresholdStatus,
      overdue_amount: overdueAmount,
      overdue_ratio_pct: overdueRatioPct,
      ageing_90_plus: ageing90Plus,
      risk_class: riskClass,
      composite_risk_score: compositeRiskScore
    },
    checks,
    sap_reference: {
      table: 'UKMBP_CMS_SGM',
      field: 'CREDIT_LIMIT',
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    },
    evaluated_at: new Date().toISOString()
  };
}

/**
 * Processes all DRAFT and PENDING_APPROVAL limit requests in the queue using the
 * deterministic autonomous credit decision policy.
 * - AUTO_APPROVE -> approves and optionally syncs to SAP
 * - AUTO_REJECT -> rejects with policy audit reason
 * - ESCALATE_TO_HUMAN -> promotes DRAFT to PENDING_APPROVAL and retains for human approver
 */
async function processPendingRequestsAutonomously(rawDb, {
  policy: customPolicy = {},
  referenceDate = '2026-11-09',
  autoSyncToSap
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const policy = resolvePolicy(customPolicy);
  const shouldSyncSap = autoSyncToSap !== undefined ? Boolean(autoSyncToSap) : policy.autoSyncApprovedToSap;

  let allRequests = await listCanonicalLimitRequests(db);
  if (!allRequests.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    allRequests = await listCanonicalLimitRequests(db);
  }

  const actionable = allRequests.filter(r =>
    r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL'
  );

  const outcomes = [];
  let autoApprovedCount = 0;
  let autoRejectedCount = 0;
  let escalatedCount = 0;

  for (const reqRecord of actionable) {
    const evaluation = await evaluateCustomerAutonomousDecision(db, reqRecord.bp_id, {
      requestedLimit: Number(reqRecord.requested_limit),
      policy,
      referenceDate
    });

    if (evaluation.decision === 'AUTO_APPROVE') {
      if (reqRecord.status === 'DRAFT') {
        await promoteDraftLimitRequest(db, reqRecord.request_id, reqRecord.requested_by || 'analyst');
      }
      const auditReason = `[${evaluation.policy_id} · ${evaluation.matched_rule_id}] ${evaluation.explanation}`.slice(0, 500);
      const decided = await decideCanonicalLimitRequest(db, reqRecord.request_id, {
        decision: 'APPROVED',
        reason: auditReason,
        approverId: 'AUTONOMOUS_POLICY_AGENT',
        autoSyncToSap: shouldSyncSap,
        referenceDate
      });
      autoApprovedCount++;
      outcomes.push({
        request_id: reqRecord.request_id,
        bp_id: reqRecord.bp_id,
        bp_name: evaluation.bp_name,
        action_taken: 'AUTO_APPROVED',
        final_status: decided.request.status,
        evaluation
      });
    } else if (evaluation.decision === 'AUTO_REJECT') {
      if (reqRecord.status === 'DRAFT') {
        await promoteDraftLimitRequest(db, reqRecord.request_id, reqRecord.requested_by || 'analyst');
      }
      const auditReason = `[${evaluation.policy_id} · ${evaluation.matched_rule_id}] ${evaluation.explanation}`.slice(0, 500);
      const decided = await decideCanonicalLimitRequest(db, reqRecord.request_id, {
        decision: 'REJECTED',
        reason: auditReason,
        approverId: 'AUTONOMOUS_POLICY_AGENT',
        autoSyncToSap: false,
        referenceDate
      });
      autoRejectedCount++;
      outcomes.push({
        request_id: reqRecord.request_id,
        bp_id: reqRecord.bp_id,
        bp_name: evaluation.bp_name,
        action_taken: 'AUTO_REJECTED',
        final_status: decided.request.status,
        evaluation
      });
    } else {
      // ESCALATE_TO_HUMAN: ensure DRAFT is promoted to PENDING_APPROVAL for human controller/finance head
      let currentStatus = reqRecord.status;
      if (reqRecord.status === 'DRAFT') {
        const promoted = await promoteDraftLimitRequest(db, reqRecord.request_id, reqRecord.requested_by || 'analyst');
        currentStatus = promoted.status;
      }
      escalatedCount++;
      outcomes.push({
        request_id: reqRecord.request_id,
        bp_id: reqRecord.bp_id,
        bp_name: evaluation.bp_name,
        action_taken: 'ESCALATED_TO_HUMAN',
        final_status: currentStatus,
        required_authority: evaluation.required_human_authority,
        evaluation
      });
    }
  }

  return {
    policy_id: policy.policyId,
    evaluated_count: actionable.length,
    auto_approved_count: autoApprovedCount,
    auto_rejected_count: autoRejectedCount,
    escalated_to_human_count: escalatedCount,
    outcomes,
    executed_at: new Date().toISOString()
  };
}

/**
 * Scans the entire Business Partner portfolio, identifies accounts requiring credit
 * limit adjustments or risk intervention, evaluates each against the autonomous policy,
 * and optionally creates and executes governed limit workflows.
 */
async function evaluatePortfolioAutonomousActions(rawDb, {
  policy: customPolicy = {},
  referenceDate = '2026-11-09',
  autoCreateAndExecute = false
} = {}) {
  const db = getDatabaseHandle(rawDb);
  const policy = resolvePolicy(customPolicy);

  let partners = await listBusinessPartners(db);
  if (!partners.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    partners = await listBusinessPartners(db);
  }

  const recommendations = [];
  for (const partner of partners) {
    const dossier = await getBusinessPartnerCreditDossier(db, partner.bp_id, { referenceDate });
    const snap = dossier.snapshot;
    const util = Number(snap.utilization_pct || 0);
    const overdue = Number(snap.overdue_amount || 0);

    // Only flag accounts that have elevated utilization (>=80%) or overdue balances
    if (util < 80 && overdue === 0) continue;

    // Propose a pragmatic 10% increase for high-utilization accounts with clean overdue,
    // or a full exposure-covering limit for breached accounts
    let proposedLimit = Number(snap.credit_limit);
    if (util >= 80 && util <= 105 && overdue === 0) {
      proposedLimit = roundCurrency(Number(snap.credit_limit) * 1.1); // +10% buffer
    } else if (util > 105) {
      proposedLimit = Math.ceil((Number(snap.total_exposure) * 1.1) / 10000) * 10000;
    }

    const evaluation = await evaluateCustomerAutonomousDecision(db, partner.bp_id, {
      requestedLimit: proposedLimit,
      policy,
      referenceDate
    });

    let workflowOutcome = null;
    if (autoCreateAndExecute && proposedLimit > Number(snap.credit_limit)) {
      const existingReqs = await listCanonicalLimitRequests(db, { bpId: partner.bp_id });
      const hasOpen = existingReqs.some(r =>
        r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL'
      );
      if (!hasOpen) {
        const created = await submitCanonicalLimitRequest(db, {
          bpId: partner.bp_id,
          creditSegment: snap.credit_segment || 'MAIN',
          requestedLimit: proposedLimit,
          justification: `Autonomous proactive evaluation (${policy.policyId}): ${evaluation.explanation}`,
          requestedBy: 'AUTONOMOUS_MONITOR',
          asDraft: false,
          referenceDate
        });
        if (evaluation.decision === 'AUTO_APPROVE') {
          const decided = await decideCanonicalLimitRequest(db, created.request_id, {
            decision: 'APPROVED',
            reason: `[${evaluation.policy_id} · ${evaluation.matched_rule_id}] ${evaluation.explanation}`.slice(0, 500),
            approverId: 'AUTONOMOUS_POLICY_AGENT',
            autoSyncToSap: policy.autoSyncApprovedToSap,
            referenceDate
          });
          workflowOutcome = {
            request_id: created.request_id,
            action: 'CREATED_AND_AUTO_APPROVED',
            status: decided.request.status
          };
        } else {
          workflowOutcome = {
            request_id: created.request_id,
            action: 'CREATED_AND_ESCALATED_TO_HUMAN',
            status: created.status,
            required_authority: evaluation.required_human_authority
          };
        }
      }
    }

    recommendations.push({
      bp_id: partner.bp_id,
      bp_name: partner.bp_name,
      current_limit: Number(snap.credit_limit),
      proposed_limit: proposedLimit,
      current_utilization_pct: util,
      threshold_status: snap.threshold_status,
      decision: evaluation.decision,
      matched_rule_id: evaluation.matched_rule_id,
      required_human_authority: evaluation.required_human_authority,
      explanation: evaluation.explanation,
      workflow_outcome: workflowOutcome
    });
  }

  return {
    policy_id: policy.policyId,
    policy,
    total_partners_scanned: partners.length,
    flagged_partners_count: recommendations.length,
    auto_approvable_count: recommendations.filter(r => r.decision === 'AUTO_APPROVE').length,
    auto_rejectable_count: recommendations.filter(r => r.decision === 'AUTO_REJECT').length,
    human_escalation_count: recommendations.filter(r => r.decision === 'ESCALATE_TO_HUMAN').length,
    recommendations,
    scanned_at: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_AUTONOMOUS_CREDIT_POLICY,
  evaluateCustomerAutonomousDecision,
  evaluatePortfolioAutonomousActions,
  processPendingRequestsAutonomously,
  resolvePolicy
};
