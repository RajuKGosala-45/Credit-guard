const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AnthropicProvider,
  GeminiProvider,
  createLlmProvider,
  testGeminiConnectivity,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS
} = require('../srv/llm');

function mockResponse({ ok = true, status = 200, json } = {}) {
  return {
    ok,
    status,
    json: json || (async () => ({ content: [{ type: 'text', text: 'OK' }] }))
  };
}

async function withFetch(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

test('provider abstraction normalizes tool calls without exposing credentials', async () => {
  const originalFetch = global.fetch;
  let requestOptions;
  let requestUrl;
  global.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'I will inspect the customer.' },
          { type: 'tool_use', id: 'tool-1', name: 'get_customer', input: { customer_id: 'C001' } }
        ]
      })
    };
  };
  try {
    const provider = new AnthropicProvider({ apiKey: 'server-only-test-secret' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Explain C001' }],
      tools: [],
      system: 'Use registered tools.'
    });

    assert.equal(result.text, 'I will inspect the customer.');
    assert.deepEqual(result.toolCalls, [{
      id: 'tool-1',
      name: 'get_customer',
      input: { customer_id: 'C001' }
    }]);
    assert.equal(requestUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(requestOptions.method, 'POST');
    assert.equal(requestOptions.headers['content-type'], 'application/json');
    assert.equal(requestOptions.headers['x-api-key'], 'server-only-test-secret');
    assert.equal(requestOptions.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(JSON.parse(requestOptions.body), {
      model: 'claude-sonnet-5-5',
      max_tokens: 1200,
      system: 'Use registered tools.',
      tools: [],
      messages: [{ role: 'user', content: 'Explain C001' }]
    });
    assert.equal(JSON.stringify(result).includes('server-only-test-secret'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider reports bounded timeouts and classifies service failures', async () => {
  await withFetch((_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }), async () => {
    const provider = new AnthropicProvider({ apiKey: 'server-only-test-secret', timeoutMs: 5 });
    await assert.rejects(
      provider.complete({ messages: [], tools: [], system: '' }),
      error => error.category === 'provider_timeout'
    );
  });

  const offline = createLlmProvider({ providerName: 'offline', apiKey: 'ignored' });
  assert.equal(offline, null);
  assert.throws(() => createLlmProvider({ providerName: 'not-configured' }), /Unsupported LLM provider/);
});

test('timeout configuration accepts positive bounded values and defaults only when absent', () => {
  assert.equal(new AnthropicProvider({ apiKey: 'test' }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(new AnthropicProvider({ apiKey: 'test', timeoutMs: '2500' }).timeoutMs, 2500);
  assert.equal(new AnthropicProvider({ apiKey: 'test', timeoutMs: MAX_TIMEOUT_MS }).timeoutMs, MAX_TIMEOUT_MS);
  assert.equal(createLlmProvider({ apiKey: '', timeoutMs: '2500' }), null);
});

test('timeout configuration rejects empty, non-positive, non-integer, malformed and excessive values', () => {
  for (const timeoutMs of ['', '0', '-1', '1.5', 'not-a-number', 0, -5, 1.5, MAX_TIMEOUT_MS + 1, Infinity]) {
    assert.throws(
      () => createLlmProvider({ apiKey: '', timeoutMs }),
      error => error instanceof TypeError && /LLM_TIMEOUT_MS/.test(error.message)
    );
  }
  assert.throws(
    () => new AnthropicProvider({ apiKey: 'test', timeoutMs: ' ' }),
    error => error instanceof TypeError && /LLM_TIMEOUT_MS/.test(error.message)
  );
  assert.throws(
    () => createLlmProvider({ providerName: 'offline', timeoutMs: 0 }),
    error => error instanceof TypeError && /LLM_TIMEOUT_MS/.test(error.message)
  );
});

test('provider rejects malformed JSON without exposing the parser error', async () => {
  await withFetch(async () => mockResponse({
    json: async () => { throw new SyntaxError('sensitive raw response body'); }
  }), async () => {
    const provider = new AnthropicProvider({ apiKey: 'test' });
    await assert.rejects(
      provider.complete({ messages: [], tools: [], system: '' }),
      error => error.category === 'provider_response_invalid'
        && !error.message.includes('sensitive raw response body')
    );
  });
});

test('provider rejects invalid top-level and content block structures', async () => {
  const invalidBodies = [
    null,
    {},
    { content: null },
    { content: [] },
    { content: [null] },
    { content: [{ type: 'text', text: 10 }] },
    { content: [{ type: 'tool_use', id: 'tool-1', name: 'get_customer', input: [] }] },
    { content: [{ type: 'tool_use', id: '', name: 'get_customer', input: {} }] },
    { content: [{ type: 'tool_use', id: 'tool-1', name: '', input: {} }] },
    { content: [{ type: 'tool_use', id: 'tool-1', name: 'get_customer' }] },
    { content: [{ type: 'unknown' }] }
  ];

  for (const body of invalidBodies) {
    await withFetch(async () => mockResponse({ json: async () => body }), async () => {
      const provider = new AnthropicProvider({ apiKey: 'test' });
      await assert.rejects(
        provider.complete({ messages: [], tools: [], system: '' }),
        error => error.category === 'provider_response_invalid'
      );
    });
  }
});

test('provider classifies authentication, rate-limit and other HTTP errors without reading bodies', async () => {
  for (const [status, category] of [
    [401, 'provider_authentication'],
    [403, 'provider_authentication'],
    [429, 'rate_limited'],
    [500, 'provider_error']
  ]) {
    await withFetch(async () => mockResponse({
      ok: false,
      status,
      json: async () => { throw new Error('sensitive provider response body'); }
    }), async () => {
      const provider = new AnthropicProvider({ apiKey: 'test' });
      await assert.rejects(
        provider.complete({ messages: [], tools: [], system: '' }),
        error => error.category === category
          && error.statusCode === status
          && !error.message.includes('sensitive provider response body')
      );
    });
  }
});

test('provider sanitizes network failures', async () => {
  await withFetch(async () => { throw new Error('network error containing private details'); }, async () => {
    const provider = new AnthropicProvider({ apiKey: 'test' });
    await assert.rejects(
      provider.complete({ messages: [], tools: [], system: '' }),
      error => error.category === 'provider_unavailable'
        && !error.message.includes('private details')
    );
  });
});

test('Gemini provider uses the official SDK contract and normalizes forced planning calls', async () => {
  let request;
  const provider = new GeminiProvider({
    apiKey: 'gemini-test-key',
    model: 'gemini-test-model',
    client: {
      models: {
        async generateContent(options) {
          request = options;
          return {
            text: '',
            functionCalls: [{
              id: 'call-1',
              name: 'create_task_plan',
              args: { objective: 'Inspect customer', tasks: [] }
            }]
          };
        }
      }
    }
  });
  const result = await provider.complete({
    messages: [
      { role: 'user', content: 'Analyze C001' },
      { role: 'assistant', content: 'I will inspect the customer.' }
    ],
    tools: [{
      name: 'create_task_plan',
      description: 'Create a validated plan.',
      input_schema: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] }
    }],
    tool_choice: { type: 'tool', name: 'create_task_plan' },
    system: 'Use only registered tools.'
  });

  assert.equal(request.model, 'gemini-test-model');
  assert.equal(request.contents[0].role, 'user');
  assert.equal(request.contents[1].role, 'model');
  assert.equal(request.config.systemInstruction, 'Use only registered tools.');
  assert.equal(request.config.automaticFunctionCalling.disable, true);
  assert.deepEqual(request.config.toolConfig.functionCallingConfig, {
    mode: 'ANY',
    allowedFunctionNames: ['create_task_plan']
  });
  assert.equal(request.config.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
  assert.deepEqual(result.toolCalls, [{
    id: 'call-1',
    name: 'create_task_plan',
    input: { objective: 'Inspect customer', tasks: [] }
  }]);
  assert.equal(JSON.stringify(result).includes('gemini-test-key'), false);
});

test('Gemini provider selection preserves Anthropic and handles missing configuration', () => {
  const client = { models: { generateContent: async () => ({ text: 'ok' }) } };
  const provider = createLlmProvider({
    providerName: 'gemini',
    apiKey: 'gemini-test-key',
    model: 'configured-gemini-model',
    client
  });
  assert.ok(provider instanceof GeminiProvider);
  assert.equal(provider.model, 'configured-gemini-model');
  assert.equal(createLlmProvider({ providerName: 'gemini', apiKey: '' }), null);
  assert.ok(createLlmProvider({ providerName: 'anthropic', apiKey: 'anthropic-test-key' }) instanceof AnthropicProvider);
  assert.equal(createLlmProvider({ providerName: 'offline', apiKey: 'ignored' }), null);
});

test('Gemini provider categorizes authentication, quota, service and malformed-response errors safely', async () => {
  for (const [status, category] of [
    [400, 'provider_error'],
    [401, 'provider_authentication'],
    [403, 'provider_authentication'],
    [429, 'rate_limited'],
    [404, 'provider_error'],
    [503, 'provider_unavailable']
  ]) {
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-key',
      client: {
        models: {
          async generateContent() {
            throw Object.assign(new Error('private credential data'), { status });
          }
        }
      }
    });
    await assert.rejects(
      provider.complete({ messages: [], tools: [], system: '' }),
      error => error.category === category
        && !error.message.includes('private credential data')
        && !error.message.includes('gemini-test-key')
    );
  }

  const malformed = new GeminiProvider({
    apiKey: 'gemini-test-key',
    client: { models: { generateContent: async () => ({ text: '', functionCalls: [] }) } }
  });
  await assert.rejects(
    malformed.complete({ messages: [], tools: [], system: '' }),
    error => error.category === 'provider_response_invalid'
  );
});

test('Gemini timeout aborts the SDK request and connectivity check uses no tools', async () => {
  let receivedSignal;
  const hanging = new GeminiProvider({
    apiKey: 'gemini-test-key',
    timeoutMs: 5,
    client: {
      models: {
        generateContent: (_options) => new Promise((_, reject) => {
          receivedSignal = _options.config.abortSignal;
          receivedSignal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        })
      }
    }
  });
  await assert.rejects(
    hanging.complete({ messages: [], tools: [], system: '' }),
    error => error.category === 'provider_timeout'
  );
  assert.equal(receivedSignal.aborted, true);

  let connectivityRequest;
  const result = await testGeminiConnectivity({
    apiKey: 'gemini-test-key',
    model: 'gemini-test-model',
    client: {
      models: {
        async generateContent(options) {
          connectivityRequest = options;
          return { text: 'OK' };
        }
      }
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(connectivityRequest.model, 'gemini-test-model');
  assert.equal(connectivityRequest.config.tools, undefined);
  assert.equal(connectivityRequest.config.toolConfig, undefined);
  assert.equal(JSON.stringify(result).includes('gemini-test-key'), false);
});
