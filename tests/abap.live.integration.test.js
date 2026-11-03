const test = require('node:test');
const assert = require('node:assert/strict');
const { AbapClient } = require('../srv/integrations/abap/client');

const customerId = process.env.ABAP_LIVE_TEST_CUSTOMER_ID;
const enabled = process.env.ABAP_LIVE_TEST === '1'
  && process.env.ABAP_LIVE_TEST_NONPRODUCTION === 'I_CONFIRM_NONPRODUCTION'
  && customerId === 'C1001'
  && Boolean(process.env.ABAP_DESTINATION_NAME);

test('ABAP non-production destination returns the synthetic connector contract', {
  skip: !enabled,
  timeout: 60000
}, async () => {
  const result = await new AbapClient().getCreditExposure(customerId);
  assert.equal(result.customer.ID, customerId);
  assert.ok(Number.isFinite(result.analysis.creditLimit));
  assert.match(result.customer.currency, /^[A-Z]{3}$/);
  assert.ok(Array.isArray(result.openItems));
  assert.ok(result.openItems.every(item =>
    item.customer_ID === customerId
    && item.currency === result.customer.currency
    && Number.isFinite(item.amount)));
  assert.equal(result.source, 'ABAP Environment via BTP Destination service');
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
});
