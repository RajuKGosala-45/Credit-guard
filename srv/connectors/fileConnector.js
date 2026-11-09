const fs = require('fs');
const path = require('path');
const { proposeFieldMappings } = require('../schemaMapper');
const { buildConnectorHealthEnvelope } = require('./IDataConnector');

// First-class File Connector for structured ERP exports (CSV, TSV, JSON, OData JSON, Spreadsheet XML)
function parseDelimitedText(text, explicitDelimiter = null) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return { headers: [], rows: [] };

  const lines = [];
  let currentLine = [];
  let currentField = '';
  let inQuotes = false;

  // Detect delimiter from first line if not explicitly specified
  const firstLineEnd = cleaned.indexOf('\n');
  const firstLine = firstLineEnd >= 0 ? cleaned.slice(0, firstLineEnd) : cleaned;
  const delimiter = explicitDelimiter
    || (firstLine.split('\t').length > firstLine.split(',').length ? '\t'
      : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentLine.push(currentField.trim());
      currentField = '';
    } else if (ch === '\r' && next === '\n') {
      currentLine.push(currentField.trim());
      lines.push(currentLine);
      currentLine = [];
      currentField = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      currentLine.push(currentField.trim());
      lines.push(currentLine);
      currentLine = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }
  if (currentField.length > 0 || currentLine.length > 0) {
    currentLine.push(currentField.trim());
    lines.push(currentLine);
  }

  const nonEmptyLines = lines.filter(line => line.some(cell => cell !== ''));
  if (nonEmptyLines.length === 0) return { headers: [], rows: [] };

  const headers = nonEmptyLines[0].map((h, idx) => h || `COLUMN_${idx + 1}`);
  const rows = nonEmptyLines.slice(1).map(cells => {
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = cells[idx] !== undefined ? cells[idx] : '';
    });
    return obj;
  });

  return { headers, rows };
}

function parseJsonExport(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  let rows = [];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === 'object') {
    // Support OData V4 { value: [...] }, OData V2 { d: { results: [...] } }, or { records: [...] }
    if (Array.isArray(parsed.value)) rows = parsed.value;
    else if (Array.isArray(parsed.d?.results)) rows = parsed.d.results;
    else if (Array.isArray(parsed.records)) rows = parsed.records;
    else if (Array.isArray(parsed.items)) rows = parsed.items;
    else if (Array.isArray(parsed.data)) rows = parsed.data;
    else rows = [parsed];
  }
  const cleanRows = rows.filter(r => r && typeof r === 'object' && !Array.isArray(r));
  const headers = [...new Set(cleanRows.flatMap(r => Object.keys(r).filter(k => k !== '__metadata')))];
  return { headers, rows: cleanRows };
}

function parseXmlTabularExport(text) {
  // Lightweight SpreadsheetML / simple XML row parser (<Row><Cell><Data>...</Data></Cell></Row> or <item><FIELD>val</FIELD></item>)
  const str = String(text || '');
  const itemMatches = [...str.matchAll(/<(?:item|row|record)\b[^>]*>([\s\S]*?)<\/(?:item|row|record)>/gi)];
  if (!itemMatches.length) return { headers: [], rows: [] };

  const rows = [];
  const headerSet = new Set();
  for (const match of itemMatches) {
    const inner = match[1];
    const fieldMatches = [...inner.matchAll(/<([A-Za-z0-9_:-]+)\b[^>]*>([^<]*)<\/\1>/g)];
    if (fieldMatches.length) {
      const obj = {};
      for (const [, tag, val] of fieldMatches) {
        if (tag.toLowerCase() === 'data' || tag.toLowerCase() === 'cell') continue;
        headerSet.add(tag);
        obj[tag] = val.trim();
      }
      if (Object.keys(obj).length > 0) rows.push(obj);
    }
  }
  return { headers: [...headerSet], rows };
}

function parseStructuredFileBuffer({ buffer, text, filename = 'export.csv', format = null }) {
  const rawText = typeof text === 'string'
    ? text
    : Buffer.isBuffer(buffer)
      ? buffer.toString('utf8')
      : String(buffer || '');
  const ext = (format || path.extname(filename) || '.csv').toLowerCase().replace(/^\./, '');

  if (ext === 'json') {
    return { format: 'JSON', ...parseJsonExport(rawText) };
  }
  if (ext === 'xml') {
    return { format: 'XML', ...parseXmlTabularExport(rawText) };
  }
  if (ext === 'tsv') {
    return { format: 'TSV', ...parseDelimitedText(rawText, '\t') };
  }
  // If content starts with [ or {, auto-detect JSON
  const trimmed = rawText.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return { format: 'JSON', ...parseJsonExport(trimmed) };
    } catch {
      // fall through to CSV
    }
  }
  return { format: 'CSV', ...parseDelimitedText(rawText) };
}

function resolveWorkspaceFileContent(config = {}) {
  if (config.rawContent || config.buffer || config.records) {
    return config;
  }
  const ref = String(
    config.connection_config_ref || config.filePath || 'db/data/credit-Customers.csv'
  ).replace(/^config:/, '').trim();
  if (!ref) return null;
  const rootDir = path.resolve(__dirname, '../..');
  const candidatePath = path.resolve(rootDir, ref);
  if (!candidatePath.startsWith(rootDir) || !fs.existsSync(candidatePath)) {
    return null;
  }
  return {
    filename: path.basename(candidatePath),
    rawContent: fs.readFileSync(candidatePath, 'utf8')
  };
}

function createFileConnector() {
  return Object.freeze({
    connectorType: 'FILE',

    async testConnection(config = {}) {
      const resolved = resolveWorkspaceFileContent(config);
      const hasInlineData = Boolean(
        resolved?.rawContent
        || resolved?.buffer
        || (Array.isArray(config.records) && config.records.length > 0)
      );
      return buildConnectorHealthEnvelope({
        connectorType: 'FILE',
        connected: true,
        mode: hasInlineData ? 'FILE_READY' : 'FILE_UPLOAD_READY',
        message: hasInlineData
          ? `Structured file source (${resolved?.filename || config.filename || 'inline dataset'}) is ready for schema discovery and canonical ingestion.`
          : 'Structured File Connector (CSV / TSV / JSON / XML / SE16N Export) is ready to accept file uploads.',
        sapReference: {
          tables: ['BUT000', 'KNA1', 'KNB1', 'UKMBP_CMS_SGM', 'UKM_ITEM', 'ACDOCA', 'BSID', 'BSAD']
        }
      });
    },

    async discoverSchema(config = {}, options = {}) {
      let headers = [];
      let rows = [];
      let format = 'CSV';

      if (Array.isArray(config.records)) {
        rows = config.records;
        headers = [...new Set(rows.flatMap(r => (r && typeof r === 'object' ? Object.keys(r) : [])))];
        format = 'JSON';
      } else {
        const resolved = resolveWorkspaceFileContent(config) || config;
        const parsed = parseStructuredFileBuffer({
          buffer: resolved.buffer,
          text: resolved.rawContent || resolved.text || '',
          filename: resolved.filename || config.filename || 'upload.csv',
          format: config.format
        });
        headers = parsed.headers;
        rows = parsed.rows;
        format = parsed.format;
      }

      const sourceId = config.source_id || config.sourceId || 'FILE-CONNECTOR';
      const sourceEntity = options.sourceEntity || config.filename || 'FILE_EXPORT';
      const discovery = proposeFieldMappings({
        sourceId,
        sourceEntity,
        targetCanonicalEntity: options.targetCanonicalEntity || null,
        records: rows,
        headers
      });

      return {
        connectorType: 'FILE',
        format,
        rowCount: rows.length,
        headers,
        sampleRows: rows.slice(0, 5),
        ...discovery
      };
    },

    async fetchRecords(config = {}, { entity = 'DEFAULT', limit = 5000 } = {}) {
      let rows = [];
      if (Array.isArray(config.records)) {
        rows = config.records;
      } else {
        const resolved = resolveWorkspaceFileContent(config) || config;
        const parsed = parseStructuredFileBuffer({
          buffer: resolved.buffer,
          text: resolved.rawContent || resolved.text || '',
          filename: resolved.filename || config.filename || 'upload.csv',
          format: config.format
        });
        rows = parsed.rows;
      }
      const bounded = rows.slice(0, Math.max(1, Number(limit) || 5000));
      return {
        connectorType: 'FILE',
        entity,
        records: bounded,
        totalCount: rows.length,
        retrievedAt: new Date().toISOString()
      };
    }
  });
}

module.exports = {
  createFileConnector,
  parseDelimitedText,
  parseJsonExport,
  parseStructuredFileBuffer
};
