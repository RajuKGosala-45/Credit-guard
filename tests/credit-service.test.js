const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  aggregateExposure,
  aggregatePortfolio,
  createLimitRequest,
  decideLimitRequest,
  prepareLimitChange
} = require('../srv/creditService');

const customers = [
  {
    country: 'India',
    companyCode: 'BS01',
    currency: 'INR',
    exposure: 80,
    creditLimit: 100,
    status: 'WARNING',
    flags: []
  },
  {
    country: 'India',
    companyCode: 'BS01',
    currency: 'EUR',
    exposure: 40,
    creditLimit: 100,
    status: 'HEALTHY',
    flags: []
  }
];

test('exposure aggregation keeps currencies separate and returns finite utilization', () => {
  const rows = aggregateExposure(customers, 'country');

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.currency).sort(), ['EUR', 'INR']);
  assert.ok(rows.every(row => Number.isFinite(row.exposure) && Number.isFinite(row.utilisation)));
  assert.ok(rows.every(row => row.label.includes(row.currency)));
});

test('portfolio KPI totals do not combine currencies', () => {
  const kpis = aggregatePortfolio(customers);

  assert.equal(kpis.totalExposure, null);
  assert.equal(kpis.totalLimit, null);
  assert.equal(kpis.overallUtilisation, null);
  assert.deepEqual(kpis.currencyTotals.map(row => row.currency).sort(), ['EUR', 'INR']);
  assert.deepEqual(kpis.currencyTotals.map(row => row.availableCredit).sort(), ['20.00', '60.00']);
  assert.equal(JSON.stringify(kpis).includes('Infinity'), false);
});

test('available credit preserves decimal precision without combining currencies', () => {
  const portfolio = aggregatePortfolio([{
    currency: 'INR',
    exposure: 0.1,
    creditLimit: 0.3,
    overdueAmount: 0.1,
    overdueInvoiceCount: 1,
    status: 'WARNING',
    flags: ['WARNING']
  }]);

  assert.equal(portfolio.availableCredit, '0.20');
  assert.equal(portfolio.overdueAmount, '0.10');
  assert.equal(portfolio.overdueInvoiceCount, 1);
});

test('portfolio totals fail explicitly when currency is absent', () => {
  assert.throws(() => aggregatePortfolio([{
    exposure: 100,
    creditLimit: 200,
    status: 'HEALTHY',
    flags: []
  }]), /currency is missing/i);
});

test('zero-limit currency groups have null utilization rather than infinity', () => {
  const noLimit = [{
    country: 'India',
    currency: 'INR',
    exposure: 100,
    creditLimit: 0,
    status: 'MANUAL_REVIEW',
    flags: []
  }];
  const exposure = aggregateExposure(noLimit, 'country');
  const portfolio = aggregatePortfolio(noLimit);

  assert.equal(exposure[0].utilisation, null);
  assert.equal(portfolio.overallUtilisation, null);
  assert.equal(JSON.stringify({ exposure, portfolio }).includes('Infinity'), false);
});

test('SAP read-only mode blocks direct request preparation, submission, and approval after authorization', async () => {
  const previousSource = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE;
  process.env.CREDIT_GUARD_AGENT_DATA_SOURCE = 'abap';
  const requester = new cds.User({ id: 'requester', roles: ['CreditRequester'] });
  const approver = new cds.User({ id: 'approver', roles: ['CreditApprover'] });
  const reader = new cds.User({ id: 'reader', roles: ['CreditReader'] });
  const pendingRequest = {
    ID: 'request-1',
    requestedBy: 'requester',
    approverLevel: 'Finance Head',
    status: 'Pending'
  };
  const db = {
    async run(query) {
      if (query.SELECT) {
        assert.equal(query.SELECT.from.ref[0], 'credit.LimitRequests');
        return [pendingRequest];
      }
      throw new Error('Read-only mode must not write request data.');
    },
    async tx() {
      throw new Error('Read-only mode must not begin a decision transaction.');
    }
  };

  try {
    await assert.rejects(
      prepareLimitChange(db, requester, { customerId: 'C001', requestedLimit: 120, reason: 'Reason' }),
      { statusCode: 409, message: /read-only mode/i }
    );
    await assert.rejects(
      createLimitRequest(db, requester, { customerId: 'C001', requestedLimit: 120, reason: 'Reason' }, 'key'),
      { statusCode: 409, message: /read-only mode/i }
    );
    await assert.rejects(
      decideLimitRequest(db, reader, pendingRequest.ID, { decision: 'Approved', reason: 'Reason' }),
      { statusCode: 403 }
    );
    await assert.rejects(
      decideLimitRequest(db, approver, pendingRequest.ID, { decision: 'Approved', reason: 'Reason' }),
      { statusCode: 409, message: /read-only mode/i }
    );
  } finally {
    if (previousSource === undefined) delete process.env.CREDIT_GUARD_AGENT_DATA_SOURCE;
    else process.env.CREDIT_GUARD_AGENT_DATA_SOURCE = previousSource;
  }
});
