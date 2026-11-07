const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../srv/integrations/mock-sap/fixtures.json');
const {
  createMockSapConnector,
  getMockSapSourceConfiguration,
  getMockSapSourceDefinition
} = require('../srv/integrations/mock-sap/connector');
const { mapCanonicalRecord } = require('../srv/canonicalData');

test('Mock SAP connector registers a synthetic-only source and validates each fixture entity', async () => {
  const connector = createMockSapConnector({
    now: () => new Date('2026-11-06T08:00:00.000Z')
  });
  const source = getMockSapSourceDefinition();
  const config = getMockSapSourceConfiguration();

  assert.equal(source.sourceId, fixture.source.systemId);
  assert.match(source.sourceName, /Mock SAP Simulator.*synthetic data only/);
  assert.equal(source.sourceType, 'MOCK_SAP_SIMULATOR');
  assert.equal(source.authenticationReference, null);
  assert.deepEqual(connector.capabilities().entities, Object.keys(fixture.entities));

  for (const entityType of source.supportedEntities) {
    const page = await connector.read({
      source,
      config,
      entityType,
      cursor: null,
      since: undefined,
      signal: new AbortController().signal
    });
    const entity = fixture.entities[entityType];
    assert.equal(page.complete, true);
    assert.equal(page.retrievedAt, '2026-11-06T08:00:00.000Z');
    assert.equal(page.records.length, entity.records.length);
    for (const record of page.records) {
      const mapped = mapCanonicalRecord(entityType, record, page.mapping, {
        sourceId: source.sourceId,
        sourceEntity: page.sourceEntity,
        sourceRecordId: record[page.sourceRecordIdField],
        retrievedAt: page.retrievedAt,
        mappingVersion: source.mappingVersion
      });
      assert.equal(mapped.valid, true, JSON.stringify(mapped.issues));
    }
  }
});

test('Mock SAP connector rejects altered source identity and incremental reads', async () => {
  const connector = createMockSapConnector();
  const source = getMockSapSourceDefinition();
  const config = getMockSapSourceConfiguration();

  await assert.rejects(connector.read({
    source: { ...source, sourceId: 'other-source' },
    config,
    entityType: 'CUSTOMER'
  }), { category: 'mock_sap_source_mismatch' });
  await assert.rejects(connector.read({
    source,
    config,
    entityType: 'CUSTOMER',
    cursor: 'next-page'
  }), { category: 'incremental_not_supported' });
});
