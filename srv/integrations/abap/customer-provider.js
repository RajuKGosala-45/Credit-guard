const creditService = require('../../creditService');
const { getConfiguredDataSource } = require('../../dataSource');

function createAgentCustomerProvider({
  db,
  user,
  source = getConfiguredDataSource(),
  abapClient
} = {}) {
  if (source === 'abap') {
    if (!abapClient) throw new Error('The ABAP customer provider requires an ABAP client.');
    return {
      source,
      getCustomer: customerId => abapClient.getCreditExposure(customerId),
      listCustomers: options => abapClient.listCustomerAnalyses(options)
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
