const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const { MOCK_SAP_SOURCE_ID, validateSourceDefinition } = require('./sourceRegistry');
const { getMockSapSourceDefinition } = require('./integrations/mock-sap/connector');

function fromRow(row) {
  let supportedEntities;
  try {
    supportedEntities = JSON.parse(row.supportedEntities);
  } catch (cause) {
    throw new TypeError('Stored source entity configuration is invalid.', { cause });
  }
  return {
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    sourceType: row.sourceType,
    enabled: row.enabled,
    supportedEntities,
    mappingVersion: row.mappingVersion,
    authenticationReference: row.authenticationReference ?? null,
    configurationReference: row.configurationReference,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString()
  };
}

function toRow(source) {
  return {
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceType: source.sourceType,
    enabled: source.enabled,
    supportedEntities: JSON.stringify(source.supportedEntities),
    mappingVersion: source.mappingVersion,
    authenticationReference: source.authenticationReference,
    configurationReference: source.configurationReference,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

async function getSource(db, sourceId) {
  const row = await db.run(SELECT.one.from('credit.DataSources').where({ sourceId }));
  return row ? fromRow(row) : null;
}

async function listSources(db) {
  const rows = await db.run(SELECT.from('credit.DataSources').orderBy('sourceId asc'));
  return rows.map(fromRow);
}

async function registerSource(db, definition, now = new Date()) {
  const validated = validateSourceDefinition(definition);
  const timestamp = now.toISOString();
  const source = { ...validated, createdAt: timestamp, updatedAt: timestamp };
  await db.run(INSERT.into('credit.DataSources').entries(toRow(source)));
  return source;
}

async function ensureMockSapSource(db, now = new Date()) {
  const definition = getMockSapSourceDefinition();
  const existing = await getSource(db, MOCK_SAP_SOURCE_ID);
  if (existing) {
    const matchesDefinition = existing.sourceName === definition.sourceName
      && existing.sourceType === definition.sourceType
      && existing.supportedEntities.length === definition.supportedEntities.length
      && existing.supportedEntities.every((entity, index) =>
        entity === definition.supportedEntities[index])
      && existing.mappingVersion === definition.mappingVersion
      && existing.authenticationReference === null
      && existing.configurationReference === definition.configurationReference;
    if (!matchesDefinition) {
      const error = new Error('Registered Mock SAP source conflicts with the built-in simulator definition.');
      error.statusCode = 409;
      throw error;
    }
    return existing;
  }
  return registerSource(db, definition, now);
}

async function updateSource(db, sourceId, changes, now = new Date()) {
  const current = await getSource(db, sourceId);
  if (!current) {
    const error = new Error(`Source ${sourceId} is not registered.`);
    error.statusCode = 404;
    throw error;
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('Source update must be an object.');
  }
  if (sourceId === MOCK_SAP_SOURCE_ID
    && Object.keys(changes).some(field => field !== 'enabled')) {
    const error = new Error('Built-in Mock SAP source configuration cannot be changed.');
    error.statusCode = 400;
    throw error;
  }
  const { createdAt, updatedAt, ...editable } = current;
  const updated = validateSourceDefinition({ ...editable, ...changes });
  if (updated.sourceId !== sourceId) throw new TypeError('Source ID cannot be changed.');
  const persisted = {
    ...updated,
    createdAt,
    updatedAt: now.toISOString()
  };
  const result = await db.run(UPDATE('credit.DataSources')
    .set(toRow(persisted))
    .where({ sourceId }));
  if (result !== 1) {
    const error = new Error('Source changed before the update could be saved.');
    error.statusCode = 409;
    throw error;
  }
  return persisted;
}

function selectEnabledSource(source) {
  if (!source) {
    const error = new Error('Source is not registered.');
    error.statusCode = 404;
    throw error;
  }
  if (!source.enabled) {
    const error = new Error(`Source ${source.sourceId} is disabled.`);
    error.statusCode = 409;
    throw error;
  }
  return source;
}

module.exports = {
  getSource,
  ensureMockSapSource,
  listSources,
  registerSource,
  selectEnabledSource,
  updateSource
};
