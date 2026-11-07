function getConfiguredDataSource() {
  return process.env.CREDIT_GUARD_AGENT_DATA_SOURCE || 'local';
}

function isAbapReadOnlySource(source = getConfiguredDataSource()) {
  return source === 'abap';
}

function assertCreditLimitWorkflowAvailable(source = getConfiguredDataSource()) {
  if (!isAbapReadOnlySource(source)) return;
  const error = new Error(
    'Credit-limit requests and approvals are unavailable while SAP customer data is connected in read-only mode.'
  );
  error.statusCode = 409;
  throw error;
}

module.exports = {
  assertCreditLimitWorkflowAvailable,
  getConfiguredDataSource,
  isAbapReadOnlySource
};
