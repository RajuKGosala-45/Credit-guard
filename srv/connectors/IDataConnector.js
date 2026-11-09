const { SAP_VERIFICATION_NOTE } = require('../canonicalSchemaMetadata');

const REQUIRED_CONNECTOR_METHODS = Object.freeze([
  'testConnection',
  'discoverSchema',
  'fetchRecords'
]);

function assertValidConnector(connector, connectorType = 'UNKNOWN') {
  if (!connector || typeof connector !== 'object') {
    throw new TypeError(`Connector ${connectorType} must be an object implementing IDataConnector.`);
  }
  for (const method of REQUIRED_CONNECTOR_METHODS) {
    if (typeof connector[method] !== 'function') {
      throw new TypeError(`Connector ${connectorType} is missing required IDataConnector method: ${method}()`);
    }
  }
  return connector;
}

function buildConnectorHealthEnvelope({
  connectorType,
  connected,
  mode,
  message,
  sapReference = null,
  latencyMs = 1
}) {
  return {
    connectorType,
    connected: Boolean(connected),
    mode: mode || 'LIVE',
    message: String(message || ''),
    latencyMs: Number(latencyMs) || 1,
    sapReference: sapReference
      ? {
          ...sapReference,
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
      : {
          verified: false,
          verificationNote: SAP_VERIFICATION_NOTE
        }
  };
}

module.exports = {
  REQUIRED_CONNECTOR_METHODS,
  assertValidConnector,
  buildConnectorHealthEnvelope
};
