const { calculateUtilisation, formatINR } = require('./calculators');
const { VALID_INTENTS } = require('./intentClassifier');

const ALLOWED_BLOCK_TYPES = new Set([
  'text',
  'metrics',
  'table',
  'chart',
  'alerts',
  'keyValue',
  'comparison',
  'recommendation',
  'observations',
  'notice'
]);

const ALLOWED_VALUE_KINDS = new Set(['ACTUAL', 'CALCULATED', 'SIMULATED']);
const ALLOWED_SOURCE_TYPES = new Set(['SYNTHETIC_DEMO', 'MOCK_SAP_SIMULATOR', 'FILE_IMPORT', 'HANA_CLOUD']);

function stripMarkdownSyntax(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateAndRepairZeroLimitRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (Object.hasOwn(row, 'creditLimit') && Number(row.creditLimit) <= 0) {
    const exp = Number(row.exposure || 0);
    const util = calculateUtilisation(exp, 0);
    row.utilisationPct = util.utilisationPct; // null
    row.utilisationDisplay = util.display; // 'N/A (no limit)'
    row.isNoLimit = true;
    if (exp > 0) {
      row.status = 'BREACH';
      const existingFlags = String(row.flags || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!existingFlags.includes('No limit set')) existingFlags.unshift('No limit set');
      row.flags = existingFlags.join(', ');
    }
  } else if (Object.hasOwn(row, 'utilisationPct')) {
    if (!Number.isFinite(Number(row.utilisationPct)) && row.utilisationPct !== null) {
      const util = calculateUtilisation(row.exposure, row.creditLimit);
      row.utilisationPct = util.utilisationPct;
      row.utilisationDisplay = util.display;
    }
  }
  return row;
}

function checkReconciliation(response) {
  const issues = [];
  if (!response || !Array.isArray(response.blocks)) {
    return { ok: false, issues: ['Response blocks array is missing.'] };
  }

  const metricsBlock = response.blocks.find(b => b && b.type === 'metrics');
  const tableBlock = response.blocks.find(b => b && b.type === 'table');
  const chartBlock = response.blocks.find(b => b && b.type === 'chart');

  // 1. Check pure LIST visual budget rule
  if (response.intent?.primary === 'LIST' && (!response.intent.secondary || response.intent.secondary.length === 0)) {
    if (metricsBlock) issues.push('Pure LIST response must not contain a metrics (KPI) block.');
    if (chartBlock) issues.push('Pure LIST response must not contain a chart block.');
  }

  // 2. Check table rows for NaN / Infinity or zero-limit division errors
  if (tableBlock && Array.isArray(tableBlock.rows)) {
    for (const row of tableBlock.rows) {
      if (row.creditLimit !== undefined && Number(row.creditLimit) <= 0 && row.utilisationPct !== null) {
        issues.push(`Customer ${row.customerId || row.customer || ''} has creditLimit=0 but non-null utilisationPct.`);
      }
      if (typeof row.utilisationPct === 'number' && !Number.isFinite(row.utilisationPct)) {
        issues.push('Table row contains NaN or Infinity utilisationPct.');
      }
    }
  }

  // 3. Reconcile metrics block totals against table rows when both represent portfolio/cohort exposure
  if (metricsBlock && tableBlock && Array.isArray(tableBlock.rows) && tableBlock.rows.length > 0) {
    const rowsHaveExposure = tableBlock.rows.every(r => Object.hasOwn(r, 'exposure'));
    const expMetric = (metricsBlock.items || []).find(item => item.id === 'total-exposure' || item.id === 'risk-exposure');
    if (rowsHaveExposure && expMetric && Number.isFinite(Number(expMetric.rawValue))) {
      const tableExposureSum = Math.round(tableBlock.rows.reduce((sum, r) => sum + Number(r.exposure || 0), 0));
      const metricExposureVal = Math.round(Number(expMetric.rawValue));
      if (Math.abs(tableExposureSum - metricExposureVal) > 5) {
        issues.push(`Metrics exposure (${metricExposureVal}) does not reconcile with table exposure sum (${tableExposureSum}).`);
      }
    }

    const rowsHaveLimit = tableBlock.rows.every(r => Object.hasOwn(r, 'creditLimit'));
    const limitMetric = (metricsBlock.items || []).find(item => item.id === 'total-limit');
    if (rowsHaveLimit && limitMetric && Number.isFinite(Number(limitMetric.rawValue))) {
      const tableLimitSum = Math.round(tableBlock.rows.reduce((sum, r) => sum + Number(r.creditLimit || 0), 0));
      const metricLimitVal = Math.round(Number(limitMetric.rawValue));
      if (Math.abs(tableLimitSum - metricLimitVal) > 5) {
        issues.push(`Metrics credit limit (${metricLimitVal}) does not reconcile with table credit limit sum (${tableLimitSum}).`);
      }
    }
  }

  // 4. Reconcile summary customer count against table.totalRows for LIST
  if (response.intent?.primary === 'LIST' && tableBlock && typeof response.summary === 'string') {
    const countMatch = response.summary.match(/\bFound\s+(\d+)\s+customers?\b/i);
    if (countMatch && Number(countMatch[1]) !== tableBlock.rows.length) {
      issues.push(`Summary customer count (${countMatch[1]}) does not match table row count (${tableBlock.rows.length}).`);
    }
  }

  // 5. Check recommendation safety
  for (const block of response.blocks) {
    if (block?.type === 'recommendation' && block.executed !== false) {
      issues.push('Recommendation block must have executed: false.');
    }
  }

  // 6. Check provenance safety
  if (!ALLOWED_SOURCE_TYPES.has(response.dataProvenance?.sourceType)) {
    issues.push(`Unsupported or prohibited dataProvenance.sourceType: ${response.dataProvenance?.sourceType}.`);
  }

  return { ok: issues.length === 0, issues };
}

function repairStructuredResponse(response) {
  if (!response || typeof response !== 'object') return null;
  const repaired = structuredClone ? structuredClone(response) : JSON.parse(JSON.stringify(response));

  repaired.schemaVersion = '1.0';
  if (!repaired.intent || typeof repaired.intent !== 'object') {
    repaired.intent = { primary: 'UNKNOWN', secondary: [], confidence: 0.8, resolvedFromContext: false };
  }
  if (!VALID_INTENTS.includes(repaired.intent.primary)) {
    repaired.intent.primary = 'UNKNOWN';
  }
  repaired.intent.secondary = Array.isArray(repaired.intent.secondary) ? repaired.intent.secondary : [];

  repaired.title = stripMarkdownSyntax(repaired.title || 'Credit Guard Analysis');
  repaired.summary = stripMarkdownSyntax(repaired.summary || 'Deterministic credit analysis completed.');
  repaired.headlineBullets = Array.isArray(repaired.headlineBullets)
    ? repaired.headlineBullets.map(stripMarkdownSyntax).filter(Boolean).slice(0, 5)
    : [];
  repaired.assumptions = Array.isArray(repaired.assumptions) ? repaired.assumptions.map(stripMarkdownSyntax) : [];
  repaired.limitations = Array.isArray(repaired.limitations) ? repaired.limitations.map(stripMarkdownSyntax) : [];

  if (!repaired.dataProvenance || typeof repaired.dataProvenance !== 'object') {
    repaired.dataProvenance = {};
  }
  if (!ALLOWED_SOURCE_TYPES.has(repaired.dataProvenance.sourceType)) {
    repaired.dataProvenance.sourceType = 'SYNTHETIC_DEMO';
  }
  repaired.dataProvenance.currency = 'INR';
  repaired.dataProvenance.policyId = repaired.dataProvenance.policyId || 'FIN-FSCM-AUTONOMOUS-POLICY-V1';
  repaired.dataProvenance.toolsInvoked = Array.isArray(repaired.dataProvenance.toolsInvoked)
    ? repaired.dataProvenance.toolsInvoked
    : [];

  // Filter to whitelisted blocks and enforce visual budget
  let metricsSeen = 0;
  let chartsSeen = 0;
  const isPureList = repaired.intent.primary === 'LIST' && repaired.intent.secondary.length === 0;

  const validBlocks = [];
  for (const block of (Array.isArray(repaired.blocks) ? repaired.blocks : [])) {
    if (!block || !ALLOWED_BLOCK_TYPES.has(block.type)) continue;
    if (isPureList && (block.type === 'metrics' || block.type === 'chart')) {
      continue;
    }
    if (block.type === 'metrics') {
      metricsSeen += 1;
      if (metricsSeen > 1) continue;
      block.items = (Array.isArray(block.items) ? block.items : []).slice(0, 4).map(item => ({
        ...item,
        label: stripMarkdownSyntax(item.label || ''),
        valueKind: ALLOWED_VALUE_KINDS.has(item.valueKind) ? item.valueKind : 'CALCULATED'
      }));
    }
    if (block.type === 'chart') {
      chartsSeen += 1;
      if (chartsSeen > 1) continue;
      block.valueKind = ALLOWED_VALUE_KINDS.has(block.valueKind) ? block.valueKind : 'CALCULATED';
    }
    if (block.type === 'table') {
      block.rows = (Array.isArray(block.rows) ? block.rows : []).map(validateAndRepairZeroLimitRow);
      block.totalRows = block.rows.length;
      block.pageSize = Number.isInteger(block.pageSize) && block.pageSize > 0 ? block.pageSize : 10;
    }
    if (block.type === 'recommendation') {
      block.executed = false;
      block.advisoryNote = stripMarkdownSyntax(block.advisoryNote || 'Advisory only; human approval is required.');
    }
    if (block.type === 'text') {
      block.text = stripMarkdownSyntax(block.text || '');
    }
    if (block.type === 'observations') {
      block.items = (Array.isArray(block.items) ? block.items : []).map(stripMarkdownSyntax).filter(Boolean);
    }
    if (block.type === 'notice') {
      block.title = stripMarkdownSyntax(block.title || 'Notice');
      block.message = stripMarkdownSyntax(block.message || '');
    }
    validBlocks.push(block);
  }
  repaired.blocks = validBlocks;

  // Reconcile metrics against table if mismatched
  const metricsBlock = repaired.blocks.find(b => b.type === 'metrics');
  const tableBlock = repaired.blocks.find(b => b.type === 'table');
  if (metricsBlock && tableBlock && Array.isArray(tableBlock.rows) && tableBlock.rows.length > 0) {
    const rowsHaveExposure = tableBlock.rows.every(r => Object.hasOwn(r, 'exposure'));
    if (rowsHaveExposure) {
      const tableExposureSum = Math.round(tableBlock.rows.reduce((sum, r) => sum + Number(r.exposure || 0), 0));
      for (const item of metricsBlock.items || []) {
        if ((item.id === 'total-exposure' || item.id === 'risk-exposure') && Math.abs(Number(item.rawValue || 0) - tableExposureSum) > 5) {
          item.rawValue = tableExposureSum;
          item.value = formatINR(tableExposureSum);
          repaired.limitations.push('Reconciled KPI total exposure to match the filtered table rows.');
        }
      }
    }
    const rowsHaveLimit = tableBlock.rows.every(r => Object.hasOwn(r, 'creditLimit'));
    if (rowsHaveLimit) {
      const tableLimitSum = Math.round(tableBlock.rows.reduce((sum, r) => sum + Number(r.creditLimit || 0), 0));
      for (const item of metricsBlock.items || []) {
        if (item.id === 'total-limit' && Math.abs(Number(item.rawValue || 0) - tableLimitSum) > 5) {
          item.rawValue = tableLimitSum;
          item.value = formatINR(tableLimitSum);
          repaired.limitations.push('Reconciled KPI total credit limit to match the filtered table rows.');
        }
      }
    }
  }

  // Reconcile LIST summary count with table rows
  if (repaired.intent.primary === 'LIST' && tableBlock && typeof repaired.summary === 'string') {
    repaired.summary = repaired.summary.replace(
      /\bFound\s+\d+\s+customers?\b/i,
      `Found ${tableBlock.rows.length} ${tableBlock.rows.length === 1 ? 'customer' : 'customers'}`
    );
  }

  return repaired;
}

function buildSafeFallbackResponse(rawSummary, intentPlan = {}, provenance = {}, reason = 'Structured block validation failed.') {
  const safeText = stripMarkdownSyntax(rawSummary || 'Credit Guard processed the request using deterministic backend data.');
  return {
    schemaVersion: '1.0',
    intent: {
      primary: VALID_INTENTS.includes(intentPlan.primaryIntent) ? intentPlan.primaryIntent : 'EXPLAIN',
      secondary: [],
      confidence: 0.5,
      resolvedFromContext: Boolean(intentPlan.resolvedFromContext),
      contextNote: intentPlan.contextNote || null
    },
    title: 'Credit Guard Analysis (Limited View)',
    summary: safeText,
    blocks: [
      {
        type: 'notice',
        severity: 'warning',
        title: 'Limited View – Safe Fallback Active',
        message: 'A structured visual component could not be verified and was omitted to guarantee numerical accuracy.'
      },
      {
        type: 'text',
        text: safeText
      }
    ],
    assumptions: [],
    limitations: [reason],
    dataProvenance: {
      sourceType: ALLOWED_SOURCE_TYPES.has(provenance.sourceType) ? provenance.sourceType : 'SYNTHETIC_DEMO',
      connectorName: provenance.connectorName || 'Credit Guard Demo Dataset',
      lastSyncAt: provenance.lastSyncAt || new Date().toISOString(),
      currency: 'INR',
      policyId: 'FIN-FSCM-AUTONOMOUS-POLICY-V1',
      toolsInvoked: provenance.toolsInvoked || []
    },
    suggestedFollowUps: [
      'Show all customers',
      'Show total portfolio credit exposure by country',
      'List customers with utilisation >= 80%'
    ]
  };
}

function validateAndReconcileResponse(candidateResponse, { intentPlan = {}, provenance = {} } = {}) {
  // First pass repair + check
  const normalized = repairStructuredResponse(candidateResponse);
  if (!normalized) {
    return buildSafeFallbackResponse(candidateResponse?.summary, intentPlan, provenance, 'Response object was empty.');
  }

  const firstCheck = checkReconciliation(normalized);
  if (firstCheck.ok) {
    return normalized;
  }

  // Retry 1: drop offending non-reconciling chart/metrics blocks if still failing
  const retryResponse = repairStructuredResponse(normalized);
  const secondCheck = checkReconciliation(retryResponse);
  if (secondCheck.ok) {
    return retryResponse;
  }

  // Drop non-reconciling metrics/chart blocks and add limitation note
  retryResponse.blocks = (retryResponse.blocks || []).filter(b => b.type !== 'metrics' && b.type !== 'chart');
  retryResponse.limitations = [
    ...(retryResponse.limitations || []),
    ...secondCheck.issues
  ];

  const finalCheck = checkReconciliation(retryResponse);
  if (finalCheck.ok && retryResponse.blocks.length > 0) {
    return retryResponse;
  }

  return buildSafeFallbackResponse(
    candidateResponse?.summary,
    intentPlan,
    provenance,
    secondCheck.issues.join(' ') || 'Structured validation failed after retry.'
  );
}

module.exports = {
  ALLOWED_BLOCK_TYPES,
  ALLOWED_VALUE_KINDS,
  ALLOWED_SOURCE_TYPES,
  stripMarkdownSyntax,
  checkReconciliation,
  repairStructuredResponse,
  buildSafeFallbackResponse,
  validateAndReconcileResponse
};
