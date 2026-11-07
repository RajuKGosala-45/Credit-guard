const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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

class GeminiProvider {
  #client;

  constructor({ apiKey, model, timeoutMs, client } = {}) {
    if (!apiKey) throw new Error('Gemini API key is required.');
    this.model = model || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    if (client) {
      this.#client = client;
    } else {
      const { GoogleGenAI } = require('@google/genai');
      this.#client = new GoogleGenAI({ apiKey });
    }
  }

  async complete({ messages, tools = [], tool_choice: toolChoice, system, signal } = {}) {
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
      const functionDeclarations = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.input_schema
      }));
      const functionCallingConfig = toolChoice?.type === 'tool'
        ? {
          mode: 'ANY',
          allowedFunctionNames: [toolChoice.name]
        }
        : functionDeclarations.length ? { mode: 'AUTO' } : undefined;
      const response = await this.#client.models.generateContent({
        model: this.model,
        contents: messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(message.content ?? '') }]
        })),
        config: {
          systemInstruction: system,
          maxOutputTokens: 1200,
          abortSignal: controller.signal,
          automaticFunctionCalling: { disable: true },
          ...(functionDeclarations.length ? {
            tools: [{ functionDeclarations }],
            ...(functionCallingConfig ? {
              toolConfig: { functionCallingConfig }
            } : {})
          } : {})
        }
      });

      const candidateParts = response?.candidates?.[0]?.content?.parts;
      const functionCalls = Array.isArray(response?.functionCalls)
        ? response.functionCalls
        : Array.isArray(candidateParts)
          ? candidateParts.map(part => part?.functionCall).filter(Boolean)
          : [];
      const text = typeof response?.text === 'string'
        ? response.text
        : Array.isArray(candidateParts)
          ? candidateParts.map(part => part?.text).filter(value => typeof value === 'string').join('\n')
          : '';
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const [index, call] of functionCalls.entries()) {
        if (typeof call?.name !== 'string' || !call.name.trim()
          || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
          throw providerError('LLM provider returned an invalid function call.', 'provider_response_invalid');
        }
        content.push({
          type: 'tool_use',
          id: typeof call.id === 'string' && call.id.trim() ? call.id : `gemini-call-${index + 1}`,
          name: call.name,
          input: call.args
        });
      }
      if (!content.length) {
        throw providerError('LLM provider returned an invalid response.', 'provider_response_invalid');
      }
      return {
        content,
        text,
        toolCalls: content.filter(block => block.type === 'tool_use').map(block => ({
          id: block.id,
          name: block.name,
          input: block.input
        }))
      };
    } catch (error) {
      if (timedOut) {
        throw providerError('LLM provider timed out.', 'provider_timeout');
      }
      if (signal?.aborted) throw signal.reason || error;
      if (error?.category) throw error;
      const rawStatus = error?.status ?? error?.statusCode ?? error?.code;
      const status = Number(rawStatus);
      if (status === 401 || status === 403) {
        throw providerError('Gemini rejected the configured credentials.', 'provider_authentication', status);
      }
      if (status === 429) {
        throw providerError('Gemini rate limit was reached.', 'rate_limited', status);
      }
      if (status === 503 || status === 502) {
        throw providerError('Gemini is temporarily unavailable.', 'provider_unavailable', status);
      }
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        throw providerError('Gemini rejected the request.', 'provider_error', status);
      }
      if (Number.isInteger(status) && status >= 500) {
        throw providerError('Gemini is temporarily unavailable.', 'provider_unavailable', status);
      }
      if (error instanceof TypeError && /invalid (response|function call)/i.test(error.message)) {
        throw error;
      }
      throw providerError('LLM provider is unavailable.', 'provider_unavailable');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function createLlmProvider({ providerName = 'anthropic', apiKey, model, timeoutMs, client } = {}) {
  if (!['anthropic', 'gemini', 'offline'].includes(providerName)) {
    throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
  const validatedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (providerName === 'offline') return null;
  if (!apiKey) return null;
  if (providerName === 'gemini') {
    return new GeminiProvider({ apiKey, model, timeoutMs: validatedTimeoutMs, client });
  }
  return new AnthropicProvider({ apiKey, model, timeoutMs: validatedTimeoutMs });
}

async function testGeminiConnectivity({ apiKey, model, timeoutMs, provider, client } = {}) {
  const selectedProvider = provider || createLlmProvider({
    providerName: 'gemini',
    apiKey,
    model,
    timeoutMs,
    client
  });
  if (!selectedProvider) {
    return { ok: false, errorCategory: 'provider_not_configured' };
  }
  try {
    const response = await selectedProvider.complete({
      system: 'Reply with the single word OK. Do not call tools.',
      messages: [{ role: 'user', content: 'Connectivity check.' }],
      tools: []
    });
    if (response?.toolCalls?.length || typeof response?.text !== 'string' || !response.text.trim()) {
      return { ok: false, errorCategory: 'provider_response_invalid' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errorCategory: error?.category || 'provider_unavailable',
      ...(Number.isInteger(error?.statusCode) ? { statusCode: error.statusCode } : {})
    };
  }
}

module.exports = {
  AnthropicProvider,
  GeminiProvider,
  createLlmProvider,
  testGeminiConnectivity,
  normalizeTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_GEMINI_MODEL
};
