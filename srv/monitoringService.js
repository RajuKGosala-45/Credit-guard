const { createPortfolioDataProvider } = require('./portfolioDataProvider');
const { generateMonitoringSummary } = require('./monitoringSummary');
const {
  claimMonitoringRecovery,
  completeMonitoringRun,
  createMonitoringRun,
  dispatchNotificationOutbox,
  failMonitoringRun,
  getMonitoringRun,
  listMonitoringFindings,
  saveMonitoringAdvisory
} = require('./monitoringStore');

const RULES_VERSION = '1';
const DEFAULT_MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const RISK_CONDITIONS = Object.freeze([
  'CRITICAL',
  'BREACH',
  'WARNING',
  'OVERDUE_RISK',
  'NO_LIMIT',
  'STALE_REVIEW'
]);

function assertReader(user) {
  if (!user || user._is_anonymous || user._is_privileged || !user.id || !user.is?.('CreditReader')) {
    const error = new Error('The authenticated user does not have permission to monitor credit data.');
    error.statusCode = user?.id ? 403 : 401;
    throw error;
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError(`${label} must be a valid timestamp.`);
  return timestamp.toISOString();
}

function assertMoney(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative amount.`);
  }
}

function normalizeCustomer(customer) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    throw new TypeError('The monitoring source returned an invalid customer record.');
  }
  if (typeof customer.ID !== 'string' || !customer.ID.trim()
    || typeof customer.name !== 'string' || !customer.name.trim()) {
    throw new TypeError('The monitoring source returned a customer without an identifier or name.');
  }
  if (!['HEALTHY', 'WARNING', 'BREACH', 'MANUAL_REVIEW'].includes(customer.status)) {
    throw new TypeError(`Customer ${customer.ID} monitoring status is invalid.`);
  }
  assertMoney(customer.creditLimit, `Customer ${customer.ID} credit limit`);
  assertMoney(customer.exposure, `Customer ${customer.ID} exposure`);
  assertMoney(customer.overdueAmount, `Customer ${customer.ID} overdue amount`);
  if (customer.utilisation !== null
    && (typeof customer.utilisation !== 'number' || !Number.isFinite(customer.utilisation)
      || customer.utilisation < 0)) {
    throw new TypeError(`Customer ${customer.ID} utilization is invalid.`);
  }
  if (typeof customer.overdueShare !== 'number' || !Number.isFinite(customer.overdueShare)
    || customer.overdueShare < 0 || customer.overdueShare > 1) {
    throw new TypeError(`Customer ${customer.ID} overdue share is invalid.`);
  }
  if (!Array.isArray(customer.flags)
    || customer.flags.some(flag => typeof flag !== 'string' || !RISK_CONDITIONS.includes(flag))) {
    throw new TypeError(`Customer ${customer.ID} risk flags are invalid.`);
  }
  if (customer.currency !== undefined && customer.currency !== null
    && (typeof customer.currency !== 'string' || !/^[A-Z]{3}$/.test(customer.currency))) {
    throw new TypeError(`Customer ${customer.ID} currency is invalid.`);
  }
  return customer;
}

function severityFor(customer) {
  if (customer.flags.includes('CRITICAL')) return 'CRITICAL';
  if (customer.status === 'BREACH' || customer.flags.includes('BREACH')) return 'HIGH';
  if (customer.flags.includes('OVERDUE_RISK') || customer.flags.includes('WARNING')) return 'MEDIUM';
  if (customer.flags.includes('NO_LIMIT') || customer.flags.includes('STALE_REVIEW')) return 'REVIEW';
  return 'LOW';
}

function createFindings(customers, source, retrievedAt) {
  return customers.filter(customer =>
    customer.flags.length > 0 || customer.status !== 'HEALTHY' || customer.overdueAmount > 0
  ).map(customer => ({
    customerId: customer.ID,
    customerName: customer.name,
    status: customer.status,
    severity: severityFor(customer),
    conditions: [...new Set([
      ...customer.flags,
      ...(customer.status === 'BREACH' ? ['BREACH'] : []),
      ...(customer.overdueAmount > 0 ? ['OVERDUE_AMOUNT'] : [])
    ])],
    exposure: customer.exposure,
    creditLimit: customer.creditLimit,
    utilisation: customer.utilisation,
    overdueAmount: customer.overdueAmount,
    overdueShare: customer.overdueShare,
    currency: customer.currency || null,
    source,
    retrievedAt
  }));
}

function summarize(customers, findings) {
  return {
    customersMonitored: customers.length,
    warningCustomers: customers.filter(customer => customer.status === 'WARNING').length,
    breachedCustomers: customers.filter(customer => customer.status === 'BREACH').length,
    criticalCustomers: customers.filter(customer => customer.flags.includes('CRITICAL')).length,
    overdueCustomers: customers.filter(customer => customer.overdueAmount > 0).length,
    manualReviewCustomers: customers.filter(customer => customer.status === 'MANUAL_REVIEW').length,
    findings: findings.length
  };
}

function normalizeSnapshot(snapshot, { now, maxSourceAgeMs }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('The monitoring provider returned an invalid snapshot.');
  }
  if (typeof snapshot.source !== 'string' || !snapshot.source.trim()
    || !Array.isArray(snapshot.customers)) {
    throw new TypeError('The monitoring provider returned an incomplete snapshot.');
  }
  const retrievedAt = assertTimestamp(snapshot.retrievedAt, 'Source retrieval timestamp');
  const customers = snapshot.customers.map(normalizeCustomer);
  const ids = new Set();
  for (const customer of customers) {
    if (ids.has(customer.ID)) throw new TypeError('The monitoring source returned duplicate customer identifiers.');
    ids.add(customer.ID);
  }
  const sourceTimestamp = snapshot.sourceTimestamp
    ? assertTimestamp(snapshot.sourceTimestamp, 'Source data timestamp')
    : null;
  if (sourceTimestamp && new Date(sourceTimestamp).getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new TypeError('The monitoring source timestamp is in the future.');
  }
  const freshness = sourceTimestamp
    ? (now.getTime() - new Date(sourceTimestamp).getTime() > maxSourceAgeMs ? 'STALE' : 'FRESH')
    : 'UNKNOWN';
  const status = snapshot.complete === false ? 'PARTIAL'
    : freshness === 'STALE' ? 'STALE' : 'COMPLETED';
  const findings = createFindings(customers, snapshot.source, retrievedAt);
  return {
    status,
    source: snapshot.source,
    retrievedAt,
    sourceTimestamp,
    freshness,
    rulesVersion: RULES_VERSION,
    summary: summarize(customers, findings),
    findings
  };
}

async function loadSnapshot({ db, user, source, abapClient, provider, now }) {
  if (provider) return provider.getSnapshot();
  const customerProvider = createPortfolioDataProvider({
    db,
    user,
    source,
    abapClient
  });
  const rows = await customerProvider.listCustomers();
  if (customerProvider.source === 'local') {
    return {
      source: 'CAP database',
      retrievedAt: now.toISOString(),
      customers: rows,
      complete: true
    };
  }

  const retrievedAtValues = new Set(rows.map(row => row?.retrievedAt).filter(Boolean));
  if (retrievedAtValues.size > 1) {
    throw new TypeError('The ABAP monitoring source returned inconsistent retrieval timestamps.');
  }
  return {
    source: 'ABAP Environment via BTP Destination service',
    retrievedAt: retrievedAtValues.values().next().value || now.toISOString(),
    customers: rows,
    complete: true
  };
}

async function monitorPortfolio({
  db,
  user,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient,
  provider,
  now = new Date(),
  maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS
} = {}) {
  assertReader(user);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('The monitoring clock is invalid.');
  }
  if (!Number.isSafeInteger(maxSourceAgeMs) || maxSourceAgeMs < 0) {
    throw new TypeError('The maximum source age is invalid.');
  }
  const snapshot = await loadSnapshot({ db, user, source, abapClient, provider, now });
  return normalizeSnapshot(snapshot, { now, maxSourceAgeMs });
}

function sourceName(source) {
  return source === 'abap'
    ? 'ABAP Environment via BTP Destination service'
    : source === 'local' ? 'CAP database' : source;
}

function publicRun(run, findings = []) {
  let summary = null;
  try { summary = run.summary ? JSON.parse(run.summary) : null; }
  catch { summary = null; }
  return {
    id: run.ID,
    status: run.status,
    runKind: run.runKind,
    source: run.source,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    retrievedAt: run.retrievedAt,
    sourceTimestamp: run.sourceTimestamp,
    freshness: run.freshness,
    rulesVersion: run.rulesVersion,
    summary,
    errorCategory: run.errorCategory,
    attemptCount: run.attemptCount,
    recoveryStatus: run.recoveryStatus,
    advisorySummary: run.advisorySummary || null,
    advisorySource: run.advisorySource || null,
    advisoryErrorCategory: run.advisoryErrorCategory || null,
    findings: findings.map(publicFinding)
  };
}

function publicFinding(finding) {
  let conditions = [];
  if (Array.isArray(finding.conditions)) conditions = finding.conditions;
  else {
    try { conditions = JSON.parse(finding.conditions); }
    catch { conditions = []; }
  }
  return {
    ID: finding.ID,
    customer_ID: finding.customer_ID,
    customerName: finding.customerName,
    status: finding.status,
    severity: finding.severity,
    conditions,
    exposure: finding.exposure,
    creditLimit: finding.creditLimit,
    utilisation: finding.utilisation,
    overdueAmount: finding.overdueAmount,
    overdueShare: finding.overdueShare,
    currency: finding.currency,
    source: finding.source,
    retrievedAt: finding.retrievedAt
  };
}

async function executeMonitoringRun({
  db,
  user,
  runKind = 'MANUAL',
  slotKey,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient,
  provider,
  summaryProvider,
  now = new Date(),
  deliverNotification
} = {}) {
  assertReader(user);
  const key = slotKey || `manual:${require('crypto').randomUUID()}`;
  const claimed = await createMonitoringRun(db, {
    slotKey: key,
    runKind,
    source: provider?.source || sourceName(source),
    triggeredBy: user.id,
    now
  });
  if (!claimed.created) {
    const findings = await listMonitoringFindings(db, claimed.run.ID);
    return { ...publicRun(claimed.run, findings), duplicate: true };
  }
  let result;
  let run;
  try {
    result = await monitorPortfolio({
      db, user, source, abapClient, provider, now
    });
    run = await completeMonitoringRun(
      db, claimed.run.ID, result, user.id, new Date(), claimed.run.attemptCount
    );
  } catch (error) {
    const failed = await failMonitoringRun(db, claimed.run.ID, error, new Date(), claimed.run.attemptCount);
    if (!failed) throw error;
    return publicRun(failed);
  }
  const advisory = await generateMonitoringSummary(result, { provider: summaryProvider });
  let advisoryErrorCategory = advisory.errorCategory;
  try {
    await saveMonitoringAdvisory(db, claimed.run.ID, advisory);
  } catch {
    advisoryErrorCategory = 'monitoring_persistence_error';
  }
  let notificationFailures = 0;
  try {
    notificationFailures = (await dispatchNotificationOutbox(db, {
      deliver: deliverNotification,
      now: new Date()
    })).filter(item => item.status === 'FAILED').length;
  } catch {
    notificationFailures = 1;
  }
  const findings = await listMonitoringFindings(db, claimed.run.ID);
  return {
    ...publicRun({
      ...run,
      source: result.source,
      retrievedAt: result.retrievedAt,
      sourceTimestamp: result.sourceTimestamp,
      freshness: result.freshness,
      rulesVersion: result.rulesVersion,
      summary: JSON.stringify({
        status: result.status,
        source: result.source,
        retrievedAt: result.retrievedAt,
        sourceTimestamp: result.sourceTimestamp,
        freshness: result.freshness,
        rulesVersion: result.rulesVersion,
        ...result.summary
      }),
      advisorySummary: advisory.text,
      advisorySource: advisory.source,
      advisoryErrorCategory
    }, findings),
    notificationFailures
  };
}

async function recoverMonitoringRun({
  db,
  user,
  runId,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient,
  provider,
  summaryProvider,
  now = new Date(),
  deliverNotification
} = {}) {
  assertReader(user);
  const run = await claimMonitoringRecovery(db, runId, now);
  let result;
  let completed;
  try {
    result = await monitorPortfolio({
      db, user, source, abapClient, provider, now
    });
    completed = await completeMonitoringRun(db, run.ID, result, user.id, new Date(), run.attemptCount);
  } catch (error) {
    const failed = await failMonitoringRun(db, run.ID, error, new Date(), run.attemptCount);
    if (!failed) throw error;
    return publicRun(failed);
  }
  const advisory = await generateMonitoringSummary(result, { provider: summaryProvider });
  let advisoryErrorCategory = advisory.errorCategory;
  try {
    await saveMonitoringAdvisory(db, run.ID, advisory);
  } catch {
    advisoryErrorCategory = 'monitoring_persistence_error';
  }
  let notificationFailures = 0;
  try {
    notificationFailures = (await dispatchNotificationOutbox(db, {
      deliver: deliverNotification,
      now: new Date()
    })).filter(item => item.status === 'FAILED').length;
  } catch {
    notificationFailures = 1;
  }
  const findings = await listMonitoringFindings(db, run.ID);
  return {
    ...publicRun({
      ...completed,
      source: result.source,
      retrievedAt: result.retrievedAt,
      sourceTimestamp: result.sourceTimestamp,
      freshness: result.freshness,
      rulesVersion: result.rulesVersion,
      summary: JSON.stringify({
        status: result.status,
        source: result.source,
        retrievedAt: result.retrievedAt,
        sourceTimestamp: result.sourceTimestamp,
        freshness: result.freshness,
        rulesVersion: result.rulesVersion,
        ...result.summary
      }),
      advisorySummary: advisory.text,
      advisorySource: advisory.source,
      advisoryErrorCategory
    }, findings),
    notificationFailures
  };
}

module.exports = {
  DEFAULT_MAX_SOURCE_AGE_MS,
  RULES_VERSION,
  executeMonitoringRun,
  monitorPortfolio,
  normalizeSnapshot,
  publicFinding,
  publicRun,
  recoverMonitoringRun,
  summarize
};
