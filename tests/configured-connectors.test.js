const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFileRepositoryConnector,
  createRestConnector,
  createSqlConnector,
  parseCsv,
  parseFlatXml
} = require('../srv/configuredConnectors');
const { createAbapODataConnector } = require('../srv/connectorManager');
const { destinationHeaders } = require('../srv/ingestionRuntime');

const source = {
  sourceId: 'approved',
  sourceType: 'REST_API',
  enabled: true,
  supportedEntities: ['CUSTOMER'],
  authenticationReference: 'credential:approved',
  configurationReference: 'repository:approved'
};
const mapping = {
  sourceEntity: 'Customers',
  sourceRecordIdField: 'CustomerId',
  fields: {
    customerId: 'CustomerId',
    sourceCustomerId: 'CustomerId',
    customerName: 'CustomerName',
    companyCode: 'CompanyCode'
  }
};

test('CSV parser preserves quoted commas, escaped quotes, and embedded newlines', () => {
  assert.deepEqual(parseCsv(
    'ID,Name,Note\r\nC1,"Smith, Inc.","said ""hello"""\r\nC2,Multi,"one\ntwo"\r\n'
  ), [
    { ID: 'C1', Name: 'Smith, Inc.', Note: 'said "hello"' },
    { ID: 'C2', Name: 'Multi', Note: 'one\ntwo' }
  ]);
  assert.throws(() => parseCsv('ID,ID\n1,2'), { category: 'source_invalid_format' });
  assert.throws(() => parseCsv('ID,Name\n1,"unterminated'), { category: 'source_invalid_format' });
  assert.throws(() => parseCsv('ID,Name\n1,"quoted"tail'), { category: 'source_invalid_format' });
  assert.throws(() => parseCsv('ID\n1\n2', 1), { category: 'source_record_limit' });
});

test('flat XML parser reads configured row elements and rejects entity expansion and nested fields', () => {
  assert.deepEqual(parseFlatXml(
    '<Feed><row><CustomerId>C1</CustomerId><CustomerName>A &amp; B</CustomerName></row></Feed>',
    'row',
    10
  ), [{ CustomerId: 'C1', CustomerName: 'A & B' }]);
  assert.throws(() => parseFlatXml(
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><Feed/>',
    'row',
    10
  ), { category: 'source_invalid_format' });
  assert.throws(() => parseFlatXml(
    '<Feed><row><Name><First>A</First></Name></row></Feed>',
    'row',
    10
  ), { category: 'source_invalid_format' });
  assert.throws(() => parseFlatXml('<Feed/><Other/>', 'row', 10), {
    category: 'source_invalid_format'
  });
  assert.throws(() => parseFlatXml('<Feed><row broken></row></Feed>', 'row', 10), {
    category: 'source_invalid_format'
  });
});

test('file connector reads only through a trusted repository reference and parses CSV and JSON', async () => {
  const reads = [];
  let format = 'CSV';
  const connector = createFileRepositoryConnector({
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    readRepository: async (reference, options) => {
      reads.push({ reference, options });
      return {
        buffer: Buffer.from(format === 'CSV'
          ? 'CustomerId,CustomerName,CompanyCode\nC1,Customer One,1000\n'
          : JSON.stringify({ data: [{ CustomerId: 'C2', CustomerName: 'Customer Two', CompanyCode: '2000' }] })),
        format,
        sourceTimestamp: '2026-11-04T23:59:00.000Z',
        complete: true
      };
    }
  });
  const config = {
    entityMappings: {
      CUSTOMER: {
        ...mapping,
        recordsPath: 'data'
      }
    }
  };
  const csv = await connector.read({
    source: { ...source, sourceType: 'CSV_XLSX' },
    config,
    entityType: 'CUSTOMER',
    signal: new AbortController().signal
  });
  format = 'JSON';
  const json = await connector.read({
    source: { ...source, sourceType: 'JSON_XML' },
    config,
    entityType: 'CUSTOMER',
    signal: new AbortController().signal
  });

  assert.equal(csv.records[0].CustomerId, 'C1');
  assert.equal(json.records[0].CustomerId, 'C2');
  assert.equal(csv.complete, true);
  assert.equal(csv.retrievedAt, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(reads.map(item => item.reference), ['repository:approved', 'repository:approved']);
  assert.ok(reads.every(item => !Object.hasOwn(item.options, 'path')));
});

test('file connector parses XML and fails closed for XLSX without an approved parser', async () => {
  const connector = createFileRepositoryConnector({
    readRepository: async () => ({
      buffer: Buffer.from('<Feed><row><CustomerId>C1</CustomerId><CustomerName>One</CustomerName><CompanyCode>1</CompanyCode></row></Feed>'),
      format: 'XML',
      complete: true
    })
  });
  const xml = await connector.read({
    source: { ...source, sourceType: 'JSON_XML' },
    config: { entityMappings: { CUSTOMER: { ...mapping, rowElement: 'row' } } },
    entityType: 'CUSTOMER'
  });
  assert.equal(xml.records[0].CustomerId, 'C1');

  const xlsx = createFileRepositoryConnector({
    readRepository: async () => ({ buffer: Buffer.from('not interpreted'), format: 'XLSX', complete: true })
  });
  await assert.rejects(xlsx.read({
    source: { ...source, sourceType: 'CSV_XLSX' },
    config: { entityMappings: { CUSTOMER: mapping } },
    entityType: 'CUSTOMER'
  }), { category: 'xlsx_parser_unavailable', statusCode: 501 });
});

test('REST connector enforces HTTPS hostname allowlist, paging, watermark, and credential boundary', async () => {
  const requests = [];
  const connector = createRestConnector({
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    credentialResolver: async reference => {
      assert.equal(reference, 'credential:approved');
      return { authorization: 'Bearer test-secret' };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({
        data: [{ CustomerId: 'C1', CustomerName: 'One', CompanyCode: '1' }],
        next: 'page-2',
        asOf: '2026-11-04T23:00:00.000Z'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await connector.read({
    source,
    config: {
      allowedHosts: ['api.example.test'],
      entityMappings: {
        CUSTOMER: {
          ...mapping,
          endpoint: 'https://api.example.test/v1/customers',
          recordsPath: 'data',
          nextCursorPath: 'next',
          cursorParameter: 'cursor',
          watermarkParameter: 'updatedSince',
          sourceUpdatedAtField: 'UpdatedAt',
          sourceTimestampPath: 'asOf'
        }
      }
    },
    entityType: 'CUSTOMER',
    cursor: 'page-1',
    since: '2026-11-01T00:00:00.000Z',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000
  });

  const requested = new URL(requests[0].url);
  assert.equal(requested.hostname, 'api.example.test');
  assert.equal(requested.searchParams.get('cursor'), 'page-1');
  assert.equal(requested.searchParams.get('updatedSince'), '2026-11-01T00:00:00.000Z');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-secret');
  assert.equal(result.records[0].CustomerId, 'C1');
  assert.equal(result.sourceTimestamp, '2026-11-04T23:00:00.000Z');
  assert.equal(result.complete, false);

  await assert.rejects(connector.read({
    source,
    config: {
      allowedHosts: ['allowed.example.test'],
      entityMappings: {
        CUSTOMER: { ...mapping, endpoint: 'https://other.example.test/v1/customers' }
      }
    },
    entityType: 'CUSTOMER'
  }), { category: 'source_host_not_allowed' });
  await assert.rejects(destinationHeaders('credential:unapproved'), {
    category: 'source_authentication_unavailable'
  });
});

test('SQL connector uses parameterized CAP SELECT queries and bounded cursor paging', async () => {
  const queries = [];
  const connector = createSqlConnector({
    connect: async reference => {
      assert.equal(reference, 'config:approved');
      return {
        async run(query) {
          queries.push(query);
          const offset = query.SELECT.limit.offset?.val || 0;
          return offset === 0
            ? [{ CustomerId: 'C1', CustomerName: 'One', CompanyCode: '1', UpdatedAt: '2026-11-04T23:00:00.000Z' }]
            : [];
        }
      };
    },
    defaultPageSize: 1
  });
  const config = {
    entityMappings: {
      CUSTOMER: {
        ...mapping,
        databaseEntity: 'approved.Customers',
        sourceUpdatedAtField: 'UpdatedAt',
        sourceTimestampField: 'UpdatedAt'
      }
    }
  };
  const first = await connector.read({
    source: { ...source, sourceType: 'SQL_DATABASE', configurationReference: 'config:approved' },
    config,
    entityType: 'CUSTOMER',
    since: '2026-11-01T00:00:00.000Z',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000
  });
  const second = await connector.read({
    source: { ...source, sourceType: 'SQL_DATABASE', configurationReference: 'config:approved' },
    config,
    entityType: 'CUSTOMER',
    cursor: first.nextCursor,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000
  });

  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, '1');
  assert.equal(second.complete, true);
  assert.ok(queries.every(query => query.SELECT));
  assert.ok(queries[0].SELECT.where.some(item => item?.ref?.[0] === 'UpdatedAt'));
  assert.equal(queries[0].SELECT.from.ref[0], 'approved.Customers');
});

test('SAP adapter reuses the existing read-only OData collection client and configured entity paths', async () => {
  const reads = [];
  const client = {
    destinationName: 'test-sap',
    customersPath: 'sap/Customers',
    openItemsPath: 'sap/OpenItems',
    pageSize: 50,
    async readCollection(path, params, operation, options) {
      reads.push({ path, params, operation, options });
      return [{ CustomerId: 'C1', CustomerName: 'Customer One', CompanyCode: '1000' }];
    }
  };
  const connector = createAbapODataConnector({ client });
  const result = await connector.read({
    source: {
      sourceId: 'approved',
      sourceType: 'SAP_S4HANA_ODATA',
      authenticationReference: 'destination:test-sap'
    },
    config: {
      entityMappings: {
        CUSTOMER: {
          sourceEntity: 'Customers',
          sourceRecordIdField: 'CustomerId',
          fields: mapping.fields
        }
      }
    },
    entityType: 'CUSTOMER',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000
  });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].path, 'sap/Customers');
  assert.deepEqual(reads[0].params, { $top: 50 });
  assert.equal(reads[0].operation, 'ingest_customers');
  assert.equal(result.records[0].CustomerId, 'C1');
  assert.equal(result.complete, true);
  await assert.rejects(connector.read({
    source: { sourceId: 'approved', authenticationReference: 'destination:test-sap' },
    config: { entityMappings: { CUSTOMER: { ...mapping, sourceEntity: 'UnapprovedEntity' } } },
    entityType: 'CUSTOMER'
  }), { category: 'source_mapping_unavailable' });
});
