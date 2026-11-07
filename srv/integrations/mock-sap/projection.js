const { createHash } = require('node:crypto');
const cds = require('@sap/cds');

const { SELECT, INSERT } = cds.ql;
const ENTITY_TYPES = Object.freeze(['CUSTOMER', 'CREDIT_ACCOUNT', 'INVOICE', 'PAYMENT']);

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
  } catch (cause) {
    throw projectionError('Mock SAP canonical record could not be projected.', 'mock_projection_invalid');
  }
}

function businessId(prefix, ...parts) {
  const identity = parts.join('\u0000');
  return `${prefix}${createHash('sha256').update(identity).digest('hex').slice(0, 9)}`;
}

function groupRecords(records) {
  const grouped = Object.fromEntries(ENTITY_TYPES.map(type => [type, []]));
  for (const record of records) {
    if (Object.hasOwn(grouped, record.entityType)) grouped[record.entityType].push(parseCanonical(record));
  }
  if (ENTITY_TYPES.some(type => grouped[type].length === 0)) {
    throw projectionError('Mock SAP projection requires complete customer, credit account, invoice, and payment records.');
  }
  return grouped;
}

function indexUnique(records, key, label) {
  const indexed = new Map();
  for (const record of records) {
    const value = record[key];
    if (typeof value !== 'string' || !value) {
      throw projectionError(`Mock SAP ${label} has an invalid ${key}.`);
    }
    if (indexed.has(value)) throw projectionError(`Mock SAP ${label} contains duplicate ${key} values.`);
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

async function insertMissing(tx, table, rows, { preservedFields = [] } = {}) {
  let inserted = 0;
  let alreadyPresent = 0;
  for (const row of rows) {
    const existing = await tx.run(SELECT.one.from(table).where({ ID: row.ID }));
    if (existing) {
      const matchesFixture = Object.entries(row).every(([field, value]) =>
        preservedFields.includes(field) || sameValue(value, existing[field], field));
      if (!matchesFixture) {
        throw projectionError(
          `Mock SAP record ${row.ID} conflicts with an existing Credit Guard ${table.split('.').at(-1)} record.`,
          'mock_projection_conflict'
        );
      }
      alreadyPresent += 1;
      continue;
    }
    await tx.run(INSERT.into(table).entries(row));
    inserted += 1;
  }
  return { sourceRecords: rows.length, inserted, alreadyPresent };
}

async function projectMockSapRecords(tx, records) {
  const grouped = groupRecords(records);
  const customers = indexUnique(grouped.CUSTOMER, 'customerId', 'customers');
  const accounts = indexUnique(grouped.CREDIT_ACCOUNT, 'accountId', 'credit accounts');
  const accountByCustomer = new Map();
  for (const account of accounts.values()) {
    if (!customers.has(account.customerId) || accountByCustomer.has(account.customerId)) {
      throw projectionError('Mock SAP credit accounts must reference exactly one known customer each.');
    }
    accountByCustomer.set(account.customerId, account);
  }
  if (accountByCustomer.size !== customers.size) {
    throw projectionError('Every Mock SAP customer must have one credit account.');
  }

  const customerRows = [...customers.values()].map(customer => {
    const account = accountByCustomer.get(customer.customerId);
    if (!customer.country || !customer.currency || !customer.riskClass
      || !customer.lastReviewDate || customer.currency !== account.currency) {
      throw projectionError(`Mock SAP customer ${customer.customerId} has incomplete or inconsistent account data.`);
    }
    return {
      ID: customer.customerId,
      name: customer.customerName,
      country: customer.country,
      companyCode: customer.companyCode,
      currency: account.currency,
      creditLimit: account.creditLimit,
      riskClass: customer.riskClass,
      lastReviewDate: customer.lastReviewDate
    };
  });

  const invoiceRows = grouped.INVOICE.map(invoice => {
    const account = accounts.get(invoice.accountId);
    if (!customers.has(invoice.customerId) || !account
      || account.customerId !== invoice.customerId || invoice.currency !== account.currency) {
      throw projectionError(`Mock SAP invoice ${invoice.sourceDocumentId} has an invalid customer or account reference.`);
    }
    return {
      ID: businessId('MSI', invoice.sourceDocumentId, invoice.documentItemId || ''),
      customer_ID: invoice.customerId,
      type: 'INVOICE',
      amount: invoice.outstandingAmount,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      status: invoice.paymentStatus
    };
  });

  const paymentRows = grouped.PAYMENT.map(payment => {
    const account = accounts.get(payment.accountId);
    if (!customers.has(payment.customerId) || !account
      || account.customerId !== payment.customerId || payment.currency !== account.currency) {
      throw projectionError(`Mock SAP payment ${payment.paymentId} has an invalid customer or account reference.`);
    }
    return {
      ID: businessId('MSP', payment.paymentId),
      customer_ID: payment.customerId,
      reference: payment.paymentId,
      amount: payment.amount,
      currency: payment.currency,
      postingDate: payment.postingDate,
      status: payment.paymentStatus
    };
  });

  const customerProjection = await insertMissing(tx, 'credit.Customers', customerRows, {
    preservedFields: ['creditLimit']
  });
  const invoiceProjection = await insertMissing(tx, 'credit.OpenItems', invoiceRows);
  const paymentProjection = await insertMissing(tx, 'credit.Payments', paymentRows);
  return {
    CUSTOMER: {
      sourceRecords: customerProjection.sourceRecords,
      inserted: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent
    },
    CREDIT_ACCOUNT: {
      sourceRecords: grouped.CREDIT_ACCOUNT.length,
      applied: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent
    },
    INVOICE: invoiceProjection,
    PAYMENT: paymentProjection
  };
}

module.exports = { projectMockSapRecords };
