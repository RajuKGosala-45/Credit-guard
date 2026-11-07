const { createHash, randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const {
  classifyCustomer,
  routeApprover,
  canDecide,
  validateUniqueItemOwners
} = require('./rules');
const {
  createLimitRequestId,
  validateActorId,
  validateIdempotencyKey,
  validateLimitRequest
} = require('./limitRequests');
const { assertCreditLimitWorkflowAvailable } = require('./dataSource');

const hasAnyRole = (user, roles) =>
  Boolean(user && !user._is_anonymous && !user._is_privileged && user.id
    && roles.some(role => user.is(role)));

function requireRole(user, roles) {
  if (!hasAnyRole(user, roles)) {
    const error = new Error('The authenticated user does not have permission for this operation.');
    error.statusCode = user?.id ? 403 : 401;
    throw error;
  }
}

async function getCustomerSummaries(db, user) {
  requireRole(user, ['CreditReader']);
  const [customers, items] = await Promise.all([
    db.run(SELECT.from('credit.Customers')),
    db.run(SELECT.from('credit.OpenItems'))
  ]);
  validateUniqueItemOwners(items);
  return customers.map(customer =>
    classifyCustomer(customer, items.filter(item => item.customer_ID === customer.ID)));
}

async function getCustomerDetail(db, user, customerId) {
  const customer = (await getCustomerSummaries(db, user)).find(item => item.ID === customerId);
  if (!customer) return null;
  const openItems = await db.run(SELECT.from('credit.OpenItems').where({ customer_ID: customer.ID }));
  const analysis = classifyCustomer(customer, openItems, new Date(), true);
  return { ...customer, openItems: analysis.itemAnalysis };
}

async function getCustomerPayments(db, user, customerId) {
  requireRole(user, ['CreditReader']);
  const customer = (await db.run(SELECT.one.from('credit.Customers').where({ ID: customerId }))) || null;
  if (!customer) return null;
  return db.run(SELECT.from('credit.Payments')
    .where({ customer_ID: customer.ID })
    .orderBy('postingDate desc'));
}

function aggregateExposure(records, key) {
  const grouped = new Map();
  const currencies = new Set(records.map(customer => requireCurrency(customer.currency)));
  for (const customer of records) {
    const label = customer[key];
    const currency = requireCurrency(customer.currency);
    const groupKey = `${label}\u0000${currency}`;
    const row = grouped.get(groupKey) || {
      label: currencies.size > 1 ? `${label} (${currency})` : label,
      currency,
      exposure: 0,
      creditLimit: 0,
      customers: 0
    };
    row.exposure += customer.exposure;
    row.creditLimit += customer.creditLimit;
    if (!Number.isFinite(row.exposure) || !Number.isFinite(row.creditLimit)) {
      throw new TypeError('Aggregated exposure or credit limit is invalid.');
    }
    row.customers += 1;
    grouped.set(groupKey, row);
  }
  return [...grouped.values()].map(row => {
    const utilisation = row.creditLimit ? row.exposure / row.creditLimit : null;
    if (utilisation !== null && !Number.isFinite(utilisation)) {
      throw new TypeError('Aggregated utilization is invalid.');
    }
    return { ...row, utilisation };
  }).sort((a, b) => b.exposure - a.exposure);
}

function aggregatePortfolio(customers) {
  const grouped = new Map();
  const availableByCurrency = new Map();
  const overdueByCurrency = new Map();
  for (const customer of customers) {
    const currency = requireCurrency(customer.currency);
    const row = grouped.get(currency) || { currency, totalExposure: 0, totalLimit: 0 };
    row.totalExposure += customer.exposure;
    row.totalLimit += customer.creditLimit;
    if (!Number.isFinite(row.totalExposure) || !Number.isFinite(row.totalLimit)) {
      throw new TypeError(`Portfolio totals for ${currency} are invalid.`);
    }
    grouped.set(currency, row);
    const available = availableByCurrency.get(currency) || 0n;
    availableByCurrency.set(
      currency,
      available + amountToMinorUnits(customer.creditLimit) - amountToMinorUnits(customer.exposure)
    );
    overdueByCurrency.set(
      currency,
      (overdueByCurrency.get(currency) || 0n) + amountToMinorUnits(customer.overdueAmount || 0)
    );
  }
  const currencyTotals = [...grouped.values()].map(row => ({
    ...row,
    overallUtilisation: row.totalLimit ? row.totalExposure / row.totalLimit : null,
    availableCredit: formatMinorUnits(availableByCurrency.get(row.currency) || 0n),
    overdueAmount: formatMinorUnits(overdueByCurrency.get(row.currency) || 0n)
  }));
  if (currencyTotals.some(row =>
    row.overallUtilisation !== null && !Number.isFinite(row.overallUtilisation))) {
    throw new TypeError('Portfolio utilization is invalid.');
  }
  const totals = currencyTotals.length === 1 ? currencyTotals[0]
    : currencyTotals.length === 0 ? { totalExposure: 0, totalLimit: 0, overallUtilisation: 0 }
      : { totalExposure: null, totalLimit: null, overallUtilisation: null };
  const kpis = {
    ...totals,
    availableCredit: currencyTotals.length === 1 ? currencyTotals[0].availableCredit : null,
    customersBreached: customers.filter(item => item.status === 'BREACH').length,
    warningCustomers: customers.filter(item => item.status === 'WARNING').length,
    criticalCustomers: customers.filter(item => item.flags.includes('CRITICAL')).length,
    overdueInvoiceCount: customers.reduce((count, item) => count + (item.overdueInvoiceCount || 0), 0),
    manualReviewCustomers: customers.filter(item => item.status === 'MANUAL_REVIEW').length,
    overdueRiskCustomers: customers.filter(item => item.flags.includes('OVERDUE_RISK')).length,
    healthyCustomers: customers.filter(item => item.status === 'HEALTHY').length,
    customerCount: customers.length
  };
  if (currencyTotals.length > 1) kpis.currencyTotals = currencyTotals;
  return kpis;
}

function amountToMinorUnits(value) {
  const amount = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new TypeError('Portfolio amount cannot be represented as currency minor units.');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}

function requireCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError('Portfolio currency is missing or invalid; currencies cannot be assumed or combined.');
  }
  return value;
}

function formatMinorUnits(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

async function listLimitRequests(db, user, status) {
  requireRole(user, ['CreditReader']);
  const query = SELECT.from('credit.LimitRequests').orderBy('createdAt desc');
  if (status) query.where({ status });
  const [requests, customers] = await Promise.all([
    db.run(query),
    db.run(SELECT.from('credit.Customers'))
  ]);
  return requests.map(request => ({
    ...request,
    customerName: customers.find(customer => customer.ID === request.customer_ID)?.name || request.customer_ID
  }));
}

async function prepareLimitChange(db, user, input) {
  requireRole(user, ['CreditRequester', 'CreditAnalyst', 'CreditManager', 'CreditAdmin']);
  assertCreditLimitWorkflowAvailable();
  const { customerId, requestedLimit, reason } = validateLimitRequest({
    customerId: input?.customerId,
    requestedLimit: input?.requestedLimit,
    reason: input?.reason
  });
  const customer = (await db.run(SELECT.from('credit.Customers').where({ ID: customerId })))[0];
  if (!customer) {
    const error = new Error(`Customer ${customerId} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return {
    customerId,
    customerName: customer.name,
    currentLimit: Number(customer.creditLimit || 0),
    requestedLimit,
    reason,
    approverLevel: routeApprover(Number(customer.creditLimit || 0), requestedLimit)
  };
}

function limitRequestIdempotencyId(requesterId, idempotencyKey) {
  return createHash('sha256')
    .update(JSON.stringify([requesterId, idempotencyKey]))
    .digest('hex');
}

function limitRequestPayloadHash(payload) {
  return createHash('sha256')
    .update(JSON.stringify([payload.customerId, payload.requestedLimit, payload.reason]))
    .digest('hex');
}

async function findIdempotentLimitRequest(db, idempotencyId, requesterId, payloadHash) {
  const entry = await db.run(SELECT.one.from('credit.LimitRequestIdempotency')
    .where({ ID: idempotencyId, requester_ID: requesterId }));
  if (!entry) return null;
  if (entry.payloadHash !== payloadHash) {
    const error = new Error('This idempotency key was already used with a different request.');
    error.statusCode = 409;
    throw error;
  }
  const request = await db.run(SELECT.one.from('credit.LimitRequests')
    .where({ ID: entry.request_ID, requestedBy: requesterId }));
  if (!request) {
    const error = new Error('The idempotent request record is inconsistent.');
    error.statusCode = 500;
    throw error;
  }
  return request;
}

async function createLimitRequest(db, user, input, rawIdempotencyKey) {
  requireRole(user, ['CreditRequester']);
  assertCreditLimitWorkflowAvailable();
  const requestedBy = validateActorId(user.id);
  const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
  const payload = validateLimitRequest({
    customerId: input?.customerId,
    requestedLimit: input?.requestedLimit,
    reason: input?.reason
  });
  const idempotencyId = limitRequestIdempotencyId(requestedBy, idempotencyKey);
  const payloadHash = limitRequestPayloadHash(payload);
  const existing = await findIdempotentLimitRequest(db, idempotencyId, requestedBy, payloadHash);
  if (existing) return { request: existing, duplicate: true };

  const proposal = await prepareLimitChange(db, user, payload);
  const request = {
    ID: createLimitRequestId(),
    customer_ID: proposal.customerId,
    currentLimit: proposal.currentLimit,
    requestedLimit: proposal.requestedLimit,
    reason: proposal.reason,
    requestedBy,
    status: 'Pending',
    approverLevel: proposal.approverLevel,
    createdAt: new Date().toISOString()
  };
  try {
    await db.tx(async tx => {
      await tx.run(INSERT.into('credit.LimitRequests').entries(request));
      await tx.run(INSERT.into('credit.LimitRequestIdempotency').entries({
        ID: idempotencyId,
        request_ID: request.ID,
        requester_ID: requestedBy,
        payloadHash
      }));
    });
    return { request, duplicate: false };
  } catch (error) {
    const winner = await findIdempotentLimitRequest(db, idempotencyId, requestedBy, payloadHash);
    if (winner) return { request: winner, duplicate: true };
    throw error;
  }
}

function validateDecisionReason(reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized || normalized.length > 500) {
    const error = new TypeError('Provide a decision reason of 1-500 characters.');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

async function decideLimitRequest(db, user, requestId, input) {
  const decision = input?.decision;
  if (!['Approved', 'Rejected'].includes(decision)) {
    const error = new TypeError('Provide an Approved or Rejected decision.');
    error.statusCode = 400;
    throw error;
  }
  const request = (await db.run(SELECT.from('credit.LimitRequests').where({ ID: requestId })))[0];
  if (!request) {
    const error = new Error('Limit request was not found.');
    error.statusCode = 404;
    throw error;
  }
  if (request.status !== 'Pending') {
    const error = new Error('This request has already been decided.');
    error.statusCode = 409;
    throw error;
  }

  requireRole(user, ['FinanceHead', 'CreditApprover', 'CreditAdmin', 'CreditController', 'CreditManager']);
  const role = user?.is('FinanceHead') || user?.is('CreditApprover') || user?.is('CreditAdmin')
    ? 'Finance Head'
    : user?.is('CreditController') || user?.is('CreditManager') ? 'Credit Controller' : null;
  if (!role || !canDecide(role, request.approverLevel)) {
    const error = new Error(`The authenticated user is not authorized to decide a request routed to ${request.approverLevel}.`);
    error.statusCode = user?.id ? 403 : 401;
    throw error;
  }
  if (request.requestedBy === user.id) {
    const error = new Error('The requester cannot approve or reject their own request.');
    error.statusCode = 403;
    throw error;
  }

  assertCreditLimitWorkflowAvailable();
  const decidedBy = validateActorId(user.id);
  const decisionReason = validateDecisionReason(input.reason);
  const decidedAt = new Date().toISOString();
  await db.tx(async tx => {
    const transitioned = await tx.run(UPDATE('credit.LimitRequests')
      .set({ status: decision, decidedBy, decidedAt })
      .where({ ID: request.ID, status: 'Pending' }));
    if (transitioned !== 1) {
      const error = new Error('This request has already been decided.');
      error.statusCode = 409;
      throw error;
    }
    if (decision === 'Approved') {
      const customerUpdated = await tx.run(UPDATE('credit.Customers')
        .set({ creditLimit: request.requestedLimit }).where({ ID: request.customer_ID }));
      if (customerUpdated !== 1) {
        const error = new Error('The customer record changed before this request could be applied.');
        error.statusCode = 409;
        throw error;
      }
    }
    await tx.run(INSERT.into('credit.ApprovalHistory').entries({
      ID: randomUUID(),
      request_ID: request.ID,
      requester_ID: request.requestedBy,
      approver_ID: decidedBy,
      previousStatus: request.status,
      newStatus: decision,
      decisionReason,
      timestamp: decidedAt
    }));
  });
  return { ...request, status: decision, decidedBy, decidedAt, decisionReason };
}

async function getApprovalHistory(db, user, requestId) {
  requireRole(user, ['CreditReader']);
  return db.run(SELECT.from('credit.ApprovalHistory')
    .where({ request_ID: requestId }).orderBy('timestamp asc'));
}

module.exports = {
  aggregateExposure,
  aggregatePortfolio,
  amountToMinorUnits,
  createLimitRequest,
  decideLimitRequest,
  getApprovalHistory,
  getCustomerDetail,
  getCustomerPayments,
  getCustomerSummaries,
  listLimitRequests,
  prepareLimitChange
};
