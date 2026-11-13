const CSRF_TOKEN_ENDPOINT = '/credit/index.html';
let csrfToken;
let csrfTokenPromise;
const inMemoryLimitRequestKeys = new Map();

function isLoopbackHost() {
  const hostname = globalThis.location?.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isFormData(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function isStateChangingMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

async function fetchSameOrigin(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  let controller = null;
  let timerId = null;
  let didTimeout = false;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortController === 'function' && !fetchOptions.signal) {
    controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timerId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
  }
  try {
    return await fetch(path, {
      ...fetchOptions,
      credentials: fetchOptions.credentials || 'same-origin'
    });
  } catch {
    if (didTimeout) {
      throw new Error(`Request to ${path} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error('Cannot reach Credit Guard. Check that the server is running on port 4005, then try again.');
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

async function readResponseBody(response) {
  return response.json().catch(() => ({}));
}

function throwResponseError(response, body) {
  throw new Error(body.error || `The request failed (${response.status}). Try again.`);
}

async function acquireCsrfToken() {
  const response = await fetchSameOrigin(CSRF_TOKEN_ENDPOINT, {
    method: 'GET',
    headers: { 'X-CSRF-Token': 'Fetch' }
  });
  if (!response.ok) {
    throwResponseError(response, await readResponseBody(response));
  }
  const token = response.headers.get('X-CSRF-Token');
  if (!token || ['fetch', 'required'].includes(token.toLowerCase())) {
    if (isLoopbackHost()) return undefined;
    throw new Error('Credit Guard could not establish a secure browser session. Reload the page and try again.');
  }
  await response.text();
  return token;
}

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  if (!csrfTokenPromise) csrfTokenPromise = acquireCsrfToken();
  try {
    csrfToken = await csrfTokenPromise;
    return csrfToken;
  } finally {
    csrfTokenPromise = undefined;
  }
}

function invalidateCsrfToken(token) {
  if (csrfToken === token) csrfToken = undefined;
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const stateChanging = isStateChangingMethod(method);
  const token = stateChanging ? await getCsrfToken() : undefined;
  const headers = new Headers(options.headers || {});
  if (!isFormData(options.body) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (stateChanging && token) headers.set('X-CSRF-Token', token);

  const response = await fetchSameOrigin(path, {
    ...options,
    method,
    headers,
    credentials: options.credentials || 'same-origin'
  });
  const csrfRejected = response.headers.get('X-CSRF-Token')?.toLowerCase() === 'required';
  if (stateChanging && (csrfRejected || response.status === 401 || response.status === 403)) {
    invalidateCsrfToken(token);
  }
  const body = await readResponseBody(response);
  if (!response.ok) throwResponseError(response, body);
  return body;
}

export { request };

export const getSession = () => request('/api/session');
export const getMockSap = () => request('/api/mock-sap');
export const extractMockSap = () => request('/api/mock-sap/extract', {
  method: 'POST',
  body: JSON.stringify({})
});
export const runMockSapMonitoring = () => request('/api/mock-sap/monitoring', {
  method: 'POST',
  body: JSON.stringify({})
});
export const getDashboard = () => request('/api/dashboard');
export const getMonitoringSummary = () => request('/api/monitoring/summary');
export const getMonitoringRuns = (limit = 20) => request(`/api/monitoring/runs?limit=${encodeURIComponent(limit)}`);
export const getMonitoringRun = runId => request(`/api/monitoring/runs/${encodeURIComponent(runId)}`);
export async function waitForMonitoringRun(runId, { intervalMs = 2000, onStatus } = {}) {
  let run;
  do {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    run = await getMonitoringRun(runId);
    onStatus?.(run);
  } while (run.status === 'QUEUED' || run.status === 'RUNNING');
  return run;
}
export const getMonitoringFindings = runId => request(`/api/monitoring/runs/${encodeURIComponent(runId)}/findings`);
export const getMonitoringAlerts = (status = 'ACTIVE') =>
  request(`/api/monitoring/alerts?status=${encodeURIComponent(status)}`);
export const runMonitoring = () => request('/api/monitoring/runs', { method: 'POST' });
export const acknowledgeMonitoringAlert = id => request(
  `/api/monitoring/alerts/${encodeURIComponent(id)}/acknowledge`,
  { method: 'POST' }
);
export const resolveMonitoringAlert = id => request(
  `/api/monitoring/alerts/${encodeURIComponent(id)}/resolve`,
  { method: 'POST' }
);
export const getCustomers = () => request('/api/customers');
export const getCustomer = id => request(`/api/customers/${encodeURIComponent(id)}`);
export const getCustomerPayments = id => request(`/api/customers/${encodeURIComponent(id)}/payments`);
export const getLimitRequests = status => request(`/api/limit-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const getApprovalHistory = requestId => request(
  `/api/limit-requests/${encodeURIComponent(requestId)}/history`
);

let simulatedExtractionFailure = false;

export function setSimulatedExtractionFailure(shouldFail) {
  simulatedExtractionFailure = Boolean(shouldFail);
}

/**
 * CENTRAL DATA SERVICE (Single Source of Truth)
 * ----------------------------------------------------------------------------
 * NOTE: This is the SINGLE place to replace with the real SAP BTP / CAP /
 * HANA CDS extraction call in production.
 *
 * ARCHITECTURE NOTE:
 * In production, the 5-minute extraction and monitoring cycle should run as a
 * backend scheduled job (for example, a CAP / SAP BTP Job Scheduler or cron
 * worker), with the frontend only polling or subscribing for the persisted
 * result. The frontend 5-minute timer is used only for this demo.
 *
 * Returns the deterministic demo portfolio dataset (customers, exposures,
 * limits, overdue invoices, and limit requests) stamped with a fresh
 * retrievedAt ISO timestamp.
 */
const STAGING_CUSTOMER_ID_RE = /^MS-C/i;

function isMockSapStagingCustomer(customer) {
  if (!customer || typeof customer !== 'object') return false;
  return STAGING_CUSTOMER_ID_RE.test(String(customer.ID || ''))
    || customer.sourceSystem === 'MOCK_SAP'
    || customer.isMockSapStaging === true;
}

function normalizeCountryLabel(country) {
  const raw = String(country || '').trim();
  if (raw.toUpperCase() === 'IN') return 'India';
  return raw || 'Unknown';
}

function computeCanonicalGroupExposure(customers, groupKey) {
  const grouped = new Map();
  for (const c of customers) {
    const label = groupKey === 'country' ? normalizeCountryLabel(c.country) : (c.companyCode || 'Unknown');
    const currency = c.currency || 'INR';
    const row = grouped.get(label) || {
      label,
      currency,
      exposure: 0,
      creditLimit: 0,
      customers: 0
    };
    row.exposure += Number(c.exposure) || 0;
    row.creditLimit += Number(c.creditLimit) || 0;
    row.customers += 1;
    grouped.set(label, row);
  }
  return [...grouped.values()]
    .map(row => ({
      ...row,
      utilisation: row.creditLimit > 0 ? row.exposure / row.creditLimit : null
    }))
    .sort((a, b) => b.exposure - a.exposure);
}

/**
 * Option A Staging Isolation:
 * Keeps active Credit Guard portfolio strictly to canonical customers (13)
 * and separates synthetic Mock SAP staging customers (MS-C*) into staging state
 * so active KPIs and exposure breakdowns are never inflated.
 */
export function separateMockSapStagingPortfolio(dashboard = {}, rawCustomers = []) {
  const list = Array.isArray(rawCustomers) ? rawCustomers : [];
  const mockSapStagingCustomers = [];
  const customers = [];

  for (const item of list) {
    if (isMockSapStagingCustomer(item)) {
      mockSapStagingCustomers.push({
        ...item,
        country: normalizeCountryLabel(item.country),
        isMockSapStaging: true
      });
    } else {
      customers.push(item);
    }
  }

  if (mockSapStagingCustomers.length === 0) {
    return {
      dashboard,
      customers,
      mockSapStagingCustomers
    };
  }

  const totalExposure = customers.reduce((sum, c) => sum + (Number(c.exposure) || 0), 0);
  const totalLimit = customers.reduce((sum, c) => sum + (Number(c.creditLimit) || 0), 0);
  const overdueAmount = customers.reduce((sum, c) => sum + (Number(c.overdueAmount) || 0), 0);
  const currency = customers[0]?.currency || dashboard?.kpis?.currency || 'INR';

  const recomputedKpis = {
    ...(dashboard?.kpis || {}),
    currency,
    totalExposure,
    totalLimit,
    overallUtilisation: totalLimit > 0 ? totalExposure / totalLimit : null,
    availableCredit: (totalLimit - totalExposure).toFixed(2),
    overdueAmount: overdueAmount.toFixed(2),
    customersBreached: customers.filter(c => c.status === 'BREACH').length,
    warningCustomers: customers.filter(c => c.status === 'WARNING').length,
    criticalCustomers: customers.filter(c => Array.isArray(c.flags)
      ? c.flags.includes('CRITICAL')
      : (Number(c.creditLimit) > 0 && (Number(c.exposure) / Number(c.creditLimit)) >= 1.2)).length,
    overdueInvoiceCount: customers.reduce((sum, c) => sum + (Number(c.overdueInvoiceCount) || 0), 0),
    manualReviewCustomers: customers.filter(c => c.status === 'MANUAL_REVIEW' || Number(c.creditLimit) === 0).length,
    overdueRiskCustomers: customers.filter(c => Array.isArray(c.flags)
      ? c.flags.includes('OVERDUE_RISK')
      : (Number(c.overdueAmount) || 0) > 0).length,
    healthyCustomers: customers.filter(c => c.status === 'HEALTHY' || c.status === 'OK').length,
    customerCount: customers.length
  };

  const recomputedExposure = {
    country: computeCanonicalGroupExposure(customers, 'country'),
    companyCode: computeCanonicalGroupExposure(customers, 'companyCode'),
    customer: customers
      .map(c => ({
        label: c.name,
        ID: c.ID,
        currency: c.currency || currency,
        exposure: Number(c.exposure) || 0,
        creditLimit: Number(c.creditLimit) || 0,
        utilisation: Number(c.creditLimit) > 0 ? (Number(c.exposure) || 0) / Number(c.creditLimit) : null
      }))
      .sort((a, b) => b.exposure - a.exposure)
  };

  return {
    dashboard: {
      ...(dashboard || {}),
      kpis: recomputedKpis,
      exposure: recomputedExposure
    },
    customers,
    mockSapStagingCustomers
  };
}

export async function fetchPortfolioData() {
  if (simulatedExtractionFailure || globalThis.__simulateExtractionFailure === true) {
    throw new Error('Simulated extraction failure: CAP database (demo) endpoint did not respond.');
  }

  const [rawDashboard, rawCustomers, rawRequests, mockSap, v2Connectors, schedulerStatus] = await Promise.all([
    getDashboard(),
    getCustomers(),
    getLimitRequests(),
    getMockSap().catch(() => null),
    getV2Connectors().catch(() => null),
    getV2SchedulerStatus().catch(() => null)
  ]);

  const { dashboard, customers, mockSapStagingCustomers } = separateMockSapStagingPortfolio(rawDashboard, rawCustomers);

  const requests = await Promise.all((rawRequests || []).map(async reqItem => ({
    ...reqItem,
    auditHistory: reqItem.status === 'Pending' ? [] : await getApprovalHistory(reqItem.ID).catch(() => [])
  })));

  const retrievedAt = new Date().toISOString();
  return {
    source: 'CAP database (demo)',
    retrievedAt,
    dashboard,
    customers,
    mockSapStagingCustomers,
    v2Connectors,
    schedulerStatus,
    exposures: dashboard?.exposure || {},
    limits: (customers || []).map(c => ({ customerId: c.ID, creditLimit: c.creditLimit, currency: c.currency })),
    invoices: {
      overdueInvoiceCount: dashboard?.kpis?.overdueInvoiceCount || 0,
      overdueAmount: dashboard?.kpis?.overdueAmount || 0
    },
    requests,
    mockSap
  };
}
function limitRequestFingerprint(payload) {
  return JSON.stringify({
    customerId: payload.customerId,
    requestedLimit: Number(payload.requestedLimit),
    reason: typeof payload.reason === 'string' ? payload.reason.trim() : payload.reason
  });
}
function readPendingLimitRequest(storageKey) {
  return globalThis.sessionStorage
    ? globalThis.sessionStorage.getItem(storageKey)
    : inMemoryLimitRequestKeys.get(storageKey) || null;
}
function writePendingLimitRequest(storageKey, value) {
  if (globalThis.sessionStorage) globalThis.sessionStorage.setItem(storageKey, value);
  else inMemoryLimitRequestKeys.set(storageKey, value);
}
function removePendingLimitRequest(storageKey) {
  if (globalThis.sessionStorage) globalThis.sessionStorage.removeItem(storageKey);
  else inMemoryLimitRequestKeys.delete(storageKey);
}
function pendingLimitRequestKey(payload, submissionId) {
  const storageKey = `creditGuard.limitRequest:${encodeURIComponent(submissionId)}`;
  const fingerprint = limitRequestFingerprint(payload);
  const storedValue = readPendingLimitRequest(storageKey);
  if (storedValue) {
    let stored;
    try { stored = JSON.parse(storedValue); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (stored?.fingerprint === fingerprint && typeof stored.key === 'string'
      && stored.key.length > 0 && stored.key.length <= 160) {
      return { storageKey, fingerprint, key: stored.key };
    }
  }
  const key = globalThis.crypto?.randomUUID?.();
  if (!key) throw new Error('Credit Guard could not create a safe request submission key.');
  writePendingLimitRequest(storageKey, JSON.stringify({ fingerprint, key }));
  return { storageKey, fingerprint, key };
}
function clearPendingLimitRequestKey({ storageKey, key }) {
  const storedValue = readPendingLimitRequest(storageKey);
  if (!storedValue) return;
  let stored;
  try { stored = JSON.parse(storedValue); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return;
  }
  if (stored?.key === key) removePendingLimitRequest(storageKey);
}
export async function createLimitRequest(payload, submissionId = 'form') {
  const submission = pendingLimitRequestKey(payload, submissionId);
  const result = await request('/api/limit-requests', {
    method: 'POST',
    headers: { 'Idempotency-Key': submission.key },
    body: JSON.stringify(payload)
  });
  clearPendingLimitRequestKey(submission);
  return result;
}
export const decideLimitRequest = (id, payload) => request(`/api/limit-requests/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(payload) });
export const recoverMonitoringRun = id => request(
  `/api/monitoring/runs/${encodeURIComponent(id)}/recover`,
  { method: 'POST' }
);
export const sendChat = (message, documentContext, conversationId) => request('/api/chat', {
  method: 'POST', body: JSON.stringify({ message, documentContext, conversationId })
});
export const getAgentHistory = () => request('/api/agent/history');
export const getAgentExecution = id => request(`/api/agent/executions/${encodeURIComponent(id)}`);
export const recoverAgentExecution = id => request(
  `/api/agent/executions/${encodeURIComponent(id)}/recover`,
  { method: 'POST' }
);
export const getAgentConversation = id => request(`/api/agent/conversations/${encodeURIComponent(id)}`);
export const clearAgentConversation = id => request(
  id ? `/api/agent/conversations/${encodeURIComponent(id)}` : '/api/agent/history',
  { method: 'DELETE' }
);
export const submitPreparedProposal = (proposal, submissionId = 'proposal') => createLimitRequest({
  customerId: proposal.customerId,
  requestedLimit: proposal.requestedLimit,
  reason: proposal.reason
}, submissionId);
export function analyzeDocument(file) {
  const form = new FormData();
  form.append('document', file);
  return request('/api/documents/analyze', { method: 'POST', body: form });
}
export const checkGeminiConnectivity = () => request('/api/ai/gemini/connectivity', {
  method: 'POST',
  body: JSON.stringify({})
});

// Phase 6 V2 Canonical, Connectors & Workflow API Client Methods
export const getV2Connectors = (timeoutMs = 10000) => request('/api/v2/connectors', { timeoutMs });
export const testV2Connector = payload => request('/api/v2/connectors/test', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const discoverV2Schema = payload => request('/api/v2/connectors/discover', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const confirmV2Mappings = payload => request('/api/v2/connectors/mappings/confirm', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const syncV2Connector = payload => request('/api/v2/connectors/sync', {
  method: 'POST',
  body: JSON.stringify(payload)
});

export const getV2PortfolioExposure = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/api/v2/exposure/portfolio${query ? `?${query}` : ''}`);
};
export const getV2BusinessPartnerDossier = (bpId, params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/api/v2/exposure/partners/${encodeURIComponent(bpId)}${query ? `?${query}` : ''}`);
};
export const recalculateV2Exposure = (referenceDate = '2026-11-09') => request('/api/v2/exposure/recalculate', {
  method: 'POST',
  body: JSON.stringify({ referenceDate })
});

export const getV2WorkflowLimitRequests = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/api/v2/workflow/limit-requests${query ? `?${query}` : ''}`);
};
export const previewV2LimitChange = payload => request('/api/v2/workflow/limit-requests/preview', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const submitV2LimitRequest = payload => request('/api/v2/workflow/limit-requests', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const submitV2DraftLimitRequest = requestId => request(`/api/v2/workflow/limit-requests/${encodeURIComponent(requestId)}/submit`, {
  method: 'POST',
  body: JSON.stringify({})
});
export const decideV2LimitRequest = (requestId, payload) => request(`/api/v2/workflow/limit-requests/${encodeURIComponent(requestId)}/decision`, {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const syncV2LimitRequestToSap = (requestId, payload = {}) => request(`/api/v2/workflow/limit-requests/${encodeURIComponent(requestId)}/sync-sap`, {
  method: 'POST',
  body: JSON.stringify(payload)
});

export const queryV2Agent = payload => request('/api/v2/agent/query', {
  method: 'POST',
  body: JSON.stringify(payload)
});

export const getV2SchedulerStatus = (timeoutMs = 10000) => request('/api/v2/monitoring/scheduler-status', { timeoutMs });
export const triggerV2SchedulerCycle = (force = true, timeoutMs = 10000) => request('/api/v2/monitoring/scheduler-trigger', {
  method: 'POST',
  timeoutMs,
  body: JSON.stringify({ force })
});

export const getV2AutonomousPolicy = () => request('/api/v2/autonomous/policy');
export const evaluateV2CustomerAutonomousDecision = payload => request('/api/v2/autonomous/evaluate-customer', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const processV2PendingAutonomousRequests = (payload = {}) => request('/api/v2/autonomous/process-pending', {
  method: 'POST',
  body: JSON.stringify(payload)
});
export const scanV2PortfolioAutonomousActions = (payload = {}) => request('/api/v2/autonomous/scan-portfolio', {
  method: 'POST',
  body: JSON.stringify(payload)
});

