const crypto = require('crypto');
const cds = require('@sap/cds');
const { getDatabaseHandle } = require('./hanaConnection');
const {
  CANONICAL_SOURCE_TYPES,
  CANONICAL_TABLES,
  DEFAULT_SAP_FIELD_MAPPINGS,
  SAP_VERIFICATION_NOTE,
  createSapMappingEnvelope
} = require('./canonicalSchemaMetadata');
const {
  calculatePartnerExposureSnapshot,
  calculatePortfolioRollups,
  classifyThresholdStatus
} = require('./exposureCalculator');

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

function entityNames(db) {
  const entities = db?.model?.definitions || cds.model?.definitions || {};
  return {
    DataSources: entities['credit.CG_DATA_SOURCE'] ? 'credit.CG_DATA_SOURCE' : 'CG_DATA_SOURCE',
    FieldMappings: entities['credit.CG_FIELD_MAPPING'] ? 'credit.CG_FIELD_MAPPING' : 'CG_FIELD_MAPPING',
    RawPayloads: entities['credit.CG_RAW_PAYLOAD'] ? 'credit.CG_RAW_PAYLOAD' : 'CG_RAW_PAYLOAD',
    BusinessPartners: entities['credit.CG_BUSINESS_PARTNER'] ? 'credit.CG_BUSINESS_PARTNER' : 'CG_BUSINESS_PARTNER',
    CreditSegments: entities['credit.CG_BP_CREDIT_SEGMENT'] ? 'credit.CG_BP_CREDIT_SEGMENT' : 'CG_BP_CREDIT_SEGMENT',
    ExposureItems: entities['credit.CG_CREDIT_EXPOSURE_ITEM'] ? 'credit.CG_CREDIT_EXPOSURE_ITEM' : 'CG_CREDIT_EXPOSURE_ITEM',
    OpenReceivables: entities['credit.CG_OPEN_RECEIVABLE'] ? 'credit.CG_OPEN_RECEIVABLE' : 'CG_OPEN_RECEIVABLE',
    PaymentHistory: entities['credit.CG_PAYMENT_HISTORY'] ? 'credit.CG_PAYMENT_HISTORY' : 'CG_PAYMENT_HISTORY',
    ExposureSnapshots: entities['credit.CG_EXPOSURE_SNAPSHOT'] ? 'credit.CG_EXPOSURE_SNAPSHOT' : 'CG_EXPOSURE_SNAPSHOT',
    LimitRequests: entities['credit.CG_CREDIT_LIMIT_REQUEST'] ? 'credit.CG_CREDIT_LIMIT_REQUEST' : 'CG_CREDIT_LIMIT_REQUEST',
    LegacyCustomers: entities['credit.Customers'] ? 'credit.Customers' : 'Customers',
    LegacyOpenItems: entities['credit.OpenItems'] ? 'credit.OpenItems' : 'OpenItems',
    LegacyPayments: entities['credit.Payments'] ? 'credit.Payments' : 'Payments',
    LegacyLimitRequests: entities['credit.LimitRequests'] ? 'credit.LimitRequests' : 'LimitRequests'
  };
}

function roundCurrency(value) {
  const num = Number(value) || 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function sha256Hex(payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function daysBetweenDates(earlierDateStr, laterDateStr) {
  if (!earlierDateStr || !laterDateStr) return 0;
  const start = Date.parse(`${String(earlierDateStr).slice(0, 10)}T00:00:00.000Z`);
  const end = Date.parse(`${String(laterDateStr).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24)));
}

function evaluateDeterministicThreshold({ utilizationPct, creditBlocked = false }) {
  if (creditBlocked) return 'BLOCKED';
  const pct = Number(utilizationPct) || 0;
  if (pct > 100) return 'BREACH';
  if (pct >= 95) return 'CRITICAL';
  if (pct >= 80) return 'WARNING';
  return 'NORMAL';
}

async function upsertDataSource(rawDb, source) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  if (!source || typeof source.source_id !== 'string' || !source.source_id.trim()) {
    throw new TypeError('source_id is required.');
  }
  if (!CANONICAL_SOURCE_TYPES.includes(source.source_type)) {
    throw new TypeError(`Unsupported canonical source_type: ${source.source_type}`);
  }
  if (typeof source.connection_config_ref !== 'string' || !source.connection_config_ref.trim()) {
    throw new TypeError('connection_config_ref is required and must reference an env var or BTP Destination.');
  }
  const nowIso = new Date().toISOString();
  const existing = await db.run(
    SELECT.one.from(names.DataSources).where({ source_id: source.source_id })
  );
  const row = {
    source_id: source.source_id.trim(),
    source_name: String(source.source_name || source.source_id).trim(),
    source_type: source.source_type,
    connection_config_ref: source.connection_config_ref.trim(),
    status: source.status || 'ACTIVE',
    last_sync_at: source.last_sync_at ?? existing?.last_sync_at ?? null,
    created_at: existing?.created_at || source.created_at || nowIso
  };
  if (existing) {
    await db.run(UPDATE(names.DataSources).set(row).where({ source_id: row.source_id }));
  } else {
    await db.run(INSERT.into(names.DataSources).entries(row));
  }
  return row;
}

async function listDataSources(rawDb) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  return db.run(SELECT.from(names.DataSources).orderBy('source_id asc'));
}

async function saveFieldMappings(rawDb, sourceId, mappings = []) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const saved = [];

  for (const item of mappings) {
    const enveloped = createSapMappingEnvelope(item);
    const mappingId = enveloped.mapping_id
      || `${sourceId}:${enveloped.canonical_entity}:${enveloped.canonical_field}`;
    const row = {
      mapping_id: String(mappingId).slice(0, 64),
      source_id: sourceId,
      source_entity: String(enveloped.source_entity || 'DEFAULT').trim(),
      source_field: String(enveloped.source_field || enveloped.canonical_field).trim(),
      canonical_entity: String(enveloped.canonical_entity).trim(),
      canonical_field: String(enveloped.canonical_field).trim(),
      transform_rule: String(enveloped.transform_rule || 'NONE').trim(),
      confidence: Number(enveloped.confidence ?? 1.0),
      verified_by_user: Boolean(enveloped.verified_by_user === true),
      sap_reference_table: enveloped.sap_reference_table || null,
      sap_reference_field: enveloped.sap_reference_field || null,
      sap_reference_verified: Boolean(enveloped.sap_reference_verified === true),
      verification_note: enveloped.verification_note || SAP_VERIFICATION_NOTE,
      updated_at: nowIso
    };
    const existing = await db.run(
      SELECT.one.from(names.FieldMappings).where({ mapping_id: row.mapping_id })
    );
    if (existing) {
      await db.run(UPDATE(names.FieldMappings).set(row).where({ mapping_id: row.mapping_id }));
    } else {
      await db.run(INSERT.into(names.FieldMappings).entries(row));
    }
    saved.push(row);
  }
  return saved;
}

async function listFieldMappings(rawDb, { sourceId, canonicalEntity } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (sourceId) where.source_id = sourceId;
  if (canonicalEntity) where.canonical_entity = canonicalEntity;
  const query = Object.keys(where).length
    ? SELECT.from(names.FieldMappings).where(where).orderBy('mapping_id asc')
    : SELECT.from(names.FieldMappings).orderBy('mapping_id asc');
  return db.run(query);
}

async function insertRawPayload(rawDb, payload) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const rawJson = typeof payload.raw_json === 'string'
    ? payload.raw_json
    : JSON.stringify(payload.raw_json || {});
  const row = {
    payload_id: payload.payload_id || crypto.randomUUID(),
    source_id: payload.source_id,
    entity_type: payload.entity_type,
    raw_json: rawJson,
    ingested_at: payload.ingested_at || new Date().toISOString(),
    row_hash: payload.row_hash || sha256Hex(rawJson),
    sync_batch_id: payload.sync_batch_id || 'BATCH-INIT'
  };
  await db.run(INSERT.into(names.RawPayloads).entries(row));
  return row;
}

async function listRawPayloads(rawDb, { sourceId, syncBatchId } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (sourceId) where.source_id = sourceId;
  if (syncBatchId) where.sync_batch_id = syncBatchId;
  const query = Object.keys(where).length
    ? SELECT.from(names.RawPayloads).where(where).orderBy('ingested_at desc')
    : SELECT.from(names.RawPayloads).orderBy('ingested_at desc');
  return db.run(query);
}

async function upsertBusinessPartner(rawDb, partner) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const row = {
    bp_id: String(partner.bp_id).trim(),
    source_id: String(partner.source_id || 'LOCAL-CANONICAL').trim(),
    external_bp_number: String(partner.external_bp_number || partner.bp_id).trim(),
    bp_name: String(partner.bp_name).trim(),
    country_code: String(partner.country_code || 'India').trim(),
    company_code: String(partner.company_code || '1000').trim(),
    risk_class: partner.risk_class ? String(partner.risk_class).trim() : 'B',
    credit_segment: String(partner.credit_segment || 'MAIN').trim(),
    currency: String(partner.currency || 'INR').trim(),
    status: String(partner.status || 'ACTIVE').trim(),
    updated_at: partner.updated_at || nowIso
  };
  const existing = await db.run(
    SELECT.one.from(names.BusinessPartners).where({ bp_id: row.bp_id })
  );
  if (existing) {
    await db.run(UPDATE(names.BusinessPartners).set(row).where({ bp_id: row.bp_id }));
  } else {
    await db.run(INSERT.into(names.BusinessPartners).entries(row));
  }
  return row;
}

async function listBusinessPartners(rawDb, { companyCode, countryCode, creditSegment } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (companyCode) where.company_code = companyCode;
  if (countryCode) where.country_code = countryCode;
  if (creditSegment) where.credit_segment = creditSegment;
  const query = Object.keys(where).length
    ? SELECT.from(names.BusinessPartners).where(where).orderBy('bp_id asc')
    : SELECT.from(names.BusinessPartners).orderBy('bp_id asc');
  return db.run(query);
}

async function upsertCreditSegment(rawDb, segment) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const row = {
    bp_id: String(segment.bp_id).trim(),
    credit_segment: String(segment.credit_segment || 'MAIN').trim(),
    credit_limit: roundCurrency(segment.credit_limit),
    currency: String(segment.currency || 'INR').trim(),
    limit_valid_to: segment.limit_valid_to || null,
    credit_blocked: Boolean(segment.credit_blocked === true),
    block_reason: segment.block_reason || null,
    risk_class: segment.risk_class || 'B',
    last_review_date: segment.last_review_date || null,
    source_id: String(segment.source_id || 'LOCAL-CANONICAL').trim(),
    updated_at: segment.updated_at || nowIso
  };
  const existing = await db.run(
    SELECT.one.from(names.CreditSegments).where({
      bp_id: row.bp_id,
      credit_segment: row.credit_segment
    })
  );
  if (existing) {
    await db.run(
      UPDATE(names.CreditSegments).set(row).where({
        bp_id: row.bp_id,
        credit_segment: row.credit_segment
      })
    );
  } else {
    await db.run(INSERT.into(names.CreditSegments).entries(row));
  }
  return row;
}

async function listCreditSegments(rawDb, { bpId, creditSegment } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (creditSegment) where.credit_segment = creditSegment;
  const query = Object.keys(where).length
    ? SELECT.from(names.CreditSegments).where(where).orderBy('bp_id asc', 'credit_segment asc')
    : SELECT.from(names.CreditSegments).orderBy('bp_id asc', 'credit_segment asc');
  return db.run(query);
}

async function upsertExposureItem(rawDb, item) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const amount = roundCurrency(item.amount);
  const row = {
    item_id: String(item.item_id).trim(),
    bp_id: String(item.bp_id).trim(),
    credit_segment: String(item.credit_segment || 'MAIN').trim(),
    company_code: String(item.company_code || '1000').trim(),
    exposure_category: String(item.exposure_category || 'OPEN_INVOICE').trim(),
    source_doc_number: String(item.source_doc_number || item.item_id).trim(),
    source_doc_type: String(item.source_doc_type || 'INVOICE').trim(),
    amount,
    currency: String(item.currency || 'INR').trim(),
    amount_in_segment_currency: roundCurrency(item.amount_in_segment_currency ?? amount),
    posting_date: item.posting_date || null,
    due_date: item.due_date || null,
    is_overdue: Boolean(item.is_overdue === true),
    days_overdue: Number(item.days_overdue) || 0,
    source_id: String(item.source_id || 'LOCAL-CANONICAL').trim(),
    updated_at: item.updated_at || nowIso
  };
  const existing = await db.run(
    SELECT.one.from(names.ExposureItems).where({ item_id: row.item_id })
  );
  if (existing) {
    await db.run(UPDATE(names.ExposureItems).set(row).where({ item_id: row.item_id }));
  } else {
    await db.run(INSERT.into(names.ExposureItems).entries(row));
  }
  return row;
}

async function listExposureItems(rawDb, { bpId, creditSegment, companyCode } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (creditSegment) where.credit_segment = creditSegment;
  if (companyCode) where.company_code = companyCode;
  const query = Object.keys(where).length
    ? SELECT.from(names.ExposureItems).where(where).orderBy('item_id asc')
    : SELECT.from(names.ExposureItems).orderBy('item_id asc');
  return db.run(query);
}

async function upsertOpenReceivable(rawDb, receivable) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const amountDoc = roundCurrency(receivable.amount_doc_curr);
  const row = {
    receivable_id: String(receivable.receivable_id).trim(),
    bp_id: String(receivable.bp_id).trim(),
    company_code: String(receivable.company_code || '1000').trim(),
    accounting_doc_no: String(receivable.accounting_doc_no || receivable.receivable_id).trim(),
    fiscal_year: String(receivable.fiscal_year || '2026').trim(),
    line_item: String(receivable.line_item || '001').trim(),
    invoice_ref: receivable.invoice_ref || receivable.accounting_doc_no || null,
    document_date: receivable.document_date || null,
    baseline_date: receivable.baseline_date || null,
    due_date: receivable.due_date || null,
    amount_doc_curr: amountDoc,
    doc_currency: String(receivable.doc_currency || 'INR').trim(),
    amount_local_curr: roundCurrency(receivable.amount_local_curr ?? amountDoc),
    local_currency: String(receivable.local_currency || receivable.doc_currency || 'INR').trim(),
    dunning_level: Number(receivable.dunning_level) || 0,
    dispute_flag: Boolean(receivable.dispute_flag === true),
    clearing_status: String(receivable.clearing_status || 'OPEN').trim(),
    source_id: String(receivable.source_id || 'LOCAL-CANONICAL').trim(),
    updated_at: receivable.updated_at || nowIso
  };
  const existing = await db.run(
    SELECT.one.from(names.OpenReceivables).where({ receivable_id: row.receivable_id })
  );
  if (existing) {
    await db.run(UPDATE(names.OpenReceivables).set(row).where({ receivable_id: row.receivable_id }));
  } else {
    await db.run(INSERT.into(names.OpenReceivables).entries(row));
  }
  return row;
}

async function listOpenReceivables(rawDb, { bpId, companyCode, clearingStatus } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (companyCode) where.company_code = companyCode;
  if (clearingStatus) where.clearing_status = clearingStatus;
  const query = Object.keys(where).length
    ? SELECT.from(names.OpenReceivables).where(where).orderBy('receivable_id asc')
    : SELECT.from(names.OpenReceivables).orderBy('receivable_id asc');
  return db.run(query);
}

async function upsertPaymentHistory(rawDb, payment) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const row = {
    payment_id: String(payment.payment_id).trim(),
    bp_id: String(payment.bp_id).trim(),
    company_code: String(payment.company_code || '1000').trim(),
    payment_doc_no: String(payment.payment_doc_no || payment.payment_id).trim(),
    invoice_ref: payment.invoice_ref || null,
    payment_date: payment.payment_date,
    due_date: payment.due_date || null,
    days_late: Number(payment.days_late) || 0,
    amount: roundCurrency(payment.amount),
    currency: String(payment.currency || 'INR').trim(),
    source_id: String(payment.source_id || 'LOCAL-CANONICAL').trim(),
    updated_at: payment.updated_at || nowIso
  };
  const existing = await db.run(
    SELECT.one.from(names.PaymentHistory).where({ payment_id: row.payment_id })
  );
  if (existing) {
    await db.run(UPDATE(names.PaymentHistory).set(row).where({ payment_id: row.payment_id }));
  } else {
    await db.run(INSERT.into(names.PaymentHistory).entries(row));
  }
  return row;
}

async function listPaymentHistory(rawDb, { bpId, companyCode } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (companyCode) where.company_code = companyCode;
  const query = Object.keys(where).length
    ? SELECT.from(names.PaymentHistory).where(where).orderBy('payment_date desc', 'payment_id asc')
    : SELECT.from(names.PaymentHistory).orderBy('payment_date desc', 'payment_id asc');
  return db.run(query);
}

async function saveExposureSnapshot(rawDb, snapshot) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const row = {
    snapshot_id: snapshot.snapshot_id || `${snapshot.bp_id}:${snapshot.credit_segment || 'MAIN'}`,
    bp_id: String(snapshot.bp_id).trim(),
    credit_segment: String(snapshot.credit_segment || 'MAIN').trim(),
    company_code: String(snapshot.company_code || '1000').trim(),
    country_code: String(snapshot.country_code || 'India').trim(),
    credit_limit: roundCurrency(snapshot.credit_limit),
    open_orders_amount: roundCurrency(snapshot.open_orders_amount),
    open_deliveries_amount: roundCurrency(snapshot.open_deliveries_amount),
    open_billing_amount: roundCurrency(snapshot.open_billing_amount),
    open_ar_amount: roundCurrency(snapshot.open_ar_amount),
    total_exposure: roundCurrency(snapshot.total_exposure),
    available_credit: roundCurrency(snapshot.available_credit),
    utilization_pct: roundCurrency(snapshot.utilization_pct),
    overdue_amount: roundCurrency(snapshot.overdue_amount),
    overdue_count: Number(snapshot.overdue_count) || 0,
    ageing_0_30: roundCurrency(snapshot.ageing_0_30),
    ageing_31_60: roundCurrency(snapshot.ageing_31_60),
    ageing_61_90: roundCurrency(snapshot.ageing_61_90),
    ageing_90_plus: roundCurrency(snapshot.ageing_90_plus),
    threshold_status: snapshot.threshold_status || 'NORMAL',
    calculated_at: snapshot.calculated_at || nowIso,
    source_id: String(snapshot.source_id || 'LOCAL-CANONICAL').trim()
  };
  const existing = await db.run(
    SELECT.one.from(names.ExposureSnapshots).where({ snapshot_id: row.snapshot_id })
  );
  if (existing) {
    await db.run(UPDATE(names.ExposureSnapshots).set(row).where({ snapshot_id: row.snapshot_id }));
  } else {
    await db.run(INSERT.into(names.ExposureSnapshots).entries(row));
  }
  return row;
}

async function listExposureSnapshots(rawDb, { bpId, companyCode, countryCode, creditSegment, thresholdStatus } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (companyCode) where.company_code = companyCode;
  if (countryCode) where.country_code = countryCode;
  if (creditSegment) where.credit_segment = creditSegment;
  if (thresholdStatus) where.threshold_status = thresholdStatus;
  const query = Object.keys(where).length
    ? SELECT.from(names.ExposureSnapshots).where(where).orderBy('bp_id asc')
    : SELECT.from(names.ExposureSnapshots).orderBy('bp_id asc');
  return db.run(query);
}

async function upsertCanonicalLimitRequest(rawDb, request) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const nowIso = new Date().toISOString();
  const row = {
    request_id: String(request.request_id).trim(),
    bp_id: String(request.bp_id).trim(),
    credit_segment: String(request.credit_segment || 'MAIN').trim(),
    company_code: String(request.company_code || '1000').trim(),
    current_limit: roundCurrency(request.current_limit),
    requested_limit: roundCurrency(request.requested_limit),
    currency: String(request.currency || 'INR').trim(),
    justification: String(request.justification || '').trim(),
    ai_risk_summary: request.ai_risk_summary || null,
    status: String(request.status || 'PENDING_APPROVAL').trim(),
    requested_by: String(request.requested_by || 'system').trim(),
    approved_by: request.approved_by || null,
    sap_sync_status: String(request.sap_sync_status || 'NOT_SYNCED').trim(),
    created_at: request.created_at || nowIso,
    decided_at: request.decided_at || null
  };
  const existing = await db.run(
    SELECT.one.from(names.LimitRequests).where({ request_id: row.request_id })
  );
  if (existing) {
    await db.run(UPDATE(names.LimitRequests).set(row).where({ request_id: row.request_id }));
  } else {
    await db.run(INSERT.into(names.LimitRequests).entries(row));
  }
  return row;
}

async function listCanonicalLimitRequests(rawDb, { bpId, status } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const where = {};
  if (bpId) where.bp_id = bpId;
  if (status) where.status = status;
  const query = Object.keys(where).length
    ? SELECT.from(names.LimitRequests).where(where).orderBy('created_at desc')
    : SELECT.from(names.LimitRequests).orderBy('created_at desc');
  return db.run(query);
}

function buildDeterministicSnapshot({
  partner,
  segment,
  exposureItems = [],
  openReceivables = [],
  payments = [],
  referenceDate = '2026-11-09'
}) {
  return calculatePartnerExposureSnapshot({
    partner,
    segment,
    exposureItems,
    openReceivables,
    payments,
    referenceDate
  });
}

async function recalculateAllExposureSnapshots(rawDb, { referenceDate = '2026-11-09' } = {}) {
  const db = getDatabaseHandle(rawDb);
  let partners = await listBusinessPartners(db);
  if (!partners.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    partners = await listBusinessPartners(db);
  }
  const [segments, exposureItems, openReceivables, payments] = await Promise.all([
    listCreditSegments(db),
    listExposureItems(db),
    listOpenReceivables(db),
    listPaymentHistory(db)
  ]);

  const savedSnapshots = [];
  for (const partner of partners) {
    const segment = segments.find(s => s.bp_id === partner.bp_id) || {
      bp_id: partner.bp_id,
      credit_segment: partner.credit_segment || 'MAIN',
      credit_limit: 0,
      credit_blocked: false
    };
    const bpExposureItems = exposureItems.filter(e => e.bp_id === partner.bp_id);
    const bpReceivables = openReceivables.filter(r => r.bp_id === partner.bp_id);
    const bpPayments = payments.filter(p => p.bp_id === partner.bp_id);
    const calculated = calculatePartnerExposureSnapshot({
      partner,
      segment,
      exposureItems: bpExposureItems,
      openReceivables: bpReceivables,
      payments: bpPayments,
      referenceDate
    });
    const persisted = await saveExposureSnapshot(db, calculated);
    savedSnapshots.push({
      ...persisted,
      diagnostics: calculated.diagnostics
    });
  }
  return savedSnapshots;
}

async function getCanonicalPortfolioAnalytics(rawDb, {
  countryCode = null,
  companyCode = null,
  creditSegment = null,
  thresholdStatus = null,
  riskClass = null,
  referenceDate = '2026-11-09'
} = {}) {
  const db = getDatabaseHandle(rawDb);
  let partners = await listBusinessPartners(db);
  if (!partners.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    partners = await listBusinessPartners(db);
  }
  const [segments, snapshots] = await Promise.all([
    listCreditSegments(db),
    listExposureSnapshots(db)
  ]);

  const partnerByBp = new Map(partners.map(p => [p.bp_id, p]));
  const segmentByBp = new Map(segments.map(s => [s.bp_id, s]));

  const enriched = snapshots.map(snap => {
    const partner = partnerByBp.get(snap.bp_id) || {};
    const segment = segmentByBp.get(snap.bp_id) || {};
    return {
      ...snap,
      bp_name: partner.bp_name || snap.bp_id,
      risk_class: segment.risk_class || partner.risk_class || 'B',
      currency: segment.currency || partner.currency || 'INR',
      credit_blocked: Boolean(segment.credit_blocked)
    };
  });

  const filtered = enriched.filter(row => {
    if (countryCode && row.country_code !== countryCode) return false;
    if (companyCode && row.company_code !== companyCode) return false;
    if (creditSegment && row.credit_segment !== creditSegment) return false;
    if (thresholdStatus && row.threshold_status !== thresholdStatus) return false;
    if (riskClass && row.risk_class !== riskClass) return false;
    return true;
  });

  const rollups = calculatePortfolioRollups(filtered);
  return {
    referenceDate,
    filters: { countryCode, companyCode, creditSegment, thresholdStatus, riskClass },
    ...rollups,
    snapshots: filtered
  };
}

async function getBusinessPartnerCreditDossier(rawDb, bpId, { referenceDate = '2026-11-09' } = {}) {
  const db = getDatabaseHandle(rawDb);
  let partners = await listBusinessPartners(db);
  if (!partners.length) {
    await seedCanonicalFromLegacyDemo(db, { referenceDate });
    partners = await listBusinessPartners(db);
  }
  const partner = partners.find(p => p.bp_id === bpId);
  if (!partner) {
    const error = new Error(`Business Partner ${bpId} not found in canonical repository.`);
    error.statusCode = 404;
    throw error;
  }

  const [segments, exposureItems, openReceivables, payments, limitRequests] = await Promise.all([
    listCreditSegments(db, { bpId }),
    listExposureItems(db, { bpId }),
    listOpenReceivables(db, { bpId }),
    listPaymentHistory(db, { bpId }),
    listCanonicalLimitRequests(db, { bpId })
  ]);

  const segment = segments[0] || {
    bp_id: partner.bp_id,
    credit_segment: partner.credit_segment || 'MAIN',
    credit_limit: 0,
    currency: partner.currency || 'INR',
    credit_blocked: false
  };

  const calculated = calculatePartnerExposureSnapshot({
    partner,
    segment,
    exposureItems,
    openReceivables,
    payments,
    referenceDate
  });
  await saveExposureSnapshot(db, calculated);

  return {
    partner,
    creditSegment: segment,
    snapshot: calculated,
    diagnostics: calculated.diagnostics,
    exposureItems,
    openReceivables,
    paymentHistory: payments,
    limitRequests
  };
}

async function seedCanonicalFromLegacyDemo(rawDb, { referenceDate = '2026-04-16' } = {}) {
  const db = getDatabaseHandle(rawDb);
  const names = entityNames(db);
  const sourceId = 'SEED-FIN-FSCM-CR';
  const nowIso = new Date().toISOString();

  await upsertDataSource(db, {
    source_id: sourceId,
    source_name: 'SAP S/4HANA FIN-FSCM-CR Seeded Baseline (13 Business Partners)',
    source_type: 'FILE',
    connection_config_ref: 'config:db/data/credit-Customers.csv',
    status: 'ACTIVE',
    last_sync_at: nowIso,
    created_at: nowIso
  });

  await saveFieldMappings(
    db,
    sourceId,
    DEFAULT_SAP_FIELD_MAPPINGS.map((m, idx) => ({
      mapping_id: `${sourceId}:MAP-${String(idx + 1).padStart(3, '0')}`,
      source_id: sourceId,
      source_entity: m.sap_reference_table,
      source_field: m.sap_reference_field,
      canonical_entity: m.canonical_entity,
      canonical_field: m.canonical_field,
      transform_rule: m.transform_rule,
      confidence: 1.0,
      verified_by_user: false,
      sap_reference_table: m.sap_reference_table,
      sap_reference_field: m.sap_reference_field,
      sap_reference_verified: false,
      verification_note: SAP_VERIFICATION_NOTE
    }))
  );

  const [customers, openItems, payments, limitRequests] = await Promise.all([
    db.run(SELECT.from(names.LegacyCustomers).orderBy('ID asc')),
    db.run(SELECT.from(names.LegacyOpenItems).orderBy('ID asc')),
    db.run(SELECT.from(names.LegacyPayments).orderBy('ID asc')),
    db.run(SELECT.from(names.LegacyLimitRequests).orderBy('ID asc'))
  ]);

  const itemsByBp = new Map();
  const receivablesByBp = new Map();

  for (const customer of customers) {
    await upsertBusinessPartner(db, {
      bp_id: customer.ID,
      source_id: sourceId,
      external_bp_number: customer.ID,
      bp_name: customer.name,
      country_code: customer.country || 'India',
      company_code: customer.companyCode || '1000',
      risk_class: customer.riskClass || 'B',
      credit_segment: 'MAIN',
      currency: customer.currency || 'INR',
      status: 'ACTIVE',
      updated_at: nowIso
    });

    await upsertCreditSegment(db, {
      bp_id: customer.ID,
      credit_segment: 'MAIN',
      credit_limit: customer.creditLimit,
      currency: customer.currency || 'INR',
      limit_valid_to: '2026-12-31',
      credit_blocked: false,
      block_reason: null,
      risk_class: customer.riskClass || 'B',
      last_review_date: customer.lastReviewDate || '2026-01-15',
      source_id: sourceId,
      updated_at: nowIso
    });
  }

  const customerMap = new Map(customers.map(c => [c.ID, c]));

  for (const item of openItems) {
    const bpId = item.customer_ID;
    const customer = customerMap.get(bpId);
    const companyCode = customer?.companyCode || '1000';
    const isOrder = String(item.type || '').toUpperCase().includes('ORDER');
    const category = isOrder ? 'OPEN_ORDER' : 'OPEN_INVOICE';
    const isOverdue = Boolean(item.status === 'OVERDUE' || (item.dueDate && item.dueDate < referenceDate));
    const daysOverdue = isOverdue ? daysBetweenDates(item.dueDate, referenceDate) : 0;

    const expItem = await upsertExposureItem(db, {
      item_id: item.ID,
      bp_id: bpId,
      credit_segment: 'MAIN',
      company_code: companyCode,
      exposure_category: category,
      source_doc_number: item.ID,
      source_doc_type: item.type || 'INVOICE',
      amount: item.amount,
      currency: item.currency || customer?.currency || 'INR',
      amount_in_segment_currency: item.amount,
      posting_date: '2026-03-01',
      due_date: item.dueDate,
      is_overdue: isOverdue,
      days_overdue: daysOverdue,
      source_id: sourceId,
      updated_at: nowIso
    });

    if (!itemsByBp.has(bpId)) itemsByBp.set(bpId, []);
    itemsByBp.get(bpId).push(expItem);

    if (category === 'OPEN_INVOICE') {
      const rec = await upsertOpenReceivable(db, {
        receivable_id: item.ID,
        bp_id: bpId,
        company_code: companyCode,
        accounting_doc_no: item.ID,
        fiscal_year: '2026',
        line_item: '001',
        invoice_ref: item.ID,
        document_date: '2026-03-01',
        baseline_date: '2026-03-01',
        due_date: item.dueDate,
        amount_doc_curr: item.amount,
        doc_currency: item.currency || customer?.currency || 'INR',
        amount_local_curr: item.amount,
        local_currency: item.currency || customer?.currency || 'INR',
        dunning_level: isOverdue ? 1 : 0,
        dispute_flag: false,
        clearing_status: 'OPEN',
        source_id: sourceId,
        updated_at: nowIso
      });
      if (!receivablesByBp.has(bpId)) receivablesByBp.set(bpId, []);
      receivablesByBp.get(bpId).push(rec);
    }
  }

  for (const pmt of payments) {
    const bpId = pmt.customer_ID;
    const customer = customerMap.get(bpId);
    await upsertPaymentHistory(db, {
      payment_id: pmt.ID,
      bp_id: bpId,
      company_code: customer?.companyCode || '1000',
      payment_doc_no: pmt.reference || pmt.ID,
      invoice_ref: pmt.reference || null,
      payment_date: pmt.postingDate || '2026-03-15',
      due_date: pmt.postingDate || '2026-03-15',
      days_late: 0,
      amount: pmt.amount,
      currency: pmt.currency || customer?.currency || 'INR',
      source_id: sourceId,
      updated_at: nowIso
    });
  }

  for (const reqRow of limitRequests) {
    const bpId = reqRow.customer_ID;
    const customer = customerMap.get(bpId);
    const statusMap = {
      PENDING: 'PENDING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED'
    };
    await upsertCanonicalLimitRequest(db, {
      request_id: reqRow.ID,
      bp_id: bpId,
      credit_segment: 'MAIN',
      company_code: customer?.companyCode || '1000',
      current_limit: reqRow.currentLimit,
      requested_limit: reqRow.requestedLimit,
      currency: customer?.currency || 'INR',
      justification: reqRow.reason || 'Credit limit review',
      ai_risk_summary: null,
      status: statusMap[reqRow.status] || 'PENDING_APPROVAL',
      requested_by: reqRow.requestedBy || 'analyst',
      approved_by: reqRow.decidedBy || null,
      sap_sync_status: reqRow.status === 'APPROVED' ? 'LOCAL_SIMULATED' : 'NOT_SYNCED',
      created_at: reqRow.createdAt || nowIso,
      decided_at: reqRow.decidedAt || null
    });
  }

  const snapshots = [];
  for (const customer of customers) {
    const partner = {
      bp_id: customer.ID,
      company_code: customer.companyCode || '1000',
      country_code: customer.country || 'India',
      credit_segment: 'MAIN',
      source_id: sourceId
    };
    const segment = {
      bp_id: customer.ID,
      credit_segment: 'MAIN',
      credit_limit: customer.creditLimit,
      credit_blocked: false
    };
    const snap = buildDeterministicSnapshot({
      partner,
      segment,
      exposureItems: itemsByBp.get(customer.ID) || [],
      openReceivables: receivablesByBp.get(customer.ID) || [],
      referenceDate
    });
    snapshots.push(await saveExposureSnapshot(db, snap));
  }

  return {
    sourceId,
    businessPartnersSeeded: customers.length,
    exposureItemsSeeded: openItems.length,
    paymentsSeeded: payments.length,
    limitRequestsSeeded: limitRequests.length,
    snapshotsCalculated: snapshots.length,
    canonicalTables: Object.keys(CANONICAL_TABLES)
  };
}

module.exports = {
  buildDeterministicSnapshot,
  classifyThresholdStatus,
  daysBetweenDates,
  evaluateDeterministicThreshold,
  getBusinessPartnerCreditDossier,
  getCanonicalPortfolioAnalytics,
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
  recalculateAllExposureSnapshots,
  roundCurrency,
  saveExposureSnapshot,
  saveFieldMappings,
  seedCanonicalFromLegacyDemo,
  sha256Hex,
  upsertBusinessPartner,
  upsertCanonicalLimitRequest,
  upsertCreditSegment,
  upsertDataSource,
  upsertExposureItem,
  upsertOpenReceivable,
  upsertPaymentHistory
};
