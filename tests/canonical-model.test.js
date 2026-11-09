const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  getPublicDatabaseStatus,
  resolveDatabaseConfig
} = require('../srv/hanaConnection');
const {
  CANONICAL_TABLES,
  DEFAULT_SAP_FIELD_MAPPINGS,
  SAP_VERIFICATION_NOTE
} = require('../srv/canonicalSchemaMetadata');
const {
  insertRawPayload,
  listBusinessPartners,
  listCanonicalLimitRequests,
  listCreditSegments,
  listDataSources,
  listExposureItems,
  listExposureSnapshots,
  listFieldMappings,
  listOpenReceivables,
  listPaymentHistory,
  listRawPayloads,
  seedCanonicalFromLegacyDemo,
  upsertDataSource
} = require('../srv/canonicalRepository');

test('resolveDatabaseConfig falls back to SQLITE_FALLBACK when HANA env vars are absent', () => {
  const resolved = resolveDatabaseConfig({});
  assert.equal(resolved.mode, 'SQLITE_FALLBACK');
  assert.equal(resolved.configured, false);
  assert.equal(resolved.credentials, null);
  assert.ok(resolved.missingEnvVars.includes('HANA_HOST'));
});

test('resolveDatabaseConfig detects HANA_CLOUD when HANA env vars are provided and hides secrets in public status', () => {
  const env = {
    HANA_HOST: 'example.hana.prod-ap11.hanacloud.ondemand.com',
    HANA_PORT: '443',
    HANA_USER: 'DBADMIN',
    HANA_PASSWORD: 'test-env-only-secret',
    HANA_SCHEMA: 'CREDIT_GUARD_HDI',
    HANA_ENCRYPT: 'true'
  };
  const resolved = resolveDatabaseConfig(env);
  assert.equal(resolved.mode, 'HANA_CLOUD');
  assert.equal(resolved.configured, true);
  assert.equal(resolved.encrypt, true);

  const publicStatus = getPublicDatabaseStatus(env);
  assert.equal(publicStatus.mode, 'HANA_CLOUD');
  assert.equal(publicStatus.hanaConfigured, true);
  assert.equal(publicStatus.password, undefined);
  assert.equal(publicStatus.credentials, undefined);
});

test('all SAP table and field references carry verified=false and standard verification note', () => {
  for (const [, tableMeta] of Object.entries(CANONICAL_TABLES)) {
    if (tableMeta.sapReference) {
      assert.equal(tableMeta.sapReference.verified, false);
      assert.equal(tableMeta.sapReference.verificationNote, SAP_VERIFICATION_NOTE);
    }
  }
  assert.ok(DEFAULT_SAP_FIELD_MAPPINGS.length >= 10);
  for (const mapping of DEFAULT_SAP_FIELD_MAPPINGS) {
    assert.equal(mapping.verified, false);
    assert.equal(mapping.verification_note, SAP_VERIFICATION_NOTE);
  }
});

test('canonical repository persists and queries all 10 CG_* FIN-FSCM-CR entities', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  const summary = await seedCanonicalFromLegacyDemo(db, { referenceDate: '2026-04-16' });
  assert.equal(summary.businessPartnersSeeded, 13);
  assert.equal(summary.snapshotsCalculated, 13);

  const rawPayload = await insertRawPayload(db, {
    source_id: summary.sourceId,
    entity_type: 'CG_BUSINESS_PARTNER',
    raw_json: { bp_id: 'C001', bp_name: 'Aarav Components' },
    sync_batch_id: 'BATCH-TEST-001'
  });
  assert.ok(rawPayload.payload_id);
  assert.equal(rawPayload.row_hash.length, 64);

  const [
    sources,
    mappings,
    rawPayloads,
    partners,
    segments,
    exposureItems,
    receivables,
    payments,
    snapshots,
    requests
  ] = await Promise.all([
    listDataSources(db),
    listFieldMappings(db, { sourceId: summary.sourceId }),
    listRawPayloads(db, { syncBatchId: 'BATCH-TEST-001' }),
    listBusinessPartners(db),
    listCreditSegments(db),
    listExposureItems(db),
    listOpenReceivables(db),
    listPaymentHistory(db),
    listExposureSnapshots(db),
    listCanonicalLimitRequests(db)
  ]);

  assert.ok(sources.length >= 1);
  assert.equal(mappings.length, DEFAULT_SAP_FIELD_MAPPINGS.length);
  assert.ok(mappings.every(m => m.sap_reference_verified === false));
  assert.ok(mappings.every(m => m.verification_note === SAP_VERIFICATION_NOTE));
  assert.equal(rawPayloads.length, 1);
  assert.equal(partners.length, 13);
  assert.equal(segments.length, 13);
  assert.ok(exposureItems.length >= 20);
  assert.ok(receivables.length >= 15);
  assert.ok(payments.length >= 10);
  assert.equal(snapshots.length, 13);
  assert.ok(Array.isArray(requests));

  const c001Snapshot = snapshots.find(s => s.bp_id === 'C001');
  assert.ok(c001Snapshot);
  assert.equal(Number(c001Snapshot.credit_limit), 1000000);
  assert.equal(Number(c001Snapshot.total_exposure), 1200000);
  assert.equal(Number(c001Snapshot.available_credit), -200000);
  assert.equal(Number(c001Snapshot.utilization_pct), 120);
  assert.equal(c001Snapshot.threshold_status, 'BREACH');

  await assert.rejects(
    () => upsertDataSource(db, {
      source_id: 'BAD-SRC',
      source_name: 'Bad Source',
      source_type: 'INVALID_TYPE',
      connection_config_ref: 'env:TEST'
    }),
    /Unsupported canonical source_type/
  );
});
