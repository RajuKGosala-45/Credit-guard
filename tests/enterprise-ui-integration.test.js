const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { chat } = require('../srv/agent');

test('Enterprise UI & AI Credit Assistance integration tests', async (t) => {
  await cds.test(__dirname + '/..');
  const db = cds.db;

  await t.test('Agent handles overdue invoices, high exposure, and collections recommendations with live data', async () => {
    const user = { id: 'test-user', roles: ['CreditReader', 'CreditMonitor'] };

    const response = await chat(
      'List all customers with overdue invoices and high exposure, and recommend collections actions.',
      db,
      null,
      user,
      { customerDataSource: 'local' }
    );

    assert.ok(response && response.reply, 'Agent must return a reply');
    assert.match(response.reply, /overdue/i, 'Reply must describe overdue items');
    assert.match(response.reply, /utili[sz]ation/i, 'Reply must describe utilization');
    assert.match(response.reply, /action/i, 'Reply must recommend collections actions');
    assert.doesNotMatch(response.reply, /could not safely validate the plan inputs/i, 'Must not return validation error');
  });

  await t.test('Agent handles evaluation of C001 (Aarav Components) with live deterministic calculations', async () => {
    const user = { id: 'test-user', roles: ['CreditReader', 'CreditAnalyst'] };

    const response = await chat(
      'Evaluate Aarav Components (C001) credit risk and exposure.',
      db,
      null,
      user,
      { customerDataSource: 'local' }
    );

    assert.ok(response && response.reply, 'Agent must return a reply');
    assert.match(response.reply, /Aarav|C001/i, 'Reply must mention Aarav or C001');
    assert.doesNotMatch(response.reply, /could not safely validate the plan inputs/i, 'Must not return validation error');
  });
});
