const cds = require('@sap/cds');
const { ENTITY_TYPES } = require('./canonicalData');
const { ConnectorError, createAbapODataConnector } = require('./connectorManager');

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function assertEntityMapping(config, entityType) {
  const mapping = config?.entityMappings?.[entityType];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
    || !ENTITY_TYPES.includes(entityType)
    || typeof mapping.sourceEntity !== 'string' || !mapping.sourceEntity.trim()
    || !mapping.fields || typeof mapping.fields !== 'object' || Array.isArray(mapping.fields)
    || typeof mapping.sourceRecordIdField !== 'string' || !mapping.sourceRecordIdField.trim()) {
    throw new ConnectorError('Approved source entity mapping is unavailable.', {
      category: 'source_mapping_unavailable',
      statusCode: 503
    });
  }
  return mapping;
}

function extractPath(value, path) {
  if (!path) return value;
  return path.split('.').reduce((current, key) => {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    return current[key];
  }, value);
}

function parseCsv(text, maxRecords = 100000) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new TypeError('CSV record limit is invalid.');
  }
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const appendRow = () => {
    row.push(field);
    field = '';
    if (row.some(value => value !== '')) {
      if (rows.length >= maxRecords + 1) {
        throw new ConnectorError('CSV source exceeded the configured record limit.', {
          category: 'source_record_limit',
          statusCode: 413
        });
      }
      rows.push(row);
    }
    row = [];
    afterQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      }
      else field += character;
      continue;
    }
    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new ConnectorError('CSV source has characters after a quoted field.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    if (character === '"' && field.length === 0 && !afterQuote) quoted = true;
    else if (character === '"') {
      throw new ConnectorError('CSV source contains an unexpected quote.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    else if (character === ',') {
      row.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\r' || character === '\n') {
      appendRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else field += character;
  }
  if (quoted) {
    throw new ConnectorError('CSV source contains an unterminated quoted field.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  if (field !== '' || row.length) {
    appendRow();
  }
  if (!rows.length) return [];
  const headers = rows.shift().map(header => header.trim());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw new ConnectorError('CSV source has missing or duplicate column names.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  return rows.map((values, index) => {
    if (values.length !== headers.length) {
      throw new ConnectorError(`CSV record ${index + 2} has an unexpected number of columns.`, {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function decodeXmlText(value) {
  if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/.test(value)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    || value.includes(']]>')) {
    throw new ConnectorError('XML source contains an unsupported entity reference.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, name) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return '\'';
    const codePoint = name.startsWith('#x')
      ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    const validXmlCodePoint = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!Number.isInteger(codePoint) || !validXmlCodePoint) {
      throw new ConnectorError('XML source contains an invalid character reference.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseFlatXml(text, rowElement, maxRecords) {
  if (typeof rowElement !== 'string' || !XML_NAME.test(rowElement)) {
    throw new ConnectorError('XML row element is not configured safely.', {
      category: 'source_configuration_invalid',
      statusCode: 503
    });
  }
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) {
    throw new ConnectorError('XML source uses unsupported declarations or sections.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  const tokens = text.match(/<\?[^?]*\?>|<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+|</g) || [];
  if (tokens.join('') !== text) {
    throw new ConnectorError('XML source is malformed.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  const stack = [];
  const records = [];
  let activeRecord = null;
  let rootElementSeen = false;
  let rootElementClosed = false;
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<!')) {
      throw new ConnectorError('XML source declarations are not supported.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    if (token.startsWith('</')) {
      const match = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
      if (!match || stack.at(-1)?.name !== match[1]) {
        throw new ConnectorError('XML source has mismatched elements.', {
          category: 'source_invalid_format',
          statusCode: 422
        });
      }
      const closed = stack.pop();
      const parent = stack.at(-1);
      if (!parent) rootElementClosed = true;
      if (activeRecord && parent?.name === rowElement) {
        if (Object.hasOwn(activeRecord, closed.name)) {
          throw new ConnectorError('XML source row has duplicate field elements.', {
            category: 'source_invalid_format',
            statusCode: 422
          });
        }
        activeRecord[closed.name] = decodeXmlText(closed.text).trim();
      } else if (closed.name === rowElement) {
        records.push(activeRecord || {});
        activeRecord = null;
        if (records.length > maxRecords) {
          throw new ConnectorError('XML source exceeded the configured record limit.', {
            category: 'source_record_limit',
            statusCode: 413
          });
        }
      } else if (activeRecord && parent && parent.name !== rowElement) {
        throw new ConnectorError('XML source rows must contain flat fields.', {
          category: 'source_invalid_format',
          statusCode: 422
        });
      } else if (parent) {
        parent.text += closed.text;
      }
      continue;
    }
    if (token.startsWith('<')) {
      const match = /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s+([^<>]*?))?\s*(\/?)>$/.exec(token);
      if (!match) {
        throw new ConnectorError('XML source element is malformed or has unsupported markup.', {
          category: 'source_invalid_format',
          statusCode: 422
        });
      }
      const name = match[1];
      const attributes = match[2] || '';
      const seenAttributes = new Set();
      const attributePattern = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/y;
      let attributeIndex = 0;
      while (attributeIndex < attributes.length) {
        attributePattern.lastIndex = attributeIndex;
        const attribute = attributePattern.exec(attributes);
        if (!attribute) {
          throw new ConnectorError('XML source has malformed attributes.', {
            category: 'source_invalid_format',
            statusCode: 422
          });
        }
        if (seenAttributes.has(attribute[1])) {
          throw new ConnectorError('XML source has duplicate attributes.', {
            category: 'source_invalid_format',
            statusCode: 422
          });
        }
        seenAttributes.add(attribute[1]);
        decodeXmlText(attribute[2].slice(1, -1));
        attributeIndex = attributePattern.lastIndex;
      }
      if (stack.length === 0) {
        if (rootElementSeen || rootElementClosed) {
          throw new ConnectorError('XML source must contain exactly one root element.', {
            category: 'source_invalid_format',
            statusCode: 422
          });
        }
        rootElementSeen = true;
      }
      if (name === rowElement) {
        if (activeRecord || records.length >= maxRecords) {
          throw new ConnectorError('XML source has nested rows or exceeded its record limit.', {
            category: 'source_record_limit',
            statusCode: 413
          });
        }
        activeRecord = {};
      } else if (activeRecord && stack.at(-1)?.name !== rowElement) {
        throw new ConnectorError('XML source rows must contain flat fields.', {
          category: 'source_invalid_format',
          statusCode: 422
        });
      }
      if (match[3]) {
        if (stack.length === 0) rootElementClosed = true;
        if (activeRecord && stack.at(-1)?.name === rowElement) activeRecord[name] = '';
        else if (name === rowElement) {
          records.push({});
          activeRecord = null;
        }
      } else stack.push({ name, text: '' });
      continue;
    }
    if (stack.length) stack.at(-1).text += token;
    else if (decodeXmlText(token).trim()) {
      throw new ConnectorError('XML source has text outside its root element.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
  }
  if (stack.length || activeRecord || !rootElementSeen) {
    throw new ConnectorError('XML source ended before all elements were closed.', {
      category: 'source_invalid_format',
      statusCode: 422
    });
  }
  return records;
}

function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch (cause) {
    throw new ConnectorError('Source file is not valid UTF-8.', {
      category: 'source_invalid_encoding',
      statusCode: 422,
      cause
    });
  }
}

function validateRepositoryPayload(payload, maxBytes) {
  if (!payload || !Buffer.isBuffer(payload.buffer) || payload.buffer.length === 0) {
    throw new ConnectorError('Approved repository returned no source content.', {
      category: 'source_empty',
      statusCode: 422
    });
  }
  if (payload.buffer.length > maxBytes) {
    throw new ConnectorError('Source file exceeds the configured size limit.', {
      category: 'source_size_limit',
      statusCode: 413
    });
  }
}

function createFileRepositoryConnector({
  readRepository,
  xlsxParser,
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRecords = 100000
} = {}) {
  if (typeof readRepository !== 'function') {
    throw new TypeError('File connector requires an approved repository resolver.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('File connector size limit is invalid.');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > 1000000) {
    throw new TypeError('File connector record limit is invalid.');
  }
  return {
    capabilities() {
      return {
        entities: [...ENTITY_TYPES],
        supportsIncremental: false,
        supportsCancellation: true
      };
    },
    async read({ source, config, entityType, cursor, since, signal, deadlineAt }) {
      if (cursor || since) {
        throw new ConnectorError('Repository file ingestion supports full reads only.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      const mapping = assertEntityMapping(config, entityType);
      if (signal?.aborted) throw signal.reason;
      let payload;
      try {
        payload = await readRepository(source.configurationReference, {
          signal,
          deadlineAt,
          sourceId: source.sourceId,
          entityType
        });
      } catch (cause) {
        throw new ConnectorError('Approved repository retrieval failed.', {
          category: 'repository_unavailable',
          statusCode: 503,
          cause
        });
      }
      validateRepositoryPayload(payload, maxBytes);
      const format = String(payload.format || '').toUpperCase();
      const sourceType = source.sourceType;
      if ((sourceType === 'CSV_XLSX' && !['CSV', 'XLSX'].includes(format))
        || (sourceType === 'JSON_XML' && !['JSON', 'XML'].includes(format))) {
        throw new ConnectorError('Repository file format does not match the registered source type.', {
          category: 'source_format_unsupported',
          statusCode: 415
        });
      }
      const text = format === 'XLSX' ? null : decodeText(payload.buffer);
      let records;
      if (format === 'CSV') {
        records = parseCsv(text, maxRecords);
      } else if (format === 'JSON') {
        let document;
        try {
          document = JSON.parse(text);
        } catch (cause) {
          throw new ConnectorError('JSON source is malformed.', {
            category: 'source_invalid_format',
            statusCode: 422,
            cause
          });
        }
        records = extractPath(document, mapping.recordsPath);
      } else if (format === 'XML') {
        records = parseFlatXml(text, mapping.rowElement, maxRecords);
      } else if (format === 'XLSX') {
        if (typeof xlsxParser !== 'function') {
          throw new ConnectorError('XLSX parsing is unavailable because no approved parser is configured.', {
            category: 'xlsx_parser_unavailable',
            statusCode: 501
          });
        }
        records = await xlsxParser(payload.buffer, mapping);
      } else {
        throw new ConnectorError('Approved repository returned an unsupported file format.', {
          category: 'source_format_unsupported',
          statusCode: 415
        });
      }
      if (!Array.isArray(records) || records.length > maxRecords
        || records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) {
        throw new ConnectorError('Parsed source records do not match the configured entity contract.', {
          category: 'source_invalid_format',
          statusCode: 422
        });
      }
      if (signal?.aborted) throw signal.reason;
      const retrieved = now();
      if (!(retrieved instanceof Date) || !Number.isFinite(retrieved.getTime())) {
        throw new TypeError('File connector clock is invalid.');
      }
      return {
        records,
        sourceEntity: mapping.sourceEntity,
        sourceRecordIdField: mapping.sourceRecordIdField,
        sourceUpdatedAtField: mapping.sourceUpdatedAtField,
        mapping: mapping.fields,
        nextCursor: null,
        sourceTimestamp: payload.sourceTimestamp || null,
        retrievedAt: retrieved.toISOString(),
        complete: payload.complete === true
      };
    }
  };
}

function responseRecords(document, recordsPath) {
  const records = extractPath(document, recordsPath);
  if (!Array.isArray(records)) {
    throw new ConnectorError('REST response does not contain the configured record collection.', {
      category: 'connector_invalid_response',
      statusCode: 502
    });
  }
  return records;
}

async function readBoundedBody(response, limit) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ConnectorError('REST response exceeds the configured size limit.', {
      category: 'response_size_limit',
      statusCode: 502
    });
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) {
      throw new ConnectorError('REST response exceeds the configured size limit.', {
        category: 'response_size_limit',
        statusCode: 502
      });
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ConnectorError('REST response exceeds the configured size limit.', {
        category: 'response_size_limit',
        statusCode: 502
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function createRestConnector({
  fetchImpl = globalThis.fetch,
  credentialResolver = async () => ({}),
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof credentialResolver !== 'function') {
    throw new TypeError('REST connector requires fetch and a credential resolver.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('REST response size limit is invalid.');
  }
  return {
    capabilities() {
      return { entities: [...ENTITY_TYPES], supportsIncremental: true, supportsCancellation: true };
    },
    async read({ source, config, entityType, cursor, since, signal, deadlineAt, pageSize }) {
      const mapping = assertEntityMapping(config, entityType);
      const endpoint = mapping.endpoint;
      if (typeof endpoint !== 'string') {
        throw new ConnectorError('REST endpoint is not configured.', {
          category: 'source_configuration_unavailable',
          statusCode: 503
        });
      }
      let url;
      try {
        url = new URL(endpoint);
      } catch (cause) {
        throw new ConnectorError('REST endpoint is invalid.', {
          category: 'source_configuration_invalid',
          statusCode: 503,
          cause
        });
      }
      const allowedHosts = config.allowedHosts;
      if (url.protocol !== 'https:' || url.username || url.password
        || !Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname)) {
        throw new ConnectorError('REST endpoint is outside the configured HTTPS host allowlist.', {
          category: 'source_host_not_allowed',
          statusCode: 403
        });
      }
      if (since && (!mapping.watermarkParameter || !mapping.sourceUpdatedAtField)) {
        throw new ConnectorError('REST source does not define a reliable incremental watermark.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      if (cursor && !mapping.cursorParameter) {
        throw new ConnectorError('REST source does not define cursor pagination.', {
          category: 'pagination_not_supported',
          statusCode: 400
        });
      }
      if (mapping.pageSizeParameter) {
        const size = pageSize || mapping.pageSize || DEFAULT_PAGE_SIZE;
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAGE_SIZE) {
          throw new ConnectorError('REST page size is invalid.', {
            category: 'source_configuration_invalid',
            statusCode: 503
          });
        }
        url.searchParams.set(mapping.pageSizeParameter, String(size));
      }
      if (cursor) url.searchParams.set(mapping.cursorParameter, cursor);
      if (since) url.searchParams.set(mapping.watermarkParameter, since);
      if (signal?.aborted) throw signal.reason;
      if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
        throw new ConnectorError('REST request deadline has expired.', {
          category: 'connector_timeout',
          statusCode: 504
        });
      }

      let response;
      try {
        const credentials = await credentialResolver(source.authenticationReference, source);
        const headers = credentials?.headers || credentials;
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          throw new TypeError('Credential resolver returned invalid request headers.');
        }
        if (credentials?.destinationUrl) {
          let destinationUrl;
          try { destinationUrl = new URL(credentials.destinationUrl); }
          catch (cause) {
            throw new ConnectorError('REST authentication destination is invalid.', {
              category: 'source_authentication_unavailable',
              statusCode: 503,
              cause
            });
          }
          if (destinationUrl.origin !== url.origin) {
            throw new ConnectorError('REST endpoint does not match its authentication destination.', {
              category: 'source_authentication_mismatch',
              statusCode: 403
            });
          }
        }
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', ...headers },
          redirect: 'error',
          signal
        });
      } catch (cause) {
        if (signal?.aborted) throw signal.reason || cause;
        throw new ConnectorError('REST source request failed.', {
          category: 'rest_network_error',
          statusCode: 503,
          cause
        });
      }
      if (!response.ok) {
        const statusCode = response.status === 401 || response.status === 403
          ? 502 : response.status === 429 || response.status >= 500 ? 503 : 502;
        throw new ConnectorError('REST source returned an unsuccessful response.', {
          category: response.status === 401 || response.status === 403
            ? 'rest_unauthorized' : `rest_http_${response.status}`,
          statusCode
        });
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/application\/json|application\/[^;]+\+json/i.test(contentType)) {
        throw new ConnectorError('REST source must return a JSON response.', {
          category: 'rest_content_type_invalid',
          statusCode: 502
        });
      }
      const buffer = await readBoundedBody(response, maxBytes);
      let document;
      try {
        document = JSON.parse(decodeText(buffer));
      } catch (cause) {
        if (cause instanceof ConnectorError) throw cause;
        throw new ConnectorError('REST source returned malformed JSON.', {
          category: 'connector_invalid_response',
          statusCode: 502,
          cause
        });
      }
      const records = responseRecords(document, mapping.recordsPath);
      const nextCursor = mapping.nextCursorPath
        ? extractPath(document, mapping.nextCursorPath) : null;
      if (nextCursor !== null && nextCursor !== undefined
        && (typeof nextCursor !== 'string' || !nextCursor.trim())) {
        throw new ConnectorError('REST source returned an invalid pagination cursor.', {
          category: 'connector_invalid_response',
          statusCode: 502
        });
      }
      const retrieved = now();
      if (!(retrieved instanceof Date) || !Number.isFinite(retrieved.getTime())) {
        throw new TypeError('REST connector clock is invalid.');
      }
      return {
        records,
        sourceEntity: mapping.sourceEntity,
        sourceRecordIdField: mapping.sourceRecordIdField,
        sourceUpdatedAtField: mapping.sourceUpdatedAtField,
        mapping: mapping.fields,
        nextCursor: nextCursor || null,
        checkpoint: mapping.checkpointPath ? extractPath(document, mapping.checkpointPath) : null,
        sourceTimestamp: mapping.sourceTimestampPath
          ? extractPath(document, mapping.sourceTimestampPath) || null : null,
        retrievedAt: retrieved.toISOString(),
        complete: !nextCursor
      };
    }
  };
}

function createSqlConnector({
  connect,
  now = () => new Date(),
  defaultPageSize = DEFAULT_PAGE_SIZE
} = {}) {
  if (typeof connect !== 'function') {
    throw new TypeError('SQL connector requires a trusted CAP connection resolver.');
  }
  if (!Number.isSafeInteger(defaultPageSize) || defaultPageSize <= 0 || defaultPageSize > MAX_PAGE_SIZE) {
    throw new TypeError('SQL connector page size is invalid.');
  }
  return {
    capabilities() {
      return { entities: [...ENTITY_TYPES], supportsIncremental: true, supportsCancellation: true };
    },
    async read({ source, config, entityType, cursor, since, signal, deadlineAt, pageSize }) {
      const mapping = assertEntityMapping(config, entityType);
      const entityName = mapping.databaseEntity;
      const sourceFields = [...new Set([
        ...Object.values(mapping.fields),
        mapping.sourceRecordIdField,
        mapping.sourceUpdatedAtField,
        mapping.sourceTimestampField
      ].filter(Boolean))];
      if (typeof entityName !== 'string' || !IDENTIFIER.test(entityName)
        || sourceFields.some(field => typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) {
        throw new ConnectorError('SQL entity or column mapping is invalid.', {
          category: 'source_configuration_invalid',
          statusCode: 503
        });
      }
      if (since && !mapping.sourceUpdatedAtField) {
        throw new ConnectorError('SQL source has no configured incremental watermark field.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      if (signal?.aborted) throw signal.reason;
      if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
        throw new ConnectorError('SQL query deadline has expired.', {
          category: 'connector_timeout',
          statusCode: 504
        });
      }
      const offset = cursor === null || cursor === undefined ? 0 : Number(cursor);
      const limit = pageSize || mapping.pageSize || defaultPageSize;
      if (!Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
        throw new ConnectorError('SQL cursor or page size is invalid.', {
          category: 'source_configuration_invalid',
          statusCode: 503
        });
      }
      let connection;
      try {
        connection = await connect(source.configurationReference, source);
        if (!connection || typeof connection.run !== 'function') {
          throw new TypeError('Configured CAP source connection is unavailable.');
        }
        const query = cds.ql.SELECT.from(entityName).columns(sourceFields)
          .orderBy(mapping.sourceRecordIdField)
          .limit(limit, offset);
        if (since) query.where({ [mapping.sourceUpdatedAtField]: { '>': since } });
        const records = await connection.run(query);
        if (!Array.isArray(records)) {
          throw new ConnectorError('SQL source returned an invalid row collection.', {
            category: 'connector_invalid_response',
            statusCode: 502
          });
        }
        if (signal?.aborted) throw signal.reason;
        const retrieved = now();
        if (!(retrieved instanceof Date) || !Number.isFinite(retrieved.getTime())) {
          throw new TypeError('SQL connector clock is invalid.');
        }
        const timestamps = new Set(records.map(record => {
          const value = record[mapping.sourceTimestampField];
          return value instanceof Date && Number.isFinite(value.getTime())
            ? value.toISOString() : value;
        }).filter(value => typeof value === 'string'));
        return {
          records,
          sourceEntity: mapping.sourceEntity,
          sourceRecordIdField: mapping.sourceRecordIdField,
          sourceUpdatedAtField: mapping.sourceUpdatedAtField,
          mapping: mapping.fields,
          nextCursor: records.length === limit ? String(offset + records.length) : null,
          sourceTimestamp: timestamps.size === 1 ? [...timestamps][0] : null,
          retrievedAt: retrieved.toISOString(),
          complete: records.length < limit
        };
      } catch (cause) {
        if (cause instanceof ConnectorError || cause?.category || signal?.aborted) throw cause;
        throw new ConnectorError('SQL source query failed.', {
          category: 'sql_query_failed',
          statusCode: 503,
          cause
        });
      }
    }
  };
}

function createConfiguredConnectors(options = {}) {
  const adapters = [];
  if (typeof options.file?.readRepository === 'function') {
    const file = createFileRepositoryConnector(options.file);
    adapters.push(
      { sourceType: 'CSV_XLSX', connector: file },
      { sourceType: 'JSON_XML', connector: file }
    );
  }
  if (options.rest) adapters.push({
    sourceType: 'REST_API',
    connector: createRestConnector(options.rest)
  });
  if (typeof options.sql?.connect === 'function') {
    const sql = createSqlConnector(options.sql);
    adapters.push(
      { sourceType: 'SQL_DATABASE', connector: sql },
      { sourceType: 'SAP_HANA', connector: sql }
    );
  }
  if (options.abapClient) {
    adapters.push({
      sourceType: 'SAP_S4HANA_ODATA',
      connector: createAbapODataConnector({ client: options.abapClient })
    });
  }
  return adapters;
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  createConfiguredConnectors,
  createFileRepositoryConnector,
  createRestConnector,
  createSqlConnector,
  decodeXmlText,
  parseCsv,
  parseFlatXml
};
