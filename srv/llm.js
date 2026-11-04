const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;

function normalizeTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;

  const timeoutMs = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`LLM_TIMEOUT_MS must be a positive whole number no greater than ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function providerError(message, category, statusCode) {
  const error = new Error(message);
  error.category = category;
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

function normalizeResponse(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Array.isArray(result.content) || result.content.length === 0) {
    throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
  }

  const toolCalls = [];
  const textBlocks = [];
  for (const block of result.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw providerError('LLM provider returned an invalid response block.', 'provider_response_invalid');
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text);
      continue;
    }
    if (block.type === 'tool_use'
      && typeof block.id === 'string' && block.id.trim()
      && typeof block.name === 'string' && block.name.trim()
      && block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input)) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
      continue;
    }
    throw providerError('LLM provider returned an invalid response block.', 'provider_response_invalid');
  }

  return {
    content: result.content,
    text: textBlocks.join('\n'),
    toolCalls
  };
}

class AnthropicProvider {
  constructor({ apiKey, model, timeoutMs }) {
    if (!apiKey) throw new Error('Anthropic API key is required.');
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-5-5';
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
  }

  async complete({ messages, tools, system, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

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
      if (!response || typeof response.ok !== 'boolean') {
        throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
      }

      if (!response.ok) {
        const statusCode = Number.isInteger(response.status) ? response.status : undefined;
        const category = statusCode === 401 || statusCode === 403
          ? 'provider_authentication'
          : statusCode === 429 ? 'rate_limited' : 'provider_error';
        throw providerError(
          statusCode ? `LLM provider returned HTTP ${statusCode}.` : 'LLM provider returned an HTTP error.',
          category,
          statusCode
        );
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw providerError('LLM provider returned invalid JSON.', 'provider_response_invalid');
      }
      return normalizeResponse(result);
    } catch (error) {
      if (timedOut) {
        throw providerError('LLM provider timed out.', 'provider_timeout');
      }
      if (signal?.aborted) throw signal.reason || error;
      if (error?.category) throw error;
      throw providerError('LLM provider is unavailable.', 'provider_unavailable');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function createLlmProvider({ providerName = 'anthropic', apiKey, model, timeoutMs } = {}) {
  if (!['anthropic', 'offline'].includes(providerName)) {
    throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
  const validatedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (providerName === 'offline') return null;
  if (!apiKey) return null;
  return new AnthropicProvider({ apiKey, model, timeoutMs: validatedTimeoutMs });
}

module.exports = {
  AnthropicProvider,
  createLlmProvider,
  normalizeTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS
};
