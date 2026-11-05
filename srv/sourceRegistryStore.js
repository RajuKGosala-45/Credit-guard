const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const { validateSourceDefinition } = require('./sourceRegistry');

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
  listSources,
  registerSource,
  selectEnabledSource,
  updateSource
};
