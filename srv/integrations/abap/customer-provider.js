const creditService = require('../../creditService');

function createAgentCustomerProvider({
  db,
  user,
  source = process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local',
  abapClient
} = {}) {
  if (source === 'abap') {
    if (!abapClient) throw new Error('The ABAP customer provider requires an ABAP client.');
    return {
      source,
      getCustomer: customerId => abapClient.getCreditExposure(customerId),
      listCustomers: () => abapClient.listCustomerAnalyses()
    };
  }
  if (source === 'local') {
    return {
      source,
      getCustomer: customerId => creditService.getCustomerDetail(db, user, customerId),
      listCustomers: () => creditService.getCustomerSummaries(db, user)
    };
  }
  const error = new Error('CREDIT_GUARD_AGENT_DATA_SOURCE must be local or abap.');
  error.statusCode = 500;
  throw error;
}

module.exports = { createAgentCustomerProvider };
