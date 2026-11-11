const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { startCapServer, stopCapServer } = require('./support/cap-server');
const { generateDataset } = require('../scripts/generate-sap-sim-data');
const { defaultSimClock, isSapSimEnabled } = require('../srv/integrations/mock-sap-generated/connector');
const { loadGeneratedSapPortfolio } = require('../srv/integrations/mock-sap-generated/loader');

let server;

function normalizeLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

async function request(origin, reqPath, { identity = 'reader', method = 'GET', body } = {}) {
  const headers = {};
  if (identity) {
    headers.authorization = `Basic ${Buffer.from(`${identity}:test`).toString('base64')}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${origin}${reqPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = normalizeLf(await response.text());
  let responseBody;
  try {
    responseBody = text ? JSON.parse(text) : null;
  } catch {
    responseBody = text;
  }
  return { response, body: responseBody };
}

test.before(async () => {
  server = await startCapServer({
    env: {
      CREDIT_GUARD_SAP_SIM: 'true'
    }
  });
});

test.after(async () => {
  await stopCapServer(server);
});

test('Generator defaults seed to 42 and today to current UTC date when called without arguments', () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const dataset = generateDataset();
  assert.equal(dataset.expectedResults.metadata.seed, 42);
  assert.equal(dataset.expectedResults.metadata.customerCount, 300);
  assert.equal(dataset.expectedResults.metadata.asOfDate, todayUtc);
  assert.equal(dataset.tables.BUT000.length, 300);
});

test('Startup hook is inert without CREDIT_GUARD_SAP_SIM_AUTOLOAD=true, and load on empty db/sap-sim/data populates 312 customers idempotently', async () => {
  const savedGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'dummy';

  try {
    // 1. Verify startup hook was inert without CREDIT_GUARD_SAP_SIM_AUTOLOAD=true
    const initialRes = await request(server.origin, '/api/customers');
    assert.equal(initialRes.response.status, 200);
    const initialDemoCustomers = initialRes.body;
    assert.equal(initialDemoCustomers.length, 13);
    assert.deepEqual(
      initialDemoCustomers.map(c => c.ID).sort(),
      ['C001', 'C002', 'C003', 'C004', 'C005', 'C006', 'C007', 'C008', 'C009', 'C010', 'C011', 'C012', 'C013']
    );

    // 2. Remove db/sap-sim/data completely to prove load generates CSVs from scratch
    const simDataDir = path.resolve(__dirname, '..', 'db', 'sap-sim', 'data');
    fs.rmSync(simDataDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(simDataDir), false);

    // 3. First load on empty db/sap-sim/data
    const expectedAsOfDate = defaultSimClock().toISOString().slice(0, 10);
    const load1 = await request(server.origin, '/api/mock-sap-generated/load', {
      identity: 'administrator',
      method: 'POST',
      body: {}
    });
    assert.equal(load1.response.status, 200);
    assert.equal(load1.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
    assert.equal(load1.body.sourceId, 'MOCK-SAP-GEN-001');
    assert.equal(load1.body.status, 'SUCCEEDED_WITH_WARNINGS');
    assert.equal(load1.body.asOfDate, expectedAsOfDate);
    assert.equal(load1.body.seed, 42);
    assert.equal(load1.body.generatedCustomers, 300);
    assert.equal(load1.body.snapshotPromoted, true);
    assert.equal(load1.body.decisionEligible, false);
    assert.match(load1.body.decisionEligibleExplanation, /4 expected synthetic quality warnings/);
    assert.deepEqual(load1.body.counts, {
      projectedCustomers: 299,
      customersInserted: 299,
      customersUpdated: 0,
      openItems: {
        total: 709,
        invoices: 530,
        salesOrders: 179
      },
      payments: 1010,
      paymentHistory: 1010
    });
    assert.deepEqual(load1.body.quarantinedCustomers, ['0001000009']);
    assert.equal(load1.body.quarantinedCustomerCount, 1);
    assert.equal(load1.body.qualityIssueCounts.total, 4);
    assert.equal(load1.body.qualityIssueCounts.errors, 0);
    assert.equal(load1.body.qualityIssueCounts.warnings, 4);
    assert.equal(typeof load1.body.monitoringRunId, 'string');
    assert.ok(load1.body.monitoringRunId.length > 0);
    assert.equal(load1.body.monitoringError, null);
    assert.equal(fs.existsSync(path.join(simDataDir, 'BUT000.csv')), true);

    // 4. Verify 312 customers in portfolio and C001..C013 untouched
    const afterLoad1Res = await request(server.origin, '/api/customers');
    assert.equal(afterLoad1Res.response.status, 200);
    assert.equal(afterLoad1Res.body.length, 312);
    const demoAfterLoad1 = afterLoad1Res.body.filter(c => /^C\d{3}$/.test(c.ID));
    assert.deepEqual(demoAfterLoad1, initialDemoCustomers);

    // Verify scenario customers 0001000001..0001000004 and 404 for quarantined 0001000009
    const c1 = await request(server.origin, '/api/customers/0001000001');
    assert.equal(c1.response.status, 200);
    assert.equal(c1.body.status, 'WARNING');
    assert.deepEqual(c1.body.flags, ['WARNING']);

    const c2 = await request(server.origin, '/api/customers/0001000002');
    assert.equal(c2.response.status, 200);
    assert.equal(c2.body.status, 'BREACH');
    assert.deepEqual(c2.body.flags, ['BREACH']);

    const c3 = await request(server.origin, '/api/customers/0001000003');
    assert.equal(c3.response.status, 200);
    assert.equal(c3.body.status, 'BREACH');
    assert.deepEqual([...c3.body.flags].sort(), ['BREACH', 'CRITICAL']);

    const c4 = await request(server.origin, '/api/customers/0001000004');
    assert.equal(c4.response.status, 200);
    assert.equal(c4.body.status, 'MANUAL_REVIEW');
    assert.deepEqual(c4.body.flags, ['NO_LIMIT']);
    assert.equal(c4.body.utilisation, null);

    const c9 = await request(server.origin, '/api/customers/0001000009');
    assert.equal(c9.response.status, 404);

    // 5. Second load is idempotent
    const load2 = await request(server.origin, '/api/mock-sap-generated/load', {
      identity: 'administrator',
      method: 'POST',
      body: {}
    });
    assert.equal(load2.response.status, 200);
    assert.deepEqual(load2.body.counts, {
      projectedCustomers: 299,
      customersInserted: 0,
      customersUpdated: 299,
      openItems: {
        total: 709,
        invoices: 530,
        salesOrders: 179
      },
      payments: 1010,
      paymentHistory: 1010
    });

    const afterLoad2Res = await request(server.origin, '/api/customers');
    assert.equal(afterLoad2Res.response.status, 200);
    assert.equal(afterLoad2Res.body.length, 312);
    const demoAfterLoad2 = afterLoad2Res.body.filter(c => /^C\d{3}$/.test(c.ID));
    assert.deepEqual(demoAfterLoad2, initialDemoCustomers);
  } finally {
    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;
  }
});

test('RBAC and request validation: non-admin gets 403, cds.User.Privileged gets 403, body or query options rejected with 400', async () => {
  // Non-admin HTTP requests get 403
  const readerRes = await request(server.origin, '/api/mock-sap-generated/load', {
    identity: 'reader',
    method: 'POST',
    body: {}
  });
  assert.equal(readerRes.response.status, 403);

  const controllerRes = await request(server.origin, '/api/mock-sap-generated/load', {
    identity: 'controller',
    method: 'POST',
    body: {}
  });
  assert.equal(controllerRes.response.status, 403);

  // Direct call with cds.User.Privileged is rejected with 403
  const privUser = new cds.User.Privileged('priv');
  await assert.rejects(
    () => loadGeneratedSapPortfolio({ db: {}, user: privUser }),
    { statusCode: 403 }
  );

  // Body options rejected with 400
  const bodyOptRes = await request(server.origin, '/api/mock-sap-generated/load', {
    identity: 'administrator',
    method: 'POST',
    body: { seed: 99 }
  });
  assert.equal(bodyOptRes.response.status, 400);
  assert.equal(bodyOptRes.body.label, 'SYNTHETIC - NOT REAL SAP DATA');

  // Query options rejected with 400
  const queryOptRes = await request(server.origin, '/api/mock-sap-generated/load?seed=99', {
    identity: 'administrator',
    method: 'POST',
    body: {}
  });
  assert.equal(queryOptRes.response.status, 400);
  assert.equal(queryOptRes.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
});

test('Concurrent loads return one 200 and one 409', async () => {
  const [resA, resB] = await Promise.all([
    request(server.origin, '/api/mock-sap-generated/load', {
      identity: 'administrator',
      method: 'POST',
      body: {}
    }),
    request(server.origin, '/api/mock-sap-generated/load', {
      identity: 'administrator',
      method: 'POST',
      body: {}
    })
  ]);

  const statuses = [resA.response.status, resB.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflictRes = resA.response.status === 409 ? resA : resB;
  assert.equal(conflictRes.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
});

test('Missing scripts/generate-sap-sim-data.js returns 503 and does not crash module load or server startup', async () => {
  const adminUser = new cds.User({ id: 'sap-sim-autoload', roles: ['CreditAdmin', 'CreditReader'] });
  const originalLoad = Module._load;

  try {
    Module._load = function patchedLoad(requestId, parent, isMain) {
      if (typeof requestId === 'string' && requestId.includes('generate-sap-sim-data')) {
        const err = new Error(`Cannot find module '${requestId}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return originalLoad.call(this, requestId, parent, isMain);
    };

    // Requiring loader.js at startup does not load scripts/generate-sap-sim-data.js
    const loaderPath = require.resolve('../srv/integrations/mock-sap-generated/loader');
    delete require.cache[loaderPath];
    const freshLoader = require('../srv/integrations/mock-sap-generated/loader');
    assert.equal(typeof freshLoader.loadGeneratedSapPortfolio, 'function');

    // Calling loadGeneratedSapPortfolio when scripts/ is missing throws 503
    await assert.rejects(
      () => freshLoader.loadGeneratedSapPortfolio({ db: {}, user: adminUser }),
      { statusCode: 503, category: 'generator_script_unavailable' }
    );
  } finally {
    Module._load = originalLoad;
  }
});

test('Gate off returns 403 matching existing generated routes, and startup hook populates when CREDIT_GUARD_SAP_SIM_AUTOLOAD=true', async () => {
  // 1. Direct gate check when NODE_ENV=production without CREDIT_GUARD_SAP_SIM=true
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSimFlag = process.env.CREDIT_GUARD_SAP_SIM;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.CREDIT_GUARD_SAP_SIM;
    assert.equal(isSapSimEnabled(), false);

    const adminUser = new cds.User({ id: 'admin', roles: ['CreditAdmin', 'CreditReader'] });
    await assert.rejects(
      () => loadGeneratedSapPortfolio({ db: {}, user: adminUser }),
      { statusCode: 403, category: 'mock_sap_generated_disabled' }
    );
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedSimFlag === undefined) delete process.env.CREDIT_GUARD_SAP_SIM;
    else process.env.CREDIT_GUARD_SAP_SIM = savedSimFlag;
  }

  // 2. HTTP gate off check on server with NODE_ENV=production and CREDIT_GUARD_SAP_SIM unset
  const cdsModulePath = require.resolve('@sap/cds');
  const hookPath = path.join(os.tmpdir(), `sap-sim-load-prod-hook-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(
    hookPath,
    `const cds = require(${JSON.stringify(cdsModulePath)}); cds.on('listening', () => { process.env.NODE_ENV = 'production'; });\n`,
    'utf8'
  );
  const prodServer = await startCapServer({
    env: {
      NODE_OPTIONS: `--require ${JSON.stringify(hookPath)}`,
      CREDIT_GUARD_SAP_SIM: ''
    }
  });
  try {
    const loadBlocked = await request(prodServer.origin, '/api/mock-sap-generated/load', {
      identity: 'administrator',
      method: 'POST',
      body: {}
    });
    assert.equal(loadBlocked.response.status, 403);
    assert.equal(loadBlocked.body.label, 'SYNTHETIC - NOT REAL SAP DATA');
  } finally {
    await stopCapServer(prodServer);
    fs.rmSync(hookPath, { force: true });
  }

  // 3. Startup hook with CREDIT_GUARD_SAP_SIM=true and CREDIT_GUARD_SAP_SIM_AUTOLOAD=true populates 312 customers automatically
  const simDataDir = path.resolve(__dirname, '..', 'db', 'sap-sim', 'data');
  fs.rmSync(simDataDir, { recursive: true, force: true });

  const autoloadServer = await startCapServer({
    env: {
      CREDIT_GUARD_SAP_SIM: 'true',
      CREDIT_GUARD_SAP_SIM_AUTOLOAD: 'true'
    }
  });
  try {
    let customerCount = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const res = await request(autoloadServer.origin, '/api/customers');
      if (res.response.status === 200 && Array.isArray(res.body) && res.body.length === 312) {
        customerCount = res.body.length;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(customerCount, 312);

    const statusRes = await request(autoloadServer.origin, '/api/mock-sap-generated');
    assert.equal(statusRes.response.status, 200);
    assert.equal(statusRes.body.latestRun.status, 'SUCCEEDED_WITH_WARNINGS');
    assert.equal(statusRes.body.latestRun.snapshotPromoted, true);
  } finally {
    await stopCapServer(autoloadServer);
  }
});
