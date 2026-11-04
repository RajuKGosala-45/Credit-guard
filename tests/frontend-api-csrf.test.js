const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const apiPath = path.join(__dirname, '..', 'app', 'credit', 'js', 'api.js');
let moduleSequence = 0;

async function loadApi() {
  const source = await fs.readFile(apiPath, 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  return import(moduleUrl);
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('writes fetch and cache the App Router CSRF token with same-origin session credentials', async t => {
  const api = await loadApi();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/credit/index.html') {
      return new Response('<html></html>', {
        headers: {
          'X-CSRF-Token': 'session-token',
          'Set-Cookie': 'JSESSIONID=router-session; HttpOnly; SameSite=Lax'
        }
      });
    }
    return jsonResponse({ accepted: true });
  });

  await Promise.all([
    api.request('/api/first-write', {
      method: 'POST',
      headers: { 'X-Correlation-ID': 'preserve-me' },
      body: JSON.stringify({ value: 1 })
    }),
    api.request('/api/second-write', { method: 'POST', body: JSON.stringify({ value: 2 }) })
  ]);

  assert.equal(calls.filter(call => call.url === '/credit/index.html').length, 1);
  const tokenCall = calls.find(call => call.url === '/credit/index.html');
  assert.equal(tokenCall.options.method, 'GET');
  assert.equal(tokenCall.options.credentials, 'same-origin');
  assert.equal(new Headers(tokenCall.options.headers).get('X-CSRF-Token'), 'Fetch');
  const writes = calls.filter(call => call.url !== '/credit/index.html');
  assert.equal(writes.length, 2);
  assert.ok(writes.every(call => call.options.credentials === 'same-origin'));
  assert.ok(writes.every(call => call.options.headers.get('X-CSRF-Token') === 'session-token'));
  assert.equal(writes[0].options.headers.get('X-Correlation-ID'), 'preserve-me');
});

test('GET requests do not acquire or attach a CSRF token', async t => {
  const api = await loadApi();
  let call;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    call = { url, options };
    return jsonResponse({ available: true });
  });

  await api.getDashboard();

  assert.equal(call.url, '/api/dashboard');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers.has('X-CSRF-Token'), false);
});

test('POST, PUT, PATCH, DELETE and multipart writes receive the token without overriding form boundaries', async t => {
  const api = await loadApi();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/credit/index.html') {
      return new Response('<html></html>', { headers: { 'X-CSRF-Token': 'method-token' } });
    }
    return jsonResponse({ ok: true });
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await api.request(`/api/${method.toLowerCase()}`, { method, body: '{}' });
  }
  const form = new FormData();
  form.append('document', new Blob(['synthetic document']), 'sample.txt');
  await api.request('/api/documents/analyze', { method: 'POST', body: form });

  const writes = calls.filter(call => call.url !== '/credit/index.html');
  assert.deepEqual(writes.map(call => call.options.method), ['POST', 'PUT', 'PATCH', 'DELETE', 'POST']);
  assert.ok(writes.every(call => call.options.headers.get('X-CSRF-Token') === 'method-token'));
  assert.equal(writes.at(-1).options.headers.has('content-type'), false);
  assert.equal(writes.at(-1).options.body, form);
});

test('a rejected CSRF token is invalidated but the failed write is never retried', async t => {
  const api = await loadApi();
  let tokenNumber = 0;
  const writes = [];
  let rejectNextWrite = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/credit/index.html') {
      tokenNumber += 1;
      return new Response('<html></html>', {
        headers: { 'X-CSRF-Token': `token-${tokenNumber}` }
      });
    }
    writes.push({ url, options });
    if (url === '/api/limit-requests' && rejectNextWrite) {
      rejectNextWrite = false;
      return jsonResponse({ error: 'CSRF token rejected.' }, {
        status: 403,
        headers: { 'X-CSRF-Token': 'Required' }
      });
    }
    return jsonResponse({ accepted: true });
  });

  const request = { customerId: 'C001', requestedLimit: 1, reason: 'test' };
  await assert.rejects(api.createLimitRequest(request), /CSRF token rejected/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.headers.get('X-CSRF-Token'), 'token-1');

  await api.createLimitRequest(request);
  assert.equal(tokenNumber, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].options.headers.get('X-CSRF-Token'), 'token-2');
});

test('token acquisition failure prevents a write from being submitted', async t => {
  const api = await loadApi();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ error: 'Authenticated session is required.' }, { status: 401 });
  });

  await assert.rejects(
    api.createLimitRequest({ customerId: 'C001', requestedLimit: 1, reason: 'test' }),
    /Authenticated session is required/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/credit/index.html');
});
