const ENTITY_TYPES = Object.freeze([
  'CUSTOMER',
  'CREDIT_ACCOUNT',
  'INVOICE',
  'SALES_ORDER',
  'PAYMENT',
  'PAYMENT_ALLOCATION'
]);

const PROVENANCE_FIELDS = Object.freeze([
  'sourceId',
  'sourceEntity',
  'sourceRecordId',
  'sourceUpdatedAt',
  'retrievedAt',
  'ingestedAt',
  'ingestionRunId',
  'mappingVersion'
]);

const REQUIRED_PROVENANCE_FIELDS = Object.freeze([
  'sourceId',
  'sourceEntity',
  'sourceRecordId',
  'retrievedAt',
  'mappingVersion'
]);

const IDENTIFIER_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CANONICAL_TEXT_LENGTH = 1000;

const ENTITY_FIELDS = Object.freeze({
  CUSTOMER: Object.freeze({
    customerId: 'identifier',
    sourceCustomerId: 'identifier',
    customerName: 'text',
    companyCode: 'optionalText'
  }),
  CREDIT_ACCOUNT: Object.freeze({
    accountId: 'identifier',
    customerId: 'identifier',
    creditLimit: 'decimal',
    currency: 'currency',
    creditSegment: 'optionalText'
  }),
  INVOICE: Object.freeze({
    sourceDocumentId: 'identifier',
    documentItemId: 'optionalIdentifier',
    customerId: 'identifier',
    accountId: 'optionalIdentifier',
    documentType: 'text',
    originalAmount: 'decimal',
    outstandingAmount: 'decimal',
    currency: 'currency',
    documentDate: 'optionalDate',
    dueDate: 'optionalDate',
    paymentStatus: 'text'
  }),
  SALES_ORDER: Object.freeze({
    orderId: 'identifier',
    itemId: 'identifier',
    customerId: 'identifier',
    accountId: 'optionalIdentifier',
    creditRelevantAmount: 'decimal',
    currency: 'currency',
    lifecycleStatus: 'text'
  }),
  PAYMENT: Object.freeze({
    paymentId: 'identifier',
    customerId: 'optionalIdentifier',
    accountId: 'optionalIdentifier',
    amount: 'decimal',
    currency: 'currency',
    postingDate: 'date',
    paymentStatus: 'text'
  }),
  PAYMENT_ALLOCATION: Object.freeze({
    allocationId: 'identifier',
    paymentId: 'identifier',
    invoiceId: 'identifier',
    allocatedAmount: 'decimal',
    currency: 'currency',
    allocationStatus: 'text'
  })
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(code, field, message, severity = 'ERROR', sourceField) {
  return {
    code,
    field,
    message,
    severity,
    ...(sourceField ? { sourceField } : {})
  };
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTimestamp(value) {
  return typeof value === 'string'
    && TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && isValidDate(value.slice(0, 10));
}

function validateValue(type, value) {
  switch (type) {
    case 'identifier':
    case 'optionalIdentifier':
      return typeof value === 'string' && value.trim() === value && IDENTIFIER_PATTERN.test(value);
    case 'text':
    case 'optionalText':
      return typeof value === 'string' && value.trim() === value && value.length > 0
        && value.length <= MAX_CANONICAL_TEXT_LENGTH
        && !/[\u0000-\u001f\u007f]/.test(value);
    case 'decimal':
      return typeof value === 'string' && DECIMAL_PATTERN.test(value);
    case 'currency':
      return typeof value === 'string' && CURRENCY_PATTERN.test(value);
    case 'date':
    case 'optionalDate':
      return isValidDate(value);
    default:
      return false;
  }
}

function validateProvenance(provenance) {
  const issues = [];
  if (!isRecord(provenance)) {
    return [issue('MISSING_PROVENANCE', 'provenance', 'Provenance must be an object.')];
  }
  for (const field of Object.keys(provenance)) {
    if (!PROVENANCE_FIELDS.includes(field)) {
      issues.push(issue('UNSUPPORTED_PROVENANCE_FIELD', `provenance.${field}`, 'Provenance field is not supported.'));
    }
  }
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    if (typeof provenance[field] !== 'string' || !provenance[field].trim()) {
      issues.push(issue('MISSING_PROVENANCE', `provenance.${field}`, `Provenance ${field} is required.`));
    }
  }
  for (const field of ['sourceId', 'sourceEntity', 'sourceRecordId', 'ingestionRunId']) {
    if (provenance[field] !== undefined
      && (typeof provenance[field] !== 'string'
        || provenance[field].trim() !== provenance[field]
        || !IDENTIFIER_PATTERN.test(provenance[field]))) {
      issues.push(issue('INVALID_PROVENANCE', `provenance.${field}`, `Provenance ${field} is invalid.`));
    }
  }
  if (provenance.mappingVersion !== undefined
    && (typeof provenance.mappingVersion !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(provenance.mappingVersion))) {
    issues.push(issue('INVALID_PROVENANCE', 'provenance.mappingVersion', 'Provenance mappingVersion is invalid.'));
  }
  for (const field of ['sourceUpdatedAt', 'retrievedAt', 'ingestedAt']) {
    if (provenance[field] !== undefined && !isValidTimestamp(provenance[field])) {
      issues.push(issue('INVALID_PROVENANCE_TIMESTAMP', `provenance.${field}`, `Provenance ${field} must be a valid timestamp.`));
    }
  }
  return issues;
}

function validateCanonicalRecord(entityType, record) {
  const issues = [];
  const fields = ENTITY_FIELDS[entityType];
  if (!fields) return { valid: false, issues: [issue('UNKNOWN_ENTITY_TYPE', 'entityType', 'Canonical entity type is not supported.')] };
  if (!isRecord(record)) {
    return { valid: false, issues: [issue('INVALID_RECORD', 'record', 'Canonical record must be an object.')] };
  }
  for (const field of Object.keys(record)) {
    if (field !== 'provenance' && !Object.hasOwn(fields, field)) {
      issues.push(issue('UNSUPPORTED_FIELD', field, 'Canonical field is not supported.'));
    }
  }
  for (const [field, type] of Object.entries(fields)) {
    const optional = type.startsWith('optional');
    const value = record[field];
    if (value === undefined || value === null || value === '') {
      if (!optional) issues.push(issue('MISSING_REQUIRED_FIELD', field, `Required field ${field} is missing.`));
      continue;
    }
    const valueType = optional ? type.slice('optional'.length).replace(/^./, first => first.toLowerCase()) : type;
    if (!validateValue(valueType, value)) {
      const code = type === 'decimal' ? 'INVALID_DECIMAL'
        : type === 'currency' ? 'INVALID_CURRENCY'
          : type === 'date' || type === 'optionalDate' ? 'INVALID_DATE' : 'INVALID_FIELD';
      issues.push(issue(code, field, `Field ${field} has an invalid value.`));
    }
  }
  if (entityType === 'PAYMENT' && !record.customerId && !record.accountId) {
    issues.push(issue('MISSING_PAYMENT_REFERENCE', 'customerId', 'Payment must reference a customer or credit account.'));
  }
  issues.push(...validateProvenance(record.provenance));
  return { valid: !issues.some(item => item.severity === 'ERROR'), issues };
}

function mapCanonicalRecord(entityType, sourceRecord, mapping, provenance) {
  if (!isRecord(sourceRecord)) {
    return {
      record: null,
      valid: false,
      issues: [issue('INVALID_SOURCE_RECORD', 'sourceRecord', 'Source record must be an object.')]
    };
  }
  if (!isRecord(mapping)) {
    return {
      record: null,
      valid: false,
      issues: [issue('INVALID_MAPPING', 'mapping', 'Field mapping must be an object.')]
    };
  }
  const fields = ENTITY_FIELDS[entityType];
  if (!fields) {
    return {
      record: null,
      valid: false,
      issues: [issue('UNKNOWN_ENTITY_TYPE', 'entityType', 'Canonical entity type is not supported.')]
    };
  }

  const record = {};
  const issues = [];
  for (const targetField of Object.keys(mapping)) {
    if (!Object.hasOwn(fields, targetField)
      || typeof mapping[targetField] !== 'string'
      || !mapping[targetField].trim()
      || /[\u0000-\u001f\u007f]/.test(mapping[targetField])) {
      issues.push(issue('INVALID_MAPPING', targetField, 'Field mapping target or source field is invalid.'));
    }
  }
  for (const [targetField, type] of Object.entries(fields)) {
    const sourceField = mapping[targetField];
    if (!sourceField) {
      issues.push(issue(
        type.startsWith('optional') ? 'OPTIONAL_FIELD_UNMAPPED' : 'MISSING_REQUIRED_FIELD_MAPPING',
        targetField,
        `No source field is mapped to ${targetField}.`,
        type.startsWith('optional') ? 'WARNING' : 'ERROR'
      ));
      continue;
    }
    const value = sourceRecord[sourceField];
    if (value === undefined || value === null || value === '') {
      issues.push(issue(
        type.startsWith('optional') ? 'OPTIONAL_FIELD_MISSING' : 'MISSING_REQUIRED_FIELD',
        targetField,
        `Source field for ${targetField} is missing.`,
        type.startsWith('optional') ? 'WARNING' : 'ERROR',
        sourceField
      ));
      continue;
    }
    record[targetField] = value;
  }
  record.provenance = provenance;
  const validation = validateCanonicalRecord(entityType, record);
  issues.push(...validation.issues);
  const uniqueIssues = [...new Map(issues.map(item => [
    `${item.code}:${item.field}`,
    item
  ])).values()];
  const valid = !uniqueIssues.some(item => item.severity === 'ERROR');
  return { record: valid ? record : null, valid, issues: uniqueIssues };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceIdentity(record) {
  const provenance = record?.provenance;
  if (!isRecord(provenance)
    || !['sourceId', 'sourceEntity', 'sourceRecordId'].every(field =>
      typeof provenance[field] === 'string' && provenance[field].trim())) return null;
  return [provenance.sourceId, provenance.sourceEntity, provenance.sourceRecordId]
    .map(value => `${value.length}:${value}`).join('|');
}

function comparableRecord(record) {
  const { provenance, ...businessFields } = record;
  const stableProvenance = Object.fromEntries(
    ['sourceId', 'sourceEntity', 'sourceRecordId', 'mappingVersion']
      .filter(field => provenance?.[field] !== undefined)
      .map(field => [field, provenance[field]])
  );
  return stableSerialize({ ...businessFields, provenance: stableProvenance });
}

function detectDuplicateSourceIdentities(records) {
  if (!Array.isArray(records)) throw new TypeError('Source identity detection requires an array.');
  const firstByIdentity = new Map();
  const issues = [];
  records.forEach((record, index) => {
    const identity = sourceIdentity(record);
    if (!identity) {
      issues.push(issue('MISSING_PROVENANCE', `records[${index}].provenance`, 'Source identity provenance is required.'));
      return;
    }
    if (!firstByIdentity.has(identity)) {
      firstByIdentity.set(identity, { record, index });
      return;
    }
    const first = firstByIdentity.get(identity);
    const identical = comparableRecord(first.record) === comparableRecord(record);
    issues.push(issue(
      identical ? 'DUPLICATE_SOURCE_IDENTITY' : 'CONFLICTING_SOURCE_IDENTITY',
      `records[${index}]`,
      identical
        ? `Record duplicates source identity first seen at index ${first.index}.`
        : `Record conflicts with source identity first seen at index ${first.index}.`,
      identical ? 'WARNING' : 'ERROR'
    ));
  });
  return { valid: !issues.some(item => item.severity === 'ERROR'), issues };
}

module.exports = {
  ENTITY_FIELDS,
  ENTITY_TYPES,
  PROVENANCE_FIELDS,
  REQUIRED_PROVENANCE_FIELDS,
  detectDuplicateSourceIdentities,
  isValidTimestamp,
  isRecord,
  mapCanonicalRecord,
  validateCanonicalRecord,
  validateProvenance
};
