const CONFIG = Object.freeze({
  warningUtilisation: 0.8,
  breachUtilisation: 1,
  criticalUtilisation: 1.2,
  overdueShare: 0.3,
  staleReviewMonths: 12,
  controllerIncreasePercent: 0.25,
  controllerIncreaseAmount: 500000
});


function classifyCustomer(customer, items, now = new Date()) {
  const exposure = items.reduce((sum, item) => sum + Number(item.amount), 0);
  const overdueAmount = items
    .filter(item => item.status === 'Overdue')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const creditLimit = Number(customer.creditLimit);
  const utilisation = creditLimit > 0 ? exposure / creditLimit : exposure > 0 ? Infinity : 0;
  const review = new Date(`${customer.lastReviewDate}T00:00:00Z`);
  const staleDate = new Date(now);
  staleDate.setUTCMonth(staleDate.getUTCMonth() - CONFIG.staleReviewMonths);
  const flags = [];
  const overdueRisk = exposure > 0 && overdueAmount / exposure > CONFIG.overdueShare;

  if (creditLimit === 0 && exposure > 0) flags.push('NO_LIMIT');
  if (utilisation > CONFIG.criticalUtilisation) flags.push('CRITICAL');
  else if (utilisation > CONFIG.breachUtilisation) flags.push('BREACH');
  else if (utilisation >= CONFIG.warningUtilisation) flags.push('WARNING');
  if (overdueRisk) flags.push('OVERDUE_RISK');
  if (!Number.isNaN(review.getTime()) && review < staleDate) flags.push('STALE_REVIEW');

  return {
    ...customer,
    creditLimit,
    exposure,
    overdueAmount,
    overdueShare: exposure > 0 ? overdueAmount / exposure : 0,
    utilisation,
    flags,
    status: flags.includes('NO_LIMIT') ? 'NO_LIMIT'
      : utilisation > CONFIG.criticalUtilisation ? 'CRITICAL'
        : utilisation > CONFIG.breachUtilisation ? 'BREACH'
        : utilisation >= CONFIG.warningUtilisation ? 'WARNING'
          : overdueRisk ? 'OVERDUE_RISK' : 'HEALTHY'
  };
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

module.exports = { CONFIG, classifyCustomer, routeApprover, canDecide };
