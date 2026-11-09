const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  CANONICAL_SOURCE_TYPES,
  SAP_VERIFICATION_NOTE
} = require('../srv/canonicalSchemaMetadata');
const {
  applyFieldTransform,
  proposeFieldMappings
} = require('../srv/schemaMapper');
const {
  parseStructuredFileBuffer
} = require('../srv/connectors/fileConnector');
const {
  ensureDefaultEnterpriseSources,
  getConnectorForType,
  syncSourceToCanonical
} = require('../srv/connectors/connectorRegistry');
const {
  listBusinessPartners,
  listExposureSnapshots,
  listFieldMappings,
  listRawPayloads
} = require('../srv/canonicalRepository');

test('all 6 canonical connector types implement IDataConnector and enforce SAP verified=false metadata', async () => {
  for (const sourceType of CANONICAL_SOURCE_TYPES) {
    const connector = getConnectorForType(sourceType);
    const health = await connector.testConnection({});
    assert.equal(health.connected, true);
    assert.equal(health.sapReference.verified, false);
    assert.equal(health.sapReference.verificationNote, SAP_VERIFICATION_NOTE);

    const discovery = await connector.discoverSchema({ source_id: `TEST-${sourceType}` });
    assert.ok(Array.isArray(discovery.proposedMappings));
    assert.ok(discovery.proposedMappings.length > 0);
    for (const mapping of discovery.proposedMappings) {
      assert.equal(mapping.sap_reference_verified, false);
      assert.equal(mapping.verification_note, SAP_VERIFICATION_NOTE);
      assert.ok(mapping.confidence >= 0.7 && mapping.confidence <= 1.0);
    }

    const fetched = await connector.fetchRecords({}, { limit: 5 });
    assert.ok(Array.isArray(fetched.records));
    assert.ok(fetched.records.length > 0);
  }
});

test('FileConnector parses CSV, OData V4 JSON, OData V2 JSON, and XML tabular exports', () => {
  const csvSample = [
    '"Customer ID","Company Name","Company Code","Country","Sanctioned Limit","Currency"',
    '"C901","Bharat Heavy Alloys, Ltd.","BS01","India","2,500,000.00","INR"',
    '"C902","Emirates Precision Trading","BS02","UAE","1,800,000.00","AED"'
  ].join('\r\n');

  const parsedCsv = parseStructuredFileBuffer({ text: csvSample, filename: 'erp_customers.csv' });
  assert.equal(parsedCsv.format, 'CSV');
  assert.equal(parsedCsv.rows.length, 2);
  assert.equal(parsedCsv.rows[0]['Company Name'], 'Bharat Heavy Alloys, Ltd.');

  const odataV2Sample = JSON.stringify({
    d: {
      results: [
        { __metadata: { type: 'BUT000' }, PARTNER: '100045', NAME_ORG1: 'Alpine Drives GmbH', BUKRS: 'BS05', LAND1: 'Germany' }
      ]
    }
  });
  const parsedOData = parseStructuredFileBuffer({ text: odataV2Sample, filename: 'sap_export.json' });
  assert.equal(parsedOData.format, 'JSON');
  assert.equal(parsedOData.rows.length, 1);
  assert.ok(!parsedOData.headers.includes('__metadata'));

  const xmlSample = `<Records><item><PARTNER>C905</PARTNER><NAME_ORG1>Pacific Cables</NAME_ORG1><BUKRS>BS03</BUKRS></item></Records>`;
  const parsedXml = parseStructuredFileBuffer({ text: xmlSample, filename: 'se16n.xml' });
  assert.equal(parsedXml.format, 'XML');
  assert.equal(parsedXml.rows.length, 1);
  assert.equal(parsedXml.rows[0].PARTNER, 'C905');
});

test('schemaMapper proposes high-confidence mappings and transforms SAP DATS, OData dates, and formatted decimals', () => {
  const discovery = proposeFieldMappings({
    sourceId: 'TEST-CSV',
    sourceEntity: 'CUSTOMERS_EXPORT',
    records: [
      {
        PARTNER: '4501',
        NAME_ORG1: 'Test Industrial Corp',
        BUKRS: 'BS01',
        LAND1: 'India',
        CREDIT_LIMIT: '1,250,000.50',
        WAERS: 'inr'
      }
    ]
  });

  assert.equal(discovery.detectedPrimaryEntity, 'CG_BUSINESS_PARTNER');
  assert.ok(discovery.candidateEntities.includes('CG_BUSINESS_PARTNER'));
  assert.ok(discovery.candidateEntities.includes('CG_BP_CREDIT_SEGMENT'));

  assert.equal(applyFieldTransform('4501', 'PAD_LEFT_10'), '0000004501');
  assert.equal(applyFieldTransform('20261025', 'DATE_YYYYMMDD'), '2026-10-25');
  assert.equal(applyFieldTransform('/Date(1761350400000)/', 'DATE_YYYYMMDD'), '2025-10-25');
  assert.equal(applyFieldTransform('₹ 1,250,000.50', 'DECIMAL'), 1250000.5);
  assert.equal(applyFieldTransform('inr', 'CURRENCY_ISO'), 'INR');
  assert.equal(applyFieldTransform('X', 'BOOLEAN_FLAG'), true);
  assert.equal(applyFieldTransform('', 'BOOLEAN_FLAG'), null);
});

test('syncSourceToCanonical runs full RAW -> CANONICAL -> CALCULATION pipeline for CSV File and Mock SAP connectors', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  const sources = await ensureDefaultEnterpriseSources(db);
  assert.ok(sources.length >= 6);

  // 1. Sync combined Customer + Credit Limit CSV via FILE connector
  const csvPartners = [
    'PARTNER,NAME_ORG1,BUKRS,LAND1,CREDIT_LIMIT,WAERS,RISK_CLASS',
    'C801,Zenith Semiconductors,BS01,India,2000000,INR,A',
    'C802,Horizon Petrochem,BS02,UAE,1500000,INR,B'
  ].join('\n');

  const partnerSync = await syncSourceToCanonical(db, {
    sourceId: 'FILE-CSV-JSON-UPLOAD',
    sourceType: 'FILE',
    sourceEntity: 'CUSTOMERS_CSV',
    fileConfig: {
      filename: 'customers_batch.csv',
      rawContent: csvPartners
    }
  });

  assert.equal(partnerSync.counts.rawPayloadsSaved, 2);
  assert.equal(partnerSync.counts.partnersUpserted, 2);
  assert.equal(partnerSync.counts.segmentsUpserted, 2);
  assert.equal(partnerSync.counts.snapshotsUpdated, 2);

  // 2. Sync exposure items for C801 (Open Order 500,000 + Open Invoice 1,200,000 = 1,700,000 / 2,000,000 = 85% WARNING)
  const csvExposure = [
    'ITEM_KEY,PARTNER,BUKRS,COMM_TYP,OBJKEY,AMOUNT,WAERS,NETDT',
    'EXP-801-1,C801,BS01,OPEN_ORDER,SO-801,500000,INR,2026-11-15',
    'EXP-801-2,C801,BS01,OPEN_INVOICE,INV-801,1200000,INR,2026-03-01'
  ].join('\n');

  const exposureSync = await syncSourceToCanonical(db, {
    sourceId: 'FILE-CSV-JSON-UPLOAD',
    sourceType: 'FILE',
    sourceEntity: 'UKM_ITEM_CSV',
    targetCanonicalEntity: 'CG_CREDIT_EXPOSURE_ITEM',
    fileConfig: {
      filename: 'exposure_batch.csv',
      rawContent: csvExposure
    },
    referenceDate: '2026-04-16'
  });

  assert.equal(exposureSync.counts.exposureItemsUpserted, 2);
  assert.equal(exposureSync.counts.snapshotsUpdated, 1);

  const [rawPayloads, mappings, partners, snapshots] = await Promise.all([
    listRawPayloads(db, { sourceId: 'FILE-CSV-JSON-UPLOAD' }),
    listFieldMappings(db, { sourceId: 'FILE-CSV-JSON-UPLOAD' }),
    listBusinessPartners(db),
    listExposureSnapshots(db, { bpId: 'C801' })
  ]);

  assert.equal(rawPayloads.length, 4);
  assert.ok(mappings.length >= 4);
  assert.ok(partners.some(p => p.bp_id === 'C801' && p.bp_name === 'Zenith Semiconductors'));
  assert.equal(snapshots.length, 1);
  assert.equal(Number(snapshots[0].credit_limit), 2000000);
  assert.equal(Number(snapshots[0].open_orders_amount), 500000);
  assert.equal(Number(snapshots[0].open_ar_amount), 1200000);
  assert.equal(Number(snapshots[0].total_exposure), 1700000);
  assert.equal(Number(snapshots[0].available_credit), 300000);
  assert.equal(Number(snapshots[0].utilization_pct), 85);
  assert.equal(snapshots[0].threshold_status, 'WARNING');
});
