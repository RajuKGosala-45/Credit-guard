const fs = require('node:fs/promises');
const path = require('node:path');
const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { AbapClient } = require('./integrations/abap/client');
const {
  DEFAULT_MAX_RESPONSE_BYTES,
  createConfiguredConnectors
} = require('./configuredConnectors');
const { ConnectorError, createConnectorManager } = require('./connectorManager');
const {
  CONFIGURATION_REFERENCE: MOCK_SAP_CONFIGURATION_REFERENCE,
  getMockSapSourceConfiguration,
  getMockSapSourceDefinition
} = require('./integrations/mock-sap/connector');
const { ingestSource, latestCanonicalSnapshot } = require('./ingestionService');

function createIngestionRuntime({ db, configurationResolver, adapters = [] } = {}) {
  if (!db || typeof db.run !== 'function' || typeof db.tx !== 'function') {
    throw new TypeError('Ingestion runtime requires a transactional database.');
  }
  const connectorManager = createConnectorManager({ configurationResolver, adapters });
  return Object.freeze({
    run(options) {
      return ingestSource({ ...options, db, connectorManager });
    },
    getSnapshot(sourceId, entityType, options) {
      return latestCanonicalSnapshot(db, sourceId, entityType, options);
    }
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function configurationUnavailable() {
  return new ConnectorError('Trusted source configuration is unavailable.', {
    category: 'source_configuration_unavailable',
    statusCode: 503
  });
}

function validateOptionalLimit(value, maximum, settingName) {
  if (value !== undefined
    && (!Number.isSafeInteger(value) || value <= 0 || value > maximum)) {
    throw new ConnectorError(`${settingName} is invalid in trusted ingestion configuration.`, {
      category: 'ingestion_configuration_invalid',
      statusCode: 503
    });
  }
}

async function destinationHeaders(authenticationReference) {
  if (!authenticationReference) return {};
  const match = /^destination:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(authenticationReference);
  if (!match) {
    throw new ConnectorError('REST authentication must reference an approved SAP Destination.', {
      category: 'source_authentication_unavailable',
      statusCode: 503
    });
  }
  let destination;
  try {
    destination = await getDestination({ destinationName: match[1] });
  } catch (cause) {
    throw new ConnectorError('REST authentication destination is unavailable.', {
      category: 'source_authentication_unavailable',
      statusCode: 503,
      cause
    });
  }
  if (!destination?.url) throw configurationUnavailable();
  const headers = { ...(destination.headers || {}) };
  if (destination.sapClient) headers['sap-client'] = destination.sapClient;
  for (const token of destination.authTokens || []) {
    if (token?.error) {
      throw new ConnectorError('REST authentication destination did not provide an access token.', {
        category: 'source_authentication_unavailable',
        statusCode: 503
      });
    }
    const key = token?.http_header?.key;
    const value = token?.http_header?.value;
    if (typeof key === 'string' && typeof value === 'string') headers[key] = value;
  }
  if (destination.username !== undefined && destination.password !== undefined) {
    headers.authorization = `Basic ${Buffer.from(
      `${destination.username}:${destination.password}`
    ).toString('base64')}`;
  }
  if (Object.values(headers).some(value => typeof value !== 'string')) {
    throw new ConnectorError('REST authentication destination returned invalid headers.', {
      category: 'source_authentication_unavailable',
      statusCode: 503
    });
  }
  return { headers, destinationUrl: destination.url };
}

function configuredFileReader(settings, sourceConfigurations) {
  return async (configurationReference, { entityType, signal, deadlineAt }) => {
    const config = sourceConfigurations[configurationReference];
    const repository = config?.repository;
    const repositoryFile = repository?.files?.[entityType];
    const root = repository?.root;
    const format = repository?.formats?.[entityType];
    const approvedRoots = settings.approvedRepositoryRoots;
    if (typeof root !== 'string' || !path.isAbsolute(root)
      || !Array.isArray(approvedRoots) || !approvedRoots.some(item =>
        typeof item === 'string' && path.resolve(item) === path.resolve(root))
      || typeof repositoryFile !== 'string' || !repositoryFile.trim()
      || path.isAbsolute(repositoryFile)
      || typeof format !== 'string') {
      throw configurationUnavailable();
    }
    if (signal?.aborted) throw signal.reason;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new ConnectorError('Repository read deadline has expired.', {
        category: 'connector_timeout',
        statusCode: 504
      });
    }
    const resolvedRoot = await fs.realpath(root);
    const candidate = path.resolve(resolvedRoot, repositoryFile);
    if (!isWithin(resolvedRoot, candidate)) throw configurationUnavailable();
    const resolvedFile = await fs.realpath(candidate);
    if (!isWithin(resolvedRoot, resolvedFile)) throw configurationUnavailable();
    const metadata = await fs.stat(resolvedFile);
    if (!metadata.isFile()) throw configurationUnavailable();
    const maxBytes = settings.maxFileBytes === undefined
      ? DEFAULT_MAX_RESPONSE_BYTES : settings.maxFileBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 20 * 1024 * 1024
      || metadata.size > maxBytes) {
      throw new ConnectorError('Approved repository file exceeds its configured size limit.', {
        category: 'source_size_limit',
        statusCode: 413
      });
    }
    const buffer = await fs.readFile(resolvedFile);
    if (signal?.aborted) throw signal.reason;
    if (buffer.length > maxBytes) {
      throw new ConnectorError('Approved repository file exceeds its configured size limit.', {
        category: 'source_size_limit',
        statusCode: 413
      });
    }
    return {
      buffer,
      format,
      sourceTimestamp: repository.sourceTimestamps?.[entityType] || null,
      complete: true
    };
  };
}

function createConfiguredIngestionRuntime({
  db,
  settings = cds.env.requires.creditGuardIngestion,
  cdsEnvironment = cds.env,
  abapClient = new AbapClient()
} = {}) {
  const trustedSettings = isRecord(settings) ? settings : {};
  validateOptionalLimit(trustedSettings.maxFileBytes, 20 * 1024 * 1024, 'File size limit');
  validateOptionalLimit(
    trustedSettings.maxRestResponseBytes,
    20 * 1024 * 1024,
    'REST response size limit'
  );
  const sourceConfigurations = isRecord(trustedSettings.sources) ? trustedSettings.sources : {};
  const configurationResolver = async source => {
    if (source.sourceId === getMockSapSourceDefinition().sourceId) {
      if (source.sourceType !== 'MOCK_SAP_SIMULATOR'
        || source.configurationReference !== MOCK_SAP_CONFIGURATION_REFERENCE) {
        throw configurationUnavailable();
      }
      return getMockSapSourceConfiguration();
    }
    const config = sourceConfigurations[source.configurationReference];
    if (!isRecord(config)) throw configurationUnavailable();
    return config;
  };
  const configuredConnectors = createConfiguredConnectors({
    abapClient,
    file: {
      readRepository: configuredFileReader(trustedSettings, sourceConfigurations),
      maxBytes: trustedSettings.maxFileBytes
    },
    rest: {
      credentialResolver: destinationHeaders,
      maxBytes: trustedSettings.maxRestResponseBytes
    },
    sql: {
      connect: async configurationReference => {
        const sourceConfig = sourceConfigurations[configurationReference];
        const serviceName = sourceConfig?.databaseServiceName;
        if (typeof serviceName !== 'string' || !isRecord(cdsEnvironment.requires)
          || !Object.hasOwn(cdsEnvironment.requires, serviceName)) {
          throw configurationUnavailable();
        }
        try {
          return await cds.connect.to(serviceName);
        } catch (cause) {
          throw new ConnectorError('Approved CAP database connection is unavailable.', {
            category: 'sql_connection_unavailable',
            statusCode: 503,
            cause
          });
        }
      }
    }
  });
  return createIngestionRuntime({
    db,
    configurationResolver,
    adapters: configuredConnectors
  });
}

module.exports = {
  createConfiguredIngestionRuntime,
  createIngestionRuntime,
  destinationHeaders
};
