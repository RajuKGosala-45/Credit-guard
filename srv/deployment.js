const REQUIRED_PRODUCTION_BINDINGS = ['hana', 'xsuaa'];

function isProductionProfile(profiles = []) {
  return profiles.includes('production');
}

function parseBindings(env = process.env) {
  if (!env.VCAP_SERVICES) return {};
  try {
    return JSON.parse(env.VCAP_SERVICES);
  } catch {
    throw new Error('Production service bindings are malformed; refusing to start.');
  }
}

function validateProductionBindings({ profiles = [], env = process.env, dbKind, authKind } = {}) {
  if (!isProductionProfile(profiles)) return { production: false };

  if (dbKind !== 'hana') {
    throw new Error('Production must use the configured HANA database; refusing to start.');
  }
  if (authKind !== 'xsuaa') {
    throw new Error('Production must use the configured XSUAA authentication; refusing to start.');
  }
  const dataSource = env.CREDIT_GUARD_AGENT_DATA_SOURCE;
  const syntheticDemoOptIn = env.CREDIT_GUARD_SYNTHETIC_DEMO === 'true';
  if (!['local', 'abap'].includes(dataSource)) {
    throw new Error('Production data source must be explicitly set to local or abap; refusing to start.');
  }
  if (dataSource === 'local' && !syntheticDemoOptIn) {
    throw new Error('Production local data requires CREDIT_GUARD_SYNTHETIC_DEMO=true; refusing to start.');
  }
  if (dataSource === 'abap' && syntheticDemoOptIn) {
    throw new Error('CREDIT_GUARD_SYNTHETIC_DEMO cannot be enabled with the ABAP data source; refusing to start.');
  }
  if (dataSource === 'abap' && !env.ABAP_DESTINATION_NAME?.trim()) {
    throw new Error('ABAP_DESTINATION_NAME must be configured in ABAP production mode; refusing to start.');
  }

  const bindings = parseBindings(env);
  const labels = new Set(Object.keys(bindings).map(label => label.toLowerCase()));
  const requiredBindings = dataSource === 'abap'
    ? [...REQUIRED_PRODUCTION_BINDINGS, 'destination']
    : REQUIRED_PRODUCTION_BINDINGS;
  const missing = requiredBindings.filter(label => !labels.has(label));
  if (missing.length) {
    throw new Error(`Missing required production service bindings (${missing.join(', ')}); refusing to start.`);
  }

  return { production: true };
}

module.exports = {
  REQUIRED_PRODUCTION_BINDINGS,
  isProductionProfile,
  validateProductionBindings
};
