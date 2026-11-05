const { ENTITY_TYPES } = require('./canonicalData');
const { SOURCE_TYPES } = require('./sourceRegistry');

class ConnectorError extends Error {
  constructor(message, { category = 'connector_unavailable', statusCode = 503, cause } = {}) {
    super(message, { cause });
    this.name = 'ConnectorError';
    this.category = category;
    this.statusCode = statusCode;
  }
}

function isAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || new ConnectorError('Connector operation was cancelled.', {
    category: 'connector_cancelled',
    statusCode: 503
  });
}

function validatePage(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)
    || !Array.isArray(page.records) || typeof page.complete !== 'boolean') {
    throw new ConnectorError('Connector returned an invalid page.', {
      category: 'connector_invalid_response',
      statusCode: 502
    });
  }
  if (page.nextCursor !== undefined && page.nextCursor !== null
    && (typeof page.nextCursor !== 'string' || !page.nextCursor.trim())) {
    throw new ConnectorError('Connector returned an invalid cursor.', {
      category: 'connector_invalid_response',
      statusCode: 502
    });
  }
  if (page.sourceTimestamp !== undefined && page.sourceTimestamp !== null
    && (typeof page.sourceTimestamp !== 'string' || !Number.isFinite(Date.parse(page.sourceTimestamp)))) {
    throw new ConnectorError('Connector returned an invalid source timestamp.', {
      category: 'connector_invalid_response',
      statusCode: 502
    });
  }
  return page;
}

function validateConnector(connector) {
  const capabilities = connector?.capabilities;
  if (typeof connector?.read !== 'function' || typeof capabilities !== 'function') {
    throw new TypeError('Connector must implement capabilities() and read().');
  }
  const descriptor = capabilities();
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || !Array.isArray(descriptor.entities) || descriptor.entities.length === 0
    || descriptor.entities.some(entity => !ENTITY_TYPES.includes(entity))
    || new Set(descriptor.entities).size !== descriptor.entities.length
    || typeof descriptor.supportsIncremental !== 'boolean'
    || typeof descriptor.supportsCancellation !== 'boolean') {
    throw new TypeError('Connector capabilities are invalid.');
  }
  return Object.freeze({
    entities: Object.freeze([...descriptor.entities]),
    supportsIncremental: descriptor.supportsIncremental,
    supportsCancellation: descriptor.supportsCancellation
  });
}

function createConnectorManager({ configurationResolver, adapters = [] } = {}) {
  if (!Array.isArray(adapters)) throw new TypeError('Connector adapters must be an array.');
  const connectors = new Map();
  for (const { sourceType, connector } of adapters) {
    if (!SOURCE_TYPES.includes(sourceType)) throw new TypeError('Connector source type is not supported.');
    if (connectors.has(sourceType)) throw new TypeError(`Connector already registered for ${sourceType}.`);
    connectors.set(sourceType, { connector, capabilities: validateConnector(connector) });
  }

  return Object.freeze({
    capabilities(sourceType) {
      const entry = connectors.get(sourceType);
      if (!entry) {
        throw new ConnectorError(`No connector is registered for ${sourceType}.`, {
          category: 'connector_not_implemented',
          statusCode: 501
        });
      }
      return { ...entry.capabilities, entities: [...entry.capabilities.entities] };
    },

    async read(source, request) {
      if (!source || source.enabled !== true) {
        throw new ConnectorError('Source is not enabled.', {
          category: 'source_disabled',
          statusCode: 409
        });
      }
      const entry = connectors.get(source.sourceType);
      if (!entry) {
        throw new ConnectorError(`No connector is registered for ${source.sourceType}.`, {
          category: 'connector_not_implemented',
          statusCode: 501
        });
      }
      if (!entry.capabilities.entities.includes(request.entityType)
        || !source.supportedEntities.includes(request.entityType)) {
        throw new ConnectorError(`Source ${source.sourceId} does not support ${request.entityType}.`, {
          category: 'entity_not_supported',
          statusCode: 400
        });
      }
      if (request.signal && !entry.capabilities.supportsCancellation) {
        throw new ConnectorError('Connector cannot guarantee cancellation for this operation.', {
          category: 'cancellation_not_supported',
          statusCode: 501
        });
      }
      if (request.since !== undefined && !entry.capabilities.supportsIncremental) {
        throw new ConnectorError('Incremental extraction is not supported by this connector.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      if (request.deadlineAt !== undefined
        && (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= Date.now())) {
        throw new ConnectorError('Connector execution deadline has expired.', {
          category: 'connector_deadline_exceeded',
          statusCode: 504
        });
      }
      isAborted(request.signal);

      let config;
      try {
        if (typeof configurationResolver !== 'function') {
          throw new ConnectorError('No trusted source configuration resolver is available.', {
            category: 'source_configuration_unavailable',
            statusCode: 503
          });
        }
        config = await configurationResolver(source);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError('Source configuration could not be resolved.', {
          category: 'source_configuration_unavailable',
          statusCode: 503,
          cause: error
        });
      }
      isAborted(request.signal);
      if (request.deadlineAt !== undefined && request.deadlineAt <= Date.now()) {
        throw new ConnectorError('Connector execution deadline has expired.', {
          category: 'connector_deadline_exceeded',
          statusCode: 504
        });
      }
      try {
        const page = validatePage(await entry.connector.read({
          source,
          config,
          ...request,
          capabilities: entry.capabilities
        }));
        const entityConfig = config?.entityMappings?.[request.entityType];
        return {
          ...page,
          mapping: page.mapping || entityConfig?.fields,
          sourceEntity: page.sourceEntity || entityConfig?.sourceEntity,
          sourceRecordIdField: page.sourceRecordIdField || entityConfig?.sourceRecordIdField,
          sourceUpdatedAtField: page.sourceUpdatedAtField || entityConfig?.sourceUpdatedAtField
        };
      } catch (error) {
        if (error instanceof ConnectorError || error?.category) throw error;
        throw new ConnectorError('Source retrieval failed.', {
          category: 'connector_retrieval_failed',
          statusCode: 503,
          cause: error
        });
      }
    }
  });
}

function createAbapODataConnector({ client }) {
  if (!client || typeof client.readCollection !== 'function') {
    throw new TypeError('ABAP connector requires the existing read-only ABAP client.');
  }
  return {
    capabilities() {
      return {
        entities: ['CUSTOMER'],
        supportsIncremental: false,
        supportsCancellation: true
      };
    },

    async read({ source, config, entityType, cursor, since, signal, deadlineAt, pageSize }) {
      isAborted(signal);
      if (source.authenticationReference !== `destination:${client.destinationName}`) {
        throw new ConnectorError('SAP source authentication reference does not match the configured ABAP destination.', {
          category: 'source_authentication_mismatch',
          statusCode: 403
        });
      }
      if (cursor || since) {
        throw new ConnectorError('The current ABAP collection adapter supports full reads only.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      const mapping = config?.entityMappings?.[entityType];
      if (!mapping || mapping.sourceEntity !== 'Customers'
        || !mapping.fields || typeof mapping.fields !== 'object' || Array.isArray(mapping.fields)) {
        throw new ConnectorError('Approved ABAP entity and field mapping is unavailable.', {
          category: 'source_mapping_unavailable',
          statusCode: 503
        });
      }
      const collectionPath = mapping.sourceEntity === 'Customers'
        ? client.customersPath : client.openItemsPath;
      const records = await client.readCollection(
        collectionPath,
        { '$top': pageSize || client.pageSize },
        `ingest_${mapping.sourceEntity.toLowerCase()}`,
        { signal, deadlineAt }
      );
      isAborted(signal);
      return {
        records,
        nextCursor: null,
        sourceTimestamp: null,
        retrievedAt: new Date().toISOString(),
        complete: true,
        mapping: mapping.fields,
        sourceEntity: mapping.sourceEntity
      };
    }
  };
}

module.exports = {
  ConnectorError,
  createAbapODataConnector,
  createConnectorManager,
  validateConnector,
  validatePage
};
