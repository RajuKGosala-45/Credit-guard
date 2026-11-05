const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCustomer,
  routeApprover,
  canDecide,
  validateUniqueItemOwners
} = require('../srv/rules');

function customer(creditLimit = 100, lastReviewDate = '2025-01-15') {
  return { ID: 'C001', creditLimit, lastReviewDate };
}

function item(amount, status = 'Open', extra = {}) {
  return { type: 'Invoice', amount, status, dueDate: '2025-01-16', ...extra };
}

function classifyAtUtilisation(utilisation) {
  return classifyCustomer(
    customer(100),
    [item(utilisation * 100)],
    new Date('2025-01-15T00:00:00.000Z')
  );
}

test('exposure includes unpaid invoices and sales orders but excludes closed items', () => {
  const result = classifyCustomer(customer(1000), [
    item(125, 'Open'),
    item(75, 'Overdue', { type: 'SalesOrder', dueDate: '2025-01-14' }),
    item(50, 'Closed'),
    item(25, 'Open', { type: 'UnsupportedType' })
  ], new Date('2025-01-15T00:00:00.000Z'));

  assert.equal(result.exposure, 200);
  assert.equal(result.overdueAmount, 75);
});

test('warning, breach, and critical classifications use inclusive demo thresholds', () => {
  assert.equal(classifyAtUtilisation(0).utilisation, 0);
  assert.equal(classifyAtUtilisation(0.7999).status, 'HEALTHY');
  assert.equal(classifyAtUtilisation(0.8).status, 'WARNING');
  assert.equal(classifyAtUtilisation(1).status, 'BREACH');
  assert.equal(classifyAtUtilisation(1.0001).status, 'BREACH');
  assert.equal(classifyAtUtilisation(1.1999).flags.includes('CRITICAL'), false);
  assert.equal(classifyAtUtilisation(1.2).flags.includes('CRITICAL'), true);
  assert.equal(classifyAtUtilisation(0.8).utilisationPercent, 80);
  assert.equal(classifyAtUtilisation(1).utilisationPercent, 100);
});

test('zero limit requires manual review and never returns non-finite utilization', () => {
  const noExposure = classifyCustomer(customer(0), [], new Date('2025-01-15T00:00:00Z'));
  const withExposure = classifyCustomer(customer(0), [item(1)], new Date('2025-01-15T00:00:00Z'));

  assert.equal(noExposure.utilisation, null);
  assert.equal(withExposure.utilisation, null);
  assert.equal(noExposure.status, 'MANUAL_REVIEW');
  assert.equal(withExposure.status, 'MANUAL_REVIEW');
  assert.ok(withExposure.flags.includes('NO_LIMIT'));
  assert.equal(JSON.stringify(withExposure).includes('null'), true);
  assert.doesNotMatch(JSON.stringify(withExposure), /Infinity|NaN/);
});

test('overdue amount is based on due date and unpaid credit-consuming status', () => {
  const result = classifyCustomer(customer(100), [
    item(40, 'Open', { dueDate: '2025-01-14' }),
    item(30, 'Open', { dueDate: '2025-01-15' }),
    item(20, 'Overdue', { dueDate: '2025-01-16' })
  ], new Date('2025-01-15T12:00:00.000Z'));

  assert.equal(result.exposure, 90);
  assert.equal(result.overdueAmount, 40);
});

test('overdue invoice count uses due dates and excludes sales orders and paid items', () => {
  const result = classifyCustomer(customer(1000), [
    item(40, 'Open', { ID: 'I001', dueDate: '2025-01-14' }),
    item(30, 'Open', { ID: 'S001', type: 'SalesOrder', dueDate: '2025-01-14' }),
    item(20, 'Paid', { ID: 'I002', dueDate: '2025-01-14' }),
    item(10, 'Open', { ID: 'I003', dueDate: '2025-01-15' })
  ], new Date('2025-01-15T00:00:00.000Z'));

  assert.equal(result.overdueInvoiceCount, 1);
});

test('overdue risk uses a strict greater-than 30 percent boundary', () => {
  const atBoundary = classifyCustomer(customer(), [
    item(30, 'Open', { dueDate: '2025-01-14' }),
    item(70, 'Open')
  ], new Date('2025-01-15T00:00:00.000Z'));
  const aboveBoundary = classifyCustomer(customer(), [
    item(31, 'Open', { dueDate: '2025-01-14' }),
    item(69, 'Open')
  ], new Date('2025-01-15T00:00:00.000Z'));

  assert.equal(atBoundary.overdueShare, 0.3);
  assert.equal(atBoundary.flags.includes('OVERDUE_RISK'), false);
  assert.equal(aboveBoundary.flags.includes('OVERDUE_RISK'), true);
  assert.equal(classifyCustomer(customer(), []).overdueShare, 0);
});

test('paid and closed items do not consume credit and missing or invalid due dates are not overdue', () => {
  const result = classifyCustomer(customer(100), [
    item(10, 'Paid', { dueDate: '2025-01-14' }),
    item(20, 'Closed', { dueDate: '2025-01-14' }),
    item(5, 'Cancelled', { dueDate: '2025-01-14' }),
    item(30, 'Open', { dueDate: undefined }),
    item(40, 'Open', { dueDate: '2025-02-31' })
  ], new Date('2025-01-15T00:00:00.000Z'));

  assert.equal(result.exposure, 70);
  assert.equal(result.overdueAmount, 0);
});

test('identical duplicate open-item IDs are counted once and conflicting duplicates fail', () => {
  const duplicate = item(40, 'Open', { ID: 'I001' });
  const result = classifyCustomer(customer(100), [duplicate, { ...duplicate }]);

  assert.equal(result.exposure, 40);
  assert.throws(
    () => classifyCustomer(customer(100), [duplicate, { ...duplicate, amount: 41 }]),
    /conflicting duplicate/i
  );
});

test('one open-item ID cannot be assigned across multiple customers', () => {
  assert.throws(() => validateUniqueItemOwners([
    { ID: 'I001', customer_ID: 'C001' },
    { ID: 'I001', customer_ID: 'C002' }
  ]), /assigned to multiple customers/i);
});

test('negative or invalid amounts fail and mixed currencies are never combined', () => {
  for (const amount of [-1, undefined, null, '', '   ', 'not-a-number', Infinity]) {
    assert.throws(
      () => classifyCustomer(customer(), [item(amount)]),
      /missing or invalid|finite, non-negative/i
    );
  }
  assert.throws(() => classifyCustomer(
    { ...customer(), currency: 'EUR' },
    [item(10, 'Open', { currency: 'USD' })]
  ), /different currencies/i);
  assert.throws(() => classifyCustomer(
    customer(),
    [item(10, 'Open', { currency: 'EUR' }), item(20, 'Open', { currency: 'USD' })]
  ), /different currencies/i);
});

test('invalid credit limits fail instead of producing invalid utilization', () => {
  for (const creditLimit of [-1, undefined, null, 'invalid', Infinity]) {
    assert.throws(
      () => classifyCustomer({ ...customer(), creditLimit }, []),
      /credit limit/i
    );
  }
});

test('stale review compares date-only values at the twelve-month boundary', () => {
  const now = new Date('2025-03-15T12:00:00.000Z');
  const equalBoundary = classifyCustomer(customer(100, '2024-03-15'), [], now);
  const older = classifyCustomer(customer(100, '2024-03-14'), [], now);
  const newer = classifyCustomer(customer(100, '2024-03-16'), [], now);

  assert.equal(equalBoundary.flags.includes('STALE_REVIEW'), false);
  assert.equal(older.flags.includes('STALE_REVIEW'), true);
  assert.equal(newer.flags.includes('STALE_REVIEW'), false);
});

test('stale review clamps leap-day calendar subtraction to the prior month end', () => {
  const now = new Date('2024-02-29T12:00:00.000Z');
  const boundary = classifyCustomer(customer(100, '2023-02-28'), [], now);
  const older = classifyCustomer(customer(100, '2023-02-27'), [], now);

  assert.equal(boundary.flags.includes('STALE_REVIEW'), false);
  assert.equal(older.flags.includes('STALE_REVIEW'), true);
});

test('missing or invalid review dates do not add a stale-review flag', () => {
  for (const reviewDate of [undefined, null, '', 'not-a-date']) {
    const result = classifyCustomer(
      { creditLimit: 100, lastReviewDate: reviewDate },
      [],
      new Date('2025-03-15T12:00:00.000Z')
    );
    assert.equal(result.flags.includes('STALE_REVIEW'), false);
  }
});

test('approval routing uses the existing percentage OR fixed-amount thresholds', () => {
  assert.equal(routeApprover(1_000_000, 1_250_000), 'Credit Controller');
  assert.equal(routeApprover(1_000_000, 1_500_000), 'Credit Controller');
  assert.equal(routeApprover(1_000_000, 1_500_001), 'Finance Head');
  assert.equal(routeApprover(1_000_000, 900_000), 'Credit Controller');
  assert.equal(routeApprover(0, 500_000), 'Credit Controller');
  assert.equal(routeApprover(0, 500_001), 'Finance Head');
});

test('approval hierarchy allows Finance Head escalation but not reverse escalation', () => {
  assert.equal(canDecide('Credit Controller', 'Credit Controller'), true);
  assert.equal(canDecide('Credit Controller', 'Finance Head'), false);
  assert.equal(canDecide('Finance Head', 'Credit Controller'), true);
  assert.equal(canDecide('Finance Head', 'Finance Head'), true);
  assert.equal(canDecide('unknown', 'Credit Controller'), false);
  assert.equal(canDecide('Finance Head', 'unknown'), false);
});
