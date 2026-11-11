const { randomUUID } = require('crypto');
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const { MOCK_SAP_SOURCE_ID } = require('./sourceRegistry');
const { projectMockSapRecords } = require('./integrations/mock-sap/projection');
const {
  SOURCE_ID: MOCK_SAP_GENERATED_SOURCE_ID,
  isSapSimEnabled
} = require('./integrations/mock-sap-generated/connector');
const { projectMockSapGeneratedRecords } = require('./integrations/mock-sap-generated/projection');

const SUCCESS_STATUSES = new Set(['SUCCEEDED', 'SUCCEEDED_WITH_WARNINGS']);
const RUN_STATUSES = new Set([...SUCCESS_STATUSES, 'PARTIAL', 'FAILED']);

async function findRunByIdempotencyKey(db, idempotencyKey) {
  return (await db.run(SELECT.one.from('credit.IngestionRuns').where({ idempotencyKey }))) || null;
}

async function createIngestionRun(db, {
  sourceId,
  entityTypes,
  triggeredBy,
  idempotencyKey = randomUUID(),
  now = new Date()
}) {
  if (!Array.isArray(entityTypes) || !entityTypes.length
    || entityTypes.some(entity => typeof entity !== 'string')
    || new Set(entityTypes).size !== entityTypes.length) {
    throw new TypeError('Ingestion entity scope is invalid.');
  }
  if (typeof sourceId !== 'string' || !sourceId.trim()
    || typeof triggeredBy !== 'string' || !triggeredBy.trim()
    || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()
    || idempotencyKey.length > 160) {
    throw new TypeError('Ingestion run identity is invalid.');
  }
  const startedAt = now.toISOString();
  const run = {
    ID: randomUUID(),
    idempotencyKey,
    sourceId,
    status: 'RUNNING',
    decisionEligible: false,
    startedAt,
    completedAt: null,
    retrievedAt: null,
    sourceTimestamp: null,
    triggeredBy,
    attemptCount: 1,
    rowCounts: JSON.stringify({ entityTypes })
  };
  try {
    await db.run(INSERT.into('credit.IngestionRuns').entries(run));
    return { run, created: true };
  } catch (error) {
    const existing = await findRunByIdempotencyKey(db, idempotencyKey);
    if (!existing) throw error;
    const existingScope = JSON.parse(existing.rowCounts || '{}').entityTypes;
    if (existing.sourceId !== sourceId
      || JSON.stringify(existingScope) !== JSON.stringify(entityTypes)) {
      const conflict = new Error('Idempotency key was already used for a different ingestion request.');
      conflict.statusCode = 409;
      throw conflict;
    }
    return { run: existing, created: false };
  }
}

async function claimIngestionSource(db, {
  sourceId,
  runId,
  now = new Date(),
  leaseMs
}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError('Ingestion source lock lease is invalid.');
  }
  const lockToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  try {
    return await db.tx(async tx => {
      const current = await tx.run(SELECT.one.from('credit.IngestionSourceLocks')
        .where({ sourceId }));
      if (!current) {
        await tx.run(INSERT.into('credit.IngestionSourceLocks').entries({
          sourceId,
          run_ID: runId,
          lockToken,
          leaseUntil,
          updatedAt: now.toISOString()
        }));
        return { lockToken, leaseUntil };
      }
      if (new Date(current.leaseUntil).getTime() > now.getTime()) {
        const error = new Error('Another ingestion is already running for this source.');
        error.statusCode = 409;
        error.category = 'ingestion_already_running';
        throw error;
      }
      const changed = await tx.run(UPDATE('credit.IngestionSourceLocks')
        .set({ run_ID: runId, lockToken, leaseUntil, updatedAt: now.toISOString() })
        .where({
          sourceId,
          run_ID: current.run_ID,
          lockToken: current.lockToken,
          leaseUntil: current.leaseUntil
        }));
      if (changed !== 1) {
        const error = new Error('Ingestion source lock changed before it could be claimed.');
        error.statusCode = 409;
        error.category = 'ingestion_already_running';
        throw error;
      }
      if (current.run_ID) {
        await tx.run(UPDATE('credit.IngestionRuns')
          .set({
            status: 'FAILED',
            decisionEligible: false,
            snapshotPromoted: false,
            completedAt: now.toISOString(),
            errorCategory: 'ingestion_lease_expired'
          })
          .where({ ID: current.run_ID, status: 'RUNNING' }));
      }
      return { lockToken, leaseUntil };
    });
  } catch (error) {
    if (error.category === 'ingestion_already_running') throw error;
    const current = await db.run(SELECT.one.from('credit.IngestionSourceLocks')
      .where({ sourceId }));
    if (current && new Date(current.leaseUntil).getTime() > now.getTime()) {
      const conflict = new Error('Another ingestion is already running for this source.', { cause: error });
      conflict.statusCode = 409;
      conflict.category = 'ingestion_already_running';
      throw conflict;
    }
    throw error;
  }
}

async function releaseIngestionSource(tx, sourceId, runId, lockToken, now) {
  if (!lockToken) return;
  const changed = await tx.run(UPDATE('credit.IngestionSourceLocks')
    .set({
      run_ID: null,
      lockToken: null,
      leaseUntil: new Date(0).toISOString(),
      updatedAt: now.toISOString()
    })
    .where({ sourceId, run_ID: runId, lockToken }));
  if (changed !== 1) {
    return false;
  }
  return true;
}

function validateIssue(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)
    || typeof issue.code !== 'string' || typeof issue.severity !== 'string'
    || !['ERROR', 'WARNING'].includes(issue.severity)
    || typeof issue.message !== 'string') {
    throw new TypeError('Ingestion quality issue is invalid.');
  }
  return {
    ID: randomUUID(),
    ingestionRun_ID: issue.ingestionRun_ID,
    code: issue.code.slice(0, 64),
    severity: issue.severity,
    entityType: issue.entityType || null,
    sourceRecordId: typeof issue.sourceRecordId === 'string'
      ? issue.sourceRecordId.slice(0, 256) : null,
    field: typeof issue.field === 'string' ? issue.field.slice(0, 120) : null,
    message: issue.message.slice(0, 500),
    createdAt: issue.createdAt
  };
}

async function completeIngestionRun(db, runId, {
  status,
  decisionEligible = false,
  promoteSnapshot = true,
  retrievedAt = null,
  sourceTimestamp = null,
  rowCounts,
  records = [],
  checkpoints = [],
  issues = [],
  errorCategory = null,
  lockToken,
  now = new Date()
}) {
  if (!RUN_STATUSES.has(status)) throw new TypeError('Ingestion run status is invalid.');
  if (!rowCounts || typeof rowCounts !== 'object' || Array.isArray(rowCounts)) {
    throw new TypeError('Ingestion row counts are invalid.');
  }
  const completedAt = now.toISOString();
  return db.tx(async tx => {
    const run = await tx.run(SELECT.one.from('credit.IngestionRuns').where({ ID: runId }));
    if (!run || run.status !== 'RUNNING') {
      const error = new Error('Ingestion run is not active.');
      error.statusCode = 409;
      throw error;
    }

    const shouldPromote = SUCCESS_STATUSES.has(status) && promoteSnapshot === true;
    if (shouldPromote) {
      const lock = await tx.run(SELECT.one.from('credit.IngestionSourceLocks')
        .where({ sourceId: run.sourceId, run_ID: runId, lockToken }));
      if (!lockToken || !lock) {
        const error = new Error('Ingestion source lock is not owned by this run.');
        error.statusCode = 409;
        throw error;
      }
    }
    const entityTypes = JSON.parse(run.rowCounts || '{}').entityTypes || [];
    if (shouldPromote) {
      if (run.sourceId === MOCK_SAP_SOURCE_ID) {
        rowCounts.mockProjection = await projectMockSapRecords(tx, records);
      }
      if (run.sourceId === MOCK_SAP_GENERATED_SOURCE_ID && isSapSimEnabled()) {
        rowCounts.mockSapGeneratedProjection = await projectMockSapGeneratedRecords(tx, records);
      }
      for (const entityType of entityTypes) {
        await tx.run(UPDATE('credit.CanonicalRecords')
          .set({ active: false })
          .where({ sourceId: run.sourceId, entityType, active: true }));
      }
      for (const record of records) {
        await tx.run(INSERT.into('credit.CanonicalRecords').entries({
          ...record,
          active: true
        }));
      }
      for (const checkpoint of checkpoints) {
        const existing = await tx.run(SELECT.one.from('credit.IngestionCheckpoints')
          .where({ sourceId: checkpoint.sourceId, entityType: checkpoint.entityType }));
        const values = {
          cursor: checkpoint.cursor ?? null,
          sourceTimestamp: checkpoint.sourceTimestamp ?? null,
          ingestionRun_ID: runId,
          updatedAt: completedAt
        };
        if (existing) {
          const updated = await tx.run(UPDATE('credit.IngestionCheckpoints')
            .set(values)
            .where({ sourceId: checkpoint.sourceId, entityType: checkpoint.entityType }));
          if (updated !== 1) {
            const error = new Error('Ingestion checkpoint changed before it could be saved.');
            error.statusCode = 409;
            throw error;
          }
        } else {
          await tx.run(INSERT.into('credit.IngestionCheckpoints').entries({
            sourceId: checkpoint.sourceId,
            entityType: checkpoint.entityType,
            ...values
          }));
        }
      }
    }

    for (const issue of issues) {
      await tx.run(INSERT.into('credit.IngestionQualityIssues').entries(validateIssue(issue)));
    }
    const changed = await tx.run(UPDATE('credit.IngestionRuns')
      .set({
        status,
        decisionEligible: shouldPromote && decisionEligible === true,
        snapshotPromoted: shouldPromote,
        completedAt,
        retrievedAt,
        sourceTimestamp,
        rowCounts: JSON.stringify({ ...rowCounts, entityTypes }),
        errorCategory
      })
      .where({ ID: runId, status: 'RUNNING' }));
    if (changed !== 1) {
      const error = new Error('Ingestion run changed before completion could be committed.');
      error.statusCode = 409;
      throw error;
    }
    await releaseIngestionSource(tx, run.sourceId, runId, lockToken, now);
    return {
      ...run,
      status,
      decisionEligible: shouldPromote && decisionEligible === true,
      snapshotPromoted: shouldPromote,
      completedAt,
      retrievedAt,
      sourceTimestamp,
      rowCounts: JSON.stringify({ ...rowCounts, entityTypes }),
      errorCategory
    };
  });
}

async function failIngestionRun(db, runId, category, now = new Date()) {
  const errorCategory = typeof category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(category)
    ? category : 'ingestion_failed';
  const completedAt = now.toISOString();
  const changed = await db.run(UPDATE('credit.IngestionRuns')
    .set({
      status: 'FAILED',
      decisionEligible: false,
      snapshotPromoted: false,
      completedAt,
      errorCategory
    })
    .where({ ID: runId, status: 'RUNNING' }));
  if (changed !== 1) return null;
  return (await db.run(SELECT.one.from('credit.IngestionRuns').where({ ID: runId }))) || null;
}

async function getIngestionRun(db, runId) {
  return (await db.run(SELECT.one.from('credit.IngestionRuns').where({ ID: runId }))) || null;
}

async function listIngestionIssues(db, runId) {
  return db.run(SELECT.from('credit.IngestionQualityIssues')
    .where({ ingestionRun_ID: runId }).orderBy('createdAt asc').limit(501));
}

async function getLatestIngestionRun(db, sourceId) {
  return (await db.run(SELECT.one.from('credit.IngestionRuns')
    .where({ sourceId }).orderBy('startedAt desc'))) || null;
}

async function getLatestPromotedIngestionRun(db, sourceId) {
  return (await db.run(SELECT.one.from('credit.IngestionRuns')
    .where({ sourceId, snapshotPromoted: true })
    .orderBy('completedAt desc'))) || null;
}

async function listActiveCanonicalRecords(db, sourceId, entityType, { limit, offset = 0 } = {}) {
  const query = SELECT.from('credit.CanonicalRecords')
    .where({ sourceId, entityType, active: true })
    .orderBy('sourceRecordId asc');
  if (limit !== undefined) query.limit(limit, offset);
  return db.run(query);
}

async function getIngestionCheckpoint(db, sourceId, entityType) {
  return (await db.run(SELECT.one.from('credit.IngestionCheckpoints')
    .where({ sourceId, entityType }))) || null;
}

module.exports = {
  completeIngestionRun,
  createIngestionRun,
  claimIngestionSource,
  failIngestionRun,
  getIngestionRun,
  getIngestionCheckpoint,
  getLatestIngestionRun,
  getLatestPromotedIngestionRun,
  listActiveCanonicalRecords,
  listIngestionIssues
};
