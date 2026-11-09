const SAP_VERIFICATION_NOTE = 'verify in SE11/SE16N or SAP Business Accelerator Hub';

const CANONICAL_SOURCE_TYPES = Object.freeze([
  'FILE',
  'SAP_ODATA',
  'SAP_BTP_DEST',
  'HANA',
  'REST_API',
  'MOCK_SAP'
]);

const EXPOSURE_CATEGORIES = Object.freeze([
  'OPEN_ORDER',
  'OPEN_DELIVERY',
  'OPEN_BILLING',
  'OPEN_INVOICE'
]);

const THRESHOLD_STATUSES = Object.freeze([
  'NORMAL',
  'WARNING',
  'CRITICAL',
  'BREACH',
  'BLOCKED'
]);

const LIMIT_REQUEST_STATUSES = Object.freeze([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SYNCED_TO_SAP'
]);

const TRANSFORM_RULES = Object.freeze([
  'NONE',
  'TRIM',
  'DATE_YYYYMMDD',
  'DECIMAL',
  'CURRENCY_ISO',
  'PAD_LEFT_10',
  'BOOLEAN_FLAG'
]);

const CANONICAL_TABLES = Object.freeze({
  CG_DATA_SOURCE: Object.freeze({
    cdsEntity: 'credit.CG_DATA_SOURCE',
    layer: 'REGISTRY',
    primaryKey: ['source_id'],
    sapReference: null
  }),
  CG_FIELD_MAPPING: Object.freeze({
    cdsEntity: 'credit.CG_FIELD_MAPPING',
    layer: 'REGISTRY',
    primaryKey: ['mapping_id'],
    sapReference: null
  }),
  CG_RAW_PAYLOAD: Object.freeze({
    cdsEntity: 'credit.CG_RAW_PAYLOAD',
    layer: 'RAW',
    primaryKey: ['payload_id'],
    sapReference: null
  }),
  CG_BUSINESS_PARTNER: Object.freeze({
    cdsEntity: 'credit.CG_BUSINESS_PARTNER',
    layer: 'CANONICAL',
    primaryKey: ['bp_id'],
    sapReference: Object.freeze({
      tables: ['BUT000', 'KNA1', 'KNB1'],
      odataServices: ['API_BUSINESS_PARTNER'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_BP_CREDIT_SEGMENT: Object.freeze({
    cdsEntity: 'credit.CG_BP_CREDIT_SEGMENT',
    layer: 'CANONICAL',
    primaryKey: ['bp_id', 'credit_segment'],
    sapReference: Object.freeze({
      tables: ['UKMBP_CMS_SGM', 'UKMBP_CMS'],
      odataServices: ['API_CREDITMANAGEMENTACCOUNT_SRV'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_CREDIT_EXPOSURE_ITEM: Object.freeze({
    cdsEntity: 'credit.CG_CREDIT_EXPOSURE_ITEM',
    layer: 'CANONICAL',
    primaryKey: ['item_id'],
    sapReference: Object.freeze({
      tables: ['UKM_ITEM', 'VBAK', 'LIKP', 'VBRK', 'ACDOCA'],
      odataServices: ['UKM_CREDIT_EXPOSURE_SRV'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_OPEN_RECEIVABLE: Object.freeze({
    cdsEntity: 'credit.CG_OPEN_RECEIVABLE',
    layer: 'CANONICAL',
    primaryKey: ['receivable_id'],
    sapReference: Object.freeze({
      tables: ['ACDOCA', 'BSID'],
      odataServices: ['API_OPLACCTGDOCITEMCUBE_SRV'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_PAYMENT_HISTORY: Object.freeze({
    cdsEntity: 'credit.CG_PAYMENT_HISTORY',
    layer: 'CANONICAL',
    primaryKey: ['payment_id'],
    sapReference: Object.freeze({
      tables: ['ACDOCA', 'BSAD'],
      odataServices: ['API_OPLACCTGDOCITEMCUBE_SRV'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_EXPOSURE_SNAPSHOT: Object.freeze({
    cdsEntity: 'credit.CG_EXPOSURE_SNAPSHOT',
    layer: 'CALCULATION',
    primaryKey: ['snapshot_id'],
    sapReference: Object.freeze({
      tables: ['UKMBP_CMS_SGM', 'UKM_ITEM'],
      odataServices: [],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  }),
  CG_CREDIT_LIMIT_REQUEST: Object.freeze({
    cdsEntity: 'credit.CG_CREDIT_LIMIT_REQUEST',
    layer: 'WORKFLOW',
    primaryKey: ['request_id'],
    sapReference: Object.freeze({
      tables: ['UKMBP_CMS_SGM', 'UKM_CASE'],
      odataServices: ['API_CREDITMANAGEMENTACCOUNT_SRV'],
      verified: false,
      verificationNote: SAP_VERIFICATION_NOTE
    })
  })
});

const DEFAULT_SAP_FIELD_MAPPINGS = Object.freeze([
  // CG_BUSINESS_PARTNER (BUT000 / KNA1 / KNB1)
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'bp_id',
    sap_reference_table: 'BUT000',
    sap_reference_field: 'PARTNER',
    transform_rule: 'PAD_LEFT_10',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'bp_name',
    sap_reference_table: 'BUT000',
    sap_reference_field: 'NAME_ORG1',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'country_code',
    sap_reference_table: 'KNA1',
    sap_reference_field: 'LAND1',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BUSINESS_PARTNER',
    canonical_field: 'company_code',
    sap_reference_table: 'KNB1',
    sap_reference_field: 'BUKRS',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  // CG_BP_CREDIT_SEGMENT (UKMBP_CMS_SGM / UKMBP_CMS)
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_segment',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'CREDIT_SGMNT',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_limit',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'CREDIT_LIMIT',
    transform_rule: 'DECIMAL',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'credit_blocked',
    sap_reference_table: 'UKMBP_CMS_SGM',
    sap_reference_field: 'XBLOCKED',
    transform_rule: 'BOOLEAN_FLAG',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_BP_CREDIT_SEGMENT',
    canonical_field: 'risk_class',
    sap_reference_table: 'UKMBP_CMS',
    sap_reference_field: 'RISK_CLASS',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  // CG_CREDIT_EXPOSURE_ITEM (UKM_ITEM)
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'exposure_category',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'COMM_TYP',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_CREDIT_EXPOSURE_ITEM',
    canonical_field: 'amount',
    sap_reference_table: 'UKM_ITEM',
    sap_reference_field: 'AMOUNT',
    transform_rule: 'DECIMAL',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  // CG_OPEN_RECEIVABLE (ACDOCA / BSID)
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'accounting_doc_no',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'BELNR',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'amount_doc_curr',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'WSL',
    transform_rule: 'DECIMAL',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_OPEN_RECEIVABLE',
    canonical_field: 'due_date',
    sap_reference_table: 'ACDOCA',
    sap_reference_field: 'NETDT',
    transform_rule: 'DATE_YYYYMMDD',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  // CG_PAYMENT_HISTORY (ACDOCA / BSAD)
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'payment_doc_no',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'AUGBL',
    transform_rule: 'TRIM',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  },
  {
    canonical_entity: 'CG_PAYMENT_HISTORY',
    canonical_field: 'payment_date',
    sap_reference_table: 'BSAD',
    sap_reference_field: 'AUGDT',
    transform_rule: 'DATE_YYYYMMDD',
    verified: false,
    verification_note: SAP_VERIFICATION_NOTE
  }
].map(entry => Object.freeze(entry)));

function createSapMappingEnvelope(mapping = {}) {
  return {
    ...mapping,
    sap_reference_verified: Boolean(mapping.sap_reference_verified === true),
    verification_note: mapping.verification_note || SAP_VERIFICATION_NOTE
  };
}

module.exports = {
  CANONICAL_SOURCE_TYPES,
  CANONICAL_TABLES,
  DEFAULT_SAP_FIELD_MAPPINGS,
  EXPOSURE_CATEGORIES,
  LIMIT_REQUEST_STATUSES,
  SAP_VERIFICATION_NOTE,
  THRESHOLD_STATUSES,
  TRANSFORM_RULES,
  createSapMappingEnvelope
};
