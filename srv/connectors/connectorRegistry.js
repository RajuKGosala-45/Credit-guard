const crypto = require('crypto');
const {
  CANONICAL_SOURCE_TYPES,
  SAP_VERIFICATION_NOTE
} = require('../canonicalSchemaMetadata');
const {
  buildDeterministicSnapshot,
  daysBetweenDates,
  insertRawPayload,
  listBusinessPartners,
  listCreditSegments,
  listDataSources,
  listExposureItems,
  listFieldMappings,
  listOpenReceivables,
  saveExposureSnapshot,
  saveFieldMappings,
  upsertBusinessPartner,
  upsertCreditSegment,
  upsertDataSource,
  upsertExposureItem,
  upsertOpenReceivable,
  upsertPaymentHistory
} = require('../canonicalRepository');
const {
  proposeFieldMappings,
  transformSourceRowToCanonical
} = require('../schemaMapper');
const { assertValidConnector } = require('./IDataConnector');
const { createFileConnector } = require('./fileConnector');
const { createMockSapConnector } = require('./mockSapConnector');
const { createRestApiConnector } = require('./restApiConnector');
const { createSapHanaConnector } = require('./sapHanaConnector');
const { createSapODataConnector } = require('./sapODataConnector');

const DEFAULT_ENTERPRISE_SOURCES = Object.freeze([
  {
    source_id: 'MOCK-SAP-FIN-FSCM',
    source_name: 'SAP S/4HANA FIN-FSCM-CR Seed Simulator (BUT000 / UKMBP_CMS_SGM / UKM_ITEM / ACDOCA)',
    source_type: 'MOCK_SAP',
    connection_config_ref: 'simulator:SAP_FIN_FSCM_CR',
    status: 'ACTIVE'
  },
  {
    source_id: 'FILE-CSV-JSON-UPLOAD',
    source_name: 'Structured ERP File Connector (CSV / TSV / JSON / XML / SE16N Export)',
    source_type: 'FILE',
    connection_config_ref: 'config:db/data/credit-Customers.csv',
    status: 'ACTIVE'
  },
  {
    source_id: 'SAP-S4-ODATA-V4',
    source_name: 'SAP S/4HANA Credit Management OData (API_CREDITMANAGEMENTACCOUNT_SRV)',
    source_type: 'SAP_ODATA',
    connection_config_ref: 'env:SAP_ODATA_BASE_URL',
    status: 'STANDBY'
  },
  {
    source_id: 'SAP-BTP-DEST-ABAP',
    source_name: 'SAP BTP Destination Service (ZUI_CREDIT_GUARD / FIN-FSCM-CR)',
    source_type: 'SAP_BTP_DEST',
    connection_config_ref: 'destination:SAP_BTP_DESTINATION_NAME',
    status: 'STANDBY'
  },
  {
    source_id: 'HANA-CLOUD-SLT',
    source_name: 'SAP HANA Cloud Replicated Tables (BUT000 / UKMBP_CMS_SGM / ACDOCA)',
    source_type: 'HANA',
    connection_config_ref: 'env:HANA_HOST',
    status: 'ACTIVE'
  },
  {
    source_id: 'EXTERNAL-REST-ERP',
    source_name: 'External ERP / Accounting REST API Connector',
    source_type: 'REST_API',
    connection_config_ref: 'env:REST_API_BASE_URL',
    status: 'STANDBY'
  }
]);

function getConnectorForType(sourceType, options = {}) {
  if (!CANONICAL_SOURCE_TYPES.includes(sourceType)) {
    const error = new TypeError(`Unsupported connector source_type: ${sourceType}`);
    error.statusCode = 400;
    throw error;
  }
  switch (sourceType) {
    case 'FILE':
      return assertValidConnector(createFileConnector(options), 'FILE');
    case 'SAP_ODATA':
      return assertValidConnector(createSapODataConnector({ ...options, connectorType: 'SAP_ODATA' }), 'SAP_ODATA');
    case 'SAP_BTP_DEST':
      return assertValidConnector(createSapODataConnector({ ...options, connectorType: 'SAP_BTP_DEST' }), 'SAP_BTP_DEST');
    case 'HANA':
      return assertValidConnector(createSapHanaConnector(options), 'HANA');
    case 'REST_API':
      return assertValidConnector(createRestApiConnector(options), 'REST_API');
    case 'MOCK_SAP':
      return assertValidConnector(createMockSapConnector(options), 'MOCK_SAP');
    default:
      throw new TypeError(`Unhandled connector source_type: ${sourceType}`);
  }
}

async function ensureDefaultEnterpriseSources(db) {
  const existing = await listDataSources(db);
  const existingIds = new Set(existing.map(s => s.source_id));
  for (const def of DEFAULT_ENTERPRISE_SOURCES) {
    if (!existingIds.has(def.source_id)) {
      await upsertDataSource(db, def);
    }
  }
  return listDataSources(db);
}

function normalizeExposureCategory(rawCategory) {
  const val = String(rawCategory || '').toUpperCase().trim();
  if (val.includes('ORDER') || val === '100') return 'OPEN_ORDER';
  if (val.includes('DELIV') || val === '400') return 'OPEN_DELIVERY';
  if (val.includes('BILL') || val === '500') return 'OPEN_BILLING';
  return 'OPEN_INVOICE';
}

async function syncSourceToCanonical(db, {
  sourceId = 'MOCK-SAP-FIN-FSCM',
  sourceType = null,
  sourceEntity = 'BUT000',
  targetCanonicalEntity = null,
  fileConfig = null,
  customMappings = null,
  referenceDate = '2026-04-16'
} = {}) {
  await ensureDefaultEnterpriseSources(db);
  const sources = await listDataSources(db);
  let sourceRecord = sources.find(s => s.source_id === sourceId);

  if (!sourceRecord) {
    sourceRecord = await upsertDataSource(db, {
      source_id: sourceId,
      source_name: fileConfig?.filename ? `File Import (${fileConfig.filename})` : sourceId,
      source_type: sourceType || (fileConfig ? 'FILE' : 'MOCK_SAP'),
      connection_config_ref: fileConfig?.filename ? `file:${fileConfig.filename}` : `config:${sourceId}`,
      status: 'ACTIVE'
    });
  }

  const connector = getConnectorForType(sourceType || sourceRecord.source_type);
  const configPayload = {
    ...sourceRecord,
    ...(fileConfig || {})
  };

  // 1. Discover schema & mappings if none provided
  const discovery = await connector.discoverSchema(configPayload, {
    sourceEntity,
    targetCanonicalEntity
  });

  let activeMappings = Array.isArray(customMappings) && customMappings.length
    ? await saveFieldMappings(db, sourceRecord.source_id, customMappings)
    : await listFieldMappings(db, { sourceId: sourceRecord.source_id });

  if (!activeMappings.length || (fileConfig && !customMappings)) {
    activeMappings = await saveFieldMappings(db, sourceRecord.source_id, discovery.proposedMappings);
  }

  // 2. Fetch raw records from connector
  const fetched = await connector.fetchRecords(configPayload, {
    entity: sourceEntity,
    limit: 5000
  });

  const syncBatchId = `SYNC-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  let rawPayloadsSaved = 0;
  let partnersUpserted = 0;
  let segmentsUpserted = 0;
  let exposureItemsUpserted = 0;
  let receivablesUpserted = 0;
  let paymentsUpserted = 0;
  const touchedBpIds = new Set();

  for (let i = 0; i < fetched.records.length; i += 1) {
    const rawRow = fetched.records[i];
    await insertRawPayload(db, {
      source_id: sourceRecord.source_id,
      entity_type: discovery.detectedPrimaryEntity || sourceEntity,
      raw_json: rawRow,
      ingested_at: nowIso,
      sync_batch_id: syncBatchId
    });
    rawPayloadsSaved += 1;

    // Transform according to active mappings for each candidate canonical entity
    const mappedPartner = transformSourceRowToCanonical(rawRow, activeMappings, 'CG_BUSINESS_PARTNER');
    if (mappedPartner.bp_id && mappedPartner.bp_name) {
      await upsertBusinessPartner(db, {
        ...mappedPartner,
        source_id: sourceRecord.source_id,
        updated_at: nowIso
      });
      partnersUpserted += 1;
      touchedBpIds.add(mappedPartner.bp_id);
    }

    const mappedSegment = transformSourceRowToCanonical(rawRow, activeMappings, 'CG_BP_CREDIT_SEGMENT');
    const segmentBpId = mappedSegment.bp_id || mappedPartner.bp_id;
    if (segmentBpId && mappedSegment.credit_limit !== undefined) {
      await upsertCreditSegment(db, {
        ...mappedSegment,
        bp_id: segmentBpId,
        credit_segment: mappedSegment.credit_segment || mappedPartner.credit_segment || 'MAIN',
        currency: mappedSegment.currency || mappedPartner.currency || 'INR',
        risk_class: mappedSegment.risk_class || mappedPartner.risk_class || 'B',
        source_id: sourceRecord.source_id,
        updated_at: nowIso
      });
      segmentsUpserted += 1;
      touchedBpIds.add(segmentBpId);
    }

    const mappedExposure = transformSourceRowToCanonical(rawRow, activeMappings, 'CG_CREDIT_EXPOSURE_ITEM');
    if (mappedExposure.bp_id && mappedExposure.amount !== undefined) {
      const itemId = mappedExposure.item_id || `${sourceRecord.source_id}-EXP-${i + 1}`;
      const category = normalizeExposureCategory(mappedExposure.exposure_category);
      const isOverdue = Boolean(mappedExposure.due_date && mappedExposure.due_date < referenceDate);
      const daysOverdue = isOverdue ? daysBetweenDates(mappedExposure.due_date, referenceDate) : 0;
      await upsertExposureItem(db, {
        ...mappedExposure,
        item_id: itemId,
        exposure_category: category,
        source_doc_number: mappedExposure.source_doc_number || itemId,
        source_doc_type: mappedExposure.exposure_category || category,
        is_overdue: isOverdue,
        days_overdue: daysOverdue,
        source_id: sourceRecord.source_id,
        updated_at: nowIso
      });
      exposureItemsUpserted += 1;
      touchedBpIds.add(mappedExposure.bp_id);
    }

    const mappedReceivable = transformSourceRowToCanonical(rawRow, activeMappings, 'CG_OPEN_RECEIVABLE');
    if (mappedReceivable.bp_id && mappedReceivable.amount_doc_curr !== undefined) {
      const recId = mappedReceivable.receivable_id
        || mappedReceivable.accounting_doc_no
        || `${sourceRecord.source_id}-REC-${i + 1}`;
      await upsertOpenReceivable(db, {
        ...mappedReceivable,
        receivable_id: recId,
        accounting_doc_no: mappedReceivable.accounting_doc_no || recId,
        source_id: sourceRecord.source_id,
        updated_at: nowIso
      });
      receivablesUpserted += 1;
      touchedBpIds.add(mappedReceivable.bp_id);
    }

    const mappedPayment = transformSourceRowToCanonical(rawRow, activeMappings, 'CG_PAYMENT_HISTORY');
    if (mappedPayment.bp_id && mappedPayment.amount !== undefined && mappedPayment.payment_date) {
      const payId = mappedPayment.payment_id || `${sourceRecord.source_id}-PMT-${i + 1}`;
      await upsertPaymentHistory(db, {
        ...mappedPayment,
        payment_id: payId,
        payment_doc_no: mappedPayment.payment_doc_no || payId,
        source_id: sourceRecord.source_id,
        updated_at: nowIso
      });
      paymentsUpserted += 1;
      touchedBpIds.add(mappedPayment.bp_id);
    }
  }

  // 3. Recompute deterministic CG_EXPOSURE_SNAPSHOT for all touched Business Partners
  const allPartners = await listBusinessPartners(db);
  const allSegments = await listCreditSegments(db);
  const allExposureItems = await listExposureItems(db);
  const allReceivables = await listOpenReceivables(db);

  const targetPartners = touchedBpIds.size > 0
    ? allPartners.filter(p => touchedBpIds.has(p.bp_id))
    : allPartners;

  let snapshotsUpdated = 0;
  for (const partner of targetPartners) {
    const segment = allSegments.find(s => s.bp_id === partner.bp_id) || {
      bp_id: partner.bp_id,
      credit_segment: partner.credit_segment || 'MAIN',
      credit_limit: 0,
      credit_blocked: false
    };
    const bpExposureItems = allExposureItems.filter(e => e.bp_id === partner.bp_id);
    const bpReceivables = allReceivables.filter(r => r.bp_id === partner.bp_id);
    const snap = buildDeterministicSnapshot({
      partner,
      segment,
      exposureItems: bpExposureItems,
      openReceivables: bpReceivables,
      referenceDate
    });
    await saveExposureSnapshot(db, snap);
    snapshotsUpdated += 1;
  }

  // Update source last_sync_at
  await upsertDataSource(db, {
    ...sourceRecord,
    status: 'ACTIVE',
    last_sync_at: nowIso
  });

  return {
    sourceId: sourceRecord.source_id,
    sourceType: sourceRecord.source_type,
    syncBatchId,
    syncedAt: nowIso,
    sapVerificationNote: SAP_VERIFICATION_NOTE,
    counts: {
      rawPayloadsSaved,
      partnersUpserted,
      segmentsUpserted,
      exposureItemsUpserted,
      receivablesUpserted,
      paymentsUpserted,
      snapshotsUpdated
    }
  };
}

module.exports = {
  DEFAULT_ENTERPRISE_SOURCES,
  ensureDefaultEnterpriseSources,
  getConnectorForType,
  syncSourceToCanonical
};
