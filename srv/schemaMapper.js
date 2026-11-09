const {
  DEFAULT_SAP_FIELD_MAPPINGS,
  SAP_VERIFICATION_NOTE,
  createSapMappingEnvelope
} = require('./canonicalSchemaMetadata');

// Comprehensive dictionary of SAP technical field names (BUT000, KNA1, KNB1, UKMBP_CMS_SGM, UKM_ITEM, ACDOCA, BSID, BSAD)
// and common enterprise ERP / CSV / Excel column headers mapped to Canonical FIN-FSCM-CR entities & fields.
// Per Working Rule 5, every SAP reference carries verified: false and verification_note.
const FIELD_DISCOVERY_CATALOG = Object.freeze([
  // CG_BUSINESS_PARTNER
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'bp_id',
    sap_reference_table: 'BUT000',
    sap_reference_field: 'PARTNER',
    transform_rule: 'TRIM',
    aliases: ['bp_id', 'partner', 'businesspartner', 'kunnr', 'customer', 'customer_id', 'customerid', 'cust_id', 'id', 'bp_number', 'account_no']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'external_bp_number',
    sap_reference_table: 'BUT000',
    sap_reference_field: 'BPEXT',
    transform_rule: 'TRIM',
    aliases: ['external_bp_number', 'bpext', 'ext_bp', 'external_id', 'sourcecustomerid', 'legacy_customer_id']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'bp_name',
    sap_reference_table: 'BUT000',
    sap_reference_field: 'NAME_ORG1',
    transform_rule: 'TRIM',
    aliases: ['bp_name', 'name_org1', 'name1', 'customername', 'customer_name', 'businesspartnerfullname', 'organizationbpname1', 'name', 'company_name', 'party_name']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'country_code',
    sap_reference_table: 'KNA1',
    sap_reference_field: 'LAND1',
    transform_rule: 'TRIM',
    aliases: ['country_code', 'land1', 'country', 'countrykey', 'region_country']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'company_code',
    sap_reference_table: 'KNB1',
    sap_reference_field: 'BUKRS',
    transform_rule: 'TRIM',
    aliases: ['company_code', 'bukrs', 'companycode', 'comp_code', 'legal_entity', 'entity_code']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'risk_class',
    sap_reference_table: 'UKMBP_CMS',
    sap_reference_field: 'RISK_CLASS',
    transform_rule: 'TRIM',
    aliases: ['risk_class', 'riskclass', 'ctlpc', 'credit_risk_class', 'rating', 'risk_category']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'credit_segment',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'CREDIT_SGMNT',
    transform_rule: 'TRIM',
    aliases: ['credit_segment', 'credit_sgmnt', 'creditsegment', 'kkber', 'credit_control_area', 'segment']
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'currency',
    sap_reference_table: 'KNB1',
    sap_reference_field: 'WAERS',
    transform_rule: 'CURRENCY_ISO',
    aliases: ['currency', 'waers', 'curr', 'creditsegmentcurrency', 'transactioncurrency', 'doc_currency']
  },

  // CG_BP_CREDIT_SEGMENT
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'bp_id',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'PARTNER',
    transform_rule: 'TRIM',
    aliases: ['bp_id', 'partner', 'businesspartner', 'kunnr', 'customer_id', 'customerid', 'id']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_segment',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'CREDIT_SGMNT',
    transform_rule: 'TRIM',
    aliases: ['credit_segment', 'credit_sgmnt', 'creditsegment', 'kkber']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_limit',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'CREDIT_LIMIT',
    transform_rule: 'DECIMAL',
    aliases: ['credit_limit', 'creditlimit', 'klimk', 'customercreditlimitamount', 'approved_limit', 'limit_amount', 'sanctioned_limit']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'limit_valid_to',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'LIMIT_VALID_DATE',
    transform_rule: 'DATE_YYYYMMDD',
    aliases: ['limit_valid_to', 'limit_valid_date', 'valid_to', 'expiry_date']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_blocked',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'XBLOCKED',
    transform_rule: 'BOOLEAN_FLAG',
    aliases: ['credit_blocked', 'xblocked', 'crblb', 'blocked', 'is_blocked', 'creditblock']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'block_reason',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'BLOCK_REASON',
    transform_rule: 'TRIM',
    aliases: ['block_reason', 'blockreason', 'hold_reason']
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'last_review_date',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'FOLLOW_UP_DT',
    transform_rule: 'DATE_YYYYMMDD',
    aliases: ['last_review_date', 'lastreviewdate', 'follow_up_dt', 'review_date', 'dtrev']
  },

  // CG_CREDIT_EXPOSURE_ITEM
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'item_id',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'ITEM_KEY',
    transform_rule: 'TRIM',
    aliases: ['item_id', 'item_key', 'open_item_id', 'document_id', 'id', 'doc_id', 'belnr', 'vbeln']
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'bp_id',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'PARTNER',
    transform_rule: 'TRIM',
    aliases: ['bp_id', 'partner', 'customer_id', 'customerid', 'kunnr', 'businesspartner']
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'exposure_category',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'COMM_TYP',
    transform_rule: 'TRIM',
    aliases: ['exposure_category', 'comm_typ', 'type', 'document_type', 'doctype', 'commitment_type', 'category']
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'source_doc_number',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'OBJKEY',
    transform_rule: 'TRIM',
    aliases: ['source_doc_number', 'objkey', 'vbeln', 'belnr', 'document_no', 'doc_number', 'invoice_no', 'order_no']
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'amount',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'AMOUNT',
    transform_rule: 'DECIMAL',
    aliases: ['amount', 'wrbtr', 'dmbtr', 'wsl', 'hsl', 'netwr', 'open_amount', 'exposure_amount', 'outstandingamount']
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'due_date',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'NETDT',
    transform_rule: 'DATE_YYYYMMDD',
    aliases: ['due_date', 'duedate', 'netdt', 'faedt', 'maturity_date', 'net_due_date']
  },

  // CG_OPEN_RECEIVABLE
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'receivable_id',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'BELNR',
    transform_rule: 'TRIM',
    aliases: ['receivable_id', 'belnr', 'accounting_doc_no', 'accountingdocument', 'invoice_id', 'id']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'bp_id',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'KUNNR',
    transform_rule: 'TRIM',
    aliases: ['bp_id', 'kunnr', 'partner', 'customer_id', 'customerid', 'customer']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'accounting_doc_no',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'BELNR',
    transform_rule: 'TRIM',
    aliases: ['accounting_doc_no', 'belnr', 'accountingdocument', 'doc_no', 'invoice_no']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'fiscal_year',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'GJAHR',
    transform_rule: 'TRIM',
    aliases: ['fiscal_year', 'gjahr', 'fiscalyear', 'fy', 'year']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'line_item',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'BUZEI',
    transform_rule: 'TRIM',
    aliases: ['line_item', 'buzei', 'docln', 'item_no', 'line']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'amount_doc_curr',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'WSL',
    transform_rule: 'DECIMAL',
    aliases: ['amount_doc_curr', 'wsl', 'wrbtr', 'amount', 'amountintransactioncurrency', 'invoice_amount', 'open_amount']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'amount_local_curr',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'HSL',
    transform_rule: 'DECIMAL',
    aliases: ['amount_local_curr', 'hsl', 'dmbtr', 'amountincompanycodecurrency', 'local_amount']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'due_date',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'NETDT',
    transform_rule: 'DATE_YYYYMMDD',
    aliases: ['due_date', 'duedate', 'netdt', 'netduedate', 'faedt']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'dunning_level',
    sap_reference_table: 'BSID',
    sap_reference_field: 'MANST',
    transform_rule: 'DECIMAL',
    aliases: ['dunning_level', 'manst', 'dunninglevel']
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'dispute_flag',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'DISPUTE',
    transform_rule: 'BOOLEAN_FLAG',
    aliases: ['dispute_flag', 'dispute', 'is_disputed', 'disputed']
  },

  // CG_PAYMENT_HISTORY
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'payment_id',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'AUGBL',
    transform_rule: 'TRIM',
    aliases: ['payment_id', 'augbl', 'payment_doc_no', 'clearingaccountingdocument', 'id']
  },
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'bp_id',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'KUNNR',
    transform_rule: 'TRIM',
    aliases: ['bp_id', 'kunnr', 'partner', 'customer_id', 'customerid']
  },
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'invoice_ref',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'REBZG',
    transform_rule: 'TRIM',
    aliases: ['invoice_ref', 'rebzg', 'reference', 'xblnr', 'invoice_no']
  },
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'payment_date',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'AUGDT',
    transform_rule: 'DATE_YYYYMMDD',
    aliases: ['payment_date', 'augdt', 'postingdate', 'posting_date', 'clearingdate', 'paid_date']
  },
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'amount',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'WRBTR',
    transform_rule: 'DECIMAL',
    aliases: ['amount', 'wrbtr', 'dmbtr', 'paid_amount', 'payment_amount']
  }
]);

function normalizeFieldName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function compactFieldName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function inferFieldDataType(values = []) {
  const nonEmpty = values
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .map(v => String(v).trim());
  if (nonEmpty.length === 0) return 'TEXT';

  if (nonEmpty.every(v => /^[A-Z]{3}$/.test(v))) return 'CURRENCY';
  if (nonEmpty.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{8}$/.test(v) || /^\/Date\(\d+\)\/$/.test(v))) {
    return 'DATE';
  }
  if (nonEmpty.every(v => /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v.replace(/,/g, '')))) {
    return 'DECIMAL';
  }
  if (nonEmpty.every(v => /^(true|false|x|X|1|0|yes|no)$/i.test(v))) {
    return 'BOOLEAN';
  }
  return 'TEXT';
}

function detectTargetCanonicalEntity(entityHint, sourceFields = []) {
  const hint = normalizeFieldName(entityHint);
  if (hint.includes('payment') || hint.includes('bsad')) return 'CG_PAYMENT_HISTORY';
  if (hint.includes('receivable') || hint.includes('bsid') || hint.includes('acdoca')) return 'CG_OPEN_RECEIVABLE';
  if (hint.includes('exposure') || hint.includes('ukm_item') || hint.includes('open_item') || hint.includes('openitem')) {
    return 'CG_CREDIT_EXPOSURE_ITEM';
  }
  if (hint.includes('segment') || hint.includes('ukmbp')) return 'CG_BP_CREDIT_SEGMENT';
  if (hint.includes('partner') || hint.includes('customer') || hint.includes('but000') || hint.includes('kna1')) {
    return 'CG_BUSINESS_PARTNER';
  }

  const normalizedSet = new Set(sourceFields.map(compactFieldName));
  if (normalizedSet.has('augdt') || normalizedSet.has('postingdate') || normalizedSet.has('paymentdate')) {
    return 'CG_PAYMENT_HISTORY';
  }
  if (normalizedSet.has('duedate') || normalizedSet.has('netdt') || normalizedSet.has('commtyp')) {
    if (normalizedSet.has('belnr') || normalizedSet.has('accountingdocno')) {
      return 'CG_OPEN_RECEIVABLE';
    }
    return 'CG_CREDIT_EXPOSURE_ITEM';
  }
  if (normalizedSet.has('creditlimit') || normalizedSet.has('klimk')) {
    if (normalizedSet.has('name') || normalizedSet.has('bpname') || normalizedSet.has('nameorg1')) {
      return 'CG_BUSINESS_PARTNER';
    }
    return 'CG_BP_CREDIT_SEGMENT';
  }
  return 'CG_BUSINESS_PARTNER';
}

function proposeFieldMappings({
  sourceId = 'DISCOVERED-SOURCE',
  sourceEntity = 'DEFAULT',
  targetCanonicalEntity = null,
  records = [],
  headers = null
} = {}) {
  const sampleRows = Array.isArray(records) ? records.slice(0, 25) : [];
  const discoveredColumns = Array.isArray(headers) && headers.length
    ? headers
    : [...new Set(sampleRows.flatMap(row => (row && typeof row === 'object' ? Object.keys(row) : [])))];

  const primaryEntity = targetCanonicalEntity || detectTargetCanonicalEntity(sourceEntity, discoveredColumns);
  // If a combined customer + credit limit table is uploaded (like credit-Customers.csv), map both CG_BUSINESS_PARTNER and CG_BP_CREDIT_SEGMENT!
  const normalizedCols = new Set(discoveredColumns.map(compactFieldName));
  const isCombinedPartnerAndLimit = primaryEntity === 'CG_BUSINESS_PARTNER'
    && (normalizedCols.has('creditlimit') || normalizedCols.has('klimk'));

  const candidateEntities = isCombinedPartnerAndLimit
    ? ['CG_BUSINESS_PARTNER', 'CG_BP_CREDIT_SEGMENT']
    : [primaryEntity];

  const proposals = [];
  const columnProfiles = [];

  for (const col of discoveredColumns) {
    const sampleValues = sampleRows
      .map(r => r?.[col])
      .filter(v => v !== undefined && v !== null)
      .slice(0, 5);
    const inferredType = inferFieldDataType(sampleValues);
    columnProfiles.push({
      sourceField: col,
      inferredType,
      sampleValues
    });

    const norm = normalizeFieldName(col);
    const compact = compactFieldName(col);

    for (const entityName of candidateEntities) {
      const catalogCandidates = FIELD_DISCOVERY_CATALOG.filter(c => c.canonical_entity === entityName);
      let bestMatch = null;
      let bestScore = 0;

      for (const entry of catalogCandidates) {
        for (const alias of entry.aliases) {
          const aliasNorm = normalizeFieldName(alias);
          const aliasCompact = compactFieldName(alias);
          let score = 0;
          if (norm === aliasNorm || compact === aliasCompact) {
            score = norm === normalizeFieldName(entry.canonical_field)
              || norm === normalizeFieldName(entry.sap_reference_field)
              ? 0.98
              : 0.92;
          } else if (compact.includes(aliasCompact) || aliasCompact.includes(compact)) {
            if (aliasCompact.length >= 4 && compact.length >= 4) {
              score = 0.76;
            }
          }
          if (score > bestScore) {
            bestScore = score;
            bestMatch = entry;
          }
        }
      }

      if (bestMatch && bestScore >= 0.70) {
        proposals.push(
          createSapMappingEnvelope({
            mapping_id: `${sourceId}:${entityName}:${bestMatch.canonical_field}`,
            source_id: sourceId,
            source_entity: sourceEntity,
            source_field: col,
            canonical_entity: entityName,
            canonical_field: bestMatch.canonical_field,
            transform_rule: bestMatch.transform_rule,
            confidence: Number(bestScore.toFixed(4)),
            verified_by_user: false,
            sap_reference_table: bestMatch.sap_reference_table,
            sap_reference_field: bestMatch.sap_reference_field,
            sap_reference_verified: false,
            verification_note: SAP_VERIFICATION_NOTE
          })
        );
      }
    }
  }

  // Deduplicate by (canonical_entity, canonical_field) keeping highest confidence
  const dedupedByTarget = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.canonical_entity}:${proposal.canonical_field}`;
    const existing = dedupedByTarget.get(key);
    if (!existing || proposal.confidence > existing.confidence) {
      dedupedByTarget.set(key, proposal);
    }
  }

  return {
    sourceId,
    sourceEntity,
    detectedPrimaryEntity: primaryEntity,
    candidateEntities,
    totalRowsSampled: sampleRows.length,
    columnProfiles,
    proposedMappings: [...dedupedByTarget.values()]
  };
}

function applyFieldTransform(rawValue, transformRule = 'NONE') {
  if (rawValue === undefined || rawValue === null) return null;
  const str = String(rawValue).trim();
  if (str === '') return null;

  switch (transformRule) {
    case 'PAD_LEFT_10':
      return /^\d+$/.test(str) ? str.padStart(10, '0') : str;
    case 'DATE_YYYYMMDD': {
      // Handle SAP DATS (20261025), OData V2 (/Date(1761350400000)/), or ISO (2026-10-25)
      if (/^\d{8}$/.test(str)) {
        return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
      }
      const odataMatch = str.match(/^\/Date\((-?\d+)\)\/$/);
      if (odataMatch) {
        return new Date(Number(odataMatch[1])).toISOString().slice(0, 10);
      }
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
        return str.slice(0, 10);
      }
      const parsed = Date.parse(str);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : str;
    }
    case 'DECIMAL': {
      const cleaned = str.replace(/,/g, '').replace(/[₹$€£\s]/g, '');
      const num = Number(cleaned);
      return Number.isFinite(num) ? Math.round((num + Number.EPSILON) * 100) / 100 : 0;
    }
    case 'CURRENCY_ISO':
      return str.toUpperCase().slice(0, 3);
    case 'BOOLEAN_FLAG':
      return /^(true|x|1|yes|y|blocked)$/i.test(str);
    case 'TRIM':
    case 'NONE':
    default:
      return str;
  }
}

function transformSourceRowToCanonical(sourceRow, mappings = [], targetCanonicalEntity) {
  const relevant = targetCanonicalEntity
    ? mappings.filter(m => m.canonical_entity === targetCanonicalEntity)
    : mappings;
  const output = {};
  for (const map of relevant) {
    const rawVal = sourceRow?.[map.source_field];
    const transformed = applyFieldTransform(rawVal, map.transform_rule);
    if (transformed !== null && transformed !== undefined) {
      output[map.canonical_field] = transformed;
    }
  }
  return output;
}

module.exports = {
   DEFAULT_SAP_FIELD_MAPPINGS,
  FIELD_DISCOVERY_CATALOG,
  applyFieldTransform,
  detectTargetCanonicalEntity,
  inferFieldDataType,
  proposeFieldMappings,
  transformSourceRowToCanonical
};
