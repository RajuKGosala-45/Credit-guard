import { formatINR, formatMoney, formatPercent } from '../utils.js';

/**
 * Read-Only Workspace Context Registry & Generic Query Engine
 * ----------------------------------------------------------------------------
 * Provides one read-only adapter per Credit Guard workspace tab plus the shared
 * customer dataset so AI Credit Assistance can inspect and answer questions
 * across every screen from the same shared store without mutating any tab.
 */

export const TAB_META = Object.freeze({
  overview: { tabId: 'overview', label: 'Credit Overview', buttonLabel: 'Open Credit Overview' },
  dashboard: { tabId: 'dashboard', label: 'Portfolio & Monitoring', buttonLabel: 'Open Portfolio & Monitoring' },
  analysis: { tabId: 'analysis', label: 'Exposure Analysis', buttonLabel: 'Open Exposure Analysis' },
  approvals: { tabId: 'approvals', label: 'Limit Approvals', buttonLabel: 'Open Limit Approvals' },
  simulator: { tabId: 'simulator', label: 'SAP BTP & HANA CDS', buttonLabel: 'Open SAP BTP & HANA CDS' },
  audit: { tabId: 'audit', label: 'AI Audit History', buttonLabel: 'Open AI Audit History' },
  chat: { tabId: 'chat', label: 'AI Credit Assistance', buttonLabel: 'Open AI Credit Assistance' },
  home: { tabId: 'home', label: 'Credit Guard Home', buttonLabel: 'Open Home' }
});

export const SYNONYM_MAP = Object.freeze({
  entities: {
    customers: ['customer', 'customers', 'client', 'clients', 'account', 'accounts', 'business partner', 'business partners', 'bp'],
    country_exposure: ['country exposure', 'country wise', 'country-wise', 'by country', 'per country', 'across countries', 'countries', 'country limit', 'country'],
    company_code_exposure: ['company code', 'company-code', 'company code wise', 'by company code', 'per company', 'by entity', 'bukrs', 'entities'],
    overview_kpis: ['credit overview', 'overview', 'portfolio health', 'health verdict', 'kpi', 'kpis', 'overall portfolio'],
    attention_items: ['attention items', 'priority items', 'what needs attention', 'attention list'],
    alerts: ['alert', 'alerts', 'monitoring alert', 'monitoring alerts', 'active alerts', 'critical alerts', 'warning alerts'],
    findings: ['finding', 'findings', 'monitoring findings', 'risk findings'],
    monitoring_runs: ['monitoring run', 'monitoring runs', 'monitoring status', 'monitoring summary', 'last monitoring', 'monitoring'],
    limit_drafts: ['limit draft', 'limit drafts', 'draft requests', 'prepared actions', 'draft limit'],
    limit_requests: ['limit approval', 'limit approvals', 'limit request', 'limit requests', 'approval', 'approvals', 'pending approval', 'pending approvals', 'limit change', 'last limit change'],
    connectors: ['connector', 'connectors', 'data source', 'data sources', 'source', 'sources', 'source id', 'sorceid', 'sorce id', 'connector id', 'connectivity', 'sync status', 'integration status', 'sap btp sources', 'hana sources'],
    cds_entities: ['cds entity', 'cds entities', 'cds table', 'cds tables', 'hana table', 'hana tables', 'odata service', 'odata services', 'canonical entity', 'canonical entities', 'schema', 'replicated tables', 'field mapping', 'field mappings'],
    extraction_runs: ['extraction timeline', 'extraction timelines', 'data extraction', 'extraction run', 'extraction runs', 'extraction history', 'ingestion run', 'ingestion runs', 'last sync', 'last refresh', 'scheduler run', 'scheduler runs'],
    scheduler_status: ['scheduler', 'scheduler daemon', 'daemon', 'autonomous daemon', 'autonomous scheduler', 'heartbeat', 'next cycle', 'last cycle'],
    mock_sap_staging: ['mock sap', 'sap simulator', 'mock customers', 'mock invoices', 'mock credit accounts', 'mock payments', 'staging data', 'synthetic staging'],
    audit_runs: ['audit history', 'agent history', 'audit run', 'audit runs', 'execution history', 'what did the agent do', 'memory status', 'agent memory', 'agent execution']
  },
  statuses: {
    active: 'ACTIVE',
    connected: 'ACTIVE',
    live: 'ACTIVE',
    running: 'RUNNING',
    idle: 'IDLE',
    online: 'ACTIVE',
    standby: 'STANDBY',
    'ready to connect': 'STANDBY',
    ready: 'STANDBY',
    offline: 'STANDBY',
    waiting: 'STANDBY',
    'never synced': 'NEVER_SYNCED',
    demo: 'DEMO',
    simulated: 'DEMO',
    synthetic: 'DEMO',
    failed: 'FAILED',
    error: 'FAILED',
    broken: 'FAILED',
    pending: 'Pending',
    awaiting: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    declined: 'Rejected',
    critical: 'CRITICAL',
    warning: 'WARNING',
    breach: 'BREACH',
    breached: 'BREACH',
    healthy: 'OK',
    ok: 'OK',
    acknowledged: 'ACKNOWLEDGED',
    resolved: 'RESOLVED'
  },
  fields: {
    id: ['id', 'ids', "id's", 'with id', 'with ids', 'source id', 'sorce id', 'sorceid', 'connector id', 'data source id', 'bp id', 'customer id', 'request id', 'run id'],
    name: ['name', 'names', 'source name', 'connector name', 'customer name', 'title'],
    country: ['country', 'countries', 'nation', 'region'],
    companyCode: ['company code', 'country code', 'company', 'entity', 'bukrs'],
    creditLimit: ['credit limit', 'limit', 'limits', 'cl', 'sanctioned limit'],
    exposure: ['exposure', 'exposures', 'exposer', 'exposers', 'balance', 'used'],
    availableCredit: ['headroom', 'available credit', 'available headroom', 'remaining credit', 'available'],
    utilisation: ['utilisation', 'utilization', 'utilzation', 'util', 'usage'],
    overdue: ['overdue', 'past due', 'arrears', 'delinquent'],
    status: ['status', 'state', 'health', 'mode', 'connectivity'],
    severity: ['severity', 'criticality', 'priority'],
    requestedBy: ['requester', 'requested by', 'who requested', 'creator'],
    requestedLimit: ['requested limit', 'target limit', 'proposed limit'],
    approverLevel: ['approver', 'approver level', 'authority', 'role'],
    type: ['type', 'connector type', 'source type', 'category'],
    configReference: ['config', 'config reference', 'connection config', 'endpoint'],
    freshness: ['freshness', 'age', 'stale'],
    lastRetrieved: ['last retrieved', 'last sync', 'last synced', 'synced at', 'timestamp']
  }
});

export const ENTITY_CATALOG = Object.freeze({
  customers: {
    tabId: 'analysis',
    tabLabel: 'Exposure Analysis',
    defaultColumns: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'utilisation', 'status'],
    fields: [
      { canonicalKey: 'customer', key: 'customer', label: 'Customer', align: 'left', format: 'text' },
      { canonicalKey: 'id', key: 'ID', label: 'ID', align: 'left', format: 'text' },
      { canonicalKey: 'country', key: 'country', label: 'Country', align: 'left', format: 'text' },
      { canonicalKey: 'companyCode', key: 'companyCode', label: 'Company Code', align: 'left', format: 'text' },
      { canonicalKey: 'creditLimit', key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
      { canonicalKey: 'availableCredit', key: 'availableCredit', label: 'Available Headroom', align: 'right', format: 'currency' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
      { canonicalKey: 'overdueInvoiceCount', key: 'overdueInvoiceCount', label: 'Overdue Invoices', align: 'right', format: 'number' },
      { canonicalKey: 'riskClass', key: 'riskClass', label: 'Risk Class', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' }
    ]
  },
  country_exposure: {
    tabId: 'analysis',
    tabLabel: 'Exposure Analysis',
    defaultColumns: ['groupKey', 'customerCount', 'exposure', 'creditLimit', 'availableCredit', 'utilisationPct', 'status'],
    creditLimitColumns: ['groupKey', 'creditLimit', 'exposure', 'availableCredit', 'utilisationPct', 'customerCount', 'status'],
    fields: [
      { canonicalKey: 'country', key: 'groupKey', label: 'Country', align: 'left', format: 'text' },
      { canonicalKey: 'customerCount', key: 'customerCount', label: 'Customers', align: 'right', format: 'number' },
      { canonicalKey: 'creditLimit', key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
      { canonicalKey: 'availableCredit', key: 'availableCredit', label: 'Available Headroom', align: 'right', format: 'currency' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
      { canonicalKey: 'status', key: 'status', label: 'Cohort Status', align: 'left', format: 'badge' }
    ]
  },
  company_code_exposure: {
    tabId: 'analysis',
    tabLabel: 'Exposure Analysis',
    defaultColumns: ['groupKey', 'customerCount', 'exposure', 'creditLimit', 'availableCredit', 'utilisationPct', 'status'],
    creditLimitColumns: ['groupKey', 'creditLimit', 'exposure', 'availableCredit', 'utilisationPct', 'customerCount', 'status'],
    fields: [
      { canonicalKey: 'companyCode', key: 'groupKey', label: 'Company Code', align: 'left', format: 'text' },
      { canonicalKey: 'customerCount', key: 'customerCount', label: 'Customers', align: 'right', format: 'number' },
      { canonicalKey: 'creditLimit', key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
      { canonicalKey: 'availableCredit', key: 'availableCredit', label: 'Available Headroom', align: 'right', format: 'currency' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
      { canonicalKey: 'status', key: 'status', label: 'Cohort Status', align: 'left', format: 'badge' }
    ]
  },
  connectors: {
    tabId: 'simulator',
    tabLabel: 'SAP BTP & HANA CDS',
    defaultColumns: ['id', 'name', 'type', 'status', 'mode', 'freshness', 'lastRetrieved'],
    fields: [
      { canonicalKey: 'id', key: 'id', label: 'Source ID', align: 'left', format: 'text' },
      { canonicalKey: 'name', key: 'name', label: 'Connector / Data Source', align: 'left', format: 'text' },
      { canonicalKey: 'type', key: 'type', label: 'Type', align: 'left', format: 'text' },
      { canonicalKey: 'configReference', key: 'configReference', label: 'Config Reference', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'mode', key: 'mode', label: 'Connection Mode', align: 'left', format: 'text' },
      { canonicalKey: 'freshness', key: 'freshness', label: 'Freshness', align: 'left', format: 'text' },
      { canonicalKey: 'lastRetrieved', key: 'lastRetrieved', label: 'Last Retrieved', align: 'left', format: 'text' }
    ]
  },
  scheduler_status: {
    tabId: 'simulator',
    tabLabel: 'SAP BTP & HANA CDS',
    defaultColumns: ['state', 'intervalMinutes', 'lastCycleTime', 'nextCycleTime', 'totalRuns', 'successfulRuns', 'failedRuns', 'lastError'],
    fields: [
      { canonicalKey: 'state', key: 'state', label: 'Daemon State', align: 'left', format: 'badge' },
      { canonicalKey: 'intervalMinutes', key: 'intervalMinutes', label: 'Interval (min)', align: 'right', format: 'number' },
      { canonicalKey: 'lastCycleTime', key: 'lastCycleTime', label: 'Last Cycle', align: 'left', format: 'text' },
      { canonicalKey: 'nextCycleTime', key: 'nextCycleTime', label: 'Next Cycle', align: 'left', format: 'text' },
      { canonicalKey: 'totalRuns', key: 'totalRuns', label: 'Total Runs', align: 'right', format: 'number' },
      { canonicalKey: 'successfulRuns', key: 'successfulRuns', label: 'Succeeded', align: 'right', format: 'number' },
      { canonicalKey: 'failedRuns', key: 'failedRuns', label: 'Failed', align: 'right', format: 'number' },
      { canonicalKey: 'lastError', key: 'lastError', label: 'Last Error', align: 'left', format: 'text' }
    ]
  },
  mock_sap_staging: {
    tabId: 'simulator',
    tabLabel: 'SAP BTP & HANA CDS',
    defaultColumns: ['customer', 'id', 'country', 'companyCode', 'creditLimitDisplay', 'exposure', 'utilisation', 'status'],
    fields: [
      { canonicalKey: 'customer', key: 'customer', label: 'Customer (Staging)', align: 'left', format: 'text' },
      { canonicalKey: 'id', key: 'ID', label: 'Customer ID', align: 'left', format: 'text' },
      { canonicalKey: 'country', key: 'country', label: 'Country', align: 'left', format: 'text' },
      { canonicalKey: 'companyCode', key: 'companyCode', label: 'Company Code', align: 'left', format: 'text' },
      { canonicalKey: 'creditLimit', key: 'creditLimitDisplay', label: 'Credit Limit', align: 'right', format: 'text' },
      { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
      { canonicalKey: 'riskClass', key: 'riskClass', label: 'Risk Class', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' }
    ]
  },
  cds_entities: {
    tabId: 'simulator',
    tabLabel: 'SAP BTP & HANA CDS',
    defaultColumns: ['entityName', 'sapSource', 'category', 'recordCount', 'status'],
    fields: [
      { canonicalKey: 'entityName', key: 'entityName', label: 'CDS / Canonical Entity', align: 'left', format: 'text' },
      { canonicalKey: 'sapSource', key: 'sapSource', label: 'SAP Table / Service', align: 'left', format: 'text' },
      { canonicalKey: 'category', key: 'category', label: 'Layer', align: 'left', format: 'text' },
      { canonicalKey: 'recordCount', key: 'recordCount', label: 'Records', align: 'right', format: 'number' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' }
    ]
  },
  extraction_runs: {
    tabId: 'simulator',
    tabLabel: 'SAP BTP & HANA CDS',
    defaultColumns: ['runTime', 'source', 'status', 'duration', 'records'],
    fields: [
      { canonicalKey: 'runTime', key: 'runTime', label: 'Run time', align: 'left', format: 'text' },
      { canonicalKey: 'source', key: 'source', label: 'Source/connector', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'duration', key: 'duration', label: 'Duration', align: 'right', format: 'text' },
      { canonicalKey: 'records', key: 'records', label: 'Records', align: 'right', format: 'number' }
    ]
  },
  limit_requests: {
    tabId: 'approvals',
    tabLabel: 'Limit Approvals',
    defaultColumns: ['id', 'customer', 'currentLimit', 'requestedLimit', 'requestedBy', 'approverLevel', 'status'],
    fields: [
      { canonicalKey: 'id', key: 'ID', label: 'Request ID', align: 'left', format: 'text' },
      { canonicalKey: 'customer', key: 'customer', label: 'Customer', align: 'left', format: 'text' },
      { canonicalKey: 'customerId', key: 'customerId', label: 'Customer ID', align: 'left', format: 'text' },
      { canonicalKey: 'currentLimit', key: 'currentLimit', label: 'Current Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'requestedLimit', key: 'requestedLimit', label: 'Requested Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'requestedBy', key: 'requestedBy', label: 'Requested By', align: 'left', format: 'text' },
      { canonicalKey: 'approverLevel', key: 'approverLevel', label: 'Approver Role', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'reason', key: 'reason', label: 'Reason', align: 'left', format: 'text' }
    ]
  },
  alerts: {
    tabId: 'dashboard',
    tabLabel: 'Portfolio & Monitoring',
    defaultColumns: ['customer', 'severity', 'status', 'title', 'utilisation', 'overdueAmount', 'recommendedAction'],
    fields: [
      { canonicalKey: 'id', key: 'id', label: 'Alert ID', align: 'left', format: 'text' },
      { canonicalKey: 'customer', key: 'customer', label: 'Customer', align: 'left', format: 'text' },
      { canonicalKey: 'customerId', key: 'customerId', label: 'Customer ID', align: 'left', format: 'text' },
      { canonicalKey: 'severity', key: 'severity', label: 'Severity', align: 'left', format: 'badge' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'title', key: 'title', label: 'Alert Condition', align: 'left', format: 'text' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
      { canonicalKey: 'recommendedAction', key: 'recommendedAction', label: 'Recommended Action', align: 'left', format: 'text' }
    ]
  },
  findings: {
    tabId: 'dashboard',
    tabLabel: 'Portfolio & Monitoring',
    defaultColumns: ['customer', 'severity', 'conditions', 'exposure', 'creditLimit', 'utilisationPct', 'overdueAmount'],
    fields: [
      { canonicalKey: 'customer', key: 'customer', label: 'Customer', align: 'left', format: 'text' },
      { canonicalKey: 'severity', key: 'severity', label: 'Severity', align: 'left', format: 'badge' },
      { canonicalKey: 'conditions', key: 'conditions', label: 'Conditions', align: 'left', format: 'text' },
      { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
      { canonicalKey: 'creditLimit', key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
      { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
      { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' }
    ]
  },
  monitoring_runs: {
    tabId: 'dashboard',
    tabLabel: 'Portfolio & Monitoring',
    defaultColumns: ['startedAt', 'runKind', 'status', 'source', 'customerCount', 'freshness'],
    fields: [
      { canonicalKey: 'id', key: 'id', label: 'Run ID', align: 'left', format: 'text' },
      { canonicalKey: 'runTime', key: 'startedAt', label: 'Started', align: 'left', format: 'text' },
      { canonicalKey: 'runKind', key: 'runKind', label: 'Type', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'source', key: 'source', label: 'Source', align: 'left', format: 'text' },
      { canonicalKey: 'records', key: 'customerCount', label: 'Customers', align: 'right', format: 'number' },
      { canonicalKey: 'freshness', key: 'freshness', label: 'Freshness', align: 'left', format: 'text' }
    ]
  },
  audit_runs: {
    tabId: 'audit',
    tabLabel: 'AI Audit History',
    defaultColumns: ['startedAt', 'status', 'planStatus', 'stepCount', 'recoveryStatus'],
    fields: [
      { canonicalKey: 'id', key: 'id', label: 'Execution ID', align: 'left', format: 'text' },
      { canonicalKey: 'runTime', key: 'startedAt', label: 'Started At', align: 'left', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'planStatus', key: 'planStatus', label: 'Plan Status', align: 'left', format: 'text' },
      { canonicalKey: 'stepCount', key: 'stepCount', label: 'Steps', align: 'right', format: 'number' },
      { canonicalKey: 'recoveryStatus', key: 'recoveryStatus', label: 'Recovery', align: 'left', format: 'text' }
    ]
  },
  overview_kpis: {
    tabId: 'overview',
    tabLabel: 'Credit Overview',
    defaultColumns: ['metric', 'value', 'status', 'note'],
    fields: [
      { canonicalKey: 'metric', key: 'metric', label: 'KPI Metric', align: 'left', format: 'text' },
      { canonicalKey: 'value', key: 'value', label: 'Value', align: 'right', format: 'text' },
      { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
      { canonicalKey: 'note', key: 'note', label: 'Details', align: 'left', format: 'text' }
    ]
  }
});

export function normalizeCountryLabel(rawCountry) {
  const raw = String(rawCountry || '').trim();
  if (!raw) return 'Unspecified';
  const upper = raw.toUpperCase();
  if (upper === 'IN' || upper === 'IND' || upper === 'INDIA' || upper === 'INDIAN') return 'India';
  if (upper === 'AE' || upper === 'ARE' || upper === 'UAE' || upper === 'UNITED ARAB EMIRATES' || upper === 'DUBAI') return 'UAE';
  if (upper === 'SG' || upper === 'SGP' || upper === 'SINGAPORE') return 'Singapore';
  if (upper === 'US' || upper === 'USA' || upper === 'UNITED STATES') return 'United States';
  if (upper === 'GB' || upper === 'GBR' || upper === 'UK' || upper === 'UNITED KINGDOM') return 'United Kingdom';
  if (upper === 'DE' || upper === 'DEU' || upper === 'GERMANY') return 'Germany';
  return raw;
}

export function selectCanonicalCustomers(rawCustomers = [], { specificIds = [], includeInactive = false } = {}) {
  const list = Array.isArray(rawCustomers) ? rawCustomers : [];
  const requestedSet = new Set((specificIds || []).map(id => String(id || '').toUpperCase()));
  const hasCanonicalPortfolio = list.some(c => /^C\d{3}$/i.test(String(c?.ID || c?.customer_ID || '')));
  const deduped = new Map();

  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.ID || c.customer_ID || '').trim().toUpperCase();
    if (!id) continue;
    const isInactive = String(c.status || '').toUpperCase() === 'INACTIVE';
    if (isInactive && !includeInactive && !requestedSet.has(id)) continue;
    if (hasCanonicalPortfolio && /^MS-C\d+/i.test(id) && !requestedSet.has(id)) continue;
    if (!deduped.has(id)) {
      const exposure = Number(c.exposure || 0);
      const creditLimit = Number(c.creditLimit ?? c.limit ?? 0);
      const isNoLimit = creditLimit <= 0;
      const utilisationRatio = isNoLimit
        ? null
        : (typeof c.utilisation === 'number' && Number.isFinite(c.utilisation)
          ? (c.utilisation > 10 ? c.utilisation / 100 : c.utilisation)
          : exposure / creditLimit);
      const utilisationPct = utilisationRatio !== null ? Number((utilisationRatio * 100).toFixed(1)) : null;
      const overdueAmount = Number(c.overdueAmount || 0);
      const overdueInvoiceCount = Number(c.overdueInvoiceCount || 0);
      const status = String(c.status || (isNoLimit ? 'MANUAL_REVIEW' : utilisationPct >= 100 ? 'BREACH' : utilisationPct >= 80 ? 'WARNING' : 'OK')).toUpperCase();
      const rawFlags = Array.isArray(c.flags)
        ? c.flags
        : (typeof c.flags === 'string' && c.flags.trim() ? c.flags.split(',').map(s => s.trim()) : []);
      const flags = isNoLimit && !rawFlags.some(f => /no limit/i.test(f)) ? ['No limit set', ...rawFlags] : rawFlags;

      deduped.set(id, {
        ...c,
        ID: id,
        customer: c.name || c.customerName || id,
        name: c.name || c.customerName || id,
        country: normalizeCountryLabel(c.country),
        companyCode: String(c.companyCode || c.company_code || '—').trim().toUpperCase(),
        creditLimit,
        exposure,
        availableCredit: isNoLimit ? 0 : (creditLimit - exposure),
        isNoLimit,
        utilisationRatio,
        utilisationPct,
        utilisationDisplay: isNoLimit ? 'N/A (no limit)' : `${utilisationPct.toFixed(1)}%`,
        overdueAmount,
        overdueInvoiceCount,
        status,
        riskClass: String(c.riskClass || c.CTLPC || 'Normal').trim(),
        flags,
        isInactive
      });
    }
  }
  return Array.from(deduped.values());
}

function formatDataAsOf(retrievedAt) {
  if (!retrievedAt) return 'current session';
  return String(retrievedAt).slice(0, 19).replace('T', ' ');
}

function computeFreshnessText(retrievedAt, extractionStatus = 'SUCCESS') {
  if (extractionStatus === 'FAILED') return 'Failed';
  if (!retrievedAt) return 'Fresh';
  const ts = Date.parse(retrievedAt);
  if (Number.isNaN(ts)) return 'Fresh';
  const ageMin = Math.max(0, (Date.now() - ts) / 60000);
  if (ageMin < 6) return `Fresh (${ageMin < 1 ? 'just now' : `${Math.floor(ageMin)}m ago`})`;
  if (ageMin <= 15) return `Delayed (${Math.floor(ageMin)}m ago)`;
  return `Stale (${Math.floor(ageMin)}m ago)`;
}

function aggregateExposureGroups(state, groupBy = 'country') {
  const precomputed = groupBy === 'companyCode'
    ? state?.dashboard?.exposure?.companyCode
    : state?.dashboard?.exposure?.country;
  const customers = selectCanonicalCustomers(state?.portfolioData?.customers || state?.customers || []);

  if (Array.isArray(precomputed) && precomputed.length > 0 && customers.length === 0) {
    return precomputed.map(row => {
      const exposure = Number(row.exposure || 0);
      const creditLimit = Number(row.creditLimit || 0);
      const utilPct = Number.isFinite(Number(row.utilisation))
        ? Number((Number(row.utilisation) * 100).toFixed(1))
        : (creditLimit > 0 ? Number(((exposure / creditLimit) * 100).toFixed(1)) : 0);
      return {
        groupKey: groupBy === 'country' ? normalizeCountryLabel(row.label) : String(row.label || '—'),
        customerCount: Number(row.customers || 0),
        creditLimit,
        exposure,
        availableCredit: creditLimit - exposure,
        utilisationPct: utilPct,
        overdueAmount: Number(row.overdueAmount || 0),
        status: utilPct >= 100 ? 'BREACH' : utilPct >= 80 ? 'WARNING' : 'HEALTHY'
      };
    });
  }

  const groups = new Map();
  for (const c of customers) {
    const key = groupBy === 'companyCode' ? (c.companyCode || 'Unspecified') : normalizeCountryLabel(c.country);
    const curr = groups.get(key) || {
      groupKey: key,
      customerCount: 0,
      creditLimit: 0,
      exposure: 0,
      overdueAmount: 0,
      breachedCount: 0,
      warningCount: 0
    };
    curr.customerCount += 1;
    curr.creditLimit += c.creditLimit;
    curr.exposure += c.exposure;
    curr.overdueAmount += c.overdueAmount;
    if (c.status === 'BREACH') curr.breachedCount += 1;
    else if (c.status === 'WARNING') curr.warningCount += 1;
    groups.set(key, curr);
  }

  return Array.from(groups.values()).map(g => {
    const utilPct = g.creditLimit > 0 ? Number(((g.exposure / g.creditLimit) * 100).toFixed(1)) : 0;
    return {
      ...g,
      availableCredit: g.creditLimit - g.exposure,
      utilisationPct: utilPct,
      status: g.breachedCount > 0 ? 'BREACH' : g.warningCount > 0 ? 'WARNING' : 'HEALTHY'
    };
  });
}

function buildOverviewSnapshot(state = {}) {
  const customers = selectCanonicalCustomers(state?.portfolioData?.customers || state?.customers || []);
  const kpis = state?.dashboard?.kpis || null;
  const requests = Array.isArray(state?.requests)
    ? state.requests
    : (Array.isArray(state?.portfolioData?.requests) ? state.portfolioData.requests : (state?.approvals || []));

  const totalExposure = kpis ? Number(kpis.totalExposure || 0) : customers.reduce((s, c) => s + c.exposure, 0);
  const totalLimit = kpis ? Number(kpis.totalLimit || 0) : customers.reduce((s, c) => s + c.creditLimit, 0);
  const overallUtilisation = kpis && Number.isFinite(Number(kpis.overallUtilisation))
    ? Number(kpis.overallUtilisation)
    : (totalLimit > 0 ? totalExposure / totalLimit : 0);
  const overallUtilisationPct = Number((overallUtilisation * 100).toFixed(1));
  const customerCount = kpis?.customerCount ?? customers.length;
  const overdueInvoiceCount = kpis?.overdueInvoiceCount ?? customers.reduce((s, c) => s + c.overdueInvoiceCount, 0);
  const overdueRiskCustomers = kpis?.overdueRiskCustomers ?? customers.filter(c => c.overdueAmount > 0).length;
  const overdueAmount = kpis?.overdueAmount ?? customers.reduce((s, c) => s + c.overdueAmount, 0);
  const customersBreached = kpis?.customersBreached ?? customers.filter(c => c.status === 'BREACH').length;
  const criticalCustomers = kpis?.criticalCustomers ?? customers.filter(c => c.utilisationPct !== null && c.utilisationPct >= 120).length;
  const availableHeadroom = totalLimit - totalExposure;

  let verdictTone = 'healthy';
  let verdictLabel = 'Healthy';
  if (overdueInvoiceCount > 5 || overallUtilisation > 0.8 || customersBreached > 0) {
    verdictTone = 'action';
    verdictLabel = 'Action needed';
  } else if (overdueInvoiceCount >= 1 || overallUtilisation >= 0.6) {
    verdictTone = 'watch';
    verdictLabel = 'Watch';
  }

  const utilDesc = overallUtilisation > 0.8 ? 'high' : overallUtilisation >= 0.6 ? 'moderate' : 'healthy';
  let reasonText = 'All customer accounts are within credit terms';
  if (overdueInvoiceCount > 0) {
    reasonText = `${overdueInvoiceCount} overdue invoice${overdueInvoiceCount === 1 ? '' : 's'} across ${overdueRiskCustomers} customer${overdueRiskCustomers === 1 ? '' : 's'}`;
  } else if (customersBreached > 0) {
    reasonText = `${customersBreached} customer${customersBreached === 1 ? '' : 's'} exceed assigned credit limits`;
  }
  const verdictText = verdictTone === 'healthy'
    ? `Utilisation is ${formatPercent(overallUtilisation)} (${utilDesc}). All customer accounts are within credit terms.`
    : `${verdictLabel}: ${reasonText}. Utilisation ${formatPercent(overallUtilisation)} (${utilDesc}).`;

  const pendingRequests = requests.filter(r => r && ['Pending', 'PENDING_APPROVAL'].includes(r.status));
  const attentionItems = [];
  if (overdueInvoiceCount > 0) {
    attentionItems.push({
      id: 'overdue-concentration',
      severity: overdueInvoiceCount > 5 ? 'ACTION' : 'WATCH',
      headline: `Overdue concentration (${overdueInvoiceCount} overdue invoices, ${overdueRiskCustomers} customers)`,
      detail: `${formatINR(overdueAmount)} past due`
    });
  }
  if (customersBreached > 0) {
    attentionItems.push({
      id: 'limit-breaches',
      severity: 'ACTION',
      headline: `${customersBreached} customer${customersBreached === 1 ? '' : 's'} at or above 100% credit limit`,
      detail: criticalCustomers > 0 ? `Includes ${criticalCustomers} critical (>=120%)` : 'Credit headroom exhausted'
    });
  }
  if (pendingRequests.length > 0) {
    attentionItems.push({
      id: 'pending-approvals',
      severity: 'WATCH',
      headline: `Pending limit approvals (${pendingRequests.length} awaiting decision)`,
      detail: 'Requires Credit Controller / Finance Head review'
    });
  }

  return {
    totalExposure,
    totalLimit,
    availableHeadroom,
    overallUtilisation,
    overallUtilisationPct,
    customerCount,
    overdueInvoiceCount,
    overdueRiskCustomers,
    overdueAmount,
    customersBreached,
    criticalCustomers,
    pendingApprovalCount: pendingRequests.length,
    verdict: { tone: verdictTone, label: verdictLabel, text: verdictText },
    attentionItems,
    kpiRows: [
      { metric: 'Total Exposure', value: formatMoney(totalExposure, kpis?.currency || 'INR'), status: overallUtilisation > 0.8 ? 'Action needed' : overallUtilisation >= 0.6 ? 'Watch' : 'Healthy', note: `${customerCount} customers` },
      { metric: 'Total Credit Limit', value: formatMoney(totalLimit, kpis?.currency || 'INR'), status: (1 - overallUtilisation) < 0.1 ? 'Action needed' : (1 - overallUtilisation) < 0.25 ? 'Watch' : 'Healthy', note: `Available headroom: ${formatMoney(availableHeadroom, kpis?.currency || 'INR')}` },
      { metric: 'Overall Utilisation', value: `${overallUtilisationPct.toFixed(1)}%`, status: overallUtilisation > 0.8 ? 'Action needed' : overallUtilisation >= 0.6 ? 'Watch' : 'Healthy', note: `${customersBreached} breached · ${criticalCustomers} critical` },
      { metric: 'Overdue Invoices', value: String(overdueInvoiceCount), status: overdueInvoiceCount > 5 ? 'Action needed' : overdueInvoiceCount >= 1 ? 'Watch' : 'Healthy', note: `${formatMoney(overdueAmount, kpis?.currency || 'INR')} across ${overdueRiskCustomers} customers` }
    ]
  };
}

function normalizeConnectorStatus(rawStatus, mode = '') {
  const s = String(rawStatus || '').toUpperCase();
  const m = String(mode || '').toUpperCase();
  if (s === 'FAILED' || s === 'ERROR') return 'FAILED';
  if (s === 'STANDBY' || s === 'OFFLINE' || m.includes('STANDBY')) return 'STANDBY';
  if (s === 'DEMO' || m.includes('DEMO')) return 'DEMO';
  if (s === 'CONNECTED' || s === 'ACTIVE' || m.includes('CONNECTED')) return 'CONNECTED';
  return s || 'CONNECTED';
}

function collectConnectorsRecords(state = {}) {
  const retrievedAt = state?.retrievedAt || state?.portfolioData?.retrievedAt || null;
  const formattedSync = retrievedAt ? formatDataAsOf(retrievedAt) : 'Never';
  const defaultFreshness = computeFreshnessText(retrievedAt, state?.extractionStatus);

  if (Array.isArray(state?.connectors) && state.connectors.length > 0) {
    return state.connectors.map((c, idx) => {
      const syncIso = c.last_sync_at || null;
      const lastRet = c.lastRetrieved || (syncIso ? formatDataAsOf(syncIso) : 'Never');
      return {
        id: c.id || c.source_id || c.sourceId || `SRC-${idx + 1}`,
        name: c.name || c.source_name || c.sourceName || c.connector || 'Connector',
        type: c.type || c.source_type || c.sourceType || 'SYSTEM',
        configReference: c.connection_config_ref || c.configReference || '—',
        status: String(c.status || 'ACTIVE').toUpperCase(),
        mode: c.mode || String(c.status || 'Active'),
        freshness: c.freshness || (lastRet === 'Never' ? 'Never synced' : defaultFreshness),
        last_sync_at: syncIso,
        lastRetrieved: lastRet,
        neverSynced: !syncIso && (!c.lastRetrieved || String(c.lastRetrieved).toLowerCase() === 'never')
      };
    });
  }

  if (Array.isArray(state?.v2Connectors?.sources) && state.v2Connectors.sources.length > 0) {
    return state.v2Connectors.sources.map((s, idx) => {
      const st = String(s.status || 'STANDBY').toUpperCase();
      const srcType = String(s.source_type || s.sourceType || s.type || 'CONNECTOR');
      const resolvedMode = st === 'DEMO'
        ? 'Demo (Synthetic Fixture)'
        : (st === 'ACTIVE' || st === 'CONNECTED')
          ? 'Active (Connected)'
          : st === 'FAILED'
            ? 'Failed'
            : 'Standby (Ready to connect)';
      const rawId = s.source_id || s.sourceId || s.id || `SRC-${idx + 1}`;
      const rawName = s.source_name || s.sourceName || s.name || 'Connector';
      const unifiedName = rawId === 'MOCK-SAP-FIN-FSCM' && !/MOCK-S4-001/i.test(rawName)
        ? `${rawName} (Simulator ID: MOCK-S4-001)`
        : rawName;
      const syncIso = s.last_sync_at || null;
      const lastRetrieved = s.lastRetrieved || (syncIso ? formatDataAsOf(syncIso) : 'Never');
      const neverSynced = !syncIso && (!s.lastRetrieved || String(s.lastRetrieved).toLowerCase() === 'never');
      return {
        id: rawId,
        name: unifiedName,
        type: srcType,
        configReference: s.connection_config_ref || s.configReference || '—',
        status: st,
        mode: resolvedMode,
        freshness: s.freshness || (syncIso ? computeFreshnessText(syncIso, state?.extractionStatus) : (st === 'STANDBY' ? 'Not connected' : 'Not yet synced')),
        last_sync_at: syncIso,
        lastRetrieved,
        neverSynced
      };
    });
  }

  return [];
}

function collectSchedulerRecord(state = {}) {
  const s = state?.schedulerStatus || null;
  if (!s) {
    return [{
      state: 'IDLE',
      intervalMinutes: 5,
      lastCycleTime: state?.lastSuccessfulAt ? formatDataAsOf(state.lastSuccessfulAt) : 'Pending initial',
      nextCycleTime: state?.nextRunAt ? formatDataAsOf(state.nextRunAt) : '—',
      totalRuns: Array.isArray(state?.monitoringData?.runs) ? state.monitoringData.runs.length : 0,
      successfulRuns: Array.isArray(state?.monitoringData?.runs) ? state.monitoringData.runs.filter(r => r.status === 'COMPLETED').length : 0,
      failedRuns: 0,
      skippedRuns: 0,
      lastError: state?.lastError || 'None'
    }];
  }
  const resolvedState = s.state
    || (s.lastRunStatus === 'FAILED' ? 'ERROR' : (s.status === 'RUNNING' ? 'RUNNING' : 'IDLE'));
  const lastRaw = s.lastCycleTime || s.lastCompletedAt || s.lastRunAt || null;
  const nextRaw = s.nextCycleTime || s.nextRunAt || null;
  return [{
    state: String(resolvedState).toUpperCase(),
    intervalMinutes: Number.isFinite(Number(s.intervalMinutes)) ? Number(s.intervalMinutes) : 5,
    lastCycleTime: lastRaw ? formatDataAsOf(lastRaw) : 'Pending initial',
    nextCycleTime: nextRaw ? formatDataAsOf(nextRaw) : '—',
    totalRuns: Number(s.totalRuns ?? 0),
    successfulRuns: Number(s.successfulRuns ?? 0),
    failedRuns: Number(s.failedRuns ?? 0),
    skippedRuns: Number(s.skippedRuns ?? 0),
    lastError: s.lastError || s.lastRunError || 'None'
  }];
}

function collectMockSapStagingBundle(state = {}) {
  const entities = state?.mockSap?.entities || {};
  const rawCusts = Array.isArray(entities.CUSTOMER?.records) ? entities.CUSTOMER.records : [];
  const rawAccounts = Array.isArray(entities.CREDIT_ACCOUNT?.records) ? entities.CREDIT_ACCOUNT.records : [];
  const rawInvoices = Array.isArray(entities.INVOICE?.records) ? entities.INVOICE.records : [];
  const rawPayments = Array.isArray(entities.PAYMENT?.records) ? entities.PAYMENT.records : [];
  const namesMap = new Map(rawCusts.map(r => [String(r.KUNNR || '').toUpperCase(), r.NAME1 || r.KUNNR]));

  const accounts = rawAccounts.map(acc => {
    const custId = String(acc.KUNNR || '').toUpperCase();
    const limitNum = Number(acc.KLIMK || 0);
    return {
      accountId: acc.CREDIT_ACCOUNT,
      customerId: custId,
      customer: namesMap.get(custId) || custId,
      creditLimit: limitNum,
      creditLimitDisplay: limitNum <= 0 ? 'No limit set' : formatMoney(limitNum, acc.WAERS || 'INR'),
      currency: acc.WAERS || 'INR',
      creditSegment: acc.KKBER || 'MSEG'
    };
  });

  const invoices = rawInvoices.map(inv => {
    const custId = String(inv.KUNNR || '').toUpperCase();
    return {
      invoiceId: inv.BELNR,
      customerId: custId,
      customer: namesMap.get(custId) || custId,
      accountId: inv.CREDIT_ACCOUNT,
      amount: Number(inv.DMBTR || 0),
      currency: inv.WAERS || 'INR',
      documentDate: inv.BLDAT || '—',
      dueDate: inv.ZFBDT || '—',
      status: String(inv.STATUS || 'OPEN').toUpperCase()
    };
  });

  const payments = rawPayments.map(pay => {
    const custId = String(pay.KUNNR || '').toUpperCase();
    return {
      paymentId: pay.PAYMENT_ID,
      customerId: custId,
      customer: namesMap.get(custId) || custId,
      accountId: pay.CREDIT_ACCOUNT,
      amount: Number(pay.DMBTR || 0),
      currency: pay.WAERS || 'INR',
      postingDate: pay.BUDAT || '—',
      status: String(pay.STATUS || 'POSTED').toUpperCase()
    };
  });

  let customers = [];
  if (rawCusts.length > 0) {
    customers = rawCusts.map(c => {
      const id = String(c.KUNNR || '').toUpperCase();
      const acc = accounts.find(a => a.customerId === id);
      const custInvoices = invoices.filter(inv => inv.customerId === id);
      const custPayments = payments.filter(pay => pay.customerId === id);
      const creditLimit = acc ? acc.creditLimit : 0;
      const exposure = custInvoices.reduce((s, inv) => s + inv.amount, 0);
      const overdueInvoices = custInvoices.filter(inv => inv.status === 'OVERDUE');
      const overdueAmount = overdueInvoices.reduce((s, inv) => s + inv.amount, 0);
      const paymentsTotal = custPayments.reduce((s, pay) => s + pay.amount, 0);
      const isNoLimit = creditLimit <= 0;
      const utilisationPct = isNoLimit ? null : Number(((exposure / creditLimit) * 100).toFixed(1));
      const status = isNoLimit ? 'NO LIMIT SET' : (utilisationPct >= 100 ? 'BREACH' : utilisationPct >= 80 ? 'WARNING' : 'OK');
      return {
        ID: id,
        customer: c.NAME1 || id,
        country: normalizeCountryLabel(c.LAND1),
        companyCode: String(c.BUKRS || '—').toUpperCase(),
        creditLimit,
        creditLimitDisplay: isNoLimit ? 'No limit set' : formatMoney(creditLimit, c.WAERS || 'INR'),
        isNoLimit,
        exposure,
        availableCredit: isNoLimit ? 0 : (creditLimit - exposure),
        utilisationPct,
        utilisationDisplay: isNoLimit ? 'N/A (no limit)' : `${utilisationPct.toFixed(1)}%`,
        overdueAmount,
        overdueInvoiceCount: overdueInvoices.length,
        paymentsTotal,
        riskClass: String(c.CTLPC || 'Normal'),
        status
      };
    });
  } else if (Array.isArray(state?.mockSapStagingCustomers) && state.mockSapStagingCustomers.length > 0) {
    customers = selectCanonicalCustomers(state.mockSapStagingCustomers, {
      specificIds: state.mockSapStagingCustomers.map(c => c.ID || c.customer_ID),
      includeInactive: true
    }).map(c => ({
      ...c,
      creditLimitDisplay: c.isNoLimit ? 'No limit set' : formatMoney(c.creditLimit, 'INR')
    }));
  }

  return {
    customers,
    accounts,
    invoices,
    payments,
    counts: {
      customerCount: customers.length,
      accountCount: accounts.length,
      invoiceCount: invoices.length,
      paymentCount: payments.length,
      totalLimit: customers.reduce((s, c) => s + c.creditLimit, 0),
      totalExposure: customers.reduce((s, c) => s + c.exposure, 0),
      totalPayments: payments.reduce((s, p) => s + p.amount, 0)
    }
  };
}

function collectCdsEntityRecords(state = {}) {
  const rows = [];
  const fixtureCounts = state?.mockSap?.fixtureCounts || {
    CUSTOMER: Array.isArray(state?.customers) ? state.customers.length : 13,
    CREDIT_ACCOUNT: Array.isArray(state?.customers) ? state.customers.length : 13,
    INVOICE: 19,
    PAYMENT: 10
  };
  const canonicalMeta = [
    { entityName: 'CUSTOMER', sapSource: 'BUT000 (Business Partner Master)', category: 'CANONICAL_CDS', recordCount: fixtureCounts.CUSTOMER ?? 13, status: 'ACTIVE' },
    { entityName: 'CREDIT_ACCOUNT', sapSource: 'UKMBP_CMS_SGM (FSCM Credit Segment)', category: 'CANONICAL_CDS', recordCount: fixtureCounts.CREDIT_ACCOUNT ?? 13, status: 'ACTIVE' },
    { entityName: 'INVOICE', sapSource: 'UKM_ITEM / BSID (Open Receivables)', category: 'CANONICAL_CDS', recordCount: fixtureCounts.INVOICE ?? 19, status: 'ACTIVE' },
    { entityName: 'PAYMENT', sapSource: 'ACDOCA / BSAD (Cleared Payments)', category: 'CANONICAL_CDS', recordCount: fixtureCounts.PAYMENT ?? 10, status: 'ACTIVE' }
  ];
  rows.push(...canonicalMeta);

  const hanaTables = state?.v2Connectors?.hanaReplicatedTables || [];
  for (const t of hanaTables) {
    rows.push({
      entityName: t.table || t.name || String(t),
      sapSource: t.description || 'SAP HANA SLT Replicated Table',
      category: 'HANA_REPLICATED',
      recordCount: t.recordCount ?? null,
      status: 'ACTIVE'
    });
  }
  const odataServices = state?.v2Connectors?.sapCandidateODataServices || [];
  for (const s of odataServices) {
    rows.push({
      entityName: s.service || s.name || String(s),
      sapSource: s.entitySet || 'SAP S/4HANA OData Service',
      category: 'SAP_ODATA',
      recordCount: null,
      status: 'STANDBY'
    });
  }
  return rows;
}

function collectAlertsRecords(state = {}) {
  const rawAlerts = Array.isArray(state?.monitoringData?.alerts) ? state.monitoringData.alerts : [];
  const customers = selectCanonicalCustomers(state?.portfolioData?.customers || state?.customers || []);
  const byId = new Map(customers.map(c => [c.ID, c]));
  return rawAlerts.map((a, idx) => {
    const cid = String(a.customer_ID || a.customerId || '').toUpperCase();
    const cust = byId.get(cid);
    const rawUtil = a.utilisation ?? cust?.utilisationRatio ?? null;
    const utilPct = rawUtil !== null && Number.isFinite(Number(rawUtil))
      ? Number((Number(rawUtil) > 10 ? Number(rawUtil) : Number(rawUtil) * 100).toFixed(1))
      : null;
    return {
      id: a.ID || a.id || `ALT-${idx + 1}`,
      customerId: cid || '—',
      customer: a.customerName || cust?.name || cid || 'Customer',
      severity: String(a.severity || 'WARNING').toUpperCase(),
      status: String(a.status || 'ACTIVE').toUpperCase(),
      title: a.title || (a.conditionKey ? a.conditionKey.replaceAll('_', ' ') : 'Threshold Alert'),
      description: a.message || a.description || '',
      utilisationPct: utilPct,
      overdueAmount: Number(a.overdueAmount ?? cust?.overdueAmount ?? 0),
      recommendedAction: a.recommendedAction || 'Review customer exposure and overdue invoices.',
      detectedAt: a.lastSeenAt || a.detectedAt || a.createdAt || null
    };
  });
}

function collectLimitRequestRecords(state = {}) {
  const raw = Array.isArray(state?.requests)
    ? state.requests
    : (Array.isArray(state?.portfolioData?.requests) ? state.portfolioData.requests : (state?.approvals || []));
  return raw.map((r, idx) => {
    const cur = Number(r.currentLimit || 0);
    const req = Number(r.requestedLimit || 0);
    return {
      ID: r.ID || `REQ-${idx + 1}`,
      customerId: String(r.customer_ID || r.customerId || '—').toUpperCase(),
      customer: r.customerName || r.customer_ID || 'Customer',
      currentLimit: cur,
      requestedLimit: req,
      delta: req - cur,
      requestedBy: r.requestedBy || 'requester',
      approverLevel: r.approverLevel || 'Credit Controller',
      status: r.status || 'Pending',
      reason: r.reason || '—',
      decidedBy: r.decidedBy || null,
      decidedAt: r.decidedAt || null,
      createdAt: r.createdAt || null
    };
  });
}

function collectAuditRunRecords(state = {}) {
  const executions = Array.isArray(state?.agentHistory?.executions) ? state.agentHistory.executions : [];
  return executions.map((e, idx) => ({
    id: e.ID || `EXEC-${idx + 1}`,
    startedAt: e.startedAt ? formatDataAsOf(e.startedAt) : '—',
    _ms: e.startedAt ? Date.parse(e.startedAt) : 0,
    status: String(e.status || 'COMPLETED').toUpperCase(),
    planStatus: e.planStatus || 'COMPLETED',
    stepCount: Number(e.stepCount || (Array.isArray(e.taskResults) ? e.taskResults.length : 0)),
    recoveryStatus: e.recoveryStatus || 'NOT_AVAILABLE',
    summary: Array.isArray(e.taskResults) && e.taskResults[0]?.summary ? e.taskResults[0].summary : (e.planStatus || 'Completed')
  }));
}

function collectExtractionRunRecords(state = {}, sessionRuns = []) {
  const runsMap = new Map();
  const addRun = r => {
    if (!r || !r.runTime) return;
    const ms = Date.parse(r.runTime);
    if (Number.isNaN(ms)) return;
    const key = `${new Date(ms).toISOString()}::${r.source}::${r.status}`;
    if (!runsMap.has(key)) {
      runsMap.set(key, {
        ...r,
        _ms: ms,
        runTime: formatDataAsOf(new Date(ms).toISOString()),
        duration: Number.isFinite(r.durationMs) && r.durationMs >= 0
          ? (r.durationMs < 1000 ? `${Math.round(r.durationMs)} ms` : `${(r.durationMs / 1000).toFixed(1)} s`)
          : '—',
        records: r.recordCount !== null && r.recordCount !== undefined ? Number(r.recordCount) : null
      });
    }
  };

  for (const eRun of state?.extractionRuns || []) {
    const ts = eRun.finishedAt || eRun.startedAt;
    if (!ts) continue;
    const rc = eRun.recordCounts;
    const totalCount = rc && typeof rc === 'object'
      ? (rc.total ?? rc.snapshots ?? rc.partnersUpserted ?? rc.customers ?? Object.values(rc).find(v => typeof v === 'number') ?? null)
      : null;
    addRun({
      runTime: ts,
      source: eRun.sourceName || eRun.sourceId || 'Credit Guard Shared Pipeline',
      status: String(eRun.status || 'COMPLETED').toUpperCase(),
      durationMs: eRun.durationMs ?? null,
      recordCount: totalCount,
      triggeredBy: eRun.triggeredBy || 'SCHEDULER',
      error: eRun.error || null
    });
  }

  for (const r of sessionRuns || []) addRun(r);

  for (const mRun of state?.monitoringData?.runs || []) {
    const startMs = mRun.startedAt ? Date.parse(mRun.startedAt) : NaN;
    const endMs = mRun.completedAt ? Date.parse(mRun.completedAt) : NaN;
    const ts = mRun.completedAt || mRun.startedAt || mRun.retrievedAt;
    if (!ts) continue;
    addRun({
      runTime: ts,
      source: mRun.source || 'Monitoring & Portfolio Scheduler',
      status: String(mRun.status || 'COMPLETED').toUpperCase(),
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
      recordCount: Number.isFinite(Number(mRun.customerCount))
        ? Number(mRun.customerCount)
        : (Number.isFinite(Number(mRun.summary?.customersMonitored)) ? Number(mRun.summary.customersMonitored) : null),
      error: mRun.errorMessage || mRun.errorCategory || null
    });
  }

  const mockSources = Array.isArray(state?.mockSap?.sources)
    ? state.mockSap.sources
    : (state?.mockSap?.source ? [{ ...state.mockSap.source, latestRun: state.mockSap.latestRun }] : []);
  for (const src of mockSources) {
    const lr = src?.latestRun;
    if (!lr) continue;
    const startMs = lr.startedAt ? Date.parse(lr.startedAt) : NaN;
    const endMs = lr.completedAt ? Date.parse(lr.completedAt) : NaN;
    const ts = lr.completedAt || lr.startedAt || state?.retrievedAt;
    if (!ts) continue;
    addRun({
      runTime: ts,
      source: src.sourceName || 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)',
      status: String(lr.status || 'COMPLETED').toUpperCase(),
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
      recordCount: Number.isFinite(Number(lr.recordCount)) ? Number(lr.recordCount) : null,
      error: lr.errorCount > 0 ? `${lr.errorCount} issues` : null
    });
  }

  return Array.from(runsMap.values()).sort((a, b) => b._ms - a._ms);
}

/**
 * Returns all 7 read-only workspace adapters grounded directly in the shared store.
 */
export function getWorkspaceAdapters(state = {}, { sessionRuns = [] } = {}) {
  const overviewSnap = buildOverviewSnapshot(state);
  const customers = selectCanonicalCustomers(state?.portfolioData?.customers || state?.customers || []);
  const countryRows = aggregateExposureGroups(state, 'country');
  const companyRows = aggregateExposureGroups(state, 'companyCode');
  const limitRequests = collectLimitRequestRecords(state);
  const alerts = collectAlertsRecords(state);
  const findings = Array.isArray(state?.monitoringData?.findings)
    ? state.monitoringData.findings
    : (state?.monitoringData?.summary?.latestRun?.findings || []);
  const monitoringRuns = (Array.isArray(state?.monitoringData?.runs) ? state.monitoringData.runs : []).map((r, idx) => ({
    id: r.id || r.ID || `MRUN-${idx + 1}`,
    startedAt: r.startedAt ? formatDataAsOf(r.startedAt) : '—',
    completedAt: r.completedAt ? formatDataAsOf(r.completedAt) : '—',
    _ms: r.completedAt ? Date.parse(r.completedAt) : (r.startedAt ? Date.parse(r.startedAt) : 0),
    runKind: r.runKind || 'SCHEDULED',
    status: String(r.status || 'COMPLETED').toUpperCase(),
    source: r.source || 'CAP database (demo)',
    customerCount: r.summary?.customersMonitored ?? r.customerCount ?? customers.length,
    freshness: r.freshness || computeFreshnessText(state?.retrievedAt, state?.extractionStatus),
    errorCategory: r.errorCategory || null
  }));
  const connectors = collectConnectorsRecords(state);
  const cdsEntities = collectCdsEntityRecords(state);
  const extractionRuns = collectExtractionRunRecords(state, sessionRuns);
  const schedulerRows = collectSchedulerRecord(state);
  const mockSapBundle = collectMockSapStagingBundle(state);
  const auditRuns = collectAuditRunRecords(state);

  return [
    {
      tabId: 'overview',
      label: 'Credit Overview',
      description: 'Portfolio KPIs (exposure, limit, utilisation, overdue), health verdict, and priority attention items.',
      entities: ['overview_kpis', 'attention_items'],
      fields: ENTITY_CATALOG.overview_kpis.fields,
      supportedOperations: ['STATUS_SUMMARY', 'EXPLAIN', 'LIST'],
      getSnapshot: () => overviewSnap,
      getRecords: entityName => entityName === 'attention_items' ? overviewSnap.attentionItems : overviewSnap.kpiRows
    },
    {
      tabId: 'dashboard',
      label: 'Portfolio & Monitoring',
      description: 'Monitoring runs, warning/breached/critical counts, active alerts, customer findings, and draft limit changes.',
      entities: ['monitoring_runs', 'alerts', 'findings', 'limit_drafts'],
      fields: { alerts: ENTITY_CATALOG.alerts.fields, findings: ENTITY_CATALOG.findings.fields, monitoring_runs: ENTITY_CATALOG.monitoring_runs.fields },
      supportedOperations: ['LIST', 'COUNT', 'STATUS_SUMMARY', 'EXPLAIN', 'TOP_N'],
      getSnapshot: () => {
        const latest = state?.monitoringData?.summary?.latestRun || null;
        const monSummary = latest?.summary || {};
        return {
          latestRunStatus: latest?.status || (state?.retrievedAt ? 'COMPLETED' : 'NONE'),
          lastRunAt: latest?.completedAt || latest?.startedAt || state?.retrievedAt || null,
          customersMonitored: monSummary.customersMonitored ?? customers.length,
          warningCustomers: monSummary.warningCustomers ?? customers.filter(c => c.status === 'WARNING').length,
          breachedCustomers: monSummary.breachedCustomers ?? customers.filter(c => c.status === 'BREACH').length,
          criticalCustomers: monSummary.criticalCustomers ?? customers.filter(c => c.utilisationPct !== null && c.utilisationPct >= 120).length,
          activeAlerts: alerts.length,
          criticalAlertCount: alerts.filter(a => a.severity === 'CRITICAL').length,
          findingsCount: findings.length,
          runsCount: monitoringRuns.length
        };
      },
      getRecords: entityName => {
        if (entityName === 'alerts') return alerts;
        if (entityName === 'findings') return findings.map(f => ({
          customer: `${f.customerName || f.customer_ID} (${f.customer_ID})`,
          severity: String(f.severity || 'WARNING').toUpperCase(),
          conditions: Array.isArray(f.conditions) ? f.conditions.join(', ').replaceAll('_', ' ') : (f.conditions || '—'),
          exposure: Number(f.exposure || 0),
          creditLimit: Number(f.creditLimit || 0),
          utilisationPct: f.utilisation !== null && f.utilisation !== undefined ? Number((Number(f.utilisation) * 100).toFixed(1)) : null,
          overdueAmount: Number(f.overdueAmount || 0)
        }));
        if (entityName === 'limit_drafts') return Array.isArray(state?.preparedActions) ? state.preparedActions : [];
        return monitoringRuns;
      }
    },
    {
      tabId: 'analysis',
      label: 'Exposure Analysis',
      description: 'Country-wise and company-code-wise exposure, credit limit, utilisation, and available headroom.',
      entities: ['country_exposure', 'company_code_exposure'],
      fields: { country_exposure: ENTITY_CATALOG.country_exposure.fields, company_code_exposure: ENTITY_CATALOG.company_code_exposure.fields },
      supportedOperations: ['LIST', 'GROUP_BY', 'SUM', 'AVG', 'MIN', 'MAX', 'TOP_N', 'COMPARE', 'COUNT'],
      getSnapshot: () => ({
        countriesCount: countryRows.length,
        companyCodesCount: companyRows.length,
        totalExposure: overviewSnap.totalExposure,
        totalLimit: overviewSnap.totalLimit,
        availableHeadroom: overviewSnap.availableHeadroom
      }),
      getRecords: entityName => entityName === 'company_code_exposure' ? companyRows : countryRows
    },
    {
      tabId: 'approvals',
      label: 'Limit Approvals',
      description: 'Pending, approved, and rejected credit limit requests, requester details, and sidebar badge count.',
      entities: ['limit_requests'],
      fields: ENTITY_CATALOG.limit_requests.fields,
      supportedOperations: ['LIST', 'COUNT', 'TOP_N', 'DETAIL', 'STATUS_SUMMARY', 'EXPLAIN'],
      getSnapshot: () => {
        const pending = limitRequests.filter(r => r.status === 'Pending');
        const approved = limitRequests.filter(r => r.status === 'Approved');
        const rejected = limitRequests.filter(r => r.status === 'Rejected');
        const sortedLatest = [...limitRequests].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
        return {
          totalCount: limitRequests.length,
          pendingCount: pending.length,
          approvedCount: approved.length,
          rejectedCount: rejected.length,
          lastRequest: sortedLatest[0] || null
        };
      },
      getRecords: () => limitRequests
    },
    {
      tabId: 'simulator',
      label: 'SAP BTP & HANA CDS',
      description: 'Enterprise connectors/data sources, field mappings, SAP S/4HANA & HANA CDS entities/tables, autonomous 5-minute scheduler daemon, Mock SAP synthetic staging, and extraction runs.',
      entities: ['connectors', 'cds_entities', 'extraction_runs', 'scheduler_status', 'mock_sap_staging'],
      fields: {
        connectors: ENTITY_CATALOG.connectors.fields,
        cds_entities: ENTITY_CATALOG.cds_entities.fields,
        extraction_runs: ENTITY_CATALOG.extraction_runs.fields,
        scheduler_status: ENTITY_CATALOG.scheduler_status.fields,
        mock_sap_staging: ENTITY_CATALOG.mock_sap_staging.fields
      },
      supportedOperations: ['LIST', 'COUNT', 'GROUP_BY', 'STATUS_SUMMARY', 'DETAIL', 'EXPLAIN'],
      getSnapshot: () => ({
        connectorCount: connectors.length,
        activeCount: connectors.filter(c => ['ACTIVE', 'CONNECTED'].includes(String(c.status || '').toUpperCase())).length,
        standbyCount: connectors.filter(c => normalizeConnectorStatus(c.status, c.mode) === 'STANDBY').length,
        neverSyncedCount: connectors.filter(c => c.neverSynced || String(c.lastRetrieved || '').toLowerCase() === 'never').length,
        mappingsCount: Number(state?.v2Connectors?.mappingsCount ?? 15),
        hanaTableCount: (state?.v2Connectors?.hanaReplicatedTables || []).length,
        sapODataCount: (state?.v2Connectors?.sapCandidateODataServices || []).length,
        cdsEntityCount: cdsEntities.length,
        extractionRunCount: extractionRuns.length,
        failedRunsCount: extractionRuns.filter(r => r.status === 'FAILED').length,
        scheduler: schedulerRows[0],
        mockSapCounts: mockSapBundle.counts
      }),
      getRecords: entityName => {
        if (entityName === 'cds_entities') return cdsEntities;
        if (entityName === 'extraction_runs') return extractionRuns;
        if (entityName === 'scheduler_status') return schedulerRows;
        if (entityName === 'mock_sap_staging') return mockSapBundle.customers;
        return connectors;
      }
    },
    {
      tabId: 'audit',
      label: 'AI Audit History',
      description: 'Agent execution runs, memory status, execution recovery status, and enterprise connector audit state.',
      entities: ['audit_runs'],
      fields: ENTITY_CATALOG.audit_runs.fields,
      supportedOperations: ['LIST', 'COUNT', 'TOP_N', 'STATUS_SUMMARY', 'EXPLAIN'],
      getSnapshot: () => ({
        executionCount: auditRuns.length,
        conversationCount: Array.isArray(state?.agentHistory?.conversations) ? state.agentHistory.conversations.length : 0,
        memoryEnabled: state?.agentHistory?.memoryEnabled !== undefined ? Boolean(state.agentHistory.memoryEnabled) : null,
        lastExecution: auditRuns[0] || null
      }),
      getRecords: () => auditRuns
    },
    {
      tabId: 'customers',
      label: 'Exposure Analysis',
      description: 'Shared customer master dataset with credit limits, exposure, headroom, utilisation %, and overdue receivables.',
      entities: ['customers'],
      fields: ENTITY_CATALOG.customers.fields,
      supportedOperations: ['LIST', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOP_N', 'DETAIL', 'COMPARE'],
      getSnapshot: () => ({
        activeCount: customers.length,
        totalExposure: overviewSnap.totalExposure,
        totalLimit: overviewSnap.totalLimit
      }),
      getRecords: () => customers
    }
  ];
}

export function getWorkspaceAdapterByTab(tabId, state = {}, opts = {}) {
  const normTab = String(tabId || 'overview').toLowerCase();
  const adapters = getWorkspaceAdapters(state, opts);
  return adapters.find(a => a.tabId === normTab) || adapters[0];
}

export function getActiveTabContext(state = {}, opts = {}) {
  const currentTab = String(state?.currentTab || 'chat').toLowerCase();
  const lastViewed = String(state?.lastViewed || state?.lastViewedTab || (currentTab !== 'chat' && currentTab !== 'home' ? currentTab : 'overview')).toLowerCase();
  const targetTab = (currentTab === 'chat' || currentTab === 'home') ? lastViewed : currentTab;
  return {
    currentTab,
    lastViewed,
    activeAdapter: getWorkspaceAdapterByTab(targetTab, state, opts),
    currentTabMeta: TAB_META[currentTab] || TAB_META.chat,
    lastViewedMeta: TAB_META[lastViewed] || TAB_META.overview
  };
}

function getEntitySpec(entityName) {
  return ENTITY_CATALOG[entityName] || ENTITY_CATALOG.customers;
}

function resolveEntityColumns(entityName, plan = {}) {
  const spec = getEntitySpec(entityName);
  const byKey = new Map(spec.fields.map(f => [f.canonicalKey, f]));
  const byProp = new Map(spec.fields.map(f => [f.key, f]));
  const findField = k => byKey.get(k) || byProp.get(k) || null;

  let baseOrder = [...spec.defaultColumns];
  if ((entityName === 'country_exposure' || entityName === 'company_code_exposure')
    && plan.filters?.metric === 'creditLimit' && Array.isArray(spec.creditLimitColumns)) {
    baseOrder = [...spec.creditLimitColumns];
  }

  const include = Array.isArray(plan.columns?.include) ? plan.columns.include : [];
  const exclude = Array.isArray(plan.columns?.exclude) ? plan.columns.exclude : [];
  const mode = plan.columnMode || (exclude.length ? 'exclude' : include.length ? 'include' : 'default');

  let chosenKeys = [...baseOrder];

  if (mode === 'only' && include.length > 0) {
    const resolved = include.map(k => findField(k)?.canonicalKey).filter(Boolean);
    chosenKeys = [];
    const anchor = byKey.has('customer') ? 'customer' : (byKey.has('name') ? 'name' : null);
    if (anchor && !resolved.includes(anchor) && resolved[0] !== 'id') {
      chosenKeys.push(anchor);
    }
    for (const k of resolved) {
      if (!chosenKeys.includes(k)) chosenKeys.push(k);
    }
  } else if (mode === 'include' && include.length > 0) {
    if (entityName === 'connectors') {
      chosenKeys = [...baseOrder];
      for (const k of include) {
        const f = findField(k);
        if (f && !chosenKeys.includes(f.canonicalKey) && !chosenKeys.includes(f.key)) {
          chosenKeys.unshift(f.canonicalKey);
        }
      }
      // Put requested ID right up front cleanly without duplicates
      chosenKeys = Array.from(new Set(chosenKeys));
    } else if (entityName === 'customers') {
      chosenKeys = ['customer', 'id'];
      for (const k of include) {
        const f = findField(k);
        if (f && !chosenKeys.includes(f.canonicalKey)) chosenKeys.push(f.canonicalKey);
      }
    } else {
      for (const k of include) {
        const f = findField(k);
        if (f && !chosenKeys.includes(f.canonicalKey) && !chosenKeys.includes(f.key)) {
          chosenKeys.push(f.canonicalKey);
        }
      }
    }
  } else if (exclude.length > 0) {
    const excSet = new Set(exclude.map(k => {
      const f = findField(k);
      return [k, f?.canonicalKey, f?.key].filter(Boolean);
    }).flat());
    chosenKeys = baseOrder.filter(k => {
      const f = findField(k);
      return !excSet.has(k) && !(f && excSet.has(f.canonicalKey)) && !(f && excSet.has(f.key));
    });
    if (chosenKeys.length === 0) chosenKeys = [baseOrder[0]];
  }

  return chosenKeys
    .map(k => findField(k))
    .filter(Boolean)
    .map(f => ({ ...f }));
}

function applyPlanFilters(records, entityName, filters = {}, timeRange = null) {
  let rows = [...records];

  if (filters.country) {
    const target = normalizeCountryLabel(filters.country).toLowerCase();
    rows = rows.filter(r => normalizeCountryLabel(r.country || r.groupKey).toLowerCase() === target);
  }
  if (filters.companyCode) {
    const co = String(filters.companyCode).toUpperCase();
    rows = rows.filter(r => String(r.companyCode || r.groupKey || '').toUpperCase() === co);
  }
  if (Array.isArray(filters.customerIds) && filters.customerIds.length > 0 && entityName !== 'customers') {
    const set = new Set(filters.customerIds.map(id => String(id).toUpperCase()));
    rows = rows.filter(r => set.has(String(r.customerId || r.customer_ID || r.ID || '').toUpperCase()));
  }
  if (filters.severity) {
    const sev = String(filters.severity).toUpperCase();
    rows = rows.filter(r => String(r.severity || '').toUpperCase() === sev);
  }
  if (entityName === 'connectors') {
    if (filters.connectorFilter === 'SAP_BTP_HANA') {
      rows = rows.filter(r => /\b(?:sap|btp|hana)\b/i.test(`${r.id} ${r.name} ${r.type}`));
    }
    if (filters.neverSynced) {
      rows = rows.filter(r => r.neverSynced || String(r.lastRetrieved || '').toLowerCase() === 'never');
    }
    const statusList = Array.isArray(filters.statuses) && filters.statuses.length
      ? filters.statuses.map(s => String(s).toUpperCase())
      : (filters.status ? [String(filters.status).toUpperCase()] : []);
    if (statusList.length > 0) {
      const wantsNever = statusList.includes('NEVER_SYNCED');
      const wantsActive = statusList.includes('ACTIVE') || statusList.includes('CONNECTED');
      const wantsStandby = statusList.includes('STANDBY');
      const wantsDemo = statusList.includes('DEMO');
      const wantsFailed = statusList.includes('FAILED');
      rows = rows.filter(r => {
        const norm = normalizeConnectorStatus(r.status, r.mode);
        if (wantsNever && (r.neverSynced || String(r.lastRetrieved || '').toLowerCase() === 'never')) return true;
        if (wantsActive && (norm === 'CONNECTED' || norm === 'ACTIVE')) return true;
        if (wantsStandby && norm === 'STANDBY') return true;
        if (wantsDemo && norm === 'DEMO') return true;
        if (wantsFailed && norm === 'FAILED') return true;
        return statusList.includes(String(r.status || '').toUpperCase());
      });
    }
  } else if (filters.status || (Array.isArray(filters.statuses) && filters.statuses.length)) {
    const targetList = (Array.isArray(filters.statuses) && filters.statuses.length
      ? filters.statuses
      : [filters.status]).map(s => String(s).toUpperCase());
    rows = rows.filter(r => targetList.includes(String(r.status || '').toUpperCase()));
  }

  if (timeRange?.from || timeRange?.to) {
    const fromMs = timeRange.from ? Date.parse(timeRange.from) : -Infinity;
    const toMs = timeRange.to ? Date.parse(timeRange.to) : Infinity;
    const hasMs = rows.some(r => Number.isFinite(r._ms) && r._ms > 0);
    if (hasMs) {
      rows = rows.filter(r => !Number.isFinite(r._ms) || r._ms === 0 || (r._ms >= fromMs && r._ms <= toMs));
    }
  }

  return rows;
}

function sortRecordsForPlan(rows, entityName, plan = {}) {
  const sortBy = plan.sortBy
    || (entityName === 'country_exposure' || entityName === 'company_code_exposure'
      ? (plan.filters?.metric === 'creditLimit' ? 'creditLimit' : 'exposure')
      : entityName === 'limit_requests'
        ? 'createdAt'
        : entityName === 'connectors'
          ? 'statusPriority'
          : null);
  const sortDir = plan.sortDir || 'desc';
  const dir = sortDir === 'asc' ? 1 : -1;

  if (!sortBy) return [...rows];

  return [...rows].sort((a, b) => {
    if (sortBy === 'statusPriority') {
      const rank = s => (s === 'CONNECTED' || s === 'ACTIVE' ? 0 : s === 'DEMO' ? 1 : s === 'STANDBY' ? 2 : 3);
      return rank(normalizeConnectorStatus(a.status, a.mode)) - rank(normalizeConnectorStatus(b.status, b.mode));
    }
    if (sortBy === 'createdAt') {
      return (Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)) * dir;
    }
    if (sortBy === 'utilisationPct' || sortBy === 'utilisation') {
      const ua = a.utilisationPct !== null && a.utilisationPct !== undefined ? Number(a.utilisationPct) : (dir === 1 ? Infinity : -Infinity);
      const ub = b.utilisationPct !== null && b.utilisationPct !== undefined ? Number(b.utilisationPct) : (dir === 1 ? Infinity : -Infinity);
      return ((ua - ub) * dir) || ((Number(b.exposure || 0) - Number(a.exposure || 0)));
    }
    const va = a[sortBy] ?? a.utilisationPct ?? a.exposure ?? 0;
    const vb = b[sortBy] ?? b.utilisationPct ?? b.exposure ?? 0;
    if (typeof va === 'string' && typeof vb === 'string') {
      return va.localeCompare(vb) * (sortDir === 'desc' ? -1 : 1);
    }
    return (Number(va || 0) - Number(vb || 0)) * dir;
  });
}

function buildConnectorBreakdown(connectors = []) {
  const counts = { activeOrConnected: 0, demo: 0, standby: 0, failed: 0 };
  for (const c of connectors) {
    const norm = normalizeConnectorStatus(c.status, c.mode);
    if (norm === 'STANDBY') counts.standby += 1;
    else if (norm === 'DEMO') counts.demo += 1;
    else if (norm === 'FAILED') counts.failed += 1;
    else counts.activeOrConnected += 1;
  }
  const parts = [];
  if (counts.activeOrConnected > 0) parts.push(`${counts.activeOrConnected} Connected/Active`);
  if (counts.demo > 0) parts.push(`${counts.demo} Demo`);
  if (counts.standby > 0) parts.push(`${counts.standby} Standby (ready to connect)`);
  if (counts.failed > 0) parts.push(`${counts.failed} Failed`);
  return { counts, text: parts.join(', ') || '0 sources' };
}

/**
 * Executes a unified Query Plan against the read-only workspace adapters.
 */
export function executeWorkspacePlan(plan, state = {}, { sessionRuns = [], rawQuestion = '' } = {}) {
  const retrievedAt = state?.retrievedAt || state?.portfolioData?.retrievedAt || new Date().toISOString();
  const dataAsOf = formatDataAsOf(retrievedAt);
  const adapters = getWorkspaceAdapters(state, { sessionRuns });
  const entity = plan.entity || 'overview_kpis';
  const operation = plan.operation || 'LIST';
  const filters = plan.filters || {};

  const baseProv = {
    sourceType: 'SYNTHETIC_DEMO',
    connectorName: state?.portfolioData?.source || 'Credit Guard Shared Workspace Store (INR)',
    currency: 'INR',
    lastSyncAt: retrievedAt,
    policyId: 'FIN-FSCM-AUTONOMOUS-POLICY-V1'
  };

  // --- A. Navigation Guidance ("Where can I see country-wise exposure?") ---
  if (operation === 'NAVIGATE' || entity === 'tab_navigation') {
    const targetTabId = plan.targetTab || 'analysis';
    const meta = TAB_META[targetTabId] || TAB_META.analysis;
    const targetAdapter = getWorkspaceAdapterByTab(meta.tabId, state, { sessionRuns });
    const snap = targetAdapter.getSnapshot();
    let detailHint = targetAdapter.description;
    if (meta.tabId === 'analysis') {
      detailHint = `Open Exposure Analysis to view country-wise (${snap.countriesCount} countries) and company-code-wise (${snap.companyCodesCount} codes) credit limit, exposure, and utilisation bars totaling ${formatINR(snap.totalExposure)}.`;
    } else if (meta.tabId === 'approvals') {
      detailHint = `Open Limit Approvals to review ${snap.pendingCount} pending and ${snap.totalCount} total credit limit change requests.`;
    } else if (meta.tabId === 'dashboard') {
      detailHint = `Open Portfolio & Monitoring to run manual monitoring, view ${snap.activeAlerts} active alerts, and submit draft limit requests.`;
    } else if (meta.tabId === 'simulator') {
      detailHint = `Open SAP BTP & HANA CDS to inspect ${snap.connectorCount} connectors, ${snap.cdsEntityCount} CDS/canonical entities, and extraction history.`;
    }

    return {
      intent: { primary: plan.intent || 'WORKSPACE_NAVIGATION', secondary: [], confidence: plan.confidence || 0.96 },
      showTableAboveFold: false,
      title: `Go to ${meta.label}`,
      summary: `You can view that in the ${meta.label} tab. ${detailHint}`,
      navigationAction: { tabId: meta.tabId, label: meta.buttonLabel },
      sourceTabId: meta.tabId,
      sourceTabLabel: meta.label,
      dataAsOf,
      headlineBullets: [],
      blocks: [],
      assumptions: ['Navigation switches your active workspace view without modifying any data.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.navigate'] },
      suggestedFollowUps: [
        `Summarize ${meta.label}`,
        'Credit limit with country wise',
        'How many pending limit approvals?'
      ]
    };
  }

  // --- B. Current / Active Screen Context ("what am I looking at?", "explain this screen", "summarize this tab") ---
  if (entity === 'screen_context') {
    const ctx = getActiveTabContext(state, { sessionRuns });
    const requestedTab = plan.targetTab ? getWorkspaceAdapterByTab(plan.targetTab, state, { sessionRuns }) : ctx.activeAdapter;
    const snap = requestedTab.getSnapshot();
    const isViewingChat = ctx.currentTab === 'chat' && !plan.targetTab;
    const prefix = isViewingChat
      ? `You are on AI Credit Assistance (last viewed screen: ${ctx.lastViewedMeta.label}). `
      : `You are viewing ${requestedTab.label}. `;

    let summaryBody = requestedTab.description;
    const metricsItems = [];
    if (requestedTab.tabId === 'overview') {
      summaryBody = `Exposure is ${formatINR(snap.totalExposure)} against ${formatINR(snap.totalLimit)} limit (${snap.overallUtilisationPct.toFixed(1)}% utilisation), with ${snap.overdueInvoiceCount} overdue invoices and status "${snap.verdict.label}".`;
      metricsItems.push(
        { label: 'Total Exposure', value: formatINR(snap.totalExposure), valueKind: 'CALCULATED' },
        { label: 'Total Credit Limit', value: formatINR(snap.totalLimit), valueKind: 'CALCULATED' },
        { label: 'Health Verdict', value: snap.verdict.label, valueKind: 'CALCULATED' }
      );
    } else if (requestedTab.tabId === 'approvals') {
      summaryBody = `There are ${snap.pendingCount} pending, ${snap.approvedCount} approved, and ${snap.rejectedCount} rejected credit limit requests.`;
    } else if (requestedTab.tabId === 'dashboard') {
      summaryBody = `Latest monitoring status is ${snap.latestRunStatus}: ${snap.customersMonitored} customers monitored (${snap.breachedCustomers} breached, ${snap.warningCustomers} warning), with ${snap.activeAlerts} active alerts.`;
    } else if (requestedTab.tabId === 'analysis') {
      summaryBody = `Portfolio breakdown across ${snap.countriesCount} countries and ${snap.companyCodesCount} company codes (total exposure ${formatINR(snap.totalExposure)} / limit ${formatINR(snap.totalLimit)}).`;
    } else if (requestedTab.tabId === 'simulator') {
      summaryBody = `${snap.connectorCount} enterprise data sources (${snap.standbyCount} standby), ${snap.cdsEntityCount} CDS/canonical entities, and ${snap.extractionRunCount} extraction runs tracked.`;
    } else if (requestedTab.tabId === 'audit') {
      summaryBody = `${snap.executionCount} agent executions and ${snap.conversationCount} conversations recorded (memory ${snap.memoryEnabled === false ? 'disabled' : 'enabled'}).`;
    }

    return {
      intent: { primary: plan.intent || 'SCREEN_CONTEXT', secondary: [], confidence: 0.96 },
      showTableAboveFold: false,
      title: `${requestedTab.label} Summary`,
      summary: `${prefix}${summaryBody}`,
      navigationAction: requestedTab.tabId !== ctx.currentTab ? { tabId: requestedTab.tabId, label: TAB_META[requestedTab.tabId]?.buttonLabel || `Open ${requestedTab.label}` } : null,
      sourceTabId: requestedTab.tabId,
      sourceTabLabel: requestedTab.label,
      dataAsOf,
      headlineBullets: [],
      blocks: metricsItems.length ? [{ type: 'metrics', items: metricsItems }] : [],
      assumptions: ['Read-only snapshot from the live workspace store.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: [`workspaceContext.${requestedTab.tabId}`] },
      suggestedFollowUps: [
        'Summarize Credit Overview',
        'How many pending limit approvals?',
        'Show monitoring status'
      ]
    };
  }

  // --- C. Credit Overview Summary ("Summarize Credit Overview", "What is on Credit Overview?") ---
  if (entity === 'overview_kpis' || entity === 'attention_items') {
    const adapter = getWorkspaceAdapterByTab('overview', state, { sessionRuns });
    const snap = adapter.getSnapshot();
    const isDeltaQuestion = /\bchanged\b.*\brefresh\b|\bsince\s+last\s+refresh\b|\bwhat\s+changed\b/i.test(rawQuestion);

    if (isDeltaQuestion) {
      const runs = collectExtractionRunRecords(state, sessionRuns);
      const prevRun = runs[1] || null;
      const runNote = prevRun
        ? `Previous snapshot at ${prevRun.runTime} (${prevRun.source}) had ${prevRun.records ?? snap.customerCount} customers. `
        : 'Demo portfolio numbers are deterministic across 5-minute extraction cycles; ';
      return {
        intent: { primary: plan.intent || 'CREDIT_OVERVIEW_SUMMARY', secondary: [], confidence: 0.95 },
        showTableAboveFold: true,
        title: 'Refresh & Portfolio Change Summary',
        summary: `${runNote}Latest refresh as of ${dataAsOf} shows ${formatINR(snap.totalExposure)} exposure, ${snap.overallUtilisationPct.toFixed(1)}% utilisation, and ${snap.overdueInvoiceCount} overdue invoices (${snap.attentionItems.length} attention items).`,
        sourceTabId: 'overview',
        sourceTabLabel: 'Credit Overview',
        dataAsOf,
        headlineBullets: [],
        blocks: [{ type: 'table', title: 'Current Credit Overview KPIs', columns: ENTITY_CATALOG.overview_kpis.fields, rows: snap.kpiRows }],
        assumptions: ['Deterministic demo dataset re-stamps retrievedAt on each 5-minute extraction cycle.'],
        limitations: prevRun ? [] : ['Only the latest deterministic snapshot is present in memory; no field-level diff log was emitted.'],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.overview'] },
        suggestedFollowUps: ['Show me recent data extraction timelines', 'Summarize Credit Overview', 'Show monitoring status']
      };
    }

    return {
      intent: { primary: plan.intent || 'CREDIT_OVERVIEW_SUMMARY', secondary: [], confidence: 0.98 },
      showTableAboveFold: false,
      title: 'Credit Overview Summary',
      summary: `Credit Overview (${snap.verdict.label}): Total exposure is ${formatINR(snap.totalExposure)} against ${formatINR(snap.totalLimit)} credit limit (${snap.overallUtilisationPct.toFixed(1)}% utilisation), with ${snap.overdueInvoiceCount} overdue invoices (${formatINR(snap.overdueAmount)}). ${snap.attentionItems.length} priority attention items active.`,
      sourceTabId: 'overview',
      sourceTabLabel: 'Credit Overview',
      dataAsOf,
      headlineBullets: [
        snap.verdict.text,
        ...snap.attentionItems.slice(0, 3).map(a => `${a.severity}: ${a.headline} — ${a.detail}`)
      ],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Total exposure', value: formatINR(snap.totalExposure), rawValue: snap.totalExposure, subtitle: `${snap.customerCount} customers`, severity: snap.overallUtilisation > 0.8 ? 'critical' : 'healthy', valueKind: 'ACTUAL' },
            { label: 'Total credit limit', value: formatINR(snap.totalLimit), rawValue: snap.totalLimit, subtitle: `Headroom: ${formatINR(snap.availableHeadroom)}`, severity: 'neutral', valueKind: 'ACTUAL' },
            { label: 'Overall utilisation', value: `${snap.overallUtilisationPct.toFixed(1)}%`, rawValue: snap.overallUtilisationPct, subtitle: `${snap.customersBreached} breached · ${snap.criticalCustomers} critical`, severity: snap.overallUtilisation > 0.8 ? 'warning' : 'healthy', valueKind: 'CALCULATED' },
            { label: 'Overdue invoices', value: String(snap.overdueInvoiceCount), rawValue: snap.overdueInvoiceCount, subtitle: `${snap.overdueRiskCustomers} customers · ${formatINR(snap.overdueAmount)}`, severity: snap.overdueInvoiceCount > 5 ? 'critical' : 'warning', valueKind: 'ACTUAL' }
          ]
        },
        {
          type: 'table',
          title: 'Credit Overview KPI Breakdown',
          columns: ENTITY_CATALOG.overview_kpis.fields,
          rows: snap.kpiRows
        }
      ],
      assumptions: ['Values match the Credit Overview shared KPI selectors directly.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.overview'] },
      suggestedFollowUps: ['Credit limit with country wise', 'Which alerts are critical?', 'How many pending limit approvals?']
    };
  }

  // --- D. Generic Entity Query Execution Across Remaining Adapters ---
  const adapter = adapters.find(a => a.entities.includes(entity)) || adapters[adapters.length - 1];
  const allRecords = adapter.getRecords(entity);
  const filtered = applyPlanFilters(allRecords, entity, filters, plan.timeRange);
  const sorted = sortRecordsForPlan(filtered, entity, plan);
  const limitNum = Number.isInteger(plan.limit) && plan.limit > 0 ? plan.limit : null;
  const rows = limitNum ? sorted.slice(0, limitNum) : sorted;
  const columns = resolveEntityColumns(entity, plan);
  const spec = getEntitySpec(entity);

  // Special handling for CONNECTORS ("how many data sources ready to connect", "Show me all data sources...", "Show me SorceID", "Which connectors never synced?")
  if (entity === 'connectors') {
    const simSnap = adapter.getSnapshot();
    const allBreakdown = buildConnectorBreakdown(allRecords);
    const failedList = allRecords.filter(c => normalizeConnectorStatus(c.status, c.mode) === 'FAILED');

    if (allRecords.length === 0) {
      return {
        intent: { primary: plan.intent || 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.95 },
        showTableAboveFold: false,
        title: 'SAP BTP & HANA CDS Data Sources',
        summary: 'Connector registry data from /api/v2/connectors has not loaded in this store snapshot yet.',
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [
          { type: 'notice', severity: 'info', title: 'Connectors Not Loaded', message: 'Open SAP BTP & HANA CDS or ask again once /api/v2/connectors finishes loading.' }
        ],
        assumptions: ['Reads directly from /api/v2/connectors without synthetic hardcoded fallback rows.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
        suggestedFollowUps: ['Show CDS entities', 'Show scheduler daemon status', 'Show me recent data extraction timelines']
      };
    }

    if (/\bfailed\b/i.test(rawQuestion)) {
      const failedRuns = collectExtractionRunRecords(state, sessionRuns).filter(r => r.status === 'FAILED');
      const headline = failedList.length > 0
        ? `${failedList.length} data source failed (${failedList.map(c => `${c.name} [${c.id}]`).join(', ')}).`
        : failedRuns.length > 0
          ? `Latest failure was on ${failedRuns[0].source} at ${failedRuns[0].runTime}.`
          : `0 data sources have failed across ${allRecords.length} configured connectors (${allBreakdown.text}).`;
      return {
        intent: { primary: plan.intent || 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.97 },
        showTableAboveFold: failedList.length > 0,
        title: 'Data Source Failure Check',
        summary: headline,
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [{ type: 'table', title: 'Data Source Health', columns, rows: failedList.length ? failedList : allRecords }],
        assumptions: ['Read from SAP BTP & HANA CDS connector registry and shared extraction logs.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
        suggestedFollowUps: ['Show me all data sources and active, standby status', 'Show me recent data extraction timelines', 'Show CDS entities']
      };
    }

    if (operation === 'COUNT' && !filters.neverSynced) {
      const isStandbyQuery = Array.isArray(filters.statuses)
        ? filters.statuses.includes('STANDBY')
        : filters.status === 'STANDBY';
      const countHeadline = isStandbyQuery
        ? `${rows.length} of ${allRecords.length} data ${rows.length === 1 ? 'source is' : 'sources are'} standby (ready to connect)${rows.length ? `: ${rows.map(r => `${r.name} [${r.id}]`).join(', ')}` : ''} (${allBreakdown.text}).`
        : `${allRecords.length} registered connectors (${simSnap.activeCount} ACTIVE, ${simSnap.standbyCount} STANDBY; ${simSnap.mappingsCount} field mappings, ${simSnap.hanaTableCount} HANA tables, ${simSnap.sapODataCount} SAP OData services).`;
      return {
        intent: { primary: plan.intent || 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.97 },
        showTableAboveFold: false,
        title: 'Data Sources Count & Readiness',
        summary: countHeadline,
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [
          {
            type: 'metrics',
            items: [
              { label: 'Active Sources', value: `${simSnap.activeCount} / ${allRecords.length}`, rawValue: simSnap.activeCount, severity: 'healthy', valueKind: 'ACTUAL' },
              { label: 'Field Mappings', value: String(simSnap.mappingsCount), rawValue: simSnap.mappingsCount, subtitle: 'CG_FIELD_MAPPING', severity: 'neutral', valueKind: 'ACTUAL' },
              { label: 'SAP Candidate Services', value: String(simSnap.sapODataCount), rawValue: simSnap.sapODataCount, subtitle: 'OData & CDS Views', severity: 'neutral', valueKind: 'ACTUAL' },
              { label: 'HANA Tables', value: String(simSnap.hanaTableCount), rawValue: simSnap.hanaTableCount, subtitle: `${simSnap.standbyCount} connectors Standby`, severity: 'warning', valueKind: 'ACTUAL' }
            ]
          },
          { type: 'table', title: `Matched Data Sources (${rows.length})`, columns, rows }
        ],
        assumptions: ['All connectors operate with simulated demo INR data; standby connectors are pre-configured and ready to connect.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
        suggestedFollowUps: ['Show me all data sources and active, standby status', 'Show me SorceID', 'Show CDS entities']
      };
    }

    const filterNote = filters.neverSynced
      ? ' that have never synced'
      : filters.connectorFilter === 'SAP_BTP_HANA'
        ? ' matching SAP BTP & HANA'
        : (filters.statuses?.length ? ` (${filters.statuses.join(' & ').toLowerCase()})` : '');
    const idMention = columns.some(c => c.canonicalKey === 'id') ? ' with Source IDs' : '';
    const registrySummary = !filters.neverSynced && !filters.statuses?.length && !filters.connectorFilter
      ? `Showing all ${rows.length} registered connectors from /api/v2/connectors (${simSnap.activeCount} ACTIVE, ${simSnap.standbyCount} STANDBY${allBreakdown.counts.demo ? `, ${allBreakdown.counts.demo} DEMO` : ''}; ${simSnap.mappingsCount} field mappings, ${simSnap.hanaTableCount} HANA tables, ${simSnap.sapODataCount} SAP candidate OData services).`
      : `Showing ${rows.length} data ${rows.length === 1 ? 'source' : 'sources'}${filterNote}${idMention}: ${buildConnectorBreakdown(rows).text}.`;

    return {
      intent: { primary: plan.intent || 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.97 },
      showTableAboveFold: true,
      title: `SAP BTP & HANA CDS Data Sources${idMention}`,
      summary: registrySummary,
      sourceTabId: 'simulator',
      sourceTabLabel: 'SAP BTP & HANA CDS',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        { type: 'table', title: `Connectors & Data Sources (${rows.length})`, columns, rows, pageSize: 10, showAllByDefault: rows.length <= 10 }
      ],
      assumptions: ['Read directly from the /api/v2/connectors registry shared with SAP BTP & HANA CDS.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
      suggestedFollowUps: ['Which connectors never synced?', 'Show scheduler daemon status', 'Show CDS entities']
    };
  }

  // Special handling for COUNTRY_EXPOSURE / COMPANY_CODE_EXPOSURE (metric-aware: Credit Limit vs Exposure!)
  if (entity === 'country_exposure' || entity === 'company_code_exposure') {
    const dimLabel = entity === 'company_code_exposure' ? 'Company Code' : 'Country';
    const isCreditLimitMetric = filters.metric === 'creditLimit';
    const totalGroupLimit = rows.reduce((s, r) => s + Number(r.creditLimit || 0), 0);
    const totalGroupExposure = rows.reduce((s, r) => s + Number(r.exposure || 0), 0);
    const totalGroupCustomers = rows.reduce((s, r) => s + Number(r.customerCount || 0), 0);
    const topLeader = rows[0];

    const headline = isCreditLimitMetric
      ? `Total credit limit across ${rows.length} ${dimLabel.toLowerCase()} cohorts (${totalGroupCustomers} customers) is ${formatINR(totalGroupLimit)}${topLeader ? ` (highest: ${topLeader.groupKey} at ${formatINR(topLeader.creditLimit)})` : ''}.`
      : `Total portfolio exposure across ${rows.length} ${dimLabel.toLowerCase()} cohorts (${totalGroupCustomers} customers) is ${formatINR(totalGroupExposure)} against ${formatINR(totalGroupLimit)} in limits.`;

    return {
      intent: {
        primary: entity === 'company_code_exposure' ? 'EXPOSURE_BY_COMPANY_CODE' : 'EXPOSURE_BY_COUNTRY',
        secondary: [],
        confidence: 0.97,
        resolvedFromContext: Boolean(plan.resolvedFromContext),
        contextNote: plan.contextNote || null
      },
      showTableAboveFold: true,
      title: isCreditLimitMetric ? `Credit Limit Breakdown by ${dimLabel}` : `Exposure Analysis by ${dimLabel}`,
      summary: headline,
      sourceTabId: 'analysis',
      sourceTabLabel: 'Exposure Analysis',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: `${isCreditLimitMetric ? 'Credit Limit' : 'Exposure'} by ${dimLabel}`,
          columns,
          rows,
          pageSize: 10,
          showAllByDefault: true
        },
        {
          type: 'chart',
          chartType: 'donut',
          title: `${isCreditLimitMetric ? 'Credit Limit' : 'Exposure'} Share by ${dimLabel}`,
          unit: 'INR',
          valueKind: 'CALCULATED',
          series: [{
            name: isCreditLimitMetric ? 'Credit Limit (INR)' : 'Exposure (INR)',
            data: rows.map(r => ({
              label: r.groupKey,
              value: isCreditLimitMetric ? r.creditLimit : r.exposure,
              status: r.status
            }))
          }]
        }
      ],
      assumptions: ['Calculated from the same shared portfolio dataset used by Exposure Analysis in simulated INR.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.analysis'] },
      suggestedFollowUps: [
        entity === 'country_exposure' ? 'Exposure by company code' : 'Credit limit with country wise',
        'Where can I see country-wise exposure?',
        'Customers above 80% utilisation'
      ]
    };
  }

  // Special handling for LIMIT_REQUESTS ("How many pending limit approvals?", "Who requested the last limit change?", "What is on the Limit Approvals tab?")
  if (entity === 'limit_requests') {
    const snap = adapter.getSnapshot();
    if (operation === 'COUNT') {
      return {
        intent: { primary: 'LIMIT_APPROVALS_STATUS', secondary: [], confidence: 0.98 },
        showTableAboveFold: false,
        title: 'Limit Approvals Count',
        summary: `There ${snap.pendingCount === 1 ? 'is' : 'are'} ${rows.length} ${filters.status ? `${String(filters.status).toLowerCase()} ` : ''}limit approval ${rows.length === 1 ? 'request' : 'requests'} (${snap.pendingCount} Pending, ${snap.approvedCount} Approved, ${snap.rejectedCount} Rejected across ${snap.totalCount} total).`,
        sourceTabId: 'approvals',
        sourceTabLabel: 'Limit Approvals',
        dataAsOf,
        headlineBullets: [],
        blocks: [
          {
            type: 'metrics',
            items: [
              { label: 'Pending Approvals (Sidebar Badge)', value: String(snap.pendingCount), rawValue: snap.pendingCount, severity: snap.pendingCount > 0 ? 'warning' : 'healthy', valueKind: 'ACTUAL' },
              { label: 'Approved', value: String(snap.approvedCount), rawValue: snap.approvedCount, severity: 'healthy', valueKind: 'ACTUAL' },
              { label: 'Rejected', value: String(snap.rejectedCount), rawValue: snap.rejectedCount, severity: 'neutral', valueKind: 'ACTUAL' },
              { label: 'Total Requests', value: String(snap.totalCount), rawValue: snap.totalCount, severity: 'neutral', valueKind: 'ACTUAL' }
            ]
          },
          { type: 'table', title: `Limit Requests (${rows.length})`, columns, rows }
        ],
        assumptions: ['Count matches the Limit Approvals sidebar badge (#pending-count).'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.approvals'] },
        suggestedFollowUps: ['Who requested the last limit change?', 'What is on the Limit Approvals tab?', 'Summarize Credit Overview']
      };
    }

    if (/\bwho\s+requested\b|\blast\s+limit\s+change\b/i.test(rawQuestion)) {
      const latestReq = rows[0] || snap.lastRequest;
      const summaryText = latestReq
        ? `The latest limit change request (${latestReq.ID}) was submitted by "${latestReq.requestedBy}" for ${latestReq.customer} (${latestReq.customerId}): ${formatINR(latestReq.currentLimit)} -> ${formatINR(latestReq.requestedLimit)} (${latestReq.status}, routed to ${latestReq.approverLevel}).`
        : 'No credit limit change requests have been submitted yet.';
      return {
        intent: { primary: 'LIMIT_APPROVALS_STATUS', secondary: [], confidence: 0.97 },
        showTableAboveFold: Boolean(latestReq),
        title: 'Latest Credit Limit Change Request',
        summary: summaryText,
        sourceTabId: 'approvals',
        sourceTabLabel: 'Limit Approvals',
        dataAsOf,
        headlineBullets: [],
        blocks: latestReq ? [{ type: 'table', title: 'Latest Limit Request', columns, rows: [latestReq] }] : [],
        assumptions: ['Approval decisions remain restricted to authorized users inside the Limit Approvals tab.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.approvals'] },
        suggestedFollowUps: ['How many pending limit approvals?', 'Open Limit Approvals', 'Summarize Credit Overview']
      };
    }

    return {
      intent: { primary: 'LIMIT_APPROVALS_STATUS', secondary: [], confidence: 0.97 },
      showTableAboveFold: true,
      title: 'Limit Approvals Overview',
      summary: `Limit Approvals currently tracks ${snap.pendingCount} pending, ${snap.approvedCount} approved, and ${snap.rejectedCount} rejected credit limit requests (showing ${rows.length} ${rows.length === 1 ? 'request' : 'requests'}).`,
      navigationAction: /\bwhat is on\b|\btab\b/i.test(rawQuestion) ? { tabId: 'approvals', label: 'Open Limit Approvals' } : null,
      sourceTabId: 'approvals',
      sourceTabLabel: 'Limit Approvals',
      dataAsOf,
      headlineBullets: [],
      blocks: rows.length
        ? [{ type: 'table', title: `Limit Requests (${rows.length})`, columns, rows }]
        : [{ type: 'notice', severity: 'info', title: 'No Matching Limit Requests', message: 'No limit requests match the current filter.' }],
      assumptions: ['AI is read-only; approvals must be submitted and decided in Limit Approvals.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.approvals'] },
      suggestedFollowUps: ['How many pending limit approvals?', 'Who requested the last limit change?', 'Summarize Credit Overview']
    };
  }

  // Special handling for ALERTS ("Which alerts are critical?")
  if (entity === 'alerts') {
    const sevText = filters.severity ? `${filters.severity.toLowerCase()} ` : '';
    const headline = operation === 'COUNT'
      ? `There ${rows.length === 1 ? 'is' : 'are'} ${rows.length} ${sevText}monitoring ${rows.length === 1 ? 'alert' : 'alerts'} (out of ${allRecords.length} total).`
      : `Found ${rows.length} ${sevText}monitoring ${rows.length === 1 ? 'alert' : 'alerts'}${rows.length ? `: ${rows.slice(0, 3).map(r => `${r.customerId} (${r.severity})`).join(', ')}` : ' in the latest monitoring snapshot'}.`;

    return {
      intent: { primary: 'MONITORING_ALERTS', secondary: [], confidence: 0.97 },
      showTableAboveFold: operation !== 'COUNT' && rows.length > 0,
      title: `Portfolio & Monitoring Alerts${filters.severity ? ` (${filters.severity})` : ''}`,
      summary: headline,
      sourceTabId: 'dashboard',
      sourceTabLabel: 'Portfolio & Monitoring',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        rows.length > 0
          ? { type: 'table', title: `Monitoring Alerts (${rows.length})`, columns, rows }
          : { type: 'notice', severity: 'info', title: 'No Matching Alerts', message: `No ${sevText}monitoring alerts are currently active in Portfolio & Monitoring.` }
      ],
      assumptions: ['Alerts are read directly from the Portfolio & Monitoring store.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.dashboard'] },
      suggestedFollowUps: ['Show monitoring status', 'Customers above 80% utilisation', 'Summarize Credit Overview']
    };
  }

  // Special handling for MONITORING_RUNS ("Show monitoring status", "When did monitoring last run?")
  if (entity === 'monitoring_runs') {
    const snap = adapter.getSnapshot();
    const lastRunText = snap.lastRunAt ? formatDataAsOf(snap.lastRunAt) : 'not yet run';
    const summaryText = `Monitoring status is ${snap.latestRunStatus} (last run: ${lastRunText}): ${snap.customersMonitored} customers monitored — ${snap.breachedCustomers} breached, ${snap.criticalCustomers} critical, ${snap.warningCustomers} warning, and ${snap.activeAlerts} active alerts.`;
    return {
      intent: { primary: 'MONITORING_ANALYSIS', secondary: [], confidence: 0.97 },
      showTableAboveFold: rows.length > 0,
      title: 'Portfolio Monitoring Status & History',
      summary: summaryText,
      sourceTabId: 'dashboard',
      sourceTabLabel: 'Portfolio & Monitoring',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Latest Status', value: snap.latestRunStatus, valueKind: 'ACTUAL' },
            { label: 'Warning', value: String(snap.warningCustomers), rawValue: snap.warningCustomers, severity: snap.warningCustomers > 0 ? 'warning' : 'healthy', valueKind: 'ACTUAL' },
            { label: 'Breached', value: String(snap.breachedCustomers), rawValue: snap.breachedCustomers, severity: snap.breachedCustomers > 0 ? 'critical' : 'healthy', valueKind: 'ACTUAL' },
            { label: 'Critical (>=120%)', value: String(snap.criticalCustomers), rawValue: snap.criticalCustomers, severity: snap.criticalCustomers > 0 ? 'critical' : 'healthy', valueKind: 'ACTUAL' }
          ]
        },
        ...(rows.length ? [{ type: 'table', title: `Monitoring Runs (${rows.length})`, columns, rows }] : [])
      ],
      assumptions: ['Status reflects the live Portfolio & Monitoring state and 5-minute scheduler.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.dashboard'] },
      suggestedFollowUps: ['Which alerts are critical?', 'Customers above 80% utilisation', 'Summarize Credit Overview']
    };
  }

  // Special handling for SCHEDULER_STATUS ("Show scheduler daemon status", "When is the next scheduler cycle?")
  if (entity === 'scheduler_status') {
    const sched = rows[0] || collectSchedulerRecord(state)[0];
    const hasError = sched.state === 'ERROR' || (sched.lastError && sched.lastError !== 'None');
    const summaryText = `Autonomous Scheduler Daemon is ${sched.state} (${sched.intervalMinutes}-minute heartbeat): ${sched.successfulRuns}/${sched.totalRuns} cycles succeeded, ${sched.failedRuns} failed. Last cycle: ${sched.lastCycleTime} · Next cycle: ${sched.nextCycleTime}${hasError ? ` · Last error: ${sched.lastError}` : ''}.`;
    return {
      intent: { primary: plan.intent || 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.97 },
      showTableAboveFold: false,
      title: 'Autonomous Credit Monitoring Scheduler Daemon',
      summary: summaryText,
      sourceTabId: 'simulator',
      sourceTabLabel: 'SAP BTP & HANA CDS',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Daemon State', value: sched.state, severity: sched.state === 'ERROR' ? 'critical' : sched.state === 'RUNNING' ? 'healthy' : 'neutral', valueKind: 'ACTUAL' },
            { label: 'Heartbeat Interval', value: `${sched.intervalMinutes} min`, rawValue: sched.intervalMinutes, valueKind: 'ACTUAL' },
            { label: 'Cycle Telemetry', value: `${sched.successfulRuns} / ${sched.totalRuns}`, subtitle: `${sched.skippedRuns} skipped · ${sched.failedRuns} failed`, valueKind: 'ACTUAL' },
            { label: 'Next Scheduled Cycle', value: sched.nextCycleTime, subtitle: `Last: ${sched.lastCycleTime}`, valueKind: 'ACTUAL' }
          ]
        },
        { type: 'table', title: 'Autonomous Scheduler Status', columns, rows: [sched] }
      ],
      assumptions: ['Read directly from the /api/v2/monitoring/scheduler-status store shared with SAP BTP & HANA CDS.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
      suggestedFollowUps: ['Show me recent data extraction timelines', 'Show me all data sources and active, standby status', 'Show monitoring status']
    };
  }

  // Special handling for MOCK_SAP_STAGING (Part 5 Option A & Part 6 Data Quality)
  if (entity === 'mock_sap_staging') {
    const bundle = collectMockSapStagingBundle(state);
    const wantsInvoices = /\binvoices?\b|\bopen\s+items?\b|\bmsinv/i.test(rawQuestion);
    const wantsAccounts = /\bcredit\s+accounts?\b|\bms-ca\d+/i.test(rawQuestion);
    const wantsPayments = /\bpayments?\b|\bmspay/i.test(rawQuestion);
    const targetIds = Array.isArray(filters.customerIds) ? filters.customerIds.filter(id => /^MS-C\d+/i.test(id)) : [];

    if (wantsInvoices) {
      const invRows = targetIds.length
        ? bundle.invoices.filter(r => targetIds.includes(r.customerId))
        : bundle.invoices;
      const totalInvAmt = invRows.reduce((s, r) => s + r.amount, 0);
      return {
        intent: { primary: 'MOCK_SAP_STAGING', secondary: [], confidence: 0.97 },
        showTableAboveFold: true,
        title: 'Mock SAP Open Invoices · Synthetic staging data (not in portfolio totals)',
        summary: `Synthetic staging data (not in portfolio totals): ${invRows.length} Mock SAP open ${invRows.length === 1 ? 'invoice' : 'invoices'} totaling ${formatINR(totalInvAmt)} (${invRows.filter(r => r.status === 'OVERDUE').length} OVERDUE).`,
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [{
          type: 'table',
          title: `Mock SAP Invoices (${invRows.length}) · Synthetic staging data`,
          columns: [
            { key: 'invoiceId', label: 'Invoice', align: 'left', format: 'text' },
            { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
            { key: 'customerId', label: 'Customer ID', align: 'left', format: 'text' },
            { key: 'amount', label: 'Outstanding', align: 'right', format: 'currency' },
            { key: 'dueDate', label: 'Due Date', align: 'left', format: 'text' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' }
          ],
          rows: invRows
        }],
        assumptions: ['Synthetic staging data (not in portfolio totals). Active portfolio remains strictly at 13 canonical customers.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator', 'mockSap.staging'] },
        suggestedFollowUps: ['Show mock SAP customers', 'Show mock SAP credit accounts', 'Evaluate MS-C004']
      };
    }

    if (wantsAccounts) {
      const accRows = targetIds.length
        ? bundle.accounts.filter(r => targetIds.includes(r.customerId))
        : bundle.accounts;
      return {
        intent: { primary: 'MOCK_SAP_STAGING', secondary: [], confidence: 0.97 },
        showTableAboveFold: true,
        title: 'Mock SAP Credit Accounts · Synthetic staging data (not in portfolio totals)',
        summary: `Synthetic staging data (not in portfolio totals): ${accRows.length} Mock SAP credit ${accRows.length === 1 ? 'account' : 'accounts'} (${accRows.filter(a => a.creditLimit <= 0).length} with No limit set).`,
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [{
          type: 'table',
          title: `Mock SAP Credit Accounts (${accRows.length}) · Synthetic staging data`,
          columns: [
            { key: 'accountId', label: 'Account ID', align: 'left', format: 'text' },
            { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
            { key: 'customerId', label: 'Customer ID', align: 'left', format: 'text' },
            { key: 'creditLimitDisplay', label: 'Credit Limit', align: 'right', format: 'text' },
            { key: 'creditSegment', label: 'Credit Segment', align: 'left', format: 'text' }
          ],
          rows: accRows
        }],
        assumptions: ['Synthetic staging data (not in portfolio totals). Zero-limit accounts display No limit set.'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator', 'mockSap.staging'] },
        suggestedFollowUps: ['Show mock SAP customers', 'Show mock SAP invoices', 'Evaluate MS-C004']
      };
    }

    if (wantsPayments) {
      const payRows = targetIds.length
        ? bundle.payments.filter(r => targetIds.includes(r.customerId))
        : bundle.payments;
      const totalPayAmt = payRows.reduce((s, r) => s + r.amount, 0);
      return {
        intent: { primary: 'MOCK_SAP_STAGING', secondary: [], confidence: 0.97 },
        showTableAboveFold: true,
        title: 'Mock SAP Payments · Synthetic staging data (not in portfolio totals)',
        summary: `Synthetic staging data (not in portfolio totals): ${payRows.length} Mock SAP ${payRows.length === 1 ? 'payment' : 'payments'} totaling ${formatINR(totalPayAmt)}.`,
        sourceTabId: 'simulator',
        sourceTabLabel: 'SAP BTP & HANA CDS',
        dataAsOf,
        headlineBullets: [],
        blocks: [{
          type: 'table',
          title: `Mock SAP Payments (${payRows.length}) · Synthetic staging data`,
          columns: [
            { key: 'paymentId', label: 'Payment ID', align: 'left', format: 'text' },
            { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
            { key: 'customerId', label: 'Customer ID', align: 'left', format: 'text' },
            { key: 'amount', label: 'Amount', align: 'right', format: 'currency' },
            { key: 'postingDate', label: 'Posting Date', align: 'left', format: 'text' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' }
          ],
          rows: payRows
        }],
        assumptions: ['Synthetic staging data (not in portfolio totals).'],
        limitations: [],
        dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator', 'mockSap.staging'] },
        suggestedFollowUps: ['Show mock SAP customers', 'Show mock SAP invoices', 'Show mock SAP credit accounts']
      };
    }

    const custRows = targetIds.length
      ? bundle.customers.filter(c => targetIds.includes(c.ID))
      : bundle.customers;
    const singleCust = targetIds.length === 1 && custRows.length === 1 ? custRows[0] : null;
    const summaryText = singleCust
      ? `Synthetic staging data (not in portfolio totals): ${singleCust.customer} (${singleCust.ID}) in ${singleCust.country} (${singleCust.companyCode}) has ${formatINR(singleCust.exposure)} open exposure, credit limit ${singleCust.creditLimitDisplay}, utilisation ${singleCust.utilisationDisplay}, and status ${singleCust.status}.`
      : `Synthetic staging data (not in portfolio totals): ${custRows.length} Mock SAP staging customers totaling ${formatINR(bundle.counts.totalExposure)} open items against ${formatINR(bundle.counts.totalLimit)} total limit (${custRows.filter(c => c.isNoLimit).length} No limit set). Active Credit Guard portfolio remains separate at 13 customers.`;

    return {
      intent: { primary: 'MOCK_SAP_STAGING', secondary: [], confidence: 0.97 },
      showTableAboveFold: true,
      title: singleCust
        ? `Mock SAP Staging Profile: ${singleCust.customer} (${singleCust.ID}) · Synthetic staging data (not in portfolio totals)`
        : 'Mock SAP Staging Customers · Synthetic staging data (not in portfolio totals)',
      summary: summaryText,
      sourceTabId: 'simulator',
      sourceTabLabel: 'SAP BTP & HANA CDS',
      dataAsOf,
      headlineBullets: [],
      blocks: custRows.length > 0
        ? [{ type: 'table', title: `Mock SAP Staging Customers (${custRows.length}) · Synthetic staging data`, columns, rows: custRows, pageSize: 10, showAllByDefault: true }]
        : [{ type: 'notice', severity: 'info', title: 'Mock SAP Staging Not Loaded', message: 'Synthetic staging data (not in portfolio totals) will appear once Mock SAP fixtures are loaded in SAP BTP & HANA CDS.' }],
      assumptions: ['Synthetic staging data (not in portfolio totals) from MOCK-SAP-FIN-FSCM (Simulator ID: MOCK-S4-001). Country codes normalized (IN -> India) and ₹0 limits labeled No limit set / N/A (no limit).'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator', 'mockSap.staging'] },
      suggestedFollowUps: ['Show mock SAP invoices', 'Show mock SAP credit accounts', 'Show mock SAP payments']
    };
  }

  // Special handling for CDS_ENTITIES ("Show CDS entities", "How many field mappings?", "HANA tables")
  if (entity === 'cds_entities') {
    const simSnap = adapter.getSnapshot();
    const wantsHanaOnly = /\bhana\s+(?:replicated\s+)?tables?\b/i.test(rawQuestion);
    const wantsODataOnly = /\bodata\s+services?\b/i.test(rawQuestion);
    const filteredCds = wantsHanaOnly
      ? rows.filter(r => r.category === 'HANA_REPLICATED')
      : wantsODataOnly
        ? rows.filter(r => r.category === 'SAP_ODATA')
        : rows;
    return {
      intent: { primary: 'CDS_ENTITIES_LIST', secondary: [], confidence: 0.97 },
      showTableAboveFold: filteredCds.length > 0,
      title: 'SAP BTP & HANA CDS Entities, Mappings & OData Services',
      summary: `Found ${filteredCds.length} SAP HANA / CDS & OData items (${simSnap.mappingsCount} field mappings in CG_FIELD_MAPPING, ${simSnap.hanaTableCount} HANA replicated tables, ${simSnap.sapODataCount} SAP candidate OData services).`,
      sourceTabId: 'simulator',
      sourceTabLabel: 'SAP BTP & HANA CDS',
      dataAsOf,
      headlineBullets: [],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Field Mappings', value: String(simSnap.mappingsCount), rawValue: simSnap.mappingsCount, subtitle: 'CG_FIELD_MAPPING', valueKind: 'ACTUAL' },
            { label: 'HANA Tables', value: String(simSnap.hanaTableCount), rawValue: simSnap.hanaTableCount, subtitle: 'Replicated Tables', valueKind: 'ACTUAL' },
            { label: 'SAP Candidate Services', value: String(simSnap.sapODataCount), rawValue: simSnap.sapODataCount, subtitle: 'OData & CDS Views', valueKind: 'ACTUAL' },
            { label: 'Canonical Models', value: String(rows.filter(r => r.category === 'CANONICAL_CDS').length), rawValue: rows.filter(r => r.category === 'CANONICAL_CDS').length, subtitle: 'FIN-FSCM-CR', valueKind: 'ACTUAL' }
          ]
        },
        { type: 'table', title: `CDS, HANA & OData Registry (${filteredCds.length})`, columns, rows: filteredCds, pageSize: 15, showAllByDefault: filteredCds.length <= 20 }
      ],
      assumptions: ['Canonical schema and field mappings match the SAP BTP & HANA CDS registry in /api/v2/connectors.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.simulator'] },
      suggestedFollowUps: ['Show me all data sources and active, standby status', 'Show scheduler daemon status', 'Show me recent data extraction timelines']
    };
  }

  // Special handling for AUDIT_RUNS ("Show audit history for today", "What did the agent do last?")
  if (entity === 'audit_runs') {
    const snap = adapter.getSnapshot();
    const isLastAction = /\blast\b|\bwhat did\b/i.test(rawQuestion);
    const latest = rows[0] || snap.lastExecution;
    const summaryText = rows.length === 0
      ? `0 agent execution runs matched (${snap.conversationCount} saved conversations; memory ${snap.memoryEnabled === false ? 'disabled' : 'enabled'}).`
      : isLastAction && latest
        ? `Last agent execution (${latest.startedAt}) finished with status ${latest.status} across ${latest.stepCount} step(s): ${latest.summary}.`
        : `Showing ${rows.length} agent execution ${rows.length === 1 ? 'run' : 'runs'} from AI Audit History (${snap.conversationCount} saved conversations; memory ${snap.memoryEnabled === false ? 'disabled' : 'enabled'}).`;
    return {
      intent: { primary: 'AUDIT_HISTORY', secondary: [], confidence: 0.96 },
      showTableAboveFold: operation !== 'COUNT' && rows.length > 0,
      title: 'AI Audit History & Agent Executions',
      summary: summaryText,
      sourceTabId: 'audit',
      sourceTabLabel: 'AI Audit History',
      dataAsOf,
      headlineBullets: [],
      blocks: rows.length > 0
        ? [{ type: 'table', title: `Agent Execution History (${rows.length})`, columns, rows, pageSize: 10, showAllByDefault: rows.length <= 10 }]
        : [{ type: 'notice', severity: 'info', title: 'No Matching Audit Executions', message: 'No agent execution records were found for the requested window.' }],
      assumptions: ['Read from the persisted AI Audit History store.'],
      limitations: [],
      dataProvenance: { ...baseProv, toolsInvoked: ['workspaceContext.audit'] },
      suggestedFollowUps: ['What did the agent do last?', 'Show me all data sources and active, standby status', 'Summarize Credit Overview']
    };
  }

  // Generic fallback table output for any remaining entity (findings, limit_drafts, etc.)
  return {
    intent: { primary: plan.intent || 'WORKSPACE_QUERY', secondary: [], confidence: 0.95 },
    showTableAboveFold: operation !== 'COUNT' && rows.length > 0,
    title: `${adapter.label} · ${entity.replaceAll('_', ' ')}`,
    summary: rows.length > 0
      ? `Showing ${rows.length} record${rows.length === 1 ? '' : 's'} from ${adapter.label}.`
      : `No ${entity.replaceAll('_', ' ')} records are currently available in ${adapter.label}.`,
    sourceTabId: spec.tabId || adapter.tabId,
    sourceTabLabel: spec.tabLabel || adapter.label,
    dataAsOf,
    headlineBullets: [],
    blocks: rows.length > 0
      ? [{ type: 'table', title: `${adapter.label} (${rows.length})`, columns, rows, pageSize: 10, showAllByDefault: rows.length <= 10 }]
      : [{ type: 'notice', severity: 'info', title: 'No Records Found', message: `No ${entity.replaceAll('_', ' ')} records are present.` }],
    assumptions: [`Read-only view from ${adapter.label}.`],
    limitations: [],
    dataProvenance: { ...baseProv, toolsInvoked: [`workspaceContext.${adapter.tabId}`] },
    suggestedFollowUps: ['Summarize Credit Overview', 'How many pending limit approvals?', 'Show me all data sources and active, standby status']
  };
}

const registryApi = {
  TAB_META,
  SYNONYM_MAP,
  ENTITY_CATALOG,
  normalizeCountryLabel,
  selectCanonicalCustomers,
  getWorkspaceAdapters,
  getWorkspaceAdapterByTab,
  getActiveTabContext,
  executeWorkspacePlan
};

if (typeof globalThis !== 'undefined') {
  globalThis.__CG_WORKSPACE_CONTEXT__ = registryApi;
}

export default registryApi;
