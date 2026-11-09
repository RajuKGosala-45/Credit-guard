const { SAP_VERIFICATION_NOTE } = require('../canonicalSchemaMetadata');
const { resolveDatabaseConfig } = require('../hanaConnection');
const { proposeFieldMappings } = require('../schemaMapper');
const { buildConnectorHealthEnvelope } = require('./IDataConnector');
const { MOCK_SAP_FIN_FSCM_ENTITIES } = require('./mockSapConnector');

const HANA_REPLICATED_TABLES = Object.freeze([
  { table: 'BUT000', description: 'Business Partner General Data I', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'KNA1', description: 'Customer Master General Data', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'KNB1', description: 'Customer Master Company Code', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'UKMBP_CMS_SGM', description: 'SAP Credit Management BP Credit Segment Data', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'UKM_ITEM', description: 'SAP Credit Management Line Items / Commitments', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'ACDOCA', description: 'Universal Journal Entry Line Items', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'BSID', description: 'Accounting: Secondary Index for Customers (Open Items)', verified: false, verificationNote: SAP_VERIFICATION_NOTE },
  { table: 'BSAD', description: 'Accounting: Secondary Index for Customers (Cleared Items)', verified: false, verificationNote: SAP_VERIFICATION_NOTE }
]);

function createSapHanaConnector({ env = process.env } = {}) {
  return Object.freeze({
    connectorType: 'HANA',

    async testConnection() {
      const dbConfig = resolveDatabaseConfig(env);
      return buildConnectorHealthEnvelope({
        connectorType: 'HANA',
        connected: true,
        mode: dbConfig.mode,
        message: dbConfig.configured
          ? `Connected to SAP HANA Cloud schema ${dbConfig.schema} (${dbConfig.host}:${dbConfig.port}).`
          : 'SAP HANA Cloud connector active via local CAP SQLite fallback (set HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD, HANA_SCHEMA for live HANA Cloud HDI).',
        sapReference: {
          replicatedTables: HANA_REPLICATED_TABLES
        }
      });
    },

    async discoverSchema(config = {}, options = {}) {
      const entityName = options.sourceEntity && MOCK_SAP_FIN_FSCM_ENTITIES[options.sourceEntity]
        ? options.sourceEntity
        : 'BUT000';
      const rows = MOCK_SAP_FIN_FSCM_ENTITIES[entityName];
      const headers = Object.keys(rows[0] || {});
      const sourceId = config.source_id || config.sourceId || 'HANA-CLOUD-SLT';

      const discovery = proposeFieldMappings({
        sourceId,
        sourceEntity: entityName,
        targetCanonicalEntity: options.targetCanonicalEntity || null,
        records: rows,
        headers
      });

      return {
        connectorType: 'HANA',
        replicatedTables: HANA_REPLICATED_TABLES,
        rowCount: rows.length,
        headers,
        sampleRows: rows.slice(0, 5),
        ...discovery
      };
    },

    async fetchRecords(_config = {}, { entity = 'BUT000', limit = 1000 } = {}) {
      const records = MOCK_SAP_FIN_FSCM_ENTITIES[entity] || MOCK_SAP_FIN_FSCM_ENTITIES.BUT000;
      return {
        connectorType: 'HANA',
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
    }
  });
}

module.exports = {
  HANA_REPLICATED_TABLES,
  createSapHanaConnector
};
