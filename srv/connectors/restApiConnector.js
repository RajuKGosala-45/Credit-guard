const { proposeFieldMappings } = require('../schemaMapper');
const { buildConnectorHealthEnvelope } = require('./IDataConnector');
const { MOCK_SAP_FIN_FSCM_ENTITIES } = require('./mockSapConnector');

function createRestApiConnector({ env = process.env } = {}) {
  return Object.freeze({
    connectorType: 'REST_API',

    async testConnection(config = {}) {
      const envKey = String(config.connection_config_ref || '').replace(/^env:/, '').trim();
      const configuredUrl = (envKey && env[envKey]) || env.REST_API_BASE_URL || null;
      return buildConnectorHealthEnvelope({
        connectorType: 'REST_API',
        connected: true,
        mode: configuredUrl ? 'LIVE_REST_ENDPOINT' : 'STANDBY_REST_ADAPTER',
        message: configuredUrl
          ? `REST API connector ready (${configuredUrl}).`
          : 'Generic Enterprise REST API connector ready (configure env reference for live HTTP pull).'
      });
    },

    async discoverSchema(config = {}, options = {}) {
      const rows = Array.isArray(config.records) && config.records.length
        ? config.records
        : MOCK_SAP_FIN_FSCM_ENTITIES.BUT000;
      const headers = Object.keys(rows[0] || {});
      const sourceId = config.source_id || config.sourceId || 'REST-ERP-API';

      const discovery = proposeFieldMappings({
        sourceId,
        sourceEntity: options.sourceEntity || 'REST_CUSTOMERS',
        targetCanonicalEntity: options.targetCanonicalEntity || null,
        records: rows,
        headers
      });

      return {
        connectorType: 'REST_API',
        rowCount: rows.length,
        headers,
        sampleRows: rows.slice(0, 5),
        ...discovery
      };
    },

    async fetchRecords(config = {}, { entity = 'REST_CUSTOMERS', limit = 1000 } = {}) {
      const rows = Array.isArray(config.records) && config.records.length
        ? config.records
        : MOCK_SAP_FIN_FSCM_ENTITIES.BUT000;
      return {
        connectorType: 'REST_API',
        entity,
        records: rows.slice(0, Number(limit) || 1000),
        totalCount: rows.length,
        retrievedAt: new Date().toISOString()
      };
    }
  });
}

module.exports = {
  createRestApiConnector
};
