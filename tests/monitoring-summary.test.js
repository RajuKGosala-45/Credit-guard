const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deterministicSummary,
  generateMonitoringSummary,
  safeSignals
} = require('../srv/monitoringSummary');

const result = {
  status: 'COMPLETED',
  freshness: 'UNKNOWN',
  rulesVersion: '1',
  summary: {
    customersMonitored: 2,
    warningCustomers: 1,
    breachedCustomers: 1,
    criticalCustomers: 0,
    overdueCustomers: 1,
    manualReviewCustomers: 0,
    findings: 2
  },
  findings: [
    {
      customerId: 'SECRET-CUSTOMER-ID',
      customerName: 'Sensitive Customer Name',
      exposure: 987654321,
      conditions: ['WARNING', 'OVERDUE_RISK', 'OVERDUE_AMOUNT']
    },
    {
      customerId: 'SECRET-CUSTOMER-ID-2',
      customerName: 'Other Customer',
      exposure: 123456789,
      conditions: ['BREACH']
    }
  ]
};

test('AI input is minimized to deterministic aggregate counts and rule conditions', () => {
  const signals = safeSignals(result);
  const serialized = JSON.stringify(signals);
  assert.equal(serialized.includes('SECRET-CUSTOMER-ID'), false);
  assert.equal(serialized.includes('Sensitive Customer Name'), false);
  assert.equal(serialized.includes('987654321'), false);
  assert.equal(signals.conditionCounts.WARNING, 1);
  assert.equal(signals.conditionCounts.BREACH, 1);
});

test('unconfigured or unavailable AI produces a deterministic advisory summary', async () => {
  const summary = await generateMonitoringSummary(result, { provider: null });
  assert.equal(summary.source, 'DETERMINISTIC');
  assert.equal(summary.errorCategory, 'provider_not_configured');
  assert.match(summary.text, /1 warning/);
  assert.match(summary.text, /no credit action was taken/i);
});

test('AI summaries receive only minimized signals and are explicitly advisory', async () => {
  let request;
  const summary = await generateMonitoringSummary(result, {
    provider: {
      async complete(value) {
        request = value;
        return { text: 'Facts: one customer is above limit. Advisory: review source data.' };
      }
    }
  });
  assert.equal(summary.source, 'AI_ADVISORY');
  assert.equal(request.tools.length, 0);
  assert.equal(JSON.stringify(request).includes('Sensitive Customer Name'), false);
  assert.equal(JSON.stringify(request).includes('SECRET-CUSTOMER-ID'), false);
});

test('malformed provider output falls back without exposing provider details', async () => {
  const summary = await generateMonitoringSummary(result, {
    provider: {
      async complete() {
        throw Object.assign(new Error('Sensitive provider response body.'), {
          category: 'provider_timeout'
        });
      }
    }
  });
  assert.equal(summary.source, 'DETERMINISTIC');
  assert.equal(summary.errorCategory, 'provider_timeout');
  assert.equal(summary.text.includes('Sensitive provider response body'), false);
});

test('deterministic summaries remain based only on existing finding counts', () => {
  const summary = deterministicSummary(result.summary, { WARNING: 1, BREACH: 1 });
  assert.match(summary, /common flags: warning \(1\), breach \(1\)/i);
  assert.doesNotMatch(summary, /SECRET|Sensitive Customer Name/);
});
