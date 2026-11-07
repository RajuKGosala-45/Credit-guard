const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { validateProductionBindings } = require('../srv/deployment');

const root = path.join(__dirname, '..');

function readProfile(profile) {
  const script = "const cds=require('@sap/cds'); console.log(JSON.stringify({profiles:cds.env.profiles,db:cds.env.requires.db,auth:cds.env.requires.auth}))";
  const env = { ...process.env, CDS_ENV: profile };
  delete env.VCAP_SERVICES;
  delete env.VCAP_APPLICATION;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('CAP profiles separate in-memory development, durable local, and production adapters', () => {
  const development = readProfile('development');
  const persistent = readProfile('persistent');
  const production = readProfile('production');

  assert.equal(development.db.kind, 'sqlite');
  assert.equal(development.db.credentials.database, ':memory:');
  assert.equal(persistent.db.kind, 'sqlite');
  assert.equal(persistent.db.credentials.database, 'credit-guard.sqlite');
  assert.equal(production.db.kind, 'hana');
  assert.equal(production.db.credentials, undefined);
  assert.equal(production.auth.kind, 'xsuaa');
});

test('XSUAA role templates define all supported business role collections and permissions', () => {
  const descriptor = JSON.parse(readFileSync(path.join(root, 'xs-security.json'), 'utf8'));
  const templates = new Map(descriptor['role-templates'].map(template => [template.name, template]));
  const expected = [
    'ReadOnlyBusinessUser',
    'CreditAnalyst',
    'CreditManager',
    'CreditApprover',
    'Administrator',
    'CreditMonitorOperator',
    'MonitoringJob'
  ];

  for (const name of expected) assert.ok(templates.has(name), `Missing ${name} role template.`);
  for (const template of templates.values()) {
    for (const scope of template['scope-references']) {
      assert.ok(descriptor.scopes.some(candidate => candidate.name === scope), `Unknown scope ${scope}.`);
    }
  }
  assert.ok(templates.get('ReadOnlyBusinessUser')['scope-references'].includes('$XSAPPNAME.CreditReader'));
  assert.ok(templates.get('Administrator')['scope-references'].includes('$XSAPPNAME.CreditAdmin'));
});

test('CAP production XSUAA authentication fails closed without a bound service', () => {
  const script = "const auth=require('@sap/cds/lib/srv/middlewares/auth'); try { auth(); process.exitCode=2; } catch (error) { console.log(error.message); if (!/no XSUAA instance bound/.test(error.message)) process.exitCode=1; }";
  const env = { ...process.env, CDS_ENV: 'production' };
  delete env.VCAP_SERVICES;
  delete env.VCAP_APPLICATION;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /no XSUAA instance bound/i);
});

test('production startup rejects SQLite, mocked authentication, and missing ABAP bindings', () => {
  const production = {
    profiles: ['production'],
    env: {
      ABAP_DESTINATION_NAME: 'CREDIT_GUARD_ABAP',
      CREDIT_GUARD_AGENT_DATA_SOURCE: 'abap'
    },
    dbKind: 'hana',
    authKind: 'xsuaa'
  };
  assert.throws(() => validateProductionBindings({ ...production, dbKind: 'sqlite' }), /must use.*HANA/i);
  assert.throws(() => validateProductionBindings({ ...production, authKind: 'mocked' }), /must use.*XSUAA/i);
  assert.throws(() => validateProductionBindings(production), /Missing required production service bindings/i);
  assert.throws(() => validateProductionBindings({
    ...production,
    env: {
      ...production.env,
      CREDIT_GUARD_SYNTHETIC_DEMO: 'true',
      VCAP_SERVICES: JSON.stringify({
        hana: [{}], xsuaa: [{}], destination: [{}], jobscheduler: [{}]
      })
    }
  }), /cannot be enabled with the ABAP data source/i);

  assert.throws(() => validateProductionBindings({
    ...production,
    env: {
      ...production.env,
      VCAP_SERVICES: JSON.stringify({ hana: [{}], xsuaa: [{}], jobscheduler: [{}] })
    }
  }), /Missing required production service bindings \(destination\)/i);
});

test('production startup permits explicitly opted-in HANA synthetic demo without ABAP binding', () => {
  const result = validateProductionBindings({
    profiles: ['production'],
    dbKind: 'hana',
    authKind: 'xsuaa',
    env: {
      CREDIT_GUARD_AGENT_DATA_SOURCE: 'local',
      CREDIT_GUARD_SYNTHETIC_DEMO: 'true',
      VCAP_SERVICES: JSON.stringify({
        hana: [{}],
        xsuaa: [{}],
        jobscheduler: [{}]
      })
    }
  });
  assert.deepEqual(result, { production: true });

  for (const optIn of [undefined, 'false', 'TRUE']) {
    const env = {
      CREDIT_GUARD_AGENT_DATA_SOURCE: 'local',
      VCAP_SERVICES: JSON.stringify({ hana: [{}], xsuaa: [{}], jobscheduler: [{}] })
    };
    if (optIn !== undefined) env.CREDIT_GUARD_SYNTHETIC_DEMO = optIn;
    assert.throws(() => validateProductionBindings({
      profiles: ['production'],
      dbKind: 'hana',
      authKind: 'xsuaa',
      env
    }), /CREDIT_GUARD_SYNTHETIC_DEMO=true/i);
  }
});

test('production startup requires HANA, XSUAA, Destination, and Job Scheduler bindings in ABAP mode', () => {
  const result = validateProductionBindings({
    profiles: ['production'],
    dbKind: 'hana',
    authKind: 'xsuaa',
    env: {
      ABAP_DESTINATION_NAME: 'CREDIT_GUARD_ABAP',
      CREDIT_GUARD_AGENT_DATA_SOURCE: 'abap',
      VCAP_SERVICES: JSON.stringify({
        hana: [{}],
        xsuaa: [{}],
        destination: [{}],
        jobscheduler: [{}]
      })
    }
  });
  assert.deepEqual(result, { production: true });
});

test('MTA selects explicit HANA synthetic demo mode and includes HDI table data generation', () => {
  const mta = yaml.parse(readFileSync(path.join(root, 'mta.yaml'), 'utf8'));
  const server = mta.modules.find(module => module.name === 'credit-guard-srv');
  assert.equal(server.properties.CDS_ENV, 'production');
  assert.equal(server.properties.CREDIT_GUARD_AGENT_DATA_SOURCE, 'local');
  assert.equal(server.properties.CREDIT_GUARD_SYNTHETIC_DEMO, 'true');
  assert.equal(server.properties.ABAP_DESTINATION_NAME, undefined);
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['build:cf'], /contentHdbtabledata=true/);
});

test('App Router protects application routes and exposes only health routes anonymously', () => {
  const routerPackage = JSON.parse(readFileSync(path.join(root, 'approuter', 'package.json'), 'utf8'));
  assert.equal(routerPackage.dependencies['@sap/approuter'], '^23.4.0');
  assert.equal(routerPackage.engines.node, '^22.0.0');
  const routerLock = JSON.parse(readFileSync(path.join(root, 'approuter', 'package-lock.json'), 'utf8'));
  assert.equal(routerLock.packages[''].engines.node, routerPackage.engines.node);
  const appRouter = JSON.parse(readFileSync(path.join(root, 'approuter', 'xs-app.json'), 'utf8'));
  assert.equal(appRouter.logout.logoutEndpoint, '/logout');
  assert.equal(appRouter.logout.logoutPage, '/');
  const health = appRouter.routes.find(route => route.source.startsWith('^/health/'));
  const application = appRouter.routes.find(route => route.source === '^/(.*)$');
  assert.equal(health.authenticationType, 'none');
  assert.equal(application.authenticationType, 'xsuaa');
  assert.equal(application.csrfProtection, true);

  const mta = yaml.parse(readFileSync(path.join(root, 'mta.yaml'), 'utf8'));
  assert.equal(mta.ID, 'credit-guard');
  assert.ok(mta.modules.some(module => module.name === 'credit-guard-srv' && module.path === 'gen/srv'));
  assert.ok(mta.modules.some(module => module.name === 'credit-guard-db-deployer' && module.path === 'gen/db'));
  for (const binding of [
    'credit-guard-db',
    'credit-guard-xsuaa',
    'credit-guard-destination',
    'credit-guard-job-scheduler'
  ]) {
    assert.ok(mta.resources.some(resource => resource.name === binding));
  }
  const server = mta.modules.find(module => module.name === 'credit-guard-srv');
  assert.equal(server.parameters['health-check-http-endpoint'], '/health/ready');
  assert.equal(server.properties.CREDIT_GUARD_AGENT_DATA_SOURCE, 'local');
  assert.equal(server.properties.CREDIT_GUARD_SYNTHETIC_DEMO, 'true');
  assert.equal(server.properties.MONITORING_WORKER_DRAIN_TIMEOUT_MS, '8000');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.node, routerPackage.engines.node);
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
  assert.match(packageJson.scripts['build:cf'], /contentHdbtabledata=true/);
  assert.match(packageJson.scripts['build:cf'], /cpSync\('app\/credit','gen\/srv\/app\/credit'/);
});
