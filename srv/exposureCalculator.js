// ============================================================================
// PHASE 3: DETERMINISTIC FIN-FSCM-CR CREDIT EXPOSURE, AGEING & RISK ENGINE
// Working Rule 4: All financial calculations (exposure, utilization, ageing,
// thresholds, risk scores, rollups) are 100% deterministic code — never LLM output.
// ============================================================================

const THRESHOLD_RULES = Object.freeze({
  WARNING_PCT: 80.0,
  CRITICAL_PCT: 95.0,
  BREACH_PCT: 100.0001 // Strictly > 100% is BREACH; 95%..100% is CRITICAL; 80%..<95% is WARNING
});

function roundCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function daysBetweenDates(earlierDateStr, laterDateStr) {
  if (!earlierDateStr || !laterDateStr) return 0;
  const start = Date.parse(`${String(earlierDateStr).slice(0, 10)}T00:00:00.000Z`);
  const end = Date.parse(`${String(laterDateStr).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

function classifyThresholdStatus({
  utilizationPct,
  creditLimit = 0,
  totalExposure = 0,
  creditBlocked = false
}) {
  if (creditBlocked) return 'BLOCKED';
  const limit = Number(creditLimit) || 0;
  const exposure = Number(totalExposure) || 0;
  if (limit <= 0 && exposure > 0) return 'BLOCKED';
  const pct = Number(utilizationPct) || 0;
  if (pct > 100) return 'BREACH';
  if (pct >= THRESHOLD_RULES.CRITICAL_PCT) return 'CRITICAL';
  if (pct >= THRESHOLD_RULES.WARNING_PCT) return 'WARNING';
  return 'NORMAL';
}

function calculatePaymentBehaviour(payments = []) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return {
      paymentCount: 0,
      totalPaidAmount: 0,
      avgDaysLate: 0,
      onTimePaymentRatePct: 100
    };
  }
  let totalPaidAmount = 0;
  let totalDaysLate = 0;
  let onTimeCount = 0;

  for (const pmt of payments) {
    const amt = roundCurrency(pmt.amount);
    totalPaidAmount += amt;
    const explicitDaysLate = Number(pmt.days_late);
    const computedDaysLate = Number.isFinite(explicitDaysLate) && explicitDaysLate > 0
      ? explicitDaysLate
      : pmt.due_date && pmt.payment_date
        ? Math.max(0, daysBetweenDates(pmt.due_date, pmt.payment_date))
        : 0;
    totalDaysLate += computedDaysLate;
    if (computedDaysLate <= 0) {
      onTimeCount += 1;
    }
  }

  return {
    paymentCount: payments.length,
    totalPaidAmount: roundCurrency(totalPaidAmount),
    avgDaysLate: roundCurrency(totalDaysLate / payments.length),
    onTimePaymentRatePct: roundCurrency((onTimeCount / payments.length) * 100)
  };
}

function calculateCompositeRiskScore({
  utilizationPct = 0,
  totalExposure = 0,
  overdueAmount = 0,
  ageing61to90 = 0,
  ageing90Plus = 0,
  avgDaysLate = 0,
  riskClass = 'B',
  creditBlocked = false
}) {
  if (creditBlocked) return 100;

  // 1. Utilization component (0..40 points)
  const utilScore = Math.min(40, Math.max(0, (Number(utilizationPct) / 120) * 40));

  // 2. Overdue share component (0..35 points)
  const exposure = Number(totalExposure) || 0;
  const overdueRatio = exposure > 0 ? Math.min(1, (Number(overdueAmount) || 0) / exposure) : 0;
  const overdueScore = overdueRatio * 35;

  // 3. Severe ageing 61+ days component (0..15 points)
  const severeOverdue = (Number(ageing61to90) || 0) + (Number(ageing90Plus) || 0);
  const severeRatio = exposure > 0 ? Math.min(1, severeOverdue / exposure) : 0;
  const ageingScore = severeRatio * 15;

  // 4. Risk class & payment lateness component (0..10 points)
  const riskClassWeights = { A: 1, B: 4, C: 8, D: 10, E: 10 };
  const classScore = riskClassWeights[String(riskClass || 'B').toUpperCase()] ?? 4;
  const latePenalty = Math.min(4, (Number(avgDaysLate) || 0) / 10);
  const qualitativeScore = Math.min(10, classScore * 0.6 + latePenalty);

  return Math.min(100, Math.round(utilScore + overdueScore + ageingScore + qualitativeScore));
}

function calculatePartnerExposureSnapshot({
  partner,
  segment,
  exposureItems = [],
  openReceivables = [],
  payments = [],
  referenceDate = '2026-11-09'
}) {
  if (!partner || !partner.bp_id) {
    throw new TypeError('partner with bp_id is required for deterministic snapshot calculation.');
  }

  let openOrdersAmount = 0;
  let openDeliveriesAmount = 0;
  let openBillingAmount = 0;
  let openArAmount = 0;

  for (const item of exposureItems) {
    const val = roundCurrency(item.amount_in_segment_currency ?? item.amount);
    if (val <= 0) continue;
    switch (item.exposure_category) {
      case 'OPEN_ORDER':
        openOrdersAmount += val;
        break;
      case 'OPEN_DELIVERY':
        openDeliveriesAmount += val;
        break;
      case 'OPEN_BILLING':
        openBillingAmount += val;
        break;
      case 'OPEN_INVOICE':
      default:
        openArAmount += val;
        break;
    }
  }

  let overdueAmount = 0;
  let overdueCount = 0;
  let currentNotDueAmount = 0;
  let ageing0to30 = 0;
  let ageing31to60 = 0;
  let ageing61to90 = 0;
  let ageing90Plus = 0;
  let disputedAmount = 0;
  let maxDunningLevel = 0;

  // Calculate overdue & ageing from openReceivables if present, or fallback to OPEN_INVOICE exposureItems
  const receivableSource = openReceivables.length > 0
    ? openReceivables
    : exposureItems
        .filter(item => item.exposure_category === 'OPEN_INVOICE')
        .map(item => ({
          receivable_id: item.item_id,
          bp_id: item.bp_id,
          due_date: item.due_date,
          amount_local_curr: item.amount_in_segment_currency ?? item.amount,
          amount_doc_curr: item.amount,
          clearing_status: 'OPEN',
          dunning_level: item.is_overdue ? 1 : 0,
          dispute_flag: false
        }));

  for (const rec of receivableSource) {
    if (rec.clearing_status && rec.clearing_status !== 'OPEN' && rec.clearing_status !== 'PARTIAL') {
      continue;
    }
    const amt = roundCurrency(rec.amount_local_curr ?? rec.amount_doc_curr);
    if (amt <= 0) continue;

    if (rec.dispute_flag) {
      disputedAmount += amt;
    }
    if (Number(rec.dunning_level) > maxDunningLevel) {
      maxDunningLevel = Number(rec.dunning_level);
    }

    const daysDiff = rec.due_date ? daysBetweenDates(rec.due_date, referenceDate) : 0;
    if (daysDiff > 0) {
      overdueAmount += amt;
      overdueCount += 1;
      if (daysDiff <= 30) {
        ageing0to30 += amt;
      } else if (daysDiff <= 60) {
        ageing31to60 += amt;
      } else if (daysDiff <= 90) {
        ageing61to90 += amt;
      } else {
        ageing90Plus += amt;
      }
    } else {
      currentNotDueAmount += amt;
      // Include current open AR in 0-30 bucket only if no overdue items exist?
      // Standard AR ageing bucket 0-30 tracks 1..30 days past due (or 0..30 days due); we track both current_not_due and 0..30 cleanly:
      ageing0to30 += amt;
    }
  }

  // If openArAmount was not populated via exposureItems, derive from openReceivables
  if (openArAmount === 0 && openReceivables.length > 0) {
    openArAmount = roundCurrency(
      openReceivables
        .filter(r => !r.clearing_status || r.clearing_status === 'OPEN' || r.clearing_status === 'PARTIAL')
        .reduce((sum, r) => sum + roundCurrency(r.amount_local_curr ?? r.amount_doc_curr), 0)
    );
  }

  const creditLimit = roundCurrency(segment?.credit_limit ?? 0);
  const totalExposure = roundCurrency(
    openOrdersAmount + openDeliveriesAmount + openBillingAmount + openArAmount
  );
  const availableCredit = roundCurrency(creditLimit - totalExposure);
  const utilizationPct = creditLimit > 0
    ? roundCurrency((totalExposure / creditLimit) * 100)
    : totalExposure > 0
      ? 999.99
      : 0;
  const creditBlocked = Boolean(segment?.credit_blocked === true);
  const thresholdStatus = classifyThresholdStatus({
    utilizationPct,
    creditLimit,
    totalExposure,
    creditBlocked
  });

  const paymentBehaviour = calculatePaymentBehaviour(payments);
  const compositeRiskScore = calculateCompositeRiskScore({
    utilizationPct,
    totalExposure,
    overdueAmount,
    ageing61to90,
    ageing90Plus,
    avgDaysLate: paymentBehaviour.avgDaysLate,
    riskClass: segment?.risk_class || partner.risk_class || 'B',
    creditBlocked
  });

  const creditSegmentCode = segment?.credit_segment || partner.credit_segment || 'MAIN';

  return {
    snapshot_id: `${partner.bp_id}:${creditSegmentCode}`,
    bp_id: partner.bp_id,
    credit_segment: creditSegmentCode,
    company_code: partner.company_code || '1000',
    country_code: partner.country_code || 'India',
    credit_limit: creditLimit,
    open_orders_amount: roundCurrency(openOrdersAmount),
    open_deliveries_amount: roundCurrency(openDeliveriesAmount),
    open_billing_amount: roundCurrency(openBillingAmount),
    open_ar_amount: roundCurrency(openArAmount),
    total_exposure: totalExposure,
    available_credit: availableCredit,
    utilization_pct: utilizationPct,
    overdue_amount: roundCurrency(overdueAmount),
    overdue_count: overdueCount,
    ageing_0_30: roundCurrency(ageing0to30),
    ageing_31_60: roundCurrency(ageing31to60),
    ageing_61_90: roundCurrency(ageing61to90),
    ageing_90_plus: roundCurrency(ageing90Plus),
    threshold_status: thresholdStatus,
    calculated_at: new Date().toISOString(),
    source_id: partner.source_id || 'LOCAL-CANONICAL',
    // Extended deterministic analytics (not LLM-generated)
    diagnostics: {
      bp_name: partner.bp_name || partner.bp_id,
      risk_class: segment?.risk_class || partner.risk_class || 'B',
      currency: segment?.currency || partner.currency || 'INR',
      credit_blocked: creditBlocked,
      block_reason: segment?.block_reason || null,
      last_review_date: segment?.last_review_date || null,
      current_not_due_amount: roundCurrency(currentNotDueAmount),
      disputed_amount: roundCurrency(disputedAmount),
      max_dunning_level: maxDunningLevel,
      composite_risk_score: compositeRiskScore,
      payment_behaviour: paymentBehaviour
    }
  };
}

function buildDimensionRollup(snapshots = [], groupKeySelector, labelKey) {
  const groups = new Map();

  for (const snap of snapshots) {
    const key = String(groupKeySelector(snap) || 'UNASSIGNED');
    if (!groups.has(key)) {
      groups.set(key, {
        [labelKey]: key,
        customerCount: 0,
        totalCreditLimit: 0,
        totalExposure: 0,
        availableCredit: 0,
        openOrdersAmount: 0,
        openDeliveriesAmount: 0,
        openBillingAmount: 0,
        openArAmount: 0,
        overdueAmount: 0,
        overdueCount: 0,
        warningCount: 0,
        criticalCount: 0,
        breachCount: 0,
        blockedCount: 0
      });
    }
    const bucket = groups.get(key);
    bucket.customerCount += 1;
    bucket.totalCreditLimit = roundCurrency(bucket.totalCreditLimit + Number(snap.credit_limit || 0));
    bucket.totalExposure = roundCurrency(bucket.totalExposure + Number(snap.total_exposure || 0));
    bucket.availableCredit = roundCurrency(bucket.availableCredit + Number(snap.available_credit || 0));
    bucket.openOrdersAmount = roundCurrency(bucket.openOrdersAmount + Number(snap.open_orders_amount || 0));
    bucket.openDeliveriesAmount = roundCurrency(bucket.openDeliveriesAmount + Number(snap.open_deliveries_amount || 0));
    bucket.openBillingAmount = roundCurrency(bucket.openBillingAmount + Number(snap.open_billing_amount || 0));
    bucket.openArAmount = roundCurrency(bucket.openArAmount + Number(snap.open_ar_amount || 0));
    bucket.overdueAmount = roundCurrency(bucket.overdueAmount + Number(snap.overdue_amount || 0));
    bucket.overdueCount += Number(snap.overdue_count || 0);

    if (snap.threshold_status === 'WARNING') bucket.warningCount += 1;
    else if (snap.threshold_status === 'CRITICAL') bucket.criticalCount += 1;
    else if (snap.threshold_status === 'BREACH') bucket.breachCount += 1;
    else if (snap.threshold_status === 'BLOCKED') bucket.blockedCount += 1;
  }

  return [...groups.values()]
    .map(b => ({
      ...b,
      utilizationPct: b.totalCreditLimit > 0
        ? roundCurrency((b.totalExposure / b.totalCreditLimit) * 100)
        : 0
    }))
    .sort((a, b) => b.totalExposure - a.totalExposure);
}

function calculatePortfolioRollups(snapshots = []) {
  let totalCreditLimit = 0;
  let totalExposure = 0;
  let totalAvailableCredit = 0;
  let openOrdersAmount = 0;
  let openDeliveriesAmount = 0;
  let openBillingAmount = 0;
  let openArAmount = 0;
  let totalOverdueAmount = 0;
  let totalOverdueCount = 0;
  let customersWithOverdue = 0;
  let ageing0to30 = 0;
  let ageing31to60 = 0;
  let ageing61to90 = 0;
  let ageing90Plus = 0;

  const statusCounts = {
    NORMAL: 0,
    WARNING: 0,
    CRITICAL: 0,
    BREACH: 0,
    BLOCKED: 0
  };

  for (const snap of snapshots) {
    totalCreditLimit += Number(snap.credit_limit || 0);
    totalExposure += Number(snap.total_exposure || 0);
    totalAvailableCredit += Number(snap.available_credit || 0);
    openOrdersAmount += Number(snap.open_orders_amount || 0);
    openDeliveriesAmount += Number(snap.open_deliveries_amount || 0);
    openBillingAmount += Number(snap.open_billing_amount || 0);
    openArAmount += Number(snap.open_ar_amount || 0);
    totalOverdueAmount += Number(snap.overdue_amount || 0);
    totalOverdueCount += Number(snap.overdue_count || 0);
    if (Number(snap.overdue_amount || 0) > 0) {
      customersWithOverdue += 1;
    }
    ageing0to30 += Number(snap.ageing_0_30 || 0);
    ageing31to60 += Number(snap.ageing_31_60 || 0);
    ageing61to90 += Number(snap.ageing_61_90 || 0);
    ageing90Plus += Number(snap.ageing_90_plus || 0);

    const status = snap.threshold_status || 'NORMAL';
    if (Object.hasOwn(statusCounts, status)) {
      statusCounts[status] += 1;
    }
  }

  const roundedLimit = roundCurrency(totalCreditLimit);
  const roundedExposure = roundCurrency(totalExposure);
  const overallUtilizationPct = roundedLimit > 0
    ? roundCurrency((roundedExposure / roundedLimit) * 100)
    : 0;

  return {
    summary: {
      customersMonitored: snapshots.length,
      totalCreditLimit: roundedLimit,
      totalExposure: roundedExposure,
      totalAvailableCredit: roundCurrency(totalAvailableCredit),
      overallUtilizationPct,
      totalOverdueAmount: roundCurrency(totalOverdueAmount),
      totalOverdueCount,
      customersWithOverdue,
      statusCounts,
      atRiskCustomerCount:
        statusCounts.WARNING + statusCounts.CRITICAL + statusCounts.BREACH + statusCounts.BLOCKED
    },
    exposureComposition: {
      openOrdersAmount: roundCurrency(openOrdersAmount),
      openDeliveriesAmount: roundCurrency(openDeliveriesAmount),
      openBillingAmount: roundCurrency(openBillingAmount),
      openArAmount: roundCurrency(openArAmount),
      totalExposure: roundedExposure
    },
    ageingBreakdown: {
      ageing_0_30: roundCurrency(ageing0to30),
      ageing_31_60: roundCurrency(ageing31to60),
      ageing_61_90: roundCurrency(ageing61to90),
      ageing_90_plus: roundCurrency(ageing90Plus),
      totalOverdueAmount: roundCurrency(totalOverdueAmount)
    },
    byCountry: buildDimensionRollup(snapshots, s => s.country_code, 'countryCode'),
    byCompanyCode: buildDimensionRollup(snapshots, s => s.company_code, 'companyCode'),
    byCreditSegment: buildDimensionRollup(snapshots, s => s.credit_segment, 'creditSegment'),
    byRiskClass: buildDimensionRollup(
      snapshots,
      s => s.diagnostics?.risk_class || s.risk_class || 'B',
      'riskClass'
    )
  };
}

module.exports = {
  THRESHOLD_RULES,
  calculateCompositeRiskScore,
  calculatePartnerExposureSnapshot,
  calculatePaymentBehaviour,
  calculatePortfolioRollups,
  classifyThresholdStatus,
  daysBetweenDates,
  roundCurrency
};
