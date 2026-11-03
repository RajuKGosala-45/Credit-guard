const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'abap', 'adt');
const source = name => readFileSync(path.join(root, 'source', name), 'utf8');

test('ABAP CDS projections and service definition match the read-only connector contract', () => {
  const customer = source('ZI_CG_CUSTOMER.asddls');
  const openItem = source('ZI_CG_OPEN_ITEM.asddls');
  const customerProjection = source('ZC_CG_CUSTOMER.asddls');
  const itemProjection = source('ZC_CG_OPEN_ITEM.asddls');
  const service = source('ZUI_CREDIT_GUARD.srvd');

  for (const property of [
    'CustomerId', 'CustomerName', 'CreditLimit', 'Currency',
    'ReviewDate', 'Country', 'CompanyCode', 'RiskClass'
  ]) {
    assert.match(customer, new RegExp(`\\bas\\s+${property}\\b`));
    assert.match(customerProjection, new RegExp(`\\b${property}\\b`));
  }
  for (const property of [
    'OpenItemId', 'CustomerId', 'Type', 'Amount', 'Currency', 'DueDate', 'Status'
  ]) {
    assert.match(openItem, new RegExp(`\\bas\\s+${property}\\b`));
    assert.match(itemProjection, new RegExp(`\\b${property}\\b`));
  }
  assert.match(service, /ZC_CG_CUSTOMER\s+as\s+Customers/);
  assert.match(service, /ZC_CG_OPEN_ITEM\s+as\s+OpenItems/);
  assert.doesNotMatch(service, /behavior|create|update|delete/i);
});

test('synthetic ABAP CSV rows fit connector keys and include matching currencies', () => {
  const customerRows = readFileSync(path.join(root, 'test-data', 'customers.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1).map(line => line.split(','));
  const itemRows = readFileSync(path.join(root, 'test-data', 'open-items.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1).map(line => line.split(','));
  const customers = new Map(customerRows.map(row => [row[0], row]));

  for (const [customerId, , , currency] of customerRows) {
    assert.ok(customerId.length <= 12);
    assert.equal(currency, 'EUR');
  }
  for (const [itemId, customerId, , , currency] of itemRows) {
    assert.ok(itemId.length <= 12);
    assert.ok(customers.has(customerId));
    assert.equal(currency, customers.get(customerId)[3]);
  }
});
