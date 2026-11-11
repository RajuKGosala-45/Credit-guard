const { createHash } = require('node:crypto');
const cds = require('@sap/cds');

const { SELECT, INSERT } = cds.ql;
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
  } catch (cause) {
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
          `Mock SAP Generated record ${row.ID} conflicts with an existing Credit Guard ${table.split('.').at(-1)} record.`,
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
  // Decision 6: Mixed-currency customer (REJECTED_MIXED_CURRENCY) is QUARANTINED and does not fail extraction
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
  for (const customer of customers.values()) {
    if (quarantinedCustomers.has(customer.customerId)) continue;
    const account = accountByCustomer.get(customer.customerId);
    if (!customer.country || !customer.currency || !customer.riskClass
      || customer.currency !== account?.currency) {
      throw projectionError(`Mock SAP Generated customer ${customer.customerId} has incomplete or inconsistent account data.`);
    }
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

  const paymentRows = [];
  for (const payment of grouped.PAYMENT) {
    if (quarantinedCustomers.has(payment.customerId)) continue;
    const account = accounts.get(payment.accountId || `${payment.customerId}-MAIN`) || accounts.get(payment.customerId);
    if (!customers.has(payment.customerId) || !account
      || account.customerId !== payment.customerId || payment.currency !== account.currency) {
      throw projectionError(`Mock SAP Generated payment ${payment.paymentId} has an invalid customer or account reference.`);
    }
    paymentRows.push({
      ID: businessId('MSP', payment.paymentId),
      customer_ID: payment.customerId,
      reference: payment.paymentId,
      amount: payment.amount,
      currency: payment.currency,
      postingDate: payment.postingDate,
      status: payment.paymentStatus
    });
  }

  const allOpenItemRows = [...invoiceRows, ...salesOrderRows];

  const customerProjection = await insertMissing(tx, 'credit.Customers', customerRows, {
    preservedFields: ['creditLimit']
  });
  const openItemProjection = await insertMissing(tx, 'credit.OpenItems', allOpenItemRows);
  const paymentProjection = await insertMissing(tx, 'credit.Payments', paymentRows);

  return {
    CUSTOMER: {
      sourceRecords: customerRows.length,
      inserted: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent,
      quarantined: quarantinedCustomers.size
    },
    CREDIT_ACCOUNT: {
      sourceRecords: grouped.CREDIT_ACCOUNT.length,
      applied: customerProjection.inserted,
      alreadyPresent: customerProjection.alreadyPresent
    },
    INVOICE: {
      sourceRecords: invoiceRows.length,
      inserted: invoiceRows.filter(r => r.type === 'Invoice').length
    },
    SALES_ORDER: {
      sourceRecords: salesOrderRows.length,
      inserted: salesOrderRows.length
    },
    OPEN_ITEMS: openItemProjection,
    PAYMENT: paymentProjection,
    quarantinedCustomers: [...quarantinedCustomers],
    qualityIssues: projectionQualityIssues
  };
}

module.exports = {
  projectMockSapGeneratedRecords
};
