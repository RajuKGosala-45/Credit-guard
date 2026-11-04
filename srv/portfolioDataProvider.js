const creditService = require('./creditService');
const { classifyCustomer } = require('./rules');
const { AbapClient } = require('./integrations/abap/client');
const { createAgentCustomerProvider } = require('./integrations/abap/customer-provider');

function assertReader(user) {
  if (!user || user._is_anonymous || user._is_privileged || !user.id || !user.is?.('CreditReader')) {
    const error = new Error('The authenticated user does not have permission to read credit data.');
    error.statusCode = user?.id ? 403 : 401;
    throw error;
  }
}

function normalizeAbapAnalysis(record) {
  return {
    ...record.analysis,
    currency: record.customer.currency,
    source: record.source,
    retrievedAt: record.retrievedAt
  };
}

function createPortfolioDataProvider({
  db,
  user,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient
} = {}) {
  assertReader(user);
  const selectedAbapClient = source === 'abap' ? abapClient || new AbapClient() : abapClient;
  const provider = createAgentCustomerProvider({
    db,
    user,
    source,
    abapClient: selectedAbapClient
  });
  return {
    source: provider.source,
    async listCustomers(options) {
      const records = await provider.listCustomers(options);
      return provider.source === 'abap' ? records.map(normalizeAbapAnalysis) : records;
    },
    async getCustomer(customerId) {
      if (provider.source === 'local') return provider.getCustomer(customerId);
      const result = await provider.getCustomer(customerId);
      const analysis = classifyCustomer(result.customer, result.openItems, new Date(), true);
      return {
        ...analysis,
        source: result.source,
        retrievedAt: result.retrievedAt,
        openItems: analysis.itemAnalysis
      };
    }
  };
}

module.exports = {
  createPortfolioDataProvider,
  normalizeAbapAnalysis
};
