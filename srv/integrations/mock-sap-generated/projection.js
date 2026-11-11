const { createHash } = require('node:crypto');
const cds = require('@sap/cds');
const { upsertPaymentHistory } = require('../../canonicalRepository');
const {
  SOURCE_ID,
  addDaysToIso,
  getTrustedDataDirectory,
  parseSapDateToIso,
  readCsvTable
} = require('./connector');

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const ENTITY_TYPES = Object.freeze(['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'SALES_ORDER', 'PAYMENT']);

function projectionError(message, category = 'mock_projection_invalid') {
  const error = new Error(message);
  error.category = category;
  error.statusCode = 409;
  return error;
}

function parseCanonical(record) {
  try {
    const value = JSON.parse(record.canonicalData);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return value;
  } catch (_cause) {
    throw projectionError('Mock SAP Generated canonical record could not be projected.', 'mock_projection_invalid');
  }
}

function businessId(prefix, ...parts) {
  const identity = parts.join('\u0000');
  return `${prefix}${createHash('sha256').update(identity).digest('hex').slice(0, 9)}`;
}

function groupRecords(records) {
  const grouped = Object.fromEntries(ENTITY_TYPES.map(type => [type, []]));
  for (const record of records) {
    if (Object.hasOwn(grouped, record.entityType)) {
      grouped[record.entityType].push(parseCanonical(record));
    }
  }
  return grouped;
}

function indexUnique(records, key, label) {
  const indexed = new Map();
  for (const record of records) {
    const value = record[key];
    if (typeof value !== 'string' || !value) {
      throw projectionError(`Mock SAP Generated ${label} has an invalid ${key}.`);
    }
    if (indexed.has(value)) {
      throw projectionError(`Mock SAP Generated ${label} contains duplicate ${key} values.`);
    }
    indexed.set(value, record);
  }
  return indexed;
}

function sameValue(expected, actual, field) {
  if (['amount', 'creditLimit'].includes(field)) {
    return Number.isFinite(Number(expected)) && Number(expected) === Number(actual);
  }
  return expected === actual;
}

function daysBetweenIsoDates(earlierIso, laterIso) {
  if (!earlierIso || !laterIso) return 0;
  const start = Date.parse(`${String(earlierIso).slice(0, 10)}T00:00:00.000Z`);
  const end = Date.parse(`${String(laterIso).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24)));
}

async function upsertGeneratedCustomers(tx, rows) {
  let inserted = 0;
  let alreadyPresent = 0;
  let preservedCreditLimitDifferences = 0;

  for (const row of rows) {
    const existing = await tx.run(SELECT.one.from('credit.Customers').where({ ID: row.ID }));
    if (existing) {
      if (!sameValue(row.creditLimit, existing.creditLimit, 'creditLimit')) {
        preservedCreditLimitDifferences += 1;
      }
      const updatedFields = {
        name: row.name,
        country: row.country,
        companyCode: row.companyCode,
        currency: row.currency,
        riskClass: row.riskClass,
        lastReviewDate: row.lastReviewDate
      };
      const needsUpdate = Object.entries(updatedFields).some(([field, value]) => !sameValue(value, existing[field], field));
      if (needsUpdate) {
        await tx.run(UPDATE('credit.Customers').set(updatedFields).where({ ID: row.ID }));
      }
      alreadyPresent += 1;
      continue;
    }
    await tx.run(INSERT.into('credit.Customers').entries(row));
    inserted += 1;
  }

  return {
    sourceRecords: rows.length,
    inserted,
    alreadyPresent,
    preservedCreditLimitDifferences
  };
}

async function replaceCustomerScopedRows(tx, table, customerIds, rows) {
  let deleted = 0;
  for (const customerId of customerIds) {
    const count = await tx.run(DELETE.from(table).where({ customer_ID: customerId }));
    if (typeof count === 'number') deleted += count;
  }
  let inserted = 0;
  for (const row of rows) {
    await tx.run(INSERT.into(table).entries(row));
    inserted += 1;
  }
  return {
    sourceRecords: rows.length,
    deletedPrior: deleted,
    inserted
  };
}

async function projectMockSapGeneratedRecords(tx, records) {
  const grouped = groupRecords(records);
  const customers = indexUnique(grouped.CUSTOMER, 'customerId', 'customers');
  const accounts = indexUnique(grouped.CREDIT_ACCOUNT, 'accountId', 'credit accounts');
  const accountByCustomer = new Map();

  for (const account of accounts.values()) {
    if (!customers.has(account.customerId) || accountByCustomer.has(account.customerId)) {
      throw projectionError('Mock SAP Generated credit accounts must reference exactly one known customer each.');
    }
    accountByCustomer.set(account.customerId, account);
  }

  // Pre-scan credit-consuming items (INVOICE, SALES_ORDER) per customer to detect mixed currencies
  // Decision 6: Mixed-currency customer (0001000009) is QUARANTINED and does not fail extraction
  const currenciesByCustomer = new Map();
  for (const customerId of customers.keys()) {
    const account = accountByCustomer.get(customerId);
    const set = new Set();
    if (account?.currency) set.add(account.currency);
    currenciesByCustomer.set(customerId, set);
  }

  for (const invoice of grouped.INVOICE) {
    const set = currenciesByCustomer.get(invoice.customerId);
    if (set && invoice.currency) set.add(invoice.currency);
  }
  for (const so of grouped.SALES_ORDER) {
    const set = currenciesByCustomer.get(so.customerId);
    if (set && so.currency) set.add(so.currency);
  }

  const quarantinedCustomers = new Set();
  const projectionQualityIssues = [];

  for (const [customerId, currencySet] of currenciesByCustomer.entries()) {
    if (currencySet.size > 1) {
      quarantinedCustomers.add(customerId);
      projectionQualityIssues.push({
        code: 'QUARANTINED_MIXED_CURRENCY',
        severity: 'WARNING',
        message: `Customer ${customerId} quarantined: multiple currencies detected across credit-consuming items (${[...currencySet].join(', ')}).`,
        customerId
      });
    }
  }

  const customerRows = [];
  const validGeneratedCustomerIds = [];
  for (const customer of customers.values()) {
    if (quarantinedCustomers.has(customer.customerId)) continue;
    const account = accountByCustomer.get(customer.customerId);
    if (!customer.country || !customer.currency || !customer.riskClass
      || customer.currency !== account?.currency) {
      throw projectionError(`Mock SAP Generated customer ${customer.customerId} has incomplete or inconsistent account data.`);
    }
    validGeneratedCustomerIds.push(customer.customerId);
    customerRows.push({
      ID: customer.customerId,
      name: customer.customerName,
      country: customer.country,
      companyCode: customer.companyCode,
      currency: account.currency,
      creditLimit: account.creditLimit,
      riskClass: customer.riskClass,
      lastReviewDate: customer.lastReviewDate || null
    });
  }

  const invoiceRows = [];
  for (const invoice of grouped.INVOICE) {
    if (quarantinedCustomers.has(invoice.customerId)) continue;
    const account = accounts.get(invoice.accountId || `${invoice.customerId}-MAIN`) || accounts.get(invoice.customerId);
    if (!customers.has(invoice.customerId) || !account
      || account.customerId !== invoice.customerId || invoice.currency !== account.currency) {
      throw projectionError(`Mock SAP Generated invoice ${invoice.sourceDocumentId} has an invalid customer or account reference.`);
    }
    invoiceRows.push({
      ID: businessId('MSI', invoice.sourceDocumentId, invoice.documentItemId || ''),
      customer_ID: invoice.customerId,
      type: 'Invoice',
      amount: invoice.outstandingAmount,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      status: invoice.paymentStatus
    });
  }

  // Decision 4: Open sales orders projected to credit.OpenItems with type: 'SalesOrder'
  const salesOrderRows = [];
  for (const order of grouped.SALES_ORDER) {
    if (quarantinedCustomers.has(order.customerId)) continue;
    const account = accounts.get(order.accountId || `${order.customerId}-MAIN`) || accounts.get(order.customerId);
    if (!customers.has(order.customerId) || !account
      || account.customerId !== order.customerId || order.currency !== account.currency) {
      throw projectionError(`Mock SAP Generated sales order ${order.orderId} has an invalid customer or account reference.`);
    }
    salesOrderRows.push({
      ID: businessId('MSO', order.orderId, order.itemId || '000010'),
      customer_ID: order.customerId,
      type: 'SalesOrder',
      amount: order.creditRelevantAmount,
      currency: order.currency,
      dueDate: null,
      status: order.lifecycleStatus || 'Open'
    });
  }

  // Read BSAD metadata from trusted directory for Option 2B CG_PAYMENT_HISTORY enrichment
  const bsadMetaByAugbl = new Map();
  try {
    const simDir = getTrustedDataDirectory();
    const bsadRows = readCsvTable(simDir, 'BSAD.csv');
    for (const row of bsadRows) {
      if (row.AUGBL) {
        bsadMetaByAugbl.set(row.AUGBL, row);
      }
    }
  } catch (_err) {
    // If BSAD.csv cannot be read during a synthetic unit test with in-memory records, fall back to canonical fields
  }

  const paymentRows = [];
  const paymentHistoryEntries = [];
  for (const payment of grouped.PAYMENT) {
    if (quarantinedCustomers.has(payment.customerId)) continue;
    const customer = customers.get(payment.customerId);
    const account = accounts.get(payment.accountId || `${payment.customerId}-MAIN`) || accounts.get(payment.customerId);
    if (!customer || !account
      || account.customerId !== payment.customerId || payment.currency !== account.currency) {
      throw projectionError(`Mock SAP Generated payment ${payment.paymentId} has an invalid customer or account reference.`);
    }
    const pmtId = businessId('MSP', payment.paymentId);
    paymentRows.push({
      ID: pmtId,
      customer_ID: payment.customerId,
      reference: payment.paymentId,
      amount: payment.amount,
      currency: payment.currency,
      postingDate: payment.postingDate,
      status: payment.paymentStatus || 'Cleared'
    });

    const bsadRow = bsadMetaByAugbl.get(payment.paymentId);
    const zfbdtIso = bsadRow?.ZFBDT ? parseSapDateToIso(bsadRow.ZFBDT) : null;
    const zbd1tDays = bsadRow?.ZBD1T !== undefined ? parseInt(bsadRow.ZBD1T || '30', 10) : 30;
    const dueDateIso = zfbdtIso ? addDaysToIso(zfbdtIso, zbd1tDays) : payment.postingDate;
    const daysLate = daysBetweenIsoDates(dueDateIso, payment.postingDate);

    paymentHistoryEntries.push({
      payment_id: pmtId,
      bp_id: payment.customerId,
      company_code: bsadRow?.BUKRS || customer.companyCode || '1000',
      payment_doc_no: payment.paymentId,
      invoice_ref: bsadRow?.REBZG || null,
      payment_date: payment.postingDate,
      due_date: dueDateIso,
      days_late: daysLate,
      amount: payment.amount,
      currency: payment.currency,
      source_id: SOURCE_ID
    });
  }

  const allOpenItemRows = [...invoiceRows, ...salesOrderRows];

  // Clean up any prior rows if a customer was newly quarantined
  for (const quarantinedId of quarantinedCustomers) {
    await tx.run(DELETE.from('credit.OpenItems').where({ customer_ID: quarantinedId }));
    await tx.run(DELETE.from('credit.Payments').where({ customer_ID: quarantinedId }));
    await tx.run(DELETE.from('credit.Customers').where({ ID: quarantinedId }));
  }

  const customerProjection = await upsertGeneratedCustomers(tx, customerRows);
  const openItemProjection = await replaceCustomerScopedRows(tx, 'credit.OpenItems', validGeneratedCustomerIds, allOpenItemRows);
  const paymentProjection = await replaceCustomerScopedRows(tx, 'credit.Payments', validGeneratedCustomerIds, paymentRows);

  // Option 2B: Populate credit.CG_PAYMENT_HISTORY using upsertPaymentHistory, replacing only generated customers' rows
  let cgPaymentHistoryInserted = 0;
  let cgPaymentHistoryDeleted = 0;
  const hasCgPaymentHistoryTable = Boolean(
    tx?.model?.definitions?.['credit.CG_PAYMENT_HISTORY']
    || cds?.model?.definitions?.['credit.CG_PAYMENT_HISTORY']
    || (tx?.tables && Object.hasOwn(tx.tables, 'credit.CG_PAYMENT_HISTORY'))
  );
  if (hasCgPaymentHistoryTable) {
    for (const customerId of [...validGeneratedCustomerIds, ...quarantinedCustomers]) {
      const count = await tx.run(DELETE.from('credit.CG_PAYMENT_HISTORY').where({ bp_id: customerId }));
      if (typeof count === 'number') cgPaymentHistoryDeleted += count;
    }
    for (const entry of paymentHistoryEntries) {
      await upsertPaymentHistory(tx, entry);
      cgPaymentHistoryInserted += 1;
    }
  }

  return {
    CUSTOMER: {
      sourceRecords: customerRows.length,
      inserted: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent,
      preservedCreditLimitDifferences: customerProjection.preservedCreditLimitDifferences,
      quarantined: quarantinedCustomers.size
    },
    CREDIT_ACCOUNT: {
      sourceRecords: grouped.CREDIT_ACCOUNT.length,
      applied: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent,
      preservedCreditLimitDifferences: customerProjection.preservedCreditLimitDifferences
    },
    INVOICE: {
      sourceRecords: invoiceRows.length,
      inserted: invoiceRows.length
    },
    SALES_ORDER: {
      sourceRecords: salesOrderRows.length,
      inserted: salesOrderRows.length
    },
    OPEN_ITEMS: openItemProjection,
    PAYMENT: paymentProjection,
    CG_PAYMENT_HISTORY: {
      sourceRecords: paymentHistoryEntries.length,
      deletedPrior: cgPaymentHistoryDeleted,
      inserted: cgPaymentHistoryInserted
    },
    quarantinedCustomers: [...quarantinedCustomers],
    qualityIssues: projectionQualityIssues
  };
}

module.exports = {
  projectMockSapGeneratedRecords
};
