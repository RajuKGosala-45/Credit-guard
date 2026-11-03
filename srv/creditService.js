const { randomUUID } = require('crypto');
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
  validateLimitRequest
} = require('./limitRequests');

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

function aggregateExposure(records, key) {
  const grouped = new Map();
  const currencies = new Set(records.map(customer => customer.currency || 'INR'));
  for (const customer of records) {
    const label = customer[key];
    const currency = customer.currency || 'INR';
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
  for (const customer of customers) {
    const currency = customer.currency || 'INR';
    const row = grouped.get(currency) || { currency, totalExposure: 0, totalLimit: 0 };
    row.totalExposure += customer.exposure;
    row.totalLimit += customer.creditLimit;
    if (!Number.isFinite(row.totalExposure) || !Number.isFinite(row.totalLimit)) {
      throw new TypeError(`Portfolio totals for ${currency} are invalid.`);
    }
    grouped.set(currency, row);
  }
  const currencyTotals = [...grouped.values()].map(row => ({
    ...row,
    overallUtilisation: row.totalLimit ? row.totalExposure / row.totalLimit : null
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
    customersBreached: customers.filter(item => item.status === 'BREACH').length,
    warningCustomers: customers.filter(item => item.status === 'WARNING').length,
    manualReviewCustomers: customers.filter(item => item.status === 'MANUAL_REVIEW').length,
    overdueRiskCustomers: customers.filter(item => item.flags.includes('OVERDUE_RISK')).length,
    healthyCustomers: customers.filter(item => item.status === 'HEALTHY').length,
    customerCount: customers.length
  };
  if (currencyTotals.length > 1) kpis.currencyTotals = currencyTotals;
  return kpis;
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

async function createLimitRequest(db, user, input) {
  const proposal = await prepareLimitChange(db, user, input);
  const requestedBy = validateActorId(user.id);
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
  await db.run(INSERT.into('credit.LimitRequests').entries(request));
  return request;
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
  createLimitRequest,
  decideLimitRequest,
  getApprovalHistory,
  getCustomerDetail,
  getCustomerSummaries,
  listLimitRequests,
  prepareLimitChange
};
