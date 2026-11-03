const test = require('node:test');
const assert = require('node:assert/strict');
const { AnthropicProvider, createLlmProvider } = require('../srv/llm');

test('provider abstraction normalizes tool calls without exposing credentials', async () => {
  const originalFetch = global.fetch;
  let requestOptions;
  global.fetch = async (_url, options) => {
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
    assert.equal(requestOptions.headers['x-api-key'], 'server-only-test-secret');
    assert.equal(JSON.stringify(result).includes('server-only-test-secret'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider reports bounded timeouts and classifies service failures', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  try {
    const provider = new AnthropicProvider({ apiKey: 'server-only-test-secret', timeoutMs: 5 });
    await assert.rejects(
      provider.complete({ messages: [], tools: [], system: '' }),
      error => error.category === 'provider_timeout'
    );
  } finally {
    global.fetch = originalFetch;
  }

  const offline = createLlmProvider({ providerName: 'offline', apiKey: 'ignored' });
  assert.equal(offline, null);
  assert.throws(() => createLlmProvider({ providerName: 'not-configured' }), /Unsupported LLM provider/);
});
