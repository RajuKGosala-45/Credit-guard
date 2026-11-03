const REQUIRED_PRODUCTION_BINDINGS = ['hana', 'xsuaa', 'destination'];

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
  if (env.CREDIT_GUARD_AGENT_DATA_SOURCE !== 'abap') {
    throw new Error('Production must use the configured ABAP customer data provider; refusing to start.');
  }
  if (!env.ABAP_DESTINATION_NAME?.trim()) {
    throw new Error('ABAP_DESTINATION_NAME must be configured in production; refusing to start.');
  }

  const bindings = parseBindings(env);
  const labels = new Set(Object.keys(bindings).map(label => label.toLowerCase()));
  const missing = REQUIRED_PRODUCTION_BINDINGS.filter(label => !labels.has(label));
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
