const {
  ENTITY_TYPES,
  isRecord
} = require('./canonicalData');

const SOURCE_TYPES = Object.freeze([
  'SAP_S4HANA_ODATA',
  'SQL_DATABASE',
  'SAP_HANA',
  'REST_API',
  'CSV_XLSX',
  'JSON_XML',
  'MOCK_SAP_SIMULATOR'
]);

const MOCK_SAP_SOURCE_ID = 'MOCK-S4-001';

const SOURCE_FIELDS = Object.freeze([
  'sourceId',
  'sourceName',
  'sourceType',
  'enabled',
  'supportedEntities',
  'mappingVersion',
  'authenticationReference',
  'configurationReference'
]);

const REFERENCE_PATTERN = /^(destination|credential|secret|binding|config|repository|connection):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAPPING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

function invalidSource(message) {
  const error = new TypeError(message);
  error.statusCode = 400;
  throw error;
}

function validateSourceDefinition(source) {
  if (!isRecord(source)) invalidSource('Source registration must be an object.');
  const allowedFields = new Set(SOURCE_FIELDS);
  const unknownFields = Object.keys(source).filter(field => !allowedFields.has(field));
  if (unknownFields.length) {
    invalidSource(`Source registration contains unsupported field: ${unknownFields[0]}.`);
  }
  for (const field of SOURCE_FIELDS) {
    if (!Object.hasOwn(source, field)) invalidSource(`Source registration is missing ${field}.`);
  }
  if (typeof source.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(source.sourceId)) {
    invalidSource('Source ID is invalid.');
  }
  if (typeof source.sourceName !== 'string' || !source.sourceName.trim()
    || source.sourceName.length > 120 || /[\u0000-\u001f\u007f]/.test(source.sourceName)) {
    invalidSource('Source name must be non-empty text of at most 120 characters.');
  }
  if (!SOURCE_TYPES.includes(source.sourceType)) invalidSource('Source type is not supported.');
  if (typeof source.enabled !== 'boolean') invalidSource('Source enabled must be a boolean.');
  if (!Array.isArray(source.supportedEntities) || source.supportedEntities.length === 0
    || source.supportedEntities.some(entity => !ENTITY_TYPES.includes(entity))
    || new Set(source.supportedEntities).size !== source.supportedEntities.length) {
    invalidSource('Source supported entities must be a non-empty list of unique canonical entity types.');
  }
  if (typeof source.mappingVersion !== 'string' || !MAPPING_VERSION_PATTERN.test(source.mappingVersion)) {
    invalidSource('Source mapping version is invalid.');
  }
  if (source.authenticationReference !== null
    && (typeof source.authenticationReference !== 'string'
      || !REFERENCE_PATTERN.test(source.authenticationReference))) {
    invalidSource('Authentication reference must be a namespaced reference or null.');
  }
  if (typeof source.configurationReference !== 'string'
    || !REFERENCE_PATTERN.test(source.configurationReference)) {
    invalidSource('Configuration reference must be a namespaced reference.');
  }
  return {
    sourceId: source.sourceId,
    sourceName: source.sourceName.trim(),
    sourceType: source.sourceType,
    enabled: source.enabled,
    supportedEntities: [...source.supportedEntities],
    mappingVersion: source.mappingVersion,
    authenticationReference: source.authenticationReference,
    configurationReference: source.configurationReference
  };
}

function cloneSource(source) {
  return { ...source, supportedEntities: [...source.supportedEntities] };
}

function createSourceRegistry({ now = () => new Date() } = {}) {
  const sources = new Map();

  function timestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('Source registry clock must return a valid Date.');
    }
    return value.toISOString();
  }

  return Object.freeze({
    register(source) {
      const validated = validateSourceDefinition(source);
      if (sources.has(validated.sourceId)) {
        const error = new Error(`Source ${validated.sourceId} is already registered.`);
        error.statusCode = 409;
        throw error;
      }
      const createdAt = timestamp();
      const registered = { ...validated, createdAt, updatedAt: createdAt };
      sources.set(registered.sourceId, registered);
      return cloneSource(registered);
    },

    update(sourceId, changes) {
      const current = sources.get(sourceId);
      if (!current) {
        const error = new Error(`Source ${sourceId} is not registered.`);
        error.statusCode = 404;
        throw error;
      }
      if (!isRecord(changes)) invalidSource('Source update must be an object.');
      const unknownFields = Object.keys(changes).filter(field => !SOURCE_FIELDS.includes(field));
      if (unknownFields.length) {
        invalidSource(`Source update contains unsupported field: ${unknownFields[0]}.`);
      }
      const candidate = Object.fromEntries(SOURCE_FIELDS.map(field => [
        field,
        Object.hasOwn(changes, field) ? changes[field] : current[field]
      ]));
      const updated = validateSourceDefinition(candidate);
      if (updated.sourceId !== sourceId) invalidSource('Source ID cannot be changed.');
      const next = { ...updated, createdAt: current.createdAt, updatedAt: timestamp() };
      sources.set(sourceId, next);
      return cloneSource(next);
    },

    get(sourceId) {
      const source = sources.get(sourceId);
      return source ? cloneSource(source) : null;
    },

    list() {
      return [...sources.values()].map(cloneSource);
    },

    select(sourceId, entityType) {
      const source = sources.get(sourceId);
      if (!source) {
        const error = new Error(`Source ${sourceId} is not registered.`);
        error.statusCode = 404;
        throw error;
      }
      if (!source.enabled) {
        const error = new Error(`Source ${sourceId} is disabled.`);
        error.statusCode = 409;
        throw error;
      }
      if (entityType && !source.supportedEntities.includes(entityType)) {
        const error = new Error(`Source ${sourceId} does not support ${entityType}.`);
        error.statusCode = 400;
        throw error;
      }
      return cloneSource(source);
    }
  });
}

module.exports = {
  MOCK_SAP_SOURCE_ID,
  SOURCE_TYPES,
  createSourceRegistry,
  validateSourceDefinition
};
