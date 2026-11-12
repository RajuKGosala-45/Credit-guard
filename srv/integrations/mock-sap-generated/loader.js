const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const cds = require('@sap/cds');
const { createConfiguredIngestionRuntime } = require('../../ingestionRuntime');
const { listIngestionIssues } = require('../../ingestionStore');
const { executeMonitoringRun } = require('../../monitoringService');
const { ensureMockSapGeneratedSource } = require('../../sourceRegistryStore');
const {
  defaultSimClock,
  isSapSimEnabled
} = require('./connector');

const SYNTHETIC_LABEL = 'SYNTHETIC - NOT REAL SAP DATA';
const FIXED_SEED = 42;
const FIXED_CUSTOMERS = 300;
const EXPECTED_CSV_FILES = Object.freeze([
  'BUT000.csv',
  'UKMBP_CMS_SGM.csv',
  'UKM_ITEM.csv',
  'BSID.csv',
  'BSAD.csv',
  'VBAK.csv'
]);
function buildDecisionEligibleExplanation({
  snapshotPromoted,
  projectedCustomers,
  quarantinedCustomerCount,
  qualityIssueCounts = {},
  decisionEligible
}) {
  const errors = qualityIssueCounts.errors ?? 0;
  const warnings = qualityIssueCounts.warnings ?? 0;
  const totalIssues = qualityIssueCounts.total ?? (errors + warnings);

  const promotionText = snapshotPromoted
    ? `Snapshot was promoted (${projectedCustomers} valid customers active in portfolio).`
    : `Snapshot was not promoted (${projectedCustomers} customers projected).`;

  const details = `${totalIssues} quality issues (${errors} error(s), ${warnings} warning(s)) and ${quarantinedCustomerCount} quarantined customer(s)`;

  if (decisionEligible) {
    return `${promotionText} decisionEligible is true: run completed safely with ${details}.`;
  }
  return `${promotionText} decisionEligible is false because ${details} were recorded during ingestion.`;
}

let loadInProgress = false;

function assertAdministrator(user) {
  if (!user || user._is_anonymous || user._is_privileged || !user.id || !user.is?.('CreditAdmin')) {
    const error = new Error('Role CreditAdmin is required for ingestion operations.');
    error.statusCode = 403;
    error.category = 'permission_denied';
    throw error;
  }
}

function summarizeIssues(issueRows = []) {
  const byCode = {};
  let errors = 0;
  let warnings = 0;
  for (const issue of issueRows) {
    if (issue.severity === 'ERROR') errors += 1;
    else if (issue.severity === 'WARNING') warnings += 1;
    if (issue.code) {
      byCode[issue.code] = (byCode[issue.code] || 0) + 1;
    }
  }
  return {
    total: issueRows.length,
    errors,
    warnings,
    byCode
  };
}

function buildPublicLoadResult({
  source,
  run,
  issueRows,
  duplicate = false,
  asOfDate,
  monitoringRun = null,
  monitoringError = null
}) {
  let parsedRowCounts = null;
  try {
    parsedRowCounts = run.rowCounts ? JSON.parse(run.rowCounts) : null;
  } catch {
    parsedRowCounts = null;
  }
  const projection = parsedRowCounts?.mockSapGeneratedProjection || {};
  const quarantinedCustomers = Array.isArray(projection.quarantinedCustomers)
    ? projection.quarantinedCustomers
    : [];
  const qualityIssueCounts = summarizeIssues(issueRows);
  const issuesTruncated = issueRows.length > 500;
  const projectedCustomers = projection.CUSTOMER?.sourceRecords ?? 0;
  const snapshotPromoted = run.snapshotPromoted === true;
  const decisionEligible = run.decisionEligible === true;
  const decisionEligibleExplanation = buildDecisionEligibleExplanation({
    snapshotPromoted,
    projectedCustomers,
    quarantinedCustomerCount: quarantinedCustomers.length,
    qualityIssueCounts,
    decisionEligible
  });

  return {
    label: SYNTHETIC_LABEL,
    id: run.ID,
    sourceId: run.sourceId,
    sourceName: source.sourceName,
    status: run.status,
    asOfDate,
    seed: FIXED_SEED,
    generatedCustomers: FIXED_CUSTOMERS,
    snapshotPromoted,
    decisionEligible,
    decisionEligibleExplanation,
    counts: {
      projectedCustomers,
      customersInserted: projection.CUSTOMER?.inserted ?? 0,
      customersUpdated: projection.CUSTOMER?.alreadyPresent ?? 0,
      openItems: {
        total: projection.OPEN_ITEMS?.inserted ?? 0,
        invoices: projection.INVOICE?.inserted ?? 0,
        salesOrders: projection.SALES_ORDER?.inserted ?? 0
      },
      payments: projection.PAYMENT?.inserted ?? 0,
      paymentHistory: projection.CG_PAYMENT_HISTORY?.inserted ?? 0
    },
    quarantinedCustomers,
    quarantinedCustomerCount: quarantinedCustomers.length,
    qualityIssueCounts,
    monitoringRunId: monitoringRun ? monitoringRun.id : null,
    monitoringError: monitoringError || null,
    monitoring: {
      runId: monitoringRun ? monitoringRun.id : null,
      status: monitoringRun ? monitoringRun.status : (monitoringError ? 'FAILED' : null),
      error: monitoringError || null
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    retrievedAt: run.retrievedAt || null,
    sourceTimestamp: run.sourceTimestamp || null,
    rowCounts: parsedRowCounts,
    errorCategory: run.errorCategory || null,
    duplicate: Boolean(duplicate),
    issues: issueRows.slice(0, 500).map(issue => ({
      id: issue.ID,
      code: issue.code,
      severity: issue.severity,
      entityType: issue.entityType,
      sourceRecordId: issue.sourceRecordId,
      field: issue.field,
      message: issue.message,
      createdAt: issue.createdAt
    })),
    issuesTruncated
  };
}

async function loadGeneratedSapPortfolio({ db, user, runMonitoring = true } = {}) {
  if (!isSapSimEnabled()) {
    const error = new Error('MOCK_SAP_GENERATED source is disabled in production environments by default.');
    error.statusCode = 403;
    error.category = 'mock_sap_generated_disabled';
    throw error;
  }

  assertAdministrator(user);

  if (!db) {
    const error = new Error('A CAP database connection is required for Mock SAP Generated load.');
    error.statusCode = 500;
    throw error;
  }

  if (loadInProgress) {
    const error = new Error('Mock SAP Generated data load is already in progress.');
    error.statusCode = 409;
    error.category = 'load_already_running';
    throw error;
  }

  // Lazy require of scripts/generate-sap-sim-data.js after gate and auth checks
  let generator;
  const generatorScriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'generate-sap-sim-data.js');
  try {
    generator = require(generatorScriptPath);
  } catch (cause) {
    const error = new Error('Synthetic SAP data generator script (scripts/generate-sap-sim-data.js) is unavailable.');
    error.statusCode = 503;
    error.category = 'generator_script_unavailable';
    error.cause = cause;
    throw error;
  }

  loadInProgress = true;
  const sapSimRoot = path.resolve(__dirname, '..', '..', '..', 'db', 'sap-sim');
  const stageDir = path.join(sapSimRoot, `.stage-${randomUUID()}`);
  const targetDir = path.join(sapSimRoot, 'data');

  try {
    const simClockDate = defaultSimClock();
    const asOfDate = simClockDate.toISOString().slice(0, 10);

    // 1. Generate into db/sap-sim/.stage-<random> with FIXED arguments only
    const dataset = generator.generateDataset({
      seed: FIXED_SEED,
      customers: FIXED_CUSTOMERS,
      today: asOfDate
    });
    generator.writeDataset({
      out: stageDir,
      expectedOut: path.join(stageDir, 'expected-results.json')
    }, dataset);

    // 2. Move the 6 CSV tables atomically into db/sap-sim/data
    await fs.promises.mkdir(targetDir, { recursive: true });
    for (const csvFile of EXPECTED_CSV_FILES) {
      const stagedFile = path.join(stageDir, csvFile);
      const targetFile = path.join(targetDir, csvFile);
      await fs.promises.rename(stagedFile, targetFile);
    }
    await fs.promises.rm(stageDir, { recursive: true, force: true });

    // 3. Run existing MOCK-SAP-GEN-001 ingestion (projection happens once inside completeIngestionRun transaction)
    const source = await ensureMockSapGeneratedSource(db);
    const ingestionRuntime = createConfiguredIngestionRuntime({ db });
    const result = await ingestionRuntime.run({
      user,
      sourceId: source.sourceId,
      entityTypes: source.supportedEntities
    });
    const issueRows = await listIngestionIssues(db, result.run.ID);

    // 4. Optionally trigger one monitoring run through existing executeMonitoringRun path
    let monitoringRun = null;
    let monitoringError = null;
    if (runMonitoring) {
      try {
        const monitoringUser = user.is?.('CreditReader')
          ? user
          : new cds.User({ id: user.id, roles: ['CreditAdmin', 'CreditReader'] });
        monitoringRun = await executeMonitoringRun({
          db,
          user: monitoringUser,
          runKind: 'MANUAL',
          source: 'local'
        });
      } catch (monErr) {
        monitoringError = monErr?.message || 'Monitoring run could not be started.';
      }
    }

    return buildPublicLoadResult({
      source,
      run: result.run,
      issueRows,
      duplicate: result.duplicate,
      asOfDate,
      monitoringRun,
      monitoringError
    });
  } finally {
    try {
      if (fs.existsSync(stageDir)) {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    loadInProgress = false;
  }
}

module.exports = {
  buildDecisionEligibleExplanation,
  FIXED_CUSTOMERS,
  FIXED_SEED,
  SYNTHETIC_LABEL,
  loadGeneratedSapPortfolio
};
