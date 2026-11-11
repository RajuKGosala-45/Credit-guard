const fs = require('node:fs');
const path = require('node:path');
const { ConnectorError } = require('../../connectorManager');

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
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new ConnectorError('CSV source has characters after a quoted field.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    }
    if (character === '"' && field.length === 0 && !afterQuote) {
      quoted = true;
    } else if (character === '"') {
      throw new ConnectorError('CSV source contains an unexpected quote.', {
        category: 'source_invalid_format',
        statusCode: 422
      });
    } else if (character === ',') {
      row.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\r' || character === '\n') {
      appendRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
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

const SOURCE_TYPE = 'MOCK_SAP_GENERATED';
const SOURCE_ID = 'MOCK-SAP-GEN-001';
const SOURCE_NAME = 'SAP S/4HANA Synthetic FIN-FSCM Generated Simulator (300 BP)';
const CONFIGURATION_REFERENCE = 'config:mock-sap-generated';
const MAPPING_VERSION = '1.0.0';
const SUPPORTED_ENTITIES = Object.freeze(['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'SALES_ORDER', 'PAYMENT']);

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.CDS_ENV === 'production';
}

function isSapSimEnabled() {
  if (!isProduction()) return true;
  return process.env.CREDIT_GUARD_SAP_SIM === 'true';
}

function assertEnvironmentAllowed() {
  if (!isSapSimEnabled()) {
    throw new ConnectorError('MOCK_SAP_GENERATED source is disabled in production environments by default.', {
      category: 'source_disabled_in_production',
      statusCode: 403
    });
  }
}

function getMockSapGeneratedSourceDefinition() {
  return {
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
    enabled: isSapSimEnabled(),
    supportedEntities: [...SUPPORTED_ENTITIES],
    mappingVersion: MAPPING_VERSION,
    authenticationReference: null,
    configurationReference: CONFIGURATION_REFERENCE
  };
}

function getMockSapGeneratedSourceConfiguration() {
  return {
    entityMappings: {
      CUSTOMER: {
        sourceEntity: 'BUT000',
        sourceRecordIdField: 'PARTNER',
        fields: {
          customerId: 'PARTNER',
          sourceCustomerId: 'BPEXT',
          customerName: 'NAME_ORG1',
          country: 'LAND1',
          companyCode: 'BUKRS',
          currency: 'WAERS',
          riskClass: 'RISK_CLASS',
          lastReviewDate: 'FOLLOW_UP_DT'
        }
      },
      CREDIT_ACCOUNT: {
        sourceEntity: 'UKMBP_CMS_SGM',
        sourceRecordIdField: 'PARTNER',
        fields: {
          accountId: 'PARTNER',
          customerId: 'PARTNER',
          creditLimit: 'CREDIT_LIMIT',
          currency: 'WAERS',
          creditSegment: 'CREDIT_SGMNT'
        }
      },
      INVOICE: {
        sourceEntity: 'BSID',
        sourceRecordIdField: 'BELNR',
        fields: {
          sourceDocumentId: 'BELNR',
          documentItemId: 'BUZEI',
          customerId: 'KUNNR',
          accountId: 'KUNNR',
          documentType: 'BLART',
          originalAmount: 'WRBTR',
          outstandingAmount: 'WRBTR',
          currency: 'WAERS',
          documentDate: 'ZFBDT',
          dueDate: 'NETDT',
          paymentStatus: 'STATUS'
        }
      },
      SALES_ORDER: {
        sourceEntity: 'VBAK',
        sourceRecordIdField: 'VBELN',
        fields: {
          orderId: 'VBELN',
          itemId: 'ITEM_ID',
          customerId: 'KUNNR',
          accountId: 'KUNNR',
          creditRelevantAmount: 'NETWR',
          currency: 'WAERS',
          lifecycleStatus: 'STATUS'
        }
      },
      PAYMENT: {
        sourceEntity: 'BSAD',
        sourceRecordIdField: 'AUGBL',
        fields: {
          paymentId: 'AUGBL',
          customerId: 'KUNNR',
          accountId: 'KUNNR',
          amount: 'WRBTR',
          currency: 'WAERS',
          postingDate: 'AUGDT',
          paymentStatus: 'STATUS'
        }
      }
    }
  };
}

function getTrustedDataDirectory() {
  const simDir = path.resolve(__dirname, '..', '..', '..', 'db', 'sap-sim', 'data');
  if (!fs.existsSync(simDir)) {
    throw new ConnectorError(`Generated simulation data directory not found at ${simDir}. Please run scripts/generate-sap-sim-data.js first.`, {
      category: 'mock_sap_generated_missing',
      statusCode: 503
    });
  }
  return simDir;
}

function readCsvTable(simDir, fileName) {
  const filePath = path.join(simDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new ConnectorError(`Required generated CSV file ${fileName} not found at ${filePath}.`, {
      category: 'mock_sap_generated_missing',
      statusCode: 503
    });
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCsv(text);
}

function parseSapDateToIso(sapDateStr) {
  if (!sapDateStr || sapDateStr.length !== 8) return null;
  return `${sapDateStr.slice(0, 4)}-${sapDateStr.slice(4, 6)}-${sapDateStr.slice(6, 8)}`;
}

function addDaysToIso(isoDateStr, days) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function createMockSapGeneratedConnector({ now = () => new Date() } = {}) {
  return {
    capabilities() {
      return {
        entities: [...SUPPORTED_ENTITIES],
        supportsIncremental: false,
        supportsCancellation: true
      };
    },

    async read({ source, config, entityType, cursor, since, signal, deadlineAt }) {
      assertEnvironmentAllowed();

      if (source.sourceId !== SOURCE_ID
        || source.sourceType !== SOURCE_TYPE
        || source.configurationReference !== CONFIGURATION_REFERENCE) {
        throw new ConnectorError('Registered source does not match the Mock SAP Generated Simulator.', {
          category: 'mock_sap_source_mismatch',
          statusCode: 409
        });
      }
      if (cursor || since) {
        throw new ConnectorError('Mock SAP Generated extraction supports full reads only.', {
          category: 'incremental_not_supported',
          statusCode: 400
        });
      }
      if (!SUPPORTED_ENTITIES.includes(entityType)) {
        throw new ConnectorError(`Mock SAP Generated connector does not support entity ${entityType}.`, {
          category: 'entity_not_supported',
          statusCode: 400
        });
      }
      if (signal?.aborted) throw signal.reason;
      if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
        throw new ConnectorError('Mock SAP Generated extraction deadline has expired.', {
          category: 'connector_deadline_exceeded',
          statusCode: 504
        });
      }

      const simDir = getTrustedDataDirectory();
      const retrievedAt = now();
      if (!(retrievedAt instanceof Date) || !Number.isFinite(retrievedAt.getTime())) {
        throw new TypeError('Mock SAP Generated connector clock is invalid.');
      }
      const businessDateIso = retrievedAt.toISOString().slice(0, 10);

      const configuredMapping = config?.entityMappings?.[entityType];
      const defaultMapping = getMockSapGeneratedSourceConfiguration().entityMappings[entityType];
      if (!configuredMapping
        || configuredMapping.sourceEntity !== defaultMapping.sourceEntity
        || configuredMapping.sourceRecordIdField !== defaultMapping.sourceRecordIdField) {
        throw new ConnectorError(`Trusted Mock SAP Generated mapping for ${entityType} is unavailable.`, {
          category: 'source_mapping_unavailable',
          statusCode: 503
        });
      }

      let records = [];
      const qualityIssues = [];

      if (entityType === 'CUSTOMER') {
        const but000Rows = readCsvTable(simDir, 'BUT000.csv');
        const ukmRows = readCsvTable(simDir, 'UKMBP_CMS_SGM.csv');
        const followUpMap = new Map();
        for (const row of ukmRows) {
          followUpMap.set(row.PARTNER, row.FOLLOW_UP_DT);
        }

        records = but000Rows.map(row => {
          const followUpDt = followUpMap.get(row.PARTNER);
          const lastReviewDate = parseSapDateToIso(followUpDt);
          return {
            PARTNER: row.PARTNER,
            BPEXT: row.BPEXT,
            NAME_ORG1: row.NAME_ORG1,
            LAND1: row.LAND1,
            BUKRS: row.BUKRS,
            RISK_CLASS: row.RISK_CLASS,
            CREDIT_SGMNT: row.CREDIT_SGMNT,
            WAERS: row.WAERS,
            FOLLOW_UP_DT: lastReviewDate
          };
        });

      } else if (entityType === 'CREDIT_ACCOUNT') {
        const ukmRows = readCsvTable(simDir, 'UKMBP_CMS_SGM.csv');
        records = ukmRows.map(row => ({
          PARTNER: row.PARTNER,
          CREDIT_SGMNT: row.CREDIT_SGMNT,
          CREDIT_LIMIT: row.CREDIT_LIMIT,
          WAERS: row.WAERS
        }));

      } else if (entityType === 'INVOICE') {
        const bsidRows = readCsvTable(simDir, 'BSID.csv');
        for (const row of bsidRows) {
          if (row.BLART === 'RV' && row.SHKZG === 'S') {
            const zfbdtIso = parseSapDateToIso(row.ZFBDT) || businessDateIso;
            const termsDays = parseInt(row.ZBD1T || '30', 10);
            const dueIso = addDaysToIso(zfbdtIso, termsDays);
            const status = dueIso < businessDateIso ? 'Overdue' : 'Open';

            records.push({
              BELNR: row.BELNR,
              BUZEI: row.BUZEI || '001',
              KUNNR: row.KUNNR,
              BLART: row.BLART,
              WRBTR: row.WRBTR,
              WAERS: row.WAERS,
              ZFBDT: zfbdtIso,
              NETDT: dueIso,
              STATUS: status
            });
          } else if (row.BLART === 'DG') {
            qualityIssues.push({
              code: 'EXCLUDED_UNMODELED_CREDIT_MEMO',
              severity: 'WARNING',
              field: 'BLART',
              message: `Credit memo DG (BELNR ${row.BELNR}, amount ${row.WRBTR} ${row.WAERS}) excluded from exposure calculation.`,
              sourceRecordId: row.BELNR,
              customerId: row.KUNNR
            });
          } else if (row.BLART === 'DZ') {
            qualityIssues.push({
              code: 'EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT',
              severity: 'WARNING',
              field: 'BLART',
              message: `Payment on account DZ in BSID (BELNR ${row.BELNR}, amount ${row.WRBTR} ${row.WAERS}) excluded from exposure calculation.`,
              sourceRecordId: row.BELNR,
              customerId: row.KUNNR
            });
          } else {
            qualityIssues.push({
              code: 'EXCLUDED_UNMODELED_DOCUMENT_TYPE',
              severity: 'WARNING',
              field: 'BLART',
              message: `Document type ${row.BLART} in BSID (BELNR ${row.BELNR}) excluded from exposure calculation.`,
              sourceRecordId: row.BELNR,
              customerId: row.KUNNR
            });
          }
        }

      } else if (entityType === 'SALES_ORDER') {
        const vbakRows = readCsvTable(simDir, 'VBAK.csv');
        records = vbakRows.map(row => ({
          VBELN: row.VBELN,
          ITEM_ID: '000010',
          KUNNR: row.KUNNR,
          NETWR: row.NETWR,
          WAERS: row.WAERS || row.WAERK,
          STATUS: 'Open'
        }));

      } else if (entityType === 'PAYMENT') {
        const bsadRows = readCsvTable(simDir, 'BSAD.csv');
        for (const row of bsadRows) {
          if (row.BLART === 'DZ') {
            const postingDateIso = parseSapDateToIso(row.AUGDT) || businessDateIso;
            records.push({
              AUGBL: row.AUGBL,
              KUNNR: row.KUNNR,
              WRBTR: row.WRBTR,
              WAERS: row.WAERS,
              AUGDT: postingDateIso,
              STATUS: 'Cleared'
            });
          } else {
            qualityIssues.push({
              code: 'EXCLUDED_UNMODELED_CLEARING_TYPE',
              severity: 'WARNING',
              field: 'BLART',
              message: `Non-payment clearing item in BSAD (AUGBL ${row.AUGBL}, BLART ${row.BLART}) excluded from payment history.`,
              sourceRecordId: row.AUGBL,
              customerId: row.KUNNR
            });
          }
        }
      }

      return {
        records,
        sourceEntity: configuredMapping.sourceEntity,
        sourceRecordIdField: configuredMapping.sourceRecordIdField,
        mapping: { ...configuredMapping.fields },
        nextCursor: null,
        sourceTimestamp: `${businessDateIso}T00:00:00.000Z`,
        retrievedAt: retrievedAt.toISOString(),
        complete: true,
        qualityIssues
      };
    }
  };
}

module.exports = {
  CONFIGURATION_REFERENCE,
  MAPPING_VERSION,
  SOURCE_ID,
  SOURCE_NAME,
  SOURCE_TYPE,
  SUPPORTED_ENTITIES,
  createMockSapGeneratedConnector,
  getMockSapGeneratedSourceConfiguration,
  getMockSapGeneratedSourceDefinition,
  isProduction,
  isSapSimEnabled
};
