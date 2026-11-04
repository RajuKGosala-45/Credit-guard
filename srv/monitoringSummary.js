const { createLlmProvider } = require('./llm');

const MAX_ADVISORY_LENGTH = 2000;
const SAFE_CONDITIONS = new Set([
  'CRITICAL',
  'BREACH',
  'WARNING',
  'OVERDUE_RISK',
  'NO_LIMIT',
  'STALE_REVIEW',
  'OVERDUE_AMOUNT'
]);

function deterministicSummary(summary, conditionCounts) {
  const topConditions = Object.entries(conditionCounts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([condition, count]) => `${condition.toLowerCase().replaceAll('_', ' ')} (${count})`);
  const conditions = topConditions.length ? ` Common flags: ${topConditions.join(', ')}.` : '';
  return `Monitoring reviewed ${summary.customersMonitored} customer(s): ${summary.warningCustomers} warning, ${summary.breachedCustomers} above limit, ${summary.criticalCustomers} critical, and ${summary.overdueCustomers} with overdue balances.${conditions} Review deterministic customer findings and confirm source freshness before taking action. This summary is advisory; no credit action was taken.`;
}

function safeSignals(result) {
  const conditionCounts = {};
  for (const finding of result.findings) {
    for (const condition of new Set(finding.conditions)) {
      if (SAFE_CONDITIONS.has(condition)) {
        conditionCounts[condition] = (conditionCounts[condition] || 0) + 1;
      }
    }
  }
  return {
    rulesVersion: result.rulesVersion,
    monitoringStatus: result.status,
    freshness: result.freshness,
    totals: result.summary,
    conditionCounts
  };
}

function safeErrorCategory(error) {
  const category = error?.category;
  return typeof category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(category)
    ? category : 'provider_unavailable';
}

async function generateMonitoringSummary(result, { provider } = {}) {
  const signals = safeSignals(result);
  const fallback = deterministicSummary(result.summary, signals.conditionCounts);
  let selectedProvider = provider;
  try {
    if (selectedProvider === undefined) {
      selectedProvider = createLlmProvider({
        providerName: process.env.LLM_PROVIDER || 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.LLM_MODEL,
        timeoutMs: process.env.LLM_TIMEOUT_MS
      });
    }
  } catch (error) {
    return { text: fallback, source: 'DETERMINISTIC', errorCategory: safeErrorCategory(error) };
  }
  if (!selectedProvider) {
    return {
      text: fallback,
      source: 'DETERMINISTIC',
      errorCategory: 'provider_not_configured'
    };
  }

  try {
    const response = await selectedProvider.complete({
      system: [
        'Explain deterministic credit-monitoring results in plain business language.',
        'The supplied data is already calculated by approved deterministic rules. Do not recalculate exposure or infer new thresholds.',
        'Use aggregate counts only. Do not request or invent customer identities, invoice details, credit actions, approvals, or alert changes.',
        'Clearly distinguish observed facts from advisory investigation suggestions. Keep the answer under 1500 characters.'
      ].join(' '),
      messages: [{ role: 'user', content: JSON.stringify(signals) }],
      tools: []
    });
    if (response?.toolCalls?.length || typeof response?.text !== 'string'
      || !response.text.trim() || response.text.length > MAX_ADVISORY_LENGTH) {
      throw Object.assign(new Error('Invalid monitoring summary response.'), {
        category: 'provider_response_invalid'
      });
    }
    return { text: response.text.trim(), source: 'AI_ADVISORY', errorCategory: null };
  } catch (error) {
    return {
      text: fallback,
      source: 'DETERMINISTIC',
      errorCategory: safeErrorCategory(error)
    };
  }
}

module.exports = {
  MAX_ADVISORY_LENGTH,
  deterministicSummary,
  generateMonitoringSummary,
  safeSignals
};
