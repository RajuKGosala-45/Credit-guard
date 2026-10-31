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
export const getCustomers = () => request('/api/customers');
export const getCustomer = id => request(`/api/customers/${encodeURIComponent(id)}`);
export const getLimitRequests = status => request(`/api/limit-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const createLimitRequest = payload => request('/api/limit-requests', { method: 'POST', body: JSON.stringify(payload) });
export const decideLimitRequest = (id, payload) => request(`/api/limit-requests/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(payload) });
export const sendChat = (message, documentContext) => request('/api/chat', {
  method: 'POST', body: JSON.stringify({ message, documentContext })
});
export function analyzeDocument(file) {
  const form = new FormData();
  form.append('document', file);
  return request('/api/documents/analyze', { method: 'POST', body: form });
}
