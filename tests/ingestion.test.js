const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorManager } = require('../srv/connectorManager');
const { ingestSource, latestCanonicalSnapshot } = require('../srv/ingestionService');
const { registerSource } = require('../srv/sourceRegistryStore');
const { createMonitoringDatabase } = require('./support/transactional-monitoring-db');

const fixedNow = new Date('2026-11-05T00:00:00.000Z');
const admin = { id: 'administrator', is: role => role === 'CreditAdmin' };

function database() {
  return createMonitoringDatabase({
    tables: {
      'credit.DataSources': [],
      'credit.IngestionRuns': [],
      'credit.CanonicalRecords': [],
      'credit.IngestionQualityIssues': [],
      'credit.IngestionCheckpoints': [],
      'credit.IngestionSourceLocks': []
    },
    uniqueFields: {
      'credit.DataSources': ['sourceId'],
      'credit.IngestionRuns': ['ID', 'idempotencyKey'],
      'credit.CanonicalRecords': ['ID'],
      'credit.IngestionQualityIssues': ['ID'],
      'credit.IngestionCheckpoints': ['sourceId', 'entityType'],
      'credit.IngestionSourceLocks': ['sourceId']
    }
  });
}

async function addSource(db) {
  return registerSource(db, {
    sourceId: 'approved-sap',
    sourceName: 'Approved SAP',
    sourceType: 'SAP_S4HANA_ODATA',
    enabled: true,
    supportedEntities: ['CUSTOMER'],
    mappingVersion: 'v1',
    authenticationReference: 'destination:approved-sap',
    configurationReference: 'config:approved-sap'
  }, fixedNow);
}

const customerMapping = {
  customerId: 'CustomerId',
  sourceCustomerId: 'CustomerId',
  customerName: 'CustomerName',
  companyCode: 'CompanyCode'
};

function connectorFor(read, { supportsIncremental = false } = {}) {
  return createConnectorManager({
    configurationResolver: async () => ({
      entityMappings: {
        CUSTOMER: {
          fields: customerMapping,
          sourceEntity: 'Customers',
          sourceRecordIdField: 'CustomerId'
        }
      }
    }),
    adapters: [{
      sourceType: 'SAP_S4HANA_ODATA',
      connector: {
        capabilities: () => ({
          entities: ['CUSTOMER'],
          supportsIncremental,
          supportsCancellation: true
        }),
        read
      }
    }]
  });
}

function page(records, overrides = {}) {
  return {
    records,
    complete: true,
    nextCursor: null,
    sourceTimestamp: fixedNow.toISOString(),
    retrievedAt: fixedNow.toISOString(),
    ...overrides
  };
}

test('connector manager validates capabilities, enabled scope, incremental mode, and pages', async () => {
  const manager = connectorFor(async () => page([]));
  const source = {
    sourceId: 'approved-sap',
    sourceType: 'SAP_S4HANA_ODATA',
    enabled: true,
    supportedEntities: ['CUSTOMER']
  };
  await assert.rejects(manager.read({ ...source, enabled: false }, { entityType: 'CUSTOMER' }), {
    category: 'source_disabled'
  });
  await assert.rejects(manager.read(source, { entityType: 'PAYMENT' }), {
    category: 'entity_not_supported'
  });
  await assert.rejects(manager.read(source, {
    entityType: 'CUSTOMER',
    since: fixedNow.toISOString()
  }), { category: 'incremental_not_supported' });
  const result = await manager.read(source, { entityType: 'CUSTOMER' });
  assert.equal(result.sourceEntity, 'Customers');
  assert.deepEqual(result.mapping, customerMapping);
  assert.throws(() => createConnectorManager({
    adapters: [{ sourceType: 'REST_API', connector: { read() {} } }]
  }), /capabilities/);
});

test('complete ingestion maps canonical records, persists exact source values and promotes atomically', async () => {
  const db = database();
  await addSource(db);
  const connectorManager = connectorFor(async () => page([{
    CustomerId: 'C1001',
    CustomerName: 'Example Customer',
    CompanyCode: '1000'
  }]));
  const result = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager,
    idempotencyKey: 'ingest-success',
    now: () => fixedNow
  });

  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(result.run.decisionEligible, true);
  assert.equal(result.run.snapshotPromoted, true);
  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER');
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].customerId, 'C1001');
  assert.equal(snapshot.records[0].provenance.ingestionRunId, result.run.ID);
  assert.equal(db.tables['credit.CanonicalRecords'][0].sourceValues,
    '{"CustomerId":"C1001","CustomerName":"Example Customer","CompanyCode":"1000"}');
});

test('failed retrieval is recorded and retains the previously promoted snapshot', async () => {
  const db = database();
  await addSource(db);
  const successful = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Example Customer',
      CompanyCode: '1000'
    }])),
    idempotencyKey: 'first-run',
    now: () => fixedNow
  });

  await assert.rejects(ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => {
      throw Object.assign(new Error('private upstream body'), { category: 'abap_timeout' });
    }),
    idempotencyKey: 'failed-run',
    now: () => new Date(fixedNow.getTime() + 1000)
  }), error => error.category === 'abap_timeout' && Boolean(error.runId));

  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER');
  assert.equal(snapshot.latestRun.status, 'FAILED');
  assert.equal(snapshot.snapshotRun.id, successful.run.ID);
  assert.equal(snapshot.records.length, 1);
  assert.equal(db.tables['credit.CanonicalRecords'].filter(record => record.active).length, 1);
});

test('conflicting source identities are partial and cannot replace the active snapshot', async () => {
  const db = database();
  await addSource(db);
  const initial = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Example Customer',
      CompanyCode: '1000'
    }])),
    idempotencyKey: 'initial',
    now: () => fixedNow
  });
  const conflicting = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([
      { CustomerId: 'C1001', CustomerName: 'Example Customer', CompanyCode: '1000' },
      { CustomerId: 'C1001', CustomerName: 'Different Customer', CompanyCode: '1000' }
    ])),
    idempotencyKey: 'conflicting',
    now: () => fixedNow
  });

  assert.equal(conflicting.run.status, 'PARTIAL');
  assert.equal(conflicting.run.decisionEligible, false);
  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER');
  assert.equal(snapshot.snapshotRun.id, initial.run.ID);
  assert.equal(snapshot.records[0].customerName, 'Example Customer');
});

test('conflicting canonical customer identities are rejected without an approved crosswalk', async () => {
  const db = database();
  await addSource(db);
  const connectorManager = createConnectorManager({
    configurationResolver: async () => ({
      entityMappings: {
        CUSTOMER: {
          fields: {
            customerId: 'MasterCustomerId',
            sourceCustomerId: 'CustomerId',
            customerName: 'CustomerName',
            companyCode: 'CompanyCode'
          },
          sourceEntity: 'Customers',
          sourceRecordIdField: 'CustomerId'
        }
      }
    }),
    adapters: [{
      sourceType: 'SAP_S4HANA_ODATA',
      connector: {
        capabilities: () => ({
          entities: ['CUSTOMER'],
          supportsIncremental: false,
          supportsCancellation: true
        }),
        read: async () => page([
          {
            CustomerId: 'C1001',
            MasterCustomerId: 'MASTER1',
            CustomerName: 'Example Customer',
            CompanyCode: '1000'
          },
          {
            CustomerId: 'C1002',
            MasterCustomerId: 'MASTER1',
            CustomerName: 'Another Customer',
            CompanyCode: '1000'
          }
        ])
      }
    }]
  });
  const result = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager,
    idempotencyKey: 'canonical-collision',
    now: () => fixedNow
  });
  assert.equal(result.run.status, 'PARTIAL');
  assert.equal(result.run.snapshotPromoted, false);
  assert.ok(db.tables['credit.IngestionQualityIssues'].some(issue =>
    issue.code === 'CANONICAL_CUSTOMER_ID_COLLISION'));
});

test('disabled sources and unauthorized callers cannot start ingestion', async () => {
  const db = database();
  const source = await addSource(db);
  const disabled = await require('../srv/sourceRegistryStore').updateSource(
    db,
    source.sourceId,
    { enabled: false },
    fixedNow
  );
  assert.equal(disabled.enabled, false);
  await assert.rejects(ingestSource({
    db,
    user: admin,
    sourceId: source.sourceId,
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([])),
    now: () => fixedNow
  }), { statusCode: 409 });
  await assert.rejects(ingestSource({
    db,
    user: { id: 'reader', is: () => false },
    sourceId: source.sourceId,
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([])),
    now: () => fixedNow
  }), { statusCode: 403 });
});

test('idempotent requests reuse their run without repeating connector reads', async () => {
  const db = database();
  await addSource(db);
  let reads = 0;
  const options = {
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => {
      reads += 1;
      return page([{ CustomerId: 'C1001', CustomerName: 'Example Customer', CompanyCode: '1000' }]);
    }),
    idempotencyKey: 'same-request',
    now: () => fixedNow
  };
  const first = await ingestSource(options);
  const repeated = await ingestSource(options);
  assert.equal(first.run.ID, repeated.run.ID);
  assert.equal(repeated.duplicate, true);
  assert.equal(reads, 1);
});

test('transient connector errors are retried within a bounded policy', async () => {
  const db = database();
  await addSource(db);
  let attempts = 0;
  const result = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('private upstream details'), {
        category: 'abap_unavailable'
      });
      return page([{ CustomerId: 'C1001', CustomerName: 'Example Customer', CompanyCode: '1000' }]);
    }),
    idempotencyKey: 'retry-once',
    now: () => fixedNow
  });
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(result.run.rowCounts).retryCount, 1);
});

test('multi-page retrieval follows unique cursors and promotes only after completion', async () => {
  const db = database();
  await addSource(db);
  const cursors = [];
  const result = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async request => {
      cursors.push(request.cursor);
      return request.cursor
        ? page([{ CustomerId: 'C1002', CustomerName: 'Second Customer', CompanyCode: '1000' }])
        : page([{
          CustomerId: 'C1001',
          CustomerName: 'Example Customer',
          CompanyCode: '1000'
        }], { complete: false, nextCursor: 'page-2' });
    }),
    idempotencyKey: 'multiple-pages',
    now: () => fixedNow
  });
  assert.deepEqual(cursors, [null, 'page-2']);
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(JSON.parse(result.run.rowCounts).pageCount, 2);
  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER', { now: fixedNow });
  assert.equal(snapshot.records.length, 2);
});

test('cancelled ingestion is recorded and releases its source lock', async () => {
  const db = database();
  await addSource(db);
  const controller = new AbortController();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const resultPromise = ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(request => {
      markStarted();
      return new Promise(resolve => {
        request.signal.addEventListener('abort', () => resolve(page([])), { once: true });
      });
    }),
    idempotencyKey: 'cancelled-run',
    signal: controller.signal,
    now: () => fixedNow
  });
  await started;
  controller.abort();
  await assert.rejects(resultPromise, { category: 'ingestion_cancelled' });
  assert.equal(db.tables['credit.IngestionRuns'][0].status, 'FAILED');
  assert.equal(db.tables['credit.IngestionSourceLocks'][0].lockToken, null);
});

test('ingestion deadline stops waiting for an unresponsive connector and records failure', async () => {
  const db = database();
  await addSource(db);
  await assert.rejects(ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(() => new Promise(() => {})),
    idempotencyKey: 'connector-timeout',
    timeoutMs: 50,
    now: () => fixedNow
  }), { category: 'ingestion_timeout' });
  assert.equal(db.tables['credit.IngestionRuns'][0].status, 'FAILED');
  assert.equal(db.tables['credit.IngestionRuns'][0].errorCategory, 'ingestion_timeout');
});

test('incremental retrieval cannot replace a complete snapshot without merge semantics', async () => {
  const db = database();
  await addSource(db);
  const first = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Example Customer',
      CompanyCode: '1000'
    }])),
    idempotencyKey: 'full-snapshot',
    now: () => fixedNow
  });
  const incremental = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Updated Customer',
      CompanyCode: '1000'
    }]), { supportsIncremental: true }),
    idempotencyKey: 'incremental-delta',
    since: fixedNow.toISOString(),
    now: () => new Date(fixedNow.getTime() + 1000)
  });

  assert.equal(incremental.run.status, 'PARTIAL');
  assert.equal(incremental.run.snapshotPromoted, false);
  assert.ok(db.tables['credit.IngestionQualityIssues'].some(issue =>
    issue.code === 'INCREMENTAL_SNAPSHOT_MERGE_UNAVAILABLE'));
  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER', { now: fixedNow });
  assert.equal(snapshot.snapshotRun.id, first.run.ID);
  assert.equal(snapshot.records[0].customerName, 'Example Customer');
});

test('record limits and concurrent source runs fail closed', async () => {
  const db = database();
  await addSource(db);
  const initial = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Example Customer',
      CompanyCode: '1000'
    }])),
    idempotencyKey: 'limit-baseline',
    now: () => fixedNow
  });
  const overLimit = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([
      { CustomerId: 'C1002', CustomerName: 'Second Customer', CompanyCode: '1000' },
      { CustomerId: 'C1003', CustomerName: 'Third Customer', CompanyCode: '1000' }
    ])),
    idempotencyKey: 'limit-overflow',
    maxRecords: 1,
    now: () => new Date(fixedNow.getTime() + 1000)
  });
  assert.equal(overLimit.run.status, 'PARTIAL');
  assert.equal(overLimit.run.snapshotPromoted, false);
  const baseline = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER', { now: fixedNow });
  assert.equal(baseline.snapshotRun.id, initial.run.ID);

  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let finishRead;
  const blockedRead = new Promise(resolve => { finishRead = resolve; });
  const running = ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => {
      markStarted();
      await blockedRead;
      return page([{ CustomerId: 'C1004', CustomerName: 'Fourth Customer', CompanyCode: '1000' }]);
    }),
    idempotencyKey: 'concurrent-first',
    now: () => new Date(fixedNow.getTime() + 2000)
  });
  await started;
  await assert.rejects(ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([])),
    idempotencyKey: 'concurrent-second',
    now: () => new Date(fixedNow.getTime() + 2000)
  }), { category: 'ingestion_already_running' });
  finishRead();
  await running;
});

test('stale but complete source data is retained as a warning snapshot and is not decision eligible', async () => {
  const db = database();
  await addSource(db);
  const staleTimestamp = new Date(fixedNow.getTime() - (48 * 60 * 60 * 1000)).toISOString();
  const result = await ingestSource({
    db,
    user: admin,
    sourceId: 'approved-sap',
    entityTypes: ['CUSTOMER'],
    connectorManager: connectorFor(async () => page([{
      CustomerId: 'C1001',
      CustomerName: 'Example Customer',
      CompanyCode: '1000'
    }], { sourceTimestamp: staleTimestamp })),
    idempotencyKey: 'stale-source',
    now: () => fixedNow
  });
  assert.equal(result.run.status, 'SUCCEEDED_WITH_WARNINGS');
  assert.equal(result.run.snapshotPromoted, true);
  assert.equal(result.run.decisionEligible, false);
  const snapshot = await latestCanonicalSnapshot(db, 'approved-sap', 'CUSTOMER', { now: fixedNow });
  assert.equal(snapshot.snapshotRun.freshness, 'STALE');
  assert.equal(snapshot.snapshotRun.decisionEligible, false);
});
