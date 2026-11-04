const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { chat, createToolRegistry, validateToolInput } = require('../srv/agent');
const {
  AbapClient,
  AbapIntegrationError
} = require('../srv/integrations/abap/client');

const reader = new cds.User({ id: 'reader', roles: ['CreditReader'] });

const rawCustomer = {
  CustomerId: 'C1001',
  CustomerName: 'Synthetic Customer 1001',
  CreditLimit: '1000.00',
  Currency: 'EUR',
  ReviewDate: '2025-06-01',
  RiskClass: 'A'
};

const rawItems = [
  {
    OpenItemId: 'I-1001',
    CustomerId: 'C1001',
    Type: 'Invoice',
    Amount: '700.00',
    Currency: 'EUR',
    DueDate: '2025-10-01',
    Status: 'Overdue'
  },
  {
    OpenItemId: 'I-1002',
    CustomerId: 'C1001',
    Type: 'Invoice',
    Amount: '500.00',
    Currency: 'EUR',
    DueDate: '2026-04-01',
    Status: 'Open'
  }
];

const silentLogger = { info() {}, warn() {} };
const destination = { url: 'https://abap.example/sap/opu/odata4/zcredit/srvd/sap/zui_cg/0001' };

function createClient(request, options = {}) {
  return new AbapClient({
    destinationResolver: options.destinationResolver || (async () => destination),
    httpRequest: request,
    logger: options.logger || silentLogger,
    now: options.now || (() => new Date('2026-03-15T12:00:00.000Z')),
    ...options
  });
}

function emptyDb() {
  return { async run() { return []; } };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('ABAP connector follows same-origin OData pagination and applies deterministic Credit Guard rules', async () => {
  const requests = [];
  const client = createClient(async (target, config) => {
    requests.push({ target, config });
    if (config.url === 'Customers') return { status: 200, data: { value: [rawCustomer] } };
    if (config.url === 'OpenItems') {
      return {
        status: 200,
        data: {
          value: [rawItems[0]],
          '@odata.nextLink': `${destination.url}/OpenItems?$skiptoken=next`
        }
      };
    }
    if (config.url.startsWith(`${destination.url}/OpenItems?`)) {
      return { status: 200, data: { value: [rawItems[1]] } };
    }
    throw new Error('Unexpected mocked endpoint.');
  });

  const result = await client.getCreditExposure('C1001');

  assert.equal(result.customer.ID, 'C1001');
  assert.equal(result.customer.currency, 'EUR');
  assert.equal(result.analysis.exposure, 1200);
  assert.equal(result.analysis.creditLimit, 1000);
  assert.equal(result.analysis.utilisation, 1.2);
  assert.equal(result.analysis.overdueAmount, 700);
  assert.ok(result.analysis.flags.includes('OVERDUE_RISK'));
  assert.equal(result.source, 'ABAP Environment via BTP Destination service');
  assert.equal(result.retrievedAt, '2026-03-15T12:00:00.000Z');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ config }) => config.method === 'get' && config.timeout === 10000));
  assert.deepEqual(requests[0].config.params, {
    '$filter': "CustomerId eq 'C1001'",
    '$top': 1
  });
});

test('ABAP collection paging stops after cancellation and caps requests to the remaining budget', async () => {
  const controller = new AbortController();
  const requests = [];
  const client = createClient(async (_target, config) => {
    requests.push(config);
    controller.abort(Object.assign(new Error('Monitoring deadline exceeded.'), {
      category: 'monitoring_deadline_exceeded'
    }));
    return { status: 200, data: { value: [rawCustomer] } };
  }, { timeoutMs: 10000 });

  await assert.rejects(client.listCustomerAnalyses({
    signal: controller.signal,
    deadlineAt: Date.now() + 5000
  }), error => error.category === 'monitoring_deadline_exceeded');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].timeout <= 5000);
  assert.equal(requests[0].signal, controller.signal);
});

test('ABAP collection does not start the next page when cancellation arrives between pages', async () => {
  const controller = new AbortController();
  const firstPageStarted = deferred();
  const finishFirstPage = deferred();
  const requests = [];
  const client = createClient(async (_target, config) => {
    requests.push(config);
    firstPageStarted.resolve();
    await finishFirstPage.promise;
    return {
      status: 200,
      data: {
        value: [rawCustomer],
        '@odata.nextLink': `${destination.url}/Customers?$skiptoken=next`
      }
    };
  });
  const result = client.listCustomers({ signal: controller.signal });
  await firstPageStarted.promise;
  controller.abort(Object.assign(new Error('Monitoring worker is shutting down.'), {
    category: 'monitoring_worker_shutdown'
  }));
  finishFirstPage.resolve();
  await assert.rejects(result, error => error.category === 'monitoring_worker_shutdown');
  assert.equal(requests.length, 1);
});

test('ABAP connector reports a missing exact customer as 404, without using local records', async () => {
  const client = createClient(async () => ({ status: 200, data: { value: [] } }));
  await assert.rejects(client.searchCustomer('C1001'), error =>
    error instanceof AbapIntegrationError
    && error.statusCode === 404
    && error.category === 'abap_customer_not_found');
});

test('ABAP connector rejects missing required customer and open-item fields', async () => {
  const missingCustomerName = createClient(async (_target, config) => ({
    status: 200,
    data: { value: [config.url === 'Customers' ? { CustomerId: 'C1001' } : []] }
  }));
  await assert.rejects(missingCustomerName.getCustomerDetails('C1001'), /missing CustomerName/i);

  const missingAmount = createClient(async (_target, config) => ({
    status: 200,
    data: {
      value: config.url === 'Customers'
        ? [rawCustomer]
        : [{ ...rawItems[0], Amount: undefined }]
    }
  }));
  await assert.rejects(missingAmount.getCustomerDetails('C1001'), /missing or invalid Amount/i);
});

test('ABAP connector refuses currency mismatches before calculating exposure', async () => {
  const client = createClient(async (_target, config) => ({
    status: 200,
    data: {
      value: config.url === 'Customers'
        ? [rawCustomer]
        : [{ ...rawItems[0], Currency: 'USD' }]
    }
  }));
  await assert.rejects(client.getCreditExposure('C1001'), error =>
    error.category === 'abap_currency_mismatch' && error.statusCode === 502);
});

test('ABAP portfolio rejects an open-item ID assigned to multiple customers', async () => {
  const secondCustomer = { ...rawCustomer, CustomerId: 'C1002', CustomerName: 'Synthetic Customer 1002' };
  const client = createClient(async (_target, config) => ({
    status: 200,
    data: {
      value: config.url === 'Customers'
        ? [rawCustomer, secondCustomer]
        : [rawItems[0], { ...rawItems[0], CustomerId: 'C1002' }]
    }
  }));

  await assert.rejects(client.listCustomerAnalyses(), error =>
    error instanceof AbapIntegrationError
    && error.statusCode === 502
    && error.category === 'abap_invalid_response'
    && /multiple customers/i.test(error.message));
});

test('ABAP connector safely categorizes timeouts and authorization failures', async () => {
  const timeoutClient = createClient(async () => {
    const error = new Error('request timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  });
  await assert.rejects(timeoutClient.searchCustomer('C1001'), error =>
    error.category === 'abap_timeout' && error.statusCode === 504);

  const unauthorizedClient = createClient(async () => {
    const error = new Error('secret-bearing remote response');
    error.response = { status: 401, data: { password: 'must-not-leak' } };
    throw error;
  });
  await assert.rejects(unauthorizedClient.searchCustomer('C1001'), error =>
    error.category === 'abap_unauthorized'
    && !error.message.includes('secret-bearing')
    && !error.message.includes('must-not-leak'));
});

test('ABAP connector rejects cross-origin pagination links to prevent credential forwarding', async () => {
  const client = createClient(async () => ({
    status: 200,
    data: {
      value: [rawCustomer],
      '@odata.nextLink': 'https://attacker.example/collect'
    }
  }));
  await assert.rejects(client.searchCustomer('C1001'), error =>
    error.category === 'abap_invalid_response'
    && /outside its configured destination/i.test(error.message));
});

test('ABAP connector validates relative endpoint configuration and customer identifiers', () => {
  assert.throws(() => createClient(async () => ({}), {
    customersPath: 'https://attacker.example/Customers'
  }), error => error.category === 'abap_configuration');
  assert.throws(() => validateToolInput('analyzeAbapCreditRisk', { customerId: 'C1001/../../' }),
    error => error.statusCode === 400);
  assert.equal(validateToolInput('analyzeAbapCreditRisk', { customerId: 'C12345678901' }).customerId,
    'C12345678901');
  assert.throws(() => validateToolInput('analyzeAbapCreditRisk', { customerId: 'C123456789012' }),
    error => error.statusCode === 400);
});

test('ABAP connector rejects open-item identifiers that do not fit the CDS key', async () => {
  const client = createClient(async (_target, config) => ({
    status: 200,
    data: {
      value: config.url === 'Customers'
        ? [rawCustomer]
        : [{ ...rawItems[0], OpenItemId: 'ITEM-IDENTIFIER-TOO-LONG' }]
    }
  }));
  await assert.rejects(client.getCreditExposure('C1001'), error =>
    error.category === 'abap_invalid_response'
    && /exceeds the Credit Guard key length/i.test(error.message));
});

test('ABAP Agent tools enforce reader permission and return source timestamps', async () => {
  const abapClient = {
    async getCreditExposure() {
      return {
        source: 'ABAP Environment via BTP Destination service',
        retrievedAt: '2026-03-15T12:00:00.000Z',
        analysisBasis: 'Existing Credit Guard rules.',
        customer: { ID: 'C1001', currency: 'EUR' },
        openItems: rawItems,
        analysis: {
          ID: 'C1001',
          name: 'Synthetic Customer 1001',
          riskClass: 'A',
          exposure: 1200,
          creditLimit: 1000,
          currency: 'EUR',
          utilisation: 1.2,
          overdueAmount: 700,
          overdueShare: 700 / 1200,
          flags: ['BREACH', 'OVERDUE_RISK']
        }
      };
    },
    async searchCustomer() {
      return { ID: 'C1001', name: 'Synthetic Customer 1001' };
    },
    async getCustomerDetails() {
      return {
        source: 'ABAP Environment via BTP Destination service',
        retrievedAt: '2026-03-15T12:00:00.000Z',
        customer: { ID: 'C1001', currency: 'EUR' },
        openItems: rawItems
      };
    },
    async getOpenItems() {
      return rawItems;
    }
  };
  const registry = createToolRegistry(emptyDb(), reader, { abapClient });
  const result = await registry.analyzeAbapCreditRisk({ customerId: 'C1001' });
  assert.equal(result.analysis.utilisation, 1.2);
  assert.equal(result.source, 'ABAP Environment via BTP Destination service');
  assert.equal(result.retrievedAt, '2026-03-15T12:00:00.000Z');

  const unauthorized = new cds.User({ id: 'no-reader', roles: [] });
  const deniedRegistry = createToolRegistry(emptyDb(), unauthorized, { abapClient });
  await assert.rejects(deniedRegistry.analyzeAbapCreditRisk({ customerId: 'C1001' }), error =>
    error.statusCode === 403);
});

test('ABAP offline analysis is deterministic and unavailable services never fall back to local demo data', async () => {
  const client = createClient(async (_target, config) => ({
    status: 200,
    data: {
      value: config.url === 'Customers' ? [rawCustomer] : rawItems
    }
  }));
  const result = await chat(
    'Analyse customer C1001 using ABAP data.',
    emptyDb(),
    undefined,
    reader,
    { provider: null, abapClient: client }
  );
  assert.match(result.reply, /EUR 1,200 exposure against EUR 1,000 limit/);
  assert.match(result.reply, /Data source: ABAP Environment via BTP Destination service/);
  assert.match(result.reply, /Retrieved at: 2026-03-15T12:00:00.000Z/);
  assert.equal(result.execution.dataSources[0].customerId, 'C1001');
  assert.ok(result.execution.steps[0].summary.includes('2026-03-15T12:00:00.000Z'));

  const unavailable = new AbapClient({
    destinationResolver: async () => undefined,
    httpRequest: async () => { throw new Error('Must not request when destination is missing.'); },
    logger: silentLogger
  });
  await assert.rejects(
    chat('Analyse customer C1001 using ABAP data.', emptyDb(), undefined, reader, {
      provider: null,
      abapClient: unavailable
    }),
    error => error.category === 'abap_destination_unavailable'
      && error.statusCode === 503
      && error.execution.status === 'failed'
  );
});

test('ABAP customer provider can be selected without changing deterministic business rules', async () => {
  const expected = {
    source: 'ABAP Environment via BTP Destination service',
    retrievedAt: '2026-03-15T12:00:00.000Z',
    customer: { ID: 'C1001', currency: 'EUR' },
    openItems: rawItems,
    analysis: {
      ID: 'C1001',
      name: 'Synthetic Customer 1001',
      creditLimit: 1000,
      exposure: 1200,
      utilisation: 1.2,
      overdueAmount: 700,
      overdueShare: 700 / 1200,
      flags: ['BREACH', 'OVERDUE_RISK']
    }
  };
  const abapClient = {
    async getCreditExposure() { return expected; },
    async listCustomerAnalyses() { return [{ ...expected, customer: { ...expected.customer } }]; }
  };
  const tools = createToolRegistry(emptyDb(), reader, {
    abapClient,
    customerDataSource: 'abap'
  });
  const customer = await tools.get_customer({ customer_id: 'C1001' });
  assert.equal(customer.source, expected.source);
  assert.equal(customer.utilisation, 1.2);
  await assert.rejects(tools.prepare_limit_change({
    customer_id: 'C1001',
    new_limit: 1500,
    reason: 'Must not create a local proposal from remote read-only data'
  }), error => error.statusCode === 403);
});
