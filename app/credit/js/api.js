const CSRF_TOKEN_ENDPOINT = '/credit/index.html';
let csrfToken;
let csrfTokenPromise;

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

async function fetchSameOrigin(path, options) {
  try {
    return await fetch(path, {
      ...options,
      credentials: options.credentials || 'same-origin'
    });
  } catch {
    throw new Error('Cannot reach Credit Guard. Check that the server is running on port 4005, then try again.');
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
export const createLimitRequest = payload => request('/api/limit-requests', { method: 'POST', body: JSON.stringify(payload) });
export const decideLimitRequest = (id, payload) => request(`/api/limit-requests/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(payload) });
export const sendChat = (message, documentContext, conversationId) => request('/api/chat', {
  method: 'POST', body: JSON.stringify({ message, documentContext, conversationId })
});
export const getAgentHistory = () => request('/api/agent/history');
export const getAgentConversation = id => request(`/api/agent/conversations/${encodeURIComponent(id)}`);
export const clearAgentConversation = id => request(
  id ? `/api/agent/conversations/${encodeURIComponent(id)}` : '/api/agent/history',
  { method: 'DELETE' }
);
export const submitPreparedProposal = proposal => createLimitRequest({
  customerId: proposal.customerId,
  requestedLimit: proposal.requestedLimit,
  reason: proposal.reason
});
export function analyzeDocument(file) {
  const form = new FormData();
  form.append('document', file);
  return request('/api/documents/analyze', { method: 'POST', body: form });
}
