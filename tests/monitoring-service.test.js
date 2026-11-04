const test = require('node:test');
const assert = require('node:assert/strict');
const { monitorPortfolio, normalizeSnapshot, RULES_VERSION } = require('../srv/monitoringService');

const now = new Date('2026-11-04T00:00:00.000Z');
const reader = { id: 'reader', is: role => role === 'CreditReader' };

function customer(overrides = {}) {
  return {
    ID: 'C001',
    name: 'Synthetic Customer',
    creditLimit: 1000,
    exposure: 900,
    utilisation: 0.9,
    overdueAmount: 400,
    overdueShare: 4 / 9,
    flags: ['WARNING', 'OVERDUE_RISK'],
    status: 'WARNING',
    currency: 'INR',
    ...overrides
  };
}

function snapshot(customers = [customer()], overrides = {}) {
  return {
    source: 'CAP database',
    retrievedAt: now.toISOString(),
    customers,
    complete: true,
    ...overrides
  };
}

function provider(value) {
  return { async getSnapshot() { return value; } };
}

test('monitoring produces deterministic customer findings and portfolio counts', async () => {
  const result = await monitorPortfolio({
    user: reader,
    provider: provider(snapshot([
      customer(),
      customer({
        ID: 'C002',
        status: 'BREACH',
        flags: ['BREACH', 'CRITICAL'],
        utilisation: 1.25,
        exposure: 1250,
        overdueAmount: 0,
        overdueShare: 0
      })
    ])),
    now
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rulesVersion, RULES_VERSION);
  assert.equal(result.summary.customersMonitored, 2);
  assert.equal(result.summary.warningCustomers, 1);
  assert.equal(result.summary.breachedCustomers, 1);
  assert.equal(result.summary.criticalCustomers, 1);
  assert.equal(result.summary.overdueCustomers, 1);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[1].conditions, ['BREACH', 'CRITICAL']);
});

test('empty complete portfolios are successful and report zero findings', async () => {
  const result = await monitorPortfolio({
    user: reader,
    provider: provider(snapshot([])),
    now
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.complete, true);
  assert.equal(result.alertResolutionEligible, false);
  assert.equal(result.summary.customersMonitored, 0);
  assert.equal(result.findings.length, 0);
});

test('source freshness is unknown unless an upstream data timestamp is supplied', () => {
  const result = normalizeSnapshot(snapshot(), { now, maxSourceAgeMs: 1000 });
  assert.equal(result.freshness, 'UNKNOWN');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.complete, true);
  assert.equal(result.alertResolutionEligible, false);
});

test('fresh complete non-empty snapshots are eligible to resolve absent alert conditions', () => {
  const result = normalizeSnapshot(snapshot([customer()], {
    sourceTimestamp: now.toISOString()
  }), { now, maxSourceAgeMs: 1000 });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.freshness, 'FRESH');
  assert.equal(result.complete, true);
  assert.equal(result.alertResolutionEligible, true);
});

test('old source timestamps mark monitoring stale without claiming healthy data', () => {
  const result = normalizeSnapshot(snapshot([], {
    sourceTimestamp: '2026-11-02T00:00:00.000Z'
  }), { now, maxSourceAgeMs: 60 * 60 * 1000 });
  assert.equal(result.status, 'STALE');
  assert.equal(result.freshness, 'STALE');
  assert.equal(result.alertResolutionEligible, false);
});

test('explicitly incomplete provider snapshots are reported partial', () => {
  const result = normalizeSnapshot(snapshot([customer()], {
    complete: false,
    sourceTimestamp: now.toISOString()
  }), {
    now,
    maxSourceAgeMs: 1000
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.complete, false);
  assert.equal(result.alertResolutionEligible, false);
});

test('invalid or incomplete snapshots fail instead of appearing healthy', () => {
  for (const value of [
    null,
    {},
    snapshot([customer({ exposure: Number.NaN })]),
    snapshot([customer({ currency: 'US' })]),
    snapshot([customer({ flags: ['UNRECOGNIZED'] })]),
    snapshot([customer(), customer()])
  ]) {
    assert.throws(() => normalizeSnapshot(value, { now, maxSourceAgeMs: 1000 }));
  }
});

test('monitoring requires the authenticated reader role', async () => {
  await assert.rejects(monitorPortfolio({
    user: { id: 'writer', is: () => false },
    provider: provider(snapshot()),
    now
  }), error => error.statusCode === 403);
});

test('provider failures remain failures and are not converted into empty findings', async () => {
  await assert.rejects(monitorPortfolio({
    user: reader,
    provider: { async getSnapshot() { throw new Error('Source unavailable.'); } },
    now
  }), /Source unavailable/);
});

test('ABAP provider output uses the existing deterministic analysis and connector timestamp', async () => {
  const analysis = customer({
    source: undefined,
    retrievedAt: undefined
  });
  const result = await monitorPortfolio({
    user: reader,
    source: 'abap',
    abapClient: {
      async listCustomerAnalyses() {
        return [{
          source: 'ABAP Environment via BTP Destination service',
          retrievedAt: now.toISOString(),
          customer: { currency: 'INR' },
          analysis
        }];
      }
    },
    now
  });
  assert.equal(result.source, 'ABAP Environment via BTP Destination service');
  assert.equal(result.retrievedAt, now.toISOString());
  assert.equal(result.findings[0].customerId, 'C001');
  assert.deepEqual(result.findings[0].conditions, ['WARNING', 'OVERDUE_RISK', 'OVERDUE_AMOUNT']);
});
