require('dotenv').config();
const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
const multer = require('multer');
const { validateProductionBindings } = require('./deployment');
const creditService = require('./creditService');
const { createPortfolioDataProvider } = require('./portfolioDataProvider');
const { getConfiguredDataSource, isAbapReadOnlySource } = require('./dataSource');
const { validateActorId } = require('./limitRequests');
const { chat, toolDefinitions } = require('./agent');
const { DEFAULT_GEMINI_MODEL, testGeminiConnectivity } = require('./llm');
const { PLAN_VERSION, validatePlan } = require('./agentPlan');
const { extractDocument, MAX_EXTRACTED_CHARACTERS } = require('./documents');
const {
  executeMonitoringRun,
  publicFinding,
  publicRun,
  recoverMonitoringRun
} = require('./monitoringService');
const { startMonitoringWorker } = require('./monitoringWorker');
const {
  getAutonomousSchedulerInstance,
  startAutonomousScheduler
} = require('./autonomousScheduler');
const { ENTITY_TYPES, isValidTimestamp } = require('./canonicalData');
const { createConfiguredIngestionRuntime } = require('./ingestionRuntime');
const { getPublicDatabaseStatus } = require('./hanaConnection');
const { CANONICAL_SOURCE_TYPES, CANONICAL_TABLES, SAP_VERIFICATION_NOTE } = require('./canonicalSchemaMetadata');
const {
  getBusinessPartnerCreditDossier,
  getCanonicalPortfolioAnalytics,
  listBusinessPartners,
  listDataSources,
  listExposureSnapshots,
  listFieldMappings,
  recalculateAllExposureSnapshots,
  saveFieldMappings,
  seedCanonicalFromLegacyDemo
} = require('./canonicalRepository');
const {
  ensureDefaultEnterpriseSources,
  getConnectorForType,
  syncSourceToCanonical
} = require('./connectors/connectorRegistry');
const { SAP_ODATA_CANDIDATE_SERVICES } = require('./connectors/sapODataConnector');
const { HANA_REPLICATED_TABLES } = require('./connectors/sapHanaConnector');
const {
  decideCanonicalLimitRequest,
  listEnrichedCanonicalLimitRequests,
  previewCanonicalLimitChange,
  promoteDraftLimitRequest,
  submitCanonicalLimitRequest,
  syncApprovedLimitRequestToSap
} = require('./limitWorkflowService');
const {
  CANONICAL_AGENT_TOOLS,
  executeCanonicalAgentTool,
  runCanonicalAgentQuery
} = require('./canonicalAgentTools');
const {
  DEFAULT_AUTONOMOUS_CREDIT_POLICY,
  evaluateCustomerAutonomousDecision,
  evaluatePortfolioAutonomousActions,
  processPendingRequestsAutonomously
} = require('./autonomousDecisionEngine');
const mockSapFixture = require('./integrations/mock-sap/fixtures.json');
const { getMockSapSourceDefinition } = require('./integrations/mock-sap/connector');
const {
  ensureMockSapSource,
  getSource,
  listSources,
  registerSource,
  updateSource
} = require('./sourceRegistryStore');
const {
  getMonitoringAlert,
  getMonitoringRun,
  latestMonitoringRun,
  latestSuccessfulMonitoringRun,
  listMonitoringAlertEvents,
  listMonitoringAlerts,
  listMonitoringFindings,
  listMonitoringRuns,
  transitionMonitoringAlert
} = require('./monitoringStore');
const {
  getIngestionRun,
  getLatestIngestionRun,
  listIngestionIssues
} = require('./ingestionStore');
const {
  MEMORY_ENABLED,
  clearAgentHistory,
  clearConversations,
  claimExecutionRecovery,
  getOrCreateConversation,
  getExecution,
  getExecutionForRecovery,
  listConversations,
  listExecutions,
  loadConversationMessages,
  readConversation,
  recordExecution,
  saveConversationTurn
} = require('./agentStore');

validateProductionBindings({
  profiles: cds.env.profiles,
  env: process.env,
  dbKind: cds.env.requires.db?.kind,
  authKind: cds.env.requires.auth?.kind
});

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2 }
});

function parseDocumentUpload(req, res, next) {
  documentUpload.single('document')(req, res, error => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'The document exceeds the 10 MB upload limit.' : `Upload failed: ${error.message}`
    });
  });
}

function currentUser(req) {
  return req?.user || cds.context?.user;
}

function requireAuthenticatedUser(req, res, next) {
  const user = currentUser(req);
  if (!user || user._is_anonymous || user._is_privileged || !user.id) {
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Authentication is required.' });
    return;
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user?.is(role)) {
      res.status(403).json({ error: `The ${role} permission is required.` });
      return;
    }
    next();
  };
}

function requireAnyRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!roles.some(role => user?.is(role))) {
      res.status(403).json({ error: `One of these permissions is required: ${roles.join(', ')}.` });
      return;
    }
    next();
  };
}

function isMonitoringRunOwnerOrOperator(user, run) {
  return run.triggeredBy === user.id
    || run.runKind === 'SCHEDULED'
    || user.is('CreditMonitor')
    || user.is('CreditAdmin');
}

function validateScheduledFor(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new TypeError('scheduledFor must be a canonical ISO timestamp.');
  }
  const scheduledFor = new Date(value);
  if (scheduledFor.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new TypeError('scheduledFor cannot be more than five minutes in the future.');
  }
  return scheduledFor.toISOString();
}

function validateIngestionRunRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['entityTypes', 'idempotencyKey', 'since'].includes(key))) {
    throw new TypeError('Ingestion request contains unsupported fields.');
  }
  if (!Array.isArray(body.entityTypes) || body.entityTypes.length === 0
    || body.entityTypes.some(entity => !ENTITY_TYPES.includes(entity))
    || new Set(body.entityTypes).size !== body.entityTypes.length) {
    throw new TypeError('Ingestion entity scope is invalid.');
  }
  if (body.idempotencyKey !== undefined
    && (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()
      || body.idempotencyKey.length > 160 || /[\u0000-\u001f\u007f]/.test(body.idempotencyKey))) {
    throw new TypeError('Ingestion idempotency key is invalid.');
  }
  if (body.since !== undefined
    && !isValidTimestamp(body.since)) {
    throw new TypeError('Ingestion watermark is invalid.');
  }
  return {
    entityTypes: body.entityTypes,
    ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    ...(body.since !== undefined ? { since: body.since } : {})
  };
}

function queryInteger(value, label, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new TypeError(`${label} is outside the permitted range.`);
  }
  return parsed;
}

function publicIngestionRun(run, issues = [], duplicate = false, issuesTruncated = false) {
  let rowCounts = null;
  try { rowCounts = run.rowCounts ? JSON.parse(run.rowCounts) : null; }
  catch { rowCounts = null; }
  return {
    id: run.ID,
    sourceId: run.sourceId,
    status: run.status,
    decisionEligible: run.decisionEligible === true,
    snapshotPromoted: run.snapshotPromoted === true,
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    retrievedAt: run.retrievedAt || null,
    sourceTimestamp: run.sourceTimestamp || null,
    rowCounts,
    errorCategory: run.errorCategory || null,
    issues,
    issuesTruncated,
    duplicate
  };
}

cds.on('bootstrap', app => {
  app.get('/', (_req, res) => res.redirect('/credit/index.html'));
  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'live' }));
  app.get('/health/ready', (_req, res) => {
    if (!cds.db || typeof cds.db.run !== 'function') {
      return res.status(503).json({ status: 'not-ready' });
    }
    return res.status(200).json({ status: 'ready' });
  });
  if (process.env.CREDIT_GUARD_DEV_DEFAULT_USER) {
    const defaultAuthHeader = `Basic ${Buffer.from(`${process.env.CREDIT_GUARD_DEV_DEFAULT_USER}:test`).toString('base64')}`;
    app.use((req, res, next) => {
      if (!req.headers.authorization) {
        req.headers.authorization = defaultAuthHeader;
      }
      if (req.get('X-CSRF-Token')?.toLowerCase() === 'fetch') {
        res.set('X-CSRF-Token', 'dev-csrf-token');
      }
      next();
    });
  }
  app.use('/credit', cds.middlewares.before, express.static(path.join(__dirname, '..', 'app', 'credit')));
  app.use('/api', cds.middlewares.before);
  app.use('/api', express.json());
  app.use('/api', requireAuthenticatedUser);

  app.get('/api/mock-sap', requireRole('CreditReader'), async (_req, res) => {
    try {
      const definition = getMockSapSourceDefinition();
      const source = await getSource(cds.db, definition.sourceId);
      const latestRun = source ? await getLatestIngestionRun(cds.db, source.sourceId) : null;
      const issueRows = latestRun ? await listIngestionIssues(cds.db, latestRun.ID) : [];
      return res.json({
        label: 'SYNTHETIC MOCK SAP DATA — NOT A LIVE SAP CONNECTION',
        registered: Boolean(source),
        portfolioSource: getConfiguredDataSource(),
        source: source || definition,
        entities: mockSapFixture.entities,
        latestRun: latestRun
          ? publicIngestionRun(latestRun, issueRows.slice(0, 500), false, issueRows.length > 500)
          : null
      });
    } catch (error) {
      return res.status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Mock SAP simulator data is unavailable.' });
    }
  });

  app.post('/api/mock-sap/extract', requireRole('CreditAdmin'), async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length) {
        return res.status(400).json({ error: 'Mock SAP extraction does not accept request options.' });
      }
      const source = await ensureMockSapSource(cds.db);
      const ingestionRuntime = createConfiguredIngestionRuntime({ db: cds.db });
      const result = await ingestionRuntime.run({
        user: currentUser(req),
        sourceId: source.sourceId,
        entityTypes: source.supportedEntities
      });
      const issueRows = await listIngestionIssues(cds.db, result.run.ID);
      return res.status(200).json({
        sourceName: source.sourceName,
        ...publicIngestionRun(
          result.run,
          issueRows.slice(0, 500),
          result.duplicate,
          issueRows.length > 500
        )
      });
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      return res.status(status).json({
        error: status < 500 ? error.message : 'Mock SAP extraction could not be completed safely.',
        ...(error.runId ? { runId: error.runId, errorCategory: error.category } : {})
      });
    }
  });

  app.post('/api/mock-sap/monitoring', requireAnyRole('CreditMonitor', 'CreditAdmin'), async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length) {
        return res.status(400).json({ error: 'Mock SAP monitoring does not accept request options.' });
      }
      const sourceId = getMockSapSourceDefinition().sourceId;
      const latestRun = await getLatestIngestionRun(cds.db, sourceId);
      if (!latestRun?.snapshotPromoted) {
        return res.status(409).json({ error: 'Complete Mock SAP data extraction is required before monitoring.' });
      }
      const run = await executeMonitoringRun({
        db: cds.db,
        user: currentUser(req),
        runKind: 'MANUAL',
        source: 'local'
      });
      return res.status(202).json(run);
    } catch (error) {
      return res.status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Mock SAP monitoring could not be started.' });
    }
  });

  app.get('/api/session', (req, res) => {
    const user = currentUser(req);
    const hasAnyRole = (...roles) => roles.some(role => user.is(role));
    const readOnlySapSource = isAbapReadOnlySource();
    return res.json({
      userId: user.id,
      creditLimitWorkflow: readOnlySapSource ? 'READ_ONLY' : 'LOCAL_DEMO',
      permissions: {
        canExtract: hasAnyRole('CreditAdmin'),
        canRequest: !readOnlySapSource && hasAnyRole('CreditRequester', 'CreditAnalyst', 'CreditManager', 'CreditAdmin'),
        canApproveController: !readOnlySapSource && hasAnyRole(
          'CreditController', 'CreditManager', 'FinanceHead', 'CreditApprover', 'CreditAdmin'
        ),
        canApproveFinance: !readOnlySapSource && hasAnyRole('FinanceHead', 'CreditApprover', 'CreditAdmin'),
        canMonitor: hasAnyRole('CreditMonitor', 'CreditAdmin')
      }
    });
  });

  app.get('/api/canonical/status', requireRole('CreditReader'), async (_req, res) => {
    try {
      let partners = await listBusinessPartners(cds.db);
      if (!partners.length) {
        await seedCanonicalFromLegacyDemo(cds.db);
        partners = await listBusinessPartners(cds.db);
      }
      const [sources, mappings, snapshots] = await Promise.all([
        listDataSources(cds.db),
        listFieldMappings(cds.db),
        listExposureSnapshots(cds.db)
      ]);
      return res.json({
        database: getPublicDatabaseStatus(process.env),
        sapVerificationDefault: false,
        sapVerificationNote: SAP_VERIFICATION_NOTE,
        tables: CANONICAL_TABLES,
        counts: {
          dataSources: sources.length,
          fieldMappings: mappings.length,
          businessPartners: partners.length,
          exposureSnapshots: snapshots.length
        },
        sources,
        snapshots
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Canonical schema status could not be loaded.' });
    }
  });

  app.get('/api/v2/connectors', requireRole('CreditReader'), async (_req, res) => {
    try {
      const sources = await ensureDefaultEnterpriseSources(cds.db);
      const mappings = await listFieldMappings(cds.db);
      return res.json({
        supportedConnectorTypes: CANONICAL_SOURCE_TYPES,
        sapVerificationNote: SAP_VERIFICATION_NOTE,
        sapCandidateODataServices: SAP_ODATA_CANDIDATE_SERVICES,
        hanaReplicatedTables: HANA_REPLICATED_TABLES,
        sources,
        mappingsCount: mappings.length
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Connector catalog could not be loaded.' });
    }
  });

  app.post('/api/v2/connectors/test', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sources = await ensureDefaultEnterpriseSources(cds.db);
      const matchedSource = body.sourceId
        ? sources.find(s => s.source_id === body.sourceId)
        : null;
      const sourceType = body.sourceType || matchedSource?.source_type || 'MOCK_SAP';
      const connector = getConnectorForType(sourceType);
      const health = await connector.testConnection({
        ...(matchedSource || {}),
        ...body
      });
      return res.json(health);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Connector health test failed.'
      });
    }
  });

  app.post('/api/v2/connectors/discover', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sources = await ensureDefaultEnterpriseSources(cds.db);
      const matchedSource = body.sourceId
        ? sources.find(s => s.source_id === body.sourceId)
        : null;
      const sourceType = body.sourceType || matchedSource?.source_type || (body.rawContent || body.records ? 'FILE' : 'MOCK_SAP');
      const connector = getConnectorForType(sourceType);
      const discovery = await connector.discoverSchema(
        {
          ...(matchedSource || {}),
          source_id: body.sourceId || matchedSource?.source_id || `SRC-${sourceType}`,
          filename: body.filename,
          rawContent: body.rawContent,
          records: body.records,
          format: body.format
        },
        {
          sourceEntity: body.sourceEntity,
          targetCanonicalEntity: body.targetCanonicalEntity
        }
      );
      return res.json(discovery);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Schema auto-discovery failed.'
      });
    }
  });

  app.post('/api/v2/connectors/mappings/confirm', requireAnyRole('CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sourceId = String(body.sourceId || '').trim();
      if (!sourceId) {
        return res.status(400).json({ error: 'sourceId is required to confirm field mappings.' });
      }
      if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
        return res.status(400).json({ error: 'mappings array is required.' });
      }
      const confirmed = body.mappings.map(m => ({
        ...m,
        source_id: sourceId,
        verified_by_user: true,
        sap_reference_verified: Boolean(m.sap_reference_verified === true),
        verification_note: m.verification_note || SAP_VERIFICATION_NOTE
      }));
      const saved = await saveFieldMappings(cds.db, sourceId, confirmed);
      return res.json({
        sourceId,
        confirmedCount: saved.length,
        mappings: saved
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Field mappings could not be confirmed.'
      });
    }
  });

  app.post('/api/v2/connectors/sync', requireAnyRole('CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await syncSourceToCanonical(cds.db, {
        sourceId: body.sourceId || 'MOCK-SAP-FIN-FSCM',
        sourceType: body.sourceType || null,
        sourceEntity: body.sourceEntity || 'BUT000',
        targetCanonicalEntity: body.targetCanonicalEntity || null,
        fileConfig: body.rawContent || body.records
          ? {
              filename: body.filename || 'upload.csv',
              rawContent: body.rawContent,
              records: body.records,
              format: body.format
            }
          : null,
        customMappings: Array.isArray(body.mappings) ? body.mappings : null
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Canonical connector sync failed.'
      });
    }
  });

  app.get('/api/v2/exposure/portfolio', requireRole('CreditReader'), async (req, res) => {
    try {
      const analytics = await getCanonicalPortfolioAnalytics(cds.db, {
        countryCode: req.query.countryCode || null,
        companyCode: req.query.companyCode || null,
        creditSegment: req.query.creditSegment || null,
        thresholdStatus: req.query.thresholdStatus || null,
        riskClass: req.query.riskClass || null,
        referenceDate: req.query.referenceDate || '2026-11-09'
      });
      return res.json(analytics);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Deterministic portfolio exposure analytics could not be calculated.'
      });
    }
  });

  app.get('/api/v2/exposure/partners/:bpId', requireRole('CreditReader'), async (req, res) => {
    try {
      const dossier = await getBusinessPartnerCreditDossier(cds.db, req.params.bpId, {
        referenceDate: req.query.referenceDate || '2026-11-09'
      });
      return res.json(dossier);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Business Partner credit dossier could not be calculated.'
      });
    }
  });

  app.post('/api/v2/exposure/recalculate', requireAnyRole('CreditMonitor', 'CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const referenceDate = body.referenceDate || '2026-11-09';
      await recalculateAllExposureSnapshots(cds.db, { referenceDate });
      const analytics = await getCanonicalPortfolioAnalytics(cds.db, { referenceDate });
      return res.json({
        recalculated: true,
        referenceDate,
        ...analytics
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Exposure recalculation failed.'
      });
    }
  });

  app.get('/api/v2/monitoring/heartbeat', (_req, res) => {
    const scheduler = getAutonomousSchedulerInstance();
    return res.status(200).json({
      status: 'live',
      timestamp: new Date().toISOString(),
      scheduler: scheduler ? scheduler.getStatus() : { status: 'STANDBY' }
    });
  });

  app.get('/api/v2/monitoring/scheduler-status', requireRole('CreditReader'), (_req, res) => {
    const scheduler = getAutonomousSchedulerInstance();
    if (!scheduler) {
      return res.status(200).json({
        status: 'STANDBY',
        message: 'Autonomous monitoring scheduler is not currently active.'
      });
    }
    return res.status(200).json(scheduler.getStatus());
  });

  app.post('/api/v2/monitoring/scheduler-trigger', requireAnyRole('CreditReader', 'CreditMonitor', 'CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const scheduler = getAutonomousSchedulerInstance();
      if (!scheduler) {
        return res.status(503).json({ error: 'Autonomous monitoring scheduler is not active.' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const outcome = await scheduler.executeCycle({
        force: body.force !== false,
        referenceDate: body.referenceDate || '2026-11-09',
        triggeredBy: req.user?.id || 'manual-trigger'
      });
      return res.status(200).json(outcome);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Autonomous cycle execution failed.' });
    }
  });

  app.get('/api/v2/workflow/limit-requests', requireRole('CreditReader'), async (req, res) => {
    try {
      const rows = await listEnrichedCanonicalLimitRequests(cds.db, {
        status: req.query.status || null,
        bpId: req.query.bpId || null
      });
      return res.json(rows);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Canonical limit requests could not be loaded.'
      });
    }
  });

  app.post('/api/v2/workflow/limit-requests/preview', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const preview = await previewCanonicalLimitChange(cds.db, {
        bpId: body.bpId || body.customerId,
        creditSegment: body.creditSegment || 'MAIN',
        requestedLimit: body.requestedLimit,
        referenceDate: body.referenceDate || '2026-11-09'
      });
      return res.json(preview);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Credit limit impact preview failed.'
      });
    }
  });

  app.post('/api/v2/workflow/limit-requests', requireAnyRole('CreditRequester', 'CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const created = await submitCanonicalLimitRequest(cds.db, {
        bpId: body.bpId || body.customerId,
        creditSegment: body.creditSegment || 'MAIN',
        requestedLimit: body.requestedLimit,
        justification: body.justification || body.reason,
        aiRiskSummary: body.aiRiskSummary || null,
        status: body.status || 'PENDING_APPROVAL',
        requestedBy: currentUser(req).id
      });
      return res.status(201).json(created);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Canonical credit limit request could not be created.'
      });
    }
  });

  app.post('/api/v2/workflow/limit-requests/:requestId/submit', requireAnyRole('CreditRequester', 'CreditAnalyst', 'CreditManager', 'CreditAdmin'), async (req, res) => {
    try {
      const promoted = await promoteDraftLimitRequest(cds.db, req.params.requestId, currentUser(req).id);
      return res.json(promoted);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Draft credit limit request could not be submitted.'
      });
    }
  });

  app.post('/api/v2/workflow/limit-requests/:requestId/decision', requireAnyRole('CreditController', 'CreditManager', 'FinanceHead', 'CreditApprover', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const decided = await decideCanonicalLimitRequest(cds.db, req.params.requestId, {
        decision: body.decision,
        reason: body.reason,
        approverId: currentUser(req).id,
        autoSyncToSap: Boolean(body.autoSyncToSap === true)
      });
      return res.json(decided);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Credit limit request decision failed.'
      });
    }
  });

  app.post('/api/v2/workflow/limit-requests/:requestId/sync-sap', requireAnyRole('CreditController', 'CreditManager', 'FinanceHead', 'CreditApprover', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const synced = await syncApprovedLimitRequestToSap(cds.db, req.params.requestId, {
        connectorType: body.connectorType || 'MOCK_SAP'
      });
      return res.json(synced);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'SAP credit limit synchronization failed.'
      });
    }
  });

  app.get('/api/v2/autonomous/policy', requireRole('CreditReader'), (_req, res) => {
    return res.json({
      policy: DEFAULT_AUTONOMOUS_CREDIT_POLICY,
      sapVerificationDefault: false,
      sapVerificationNote: SAP_VERIFICATION_NOTE
    });
  });

  app.post('/api/v2/autonomous/evaluate-customer', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const evaluation = await evaluateCustomerAutonomousDecision(cds.db, body.bpId || body.customerId, {
        requestedLimit: body.requestedLimit,
        policy: body.policy,
        referenceDate: body.referenceDate || '2026-11-09'
      });
      return res.json(evaluation);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Autonomous customer credit evaluation failed.'
      });
    }
  });

  app.post('/api/v2/autonomous/process-pending', requireAnyRole('CreditReader', 'CreditRequester', 'CreditController', 'CreditManager', 'FinanceHead', 'CreditApprover', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await processPendingRequestsAutonomously(cds.db, {
        policy: body.policy,
        referenceDate: body.referenceDate || '2026-11-09',
        autoSyncToSap: body.autoSyncToSap !== false
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Autonomous processing of pending requests failed.'
      });
    }
  });

  app.post('/api/v2/autonomous/scan-portfolio', requireAnyRole('CreditReader', 'CreditRequester', 'CreditController', 'CreditManager', 'FinanceHead', 'CreditApprover', 'CreditAdmin'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await evaluatePortfolioAutonomousActions(cds.db, {
        policy: body.policy,
        referenceDate: body.referenceDate || '2026-11-09',
        autoCreateAndExecute: Boolean(body.autoCreateAndExecute)
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Autonomous portfolio scan failed.'
      });
    }
  });

  app.get('/api/v2/agent/tools', requireRole('CreditReader'), (_req, res) => {
    return res.json({
      tools: CANONICAL_AGENT_TOOLS,
      sapVerificationDefault: false,
      sapVerificationNote: SAP_VERIFICATION_NOTE
    });
  });

  app.post('/api/v2/agent/tool-execute', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const toolName = String(body.toolName || '').trim();
      if (!toolName) {
        return res.status(400).json({ error: 'toolName is required.' });
      }
      const result = await executeCanonicalAgentTool(cds.db, toolName, body.args || {});
      return res.json({
        toolName,
        sapVerificationDefault: false,
        sapVerificationNote: SAP_VERIFICATION_NOTE,
        result
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Canonical agent tool execution failed.'
      });
    }
  });

  app.post('/api/v2/agent/query', requireRole('CreditReader'), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const response = await runCanonicalAgentQuery(cds.db, {
        question: body.question || body.message || '',
        bpId: body.bpId || body.customerId || null,
        requestedLimit: body.requestedLimit || null
      });
      return res.json(response);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Canonical AI Credit Agent query could not be completed.'
      });
    }
  });

  app.get('/api/ingestion/sources', requireRole('CreditAdmin'), async (_req, res) => {
    try {
      return res.json(await listSources(cds.db));
    } catch {
      return res.status(500).json({ error: 'Source registry is unavailable.' });
    }
  });

  app.post('/api/ingestion/sources', requireRole('CreditAdmin'), async (req, res) => {
    try {
      const source = await registerSource(cds.db, req.body);
      return res.status(201).json(source);
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      return res.status(status).json({
        error: status < 500 ? error.message : 'Source registration could not be completed.'
      });
    }
  });

  app.put('/api/ingestion/sources/:sourceId', requireRole('CreditAdmin'), async (req, res) => {
    try {
      const sourceId = req.params.sourceId;
      const current = await getSource(cds.db, sourceId);
      if (!current) return res.status(404).json({ error: 'Source was not found.' });
      const source = await updateSource(cds.db, sourceId, req.body);
      return res.json(source);
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      return res.status(status).json({
        error: status < 500 ? error.message : 'Source update could not be completed.'
      });
    }
  });

  app.get('/api/ingestion/sources/:sourceId/status', requireRole('CreditReader'), async (req, res) => {
    try {
      const source = await getSource(cds.db, req.params.sourceId);
      if (!source) return res.status(404).json({ error: 'Source was not found.' });
      const provider = createPortfolioDataProvider({ db: cds.db, user: currentUser(req) });
      const entities = await Promise.all(source.supportedEntities.map(async entityType => ({
        entityType,
        ...(await provider.getIngestionSnapshot(source.sourceId, entityType, { includeRecords: false }))
      })));
      return res.json({
        sourceId: source.sourceId,
        enabled: source.enabled,
        entities
      });
    } catch (error) {
      return res.status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Ingestion status is unavailable.' });
    }
  });

  app.get('/api/ingestion/sources/:sourceId/snapshots/:entityType', requireRole('CreditReader'), async (req, res) => {
    try {
      const limit = queryInteger(req.query.limit, 'Snapshot limit', 1000, 1000);
      if (limit === 0) throw new TypeError('Snapshot limit must be positive.');
      const offset = queryInteger(req.query.offset, 'Snapshot offset', 0, 1000000000);
      const source = await getSource(cds.db, req.params.sourceId);
      if (!source) return res.status(404).json({ error: 'Source was not found.' });
      if (!ENTITY_TYPES.includes(req.params.entityType)
        || !source.supportedEntities.includes(req.params.entityType)) {
        return res.status(400).json({ error: 'Canonical entity is not supported by this source.' });
      }
      const provider = createPortfolioDataProvider({ db: cds.db, user: currentUser(req) });
      const snapshot = await provider.getIngestionSnapshot(source.sourceId, req.params.entityType, {
        limit,
        offset
      });
      return snapshot ? res.json(snapshot) : res.status(404).json({ error: 'No ingestion run is available.' });
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      return res.status(status).json({
        error: status < 500 ? error.message : 'Canonical snapshot is unavailable.'
      });
    }
  });

  app.get('/api/ingestion/runs/:runId', requireRole('CreditReader'), async (req, res) => {
    try {
      const run = await getIngestionRun(cds.db, req.params.runId);
      if (!run) return res.status(404).json({ error: 'Ingestion run was not found.' });
      const issueRows = await listIngestionIssues(cds.db, run.ID);
      return res.json(publicIngestionRun(
        run,
        issueRows.slice(0, 500),
        false,
        issueRows.length > 500
      ));
    } catch {
      return res.status(500).json({ error: 'Ingestion run details are unavailable.' });
    }
  });

  app.post('/api/ingestion/sources/:sourceId/runs', requireRole('CreditAdmin'), async (req, res) => {
    try {
      const request = validateIngestionRunRequest(req.body);
      const ingestionRuntime = createConfiguredIngestionRuntime({ db: cds.db });
      const result = await ingestionRuntime.run({
        user: currentUser(req),
        sourceId: req.params.sourceId,
        ...request
      });
      const issueRows = await listIngestionIssues(cds.db, result.run.ID);
      return res.status(200)
        .json(publicIngestionRun(
          result.run,
          issueRows.slice(0, 500),
          result.duplicate,
          issueRows.length > 500
        ));
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      return res.status(status).json({
        error: status < 500 ? error.message : 'Ingestion could not be completed safely.',
        ...(error.runId ? { runId: error.runId, errorCategory: error.category } : {})
      });
    }
  });

  app.get('/api/dashboard', requireRole('CreditReader'), async (_req, res) => {
    try {
      const provider = createPortfolioDataProvider({ db: cds.db, user: currentUser(_req) });
      const customers = await provider.listCustomers();
      res.json({
        kpis: creditService.aggregatePortfolio(customers),
        exposure: {
          country: creditService.aggregateExposure(customers, 'country'),
          companyCode: creditService.aggregateExposure(customers, 'companyCode'),
          customer: creditService.aggregateExposure(customers, 'name')
        }
      });
    } catch (error) {
      res.status(error.statusCode || (error instanceof TypeError ? 422 : 500))
        .json({ error: error.statusCode ? error.message : 'The credit portfolio is unavailable.' });
    }
  });

  app.post('/api/monitoring/runs', requireAnyRole('CreditMonitor', 'CreditAdmin'), async (req, res) => {
    try {
      const run = await executeMonitoringRun({ db: cds.db, user: currentUser(req), runKind: 'MANUAL' });
      return res.status(202).json(run);
    } catch (error) {
      return res.status(error.statusCode || (error instanceof TypeError ? 400 : 500))
        .json({ error: error.statusCode ? error.message : 'Monitoring could not be started safely.' });
    }
  });

  app.post('/api/monitoring/jobs/run', requireRole('CreditMonitorJob'), async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => key !== 'scheduledFor')
        || !Object.hasOwn(req.body, 'scheduledFor')) {
        return res.status(400).json({ error: 'Provide only the scheduledFor timestamp.' });
      }
      const scheduledFor = validateScheduledFor(req.body.scheduledFor);
      const run = await executeMonitoringRun({
        db: cds.db,
        user: currentUser(req),
        runKind: 'SCHEDULED',
        slotKey: `scheduled:${scheduledFor}`
      });
      return res.status(202).json(run);
    } catch (error) {
      return res.status(error.statusCode || (error instanceof TypeError ? 400 : 500))
        .json({ error: error.statusCode ? error.message : 'Scheduled monitoring could not be started safely.' });
    }
  });

  app.get('/api/monitoring/summary', requireRole('CreditReader'), async (_req, res) => {
    try {
      const [run, alerts] = await Promise.all([
        latestMonitoringRun(cds.db),
        listMonitoringAlerts(cds.db, 'ACTIVE')
      ]);
      const findings = run ? await listMonitoringFindings(cds.db, run.ID) : [];
      const lastSuccessful = await latestSuccessfulMonitoringRun(cds.db);
      return res.json({
        latestRun: run ? publicRun(run, findings.map(publicFinding)) : null,
        lastSuccessfulAt: lastSuccessful?.completedAt || null,
        canOperate: Boolean(currentUser(_req)?.is('CreditMonitor') || currentUser(_req)?.is('CreditAdmin')),
        activeAlertCount: alerts.length,
        alertsBySeverity: Object.fromEntries(
          ['CRITICAL', 'HIGH', 'MEDIUM', 'REVIEW', 'LOW'].map(severity => [
            severity,
            alerts.filter(alert => alert.severity === severity).length
          ])
        )
      });
    } catch {
      return res.status(500).json({ error: 'Monitoring summary is unavailable.' });
    }
  });

  app.get('/api/monitoring/runs', requireRole('CreditReader'), async (req, res) => {
    try {
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      const runs = await listMonitoringRuns(cds.db, limit);
      return res.json(runs.map(run => publicRun(run)));
    } catch (error) {
      return res.status(error instanceof TypeError ? 400 : 500)
        .json({ error: error instanceof TypeError ? error.message : 'Monitoring history is unavailable.' });
    }
  });

  app.get('/api/monitoring/runs/latest', requireRole('CreditReader'), async (_req, res) => {
    try {
      const run = await latestMonitoringRun(cds.db);
      if (!run) return res.status(404).json({ error: 'No monitoring run is available.' });
      return res.json(publicRun(run));
    } catch {
      return res.status(500).json({ error: 'The latest monitoring run is unavailable.' });
    }
  });

  app.get('/api/monitoring/runs/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const run = await getMonitoringRun(cds.db, req.params.id);
      if (!run) return res.status(404).json({ error: 'Monitoring run was not found.' });
      const findings = await listMonitoringFindings(cds.db, run.ID);
      return res.json(publicRun(run, findings.map(publicFinding)));
    } catch {
      return res.status(500).json({ error: 'Monitoring run details are unavailable.' });
    }
  });

  app.get('/api/monitoring/runs/:id/findings', requireRole('CreditReader'), async (req, res) => {
    try {
      const run = await getMonitoringRun(cds.db, req.params.id);
      if (!run) return res.status(404).json({ error: 'Monitoring run was not found.' });
      return res.json((await listMonitoringFindings(cds.db, run.ID)).map(publicFinding));
    } catch {
      return res.status(500).json({ error: 'Monitoring findings are unavailable.' });
    }
  });

  app.post('/api/monitoring/runs/:id/recover', requireAnyRole('CreditMonitor', 'CreditAdmin'), async (req, res) => {
    try {
      const run = await getMonitoringRun(cds.db, req.params.id);
      if (!run) return res.status(404).json({ error: 'Monitoring run was not found.' });
      if (!isMonitoringRunOwnerOrOperator(currentUser(req), run)) {
        return res.status(403).json({ error: 'You are not authorized to recover this monitoring run.' });
      }
      const recovered = await recoverMonitoringRun({
        db: cds.db,
        user: currentUser(req),
        runId: run.ID
      });
      return res.status(202).json(recovered);
    } catch (error) {
      return res.status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Monitoring recovery could not be completed safely.' });
    }
  });

  app.get('/api/monitoring/alerts', requireRole('CreditReader'), async (req, res) => {
    try {
      return res.json(await listMonitoringAlerts(cds.db, req.query.status || 'ACTIVE'));
    } catch (error) {
      return res.status(error instanceof TypeError ? 400 : 500)
        .json({ error: error instanceof TypeError ? error.message : 'Monitoring alerts are unavailable.' });
    }
  });

  app.get('/api/monitoring/alerts/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const alert = await getMonitoringAlert(cds.db, req.params.id);
      if (!alert) return res.status(404).json({ error: 'Monitoring alert was not found.' });
      const events = await listMonitoringAlertEvents(cds.db, alert.ID);
      return res.json({ ...alert, events });
    } catch {
      return res.status(500).json({ error: 'Monitoring alert details are unavailable.' });
    }
  });

  for (const action of ['acknowledge', 'resolve']) {
    app.post(
      `/api/monitoring/alerts/:id/${action}`,
      requireAnyRole('CreditMonitor', 'CreditAdmin'),
      async (req, res) => {
        try {
          if (req.body && Object.keys(req.body).length) {
            return res.status(400).json({ error: 'This alert action does not accept a request body.' });
          }
          const alert = await transitionMonitoringAlert(cds.db, {
            alertId: req.params.id,
            action: action === 'acknowledge' ? 'ACKNOWLEDGED' : 'RESOLVED',
            actorId: validateActorId(currentUser(req).id)
          });
          return res.json(alert);
        } catch (error) {
          return res.status(error.statusCode || (error instanceof TypeError ? 400 : 500))
            .json({ error: error.statusCode ? error.message : 'The alert could not be updated safely.' });
        }
      }
    );
  }

  app.get('/api/customers', requireRole('CreditReader'), async (_req, res) => {
    try {
      const provider = createPortfolioDataProvider({ db: cds.db, user: currentUser(_req) });
      res.json(await provider.listCustomers());
    }
    catch (error) {
      res.status(error.statusCode || (error instanceof TypeError ? 422 : 500))
        .json({ error: error.statusCode ? error.message : 'Customer summaries are unavailable.' });
    }
  });

  app.get('/api/customers/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const provider = createPortfolioDataProvider({ db: cds.db, user: currentUser(req) });
      const customer = await provider.getCustomer(req.params.id);
      if (!customer) return res.status(404).json({ error: `Customer ${req.params.id} was not found.` });
      return res.json(customer);
    } catch (error) {
      return res.status(error.statusCode || (error instanceof TypeError ? 422 : 500))
        .json({ error: error.statusCode ? error.message : 'Customer details are unavailable.' });
    }
  });

  app.get('/api/customers/:id/payments', requireRole('CreditReader'), async (req, res) => {
    try {
      if (getConfiguredDataSource() !== 'local') {
        return res.status(503).json({ error: 'Payment history is unavailable for the configured customer source.' });
      }
      const payments = await creditService.getCustomerPayments(cds.db, currentUser(req), req.params.id);
      if (!payments) return res.status(404).json({ error: `Customer ${req.params.id} was not found.` });
      return res.json(payments);
    } catch (error) {
      return res.status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Customer payment history is unavailable.' });
    }
  });

  app.get('/api/limit-requests', requireRole('CreditReader'), async (req, res) => {
    try {
      const requests = await creditService.listLimitRequests(cds.db, currentUser(req), req.query.status);
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/limit-requests', requireRole('CreditRequester'), async (req, res) => {
    try {
      const result = await creditService.createLimitRequest(
        cds.db,
        currentUser(req),
        req.body,
        req.get('Idempotency-Key')
      );
      if (result.duplicate) res.set('Idempotency-Replayed', 'true');
      return res.status(201).json(result.request);
    } catch (error) {
      return res.status(error.statusCode || (error instanceof TypeError ? 400 : 500)).json({ error: error.message });
    }
  });

  app.post('/api/limit-requests/:id/decision', async (req, res) => {
    try {
      const result = await creditService.decideLimitRequest(cds.db, currentUser(req), req.params.id, req.body);
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/limit-requests/:id/history', requireRole('CreditReader'), async (req, res) => {
    try {
      const history = await creditService.getApprovalHistory(cds.db, currentUser(req), req.params.id);
      return res.json(history);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/gemini/connectivity', requireRole('CreditReader'), async (_req, res) => {
    const model = process.env.LLM_MODEL || DEFAULT_GEMINI_MODEL;
    try {
      const result = await testGeminiConnectivity({
        apiKey: process.env.GEMINI_API_KEY,
        model,
        timeoutMs: process.env.LLM_TIMEOUT_MS
      });
      if (result.ok) {
        return res.json({
          ok: true,
          provider: 'gemini',
          model,
          diagnostic: 'Authenticated Gemini connectivity check succeeded.'
        });
      }

      const diagnosticByCategory = {
        provider_not_configured: 'GEMINI_API_KEY is not configured.',
        provider_authentication: 'Gemini rejected the configured API key.',
        rate_limited: 'Gemini rate limit was reached.',
        provider_unavailable: 'Gemini is temporarily unavailable.',
        provider_timeout: 'Gemini connectivity check timed out.',
        provider_response_invalid: 'Gemini returned an invalid response.',
        provider_error: Number.isInteger(result.statusCode)
          ? `Gemini rejected the request (HTTP ${result.statusCode}). Verify the configured model and API key.`
          : 'Gemini rejected the connectivity request.'
      };
      const statusByCategory = {
        provider_not_configured: 503,
        provider_authentication: 502,
        rate_limited: 429,
        provider_unavailable: 503,
        provider_timeout: 504,
        provider_response_invalid: 502,
        provider_error: 502
      };
      const category = result.errorCategory || 'provider_unavailable';
      return res.status(statusByCategory[category] || 502).json({
        ok: false,
        provider: 'gemini',
        model,
        diagnostic: diagnosticByCategory[category] || 'Gemini connectivity check failed safely.'
      });
    } catch (error) {
      const category = error?.category;
      const diagnostic = category === 'provider_timeout'
        ? 'Gemini connectivity check timed out.'
        : category === 'provider_authentication'
          ? 'Gemini rejected the configured API key.'
          : category === 'rate_limited'
            ? 'Gemini rate limit was reached.'
            : 'Gemini connectivity check could not be completed safely.';
      const status = category === 'provider_timeout' ? 504
        : category === 'rate_limited' ? 429
          : category === 'provider_authentication' ? 502 : 503;
      return res.status(status).json({
        ok: false,
        provider: 'gemini',
        model,
        diagnostic
      });
    }
  });

  app.post('/api/chat', requireRole('CreditReader'), async (req, res) => {
    let userId;
    let conversationId;
    let startedAt;
    try {
      const message = String(req.body?.message || '').trim();
      if (!message || message.length > 1000) {
        return res.status(400).json({ error: 'Enter a message of 1-1000 characters.' });
      }
      const providedContext = req.body?.documentContext;
      if (providedContext && (
        typeof providedContext.text !== 'string'
        || providedContext.text.length > MAX_EXTRACTED_CHARACTERS
        || typeof providedContext.filename !== 'string'
      )) {
        return res.status(400).json({ error: 'Document context is invalid or exceeds the 20,000-character analysis limit. Upload the document again.' });
      }
      const documentContext = providedContext ? {
        text: providedContext.text,
        filename: path.basename(providedContext.filename).slice(0, 160),
        extractedCharacters: Number(providedContext.extractedCharacters) || providedContext.text.length,
        truncated: providedContext.truncated === true
      } : undefined;
      userId = validateActorId(currentUser(req).id);
      conversationId = await getOrCreateConversation(cds.db, userId, req.body?.conversationId);
      const history = await loadConversationMessages(cds.db, conversationId, userId);
      startedAt = new Date().toISOString();
      const result = await chat(message, cds.db, documentContext, currentUser(req), {
        conversationId,
        history,
        executionStore: {
          persist: execution => recordExecution(cds.db, userId, conversationId, execution)
        }
      });
      if (MEMORY_ENABLED && !documentContext) {
        await saveConversationTurn(cds.db, conversationId, userId, message, result.reply);
      }
      return res.json({ ...result, conversationId, memoryEnabled: MEMORY_ENABLED });
    } catch (error) {
      const execution = error.execution || {
        status: 'failed',
        startedAt: startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        errorCategory: error.category || 'agent_error',
        steps: []
      };
      const status = error.statusCode || (error instanceof TypeError ? 400 : error.category === 'execution_timeout' ? 504 : 502);
      const publicMessage = status === 400
        ? 'The request could not be validated.'
        : status === 403
          ? 'You are not authorized to perform this operation.'
          : status === 504
            ? 'The agent execution timed out.'
            : 'The agent execution could not be completed safely.';
      return res.status(status)
        .json({
          error: publicMessage,
          execution: error.execution || execution,
          ...(error.execution?.executionSummary
            ? { executionSummary: error.execution.executionSummary }
            : {}),
          conversationId: conversationId || null
        });
    }
  });

  app.get('/api/agent/history', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      const [conversations, executions] = await Promise.all([
        listConversations(cds.db, userId),
        listExecutions(cds.db, userId)
      ]);
      return res.json({ memoryEnabled: MEMORY_ENABLED, conversations, executions });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/agent/conversations/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      return res.json(await readConversation(cds.db, userId, req.params.id));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.delete('/api/agent/conversations/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      const deleted = await clearConversations(cds.db, userId, req.params.id);
      return res.json({ deleted });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.delete('/api/agent/history', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      const deleted = await clearAgentHistory(cds.db, userId);
      return res.json({ deleted });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/agent/executions', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      return res.json(await listExecutions(cds.db, userId));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/agent/executions/:id', requireRole('CreditReader'), async (req, res) => {
    try {
      const userId = validateActorId(currentUser(req).id);
      return res.json(await getExecution(cds.db, userId, req.params.id));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post('/api/agent/executions/:id/recover', requireRole('CreditReader'), async (req, res) => {
    const user = currentUser(req);
    let userId;
    try {
      userId = validateActorId(user.id);
      const candidate = await getExecutionForRecovery(cds.db, userId, req.params.id);
      if (!candidate.plan || candidate.plan.version !== PLAN_VERSION) {
        const error = new Error('Execution plan is unavailable or incompatible with this version.');
        error.statusCode = 409;
        throw error;
      }
      validatePlan(candidate.plan, { toolDefinitions });
      if (!['IN_PROGRESS', 'PARTIALLY_COMPLETED', 'BLOCKED', 'FAILED'].includes(candidate.plan.status)
        || candidate.plan.tasks.some(task => task.status === 'RUNNING')) {
        const error = new Error('Execution plan is not eligible for automatic recovery.');
        error.statusCode = 409;
        throw error;
      }
      const saved = await claimExecutionRecovery(cds.db, userId, req.params.id);
      const result = await chat('Resume the saved execution.', cds.db, undefined, user, {
        conversationId: saved.conversation_ID,
        executionId: saved.ID,
        resumePlan: saved.plan,
        recoveryData: saved.recoveryData,
        taskResults: saved.taskResults,
        executionStore: {
          persist: execution => recordExecution(
            cds.db,
            userId,
            saved.conversation_ID,
            execution
          )
        }
      });
      return res.json(result);
    } catch (error) {
      if (userId && error.execution) {
        try {
          error.execution = await recordExecution(
            cds.db,
            userId,
            error.execution.conversationId || null,
            error.execution
          );
        } catch {
          error.persistenceFailed = true;
        }
      }
      return res.status(error.statusCode || (error.category === 'execution_timeout' ? 504 : 502))
        .json({
          error: error.statusCode ? error.message : 'Execution recovery could not be completed safely.',
          ...(error.execution ? { execution: error.execution } : {})
        });
    }
  });

  app.post('/api/documents/analyze', requireRole('CreditReader'), parseDocumentUpload, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose a PDF, DOCX, or TXT document to upload.' });
      let extracted;
      try {
        extracted = await extractDocument(req.file);
      } catch (error) {
        return res.status(422).json({ error: error.message });
      }
      const filename = path.basename(req.file.originalname).replace(/[\u0000-\u001f]/g, '').slice(0, 160);
      const documentContext = {
        filename,
        text: extracted.text,
        extractedCharacters: extracted.extractedCharacters,
        truncated: extracted.truncated
      };
      const userId = validateActorId(currentUser(req).id);
      const result = await chat(
        'Read this document and summarize its credit-related facts, customer references, risks, and useful next steps.',
        cds.db,
        documentContext,
        currentUser(req),
        {
          executionStore: {
            persist: execution => recordExecution(cds.db, userId, null, execution)
          }
        }
      );
      return res.json({
        ...documentContext,
        reply: result.reply,
        offline: result.offline,
        provider: result.provider,
        providerFallback: result.providerFallback,
        providerFallbackReason: result.providerFallbackReason,
        modulesUsed: result.modulesUsed,
        dataSourcesUsed: result.dataSourcesUsed,
        plan: result.plan || null,
        taskResults: result.taskResults || [],
        executionSummary: result.executionSummary
      });
    } catch (error) {
      return res.status(error.category === 'execution_timeout' ? 504 : 502).json({
        error: error.category === 'execution_timeout'
          ? 'The document analysis timed out.'
          : 'The document analysis could not be completed safely.',
        ...(error.execution?.executionSummary
          ? { executionSummary: error.execution.executionSummary }
          : {})
      });
    }
  });
});

let stopMonitoringWorker;
let stopAutonomousScheduler;
cds.on('listening', () => {
  seedCanonicalFromLegacyDemo(cds.db).catch(() => {});
  stopMonitoringWorker = startMonitoringWorker(cds.db);
  if (process.env.DISABLE_AUTONOMOUS_SCHEDULER !== 'true') {
    stopAutonomousScheduler = startAutonomousScheduler(cds.db);
  }
});
cds.on('shutdown', async () => {
  await Promise.allSettled([
    stopAutonomousScheduler?.(),
    stopMonitoringWorker?.()
  ]);
});