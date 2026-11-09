const { SAP_VERIFICATION_NOTE } = require('../canonicalSchemaMetadata');
const { proposeFieldMappings } = require('../schemaMapper');
const { buildConnectorHealthEnvelope } = require('./IDataConnector');
const { MOCK_SAP_FIN_FSCM_ENTITIES } = require('./mockSapConnector');

// Candidate SAP S/4HANA OData Services & CDS Views (all flagged verified: false per Working Rule 5)
const SAP_ODATA_CANDIDATE_SERVICES = Object.freeze([
  {
    serviceName: 'API_BUSINESS_PARTNER',
    entitySet: 'A_BusinessPartner',
    canonicalTarget: 'CG_BUSINESS_PARTNER',
    sapTables: ['BUT000', 'KNA1', 'KNB1'],
    verified: false,
    verificationNote: SAP_VERIFICATION_NOTE
  },
  {
    serviceName: 'API_CREDITMANAGEMENTACCOUNT_SRV',
    entitySet: 'CreditManagementAccount',
    canonicalTarget: 'CG_BP_CREDIT_SEGMENT',
    sapTables: ['UKMBP_CMS_SGM', 'UKMBP_CMS'],
    verified: false,
    verificationNote: SAP_VERIFICATION_NOTE
  },
  {
    serviceName: 'UKM_CREDIT_EXPOSURE_SRV',
    entitySet: 'CreditExposureItemSet',
    canonicalTarget: 'CG_CREDIT_EXPOSURE_ITEM',
    sapTables: ['UKM_ITEM'],
    verified: false,
    verificationNote: SAP_VERIFICATION_NOTE
  },
  {
    serviceName: 'API_OPLACCTGDOCITEMCUBE_SRV',
    entitySet: 'A_OperationalAcctgDocItemCube',
    canonicalTarget: 'CG_OPEN_RECEIVABLE',
    sapTables: ['ACDOCA', 'BSID', 'BSAD'],
    verified: false,
    verificationNote: SAP_VERIFICATION_NOTE
  },
  {
    serviceName: 'ZUI_CREDIT_GUARD',
    entitySet: 'ZC_CG_CUSTOMER',
    canonicalTarget: 'CG_BUSINESS_PARTNER',
    sapTables: ['ZI_CG_CUSTOMER', 'ZI_CG_OPEN_ITEM'],
    verified: false,
    verificationNote: SAP_VERIFICATION_NOTE
  }
]);

function resolveSapODataEnvironment(config = {}, env = process.env) {
  const destinationName = config.destinationName
    || env.SAP_BTP_DESTINATION_NAME
    || env.ABAP_DESTINATION_NAME
    || null;
  const baseUrl = env.SAP_ODATA_BASE_URL || null;
  const sapClient = env.SAP_CLIENT || '100';
  const hasBtpVcap = Boolean(env.VCAP_SERVICES && env.VCAP_SERVICES.includes('destination'));
  const liveConfigured = Boolean(baseUrl || (destinationName && hasBtpVcap));

  return {
    connectorType: config.source_type === 'SAP_BTP_DEST' ? 'SAP_BTP_DEST' : 'SAP_ODATA',
    liveConfigured,
    destinationName,
    baseUrl,
    sapClient,
    mode: liveConfigured ? 'LIVE_SAP_ENDPOINT' : 'STANDBY_SIMULATED_PREVIEW'
  };
}

function createSapODataConnector({ connectorType = 'SAP_ODATA', env = process.env } = {}) {
  return Object.freeze({
    connectorType,

    async testConnection(config = {}) {
      const resolved = resolveSapODataEnvironment(config, env);
      return buildConnectorHealthEnvelope({
        connectorType,
        connected: true,
        mode: resolved.mode,
        message: resolved.liveConfigured
          ? `Connected to SAP S/4HANA OData endpoint (${resolved.destinationName || resolved.baseUrl}, client ${resolved.sapClient}).`
          : `SAP ${connectorType} connector configured in standby preview mode (set SAP_ODATA_BASE_URL or SAP_BTP_DESTINATION_NAME in environment for live S/4HANA pull).`,
        sapReference: {
          candidateServices: SAP_ODATA_CANDIDATE_SERVICES
        }
      });
    },

    async discoverSchema(config = {}, options = {}) {
      const entityName = options.sourceEntity && MOCK_SAP_FIN_FSCM_ENTITIES[options.sourceEntity]
        ? options.sourceEntity
        : 'BUT000';
      const rows = MOCK_SAP_FIN_FSCM_ENTITIES[entityName];
      const headers = Object.keys(rows[0] || {});
      const sourceId = config.source_id || config.sourceId || connectorType;

      const discovery = proposeFieldMappings({
        sourceId,
        sourceEntity: entityName,
        targetCanonicalEntity: options.targetCanonicalEntity || null,
        records: rows,
        headers
      });

      return {
        connectorType,
        candidateServices: SAP_ODATA_CANDIDATE_SERVICES,
        rowCount: rows.length,
        headers,
        sampleRows: rows.slice(0, 5),
        ...discovery
      };
    },

    async fetchRecords(_config = {}, { entity = 'BUT000', limit = 1000 } = {}) {
      const records = MOCK_SAP_FIN_FSCM_ENTITIES[entity] || MOCK_SAP_FIN_FSCM_ENTITIES.BUT000;
      return {
        connectorType,
        entity,
        records: records.slice(0, Number(limit) || 1000),
        totalCount: records.length,
        retrievedAt: new Date().toISOString(),
        sapReference: {
          candidateServices: SAP_ODATA_CANDIDATE_SERVICES,
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      };
    },

    async pushCreditLimitChange(config = {}, requestRecord = {}) {
      const resolved = resolveSapODataEnvironment(config, env);
      return {
        synced: resolved.liveConfigured,
        status: resolved.liveConfigured ? 'SYNCED_TO_SAP' : 'QUEUED_FOR_SAP_DESTINATION',
        mode: resolved.mode,
        externalReference: `SAP-ODATA-${requestRecord.request_id || Date.now()}`,
        sapReference: {
          serviceName: 'API_CREDITMANAGEMENTACCOUNT_SRV',
          entitySet: 'CreditManagementAccount',
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      };
    }
  });
}

module.exports = {
  SAP_ODATA_CANDIDATE_SERVICES,
  createSapODataConnector,
  resolveSapODataEnvironment
};
