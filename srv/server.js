require('dotenv').config();
const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
const multer = require('multer');
const { validateProductionBindings } = require('./deployment');
const creditService = require('./creditService');
const { createPortfolioDataProvider } = require('./portfolioDataProvider');
const { validateActorId } = require('./limitRequests');
const { chat, toolDefinitions } = require('./agent');
const { PLAN_VERSION, validatePlan } = require('./agentPlan');
const { extractDocument, MAX_EXTRACTED_CHARACTERS } = require('./documents');
const {
  executeMonitoringRun,
  publicFinding,
  publicRun,
  recoverMonitoringRun
} = require('./monitoringService');
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

cds.on('bootstrap', app => {
  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'live' }));
  app.get('/health/ready', (_req, res) => {
    if (!cds.db || typeof cds.db.run !== 'function') {
      return res.status(503).json({ status: 'not-ready' });
    }
    return res.status(200).json({ status: 'ready' });
  });
  app.use('/credit', cds.middlewares.before, express.static(path.join(__dirname, '..', 'app', 'credit')));
  app.use('/api', cds.middlewares.before);
  app.use('/api', express.json());
  app.use('/api', requireAuthenticatedUser);

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
      return res.status(run.status === 'RUNNING' ? 202 : 200).json(run);
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
      return res.status(run.status === 'RUNNING' ? 202 : 200).json(run);
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
      if (!isMonitoringRunOwnerOrOperator(currentUser(req), run)) {
        return res.status(403).json({ error: 'You are not authorized to view this monitoring run.' });
      }
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
      if (!isMonitoringRunOwnerOrOperator(currentUser(req), run)) {
        return res.status(403).json({ error: 'You are not authorized to view this monitoring run.' });
      }
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
      return res.status(200).json(recovered);
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
      const request = await creditService.createLimitRequest(cds.db, currentUser(req), req.body);
      return res.status(201).json(request);
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