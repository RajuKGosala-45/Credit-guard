const { ConnectorError } = require('../../connectorManager');
const fixture = require('./fixtures.json');

const SOURCE_TYPE = 'MOCK_SAP_SIMULATOR';
const CONFIGURATION_REFERENCE = 'config:mock-sap-simulator';
const SUPPORTED_ENTITIES = Object.freeze(Object.keys(fixture.entities));

function getMockSapSourceDefinition() {
  return {
    sourceId: fixture.source.systemId,
    sourceName: fixture.source.name,
    sourceType: SOURCE_TYPE,
    enabled: true,
    supportedEntities: [...SUPPORTED_ENTITIES],
    mappingVersion: fixture.source.mappingVersion,
    authenticationReference: null,
    configurationReference: CONFIGURATION_REFERENCE
  };
}

function getMockSapSourceConfiguration() {
  return {
    entityMappings: Object.fromEntries(SUPPORTED_ENTITIES.map(entityType => {
      const entity = fixture.entities[entityType];
      return [entityType, {
        sourceEntity: entity.sourceEntity,
        sourceRecordIdField: entity.sourceRecordIdField,
        fields: { ...entity.fields }
      }];
    }))
  };
}

function createMockSapConnector({ now = () => new Date() } = {}) {
  return {
    capabilities() {
      return {
        entities: [...SUPPORTED_ENTITIES],
        supportsIncremental: false,
        supportsCancellation: true
      };
    },

    async read({ source, config, entityType, cursor, since, signal, deadlineAt }) {
      if (source.sourceId !== fixture.source.systemId
        || source.sourceType !== SOURCE_TYPE
        || source.configurationReference !== CONFIGURATION_REFERENCE) {
        throw new ConnectorError('Registered source does not match the built-in Mock SAP Simulator.', {
          category: 'mock_sap_source_mismatch',
          statusCode: 409
        });
      }
      if (cursor || since) {
        throw new ConnectorError('Mock SAP fixture extraction supports full reads only.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      if (!SUPPORTED_ENTITIES.includes(entityType)) {
        throw new ConnectorError('Mock SAP fixture does not support the requested entity.', {
          category: 'entity_not_supported',
          statusCode: 400
        });
      }
      if (signal?.aborted) throw signal.reason;
      if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
        throw new ConnectorError('Mock SAP extraction deadline has expired.', {
          category: 'connector_deadline_exceeded',
          statusCode: 504
        });
      }

      const entity = fixture.entities[entityType];
      const configuredMapping = config?.entityMappings?.[entityType];
      if (!configuredMapping
        || configuredMapping.sourceEntity !== entity.sourceEntity
        || configuredMapping.sourceRecordIdField !== entity.sourceRecordIdField
        || JSON.stringify(configuredMapping.fields) !== JSON.stringify(entity.fields)) {
        throw new ConnectorError('Trusted Mock SAP mapping is unavailable.', {
          category: 'source_mapping_unavailable',
          statusCode: 503
        });
      }
      const retrievedAt = now();
      if (!(retrievedAt instanceof Date) || !Number.isFinite(retrievedAt.getTime())) {
        throw new TypeError('Mock SAP connector clock is invalid.');
      }
      return {
        records: structuredClone(entity.records),
        sourceEntity: entity.sourceEntity,
        sourceRecordIdField: entity.sourceRecordIdField,
        mapping: { ...entity.fields },
        nextCursor: null,
        sourceTimestamp: null,
        retrievedAt: retrievedAt.toISOString(),
        complete: true
      };
    }
  };
}

module.exports = {
  CONFIGURATION_REFERENCE,
  SOURCE_TYPE,
  createMockSapConnector,
  getMockSapSourceConfiguration,
  getMockSapSourceDefinition
};
