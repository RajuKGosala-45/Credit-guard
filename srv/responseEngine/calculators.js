const { CONFIG, routeApprover } = require('../rules');
const { DEFAULT_AUTONOMOUS_CREDIT_POLICY } = require('../autonomousDecisionEngine');

const REFERENCE_DATE = '2026-11-09';

function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function daysBetweenDates(dueDateStr, referenceDateStr = REFERENCE_DATE) {
  if (!dueDateStr || typeof dueDateStr !== 'string') return 0;
  const dueMs = Date.parse(`${dueDateStr.slice(0, 10)}T00:00:00Z`);
  const refMs = Date.parse(`${String(referenceDateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(refMs)) return 0;
  return Math.floor((refMs - dueMs) / (1000 * 60 * 60 * 24));
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatINR(amount, { decimals = 0 } = {}) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    return '—';
  }
  const num = Number(amount);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}₹${abs.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

/**
 * Single shared deterministic utilisation function used by all Response Engine modules.
 * Formula: (exposure / creditLimit) * 100
 * If creditLimit === 0 (or <= 0): returns null utilisation, 'N/A (no limit)', and flags 'No limit set' if exposure > 0.
 */
function calculateUtilisation(exposure, creditLimit) {
  const exp = toFiniteNumber(exposure, 0);
  const limit = toFiniteNumber(creditLimit, 0);
  if (limit <= 0) {
    return {
      utilisationPct: null,
      utilisationRatio: null,
      display: 'N/A (no limit)',
      isNoLimit: true,
      noLimitWithExposure: exp > 0,
      flag: exp > 0 ? 'No limit set' : 'NO_LIMIT'
    };
  }
  const ratio = exp / limit;
  const pct = round2(ratio * 100);
  return {
    utilisationPct: pct,
    utilisationRatio: Math.round(ratio * 10000) / 10000,
    display: `${pct.toFixed(1)}%`,
    isNoLimit: false,
    noLimitWithExposure: false,
    flag: null
  };
}

function classifyCustomerSeverity(customer, utilInfo) {
  const exp = toFiniteNumber(customer.exposure, 0);
  const overdue = toFiniteNumber(customer.overdueAmount, 0);
  const pct = utilInfo.utilisationPct;
  const flags = Array.isArray(customer.flags) ? customer.flags : [];
  const riskClass = String(customer.riskClass || 'B').toUpperCase();
  const reasons = [];

  if (utilInfo.isNoLimit) {
    if (exp > 0) {
      reasons.push(`Exposure of ${formatINR(exp)} held with ₹0 credit limit (No limit set)`);
      return { severity: 'Critical', status: 'BREACH', reasons, recommendedAction: 'Set an authorized credit limit immediately or place account on credit hold.' };
    }
    reasons.push('Credit limit is ₹0 with no active exposure');
    return { severity: 'Low', status: 'NO_LIMIT', reasons, recommendedAction: 'Establish baseline credit limit before order release.' };
  }

  const criticalThresholdPct = (CONFIG.criticalUtilisation || 1.2) * 100;
  const breachThresholdPct = (CONFIG.breachUtilisation || 1.0) * 100;
  const warningThresholdPct = (CONFIG.warningUtilisation || 0.8) * 100;

  if (pct >= criticalThresholdPct) {
    reasons.push(`Utilisation at ${pct.toFixed(1)}% reaches critical threshold (>=${criticalThresholdPct}%)`);
  } else if (pct >= breachThresholdPct) {
    reasons.push(`Utilisation at ${pct.toFixed(1)}% breaches 100% credit limit (${formatINR(exp)} vs ${formatINR(customer.creditLimit)})`);
  } else if (pct >= warningThresholdPct) {
    reasons.push(`Utilisation at ${pct.toFixed(1)}% is in the 80–99% warning zone`);
  }

  if (overdue > 0) {
    const overdueRatio = exp > 0 ? round2((overdue / exp) * 100) : 0;
    reasons.push(`Overdue receivables of ${formatINR(overdue)} (${overdueRatio.toFixed(1)}% of exposure)`);
  }

  if (flags.includes('STALE_REVIEW')) {
    reasons.push(`Last credit review (${customer.lastReviewDate || 'N/A'}) is older than ${CONFIG.staleReviewMonths || 12} months`);
  }

  if (['C', 'D', 'E'].includes(riskClass)) {
    reasons.push(`Assigned elevated risk class ${riskClass}`);
  }

  let severity = 'Low';
  let status = customer.status || 'HEALTHY';

  if (pct >= 120 || (pct >= 100 && overdue > 0)) {
    severity = 'Critical';
    status = 'BREACH';
  } else if (pct >= 100 || (pct >= 80 && overdue >= 200000)) {
    severity = 'High';
    status = pct >= 100 ? 'BREACH' : 'WARNING';
  } else if (pct >= 80 || overdue > 0 || flags.includes('STALE_REVIEW')) {
    severity = 'Medium';
    status = pct >= 80 ? 'WARNING' : (customer.status || 'HEALTHY');
  } else {
    severity = 'Low';
    status = 'HEALTHY';
    if (!reasons.length) {
      reasons.push(`Utilisation at ${pct.toFixed(1)}% is within normal policy (<80%) with no limit breach`);
    }
  }

  const recommendedAction = severity === 'Critical'
    ? 'Hold new order releases, initiate immediate overdue collection, and require Finance Head review.'
    : severity === 'High'
      ? 'Escalate to Credit Controller, collect overdue open items, or evaluate temporary limit adjustment.'
      : severity === 'Medium'
        ? 'Monitor upcoming invoice due dates and follow up on overdue balances before next order cycle.'
        : 'Continue standard periodic monitoring.';

  return { severity, status, reasons, recommendedAction };
}

function normalizeCountry(rawCountry) {
  const raw = String(rawCountry || '').trim();
  if (!raw) return 'Unknown';
  const upper = raw.toUpperCase();
  if (upper === 'IN' || upper === 'IND' || upper === 'INDIA') return 'India';
  if (upper === 'AE' || upper === 'ARE' || upper === 'UAE' || upper === 'UNITED ARAB EMIRATES') return 'UAE';
  if (upper === 'SG' || upper === 'SGP' || upper === 'SINGAPORE') return 'Singapore';
  return raw;
}

function normalizePortfolioCustomers(rawCustomers = [], { specificIds = [] } = {}) {
  if (!Array.isArray(rawCustomers)) return [];
  const requestedSet = new Set((specificIds || []).map(id => String(id).trim().toUpperCase()));
  const hasCanonicalPortfolio = rawCustomers.some(c => /^C\d+$/i.test(String(c?.ID || c?.customer_ID || c?.bpId || '').trim()));
  const seenIds = new Set();
  const normalized = [];

  for (const raw of rawCustomers) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.ID || raw.customer_ID || raw.bpId || '').trim();
    if (!id || seenIds.has(id)) continue;
    if (raw.status && String(raw.status).toUpperCase() === 'INACTIVE') continue;
    // Exclude synthetic simulator-only fixture rows (MS-C*) when canonical C001..C013 portfolio exists, unless explicitly queried
    if (hasCanonicalPortfolio && /^MS-C\d+$/i.test(id) && !requestedSet.has(id.toUpperCase())) {
      continue;
    }
    seenIds.add(id);
    normalized.push({
      ...raw,
      country: normalizeCountry(raw.country || raw.country_code)
    });
  }

  return normalized;
}

function enrichCustomerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const creditLimit = toFiniteNumber(raw.creditLimit ?? raw.limit, 0);
  const exposure = toFiniteNumber(raw.exposure, 0);
  const overdueAmount = toFiniteNumber(raw.overdueAmount, 0);
  const availableCredit = round2(creditLimit - exposure);
  const utilInfo = calculateUtilisation(exposure, creditLimit);

  const baseFlags = Array.isArray(raw.flags) ? [...raw.flags] : [];
  if (utilInfo.isNoLimit) {
    if (utilInfo.noLimitWithExposure && !baseFlags.includes('No limit set')) {
      baseFlags.unshift('No limit set');
    } else if (!baseFlags.includes('NO_LIMIT')) {
      baseFlags.unshift('NO_LIMIT');
    }
  }

  const riskEval = classifyCustomerSeverity({ ...raw, creditLimit, exposure, overdueAmount, flags: baseFlags }, utilInfo);

  return {
    ...raw,
    ID: String(raw.ID || raw.customer_ID || raw.bpId || '').trim(),
    name: String(raw.name || raw.customerName || raw.ID || 'Unknown').trim(),
    country: normalizeCountry(raw.country || raw.country_code || 'Unknown'),
    companyCode: String(raw.companyCode || raw.company_code || '—').trim(),
    riskClass: String(raw.riskClass || 'B').trim(),
    currency: String(raw.currency || 'INR').trim(),
    creditLimit,
    exposure,
    availableCredit,
    overdueAmount,
    overdueInvoiceCount: Number.isInteger(raw.overdueInvoiceCount)
      ? raw.overdueInvoiceCount
      : Array.isArray(raw.openItems)
        ? raw.openItems.filter(item => item.status === 'Overdue' || toFiniteNumber(item.overdueDays, 0) > 0).length
        : (overdueAmount > 0 ? 1 : 0),
    utilisation: utilInfo.utilisationRatio,
    utilisationPct: utilInfo.utilisationPct,
    utilisationDisplay: utilInfo.display,
    isNoLimit: utilInfo.isNoLimit,
    noLimitWithExposure: utilInfo.noLimitWithExposure,
    status: utilInfo.isNoLimit ? (utilInfo.noLimitWithExposure ? 'BREACH' : 'NO_LIMIT') : (raw.status || riskEval.status),
    severity: riskEval.severity,
    riskReasons: riskEval.reasons,
    recommendedAction: riskEval.recommendedAction,
    flags: baseFlags
  };
}

function filterCustomers(rawCustomers = [], filters = {}) {
  const deduplicated = normalizePortfolioCustomers(rawCustomers, { specificIds: filters.customerIds || [] });
  const enriched = deduplicated.map(enrichCustomerRecord).filter(Boolean);
  let list = enriched;

  if (Array.isArray(filters.customerIds) && filters.customerIds.length > 0) {
    const idSet = new Set(filters.customerIds.map(id => String(id).toUpperCase()));
    list = list.filter(c => idSet.has(c.ID.toUpperCase()));
  }

  if (Array.isArray(filters.countries) && filters.countries.length > 0) {
    const countrySet = new Set(filters.countries.map(c => normalizeCountry(c).toLowerCase()));
    list = list.filter(c => countrySet.has(normalizeCountry(c.country).toLowerCase()));
  }

  if (Array.isArray(filters.companyCodes) && filters.companyCodes.length > 0) {
    const codeSet = new Set(filters.companyCodes.map(c => String(c).toUpperCase()));
    list = list.filter(c => codeSet.has(c.companyCode.toUpperCase()));
  }

  if (Array.isArray(filters.riskClasses) && filters.riskClasses.length > 0) {
    const rcSet = new Set(filters.riskClasses.map(r => String(r).toUpperCase()));
    list = list.filter(c => rcSet.has(c.riskClass.toUpperCase()));
  }

  if (filters.status) {
    const targetStatus = String(filters.status).toUpperCase();
    if (targetStatus === 'BREACH') {
      list = list.filter(c => c.status === 'BREACH' || (c.utilisationPct !== null && c.utilisationPct >= 100) || c.noLimitWithExposure);
    } else if (targetStatus === 'WARNING') {
      list = list.filter(c => c.status === 'WARNING' || (c.utilisationPct !== null && c.utilisationPct >= 80 && c.utilisationPct < 100));
    } else if (targetStatus === 'HEALTHY' || targetStatus === 'NORMAL') {
      list = list.filter(c => c.status === 'HEALTHY' && (c.utilisationPct === null || c.utilisationPct < 80));
    }
  }

  if (filters.breachOnly) {
    list = list.filter(c => c.status === 'BREACH' || (c.utilisationPct !== null && c.utilisationPct >= 100) || c.noLimitWithExposure);
  }

  if (filters.warningOrAbove || filters.highUtilisationOnly) {
    const minPct = Number.isFinite(filters.minUtilisationPct) ? filters.minUtilisationPct : 80;
    list = list.filter(c => (c.utilisationPct !== null && c.utilisationPct >= minPct) || c.noLimitWithExposure);
  } else if (Number.isFinite(filters.minUtilisationPct)) {
    list = list.filter(c => c.utilisationPct !== null && c.utilisationPct >= filters.minUtilisationPct);
  }

  if (Number.isFinite(filters.maxUtilisationPct)) {
    list = list.filter(c => c.utilisationPct !== null && c.utilisationPct <= filters.maxUtilisationPct);
  }

  if (filters.overdueOnly) {
    list = list.filter(c => c.overdueAmount > 0);
  }

  if (filters.flaggedOnly) {
    list = list.filter(c => c.flags.length > 0 || c.status !== 'HEALTHY' || c.overdueAmount > 0);
  }

  if (filters.highRiskOnly) {
    list = list.filter(c => ['Critical', 'High', 'Medium'].includes(c.severity));
  }

  const sortBy = filters.sortBy || 'utilisationPct';
  const sortDir = filters.sortDir === 'asc' ? 1 : -1;

  list = [...list].sort((a, b) => {
    if (sortBy === 'ID' || sortBy === 'name') {
      return a[sortBy].localeCompare(b[sortBy]) * (filters.sortDir === 'desc' ? -1 : 1);
    }
    const valA = a[sortBy] === null || a[sortBy] === undefined ? -1 : Number(a[sortBy]);
    const valB = b[sortBy] === null || b[sortBy] === undefined ? -1 : Number(b[sortBy]);
    if (valA !== valB) return (valA - valB) * sortDir;
    return a.ID.localeCompare(b.ID);
  });

  if (Number.isInteger(filters.limit) && filters.limit > 0) {
    list = list.slice(0, filters.limit);
  }

  return list;
}

function computeCohortMetrics(customers = []) {
  const enriched = customers.map(c => (c && c.utilisationDisplay !== undefined ? c : enrichCustomerRecord(c))).filter(Boolean);
  const customerCount = enriched.length;
  const totalCreditLimit = round2(enriched.reduce((sum, c) => sum + c.creditLimit, 0));
  const totalExposure = round2(enriched.reduce((sum, c) => sum + c.exposure, 0));
  const netAvailableCredit = round2(totalCreditLimit - totalExposure);
  const availableCredit = round2(Math.max(0, netAvailableCredit));
  const overdueExposure = round2(enriched.reduce((sum, c) => sum + c.overdueAmount, 0));
  const overdueCustomerCount = enriched.filter(c => c.overdueAmount > 0).length;
  const overdueInvoiceCount = enriched.reduce((sum, c) => sum + toFiniteNumber(c.overdueInvoiceCount, 0), 0);

  const utilInfo = calculateUtilisation(totalExposure, totalCreditLimit);

  const breachCount = enriched.filter(c => c.status === 'BREACH' || (c.utilisationPct !== null && c.utilisationPct >= 100) || c.noLimitWithExposure).length;
  const warningCount = enriched.filter(c => c.status === 'WARNING' || (c.utilisationPct !== null && c.utilisationPct >= 80 && c.utilisationPct < 100)).length;
  const healthyCount = enriched.filter(c => c.status === 'HEALTHY' && (c.utilisationPct === null || c.utilisationPct < 80) && !c.noLimitWithExposure).length;
  const noLimitCount = enriched.filter(c => c.isNoLimit).length;
  const flaggedCount = enriched.filter(c => c.flags.length > 0 || c.status !== 'HEALTHY').length;

  const severityCounts = {
    Critical: enriched.filter(c => c.severity === 'Critical').length,
    High: enriched.filter(c => c.severity === 'High').length,
    Medium: enriched.filter(c => c.severity === 'Medium').length,
    Low: enriched.filter(c => c.severity === 'Low').length
  };

  return {
    customerCount,
    totalCreditLimit,
    totalExposure,
    availableCredit,
    netAvailableCredit,
    overallUtilisationPct: utilInfo.utilisationPct,
    overallUtilisationDisplay: utilInfo.display,
    overdueExposure,
    overdueCustomerCount,
    overdueInvoiceCount,
    breachCount,
    warningCount,
    healthyCount,
    noLimitCount,
    flaggedCount,
    severityCounts
  };
}

function computeDimensionBreakdown(customers = [], dimension = 'country', { sortBy = 'exposure', maxCategories = 12 } = {}) {
  const enriched = customers.map(c => (c && c.utilisationDisplay !== undefined ? c : enrichCustomerRecord(c))).filter(Boolean);
  const totalPortfolioExposure = round2(enriched.reduce((sum, c) => sum + c.exposure, 0));
  const groups = new Map();

  for (const c of enriched) {
    const key = dimension === 'companyCode'
      ? (c.companyCode || 'Unknown')
      : dimension === 'riskClass'
        ? `Risk Class ${c.riskClass || 'B'}`
        : dimension === 'status'
          ? (c.status || 'HEALTHY')
          : dimension === 'severity'
            ? (c.severity || 'Low')
            : dimension === 'customer'
              ? `${c.name} (${c.ID})`
              : (c.country || 'Unknown');

    const current = groups.get(key) || {
      label: key,
      customerId: dimension === 'customer' ? c.ID : null,
      customerCount: 0,
      creditLimit: 0,
      exposure: 0,
      overdueAmount: 0
    };
    current.customerCount += 1;
    current.creditLimit = round2(current.creditLimit + c.creditLimit);
    current.exposure = round2(current.exposure + c.exposure);
    current.overdueAmount = round2(current.overdueAmount + c.overdueAmount);
    groups.set(key, current);
  }

  let items = [...groups.values()].map(item => {
    const util = calculateUtilisation(item.exposure, item.creditLimit);
    const shareOfExposurePct = totalPortfolioExposure > 0
      ? round2((item.exposure / totalPortfolioExposure) * 100)
      : 0;
    return {
      ...item,
      availableCredit: round2(item.creditLimit - item.exposure),
      utilisationPct: util.utilisationPct,
      utilisationDisplay: util.display,
      shareOfExposurePct
    };
  });

  items.sort((a, b) => {
    if (sortBy === 'utilisationPct') {
      return (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1) || b.exposure - a.exposure;
    }
    return b.exposure - a.exposure || (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1);
  });

  if (items.length > maxCategories) {
    const top10 = items.slice(0, 10);
    const rest = items.slice(10);
    const othersLimit = round2(rest.reduce((s, r) => s + r.creditLimit, 0));
    const othersExp = round2(rest.reduce((s, r) => s + r.exposure, 0));
    const othersOverdue = round2(rest.reduce((s, r) => s + r.overdueAmount, 0));
    const othersCount = rest.reduce((s, r) => s + r.customerCount, 0);
    const othersUtil = calculateUtilisation(othersExp, othersLimit);
    const othersShare = totalPortfolioExposure > 0 ? round2((othersExp / totalPortfolioExposure) * 100) : 0;
    items = [
      ...top10,
      {
        label: `Others (${rest.length})`,
        customerId: null,
        customerCount: othersCount,
        creditLimit: othersLimit,
        exposure: othersExp,
        overdueAmount: othersOverdue,
        availableCredit: round2(othersLimit - othersExp),
        utilisationPct: othersUtil.utilisationPct,
        utilisationDisplay: othersUtil.display,
        shareOfExposurePct: othersShare
      }
    ];
  }

  return items;
}

function computeAgeingBuckets(openItems = [], payments = [], referenceDate = REFERENCE_DATE) {
  const buckets = [
    { bucket: '0–30 Days', minDays: 1, maxDays: 30, count: 0, amount: 0, customerIds: new Set() },
    { bucket: '31–60 Days', minDays: 31, maxDays: 60, count: 0, amount: 0, customerIds: new Set() },
    { bucket: '61–90 Days', minDays: 61, maxDays: 90, count: 0, amount: 0, customerIds: new Set() },
    { bucket: '90+ Days', minDays: 91, maxDays: Infinity, count: 0, amount: 0, customerIds: new Set() }
  ];
  let currentNotDueAmount = 0;
  let currentNotDueCount = 0;
  const overdueItems = [];

  for (const item of openItems) {
    if (!item || typeof item !== 'object') continue;
    const status = String(item.status || '').toLowerCase();
    if (status === 'paid' || status === 'cleared') continue;
    const amount = toFiniteNumber(item.amount, 0);
    const custId = String(item.customer_ID || item.customerId || '').trim();
    const dueDate = item.dueDate || item.netDueDate;
    const daysOverdue = Number.isFinite(Number(item.overdueDays))
      ? Number(item.overdueDays)
      : (dueDate ? daysBetweenDates(dueDate, referenceDate) : (status === 'overdue' ? 15 : 0));

    if (daysOverdue > 0 || status === 'overdue') {
      const effectiveDays = Math.max(1, daysOverdue);
      overdueItems.push({
        invoiceId: item.ID || item.invoiceNumber || item.documentNumber || '—',
        customerId: custId,
        customerName: item.customerName || custId,
        amount,
        dueDate: dueDate || '—',
        daysOverdue: effectiveDays,
        status: 'Overdue'
      });
      const matched = buckets.find(b => effectiveDays >= b.minDays && effectiveDays <= b.maxDays) || buckets[buckets.length - 1];
      matched.count += 1;
      matched.amount = round2(matched.amount + amount);
      if (custId) matched.customerIds.add(custId);
    } else {
      currentNotDueCount += 1;
      currentNotDueAmount = round2(currentNotDueAmount + amount);
    }
  }

  let onTimeCount = 0;
  let lateCount = 0;
  let totalDaysLate = 0;
  let totalPaidAmount = 0;

  for (const pay of payments) {
    if (!pay || typeof pay !== 'object') continue;
    const amt = toFiniteNumber(pay.amount, 0);
    totalPaidAmount = round2(totalPaidAmount + amt);
    const daysLate = toFiniteNumber(pay.daysLate, 0);
    const status = String(pay.status || '').toLowerCase();
    if (daysLate > 0 || status === 'late') {
      lateCount += 1;
      totalDaysLate += Math.max(1, daysLate);
    } else {
      onTimeCount += 1;
    }
  }

  const totalPayments = onTimeCount + lateCount;
  const onTimeRatePct = totalPayments > 0 ? round2((onTimeCount / totalPayments) * 100) : null;
  const avgDaysLate = lateCount > 0 ? round2(totalDaysLate / lateCount) : 0;
  const totalOverdueAmount = round2(buckets.reduce((sum, b) => sum + b.amount, 0));

  return {
    buckets: buckets.map(b => ({
      bucket: b.bucket,
      invoiceCount: b.count,
      amount: b.amount,
      customerCount: b.customerIds.size,
      sharePct: totalOverdueAmount > 0 ? round2((b.amount / totalOverdueAmount) * 100) : 0
    })),
    currentNotDue: {
      invoiceCount: currentNotDueCount,
      amount: currentNotDueAmount
    },
    totalOverdueAmount,
    totalOverdueInvoices: overdueItems.length,
    overdueItems: overdueItems.sort((a, b) => b.amount - a.amount || b.daysOverdue - a.daysOverdue),
    paymentStats: {
      totalPayments,
      onTimeCount,
      lateCount,
      onTimeRatePct,
      avgDaysLate,
      totalPaidAmount
    }
  };
}

function simulateLimitScenario(rawCustomer, scenario = {}) {
  const customer = enrichCustomerRecord(rawCustomer);
  if (!customer) return null;

  const currentLimit = customer.creditLimit;
  const currentExposure = customer.exposure;
  const currentOverdue = customer.overdueAmount;
  const currentUtil = calculateUtilisation(currentExposure, currentLimit);

  let projectedLimit = currentLimit;
  if (Number.isFinite(Number(scenario.requestedLimit)) && Number(scenario.requestedLimit) >= 0) {
    projectedLimit = round2(Number(scenario.requestedLimit));
  } else if (Number.isFinite(Number(scenario.newLimit)) && Number(scenario.newLimit) >= 0) {
    projectedLimit = round2(Number(scenario.newLimit));
  } else if (Number.isFinite(Number(scenario.deltaLimit))) {
    projectedLimit = round2(Math.max(0, currentLimit + Number(scenario.deltaLimit)));
  } else if (Number.isFinite(Number(scenario.limitChangePct))) {
    projectedLimit = round2(Math.max(0, currentLimit * (1 + Number(scenario.limitChangePct) / 100)));
  } else if (scenario.defaultApprovalIncrease && currentExposure > currentLimit) {
    // Default recommended buffer to bring utilisation to ~80% if no target limit was specified
    projectedLimit = round2(Math.ceil((currentExposure / 0.8) / 50000) * 50000);
  } else if (scenario.defaultApprovalIncrease) {
    projectedLimit = round2(currentLimit * 1.25);
  }

  let projectedExposure = currentExposure;
  if (Number.isFinite(Number(scenario.newExposure)) && Number(scenario.newExposure) >= 0) {
    projectedExposure = round2(Number(scenario.newExposure));
  } else {
    const extraOrder = toFiniteNumber(scenario.extraExposure ?? scenario.extraInvoiceAmount, 0);
    const paymentReceived = toFiniteNumber(scenario.paymentReceived, 0);
    projectedExposure = round2(Math.max(0, currentExposure + extraOrder - paymentReceived));
  }

  const paymentAppliedToOverdue = Math.min(currentOverdue, toFiniteNumber(scenario.paymentReceived, 0));
  const projectedOverdue = round2(Math.max(0, currentOverdue - paymentAppliedToOverdue));
  const projectedAvailable = round2(projectedLimit - projectedExposure);
  const projectedUtil = calculateUtilisation(projectedExposure, projectedLimit);

  const projectedStatus = projectedUtil.isNoLimit
    ? (projectedExposure > 0 ? 'BREACH' : 'NO_LIMIT')
    : projectedUtil.utilisationPct >= 100
      ? 'BREACH'
      : projectedUtil.utilisationPct >= 80
        ? 'WARNING'
        : 'HEALTHY';

  const increasePct = currentLimit > 0
    ? round2(((projectedLimit - currentLimit) / currentLimit) * 100)
    : (projectedLimit > 0 ? 100 : 0);

  const approverLevel = routeApprover(currentLimit, projectedLimit);
  const policy = DEFAULT_AUTONOMOUS_CREDIT_POLICY;

  const policyChecks = [
    {
      rule: `Projected utilisation within 100% credit limit`,
      status: !projectedUtil.isNoLimit && projectedUtil.utilisationPct < 100
        ? (projectedUtil.utilisationPct < 80 ? 'PASS' : 'WARN')
        : 'FAIL',
      detail: projectedUtil.isNoLimit
        ? 'Projected credit limit is ₹0 (No limit set).'
        : `Projected utilisation is ${projectedUtil.display} (${formatINR(projectedExposure)} / ${formatINR(projectedLimit)}).`
    },
    {
      rule: `Overdue balance threshold (max ₹${Number(policy.autoApproveMaxOverdueAmount || 0).toLocaleString('en-IN')} for auto-approval)`,
      status: projectedOverdue === 0 ? 'PASS' : projectedOverdue <= 150000 ? 'WARN' : 'FAIL',
      detail: projectedOverdue === 0
        ? 'Zero overdue open items.'
        : `Customer has ${formatINR(projectedOverdue)} in overdue receivables.`
    },
    {
      rule: `Risk class eligibility (${(policy.autoApproveAllowedRiskClasses || ['A', 'B']).join(', ')})`,
      status: ['A', 'B'].includes(customer.riskClass) ? 'PASS' : customer.riskClass === 'C' ? 'WARN' : 'FAIL',
      detail: `Customer risk class is ${customer.riskClass}.`
    },
    {
      rule: `Limit step-up governance (<=25% Credit Controller, >25% or >₹5,00,000 increase Finance Head)`,
      status: Math.abs(increasePct) <= 25 && (projectedLimit - currentLimit) <= (CONFIG.controllerIncreaseAmount || 500000) ? 'PASS' : 'WARN',
      detail: `Limit change of ${increasePct >= 0 ? '+' : ''}${increasePct.toFixed(1)}% (${formatINR(currentLimit)} → ${formatINR(projectedLimit)}) routes to ${approverLevel}.`
    }
  ];

  if (customer.flags.includes('STALE_REVIEW')) {
    policyChecks.push({
      rule: `Periodic credit review recency (<=${CONFIG.staleReviewMonths || 12} months)`,
      status: 'WARN',
      detail: `Last review date (${customer.lastReviewDate || 'N/A'}) exceeds ${CONFIG.staleReviewMonths || 12} months.`
    });
  }

  const failCount = policyChecks.filter(c => c.status === 'FAIL').length;
  const warnCount = policyChecks.filter(c => c.status === 'WARN').length;

  let decision = 'APPROVE';
  const reasons = [];

  if (projectedUtil.isNoLimit || projectedUtil.utilisationPct >= 100) {
    decision = projectedOverdue > 250000 ? 'REJECT' : 'MANUAL_REVIEW';
    reasons.push(`Projected utilisation (${projectedUtil.display}) remains at or above the 100% breach threshold.`);
  } else if (projectedOverdue > 200000) {
    decision = 'CONDITIONAL_APPROVAL';
    reasons.push(`Overdue balance of ${formatINR(projectedOverdue)} must be settled or covered by a payment plan prior to activation.`);
  } else if (projectedOverdue > 0 || warnCount >= 2) {
    decision = 'CONDITIONAL_APPROVAL';
    reasons.push(`Requires clearance of ${formatINR(projectedOverdue)} overdue receivables and ${approverLevel} sign-off.`);
  } else if (failCount > 0) {
    decision = 'MANUAL_REVIEW';
    reasons.push(`One or more policy checks failed under ${policy.policyId}.`);
  } else {
    decision = 'APPROVE';
    reasons.push(`Projected utilisation improves to ${projectedUtil.display} with zero overdue balance.`);
  }

  reasons.push(`Governance routing requires ${approverLevel} approval (${formatINR(currentLimit)} → ${formatINR(projectedLimit)}).`);

  return {
    customer,
    current: {
      creditLimit: currentLimit,
      exposure: currentExposure,
      availableCredit: round2(currentLimit - currentExposure),
      overdueAmount: currentOverdue,
      utilisationPct: currentUtil.utilisationPct,
      utilisationDisplay: currentUtil.display,
      status: customer.status
    },
    projected: {
      creditLimit: projectedLimit,
      exposure: projectedExposure,
      availableCredit: projectedAvailable,
      overdueAmount: projectedOverdue,
      utilisationPct: projectedUtil.utilisationPct,
      utilisationDisplay: projectedUtil.display,
      status: projectedStatus
    },
    deltas: {
      creditLimitDelta: round2(projectedLimit - currentLimit),
      creditLimitDeltaPct: increasePct,
      exposureDelta: round2(projectedExposure - currentExposure),
      availableCreditDelta: round2(projectedAvailable - (currentLimit - currentExposure)),
      utilisationDeltaPct: currentUtil.utilisationPct !== null && projectedUtil.utilisationPct !== null
        ? round2(projectedUtil.utilisationPct - currentUtil.utilisationPct)
        : null
    },
    approverLevel,
    policyId: policy.policyId,
    policyChecks,
    decision,
    reasons,
    executed: false
  };
}

module.exports = {
  REFERENCE_DATE,
  toFiniteNumber,
  formatINR,
  normalizeCountry,
  normalizePortfolioCustomers,
  calculateUtilisation,
  classifyCustomerSeverity,
  enrichCustomerRecord,
  filterCustomers,
  computeCohortMetrics,
  computeDimensionBreakdown,
  computeAgeingBuckets,
  simulateLimitScenario
};
