const CONFIG = Object.freeze({
  warningUtilisation: 0.8,
  breachUtilisation: 1,
  criticalUtilisation: 1.2,
  overdueShare: 0.3,
  staleReviewMonths: 12,
  controllerIncreasePercent: 0.25,
  controllerIncreaseAmount: 500000
});

const CREDIT_CONSUMING_TYPES = new Set(['INVOICE', 'SALESORDER']);
const UNPAID_STATUSES = new Set(['OPEN', 'OVERDUE']);

function subtractCalendarMonths(date, months) {
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth(),
    Math.min(date.getUTCDate(), lastDay)
  ));
}

function dateOnly(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function monetaryValue(value, label) {
  if (value === undefined || value === null
    || (typeof value === 'string' && !value.trim())
    || !['number', 'string'].includes(typeof value)) {
    throw new TypeError(`${label} is missing or invalid.`);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TypeError(`${label} must be a finite, non-negative amount.`);
  }
  return amount;
}

function normalizeCurrency(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${label} has an invalid currency.`);
  const currency = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError(`${label} has an invalid currency.`);
  return currency;
}

function validateUniqueItemOwners(items) {
  const owners = new Map();
  for (const item of items) {
    const itemId = item.ID ?? item.OpenItemId;
    if (itemId === undefined || itemId === null || !String(itemId).trim()) continue;
    const owner = item.customer_ID ?? item.customerId ?? null;
    const key = String(itemId);
    if (owners.has(key) && owners.get(key) !== owner) {
      throw new TypeError(`Open item ${key} is assigned to multiple customers.`);
    }
    owners.set(key, owner);
  }
}

function calculateExposure(customer, items, now = new Date()) {
  if (!Array.isArray(items)) throw new TypeError('Open items must be an array.');
  const businessDate = dateOnly(now);
  if (!businessDate) throw new TypeError('The business date is invalid.');

  const customerCurrency = normalizeCurrency(customer.currency, 'Customer');
  const currencies = new Set(customerCurrency ? [customerCurrency] : []);
  const seen = new Map();
  const itemAnalysis = [];
  let exposure = 0;
  let overdueAmount = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('Open item is invalid.');
    }
    const itemId = item.ID ?? item.OpenItemId;
    const amount = monetaryValue(item.amount, `Open item ${itemId || '(unknown)'} amount`);
    const currency = normalizeCurrency(item.currency, `Open item ${itemId || '(unknown)'}`);
    const type = typeof item.type === 'string' ? item.type.trim().toUpperCase() : '';
    const status = typeof item.status === 'string' ? item.status.trim().toUpperCase() : '';
    const dueDate = dateOnly(item.dueDate);

    if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
      const key = String(itemId);
      const signature = JSON.stringify({
        customer: item.customer_ID ?? item.customerId ?? null,
        type,
        amount,
        currency,
        dueDate: item.dueDate ?? null,
        status
      });
      if (seen.has(key)) {
        if (seen.get(key) !== signature) {
          throw new TypeError(`Open item ${key} has conflicting duplicate records.`);
        }
        continue;
      }
      seen.set(key, signature);
    }

    const creditConsuming = CREDIT_CONSUMING_TYPES.has(type) && UNPAID_STATUSES.has(status);
    const isOverdue = creditConsuming && Boolean(dueDate) && dueDate < businessDate;
    itemAnalysis.push({ ...item, creditConsuming, isOverdue });
    if (!creditConsuming) continue;
    if (currency) currencies.add(currency);
    if (currencies.size > 1) {
      throw new TypeError('Credit exposure cannot combine different currencies.');
    }

    exposure += amount;
    if (!Number.isFinite(exposure)) throw new TypeError('Calculated credit exposure is invalid.');
    if (isOverdue) overdueAmount += amount;
  }

  return {
    exposure,
    overdueAmount,
    currency: currencies.values().next().value || null,
    itemAnalysis
  };
}

function classifyCustomer(customer, items, now = new Date(), includeItemAnalysis = false) {
  const calculated = calculateExposure(customer, items, now);
  const creditLimit = monetaryValue(customer.creditLimit, `Customer ${customer.ID || '(unknown)'} credit limit`);
  const utilisation = creditLimit > 0 ? calculated.exposure / creditLimit : null;
  if (utilisation !== null && !Number.isFinite(utilisation)) {
    throw new TypeError(`Customer ${customer.ID || '(unknown)'} utilization is invalid.`);
  }
  const reviewDate = dateOnly(customer.lastReviewDate);
  const staleDate = subtractCalendarMonths(now, CONFIG.staleReviewMonths);
  const flags = [];
  const overdueRisk = calculated.exposure > 0
    && calculated.overdueAmount / calculated.exposure > CONFIG.overdueShare;
  const overdueInvoiceCount = calculated.itemAnalysis.filter(item =>
    item.creditConsuming && item.isOverdue && String(item.type).toUpperCase() === 'INVOICE'
  ).length;

  if (creditLimit === 0) flags.push('NO_LIMIT');
  if (creditLimit > 0 && calculated.exposure >= creditLimit) flags.push('BREACH');
  if (utilisation !== null && utilisation >= CONFIG.criticalUtilisation) flags.push('CRITICAL');
  else if (utilisation !== null && utilisation >= CONFIG.warningUtilisation
    && calculated.exposure < creditLimit) flags.push('WARNING');
  if (overdueRisk) flags.push('OVERDUE_RISK');
  if (reviewDate && reviewDate < staleDate.toISOString().slice(0, 10)) flags.push('STALE_REVIEW');

  const result = {
    ...customer,
    creditLimit,
    currency: calculated.currency || customer.currency || undefined,
    exposure: calculated.exposure,
    overdueAmount: calculated.overdueAmount,
    overdueShare: calculated.exposure > 0 ? calculated.overdueAmount / calculated.exposure : 0,
    overdueInvoiceCount,
    utilisation,
    utilisationPercent: utilisation === null ? null : utilisation * 100,
    flags,
    status: creditLimit === 0 ? 'MANUAL_REVIEW'
      : calculated.exposure >= creditLimit ? 'BREACH'
        : utilisation >= CONFIG.warningUtilisation ? 'WARNING' : 'HEALTHY'
  };
  if (includeItemAnalysis) result.itemAnalysis = calculated.itemAnalysis;
  return result;
}

function routeApprover(currentLimit, requestedLimit) {
  const increase = Math.max(0, requestedLimit - currentLimit);
  const increasePercent = currentLimit > 0 ? increase / currentLimit : Infinity;
  return increasePercent <= CONFIG.controllerIncreasePercent
    || increase <= CONFIG.controllerIncreaseAmount
    ? 'Credit Controller' : 'Finance Head';
}


function canDecide(role, routedRole) {
  const levels = { 'Credit Controller': 1, 'Finance Head': 2 };
  return (levels[role] || 0) >= (levels[routedRole] || Infinity);
}

module.exports = {
  CONFIG,
  calculateExposure,
  classifyCustomer,
  routeApprover,
  canDecide,
  validateUniqueItemOwners
};
