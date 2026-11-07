const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfiguredIngestionRuntime } = require('../srv/ingestionRuntime');
const { createPortfolioDataProvider } = require('../srv/portfolioDataProvider');
const { monitorPortfolio } = require('../srv/monitoringService');
const { ensureMockSapSource } = require('../srv/sourceRegistryStore');
const { createMonitoringDatabase } = require('./support/transactional-monitoring-db');

const entityTypes = ['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'PAYMENT'];
const admin = {
  id: 'mock-admin',
  is: role => role === 'CreditAdmin' || role === 'CreditReader'
};

function database() {
  return createMonitoringDatabase({
    tables: {
      'credit.DataSources': [],
      'credit.IngestionRuns': [],
      'credit.CanonicalRecords': [],
      'credit.IngestionQualityIssues': [],
      'credit.IngestionCheckpoints': [],
      'credit.IngestionSourceLocks': [],
      'credit.Customers': [],
      'credit.OpenItems': [],
      'credit.Payments': [],
      'credit.LimitRequests': []
    },
    uniqueFields: {
      'credit.DataSources': ['sourceId'],
      'credit.IngestionRuns': ['ID', 'idempotencyKey'],
      'credit.CanonicalRecords': ['ID'],
      'credit.IngestionQualityIssues': ['ID'],
      'credit.IngestionCheckpoints': ['sourceId', 'entityType'],
      'credit.IngestionSourceLocks': ['sourceId'],
      'credit.Customers': ['ID'],
      'credit.OpenItems': ['ID'],
      'credit.Payments': ['ID']
    }
  });
}

test('Mock SAP extraction projects business records atomically, supports dashboard and monitoring, and preserves existing limits', async () => {
  const db = database();
  const source = await ensureMockSapSource(db, new Date('2026-11-06T08:00:00.000Z'));
  const runtime = createConfiguredIngestionRuntime({
    db,
    settings: {},
    cdsEnvironment: { requires: {} }
  });
  const first = await runtime.run({
    user: admin,
    sourceId: source.sourceId,
    entityTypes,
    idempotencyKey: 'mock-sap-integration-1',
    now: () => new Date('2026-11-06T08:00:00.000Z')
  });

  assert.equal(first.run.status, 'SUCCEEDED_WITH_WARNINGS');
  assert.equal(first.run.snapshotPromoted, true);
  const counts = JSON.parse(first.run.rowCounts);
  assert.deepEqual(counts.mockProjection, {
    CUSTOMER: { sourceRecords: 4, inserted: 4, alreadyPresent: 0 },
    CREDIT_ACCOUNT: { sourceRecords: 4, applied: 4, alreadyPresent: 0 },
    INVOICE: { sourceRecords: 6, inserted: 6, alreadyPresent: 0 },
    PAYMENT: { sourceRecords: 4, inserted: 4, alreadyPresent: 0 }
  });
  assert.equal(db.tables['credit.Customers'].length, 4);
  assert.equal(db.tables['credit.OpenItems'].length, 6);
  assert.equal(db.tables['credit.Payments'].length, 4);
  assert.deepEqual(db.tables['credit.CanonicalRecords'].reduce((counts, row) => {
    counts[row.entityType] = (counts[row.entityType] || 0) + 1;
    return counts;
  }, {}), { CUSTOMER: 4, CREDIT_ACCOUNT: 4, INVOICE: 6, PAYMENT: 4 });

  const provider = createPortfolioDataProvider({ db, user: admin, source: 'local' });
  const dashboardCustomers = await provider.listCustomers();
  const risky = dashboardCustomers.find(customer => customer.ID === 'MS-C001');
  assert.equal(risky.exposure, 1200000);
  assert.equal(risky.creditLimit, 1000000);
  assert.equal(risky.overdueAmount, 400000);

  const monitoring = await monitorPortfolio({
    user: admin,
    provider: {
      async getSnapshot() {
        return {
          source: 'CAP database',
          retrievedAt: '2026-11-06T08:00:00.000Z',
          customers: await provider.listCustomers(),
          complete: true
        };
      }
    },
    now: new Date('2026-11-06T08:00:00.000Z')
  });
  const finding = monitoring.findings.find(item => item.customerId === 'MS-C001');
  assert.ok(finding);
  assert.ok(finding.conditions.includes('CRITICAL'));
  assert.ok(finding.conditions.includes('OVERDUE_RISK'));

  const customer = db.tables['credit.Customers'].find(row => row.ID === 'MS-C001');
  customer.creditLimit = '1500000.00';
  db.tables['credit.LimitRequests'].push({
    ID: 'MS-REQ-001',
    customer_ID: 'MS-C001',
    currentLimit: '1000000.00',
    requestedLimit: '1500000.00',
    status: 'APPROVED'
  });
  assert.ok(db.tables['credit.CanonicalRecords'].some(record =>
    record.sourceId === source.sourceId && record.entityType === 'CUSTOMER'
      && record.active === true && JSON.parse(record.canonicalData).customerId === 'MS-C001'));
  const second = await runtime.run({
    user: admin,
    sourceId: source.sourceId,
    entityTypes,
    idempotencyKey: 'mock-sap-integration-2',
    now: () => new Date('2026-11-06T08:05:00.000Z')
  });

  assert.equal(second.run.snapshotPromoted, true);
  assert.equal(db.tables['credit.Customers'].length, 4);
  assert.equal(db.tables['credit.OpenItems'].length, 6);
  assert.equal(db.tables['credit.Payments'].length, 4);
  assert.equal(customer.creditLimit, '1500000.00');
  assert.equal(db.tables['credit.LimitRequests'][0].status, 'APPROVED');
  const repeatCounts = JSON.parse(second.run.rowCounts).mockProjection;
  assert.equal(repeatCounts.CUSTOMER.inserted, 0);
  assert.equal(repeatCounts.CUSTOMER.alreadyPresent, 4);
  assert.equal(repeatCounts.INVOICE.inserted, 0);
  assert.equal(repeatCounts.PAYMENT.inserted, 0);
});

test('Mock SAP projection rejects an existing customer ID collision without modifying it', async () => {
  const db = database();
  db.tables['credit.Customers'].push({
    ID: 'MS-C001',
    name: 'Existing Credit Guard record',
    country: 'IN',
    companyCode: 'X001',
    currency: 'INR',
    creditLimit: '123.00',
    riskClass: 'A',
    lastReviewDate: '2026-01-01'
  });
  const source = await ensureMockSapSource(db, new Date('2026-11-06T08:00:00.000Z'));
  const runtime = createConfiguredIngestionRuntime({
    db,
    settings: {},
    cdsEnvironment: { requires: {} }
  });

  await assert.rejects(runtime.run({
    user: admin,
    sourceId: source.sourceId,
    entityTypes,
    idempotencyKey: 'mock-sap-collision',
    now: () => new Date('2026-11-06T08:00:00.000Z')
  }), { category: 'mock_projection_conflict' });

  assert.equal(db.tables['credit.Customers'].length, 1);
  assert.equal(db.tables['credit.Customers'][0].name, 'Existing Credit Guard record');
  assert.equal(db.tables['credit.Customers'][0].creditLimit, '123.00');
  assert.equal(db.tables['credit.CanonicalRecords'].length, 0);
  assert.equal(db.tables['credit.IngestionRuns'][0].status, 'FAILED');
});
