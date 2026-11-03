class AnthropicProvider {
  constructor({ apiKey, model, timeoutMs = 15000 }) {
    if (!apiKey) throw new Error('Anthropic API key is required.');
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-5-5';
    this.timeoutMs = timeoutMs;
  }

  async complete({ messages, tools, system, signal }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('LLM provider timed out.')), this.timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: this.model, max_tokens: 1200, system, tools, messages }),
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(`LLM provider returned HTTP ${response.status}.`);
        error.category = response.status === 429 ? 'rate_limited' : 'provider_error';
        throw error;
      }

      const content = Array.isArray(result.content) ? result.content : [];
      return {
        content,
        text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        toolCalls: content.filter(block => block.type === 'tool_use').map(block => ({
          id: block.id,
          name: block.name,
          input: block.input
        }))
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error('LLM provider timed out.');
        timeoutError.category = 'provider_timeout';
        throw timeoutError;
      }
      if (!error.category) error.category = 'provider_unavailable';
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function createLlmProvider({ providerName = 'anthropic', apiKey, model, timeoutMs } = {}) {
  if (providerName === 'offline') return null;
  if (providerName !== 'anthropic') {
    throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
  if (!apiKey) return null;
  return new AnthropicProvider({ apiKey, model, timeoutMs });
}

module.exports = { AnthropicProvider, createLlmProvider };
