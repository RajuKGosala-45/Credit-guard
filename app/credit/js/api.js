async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...options.headers
      }
    });
  } catch {
    throw new Error('Cannot reach Credit Guard. Check that the server is running on port 4005, then try again.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The request failed (${response.status}). Try again.`);
  return body;
}

export const getDashboard = () => request('/api/dashboard');
export const getMonitoringSummary = () => request('/api/monitoring/summary');
export const getMonitoringRuns = (limit = 20) => request(`/api/monitoring/runs?limit=${encodeURIComponent(limit)}`);
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
