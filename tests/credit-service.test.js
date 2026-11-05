const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateExposure, aggregatePortfolio } = require('../srv/creditService');

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
