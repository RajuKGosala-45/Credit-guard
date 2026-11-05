const { randomUUID } = require('crypto');
const {
  detectDuplicateSourceIdentities,
  ENTITY_FIELDS,
  ENTITY_TYPES,
  isValidTimestamp,
  mapCanonicalRecord
} = require('./canonicalData');
const { ConnectorError } = require('./connectorManager');
const {
  completeIngestionRun,
  claimIngestionSource,
  createIngestionRun,
  getIngestionCheckpoint,
  getIngestionRun,
  getLatestIngestionRun,
  listActiveCanonicalRecords
} = require('./ingestionStore');
const { getSource, selectEnabledSource } = require('./sourceRegistryStore');

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_RECORDS = 100000;
const DEFAULT_MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INGESTION_TIMEOUT_MS = 120000;
const MAX_INGESTION_TIMEOUT_MS = 600000;
const MAX_READ_RETRIES = 2;

function assertAdministrator(user) {
  if (!user || user._is_anonymous || user._is_privileged || !user.id || !user.is?.('CreditAdmin')) {
    const error = new Error('The authenticated user does not have permission to ingest source data.');
    error.statusCode = user?.id ? 403 : 401;
    throw error;
  }
}

function validateBound(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive whole number no greater than ${maximum}.`);
  }
}

function retryableReadError(error) {
  const category = error?.category || '';
  return category === 'abap_timeout'
    || category === 'abap_unavailable'
    || category === 'abap_destination_unavailable'
    || category === 'rest_network_error'
    || category === 'repository_unavailable'
    || category === 'sql_query_failed'
    || /^rest_http_(429|5\d\d)$/.test(category);
}

async function readWithDeadline(connectorManager, source, request, onRetry) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt += 1) {
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= Date.now()) {
      throw new ConnectorError('Ingestion deadline has expired.', {
        category: 'ingestion_timeout',
        statusCode: 504
      });
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(request.signal.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener('abort', abortFromCaller, { once: true });

    let timeout;
    let removeAbortListener = () => {};
    const aborted = new Promise((_resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason || new ConnectorError('Ingestion was cancelled.', {
        category: 'ingestion_cancelled',
        statusCode: 503
      }));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) onAbort();
      timeout = setTimeout(() => controller.abort(new ConnectorError('Ingestion exceeded its execution deadline.', {
        category: 'ingestion_timeout',
        statusCode: 504
      })), request.deadlineAt - Date.now());
    });
    try {
      return await Promise.race([
        connectorManager.read(source, { ...request, signal: controller.signal }),
        aborted
      ]);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_READ_RETRIES || !retryableReadError(error)
        || request.signal?.aborted || Date.now() >= request.deadlineAt) {
        throw error;
      }
      onRetry();
      const delayMs = Math.min(500, 100 * (2 ** attempt));
      await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', cancel);
        };
        const cancel = () => {
          cleanup();
          reject(request.signal.reason || new ConnectorError('Ingestion was cancelled.', {
            category: 'ingestion_cancelled',
            statusCode: 503
          }));
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs);
        request.signal?.addEventListener('abort', cancel, { once: true });
        if (request.signal?.aborted) cancel();
      });
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
  throw lastError;
}

function timestamp(value, label) {
  if (!isValidTimestamp(value)) {
    throw new ConnectorError(`Connector ${label} is invalid.`, {
      category: 'connector_invalid_response',
      statusCode: 502
    });
  }
  return new Date(value).toISOString();
}

function issueFrom(error, { entityType, sourceRecordId } = {}) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'INGESTION_VALIDATION_ERROR',
    severity: error?.severity === 'WARNING' ? 'WARNING' : 'ERROR',
    entityType: entityType || null,
    sourceRecordId: sourceRecordId || null,
    field: typeof error?.field === 'string' ? error.field : null,
    message: typeof error?.message === 'string' ? error.message : 'Ingestion validation failed.'
  };
}

function sourceRecordIdFrom(record, field) {
  if (!field || typeof field !== 'string' || !field.trim()) return null;
  const value = record?.[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function mappedSourceValues(record, mapping) {
  const values = {};
  for (const sourceField of new Set(Object.values(mapping))) {
    if (typeof sourceField === 'string' && Object.hasOwn(record, sourceField)) {
      values[sourceField] = record[sourceField];
    }
  }
  return values;
}

function sourceUpdatedAt(record, sourceUpdatedAtField) {
  if (!sourceUpdatedAtField) return undefined;
  const value = record?.[sourceUpdatedAtField];
  if (value === undefined || value === null || value === '') return undefined;
  return timestamp(value, 'source update timestamp');
}

function validFieldMapping(entityType, mapping) {
  const fields = ENTITY_FIELDS[entityType];
  return fields && Object.entries(mapping).every(([canonicalField, sourceField]) =>
    Object.hasOwn(fields, canonicalField)
    && typeof sourceField === 'string'
    && sourceField.trim() === sourceField
    && sourceField.length > 0
    && sourceField.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(sourceField));
}

function deduplicateRecords(records, issues) {
  const result = detectDuplicateSourceIdentities(records);
  const duplicateIndexes = new Set();
  for (const duplicate of result.issues) {
    const match = /^records\[(\d+)\]$/.exec(duplicate.field);
    if (match && duplicate.code === 'DUPLICATE_SOURCE_IDENTITY') {
      duplicateIndexes.add(Number(match[1]));
    }
    issues.push(issueFrom(duplicate));
  }
  return {
    records: records.filter((_record, index) => !duplicateIndexes.has(index)),
    hasConflicts: result.issues.some(item => item.severity === 'ERROR')
  };
}

function detectCanonicalCustomerCollisions(records, issues) {
  const firstById = new Map();
  let hasCollisions = false;
  for (const record of records) {
    if (record.entityType !== 'CUSTOMER') continue;
    const customerId = record.canonicalRecord.customerId;
    const sourceIdentity = `${record.sourceEntity}\u0000${record.sourceRecordId}`;
    if (!firstById.has(customerId)) {
      firstById.set(customerId, { sourceIdentity, sourceRecordId: record.sourceRecordId });
      continue;
    }
    if (firstById.get(customerId).sourceIdentity === sourceIdentity) continue;
    hasCollisions = true;
    issues.push(issueFrom({
      code: 'CANONICAL_CUSTOMER_ID_COLLISION',
      field: 'customerId',
      message: 'Different source records resolve to the same canonical customer ID.'
    }, { entityType: 'CUSTOMER', sourceRecordId: record.sourceRecordId }));
  }
  return hasCollisions;
}

async function ingestSource({
  db,
  user,
  sourceId,
  entityTypes,
  connectorManager,
  idempotencyKey = randomUUID(),
  signal,
  since,
  now = () => new Date(),
  maxPages = DEFAULT_MAX_PAGES,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS,
  timeoutMs = DEFAULT_INGESTION_TIMEOUT_MS
} = {}) {
  assertAdministrator(user);
  if (!db || typeof db.run !== 'function' || typeof db.tx !== 'function') {
    throw new TypeError('Ingestion requires a transactional database.');
  }
  if (!connectorManager || typeof connectorManager.read !== 'function') {
    throw new TypeError('Ingestion requires a connector manager.');
  }
  validateBound(maxPages, 'Maximum ingestion pages', DEFAULT_MAX_PAGES);
  validateBound(maxRecords, 'Maximum ingestion records', DEFAULT_MAX_RECORDS);
  validateBound(timeoutMs, 'Ingestion timeout', MAX_INGESTION_TIMEOUT_MS);
  if (!Number.isSafeInteger(maxSourceAgeMs) || maxSourceAgeMs < 0) {
    throw new TypeError('Maximum source age is invalid.');
  }
  if (!Array.isArray(entityTypes) || entityTypes.length === 0
    || entityTypes.some(entity => !ENTITY_TYPES.includes(entity))
    || new Set(entityTypes).size !== entityTypes.length) {
    throw new TypeError('Ingestion entity scope is invalid.');
  }

  const source = selectEnabledSource(await getSource(db, sourceId));
  if (entityTypes.some(entity => !source.supportedEntities.includes(entity))) {
    throw new ConnectorError('Requested entity is not enabled for this source.', {
      category: 'entity_not_supported',
      statusCode: 400
    });
  }
  const started = now();
  if (!(started instanceof Date) || !Number.isFinite(started.getTime())) {
    throw new TypeError('Ingestion clock is invalid.');
  }
  const created = await createIngestionRun(db, {
    sourceId,
    entityTypes,
    triggeredBy: user.id,
    idempotencyKey,
    now: started
  });
  if (!created.created) {
    return { run: created.run, duplicate: true };
  }

  let sourceLock;
  try {
    sourceLock = await claimIngestionSource(db, {
      sourceId,
      runId: created.run.ID,
      now: started,
      leaseMs: timeoutMs + 30000
    });
  } catch (error) {
    await completeIngestionRun(db, created.run.ID, {
      status: 'FAILED',
      rowCounts: { entityTypes, complete: false },
      issues: [{
        code: error.category || 'INGESTION_LOCK_FAILED',
        severity: 'ERROR',
        message: 'Ingestion could not claim the source execution lock.',
        ingestionRun_ID: created.run.ID,
        createdAt: now().toISOString()
      }],
      errorCategory: error.category || 'ingestion_already_running',
      now: now()
    });
    error.runId = created.run.ID;
    throw error;
  }
  const deadlineAt = Date.now() + timeoutMs;

  const issues = [];
  const records = [];
  const rowCounts = {};
  const retrievedAtValues = new Set();
  const sourceTimestampValues = new Set();
  const checkpoints = [];
  let sourceTimestampMissing = false;
  let pageCount = 0;
  let hasPartialData = false;
  let hasWarnings = false;
  let hasConflicts = false;
  let retryCount = 0;
  let retrievedRecordCount = 0;
  if (since !== undefined) {
    issues.push(issueFrom({
      code: 'INCREMENTAL_SNAPSHOT_MERGE_UNAVAILABLE',
      severity: 'WARNING',
      message: 'Incremental records were retrieved but cannot replace a complete snapshot without configured merge and deletion semantics.'
    }));
    hasPartialData = true;
  }

  try {
    for (const entityType of entityTypes) {
      let cursor = null;
      const seenCursors = new Set();
      const entityRecords = [];
      let complete = false;
      let entityPages = 0;
      let invalidRows = 0;
      let unprocessedRows = 0;
      let checkpointCursor = null;
      while (!complete) {
        if (signal?.aborted) {
          throw signal.reason || new ConnectorError('Ingestion was cancelled.', {
            category: 'ingestion_cancelled',
            statusCode: 503
          });
        }
        if (entityPages >= maxPages) {
          issues.push(issueFrom({
            code: 'PAGE_LIMIT_EXCEEDED',
            severity: 'ERROR',
            message: 'Source exceeded the configured ingestion page limit.'
          }, { entityType }));
          hasPartialData = true;
          break;
        }
        const page = await readWithDeadline(connectorManager, source, {
          entityType,
          cursor,
          since,
          signal,
          deadlineAt
        }, () => { retryCount += 1; });
        entityPages += 1;
        pageCount += 1;
        if (!Array.isArray(page.records)) {
          throw new ConnectorError('Connector returned an invalid record collection.', {
            category: 'connector_invalid_response',
            statusCode: 502
          });
        }
        if (page.records.length > maxRecords - retrievedRecordCount) {
          retrievedRecordCount += page.records.length;
          unprocessedRows += page.records.length;
          issues.push(issueFrom({
            code: 'RECORD_LIMIT_EXCEEDED',
            severity: 'ERROR',
            message: 'Source exceeded the configured ingestion record limit.'
          }, { entityType }));
          hasPartialData = true;
          break;
        }
        retrievedRecordCount += page.records.length;
        if (typeof page.sourceEntity !== 'string' || !page.sourceEntity.trim()
          || page.sourceEntity.length > 120 || /[\u0000-\u001f\u007f]/.test(page.sourceEntity)
          || !page.mapping || typeof page.mapping !== 'object' || Array.isArray(page.mapping)
          || !validFieldMapping(entityType, page.mapping)
          || typeof page.sourceRecordIdField !== 'string' || !page.sourceRecordIdField.trim()
          || page.sourceRecordIdField.length > 120
          || /[\u0000-\u001f\u007f]/.test(page.sourceRecordIdField)) {
          throw new ConnectorError('Source entity, field mapping, or record identity mapping is unavailable.', {
            category: 'source_mapping_unavailable',
            statusCode: 503
          });
        }
        const retrievedAt = timestamp(page.retrievedAt, 'retrieval timestamp');
        retrievedAtValues.add(retrievedAt);
        if (page.sourceTimestamp !== undefined && page.sourceTimestamp !== null) {
          sourceTimestampValues.add(timestamp(page.sourceTimestamp, 'source timestamp'));
        } else sourceTimestampMissing = true;
        if (page.checkpoint !== undefined && page.checkpoint !== null) {
          if (typeof page.checkpoint !== 'string' || !page.checkpoint.trim()) {
            throw new ConnectorError('Connector returned an invalid checkpoint.', {
              category: 'connector_invalid_response',
              statusCode: 502
            });
          }
          checkpointCursor = page.checkpoint;
        }
        if (sourceTimestampValues.size > 1) {
          issues.push(issueFrom({
            code: 'INCONSISTENT_SOURCE_TIMESTAMP',
            severity: 'ERROR',
            message: 'Source pages reported inconsistent data timestamps.'
          }, { entityType }));
          hasPartialData = true;
        }
        if (page.complete !== true && !page.nextCursor) {
          issues.push(issueFrom({
            code: 'INCOMPLETE_SOURCE_RESPONSE',
            severity: 'ERROR',
            message: 'Source response is incomplete and has no continuation cursor.'
          }, { entityType }));
          hasPartialData = true;
          break;
        }

        for (const sourceRecord of page.records) {
          const sourceRecordId = sourceRecordIdFrom(sourceRecord, page.sourceRecordIdField);
          if (!sourceRecordId) {
            issues.push(issueFrom({
              code: 'MISSING_SOURCE_RECORD_ID',
              field: page.sourceRecordIdField,
              message: 'Source record identity is missing.'
            }, { entityType }));
            invalidRows += 1;
            hasPartialData = true;
            continue;
          }
          let updatedAt;
          try {
            updatedAt = sourceUpdatedAt(sourceRecord, page.sourceUpdatedAtField);
          } catch (error) {
            issues.push(issueFrom(error, { entityType, sourceRecordId }));
            invalidRows += 1;
            hasPartialData = true;
            continue;
          }
          const provenance = {
            sourceId,
            sourceEntity: page.sourceEntity,
            sourceRecordId,
            retrievedAt,
            ingestionRunId: created.run.ID,
            mappingVersion: source.mappingVersion,
            ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {})
          };
          const mapped = mapCanonicalRecord(entityType, sourceRecord, page.mapping, provenance);
          for (const validationIssue of mapped.issues) {
            issues.push(issueFrom(validationIssue, { entityType, sourceRecordId }));
            if (validationIssue.severity === 'WARNING') hasWarnings = true;
          }
          if (!mapped.valid || !mapped.record) {
            invalidRows += 1;
            hasPartialData = true;
            continue;
          }
          entityRecords.push({
            sourceId,
            entityType,
            sourceEntity: page.sourceEntity,
            sourceRecordId,
            sourceValues: JSON.stringify(mappedSourceValues(sourceRecord, page.mapping)),
            sourceUpdatedAt: updatedAt || null,
            retrievedAt,
            ingestedAt: null,
            ingestionRun_ID: created.run.ID,
            mappingVersion: source.mappingVersion,
            canonicalData: null,
            active: false,
            canonicalRecord: mapped.record
          });
        }
        if (hasPartialData && issues.some(item => item.code === 'RECORD_LIMIT_EXCEEDED')) break;
        complete = page.complete;
        if (!complete) {
          if (seenCursors.has(page.nextCursor)) {
            issues.push(issueFrom({
              code: 'REPEATED_SOURCE_CURSOR',
              severity: 'ERROR',
              message: 'Source repeated an ingestion cursor.'
            }, { entityType }));
            hasPartialData = true;
            break;
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      }
      rowCounts[entityType] = {
        retrieved: entityRecords.length + invalidRows + unprocessedRows,
        valid: entityRecords.length,
        invalid: invalidRows,
        pages: entityPages,
        complete
      };
      const priorCheckpoint = await getIngestionCheckpoint(db, sourceId, entityType);
      const checkpointTimestamp = !sourceTimestampMissing && sourceTimestampValues.size === 1
        ? [...sourceTimestampValues][0] : null;
      if (checkpointCursor || checkpointTimestamp || priorCheckpoint) {
        checkpoints.push({
          sourceId,
          entityType,
          cursor: checkpointCursor ?? priorCheckpoint?.cursor ?? null,
          sourceTimestamp: checkpointTimestamp || priorCheckpoint?.sourceTimestamp || null
        });
      }
      records.push(...entityRecords);
      if (!complete) hasPartialData = true;
    }

    const duplicateResult = deduplicateRecords(records.map(record => ({
      ...record.canonicalRecord,
      provenance: record.canonicalRecord.provenance
    })), issues);
    hasWarnings ||= issues.some(item => item.severity === 'WARNING');
    hasConflicts = duplicateResult.hasConflicts || detectCanonicalCustomerCollisions(records, issues);
    const duplicateIndexes = new Set();
    for (const duplicate of issues.filter(item => item.code === 'DUPLICATE_SOURCE_IDENTITY')) {
      const match = /^records\[(\d+)\]$/.exec(duplicate.field || '');
      if (match) duplicateIndexes.add(Number(match[1]));
    }
    const promotableRecords = records.filter((_record, index) => !duplicateIndexes.has(index));

    const retrievedAt = retrievedAtValues.size
      ? [...retrievedAtValues].sort().at(-1) : null;
    const sourceTimestampValue = !sourceTimestampMissing && sourceTimestampValues.size === 1
      ? [...sourceTimestampValues][0] : null;
    if (!sourceTimestampValue) {
      issues.push(issueFrom({
        code: 'SOURCE_TIMESTAMP_UNAVAILABLE',
        severity: 'WARNING',
        message: 'The source did not provide a data timestamp; decision eligibility is disabled.'
      }));
      hasWarnings = true;
    }
    const fresh = sourceTimestampValue !== null
      && started.getTime() - Date.parse(sourceTimestampValue) <= maxSourceAgeMs
      && Date.parse(sourceTimestampValue) <= started.getTime();
    if (sourceTimestampValue && !fresh) {
      issues.push(issueFrom({
        code: 'SOURCE_DATA_STALE',
        severity: 'WARNING',
        message: 'Source data is outside the configured freshness window.'
      }));
      hasWarnings = true;
    }
    if (promotableRecords.length === 0) {
      issues.push(issueFrom({
        code: 'EMPTY_CANONICAL_SNAPSHOT',
        severity: 'WARNING',
        message: 'No valid canonical records were produced.'
      }));
      hasWarnings = true;
    }
    const hasEmptyEntity = Object.entries(rowCounts).some(([, counts]) => counts.valid === 0);
    if (hasEmptyEntity && promotableRecords.length > 0) {
      issues.push(issueFrom({
        code: 'EMPTY_SOURCE_ENTITY',
        severity: 'WARNING',
        message: 'At least one requested entity returned no valid records; the snapshot was not promoted.'
      }));
      hasWarnings = true;
    }

    const complete = !hasPartialData && !hasConflicts
      && Object.values(rowCounts).every(item => item.complete);
    const status = !complete ? 'PARTIAL'
      : hasWarnings ? 'SUCCEEDED_WITH_WARNINGS' : 'SUCCEEDED';
    const promoteSnapshot = complete && !hasEmptyEntity && promotableRecords.length > 0;
    const decisionEligible = promoteSnapshot && fresh && !hasWarnings;
    const ingestedAt = now();
    if (!(ingestedAt instanceof Date) || !Number.isFinite(ingestedAt.getTime())) {
      throw new TypeError('Ingestion clock is invalid.');
    }
    const persistedRecords = promotableRecords.map(record => {
      const { canonicalRecord, ...stored } = record;
      const canonical = {
        ...canonicalRecord,
        provenance: {
          ...canonicalRecord.provenance,
          ingestedAt: ingestedAt.toISOString()
        }
      };
      return {
        ...stored,
        ingestedAt: ingestedAt.toISOString(),
        canonicalData: JSON.stringify(canonical),
        active: false
      };
    });
    const run = await completeIngestionRun(db, created.run.ID, {
      status,
      decisionEligible,
      promoteSnapshot,
      retrievedAt,
      sourceTimestamp: sourceTimestampValue,
      rowCounts: {
        ...rowCounts,
        pageCount,
        retryCount,
        qualityIssueCount: issues.length,
        complete
      },
      records: persistedRecords,
      checkpoints,
      lockToken: sourceLock.lockToken,
      issues: issues.map(item => ({
        ...item,
        ingestionRun_ID: created.run.ID,
        createdAt: ingestedAt.toISOString()
      })),
      now: ingestedAt
    });
    return { run, duplicate: false };
  } catch (error) {
    const category = signal?.aborted
      ? (typeof signal.reason?.category === 'string' ? signal.reason.category : 'ingestion_cancelled')
      : typeof error?.category === 'string'
      && /^[a-z][a-z0-9_]{0,39}$/.test(error.category)
      ? error.category : 'ingestion_failed';
    await completeIngestionRun(db, created.run.ID, {
      status: 'FAILED',
      decisionEligible: false,
      rowCounts: {
        ...rowCounts,
        pageCount,
        retryCount,
        qualityIssueCount: issues.length,
        complete: false
      },
      issues: [
        ...issues,
        {
          code: category.toUpperCase(),
          severity: 'ERROR',
          message: 'Ingestion failed before a complete snapshot was available.',
          ingestionRun_ID: created.run.ID,
          createdAt: now().toISOString()
        }
      ].map(item => ({
        ...item,
        ingestionRun_ID: created.run.ID,
        createdAt: item.createdAt || now().toISOString()
      })),
      errorCategory: category,
      lockToken: sourceLock.lockToken,
      now: now()
    });
    const failure = new Error('Ingestion failed; the prior canonical snapshot was retained.', { cause: error });
    failure.category = category;
    failure.statusCode = error.statusCode || 503;
    failure.runId = created.run.ID;
    throw failure;
  }
}

async function latestCanonicalSnapshot(db, sourceId, entityType, {
  includeRecords = true,
  limit = 1000,
  offset = 0,
  maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS,
  now = new Date()
} = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw new TypeError('Canonical entity type is invalid.');
  if (!Number.isSafeInteger(maxSourceAgeMs) || maxSourceAgeMs < 0
    || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000
    || !Number.isSafeInteger(offset) || offset < 0
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Snapshot freshness settings are invalid.');
  }
  const [latestRun, snapshotRows] = await Promise.all([
    getLatestIngestionRun(db, sourceId),
    listActiveCanonicalRecords(db, sourceId, entityType, {
      limit: includeRecords ? limit + 1 : 1,
      offset: includeRecords ? offset : 0
    })
  ]);
  const firstRecord = includeRecords && offset > 0
    ? (await listActiveCanonicalRecords(db, sourceId, entityType, { limit: 1 }))[0]
    : snapshotRows[0];
  const snapshotRunId = firstRecord?.ingestionRun_ID;
  const snapshotRun = snapshotRunId ? await getIngestionRun(db, snapshotRunId) : null;
  if (!latestRun && !snapshotRun) return null;
  const sourceTimestamp = snapshotRun?.sourceTimestamp || null;
  const timestampMs = sourceTimestamp ? Date.parse(sourceTimestamp) : Number.NaN;
  const freshness = !sourceTimestamp ? 'UNKNOWN'
    : !Number.isFinite(timestampMs) || timestampMs > now.getTime() ? 'INVALID'
      : now.getTime() - timestampMs > maxSourceAgeMs ? 'STALE' : 'FRESH';
  const decisionEligible = snapshotRun?.decisionEligible === true && freshness === 'FRESH';
  let rowCounts;
  try {
    rowCounts = latestRun?.rowCounts ? JSON.parse(latestRun.rowCounts) : null;
  } catch (cause) {
    throw new TypeError('Stored ingestion run counts are invalid.', { cause });
  }
  return {
    latestRun: latestRun ? {
      id: latestRun.ID,
      status: latestRun.status,
      decisionEligible: latestRun.decisionEligible === true,
      completedAt: latestRun.completedAt || null,
      sourceTimestamp: latestRun.sourceTimestamp || null,
      retrievedAt: latestRun.retrievedAt || null,
      errorCategory: latestRun.errorCategory || null,
      rowCounts
    } : null,
    snapshotRun: snapshotRun ? {
      id: snapshotRun.ID,
      status: snapshotRun.status,
      decisionEligible,
      retrievedAt: snapshotRun.retrievedAt || null,
      sourceTimestamp,
      freshness
    } : null,
    ...(includeRecords ? {
      records: snapshotRows.slice(0, limit).map(record => JSON.parse(record.canonicalData)),
      recordOffset: offset,
      nextOffset: snapshotRows.length > limit ? offset + limit : null
    } : {})
  };
}

module.exports = {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_SOURCE_AGE_MS,
  DEFAULT_INGESTION_TIMEOUT_MS,
  MAX_INGESTION_TIMEOUT_MS,
  ingestSource,
  latestCanonicalSnapshot
};
