const cds = require('@sap/cds');

const REQUIRED_HANA_ENV_KEYS = Object.freeze([
  'HANA_HOST',
  'HANA_PORT',
  'HANA_USER',
  'HANA_PASSWORD',
  'HANA_SCHEMA'
]);

function parseVcapHanaCredentials(env = process.env) {
  if (!env.VCAP_SERVICES) return null;
  try {
    const parsed = JSON.parse(env.VCAP_SERVICES);
    const hanaBinding = (parsed.hana || parsed['hana-cloud'] || [])[0];
    if (!hanaBinding || !hanaBinding.credentials) return null;
    const creds = hanaBinding.credentials;
    if (!creds.host || !creds.port || !creds.user || !creds.password) return null;
    return {
      host: String(creds.host).trim(),
      port: Number(creds.port) || 443,
      user: String(creds.user).trim(),
      password: String(creds.password),
      schema: String(creds.schema || env.HANA_SCHEMA || 'USR_CREDIT_GUARD').trim(),
      encrypt: creds.encrypt !== false,
      sslValidateCertificate: creds.sslValidateCertificate !== false,
      bindingSource: 'VCAP_SERVICES'
    };
  } catch {
    return null;
  }
}

function resolveDatabaseConfig(env = process.env) {
  const vcap = parseVcapHanaCredentials(env);
  if (vcap) {
    return {
      mode: 'HANA_CLOUD',
      driver: '@cap-js/hana',
      configured: true,
      bindingSource: 'VCAP_SERVICES',
      host: vcap.host,
      port: vcap.port,
      schema: vcap.schema,
      encrypt: vcap.encrypt,
      credentials: {
        host: vcap.host,
        port: vcap.port,
        user: vcap.user,
        password: vcap.password,
        schema: vcap.schema,
        encrypt: vcap.encrypt,
        sslValidateCertificate: vcap.sslValidateCertificate
      }
    };
  }

  const host = typeof env.HANA_HOST === 'string' ? env.HANA_HOST.trim() : '';
  const portRaw = typeof env.HANA_PORT === 'string' ? env.HANA_PORT.trim() : '';
  const user = typeof env.HANA_USER === 'string' ? env.HANA_USER.trim() : '';
  const password = typeof env.HANA_PASSWORD === 'string' ? env.HANA_PASSWORD : '';
  const schema = typeof env.HANA_SCHEMA === 'string' && env.HANA_SCHEMA.trim()
    ? env.HANA_SCHEMA.trim()
    : 'CREDIT_GUARD_HDI';
  const encrypt = String(env.HANA_ENCRYPT ?? 'true').toLowerCase() !== 'false';

  const hasAllEnvVars = Boolean(host && portRaw && user && password);
  if (hasAllEnvVars) {
    const port = Number(portRaw) || 443;
    return {
      mode: 'HANA_CLOUD',
      driver: '@cap-js/hana',
      configured: true,
      bindingSource: 'ENV:HANA_HOST',
      host,
      port,
      schema,
      encrypt,
      credentials: {
        host,
        port,
        user,
        password,
        schema,
        encrypt,
        sslValidateCertificate: String(env.HANA_SSL_VALIDATE ?? 'true').toLowerCase() !== 'false'
      }
    };
  }

  const missingEnvVars = REQUIRED_HANA_ENV_KEYS.filter(key => {
    const val = env[key];
    return typeof val !== 'string' || !val.trim();
  });

  return {
    mode: 'SQLITE_FALLBACK',
    driver: '@cap-js/sqlite',
    configured: false,
    bindingSource: 'LOCAL_SQLITE_MEMORY',
    host: 'localhost',
    port: null,
    schema: 'credit',
    encrypt: false,
    missingEnvVars,
    credentials: null
  };
}

function getPublicDatabaseStatus(env = process.env) {
  const resolved = resolveDatabaseConfig(env);
  return {
    mode: resolved.mode,
    driver: resolved.driver,
    hanaConfigured: resolved.configured,
    bindingSource: resolved.bindingSource,
    host: resolved.configured ? resolved.host : null,
    port: resolved.configured ? resolved.port : null,
    schema: resolved.schema,
    encrypt: resolved.encrypt,
    missingEnvVars: resolved.missingEnvVars || []
  };
}

function getDatabaseHandle(explicitDb) {
  const db = explicitDb || cds.db;
  if (!db) {
    throw new Error('CAP database handle (cds.db) is not initialized.');
  }
  return db;
}

module.exports = {
  REQUIRED_HANA_ENV_KEYS,
  getDatabaseHandle,
  getPublicDatabaseStatus,
  resolveDatabaseConfig
};
