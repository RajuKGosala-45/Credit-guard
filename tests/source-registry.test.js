const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentCustomerProvider } = require('../srv/integrations/abap/customer-provider');
const {
  ENTITY_TYPES,
  detectDuplicateSourceIdentities,
  mapCanonicalRecord,
  validateCanonicalRecord,
  validateProvenance
} = require('../srv/canonicalData');
const { SOURCE_TYPES, createSourceRegistry } = require('../srv/sourceRegistry');

const now = () => new Date('2026-11-05T00:00:00.000Z');
const sourceDefinition = overrides => ({
  sourceId: 'sap-main',
  sourceName: 'Approved SAP source',
  sourceType: 'SAP_S4HANA_ODATA',
  enabled: true,
  supportedEntities: ['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE'],
  mappingVersion: 'v1',
  authenticationReference: 'destination:approved-sap',
  configurationReference: 'config:approved-sap',
  ...overrides
});
const provenance = overrides => ({
  sourceId: 'sap-main',
  sourceEntity: 'Customers',
  sourceRecordId: 'C1001',
  retrievedAt: '2026-11-05T00:00:00.000Z',
  mappingVersion: 'v1',
  ...overrides
});
const issueCodes = result => result.issues.map(item => item.code);

test('source registry accepts approved source metadata and owns timestamps', () => {
  const registry = createSourceRegistry({ now });
  const source = registry.register(sourceDefinition());

  assert.deepEqual(source.supportedEntities, ['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE']);
  assert.equal(source.createdAt, '2026-11-05T00:00:00.000Z');
  assert.equal(source.updatedAt, source.createdAt);
  assert.deepEqual(SOURCE_TYPES, [
    'SAP_S4HANA_ODATA',
    'SQL_DATABASE',
    'SAP_HANA',
    'REST_API',
    'CSV_XLSX',
    'JSON_XML'
  ]);
  for (const [index, sourceType] of SOURCE_TYPES.entries()) {
    registry.register(sourceDefinition({ sourceId: `source-${index}`, sourceType }));
  }
  assert.deepEqual(ENTITY_TYPES.includes('PAYMENT_ALLOCATION'), true);
});

test('source registry rejects unknown types, malformed metadata, and embedded configuration values', () => {
  const registry = createSourceRegistry({ now });

  for (const invalid of [
    sourceDefinition({ sourceType: 'UNKNOWN' }),
    sourceDefinition({ enabled: 'true' }),
    sourceDefinition({ supportedEntities: ['CUSTOMER', 'CUSTOMER'] }),
    sourceDefinition({ supportedEntities: ['UNRECOGNIZED'] }),
    sourceDefinition({ configurationReference: 'https://example.invalid/source' }),
    sourceDefinition({ authenticationReference: 'password-value' }),
    { ...sourceDefinition(), password: 'must-not-be-stored' },
    { ...sourceDefinition(), endpoint: 'https://example.invalid' },
    { ...sourceDefinition(), sql: 'SELECT * FROM Customers' }
  ]) {
    assert.throws(() => registry.register(invalid), TypeError);
  }
  assert.equal(registry.list().length, 0);
});

test('source registry allows reference-only auth, rejects duplicate IDs, and does not expose credentials', () => {
  const registry = createSourceRegistry({ now });
  const registered = registry.register(sourceDefinition({ authenticationReference: null }));

  assert.equal(registered.authenticationReference, null);
  assert.equal(JSON.stringify(registered).includes('password'), false);
  assert.throws(() => registry.register(sourceDefinition({ authenticationReference: null })), {
    statusCode: 409
  });
});

test('source registry rejects unknown, disabled, or unsupported selections', () => {
  const registry = createSourceRegistry({ now });
  registry.register(sourceDefinition());
  registry.register(sourceDefinition({ sourceId: 'disabled', enabled: false }));

  assert.throws(() => registry.select('missing'), { statusCode: 404 });
  assert.throws(() => registry.select('disabled'), { statusCode: 409 });
  assert.throws(() => registry.select('sap-main', 'PAYMENT'), { statusCode: 400 });
  assert.equal(registry.select('sap-main', 'CUSTOMER').sourceId, 'sap-main');
});

test('source registry updates enabled state and returns defensive copies', () => {
  const registry = createSourceRegistry({ now });
  registry.register(sourceDefinition());
  const selected = registry.select('sap-main');
  selected.supportedEntities.push('PAYMENT');
  assert.equal(registry.select('sap-main').supportedEntities.includes('PAYMENT'), false);

  const disabled = registry.update('sap-main', { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.throws(() => registry.select('sap-main'), { statusCode: 409 });
  assert.throws(() => registry.update('sap-main', { sourceId: 'other' }), TypeError);
  assert.throws(() => registry.update('missing', { enabled: false }), { statusCode: 404 });
});

test('canonical customer mapping preserves source IDs and provenance', () => {
  const result = mapCanonicalRecord('CUSTOMER', {
    Id: 'C1001',
    Name: 'Example Customer',
    Company: '1000'
  }, {
    customerId: 'Id',
    sourceCustomerId: 'Id',
    customerName: 'Name',
    companyCode: 'Company'
  }, provenance());

  assert.equal(result.valid, true);
  assert.deepEqual(result.record, {
    customerId: 'C1001',
    sourceCustomerId: 'C1001',
    customerName: 'Example Customer',
    companyCode: '1000',
    provenance: provenance()
  });
});

test('canonical credit account mapping preserves decimal text and currency', () => {
  const result = mapCanonicalRecord('CREDIT_ACCOUNT', {
    Account: 'A-1',
    Customer: 'C1001',
    Limit: '12345678901234567890.123456789',
    Currency: 'EUR',
    Segment: 'S1'
  }, {
    accountId: 'Account',
    customerId: 'Customer',
    creditLimit: 'Limit',
    currency: 'Currency',
    creditSegment: 'Segment'
  }, provenance({ sourceEntity: 'CreditAccounts', sourceRecordId: 'A-1' }));

  assert.equal(result.valid, true);
  assert.equal(result.record.creditLimit, '12345678901234567890.123456789');
  assert.equal(result.record.currency, 'EUR');
});

test('canonical invoice and sales order mapping validates amounts without arithmetic', () => {
  const invoice = mapCanonicalRecord('INVOICE', {
    Document: 'INV-1',
    Item: '10',
    Customer: 'C1001',
    Type: 'INVOICE',
    Original: '50.000',
    Outstanding: '12.125',
    Currency: 'EUR',
    Due: '2026-12-01',
    Status: 'PARTIALLY_PAID'
  }, {
    sourceDocumentId: 'Document',
    documentItemId: 'Item',
    customerId: 'Customer',
    documentType: 'Type',
    originalAmount: 'Original',
    outstandingAmount: 'Outstanding',
    currency: 'Currency',
    dueDate: 'Due',
    paymentStatus: 'Status'
  }, provenance({ sourceEntity: 'Invoices', sourceRecordId: 'INV-1' }));
  const order = mapCanonicalRecord('SALES_ORDER', {
    Order: 'SO-1',
    Item: '20',
    Customer: 'C1001',
    Amount: '15.125',
    Currency: 'EUR',
    Status: 'OPEN'
  }, {
    orderId: 'Order',
    itemId: 'Item',
    customerId: 'Customer',
    creditRelevantAmount: 'Amount',
    currency: 'Currency',
    lifecycleStatus: 'Status'
  }, provenance({ sourceEntity: 'SalesOrders', sourceRecordId: 'SO-1' }));

  assert.equal(invoice.valid, true);
  assert.equal(invoice.record.originalAmount, '50.000');
  assert.equal(invoice.record.outstandingAmount, '12.125');
  assert.equal(order.valid, true);
  assert.equal(order.record.creditRelevantAmount, '15.125');
});

test('canonical payment and allocation mapping preserves exact amounts and references', () => {
  const payment = mapCanonicalRecord('PAYMENT', {
    Id: 'PAY-1',
    Customer: 'C1001',
    Amount: '9.999',
    Currency: 'USD',
    Date: '2026-11-01',
    Status: 'POSTED'
  }, {
    paymentId: 'Id',
    customerId: 'Customer',
    amount: 'Amount',
    currency: 'Currency',
    postingDate: 'Date',
    paymentStatus: 'Status'
  }, provenance({ sourceEntity: 'Payments', sourceRecordId: 'PAY-1' }));
  const allocation = mapCanonicalRecord('PAYMENT_ALLOCATION', {
    Id: 'ALLOC-1',
    Payment: 'PAY-1',
    Invoice: 'INV-1',
    Amount: '2.345',
    Currency: 'USD',
    Status: 'ALLOCATED'
  }, {
    allocationId: 'Id',
    paymentId: 'Payment',
    invoiceId: 'Invoice',
    allocatedAmount: 'Amount',
    currency: 'Currency',
    allocationStatus: 'Status'
  }, provenance({ sourceEntity: 'Allocations', sourceRecordId: 'ALLOC-1' }));

  assert.equal(payment.valid, true);
  assert.equal(payment.record.amount, '9.999');
  assert.equal(allocation.valid, true);
  assert.equal(allocation.record.allocatedAmount, '2.345');
});

test('mapping reports missing mandatory fields and does not fabricate optional source values', () => {
  const result = mapCanonicalRecord('CUSTOMER', { Id: 'C1' }, {
    customerId: 'Id',
    sourceCustomerId: 'MissingCustomer',
    customerName: 'MissingName',
    companyCode: 'MissingCompany'
  }, provenance());

  assert.equal(result.valid, false);
  assert.equal(result.record, null);
  assert.ok(issueCodes(result).includes('MISSING_REQUIRED_FIELD'));
  assert.ok(issueCodes(result).includes('OPTIONAL_FIELD_MISSING'));
  assert.equal(result.issues.some(item => Object.hasOwn(item, 'value')), false);
});

test('canonical validation rejects invalid decimal values, currencies, and calendar dates', () => {
  const invalid = validateCanonicalRecord('CREDIT_ACCOUNT', {
    accountId: 'A-1',
    customerId: 'C1',
    creditLimit: 0.1,
    currency: 'usd',
    provenance: provenance({ sourceEntity: 'CreditAccounts', sourceRecordId: 'A-1' })
  });

  assert.equal(invalid.valid, false);
  assert.ok(issueCodes(invalid).includes('INVALID_DECIMAL'));
  assert.ok(issueCodes(invalid).includes('INVALID_CURRENCY'));

  const badDate = validateCanonicalRecord('INVOICE', {
    sourceDocumentId: 'INV-1',
    customerId: 'C1',
    documentType: 'INVOICE',
    originalAmount: '1.00',
    outstandingAmount: '1.00',
    currency: 'EUR',
    dueDate: '2026-02-30',
    paymentStatus: 'OPEN',
    provenance: provenance({ sourceEntity: 'Invoices', sourceRecordId: 'INV-1' })
  });
  assert.ok(issueCodes(badDate).includes('INVALID_DATE'));

  const badPostingDate = validateCanonicalRecord('PAYMENT', {
    paymentId: 'PAY-1',
    customerId: 'C1',
    amount: '1.00',
    currency: 'EUR',
    postingDate: '2026-02-30',
    paymentStatus: 'POSTED',
    provenance: provenance({ sourceEntity: 'Payments', sourceRecordId: 'PAY-1' })
  });
  assert.ok(issueCodes(badPostingDate).includes('INVALID_DATE'));
});

test('canonical validation requires complete provenance and preserves optional missing timestamps', () => {
  const missing = validateProvenance({
    sourceId: 'sap-main',
    sourceEntity: 'Customers',
    retrievedAt: '2026-11-05T00:00:00.000Z'
  });
  assert.ok(missing.some(item => item.code === 'MISSING_PROVENANCE' && item.field === 'provenance.sourceRecordId'));

  const valid = validateCanonicalRecord('CUSTOMER', {
    customerId: 'C1',
    sourceCustomerId: 'SOURCE-C1',
    customerName: 'Example',
    provenance: provenance()
  });
  assert.equal(valid.valid, true);
  assert.equal(Object.hasOwn(provenance(), 'sourceUpdatedAt'), false);
  assert.equal(Object.hasOwn(provenance(), 'ingestedAt'), false);
  assert.equal(Object.hasOwn(provenance(), 'ingestionRunId'), false);
});

test('source identity detection distinguishes exact duplicates from conflicts', () => {
  const base = {
    customerId: 'C1',
    sourceCustomerId: 'SOURCE-C1',
    customerName: 'Example',
    provenance: provenance()
  };
  const exact = {
    ...base,
    provenance: provenance({ retrievedAt: '2026-11-05T01:00:00.000Z' })
  };
  const conflict = { ...base, customerName: 'Different name' };
  const result = detectDuplicateSourceIdentities([base, exact, conflict]);

  assert.equal(result.valid, false);
  assert.ok(issueCodes(result).includes('DUPLICATE_SOURCE_IDENTITY'));
  assert.ok(issueCodes(result).includes('CONFLICTING_SOURCE_IDENTITY'));
});

test('existing local and ABAP source selection contract remains unchanged', () => {
  const abapClient = { getCreditExposure() {}, listCustomerAnalyses() {} };
  const local = createAgentCustomerProvider({ source: 'local' });
  const abap = createAgentCustomerProvider({ source: 'abap', abapClient });

  assert.equal(local.source, 'local');
  assert.equal(abap.source, 'abap');
  assert.throws(() => createAgentCustomerProvider({ source: 'unknown' }), {
    statusCode: 500
  });

  const previousSelection = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE;
  try {
    process.env.CREDIT_GUARD_AGENT_DATA_SOURCE = 'abap';
    assert.equal(createAgentCustomerProvider({ abapClient }).source, 'abap');
  } finally {
    if (previousSelection === undefined) delete process.env.CREDIT_GUARD_AGENT_DATA_SOURCE;
    else process.env.CREDIT_GUARD_AGENT_DATA_SOURCE = previousSelection;
  }
});
