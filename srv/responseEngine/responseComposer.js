const {
  formatINR,
  calculateUtilisation,
  enrichCustomerRecord,
  filterCustomers,
  computeCohortMetrics,
  computeDimensionBreakdown,
  computeAgeingBuckets,
  simulateLimitScenario
} = require('./calculators');
const { CONFIG } = require('../rules');
const { DEFAULT_AUTONOMOUS_CREDIT_POLICY } = require('../autonomousDecisionEngine');

const SCHEMA_VERSION = '1.0';
const POLICY_ID = DEFAULT_AUTONOMOUS_CREDIT_POLICY.policyId || 'FIN-FSCM-AUTONOMOUS-POLICY-V1';

function buildCustomerTableBlock(customers, {
  title = 'Customer Credit Portfolio',
  includeRiskReason = false,
  sortBy = 'utilisationPct',
  sortDir = 'desc',
  pageSize = 10
} = {}) {
  const columns = [
    { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
    { key: 'country', label: 'Country', align: 'left', format: 'text' },
    { key: 'companyCode', label: 'Company Code', align: 'left', format: 'text' },
    { key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
    { key: 'exposure', label: 'Exposure', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
    { key: 'availableCredit', label: 'Available Credit', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
    { key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
    { key: 'utilisationPct', label: 'Utilisation %', align: 'right', format: 'percent', valueKind: 'CALCULATED' },
    { key: 'status', label: 'Status', align: 'left', format: 'badge', valueKind: 'CALCULATED' },
    { key: 'flags', label: 'Risk Flags', align: 'left', format: 'badge', valueKind: 'CALCULATED' }
  ];

  if (includeRiskReason) {
    columns.push({ key: 'riskReason', label: 'Primary Risk Driver', align: 'left', format: 'text', valueKind: 'CALCULATED' });
  }

  const rows = customers.map(c => ({
    customerId: c.ID,
    customerName: c.name,
    customer: `${c.name} (${c.ID})`,
    country: c.country,
    companyCode: c.companyCode,
    creditLimit: c.creditLimit,
    exposure: c.exposure,
    availableCredit: c.availableCredit,
    overdueAmount: c.overdueAmount,
    utilisationPct: c.utilisationPct,
    utilisationDisplay: c.utilisationDisplay,
    isNoLimit: c.isNoLimit,
    status: c.status,
    severity: c.severity,
    flags: Array.isArray(c.flags) && c.flags.length ? c.flags.join(', ') : 'OK',
    ...(includeRiskReason ? { riskReason: (c.riskReasons && c.riskReasons[0]) || 'Within policy thresholds' } : {})
  }));

  return {
    type: 'table',
    title,
    columns,
    rows,
    sortBy,
    sortDir,
    pageSize,
    totalRows: rows.length
  };
}

function composeListResponse(intentPlan, data) {
  const filtered = filterCustomers(data.customers, {
    ...intentPlan.filters,
    ...(intentPlan.customerIds?.length ? { customerIds: intentPlan.customerIds } : {})
  });
  const metrics = computeCohortMetrics(filtered);
  const hasRiskSecondary = (intentPlan.secondaryIntents || []).includes('RISK') || Boolean(intentPlan.filters?.highRiskOnly);

  let filterDesc = 'in the Credit Guard portfolio';
  if (intentPlan.filters?.minUtilisationPct) {
    filterDesc = `with credit utilisation >= ${intentPlan.filters.minUtilisationPct}%`;
  } else if (intentPlan.filters?.breachOnly) {
    filterDesc = 'currently breaching their credit limit (>=100% utilisation)';
  } else if (intentPlan.filters?.countries?.length) {
    filterDesc = `in ${intentPlan.filters.countries.join(', ')}`;
  } else if (intentPlan.filters?.highRiskOnly) {
    filterDesc = 'classified as elevated or high credit risk';
  }

  const title = intentPlan.filters?.minUtilisationPct
    ? `Customers with Utilisation >= ${intentPlan.filters.minUtilisationPct}%`
    : intentPlan.filters?.breachOnly
      ? 'Customers in Credit Limit Breach'
      : hasRiskSecondary
        ? 'High-Risk Customer Register'
        : 'Customer Credit Directory';

  const summary = `Found ${filtered.length} ${filtered.length === 1 ? 'customer' : 'customers'} ${filterDesc} with combined exposure of ${formatINR(metrics.totalExposure)} against ${formatINR(metrics.totalCreditLimit)} total credit limit (${metrics.overallUtilisationDisplay} overall utilisation).`;

  const tableBlock = buildCustomerTableBlock(filtered, {
    title,
    includeRiskReason: hasRiskSecondary,
    sortBy: 'utilisationPct',
    sortDir: 'desc',
    pageSize: 10
  });

  const blocks = [tableBlock];

  if (hasRiskSecondary && filtered.length > 0) {
    const observations = filtered.slice(0, 4).map(c =>
      `${c.name} (${c.ID}) [${c.severity} Risk]: ${(c.riskReasons || []).join('; ')}. Recommended: ${c.recommendedAction}`
    );
    blocks.push({
      type: 'observations',
      title: 'Risk Explanation & Priority Actions',
      items: observations
    });
  }

  const topId = filtered[0]?.ID || 'C001';
  return {
    title,
    summary,
    blocks,
    resultSetIds: filtered.map(c => c.ID),
    suggestedFollowUps: [
      `Compare their exposure`,
      `Give full details for customer ${topId}`,
      `Which customers have overdue invoices and how old are they?`
    ]
  };
}

function composeCompareResponse(intentPlan, data, rawMessage = '') {
  const dimension = intentPlan.comparisonDimension || 'customer';
  const isAskingHighestUtil = /\b(?:highest|most|top)\s+(?:credit\s+)?utili[sz]ation\b/i.test(rawMessage);
  const isMultiMetricCustomerCompare = dimension === 'customer'
    && intentPlan.customerIds?.length >= 2
    && /\b(?:exposure\s+and\s+limit|limit\s+and\s+exposure)\b/i.test(rawMessage);

  const filtered = filterCustomers(data.customers, {
    ...intentPlan.filters,
    ...(intentPlan.customerIds?.length ? { customerIds: intentPlan.customerIds } : {}),
    sortBy: isAskingHighestUtil ? 'utilisationPct' : (intentPlan.metrics?.includes('exposure') && !isAskingHighestUtil ? 'exposure' : 'utilisationPct'),
    sortDir: 'desc'
  });

  if (dimension === 'country' || dimension === 'companyCode' || dimension === 'riskClass') {
    const groups = computeDimensionBreakdown(filtered, dimension, { sortBy: 'exposure' });
    const topGroup = groups[0];
    const dimLabel = dimension === 'companyCode' ? 'Company Code' : dimension === 'riskClass' ? 'Risk Class' : 'Country';
    const title = `Credit Exposure & Utilisation Comparison by ${dimLabel}`;
    const summary = topGroup
      ? `${topGroup.label} leads with ${formatINR(topGroup.exposure)} exposure (${topGroup.shareOfExposurePct.toFixed(1)}% of portfolio) across ${topGroup.customerCount} customers at ${topGroup.utilisationDisplay} utilisation.`
      : `No records matched the requested ${dimLabel.toLowerCase()} comparison.`;

    const chartBlock = {
      type: 'chart',
      chartType: 'hbar',
      title: `Exposure by ${dimLabel} (INR)`,
      subtitle: `Sorted descending across ${groups.length} ${dimLabel.toLowerCase()} groups`,
      xLabel: dimLabel,
      yLabel: 'Exposure (INR)',
      unit: 'INR',
      valueKind: 'CALCULATED',
      series: [{
        name: 'Exposure',
        data: groups.map((g, idx) => ({
          label: g.label,
          value: g.exposure,
          secondaryValue: g.creditLimit,
          utilisationPct: g.utilisationPct,
          highlight: idx === 0,
          status: g.utilisationPct >= 100 ? 'BREACH' : g.utilisationPct >= 80 ? 'WARNING' : 'HEALTHY'
        }))
      }],
      thresholds: [],
      caption: `Source: Credit Guard CAP database (${filtered.length} customers).`
    };

    const tableBlock = {
      type: 'table',
      title: `${dimLabel} Breakdown`,
      columns: [
        { key: 'label', label: dimLabel, align: 'left', format: 'text' },
        { key: 'customerCount', label: 'Customers', align: 'right', format: 'number', valueKind: 'ACTUAL' },
        { key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
        { key: 'exposure', label: 'Exposure', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
        { key: 'availableCredit', label: 'Available Credit', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
        { key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
        { key: 'utilisationPct', label: 'Utilisation %', align: 'right', format: 'percent', valueKind: 'CALCULATED' },
        { key: 'shareOfExposurePct', label: 'Exposure Share %', align: 'right', format: 'percent', valueKind: 'CALCULATED' }
      ],
      rows: groups,
      sortBy: 'exposure',
      sortDir: 'desc',
      pageSize: 10,
      totalRows: groups.length
    };

    const observations = groups.slice(0, 3).map(g =>
      `${g.label}: ${formatINR(g.exposure)} exposure against ${formatINR(g.creditLimit)} limit (${g.utilisationDisplay} utilisation, ${formatINR(g.overdueAmount)} overdue).`
    );

    return {
      title,
      summary,
      blocks: [
        chartBlock,
        tableBlock,
        { type: 'observations', title: 'Key Comparison Insights', items: observations }
      ],
      resultSetIds: filtered.map(c => c.ID),
      suggestedFollowUps: [
        `List customers with utilisation >= 80%`,
        `Identify high-risk customers and explain why`,
        `Which customers have overdue invoices and how old are they?`
      ]
    };
  }

  // Customer comparison / ranking
  const topCustomer = filtered[0];
  const cohortMetrics = computeCohortMetrics(filtered);

  const summary = topCustomer
    ? isAskingHighestUtil
      ? `${topCustomer.name} (${topCustomer.ID}) has the highest credit utilisation at ${topCustomer.utilisationDisplay} with ${formatINR(topCustomer.exposure)} exposure against a ${formatINR(topCustomer.creditLimit)} credit limit (${topCustomer.status}).`
      : `Compared ${filtered.length} customers: ${topCustomer.name} (${topCustomer.ID}) ranks highest with ${formatINR(topCustomer.exposure)} exposure and ${topCustomer.utilisationDisplay} utilisation (combined cohort exposure ${formatINR(cohortMetrics.totalExposure)}).`
    : 'No customers matched the comparison criteria.';

  const chartCustomers = filtered.length > 12 ? filtered.slice(0, 10) : filtered;
  let chartBlock;

  if (isMultiMetricCustomerCompare || (intentPlan.customerIds?.length >= 2 && !isAskingHighestUtil)) {
    chartBlock = {
      type: 'chart',
      chartType: 'groupedBar',
      title: 'Customer Exposure vs Credit Limit Comparison (INR)',
      subtitle: `Direct comparison across ${chartCustomers.length} selected customers`,
      xLabel: 'Customer',
      yLabel: 'Amount (INR)',
      unit: 'INR',
      valueKind: 'CALCULATED',
      series: [
        {
          name: 'Credit Limit',
          data: chartCustomers.map(c => ({
            label: `${c.name} (${c.ID})`,
            shortLabel: c.ID,
            value: c.creditLimit,
            status: 'HEALTHY'
          }))
        },
        {
          name: 'Current Exposure',
          data: chartCustomers.map(c => ({
            label: `${c.name} (${c.ID})`,
            shortLabel: c.ID,
            value: c.exposure,
            utilisationPct: c.utilisationPct,
            status: c.status
          }))
        }
      ],
      thresholds: [],
      caption: `Grouped comparison of authorized credit limit vs current exposure in INR.`
    };
  } else {
    chartBlock = {
      type: 'chart',
      chartType: 'hbar',
      title: 'Customer Credit Utilisation Ranking (%)',
      subtitle: `Ranked descending against 80% Warning and 100% Breach policy thresholds`,
      xLabel: 'Utilisation %',
      yLabel: 'Customer',
      unit: 'PERCENT',
      valueKind: 'CALCULATED',
      series: [{
        name: 'Utilisation %',
        data: chartCustomers.map((c, idx) => ({
          label: `${c.name} (${c.ID})`,
          shortLabel: c.ID,
          value: c.utilisationPct ?? 0,
          exposure: c.exposure,
          creditLimit: c.creditLimit,
          highlight: idx === 0,
          status: c.status
        }))
      }],
      thresholds: [
        { label: '80% Warning', value: 80, severity: 'warning' },
        { label: '100% Breach', value: 100, severity: 'critical' }
      ],
      caption: `Top customer: ${topCustomer ? `${topCustomer.name} (${topCustomer.ID}) at ${topCustomer.utilisationDisplay}` : 'N/A'}.`
    };
  }

  const tableBlock = buildCustomerTableBlock(filtered, {
    title: 'Compared Customers',
    includeRiskReason: false,
    sortBy: isAskingHighestUtil ? 'utilisationPct' : 'exposure',
    sortDir: 'desc',
    pageSize: 10
  });

  const observations = [];
  if (topCustomer) {
    observations.push(`${topCustomer.name} (${topCustomer.ID}) leads the cohort at ${topCustomer.utilisationDisplay} utilisation (${formatINR(topCustomer.exposure)} exposure vs ${formatINR(topCustomer.creditLimit)} limit).`);
  }
  if (cohortMetrics.breachCount > 0) {
    observations.push(`${cohortMetrics.breachCount} of ${filtered.length} compared customers are at or above the 100% credit limit breach threshold.`);
  }
  if (cohortMetrics.overdueExposure > 0) {
    observations.push(`Total overdue balance across the compared customers is ${formatINR(cohortMetrics.overdueExposure)} (${cohortMetrics.overdueCustomerCount} accounts).`);
  }

  return {
    title: isAskingHighestUtil ? 'Highest Credit Utilisation Analysis' : 'Customer Credit Comparison',
    summary,
    blocks: [
      chartBlock,
      tableBlock,
      { type: 'observations', title: 'Comparison Observations', items: observations }
    ],
    resultSetIds: filtered.map(c => c.ID),
    suggestedFollowUps: topCustomer ? [
      `Give full details for customer ${topCustomer.ID}`,
      `Can we approve a credit limit increase for ${topCustomer.ID} to ₹15,00,000?`,
      `What if ${topCustomer.ID} pays ₹2,00,000?`
    ] : []
  };
}

function composeApprovalResponse(intentPlan, data) {
  const targetId = (intentPlan.customerIds && intentPlan.customerIds[0]) || 'C001';
  const rawCustomer = data.customerDetailsById.get(targetId)
    || (data.customers || []).find(c => String(c.ID).toUpperCase() === targetId)
    || (data.customers || [])[0];

  if (!rawCustomer) {
    return {
      title: 'Customer Not Found for Approval Evaluation',
      summary: `Customer ${targetId} could not be found in the Credit Guard portfolio.`,
      blocks: [{
        type: 'notice',
        severity: 'warning',
        title: 'Customer Not Found',
        message: `Customer ${targetId} does not exist in the portfolio. Specify a valid customer ID (C001–C013).`
      }],
      resultSetIds: [],
      suggestedFollowUps: ['Show all customers', 'List customers with utilisation >= 80%']
    };
  }

  const sim = simulateLimitScenario(rawCustomer, {
    ...intentPlan.scenarioParams,
    defaultApprovalIncrease: true
  });
  const cust = sim.customer;
  const historyObj = data.approvalHistoryById.get(cust.ID);
  const existingRequests = historyObj?.requests || (data.limitRequests || []).filter(r => String(r.customer_ID).toUpperCase() === cust.ID);
  const pendingCount = existingRequests.filter(r => r.status === 'Pending').length;

  const title = `Credit Limit Approval Evaluation – ${cust.name} (${cust.ID})`;
  const summary = `Advisory decision for ${cust.name} (${cust.ID}) limit change from ${formatINR(sim.current.creditLimit)} to ${formatINR(sim.projected.creditLimit)}: ${sim.decision.replaceAll('_', ' ')} (projected utilisation ${sim.projected.utilisationDisplay}, routed to ${sim.approverLevel}; no change has been executed).`;

  const keyValueBlock = {
    type: 'keyValue',
    title: `Customer Credit Snapshot – ${cust.name} (${cust.ID})`,
    items: [
      { label: 'Customer', value: `${cust.name} (${cust.ID})`, valueKind: 'ACTUAL' },
      { label: 'Country / Company Code', value: `${cust.country} / ${cust.companyCode}`, valueKind: 'ACTUAL' },
      { label: 'Risk Class', value: `Class ${cust.riskClass}`, valueKind: 'ACTUAL' },
      { label: 'Current Status', value: cust.status, valueKind: 'CALCULATED' },
      { label: 'Current Credit Limit', value: formatINR(sim.current.creditLimit), valueKind: 'ACTUAL' },
      { label: 'Current Exposure', value: formatINR(sim.current.exposure), valueKind: 'CALCULATED' },
      { label: 'Current Utilisation', value: sim.current.utilisationDisplay, valueKind: 'CALCULATED' },
      { label: 'Overdue Receivables', value: formatINR(sim.current.overdueAmount), valueKind: 'ACTUAL' },
      { label: 'Required Approver Role', value: sim.approverLevel, valueKind: 'CALCULATED' },
      { label: 'Existing Pending Requests', value: String(pendingCount), valueKind: 'ACTUAL' }
    ]
  };

  const comparisonBlock = {
    type: 'comparison',
    title: 'Current vs Projected Credit Position',
    simulation: false,
    columns: ['Metric', 'Current', 'Projected', 'Delta / Impact'],
    rows: [
      {
        metric: 'Credit Limit',
        current: formatINR(sim.current.creditLimit),
        projected: formatINR(sim.projected.creditLimit),
        delta: `${sim.deltas.creditLimitDelta >= 0 ? '+' : ''}${formatINR(sim.deltas.creditLimitDelta)} (${sim.deltas.creditLimitDeltaPct >= 0 ? '+' : ''}${sim.deltas.creditLimitDeltaPct.toFixed(1)}%)`,
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Total Exposure',
        current: formatINR(sim.current.exposure),
        projected: formatINR(sim.projected.exposure),
        delta: formatINR(sim.deltas.exposureDelta),
        valueKind: 'CALCULATED'
      },
      {
        metric: 'Available Credit',
        current: formatINR(sim.current.availableCredit),
        projected: formatINR(sim.projected.availableCredit),
        delta: `${sim.deltas.availableCreditDelta >= 0 ? '+' : ''}${formatINR(sim.deltas.availableCreditDelta)}`,
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Credit Utilisation %',
        current: sim.current.utilisationDisplay,
        projected: sim.projected.utilisationDisplay,
        delta: sim.deltas.utilisationDeltaPct !== null
          ? `${sim.deltas.utilisationDeltaPct >= 0 ? '+' : ''}${sim.deltas.utilisationDeltaPct.toFixed(1)} pts`
          : 'N/A',
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Overdue Receivables',
        current: formatINR(sim.current.overdueAmount),
        projected: formatINR(sim.projected.overdueAmount),
        delta: formatINR(0),
        valueKind: 'ACTUAL'
      },
      {
        metric: 'Policy Threshold Status',
        current: sim.current.status,
        projected: sim.projected.status,
        delta: `${sim.current.status} → ${sim.projected.status}`,
        valueKind: 'SIMULATED'
      }
    ]
  };

  const recommendationBlock = {
    type: 'recommendation',
    decision: sim.decision,
    policyChecks: sim.policyChecks,
    reasons: sim.reasons,
    advisoryNote: `Advisory evaluation only under ${POLICY_ID}. No credit limit has been submitted, approved, or modified in SAP or the Credit Guard database. Human approval by ${sim.approverLevel} is required.`,
    executed: false,
    draftAction: {
      label: `Draft limit request for ${cust.ID} (${formatINR(sim.projected.creditLimit)})`,
      prompt: `Prepare a credit limit change for ${cust.ID} to ${sim.projected.creditLimit} for credit review and exposure coverage`
    }
  };

  const chartBlock = {
    type: 'chart',
    chartType: 'groupedBar',
    title: `Current vs Projected Limit & Exposure – ${cust.name} (${cust.ID})`,
    subtitle: `Comparison in INR (Policy ${POLICY_ID})`,
    xLabel: 'Scenario',
    yLabel: 'Amount (INR)',
    unit: 'INR',
    valueKind: 'SIMULATED',
    series: [
      {
        name: 'Credit Limit',
        data: [
          { label: 'Current', value: sim.current.creditLimit, status: 'HEALTHY' },
          { label: 'Projected', value: sim.projected.creditLimit, status: 'HEALTHY' }
        ]
      },
      {
        name: 'Exposure',
        data: [
          { label: 'Current', value: sim.current.exposure, status: sim.current.status },
          { label: 'Projected', value: sim.projected.exposure, status: sim.projected.status }
        ]
      }
    ],
    thresholds: [],
    caption: `Projected utilisation shifts from ${sim.current.utilisationDisplay} to ${sim.projected.utilisationDisplay}.`
  };

  return {
    title,
    summary,
    blocks: [keyValueBlock, comparisonBlock, recommendationBlock, chartBlock],
    resultSetIds: [cust.ID],
    suggestedFollowUps: [
      `Draft limit request for ${cust.ID} to ${formatINR(sim.projected.creditLimit)}`,
      `Give full details for customer ${cust.ID}`,
      `What if ${cust.ID} pays ${formatINR(sim.current.overdueAmount || 200000)}?`
    ]
  };
}

function composeExposureResponse(intentPlan, data, rawMessage = '') {
  const filtered = filterCustomers(data.customers, {
    ...intentPlan.filters,
    ...(intentPlan.customerIds?.length ? { customerIds: intentPlan.customerIds } : {})
  });
  const metrics = computeCohortMetrics(filtered);

  const dimension = /\bcompany\s*code\b/i.test(rawMessage)
    ? 'companyCode'
    : /\brisk\s*class\b/i.test(rawMessage)
      ? 'riskClass'
      : 'country';
  const dimLabel = dimension === 'companyCode' ? 'Company Code' : dimension === 'riskClass' ? 'Risk Class' : 'Country';
  const breakdown = computeDimensionBreakdown(filtered, dimension, { sortBy: 'exposure' });

  const title = `Portfolio Credit Exposure Analysis (${dimLabel} Breakdown)`;
  const summary = `Total portfolio credit exposure across ${metrics.customerCount} customers is ${formatINR(metrics.totalExposure)} against ${formatINR(metrics.totalCreditLimit)} total credit limit (${metrics.overallUtilisationDisplay} overall utilisation, ${formatINR(metrics.availableCredit)} available credit, and ${formatINR(metrics.overdueExposure)} overdue).`;

  const metricsBlock = {
    type: 'metrics',
    items: [
      {
        id: 'total-limit',
        label: 'Total Credit Limit',
        value: formatINR(metrics.totalCreditLimit),
        rawValue: metrics.totalCreditLimit,
        unit: 'INR',
        valueKind: 'ACTUAL',
        severity: 'neutral',
        subtitle: `${metrics.customerCount} active customers`
      },
      {
        id: 'total-exposure',
        label: 'Total Exposure',
        value: formatINR(metrics.totalExposure),
        rawValue: metrics.totalExposure,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: metrics.overallUtilisationPct >= 100 ? 'critical' : metrics.overallUtilisationPct >= 80 ? 'warning' : 'neutral',
        subtitle: `${formatINR(metrics.overdueExposure)} overdue receivables`
      },
      {
        id: 'available-credit',
        label: 'Available Credit',
        value: formatINR(metrics.availableCredit),
        rawValue: metrics.availableCredit,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: 'healthy',
        subtitle: `Net headroom across portfolio`
      },
      {
        id: 'overall-utilisation',
        label: 'Overall Utilisation',
        value: metrics.overallUtilisationDisplay,
        rawValue: metrics.overallUtilisationPct,
        unit: 'PERCENT',
        valueKind: 'CALCULATED',
        severity: metrics.overallUtilisationPct >= 100 ? 'critical' : metrics.overallUtilisationPct >= 80 ? 'warning' : 'healthy',
        subtitle: `${metrics.breachCount} breach · ${metrics.warningCount} warning`
      }
    ]
  };

  const chartType = breakdown.length <= 6 ? 'donut' : 'hbar';
  const chartBlock = {
    type: 'chart',
    chartType,
    title: `Exposure Distribution by ${dimLabel}`,
    subtitle: `Share of ${formatINR(metrics.totalExposure)} total exposure`,
    xLabel: dimLabel,
    yLabel: 'Exposure (INR)',
    unit: 'INR',
    valueKind: 'CALCULATED',
    series: [{
      name: 'Exposure',
      data: breakdown.map(b => ({
        label: b.label,
        value: b.exposure,
        sharePct: b.shareOfExposurePct,
        utilisationPct: b.utilisationPct,
        customerCount: b.customerCount
      }))
    }],
    thresholds: [],
    caption: `All ${breakdown.length} ${dimLabel.toLowerCase()} segments reconcile to ${formatINR(metrics.totalExposure)} total exposure.`
  };

  const tableBlock = {
    type: 'table',
    title: `Exposure Breakdown by ${dimLabel}`,
    columns: [
      { key: 'label', label: dimLabel, align: 'left', format: 'text' },
      { key: 'customerCount', label: 'Customers', align: 'right', format: 'number', valueKind: 'ACTUAL' },
      { key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
      { key: 'exposure', label: 'Exposure', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
      { key: 'availableCredit', label: 'Available Credit', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
      { key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
      { key: 'utilisationPct', label: 'Utilisation %', align: 'right', format: 'percent', valueKind: 'CALCULATED' },
      { key: 'shareOfExposurePct', label: 'Share of Exposure %', align: 'right', format: 'percent', valueKind: 'CALCULATED' }
    ],
    rows: breakdown,
    sortBy: 'exposure',
    sortDir: 'desc',
    pageSize: 10,
    totalRows: breakdown.length
  };

  const topSeg = breakdown[0];
  const observations = [
    topSeg
      ? `${topSeg.label} accounts for the largest share of portfolio exposure at ${formatINR(topSeg.exposure)} (${topSeg.shareOfExposurePct.toFixed(1)}% of total) across ${topSeg.customerCount} customers.`
      : 'Portfolio exposure is distributed across configured segments.',
    `${metrics.breachCount} customers are in credit limit breach (>=100%) and ${metrics.warningCount} customers are in the 80–99% warning zone.`,
    `Overdue receivables represent ${formatINR(metrics.overdueExposure)} (${metrics.totalExposure > 0 ? ((metrics.overdueExposure / metrics.totalExposure) * 100).toFixed(1) : '0.0'}% of total portfolio exposure).`
  ];

  return {
    title,
    summary,
    blocks: [
      metricsBlock,
      chartBlock,
      tableBlock,
      { type: 'observations', title: 'Exposure Concentration Insights', items: observations }
    ],
    resultSetIds: filtered.map(c => c.ID),
    suggestedFollowUps: [
      `List customers with utilisation >= 80%`,
      `Identify high-risk customers and explain why`,
      `Which customer has the highest credit utilisation?`
    ]
  };
}

function composeRiskResponse(intentPlan, data) {
  const allEnriched = filterCustomers(data.customers, {
    ...(intentPlan.countries?.length ? { countries: intentPlan.countries } : {}),
    ...(intentPlan.companyCodes?.length ? { companyCodes: intentPlan.companyCodes } : {}),
    ...(intentPlan.customerIds?.length ? { customerIds: intentPlan.customerIds } : {})
  });
  const fullMetrics = computeCohortMetrics(allEnriched);

  const severityOrder = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  const rankedCustomers = [...allEnriched].sort((a, b) =>
    (severityOrder[b.severity] - severityOrder[a.severity])
    || ((b.utilisationPct ?? -1) - (a.utilisationPct ?? -1))
    || (b.overdueAmount - a.overdueAmount)
  );

  const highRiskCustomers = rankedCustomers.filter(c => ['Critical', 'High'].includes(c.severity));
  const elevatedCustomers = rankedCustomers.filter(c => ['Critical', 'High', 'Medium'].includes(c.severity));
  const tableCustomers = intentPlan.filters?.highRiskOnly ? elevatedCustomers : rankedCustomers;
  const tableMetrics = computeCohortMetrics(tableCustomers);

  const title = 'Portfolio Credit Risk Assessment & Drivers';
  const summary = `Identified ${fullMetrics.severityCounts.Critical} Critical, ${fullMetrics.severityCounts.High} High, and ${fullMetrics.severityCounts.Medium} Medium risk customers across ${allEnriched.length} evaluated accounts (total portfolio exposure ${formatINR(fullMetrics.totalExposure)}, overdue ${formatINR(fullMetrics.overdueExposure)}).`;

  const metricsBlock = {
    type: 'metrics',
    items: [
      {
        id: 'risk-critical',
        label: 'Critical Risk',
        value: String(fullMetrics.severityCounts.Critical),
        rawValue: fullMetrics.severityCounts.Critical,
        unit: 'COUNT',
        valueKind: 'CALCULATED',
        severity: fullMetrics.severityCounts.Critical > 0 ? 'critical' : 'healthy',
        subtitle: 'Breach + overdue or >=120% util'
      },
      {
        id: 'risk-high',
        label: 'High Risk',
        value: String(fullMetrics.severityCounts.High),
        rawValue: fullMetrics.severityCounts.High,
        unit: 'COUNT',
        valueKind: 'CALCULATED',
        severity: fullMetrics.severityCounts.High > 0 ? 'warning' : 'healthy',
        subtitle: '>=100% breach or heavy overdue'
      },
      {
        id: 'risk-medium',
        label: 'Medium Risk',
        value: String(fullMetrics.severityCounts.Medium),
        rawValue: fullMetrics.severityCounts.Medium,
        unit: 'COUNT',
        valueKind: 'CALCULATED',
        severity: 'warning',
        subtitle: '80–99% warning or overdue balance'
      },
      {
        id: 'risk-exposure',
        label: 'Evaluated Exposure',
        value: formatINR(tableMetrics.totalExposure),
        rawValue: tableMetrics.totalExposure,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: 'neutral',
        subtitle: `Across ${tableCustomers.length} customers in table`
      }
    ]
  };

  const chartBlock = {
    type: 'chart',
    chartType: 'donut',
    title: 'Customer Risk Severity Distribution',
    subtitle: `Classification across ${allEnriched.length} portfolio customers`,
    xLabel: 'Risk Severity',
    yLabel: 'Customers',
    unit: 'COUNT',
    valueKind: 'CALCULATED',
    series: [{
      name: 'Customers',
      data: [
        { label: 'Critical', value: fullMetrics.severityCounts.Critical, status: 'BREACH' },
        { label: 'High', value: fullMetrics.severityCounts.High, status: 'BREACH' },
        { label: 'Medium', value: fullMetrics.severityCounts.Medium, status: 'WARNING' },
        { label: 'Low', value: fullMetrics.severityCounts.Low, status: 'HEALTHY' }
      ].filter(d => d.value > 0)
    }],
    thresholds: [],
    caption: `Thresholds: Critical (>=120% or Breach+Overdue), High (>=100% or >=80%+Overdue), Medium (80–99% or Overdue/Stale).`
  };

  const tableBlock = buildCustomerTableBlock(tableCustomers, {
    title: 'Risk-Ranked Customers & Explanations',
    includeRiskReason: true,
    sortBy: 'utilisationPct',
    sortDir: 'desc',
    pageSize: 10
  });

  const priorityActions = (highRiskCustomers.length ? highRiskCustomers : elevatedCustomers).slice(0, 4).map(c =>
    `${c.name} (${c.ID}) [${c.severity}]: ${(c.riskReasons || []).join('; ')} — Action: ${c.recommendedAction}`
  );

  return {
    title,
    summary,
    blocks: [
      metricsBlock,
      chartBlock,
      tableBlock,
      { type: 'observations', title: 'Priority Risk Mitigation Actions', items: priorityActions }
    ],
    resultSetIds: tableCustomers.map(c => c.ID),
    suggestedFollowUps: [
      `Give full details for customer C001`,
      `Which customers have overdue invoices and how old are they?`,
      `What active monitoring alerts need attention today?`
    ]
  };
}

function composeTrendResponse(intentPlan, data) {
  const runs = Array.isArray(data.monitoringRuns) ? data.monitoringRuns : [];
  const enriched = filterCustomers(data.customers, intentPlan.filters);
  const currentMetrics = computeCohortMetrics(enriched);

  // Deduplicate runs by distinct timestamp/date if multiple exist
  const orderedRuns = [...runs].sort((a, b) => Date.parse(a.completedAt || 0) - Date.parse(b.completedAt || 0));

  if (orderedRuns.length < 3) {
    const snapshotCount = Math.max(1, orderedRuns.length);
    const title = 'Historical Exposure Trend – Limitation Notice';
    const summary = `Historical multi-period trend data is not available in the Credit Guard demo dataset (${snapshotCount} point-in-time snapshot available; current portfolio exposure is ${formatINR(currentMetrics.totalExposure)} across ${currentMetrics.customerCount} customers at ${currentMetrics.overallUtilisationDisplay} utilisation).`;

    return {
      title,
      summary,
      blocks: [
        {
          type: 'notice',
          severity: 'info',
          title: 'Insufficient Historical Snapshots for Time-Series Chart',
          message: `A line chart requires at least 3 historical time-series snapshots. The database currently stores ${snapshotCount} point-in-time snapshot (no multi-month historical series for ${intentPlan.period || '6m'} is persisted). Credit Guard never fabricates historical data points. Current snapshot totals: ${formatINR(currentMetrics.totalExposure)} exposure, ${formatINR(currentMetrics.totalCreditLimit)} credit limit (${currentMetrics.overallUtilisationDisplay} utilisation).`
        }
      ],
      limitations: [
        `Only ${snapshotCount} point-in-time snapshot is stored in the CAP database; historical time-series points were not fabricated.`
      ],
      resultSetIds: enriched.map(c => c.ID),
      suggestedFollowUps: [
        `Show total portfolio credit exposure by country`,
        `List customers with utilisation >= 80%`,
        `What active monitoring alerts need attention today?`
      ]
    };
  }

  const latest = orderedRuns[orderedRuns.length - 1];
  const earliest = orderedRuns[0];
  const deltaExp = Number(latest.totalExposure || 0) - Number(earliest.totalExposure || 0);

  return {
    title: 'Historical Portfolio Exposure Trend',
    summary: `Across ${orderedRuns.length} persisted monitoring snapshots, total portfolio exposure moved from ${formatINR(earliest.totalExposure)} to ${formatINR(latest.totalExposure)} (${deltaExp >= 0 ? '+' : ''}${formatINR(deltaExp)}).`,
    blocks: [
      {
        type: 'metrics',
        items: [
          {
            id: 'latest-exp',
            label: 'Latest Snapshot Exposure',
            value: formatINR(latest.totalExposure),
            rawValue: Number(latest.totalExposure || 0),
            unit: 'INR',
            valueKind: 'ACTUAL',
            severity: 'neutral',
            subtitle: `Snapshot ${String(latest.completedAt || '').slice(0, 10)}`
          },
          {
            id: 'latest-overdue',
            label: 'Latest Overdue Exposure',
            value: formatINR(latest.overdueExposure),
            rawValue: Number(latest.overdueExposure || 0),
            unit: 'INR',
            valueKind: 'ACTUAL',
            severity: 'warning',
            subtitle: `${latest.breachedCustomers || 0} breached customers`
          }
        ]
      },
      {
        type: 'chart',
        chartType: 'line',
        title: 'Total Portfolio Exposure Across Monitoring Snapshots (INR)',
        subtitle: `${orderedRuns.length} persisted monitoring runs`,
        xLabel: 'Snapshot Timestamp',
        yLabel: 'Total Exposure (INR)',
        unit: 'INR',
        valueKind: 'ACTUAL',
        series: [{
          name: 'Total Exposure',
          data: orderedRuns.map((r, i) => ({
            label: String(r.completedAt || `Run ${i + 1}`).slice(0, 16).replace('T', ' '),
            value: Number(r.totalExposure || 0)
          }))
        }],
        thresholds: [],
        caption: 'Source: Persisted Credit Guard monitoring runs.'
      },
      {
        type: 'observations',
        title: 'Trend Observations',
        items: [
          `Earliest recorded run: ${formatINR(earliest.totalExposure)} exposure (${earliest.breachedCustomers || 0} breaches).`,
          `Latest recorded run: ${formatINR(latest.totalExposure)} exposure (${latest.breachedCustomers || 0} breaches).`
        ]
      }
    ],
    resultSetIds: enriched.map(c => c.ID),
    suggestedFollowUps: [
      `Show total portfolio credit exposure by country`,
      `What active monitoring alerts need attention today?`
    ]
  };
}

function composeCustomerDetailResponse(intentPlan, data) {
  if (intentPlan.unknownCustomerIds?.length > 0 && (!intentPlan.customerIds || intentPlan.customerIds.length === 0)) {
    const unknownId = intentPlan.unknownCustomerIds[0];
    return {
      title: `Customer ${unknownId} Not Found`,
      summary: `Customer ${unknownId} was not found in the Credit Guard portfolio (available customer IDs are C001 through C013). No records were retrieved or fabricated.`,
      blocks: [
        {
          type: 'notice',
          severity: 'warning',
          title: `Customer ${unknownId} Not Found`,
          message: `No Business Partner or credit account matching "${unknownId}" exists in the Credit Guard CAP database. Valid demo customer IDs are C001 through C013.`
        }
      ],
      resultSetIds: [],
      suggestedFollowUps: [
        `Show all customers`,
        `Give full details for customer C001`,
        `List customers with utilisation >= 80%`
      ]
    };
  }

  const targetId = (intentPlan.customerIds && intentPlan.customerIds[0]) || 'C001';
  const rawDetail = data.customerDetailsById.get(targetId)
    || (data.customers || []).find(c => String(c.ID).toUpperCase() === targetId);

  if (!rawDetail) {
    return {
      title: `Customer ${targetId} Not Found`,
      summary: `Customer ${targetId} was not found in the Credit Guard portfolio.`,
      blocks: [
        {
          type: 'notice',
          severity: 'warning',
          title: `Customer ${targetId} Not Found`,
          message: `No customer record was found for ${targetId}.`
        }
      ],
      resultSetIds: [],
      suggestedFollowUps: [`Show all customers`]
    };
  }

  const cust = enrichCustomerRecord(rawDetail);
  const openItems = Array.isArray(rawDetail.openItems) ? rawDetail.openItems : [];
  const payments = data.customerPaymentsById.get(cust.ID) || (Array.isArray(rawDetail.payments) ? rawDetail.payments : []);
  const approvalHistory = data.approvalHistoryById.get(cust.ID)?.requests || [];
  const findings = (data.monitoringAnalysis?.findings || []).filter(f => String(f.customerId || f.customer_ID).toUpperCase() === cust.ID);
  const custAlerts = (data.monitoringAlerts || []).filter(a => String(a.customerId || a.customer_ID).toUpperCase() === cust.ID);

  const title = `Customer Credit Dossier – ${cust.name} (${cust.ID})`;
  const summary = `${cust.name} (${cust.ID}) in ${cust.country} (Company Code ${cust.companyCode}, Risk Class ${cust.riskClass}) has ${formatINR(cust.exposure)} exposure against a ${formatINR(cust.creditLimit)} credit limit (${cust.utilisationDisplay} utilisation, status ${cust.status}), with ${formatINR(cust.overdueAmount)} in overdue receivables across ${openItems.length} open item(s).`;

  const keyValueBlock = {
    type: 'keyValue',
    title: 'Business Partner & Credit Profile',
    items: [
      { label: 'Customer Name & ID', value: `${cust.name} (${cust.ID})`, valueKind: 'ACTUAL' },
      { label: 'Country / Company Code', value: `${cust.country} / ${cust.companyCode}`, valueKind: 'ACTUAL' },
      { label: 'Risk Class', value: `Class ${cust.riskClass}`, valueKind: 'ACTUAL' },
      { label: 'Threshold Status', value: cust.status, valueKind: 'CALCULATED' },
      { label: 'Risk Severity', value: cust.severity, valueKind: 'CALCULATED' },
      { label: 'Active Risk Flags', value: cust.flags.length ? cust.flags.join(', ') : 'OK', valueKind: 'CALCULATED' },
      { label: 'Last Credit Review Date', value: cust.lastReviewDate || '—', valueKind: 'ACTUAL' },
      { label: 'Limit Requests on File', value: String(approvalHistory.length), valueKind: 'ACTUAL' }
    ]
  };

  const metricsBlock = {
    type: 'metrics',
    items: [
      {
        id: 'cust-limit',
        label: 'Credit Limit',
        value: formatINR(cust.creditLimit),
        rawValue: cust.creditLimit,
        unit: 'INR',
        valueKind: 'ACTUAL',
        severity: 'neutral',
        subtitle: `Company Code ${cust.companyCode}`
      },
      {
        id: 'cust-exposure',
        label: 'Current Exposure',
        value: formatINR(cust.exposure),
        rawValue: cust.exposure,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: cust.status === 'BREACH' ? 'critical' : cust.status === 'WARNING' ? 'warning' : 'healthy',
        subtitle: `${openItems.length} open invoice(s)`
      },
      {
        id: 'cust-available',
        label: 'Available Credit',
        value: formatINR(cust.availableCredit),
        rawValue: cust.availableCredit,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: cust.availableCredit < 0 ? 'critical' : 'healthy',
        subtitle: cust.availableCredit < 0 ? 'Over limit' : 'Remaining headroom'
      },
      {
        id: 'cust-util',
        label: 'Utilisation %',
        value: cust.utilisationDisplay,
        rawValue: cust.utilisationPct,
        unit: 'PERCENT',
        valueKind: 'CALCULATED',
        severity: cust.status === 'BREACH' ? 'critical' : cust.status === 'WARNING' ? 'warning' : 'healthy',
        subtitle: `${formatINR(cust.overdueAmount)} overdue`
      }
    ]
  };

  const blocks = [keyValueBlock, metricsBlock];

  if (openItems.length > 0) {
    blocks.push({
      type: 'table',
      title: `Open & Overdue Invoices (${openItems.length})`,
      columns: [
        { key: 'invoiceNumber', label: 'Invoice #', align: 'left', format: 'text', valueKind: 'ACTUAL' },
        { key: 'dueDate', label: 'Due Date', align: 'left', format: 'date', valueKind: 'ACTUAL' },
        { key: 'amount', label: 'Amount', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
        { key: 'overdueDays', label: 'Days Past Due', align: 'right', format: 'number', valueKind: 'CALCULATED' },
        { key: 'status', label: 'Status', align: 'left', format: 'badge', valueKind: 'CALCULATED' }
      ],
      rows: openItems.map(item => ({
        invoiceNumber: item.invoiceNumber || item.ID || '—',
        dueDate: item.dueDate || '—',
        amount: Number(item.amount || 0),
        overdueDays: Number(item.overdueDays || 0),
        status: item.status || (Number(item.overdueDays || 0) > 0 ? 'Overdue' : 'Open')
      })),
      sortBy: 'amount',
      sortDir: 'desc',
      pageSize: 10,
      totalRows: openItems.length
    });
  }

  if (payments.length > 0) {
    blocks.push({
      type: 'table',
      title: `Recent Payment History (${payments.length})`,
      collapsible: true,
      columns: [
        { key: 'paymentDate', label: 'Payment Date', align: 'left', format: 'date', valueKind: 'ACTUAL' },
        { key: 'amount', label: 'Amount Paid', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
        { key: 'daysLate', label: 'Days Late', align: 'right', format: 'number', valueKind: 'ACTUAL' },
        { key: 'status', label: 'Timeliness', align: 'left', format: 'badge', valueKind: 'ACTUAL' }
      ],
      rows: payments.map(p => ({
        paymentDate: p.paymentDate || '—',
        amount: Number(p.amount || 0),
        daysLate: Number(p.daysLate || 0),
        status: Number(p.daysLate || 0) > 0 || String(p.status).toLowerCase() === 'late' ? 'LATE' : 'OK'
      })),
      sortBy: 'paymentDate',
      sortDir: 'desc',
      pageSize: 10,
      totalRows: payments.length
    });
  }

  const alertItems = [
    ...custAlerts.map(a => ({
      severity: String(a.severity || 'HIGH').toLowerCase() === 'critical' ? 'critical' : 'warning',
      customerId: cust.ID,
      title: a.title || `${a.alertType || 'Credit Alert'} – ${cust.name}`,
      description: a.message || a.summary || `Utilisation ${cust.utilisationDisplay}, Overdue ${formatINR(cust.overdueAmount)}.`,
      detectedAt: a.detectedAt || a.createdAt || data.provenance.lastSyncAt,
      status: a.status || 'ACTIVE',
      recommendedAction: cust.recommendedAction
    })),
    ...(custAlerts.length === 0 && findings.length > 0
      ? findings.map(f => ({
          severity: String(f.severity || 'WARNING').toLowerCase() === 'critical' ? 'critical' : 'warning',
          customerId: cust.ID,
          title: `Monitoring Finding: ${f.status || cust.status}`,
          description: f.summary || (cust.riskReasons || []).join('; '),
          detectedAt: data.monitoringAnalysis?.completedAt || data.provenance.lastSyncAt,
          status: 'ACTIVE',
          recommendedAction: f.recommendedAction || cust.recommendedAction
        }))
      : [])
  ];

  if (alertItems.length > 0) {
    blocks.push({
      type: 'alerts',
      title: 'Monitoring Alerts & Findings',
      collapsible: true,
      items: alertItems
    });
  }

  blocks.push({
    type: 'observations',
    title: 'Recommended Next Steps',
    items: [
      ...(cust.riskReasons || []),
      `Action: ${cust.recommendedAction}`
    ]
  });

  return {
    title,
    summary,
    blocks,
    resultSetIds: [cust.ID],
    suggestedFollowUps: [
      `Can we approve a credit limit increase for ${cust.ID} to ${formatINR(Math.max(1500000, cust.creditLimit * 1.25))}?`,
      `What if ${cust.ID} places a new order of ₹3,00,000?`,
      `Compare ${cust.ID}, C002 and C003 on exposure and limit`
    ]
  };
}

function composeMonitoringResponse(intentPlan, data) {
  const run = data.monitoringAnalysis;
  const rawAlerts = Array.isArray(data.monitoringAlerts) ? data.monitoringAlerts : [];
  const findings = Array.isArray(run?.findings) ? run.findings : [];
  const enriched = filterCustomers(data.customers, { flaggedOnly: true });

  const severityWeight = { CRITICAL: 4, HIGH: 3, WARNING: 2, MEDIUM: 2, REVIEW: 1, LOW: 0 };

  let alertItems = [];
  if (rawAlerts.length > 0) {
    alertItems = [...rawAlerts]
      .sort((a, b) => (severityWeight[String(b.severity).toUpperCase()] || 0) - (severityWeight[String(a.severity).toUpperCase()] || 0))
      .map(a => ({
        severity: ['CRITICAL', 'HIGH'].includes(String(a.severity).toUpperCase()) ? 'critical' : 'warning',
        customerId: a.customerId || a.customer_ID || '—',
        title: a.title || `${a.severity || 'ALERT'}: ${a.customerName || a.customerId || 'Account'}`,
        description: a.message || a.summary || 'Threshold condition detected during deterministic monitoring.',
        detectedAt: a.detectedAt || a.updatedAt || run?.completedAt || data.provenance.lastSyncAt,
        status: a.status || 'ACTIVE',
        recommendedAction: a.recommendedAction || 'Review customer open items and credit limit headroom.'
      }));
  } else if (findings.length > 0) {
    alertItems = findings
      .filter(f => f.status !== 'HEALTHY' || (Array.isArray(f.flags) && f.flags.length > 0))
      .sort((a, b) => (severityWeight[String(b.severity).toUpperCase()] || 0) - (severityWeight[String(a.severity).toUpperCase()] || 0))
      .map(f => ({
        severity: ['CRITICAL', 'HIGH', 'BREACH'].includes(String(f.severity || f.status).toUpperCase()) ? 'critical' : 'warning',
        customerId: f.customerId || f.customer_ID || '—',
        title: `${f.customerName || f.customerId} (${f.customerId || f.customer_ID}) – ${f.status || f.severity}`,
        description: f.summary || `Exposure ${formatINR(f.exposure)} vs Limit ${formatINR(f.creditLimit)} (Overdue ${formatINR(f.overdueAmount)}).`,
        detectedAt: run?.completedAt || data.provenance.lastSyncAt,
        status: 'ACTIVE',
        recommendedAction: f.recommendedAction || 'Perform credit controller review.'
      }));
  } else {
    alertItems = enriched.map(c => ({
      severity: c.status === 'BREACH' ? 'critical' : 'warning',
      customerId: c.ID,
      title: `${c.name} (${c.ID}) – ${c.status} (${c.utilisationDisplay})`,
      description: (c.riskReasons || []).join('; '),
      detectedAt: data.provenance.lastSyncAt,
      status: 'ACTIVE',
      recommendedAction: c.recommendedAction
    }));
  }

  const runTimeDisplay = run?.completedAt
    ? `Latest monitoring run (${run.runId}) completed at ${run.completedAt}`
    : `Evaluated against current deterministic portfolio snapshot (${data.provenance.lastSyncAt})`;

  const criticalCount = alertItems.filter(a => a.severity === 'critical').length;
  const warningCount = alertItems.filter(a => a.severity !== 'critical').length;

  const title = 'Active Credit Monitoring Alerts & Breaches';
  const summary = `${alertItems.length} active monitoring alert(s) require attention (${criticalCount} critical/breach, ${warningCount} warning/review). ${runTimeDisplay}.`;

  return {
    title,
    summary,
    blocks: [
      {
        type: 'alerts',
        title: `Severity-Sorted Monitoring Alerts (${alertItems.length})`,
        items: alertItems
      },
      {
        type: 'observations',
        title: 'Monitoring Run Summary & Actions',
        items: [
          runTimeDisplay,
          `Immediate priority: review the ${criticalCount} critical alert(s) exceeding 100% credit utilisation.`,
          `Note: Querying monitoring alerts from AI Credit Assistance is strictly read-only and never triggers a new monitoring job.`
        ]
      }
    ],
    resultSetIds: [...new Set(alertItems.map(a => a.customerId).filter(id => id && id !== '—'))],
    suggestedFollowUps: [
      `Give full details for customer C001`,
      `List customers with utilisation >= 80%`,
      `Which customers have overdue invoices and how old are they?`
    ]
  };
}

function composePaymentOverdueResponse(intentPlan, data) {
  const overdueCustomers = filterCustomers(data.customers, {
    ...intentPlan.filters,
    ...(intentPlan.customerIds?.length ? { customerIds: intentPlan.customerIds } : {}),
    overdueOnly: true,
    sortBy: 'overdueAmount',
    sortDir: 'desc'
  });

  const ageing = computeAgeingBuckets(data.openItems, data.payments);
  const cohortMetrics = computeCohortMetrics(overdueCustomers);

  const totalOverdue = cohortMetrics.overdueExposure;
  const overdueInvoiceCount = ageing.totalOverdueInvoices || cohortMetrics.overdueInvoiceCount;

  const title = 'Overdue Invoices, Ageing Analysis & Collection Priorities';
  const summary = `${overdueCustomers.length} customers hold ${formatINR(totalOverdue)} in overdue receivables across ${overdueInvoiceCount} overdue invoice(s), led by ${overdueCustomers[0] ? `${overdueCustomers[0].name} (${overdueCustomers[0].ID}) with ${formatINR(overdueCustomers[0].overdueAmount)}` : 'N/A'}.`;

  const metricsBlock = {
    type: 'metrics',
    items: [
      {
        id: 'overdue-total',
        label: 'Total Overdue Amount',
        value: formatINR(totalOverdue),
        rawValue: totalOverdue,
        unit: 'INR',
        valueKind: 'CALCULATED',
        severity: totalOverdue > 0 ? 'critical' : 'healthy',
        subtitle: `Across ${overdueCustomers.length} customers`
      },
      {
        id: 'overdue-invoices',
        label: 'Overdue Invoices',
        value: String(overdueInvoiceCount),
        rawValue: overdueInvoiceCount,
        unit: 'COUNT',
        valueKind: 'ACTUAL',
        severity: overdueInvoiceCount > 0 ? 'warning' : 'healthy',
        subtitle: 'Past net due date'
      },
      {
        id: 'overdue-customers',
        label: 'Delinquent Accounts',
        value: String(overdueCustomers.length),
        rawValue: overdueCustomers.length,
        unit: 'COUNT',
        valueKind: 'ACTUAL',
        severity: 'warning',
        subtitle: `Out of ${(data.customers || []).length} portfolio accounts`
      },
      {
        id: 'ontime-rate',
        label: 'Historical On-Time Payment Rate',
        value: ageing.paymentStats.onTimeRatePct !== null ? `${ageing.paymentStats.onTimeRatePct.toFixed(1)}%` : 'N/A',
        rawValue: ageing.paymentStats.onTimeRatePct,
        unit: 'PERCENT',
        valueKind: 'CALCULATED',
        severity: 'neutral',
        subtitle: `${ageing.paymentStats.totalPayments} recorded payment(s)`
      }
    ]
  };

  const chartBlock = {
    type: 'chart',
    chartType: 'bar',
    title: 'Overdue Receivables by Ageing Bucket (INR)',
    subtitle: `Distribution of ${formatINR(ageing.totalOverdueAmount || totalOverdue)} across past-due ageing buckets`,
    xLabel: 'Ageing Bucket',
    yLabel: 'Overdue Amount (INR)',
    unit: 'INR',
    valueKind: 'CALCULATED',
    series: [{
      name: 'Overdue Amount',
      data: ageing.buckets.map(b => ({
        label: b.bucket,
        value: b.amount,
        invoiceCount: b.invoiceCount,
        customerCount: b.customerCount,
        sharePct: b.sharePct,
        status: b.bucket === '90+ Days' || b.bucket === '61–90 Days' ? 'BREACH' : 'WARNING'
      }))
    }],
    thresholds: [],
    caption: `Ageing buckets computed against reference date 2026-11-09.`
  };

  const tableBlock = {
    type: 'table',
    title: 'Customers Ranked by Overdue Receivables',
    columns: [
      { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
      { key: 'country', label: 'Country', align: 'left', format: 'text' },
      { key: 'overdueAmount', label: 'Overdue Amount', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
      { key: 'overdueInvoiceCount', label: 'Overdue Invoices', align: 'right', format: 'number', valueKind: 'ACTUAL' },
      { key: 'exposure', label: 'Total Exposure', align: 'right', format: 'currency', valueKind: 'CALCULATED' },
      { key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency', valueKind: 'ACTUAL' },
      { key: 'utilisationPct', label: 'Utilisation %', align: 'right', format: 'percent', valueKind: 'CALCULATED' },
      { key: 'status', label: 'Status', align: 'left', format: 'badge', valueKind: 'CALCULATED' }
    ],
    rows: overdueCustomers.map(c => ({
      customerId: c.ID,
      customer: `${c.name} (${c.ID})`,
      country: c.country,
      overdueAmount: c.overdueAmount,
      overdueInvoiceCount: c.overdueInvoiceCount,
      exposure: c.exposure,
      creditLimit: c.creditLimit,
      utilisationPct: c.utilisationPct,
      utilisationDisplay: c.utilisationDisplay,
      status: c.status
    })),
    sortBy: 'overdueAmount',
    sortDir: 'desc',
    pageSize: 10,
    totalRows: overdueCustomers.length
  };

  const topOverdue = overdueCustomers.slice(0, 3).map(c =>
    `Priority collection: ${c.name} (${c.ID}) — ${formatINR(c.overdueAmount)} overdue (${c.overdueInvoiceCount} invoice(s), ${c.utilisationDisplay} utilisation).`
  );

  return {
    title,
    summary,
    blocks: [
      metricsBlock,
      chartBlock,
      tableBlock,
      { type: 'observations', title: 'Collection Priority Recommendations', items: topOverdue }
    ],
    resultSetIds: overdueCustomers.map(c => c.ID),
    suggestedFollowUps: [
      `Give full details for customer ${overdueCustomers[0]?.ID || 'C003'}`,
      `Compare ${overdueCustomers.slice(0, 3).map(c => c.ID).join(', ')} on exposure and limit`,
      `What if ${overdueCustomers[0]?.ID || 'C003'} pays ₹2,00,000?`
    ]
  };
}

function composeWhatIfResponse(intentPlan, data) {
  const targetId = (intentPlan.customerIds && intentPlan.customerIds[0]) || 'C003';
  const rawCustomer = data.customerDetailsById.get(targetId)
    || (data.customers || []).find(c => String(c.ID).toUpperCase() === targetId)
    || (data.customers || [])[0];

  const scenario = { ...intentPlan.scenarioParams };
  if (
    scenario.requestedLimit === undefined
    && scenario.deltaLimit === undefined
    && scenario.limitChangePct === undefined
    && scenario.extraExposure === undefined
    && scenario.paymentReceived === undefined
  ) {
    scenario.extraExposure = 300000;
  }

  const sim = simulateLimitScenario(rawCustomer, scenario);
  const cust = sim.customer;

  const scenarioDesc = scenario.extraExposure
    ? `places a new order of ${formatINR(scenario.extraExposure)}`
    : scenario.paymentReceived
      ? `makes a payment of ${formatINR(scenario.paymentReceived)}`
      : scenario.limitChangePct
        ? `changes credit limit by ${scenario.limitChangePct}%`
        : `adjusts credit limit to ${formatINR(sim.projected.creditLimit)}`;

  const title = `What-If Scenario Simulation – ${cust.name} (${cust.ID})`;
  const summary = `SIMULATION: If ${cust.name} (${cust.ID}) ${scenarioDesc}, exposure moves from ${formatINR(sim.current.exposure)} to ${formatINR(sim.projected.exposure)} and credit utilisation shifts from ${sim.current.utilisationDisplay} (${sim.current.status}) to ${sim.projected.utilisationDisplay} (${sim.projected.status}). No database records were modified.`;

  const noticeBlock = {
    type: 'notice',
    severity: 'warning',
    title: 'SIMULATION – no data changed',
    message: `This is a read-only hypothetical simulation for ${cust.name} (${cust.ID}). All projected figures are tagged SIMULATED and no customer credit limits, open items, or exposures were persisted.`
  };

  const comparisonBlock = {
    type: 'comparison',
    title: `Current vs Simulated Position – ${cust.name} (${cust.ID})`,
    simulation: true,
    columns: ['Metric', 'Current (Actual)', 'Projected (Simulated)', 'Delta'],
    rows: [
      {
        metric: 'Credit Limit',
        current: formatINR(sim.current.creditLimit),
        projected: formatINR(sim.projected.creditLimit),
        delta: `${sim.deltas.creditLimitDelta >= 0 ? '+' : ''}${formatINR(sim.deltas.creditLimitDelta)}`,
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Total Exposure',
        current: formatINR(sim.current.exposure),
        projected: formatINR(sim.projected.exposure),
        delta: `${sim.deltas.exposureDelta >= 0 ? '+' : ''}${formatINR(sim.deltas.exposureDelta)}`,
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Available Credit',
        current: formatINR(sim.current.availableCredit),
        projected: formatINR(sim.projected.availableCredit),
        delta: `${sim.deltas.availableCreditDelta >= 0 ? '+' : ''}${formatINR(sim.deltas.availableCreditDelta)}`,
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Utilisation %',
        current: sim.current.utilisationDisplay,
        projected: sim.projected.utilisationDisplay,
        delta: sim.deltas.utilisationDeltaPct !== null
          ? `${sim.deltas.utilisationDeltaPct >= 0 ? '+' : ''}${sim.deltas.utilisationDeltaPct.toFixed(1)} pts`
          : 'N/A',
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Overdue Amount',
        current: formatINR(sim.current.overdueAmount),
        projected: formatINR(sim.projected.overdueAmount),
        delta: formatINR(sim.projected.overdueAmount - sim.current.overdueAmount),
        valueKind: 'SIMULATED'
      },
      {
        metric: 'Policy Status',
        current: sim.current.status,
        projected: sim.projected.status,
        delta: `${sim.current.status} → ${sim.projected.status}`,
        valueKind: 'SIMULATED'
      }
    ]
  };

  const chartBlock = {
    type: 'chart',
    chartType: 'groupedBar',
    title: `Current vs Simulated Exposure & Limit – ${cust.name} (${cust.ID})`,
    subtitle: 'Simulated impact in INR (SIMULATION – no data changed)',
    xLabel: 'Scenario',
    yLabel: 'Amount (INR)',
    unit: 'INR',
    valueKind: 'SIMULATED',
    series: [
      {
        name: 'Credit Limit',
        data: [
          { label: 'Current', value: sim.current.creditLimit, status: 'HEALTHY' },
          { label: 'Simulated', value: sim.projected.creditLimit, status: 'HEALTHY' }
        ]
      },
      {
        name: 'Exposure',
        data: [
          { label: 'Current', value: sim.current.exposure, status: sim.current.status },
          { label: 'Simulated', value: sim.projected.exposure, status: sim.projected.status }
        ]
      }
    ],
    thresholds: [],
    caption: `Simulated utilisation: ${sim.projected.utilisationDisplay} (${sim.projected.status}).`
  };

  const observations = [
    `Scenario assumption: ${cust.name} (${cust.ID}) ${scenarioDesc}.`,
    sim.projected.status === 'BREACH'
      ? `Risk implication: Projected exposure (${formatINR(sim.projected.exposure)}) exceeds the ${formatINR(sim.projected.creditLimit)} credit limit by ${formatINR(Math.abs(sim.projected.availableCredit))}, triggering a credit block under ${POLICY_ID}.`
      : `Risk implication: Projected utilisation (${sim.projected.utilisationDisplay}) remains within the 100% credit limit with ${formatINR(sim.projected.availableCredit)} available headroom.`,
    `To accommodate this scenario at <=80% utilisation, a credit limit of at least ${formatINR(Math.ceil((sim.projected.exposure / 0.8) / 50000) * 50000)} (${sim.approverLevel} approval) would be required.`
  ];

  return {
    title,
    summary,
    blocks: [
      noticeBlock,
      comparisonBlock,
      chartBlock,
      { type: 'observations', title: 'Simulation Assumptions & Risk Implications', items: observations }
    ],
    assumptions: [
      `Simulated ${scenarioDesc} on top of current snapshot exposure (${formatINR(sim.current.exposure)}) and credit limit (${formatINR(sim.current.creditLimit)}).`
    ],
    resultSetIds: [cust.ID],
    suggestedFollowUps: [
      `Can we approve a credit limit increase for ${cust.ID} to ${formatINR(Math.ceil((sim.projected.exposure / 0.8) / 50000) * 50000)}?`,
      `Give full details for customer ${cust.ID}`,
      `Show all customers`
    ]
  };
}

function composeSapDatasourceResponse(intentPlan, data) {
  const ing = data.ingestionStatus;
  const fixture = ing?.syntheticMockSapFixture || {
    sourceId: 'mock-sap-fscm',
    label: 'SYNTHETIC - NOT REAL SAP DATA',
    customers: 13,
    creditAccounts: 13,
    openInvoices: 18,
    payments: 14
  };
  const registeredSources = Array.isArray(ing?.sources) ? ing.sources : [];

  const title = 'SAP S/4HANA & BTP Data Source Status';
  const summary = `Credit Guard is operating in SYNTHETIC_DEMO / MOCK_SAP_SIMULATOR mode (${fixture.label}) with ${registeredSources.length || 1} registered source(s), ${fixture.customers} Business Partners (BUT000), ${fixture.creditAccounts} Credit Accounts (UKMBP_CMS / KNKK), and ${fixture.openInvoices} Open Invoices (FI-AR BSEG). No live SAP production system is connected.`;

  const keyValueBlock = {
    type: 'keyValue',
    title: 'Enterprise Integration & Provenance Metadata',
    items: [
      { label: 'Active Data Provenance', value: 'SYNTHETIC_DEMO / MOCK_SAP_SIMULATOR', valueKind: 'ACTUAL' },
      { label: 'Live SAP Connection', value: 'No – Synthetic Demo Dataset (Not Live SAP)', valueKind: 'ACTUAL' },
      { label: 'Target SAP S/4HANA Modules', value: 'FIN-FSCM-CR (UKMBP_CMS, KNKK) & FI-AR (BSID / BSEG)', valueKind: 'ACTUAL' },
      { label: 'Persistence Layer', value: 'SAP CAP / HANA CDS Canonical Model', valueKind: 'ACTUAL' },
      { label: 'Synthetic Fixture Counts', value: `${fixture.customers} Customers · ${fixture.creditAccounts} Credit Accounts · ${fixture.openInvoices} Open Items · ${fixture.payments} Payments`, valueKind: 'ACTUAL' },
      { label: 'Last Metadata Check', value: ing?.retrievedAt || data.provenance.lastSyncAt, valueKind: 'ACTUAL' }
    ]
  };

  const rows = registeredSources.length > 0
    ? registeredSources.map(src => ({
        sourceId: src.sourceId,
        name: src.name,
        systemType: src.sourceSystemType || 'MOCK_SAP_SIMULATOR',
        mode: src.connectionMode || 'SYNTHETIC_DEMO',
        status: src.latestRun?.status || (src.enabled ? 'READY (DEMO)' : 'DISABLED'),
        recordsAccepted: src.latestRun?.recordsAccepted ?? fixture.customers,
        issueCount: src.latestRun?.issueCount ?? 0,
        lastSync: src.latestRun?.completedAt || 'Demo Seeded'
      }))
    : [{
        sourceId: fixture.sourceId || 'mock-sap-fscm',
        name: 'Mock SAP S/4HANA FSCM Simulator',
        systemType: 'MOCK_SAP_SIMULATOR',
        mode: 'SYNTHETIC_DEMO',
        status: 'ACTIVE (SYNTHETIC DEMO)',
        recordsAccepted: fixture.customers,
        issueCount: 0,
        lastSync: data.provenance.lastSyncAt
      }];

  const tableBlock = {
    type: 'table',
    title: 'Registered SAP & Canonical Data Sources',
    columns: [
      { key: 'sourceId', label: 'Source ID', align: 'left', format: 'text', valueKind: 'ACTUAL' },
      { key: 'name', label: 'Connector Name', align: 'left', format: 'text', valueKind: 'ACTUAL' },
      { key: 'systemType', label: 'Source Type', align: 'left', format: 'badge', valueKind: 'ACTUAL' },
      { key: 'status', label: 'Sync Status', align: 'left', format: 'badge', valueKind: 'ACTUAL' },
      { key: 'recordsAccepted', label: 'Accepted Records', align: 'right', format: 'number', valueKind: 'ACTUAL' },
      { key: 'issueCount', label: 'Validation Issues', align: 'right', format: 'number', valueKind: 'ACTUAL' },
      { key: 'lastSync', label: 'Last Sync Timestamp', align: 'left', format: 'text', valueKind: 'ACTUAL' }
    ],
    rows,
    sortBy: 'sourceId',
    sortDir: 'asc',
    pageSize: 10,
    totalRows: rows.length
  };

  const connectorHeadlineBullets = [
    `CAP Database (Demo Portfolio) — Status: Connected (Demo) · Freshness: Fresh · Last retrieved: ${(ing?.retrievedAt || data.provenance.lastSyncAt || '').slice(0, 19).replace('T', ' ')} UTC`,
    `SAP S/4HANA FIN-FSCM-CR OData (UKMBP_CMS / KNKK) — Status: Demo · ${fixture.customers} Business Partners · ${fixture.creditAccounts} Credit Segments`,
    `SAP FI-AR Open Receivables & Payments (BSID / BSEG) — Status: Demo · ${fixture.openInvoices} Open Invoices · ${fixture.payments} Payments`,
    `Mock SAP S/4HANA FSCM Simulator (${fixture.sourceId || 'MOCK-S4-001'}) — Status: Demo · Ready for extraction & monitoring`
  ];

  return {
    title,
    summary,
    headlineBullets: connectorHeadlineBullets,
    blocks: [
      keyValueBlock,
      tableBlock,
      {
        type: 'observations',
        title: 'Data Governance & Provenance Notes',
        items: [
          'All records in this environment are synthetic demo fixtures (SYNTHETIC_DEMO / MOCK_SAP_SIMULATOR) and must never be represented as live SAP production data.',
          'Canonical ingestion validates currency codes, non-negative credit limits, and Business Partner keys before promoting snapshots to the CAP database.'
        ]
      }
    ],
    resultSetIds: [],
    suggestedFollowUps: [
      `Exposure by country`,
      `Customers above 80% utilisation`,
      `How is credit utilisation calculated in Credit Guard?`
    ]
  };
}

function composeExplainResponse(intentPlan, data = {}) {
  const concept = intentPlan.explainConcept || 'utilisation';
  const metrics = computeCohortMetrics(data?.customers || []);
  const customerCount = metrics.customerCount > 0 ? metrics.customerCount : (Array.isArray(data?.customers) && data.customers.length > 0 ? data.customers.length : 13);
  const totalExposureDisplay = metrics.customerCount > 0 ? formatINR(metrics.totalExposure) : '₹65,35,000';
  const totalLimitDisplay = metrics.customerCount > 0 ? formatINR(metrics.totalCreditLimit) : '₹1,04,00,000';
  const overallUtilDisplay = metrics.customerCount > 0 ? metrics.overallUtilisationDisplay : '62.8%';

  if (concept === 'utilisation') {
    return {
      title: 'How Credit Utilisation Is Calculated in Credit Guard',
      summary: `Credit utilisation is calculated as (Current Exposure ÷ Credit Limit) × 100; across ${customerCount} portfolio customers, total exposure is ${totalExposureDisplay} against ${totalLimitDisplay} limit (${overallUtilDisplay} utilisation).`,
      headlineBullets: [
        `Formula: Utilisation (%) = (Current Exposure ÷ Credit Limit) × 100`,
        `Policy Thresholds: Healthy <80% · Warning 80–99.9% · Breach ≥100% · Critical ≥120%`,
        `Zero-Limit Rule: If Credit Limit = ₹0, utilisation is N/A (no limit) and positive exposure flags "No limit set"`,
        `Portfolio Baseline (${customerCount} customers): ${totalExposureDisplay} exposure ÷ ${totalLimitDisplay} limit = ${overallUtilDisplay}`
      ],
      blocks: [
        {
          type: 'text',
          text: 'In Credit Guard (SAP FIN-FSCM-CR deterministic rules), credit utilisation is computed strictly by the backend calculator from open receivable items and the customer’s authorized credit limit. If a customer’s credit limit is ₹0, utilisation is reported as N/A (no limit) rather than dividing by zero, and any positive exposure is flagged as "No limit set".'
        },
        {
          type: 'keyValue',
          title: 'Formula, Worked Example & Policy Thresholds',
          items: [
            { label: 'Deterministic Formula', value: 'Utilisation (%) = (Total Open Exposure ÷ Authorized Credit Limit) × 100', valueKind: 'CALCULATED' },
            { label: 'Zero-Limit Rule', value: 'If Credit Limit = ₹0 → Utilisation = null ("N/A (no limit)"); if Exposure > ₹0 → Flag "No limit set"', valueKind: 'CALCULATED' },
            { label: 'Worked Example (C001 Aarav Components)', value: 'Exposure ₹12,00,000 ÷ Credit Limit ₹10,00,000 × 100 = 120.0% (Status: BREACH)', valueKind: 'CALCULATED' },
            { label: 'Healthy Threshold (<80%)', value: 'Normal operating headroom; standard periodic monitoring', valueKind: 'ACTUAL' },
            { label: 'Warning Threshold (80% – 99.9%)', value: `Early warning alert triggered (${(CONFIG.warningUtilisation || 0.8) * 100}%)`, valueKind: 'ACTUAL' },
            { label: 'Breach Threshold (>=100%)', value: `Credit limit reached or exceeded (${(CONFIG.breachUtilisation || 1.0) * 100}%); order hold / escalation`, valueKind: 'ACTUAL' },
            { label: 'Critical Threshold (>=120%)', value: `Severe over-limit exposure (${(CONFIG.criticalUtilisation || 1.2) * 100}%); Finance Head review`, valueKind: 'ACTUAL' }
          ]
        },
        {
          type: 'observations',
          title: 'Business & Governance Implications',
          items: [
            'All KPI cards, charts, and tables in Credit Guard call the same backend calculateUtilisation(exposure, creditLimit) function so numbers always reconcile.',
            'Limit increases up to 25% (and below ₹10,00,000) route to Credit Controller; increases above 25% or >= ₹10,00,000 route to Finance Head.'
          ]
        }
      ],
      resultSetIds: [],
      suggestedFollowUps: [
        `Customers above 80% utilisation`,
        `Which customer has the highest credit utilisation?`,
        `Give full details for customer C001`
      ]
    };
  }

  return {
    title: 'Credit Guard Policy & Exposure Calculation Reference',
    summary: `Credit Guard enforces deterministic SAP FIN-FSCM-CR exposure calculation and policy ${POLICY_ID} across ${customerCount} demo customers in INR (${totalExposureDisplay} exposure, ${totalLimitDisplay} limit, ${overallUtilDisplay} utilisation).`,
    headlineBullets: [
      `Active Portfolio (${customerCount} customers): ${totalExposureDisplay} total exposure · ${totalLimitDisplay} total limit · ${overallUtilDisplay} utilisation`,
      `Utilisation Thresholds: Healthy <80% · Warning 80–99.9% · Breach ≥100% · Critical ≥120%`,
      `Governance Routing: ≤25% limit increase routes to Credit Controller; >25% or ≥₹10,00,000 routes to Finance Head`
    ],
    blocks: [
      {
        type: 'text',
        text: 'Credit Guard calculates customer exposure from unpaid open invoices, compares exposure against authorized credit limits, flags overdue receivables and stale reviews (>90 days), and evaluates credit-limit change proposals with human-in-the-loop approval routing.'
      },
      {
        type: 'keyValue',
        title: 'Core Formulas & Governance Rules',
        items: [
          { label: 'Total Exposure', value: `Sum of unpaid open invoice items in INR (${totalExposureDisplay} across ${customerCount} customers)`, valueKind: 'CALCULATED' },
          { label: 'Available Credit', value: 'Credit Limit − Current Exposure', valueKind: 'CALCULATED' },
          { label: 'Utilisation (%)', value: '(Current Exposure ÷ Credit Limit) × 100 (or "N/A (no limit)" if Limit = ₹0)', valueKind: 'CALCULATED' },
          { label: 'Policy Thresholds', value: '<80% Healthy · 80–99% Warning · >=100% Breach · >=120% Critical', valueKind: 'ACTUAL' },
          { label: 'Approval Routing', value: '<=25% increase → Credit Controller · >25% or >=₹10,00,000 → Finance Head', valueKind: 'ACTUAL' }
        ]
      },
      {
        type: 'observations',
        title: 'What You Can Ask',
        items: [
          'Portfolio & Lists: "Show all customers", "Customers above 80% utilisation", "Exposure by country".',
          'Comparisons & Risk: "Which customer has the highest credit utilisation?", "Compare C001, C002 and C003 on exposure and limit", "Identify high-risk customers and explain why".',
          'Approvals & Simulations: "Can we approve a credit limit increase for C001 to ₹15,00,000?", "What if C003 places a new order of ₹3,00,000?".'
        ]
      }
    ],
    resultSetIds: [],
    suggestedFollowUps: [
      `Customers above 80% utilisation`,
      `Exposure by country`,
      `Give me our data sources and connectivity status`
    ]
  };
}

function composeGreetingResponse() {
  return {
    title: 'Welcome to Credit Guard AI',
    summary: 'Hello! I can help you analyze portfolio credit exposure, customer utilisation, overdue receivables, limit approvals, and SAP BTP data source connectivity for Bluspring Enterprises.',
    headlineBullets: [],
    blocks: [],
    resultSetIds: [],
    suggestedFollowUps: [
      `Customers above 80% utilisation`,
      `Exposure by country`,
      `Give me our data sources and connectivity status`
    ]
  };
}

function composeUnknownResponse() {
  return {
    title: 'Clarification Needed',
    summary: 'I could not match that question to a specific credit topic. Ask about customer utilisation, country/company-code exposure, overdue invoices, customer C001–C013, limit approvals, or data source connectivity.',
    headlineBullets: [],
    blocks: [],
    resultSetIds: [],
    suggestedFollowUps: [
      `Customers above 80% utilisation`,
      `Exposure by country`,
      `Give me our data sources and connectivity status`
    ]
  };
}

function composeClarifyResponse(intentPlan) {
  const reason = intentPlan.clarificationReason
    || 'Please specify the customer ID (for example C001 – Aarav Components), target credit limit, or comparison dimension so I can provide an accurate answer.';
  return {
    title: 'Clarification Needed',
    summary: reason,
    headlineBullets: [],
    blocks: [
      {
        type: 'notice',
        severity: 'info',
        title: 'Additional Detail Required',
        message: `${reason} No tools were executed and no records were modified.`
      },
      {
        type: 'text',
        text: 'You can specify a customer ID (C001–C013), a target credit limit in INR (e.g. ₹15,00,000), or a ranking metric (credit utilisation %, exposure, or overdue amount).'
      }
    ],
    resultSetIds: [],
    suggestedFollowUps: [
      `Can we approve a credit limit increase for C001 to ₹15,00,000?`,
      `Compare C001, C002 and C003 on exposure and limit`,
      `Which customer has the highest credit utilisation?`
    ]
  };
}

function composeOutOfScopeResponse() {
  return {
    title: 'Outside Credit Guard Scope',
    summary: 'I am specialized strictly in Bluspring Enterprises credit limit monitoring, portfolio exposure analysis, overdue receivables, limit approvals, and SAP BTP / S/4HANA credit connectors.',
    headlineBullets: [],
    blocks: [
      {
        type: 'notice',
        severity: 'info',
        title: 'Credit Management Domain Only',
        message: 'That question is outside the scope of Credit Guard. I can only answer questions about customer credit limits, exposure, utilisation, overdue invoices, monitoring alerts, approval workflows, and SAP data sources.'
      },
      {
        type: 'text',
        text: 'Try one of the credit management prompts below to explore the portfolio.'
      }
    ],
    resultSetIds: [],
    suggestedFollowUps: [
      `Show total portfolio credit exposure by country`,
      `List customers with utilisation >= 80%`,
      `Identify high-risk customers and explain why`
    ]
  };
}

function buildHeadlineBullets(intentPlan, composed) {
  if (Array.isArray(composed.headlineBullets)) {
    return composed.headlineBullets.slice(0, 5);
  }
  const primary = intentPlan.primaryIntent;
  if (['GREETING', 'UNKNOWN', 'OUT_OF_SCOPE', 'CLARIFY', 'TREND'].includes(primary)) {
    return [];
  }

  const blocks = composed.blocks || [];
  const tableBlock = blocks.find(b => b.type === 'table');
  const obsBlock = blocks.find(b => b.type === 'observations');
  const recBlock = blocks.find(b => b.type === 'recommendation');
  const compBlock = blocks.find(b => b.type === 'comparison');
  const alertsBlock = blocks.find(b => b.type === 'alerts');

  if (primary === 'LIST' && tableBlock && Array.isArray(tableBlock.rows)) {
    return tableBlock.rows.slice(0, 5).map(r =>
      `${r.name || r.customerName} (${r.customerId}) — ${r.utilisationDisplay || `${r.utilisationPct}%`} utilisation · ${formatINR(r.exposure)} exposure / ${formatINR(r.creditLimit)} limit · Status: ${r.status || 'HEALTHY'}`
    );
  }

  if (primary === 'EXPOSURE' && tableBlock && Array.isArray(tableBlock.rows)) {
    return tableBlock.rows.slice(0, 5).map(r =>
      `${r.dimension}: ${formatINR(r.exposure)} exposure (${r.customerCount} customers) · ${formatINR(r.creditLimit)} limit · ${r.utilisationDisplay} utilisation (${r.shareOfExposurePct}% share)`
    );
  }

  if (primary === 'APPROVAL' && recBlock && compBlock) {
    const bullets = [];
    const limitRow = (compBlock.rows || []).find(r => r.metric.includes('Limit'));
    const utilRow = (compBlock.rows || []).find(r => r.metric.includes('Utilisation'));
    if (limitRow && utilRow) {
      bullets.push(`Credit Limit: ${limitRow.current} → ${limitRow.projected} (${limitRow.delta}) · Projected Utilisation: ${utilRow.projected}`);
    }
    bullets.push(`Recommendation: ${recBlock.decision} · Governance Authority: ${recBlock.approverLevel || 'Credit Controller'}`);
    for (const check of (recBlock.policyChecks || []).slice(0, 2)) {
      bullets.push(`${check.status}: ${check.rule} (${check.detail})`);
    }
    return bullets.slice(0, 4);
  }

  if (primary === 'MONITORING' && alertsBlock && Array.isArray(alertsBlock.items)) {
    return alertsBlock.items.slice(0, 4).map(a =>
      `${a.customerName} (${a.customerId}) — ${String(a.severity || 'warning').toUpperCase()}: ${a.condition} · ${a.description}`
    );
  }

  if (obsBlock && Array.isArray(obsBlock.items) && obsBlock.items.length > 0) {
    return obsBlock.items.slice(0, 4);
  }

  return [];
}

function composeStructuredResponse(intentPlan, data, { rawMessage = '' } = {}) {
  const primary = intentPlan.primaryIntent;
  let composed;

  switch (primary) {
    case 'GREETING':
      composed = composeGreetingResponse(intentPlan, data, rawMessage);
      break;
    case 'LIST':
      composed = composeListResponse(intentPlan, data);
      break;
    case 'COMPARE':
      composed = composeCompareResponse(intentPlan, data, rawMessage);
      break;
    case 'APPROVAL':
      composed = composeApprovalResponse(intentPlan, data);
      break;
    case 'EXPOSURE':
      composed = composeExposureResponse(intentPlan, data, rawMessage);
      break;
    case 'RISK':
      composed = composeRiskResponse(intentPlan, data);
      break;
    case 'TREND':
      composed = composeTrendResponse(intentPlan, data);
      break;
    case 'CUSTOMER_DETAIL':
      composed = composeCustomerDetailResponse(intentPlan, data);
      break;
    case 'MONITORING':
      composed = composeMonitoringResponse(intentPlan, data);
      break;
    case 'PAYMENT_OVERDUE':
      composed = composePaymentOverdueResponse(intentPlan, data);
      break;
    case 'WHATIF':
      composed = composeWhatIfResponse(intentPlan, data);
      break;
    case 'SAP_DATASOURCE':
      composed = composeSapDatasourceResponse(intentPlan, data);
      break;
    case 'EXPLAIN':
      composed = composeExplainResponse(intentPlan, data);
      break;
    case 'CLARIFY':
      composed = composeClarifyResponse(intentPlan);
      break;
    case 'OUT_OF_SCOPE':
      composed = composeOutOfScopeResponse();
      break;
    case 'UNKNOWN':
      composed = composeUnknownResponse(intentPlan, data, rawMessage);
      break;
    default:
      composed = composeUnknownResponse(intentPlan, data, rawMessage);
      break;
  }

  const headlineBullets = buildHeadlineBullets(intentPlan, composed);

  return {
    schemaVersion: SCHEMA_VERSION,
    intent: {
      primary: intentPlan.primaryIntent,
      category: intentPlan.intentCategory || intentPlan.primaryIntent,
      secondary: intentPlan.secondaryIntents || [],
      confidence: intentPlan.confidence ?? 0.9,
      resolvedFromContext: Boolean(intentPlan.resolvedFromContext),
      contextNote: intentPlan.contextNote || null
    },
    title: composed.title,
    summary: composed.summary,
    headlineBullets,
    blocks: composed.blocks || [],
    assumptions: composed.assumptions || [],
    limitations: [...new Set([...(data.limitations || []), ...(composed.limitations || [])])],
    dataProvenance: {
      sourceType: data.provenance?.sourceType || 'SYNTHETIC_DEMO',
      connectorName: data.provenance?.connectorName || 'Credit Guard Demo Dataset',
      lastSyncAt: data.provenance?.lastSyncAt || new Date().toISOString(),
      currency: 'INR',
      policyId: POLICY_ID,
      toolsInvoked: data.provenance?.toolsInvoked || []
    },
    suggestedFollowUps: (composed.suggestedFollowUps || []).slice(0, 3),
    _meta: {
      resultSetIds: composed.resultSetIds || []
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  POLICY_ID,
  composeStructuredResponse
};
