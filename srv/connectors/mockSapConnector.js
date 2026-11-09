const { SAP_VERIFICATION_NOTE } = require('../canonicalSchemaMetadata');
const { proposeFieldMappings } = require('../schemaMapper');
const { buildConnectorHealthEnvelope } = require('./IDataConnector');

// Realistic SAP S/4HANA FIN-FSCM-CR Seed Dataset across 5 Company Codes (BS01..BS05) and 4 Countries (India, UAE, Singapore, Germany)
// All SAP table and field names carry verified: false ("verify in SE11/SE16N or SAP Business Accelerator Hub")
const MOCK_SAP_FIN_FSCM_ENTITIES = Object.freeze({
  BUT000: Object.freeze([
    { PARTNER: 'C001', BPEXT: 'BP-100001', NAME_ORG1: 'Aarav Components', LAND1: 'India', BUKRS: 'BS01', RISK_CLASS: 'A', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C002', BPEXT: 'BP-100002', NAME_ORG1: 'Desert Star Trading', LAND1: 'UAE', BUKRS: 'BS02', RISK_CLASS: 'B', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C003', BPEXT: 'BP-100003', NAME_ORG1: 'Merlion Systems', LAND1: 'Singapore', BUKRS: 'BS03', RISK_CLASS: 'A', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C004', BPEXT: 'BP-100004', NAME_ORG1: 'Indus Retail Group', LAND1: 'India', BUKRS: 'BS04', RISK_CLASS: 'B', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C005', BPEXT: 'BP-100005', NAME_ORG1: 'Gulf Horizon LLC', LAND1: 'UAE', BUKRS: 'BS05', RISK_CLASS: 'C', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C006', BPEXT: 'BP-100006', NAME_ORG1: 'Monsoon Logistics', LAND1: 'India', BUKRS: 'BS01', RISK_CLASS: 'C', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C007', BPEXT: 'BP-100007', NAME_ORG1: 'Lotus Industrial', LAND1: 'India', BUKRS: 'BS02', RISK_CLASS: 'A', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C008', BPEXT: 'BP-100008', NAME_ORG1: 'Pearl Coast Foods', LAND1: 'UAE', BUKRS: 'BS03', RISK_CLASS: 'B', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C009', BPEXT: 'BP-100009', NAME_ORG1: 'Orchid Digital', LAND1: 'Singapore', BUKRS: 'BS04', RISK_CLASS: 'A', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C010', BPEXT: 'BP-100010', NAME_ORG1: 'Saffron Textiles', LAND1: 'India', BUKRS: 'BS05', RISK_CLASS: 'C', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C011', BPEXT: 'BP-100011', NAME_ORG1: 'Lion City Supplies', LAND1: 'Singapore', BUKRS: 'BS01', RISK_CLASS: 'B', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C012', BPEXT: 'BP-100012', NAME_ORG1: 'Bluewater Services', LAND1: 'UAE', BUKRS: 'BS02', RISK_CLASS: 'A', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' },
    { PARTNER: 'C013', BPEXT: 'BP-100013', NAME_ORG1: 'Northstar Components', LAND1: 'India', BUKRS: 'BS03', RISK_CLASS: 'B', CREDIT_SGMNT: 'MAIN', WAERS: 'INR' }
  ]),
  UKMBP_CMS_SGM: Object.freeze([
    { PARTNER: 'C001', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '1000000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'A', FOLLOW_UP_DT: '20260315' },
    { PARTNER: 'C002', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '800000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'B', FOLLOW_UP_DT: '20260120' },
    { PARTNER: 'C003', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '1000000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'A', FOLLOW_UP_DT: '20260501' },
    { PARTNER: 'C004', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '500000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'B', FOLLOW_UP_DT: '20251110' },
    { PARTNER: 'C005', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '1000000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'C', FOLLOW_UP_DT: '20260404' },
    { PARTNER: 'C006', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '500000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'C', FOLLOW_UP_DT: '20260611' },
    { PARTNER: 'C007', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '600000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'A', FOLLOW_UP_DT: '20260214' },
    { PARTNER: 'C008', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '700000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'B', FOLLOW_UP_DT: '20260102' },
    { PARTNER: 'C009', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '800000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'A', FOLLOW_UP_DT: '20260522' },
    { PARTNER: 'C010', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '900000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'C', FOLLOW_UP_DT: '20251201' },
    { PARTNER: 'C011', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '400000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'B', FOLLOW_UP_DT: '20260208' },
    { PARTNER: 'C012', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '1200000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'A', FOLLOW_UP_DT: '20260630' },
    { PARTNER: 'C013', CREDIT_SGMNT: 'MAIN', CREDIT_LIMIT: '1000000.00', WAERS: 'INR', LIMIT_VALID_DATE: '20261231', XBLOCKED: '', RISK_CLASS: 'B', FOLLOW_UP_DT: '20260415' }
  ]),
  UKM_ITEM: Object.freeze([
    { ITEM_KEY: 'I001', PARTNER: 'C001', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS01', COMM_TYP: 'OPEN_INVOICE', OBJKEY: 'INV-90001', AMOUNT: '200000.00', WAERS: 'INR', NETDT: '20261025' },
    { ITEM_KEY: 'I002', PARTNER: 'C001', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS01', COMM_TYP: 'OPEN_ORDER', OBJKEY: 'SO-50001', AMOUNT: '760000.00', WAERS: 'INR', NETDT: '20261115' },
    { ITEM_KEY: 'I003', PARTNER: 'C001', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS01', COMM_TYP: 'OPEN_INVOICE', OBJKEY: 'INV-90002', AMOUNT: '240000.00', WAERS: 'INR', NETDT: '20261201' },
    { ITEM_KEY: 'I004', PARTNER: 'C002', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS02', COMM_TYP: 'OPEN_INVOICE', OBJKEY: 'INV-90004', AMOUNT: '150000.00', WAERS: 'INR', NETDT: '20261020' },
    { ITEM_KEY: 'I005', PARTNER: 'C002', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS02', COMM_TYP: 'OPEN_ORDER', OBJKEY: 'SO-50002', AMOUNT: '570000.00', WAERS: 'INR', NETDT: '20261120' },
    { ITEM_KEY: 'I006', PARTNER: 'C002', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS02', COMM_TYP: 'OPEN_INVOICE', OBJKEY: 'INV-90006', AMOUNT: '180000.00', WAERS: 'INR', NETDT: '20261210' },
    { ITEM_KEY: 'I007', PARTNER: 'C003', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS03', COMM_TYP: 'OPEN_INVOICE', OBJKEY: 'INV-90007', AMOUNT: '475000.00', WAERS: 'INR', NETDT: '20261024' },
    { ITEM_KEY: 'I008', PARTNER: 'C003', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS03', COMM_TYP: 'OPEN_DELIVERY', OBJKEY: 'DLV-80003', AMOUNT: '285000.00', WAERS: 'INR', NETDT: '20261124' },
    { ITEM_KEY: 'I009', PARTNER: 'C003', CREDIT_SGMNT: 'MAIN', BUKRS: 'BS03', COMM_TYP: 'OPEN_BILLING', OBJKEY: 'BIL-70003', AMOUNT: '190000.00', WAERS: 'INR', NETDT: '20261214' }
  ]),
  ACDOCA: Object.freeze([
    { BELNR: 'I001', KUNNR: 'C001', BUKRS: 'BS01', GJAHR: '2026', BUZEI: '001', WSL: '200000.00', HSL: '200000.00', WAERS: 'INR', NETDT: '20261025', MANST: '1', DISPUTE: '' },
    { BELNR: 'I003', KUNNR: 'C001', BUKRS: 'BS01', GJAHR: '2026', BUZEI: '001', WSL: '240000.00', HSL: '240000.00', WAERS: 'INR', NETDT: '20261201', MANST: '0', DISPUTE: '' },
    { BELNR: 'I004', KUNNR: 'C002', BUKRS: 'BS02', GJAHR: '2026', BUZEI: '001', WSL: '150000.00', HSL: '150000.00', WAERS: 'INR', NETDT: '20261020', MANST: '1', DISPUTE: '' },
    { BELNR: 'I007', KUNNR: 'C003', BUKRS: 'BS03', GJAHR: '2026', BUZEI: '001', WSL: '475000.00', HSL: '475000.00', WAERS: 'INR', NETDT: '20261024', MANST: '1', DISPUTE: '' }
  ]),
  BSAD: Object.freeze([
    { AUGBL: 'P001', KUNNR: 'C001', BUKRS: 'BS01', REBZG: 'INV-8901', AUGDT: '20261001', WRBTR: '150000.00', WAERS: 'INR' },
    { AUGBL: 'P002', KUNNR: 'C002', BUKRS: 'BS02', REBZG: 'INV-8902', AUGDT: '20261005', WRBTR: '120000.00', WAERS: 'INR' },
    { AUGBL: 'P003', KUNNR: 'C003', BUKRS: 'BS03', REBZG: 'INV-8903', AUGDT: '20261012', WRBTR: '210000.00', WAERS: 'INR' }
  ])
});

function createMockSapConnector() {
  return Object.freeze({
    connectorType: 'MOCK_SAP',

    async testConnection() {
      return buildConnectorHealthEnvelope({
        connectorType: 'MOCK_SAP',
        connected: true,
        mode: 'SIMULATED_FIN_FSCM_CR',
        message: 'Mock SAP S/4HANA FIN-FSCM-CR seed connector ready (BUT000, UKMBP_CMS_SGM, UKM_ITEM, ACDOCA, BSAD).',
        sapReference: {
          tables: Object.keys(MOCK_SAP_FIN_FSCM_ENTITIES)
        }
      });
    },

    async discoverSchema(config = {}, options = {}) {
      const entityName = options.sourceEntity && MOCK_SAP_FIN_FSCM_ENTITIES[options.sourceEntity]
        ? options.sourceEntity
        : 'BUT000';
      const rows = MOCK_SAP_FIN_FSCM_ENTITIES[entityName];
      const headers = Object.keys(rows[0] || {});
      const sourceId = config.source_id || config.sourceId || 'MOCK-SAP-FIN-FSCM';
      const discovery = proposeFieldMappings({
        sourceId,
        sourceEntity: entityName,
        targetCanonicalEntity: options.targetCanonicalEntity || null,
        records: rows,
        headers
      });

      return {
        connectorType: 'MOCK_SAP',
        availableEntities: Object.keys(MOCK_SAP_FIN_FSCM_ENTITIES).map(table => ({
          entity: table,
          rowCount: MOCK_SAP_FIN_FSCM_ENTITIES[table].length,
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        })),
        rowCount: rows.length,
        headers,
        sampleRows: rows.slice(0, 5),
        ...discovery
      };
    },

    async fetchRecords(_config = {}, { entity = 'BUT000', limit = 1000 } = {}) {
      const records = MOCK_SAP_FIN_FSCM_ENTITIES[entity] || MOCK_SAP_FIN_FSCM_ENTITIES.BUT000;
      return {
        connectorType: 'MOCK_SAP',
        entity,
        records: records.slice(0, Number(limit) || 1000),
        totalCount: records.length,
        retrievedAt: new Date().toISOString(),
        sapReference: {
          table: entity,
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      };
    },

    async pushCreditLimitChange(_config = {}, requestRecord = {}) {
      return {
        synced: true,
        status: 'SIMULATED_SAP_UKMBP_CMS_SGM',
        mode: 'MOCK_SAP',
        externalReference: `UKM-SIM-${requestRecord.request_id || Date.now()}`,
        sapReference: {
          table: 'UKMBP_CMS_SGM',
          field: 'CREDIT_LIMIT',
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      };
    }
  });
}

module.exports = {
  MOCK_SAP_FIN_FSCM_ENTITIES,
  createMockSapConnector
};
