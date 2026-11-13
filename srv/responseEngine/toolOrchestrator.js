const creditService = require('../creditService');
const {
  latestMonitoringRun,
  listMonitoringRuns,
  listMonitoringFindings,
  listMonitoringAlerts
} = require('../monitoringStore');
const { getLatestIngestionRun, listIngestionIssues } = require('../ingestionStore');
const { listSources } = require('../sourceRegistryStore');
const { MOCK_SAP_SOURCE_ID } = require('../sourceRegistry');
const { getConfiguredDataSource } = require('../dataSource');
const mockSapFixture = require('../integrations/mock-sap/fixtures.json');

async function safeCall(label, fn, limitations = []) {
  try {
    return await fn();
  } catch (error) {
    limitations.push(`${label} could not be retrieved (${error?.message || 'service unavailable'}).`);
    return null;
  }
}

async function orchestrateIntentData(intentPlan, {
  db,
  user,
  tools = {},
  executionOutputs = [],
  customerDataSource
} = {}) {
  const limitations = [];
  const toolsInvoked = new Set();
  const timestamp = new Date().toISOString();

  // Seed from already executed agent tasks in this turn
  let customers = null;
  let customerDetailsById = new Map();
  let customerPaymentsById = new Map();
  let approvalHistoryById = new Map();
  let limitRequests = null;
  let monitoringAnalysis = null;
  let monitoringAlerts = null;
  let ingestionStatus = null;
  let mockSapRecords = null;

  for (const out of executionOutputs || []) {
    if (!out || !out.tool || out.result === undefined || out.result === null) continue;
    toolsInvoked.add(out.tool);
    const res = out.result;
    if (out.tool === 'get_portfolio_summary' && res.portfolio) {
      if (Array.isArray(res.customers)) customers = res.customers;
    } else if (out.tool === 'list_customers_over_threshold' && Array.isArray(res)) {
      if (!customers) customers = res;
    } else if (out.tool === 'get_customer' && res && res.ID) {
      customerDetailsById.set(String(res.ID).toUpperCase(), res);
      if (Array.isArray(res.payments)) {
        customerPaymentsById.set(String(res.ID).toUpperCase(), res.payments);
      }
    } else if (out.tool === 'get_customer_approval_history' && res && res.customerId) {
      approvalHistoryById.set(String(res.customerId).toUpperCase(), res);
    } else if (out.tool === 'list_limit_requests' && Array.isArray(res)) {
      limitRequests = res;
    } else if (out.tool === 'get_monitoring_analysis' && res) {
      monitoringAnalysis = res;
    } else if (out.tool === 'get_monitoring_alerts' && res) {
      monitoringAlerts = Array.isArray(res.alerts) ? res.alerts : [];
    } else if (out.tool === 'get_data_ingestion_status' && res) {
      ingestionStatus = res;
    } else if (out.tool === 'get_mock_sap_records' && res) {
      mockSapRecords = res;
    }
  }

  const intent = intentPlan.primaryIntent;
  const secondary = intentPlan.secondaryIntents || [];
  const allIntents = new Set([intent, ...secondary]);
  const { normalizePortfolioCustomers, normalizeCountry } = require('./calculators');

  if (intent === 'GREETING' || intent === 'UNKNOWN' || intent === 'CLARIFY' || intent === 'OUT_OF_SCOPE') {
    return {
      customers: customers ? normalizePortfolioCustomers(customers) : [],
      customerDetailsById,
      customerPaymentsById,
      approvalHistoryById,
      limitRequests: limitRequests || [],
      monitoringAnalysis,
      monitoringAlerts: monitoringAlerts || [],
      monitoringRuns: [],
      openItems: [],
      payments: [],
      ingestionStatus,
      mockSapRecords,
      limitations,
      provenance: {
        sourceType: 'SYNTHETIC_DEMO',
        connectorName: 'Credit Guard CAP Policy & Formula Engine',
        lastSyncAt: timestamp,
        toolsInvoked: [...toolsInvoked]
      }
    };
  }

  // If unknown customer was queried and no valid customer IDs exist, do not fabricate
  if (intentPlan.unknownCustomerIds?.length > 0 && (!intentPlan.customerIds || intentPlan.customerIds.length === 0)) {
    return {
      customers: [],
      customerDetailsById,
      customerPaymentsById,
      approvalHistoryById,
      limitRequests: [],
      monitoringAnalysis: null,
      monitoringAlerts: [],
      monitoringRuns: [],
      openItems: [],
      payments: [],
      ingestionStatus: null,
      mockSapRecords: null,
      limitations,
      provenance: {
        sourceType: 'SYNTHETIC_DEMO',
        connectorName: 'Credit Guard CAP Database',
        lastSyncAt: timestamp,
        toolsInvoked: [...toolsInvoked]
      }
    };
  }

  const targetCustomerIds = Array.isArray(intentPlan.customerIds) ? intentPlan.customerIds : [];

  // Load full portfolio customers when needed for deterministic filtering, reconciliation & dynamic policy counts
  const needsPortfolio = ['LIST', 'COMPARE', 'EXPOSURE', 'RISK', 'TREND', 'PAYMENT_OVERDUE', 'MONITORING', 'APPROVAL', 'WHATIF', 'EXPLAIN'].some(i => allIntents.has(i));
  if (needsPortfolio && (!Array.isArray(customers) || customers.length < 13) && db) {
    const fetched = await safeCall('Customer portfolio', async () => {
      if (intent !== 'EXPLAIN') {
        toolsInvoked.add('get_portfolio_summary');
      }
      return creditService.getCustomerSummaries(db, user);
    }, intent === 'EXPLAIN' ? [] : limitations);
    if (Array.isArray(fetched) && fetched.length > 0) {
      customers = fetched;
    }
  }

  if (Array.isArray(customers)) {
    customers = normalizePortfolioCustomers(customers, { specificIds: targetCustomerIds });
  }

  // Load single or multiple customer details when needed
  if (['CUSTOMER_DETAIL', 'APPROVAL', 'WHATIF'].some(i => allIntents.has(i))) {
    const idsToLoad = targetCustomerIds.length > 0
      ? targetCustomerIds.slice(0, 5)
      : (customers && customers.length > 0 ? [customers[0].ID] : ['C001']);

    for (const id of idsToLoad) {
      const upperId = String(id).toUpperCase();
      if (!customerDetailsById.has(upperId) && db) {
        const detail = await safeCall(`Customer detail (${upperId})`, async () => {
          toolsInvoked.add('get_customer');
          if (typeof tools.get_customer === 'function') {
            return tools.get_customer({ customer_id: upperId });
          }
          const d = await creditService.getCustomerDetail(db, user, upperId);
          const p = await creditService.getCustomerPayments(db, user, upperId);
          return d ? { ...d, payments: p || [] } : null;
        }, limitations);
        if (detail) {
          customerDetailsById.set(upperId, {
            ...detail,
            country: normalizeCountry(detail.country || detail.country_code)
          });
          if (Array.isArray(detail.payments)) {
            customerPaymentsById.set(upperId, detail.payments);
          }
        }
      }

      if (['CUSTOMER_DETAIL', 'APPROVAL'].some(i => allIntents.has(i)) && !approvalHistoryById.has(upperId) && db) {
        const historyData = await safeCall(`Approval history (${upperId})`, async () => {
          toolsInvoked.add('get_customer_approval_history');
          if (typeof tools.get_customer_approval_history === 'function') {
            return tools.get_customer_approval_history({ customer_id: upperId });
          }
          const allRequests = await creditService.listLimitRequests(db, user);
          const customerRequests = (allRequests || []).filter(r => String(r.customer_ID).toUpperCase() === upperId);
          const withHistory = await Promise.all(customerRequests.map(async reqItem => ({
            ...reqItem,
            decisions: await creditService.getApprovalHistory(db, user, reqItem.ID)
          })));
          return { customerId: upperId, requests: withHistory };
        }, limitations);
        if (historyData) {
          approvalHistoryById.set(upperId, historyData);
        }
      }
    }
  }

  // Load all open items and payments for PAYMENT_OVERDUE
  let openItems = [];
  let payments = [];
  if (allIntents.has('PAYMENT_OVERDUE') && db) {
    toolsInvoked.add('get_customer');
    const rawItems = await safeCall('Open invoice items', async () => {
      return db.run(
        require('@sap/cds').ql.SELECT.from('credit.OpenItems')
      );
    }, limitations);
    const rawPayments = await safeCall('Customer payment records', async () => {
      return db.run(
        require('@sap/cds').ql.SELECT.from('credit.Payments')
      );
    }, limitations);

    const canonicalCustomerIds = new Set((customers || []).map(c => String(c.ID).toUpperCase()));
    const customerNameMap = new Map((customers || []).map(c => [String(c.ID).toUpperCase(), c.name]));
    if (Array.isArray(rawItems)) {
      openItems = rawItems
        .filter(item => {
          const itemCustId = String(item.customer_ID || '').toUpperCase();
          if (targetCustomerIds.length > 0) {
            return targetCustomerIds.includes(itemCustId);
          }
          if (canonicalCustomerIds.size > 0 && !canonicalCustomerIds.has(itemCustId)) {
            return false;
          }
          if (intentPlan.countries?.length > 0 && Array.isArray(customers)) {
            const allowedIds = new Set(
              customers
                .filter(c => intentPlan.countries.map(x => normalizeCountry(x).toLowerCase()).includes(normalizeCountry(c.country || '').toLowerCase()))
                .map(c => String(c.ID).toUpperCase())
            );
            return allowedIds.has(itemCustId);
          }
          return true;
        })
        .map(item => ({
          ...item,
          customerName: customerNameMap.get(String(item.customer_ID || '').toUpperCase()) || item.customer_ID
        }));
    }
    if (Array.isArray(rawPayments)) {
      payments = rawPayments.filter(pay => {
        const payCustId = String(pay.customer_ID || '').toUpperCase();
        if (targetCustomerIds.length > 0) {
          return targetCustomerIds.includes(payCustId);
        }
        if (canonicalCustomerIds.size > 0 && !canonicalCustomerIds.has(payCustId)) {
          return false;
        }
        return true;
      });
    }
  }

  // Load monitoring runs, findings, and alerts for MONITORING, RISK, CUSTOMER_DETAIL, TREND
  let monitoringRuns = [];
  if (['MONITORING', 'RISK', 'CUSTOMER_DETAIL', 'TREND'].some(i => allIntents.has(i)) && db) {
    if (!monitoringAnalysis) {
      monitoringAnalysis = await safeCall('Monitoring analysis', async () => {
        toolsInvoked.add('get_monitoring_analysis');
        const run = await latestMonitoringRun(db);
        if (!run) return null;
        const findings = await listMonitoringFindings(db, run.ID);
        return {
          runId: run.ID,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          source: run.source || 'Credit Guard CAP database',
          summary: {
            customersEvaluated: run.customersEvaluated,
            flaggedCustomers: run.flaggedCustomers,
            breachedCustomers: run.breachedCustomers,
            warningCustomers: run.warningCustomers,
            overdueCustomers: run.overdueCustomers,
            staleReviewCustomers: run.staleReviewCustomers,
            totalExposure: run.totalExposure,
            overdueExposure: run.overdueExposure
          },
          findings: findings || []
        };
      }, limitations);
    }

    if (allIntents.has('MONITORING') || allIntents.has('CUSTOMER_DETAIL')) {
      if (!monitoringAlerts) {
        monitoringAlerts = await safeCall('Monitoring alerts', async () => {
          toolsInvoked.add('get_monitoring_alerts');
          return listMonitoringAlerts(db, 'ALL');
        }, limitations) || [];
      }
    }

    if (allIntents.has('TREND')) {
      monitoringRuns = await safeCall('Historical monitoring runs', async () => {
        toolsInvoked.add('get_monitoring_analysis');
        const runs = await listMonitoringRuns(db, 12);
        return (runs || []).filter(r => r.status === 'COMPLETED' && r.completedAt);
      }, limitations) || [];
    }
  }

  // Load limit requests for APPROVAL when no specific customer or when checking pending requests
  if (allIntents.has('APPROVAL') && !limitRequests && db) {
    limitRequests = await safeCall('Credit limit requests', async () => {
      toolsInvoked.add('list_limit_requests');
      return creditService.listLimitRequests(db, user);
    }, limitations) || [];
  }

  // Load data source / SAP connector metadata for SAP_DATASOURCE
  if (allIntents.has('SAP_DATASOURCE') && db) {
    if (!ingestionStatus) {
      ingestionStatus = await safeCall('Data ingestion status', async () => {
        toolsInvoked.add('get_data_ingestion_status');
        if (typeof tools.get_data_ingestion_status === 'function') {
          return tools.get_data_ingestion_status({});
        }
        const registeredSources = await listSources(db);
        const enrichedSources = await Promise.all((registeredSources || []).map(async src => {
          const latestRun = await getLatestIngestionRun(db, src.sourceId);
          const issues = latestRun ? await listIngestionIssues(db, latestRun.ID) : [];
          return {
            sourceId: src.sourceId,
            name: src.name,
            sourceSystemType: src.sourceSystemType,
            connectionMode: src.connectionMode,
            enabled: src.enabled,
            supportedEntities: src.supportedEntities,
            latestRun: latestRun ? {
              id: latestRun.ID,
              status: latestRun.status,
              completedAt: latestRun.completedAt || latestRun.startedAt,
              recordsReceived: latestRun.recordsReceived,
              recordsAccepted: latestRun.recordsAccepted,
              recordsRejected: latestRun.recordsRejected,
              snapshotPromoted: Boolean(latestRun.snapshotPromoted),
              issueCount: (issues || []).length
            } : null
          };
        }));
        return {
          source: 'Credit Guard Ingestion Registry & Mock SAP Simulator (SYNTHETIC - NOT REAL SAP DATA)',
          retrievedAt: timestamp,
          sources: enrichedSources,
          syntheticMockSapFixture: {
            sourceId: MOCK_SAP_SOURCE_ID,
            label: mockSapFixture.label || 'SYNTHETIC - NOT REAL SAP DATA',
            customers: (mockSapFixture.customers || []).length,
            creditAccounts: (mockSapFixture.creditAccounts || []).length,
            openInvoices: (mockSapFixture.openInvoices || []).length,
            payments: (mockSapFixture.payments || []).length
          }
        };
      }, limitations);
    }
  }

  const configuredMode = customerDataSource || getConfiguredDataSource();
  const isMockSap = configuredMode === 'mock-sap' || allIntents.has('SAP_DATASOURCE');

  return {
    customers: customers || [],
    customerDetailsById,
    customerPaymentsById,
    approvalHistoryById,
    limitRequests: limitRequests || [],
    monitoringAnalysis,
    monitoringAlerts: monitoringAlerts || [],
    monitoringRuns,
    openItems,
    payments,
    ingestionStatus,
    mockSapRecords,
    limitations,
    provenance: {
      sourceType: isMockSap ? 'MOCK_SAP_SIMULATOR' : 'SYNTHETIC_DEMO',
      connectorName: isMockSap
        ? 'Mock SAP S/4HANA FSCM Simulator (Synthetic Fixture)'
        : 'Credit Guard CAP Database (Synthetic Demo Portfolio)',
      lastSyncAt: monitoringAnalysis?.completedAt || ingestionStatus?.retrievedAt || timestamp,
      toolsInvoked: [...toolsInvoked]
    }
  };
}

module.exports = {
  orchestrateIntentData
};
