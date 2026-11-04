const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { classifyCustomer, validateUniqueItemOwners } = require('../../rules');

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._-]{1,12}$/;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10000;

class AbapIntegrationError extends Error {
  constructor(message, { category, statusCode = 503, cause } = {}) {
    super(message, { cause });
    this.name = 'AbapIntegrationError';
    this.category = category || 'abap_unavailable';
    this.statusCode = statusCode;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCollection(data) {
  if (Array.isArray(data)) return { rows: data, nextLink: null };
  if (!isRecord(data)) {
    throw new AbapIntegrationError('The ABAP service returned an invalid collection response.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  const rows = Array.isArray(data.value)
    ? data.value
    : Array.isArray(data.d?.results) ? data.d.results : null;
  if (!rows) {
    throw new AbapIntegrationError('The ABAP service response is missing its collection.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return {
    rows,
    nextLink: data['@odata.nextLink'] || data['odata.nextLink'] || data.d?.__next || null
  };
}

function validatePath(value, settingName) {
  if (typeof value !== 'string' || !value.trim() || /^https?:\/\//i.test(value) || value.startsWith('//')) {
    throw new AbapIntegrationError(`${settingName} must be a relative path on the configured ABAP destination.`, {
      category: 'abap_configuration',
      statusCode: 503
    });
  }
  return value.replace(/^\/+/, '');
}

function validateCustomerId(customerId) {
  if (typeof customerId !== 'string' || !CUSTOMER_ID_PATTERN.test(customerId)) {
    const error = new TypeError('Customer ID must contain 1-12 letters, digits, dots, underscores, or hyphens.');
    error.statusCode = 400;
    throw error;
  }
  return customerId;
}

function requiredString(value, field, recordName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AbapIntegrationError(`The ABAP ${recordName} response is missing ${field}.`, {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return value.trim();
}

function optionalDate(value, field, recordName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new AbapIntegrationError(`The ABAP ${recordName} response has an invalid ${field}.`, {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return value;
}

function normalizeCustomer(record) {
  if (!isRecord(record)) {
    throw new AbapIntegrationError('The ABAP customer response contains an invalid record.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  const customer = {
    ID: validateCustomerId(requiredString(record.CustomerId, 'CustomerId', 'customer')),
    name: requiredString(record.CustomerName, 'CustomerName', 'customer'),
    country: record.Country || null,
    companyCode: record.CompanyCode || null,
    riskClass: record.RiskClass || null,
    creditLimit: record.CreditLimit,
    currency: record.Currency ? requiredString(record.Currency, 'Currency', 'customer').toUpperCase() : null,
    lastReviewDate: optionalDate(record.ReviewDate, 'ReviewDate', 'customer')
  };
  if (customer.creditLimit !== undefined && customer.creditLimit !== null) {
    const creditLimit = Number(customer.creditLimit);
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      throw new AbapIntegrationError('The ABAP customer response has an invalid CreditLimit.', {
        category: 'abap_invalid_response',
        statusCode: 502
      });
    }
    customer.creditLimit = creditLimit;
  }
  if (customer.currency && !/^[A-Z]{3}$/.test(customer.currency)) {
    throw new AbapIntegrationError('The ABAP customer response has an invalid Currency.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return customer;
}

function normalizeOpenItem(record, customerId) {
  if (!isRecord(record)) {
    throw new AbapIntegrationError('The ABAP open-item response contains an invalid record.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  const item = {
    ID: requiredString(record.OpenItemId, 'OpenItemId', 'open-item'),
    customer_ID: validateCustomerId(requiredString(record.CustomerId, 'CustomerId', 'open-item')),
    type: requiredString(record.Type, 'Type', 'open-item'),
    amount: record.Amount,
    currency: requiredString(record.Currency, 'Currency', 'open-item').toUpperCase(),
    dueDate: optionalDate(record.DueDate, 'DueDate', 'open-item'),
    status: requiredString(record.Status, 'Status', 'open-item')
  };
  if (item.ID.length > 12) {
    throw new AbapIntegrationError('The ABAP open-item identifier exceeds the Credit Guard key length.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  if (item.customer_ID !== customerId) {
    throw new AbapIntegrationError('The ABAP open-item response returned a different customer.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  const amount = Number(item.amount);
  if (item.amount === undefined || item.amount === null
    || (typeof item.amount === 'string' && !item.amount.trim())
    || !Number.isFinite(amount)) {
    throw new AbapIntegrationError('The ABAP open-item response has a missing or invalid Amount.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  item.amount = amount;
  if (!/^[A-Z]{3}$/.test(item.currency)) {
    throw new AbapIntegrationError('The ABAP open-item response has an invalid Currency.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return item;
}

function safeHttpError(error) {
  const status = error?.response?.status;
  const code = error?.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')) {
    return new AbapIntegrationError('The ABAP service request timed out.', {
      category: 'abap_timeout',
      statusCode: 504,
      cause: error
    });
  }
  if (status === 401 || status === 403) {
    return new AbapIntegrationError('The ABAP destination is not authorized for this read operation.', {
      category: 'abap_unauthorized',
      statusCode: 502,
      cause: error
    });
  }
  if (status === 404) {
    return new AbapIntegrationError('The configured ABAP service endpoint is unavailable.', {
      category: 'abap_endpoint_unavailable',
      statusCode: 503,
      cause: error
    });
  }
  return new AbapIntegrationError('The ABAP service is currently unavailable.', {
    category: 'abap_unavailable',
    statusCode: status === 429 || status >= 500 ? 503 : 502,
    cause: error
  });
}

function validateNextLink(nextLink, destination) {
  let destinationUrl;
  let nextUrl;
  try {
    destinationUrl = new URL(destination.url);
    nextUrl = new URL(nextLink, destinationUrl);
  } catch (error) {
    throw new AbapIntegrationError('The ABAP service returned an invalid pagination link.', {
      category: 'abap_invalid_response',
      statusCode: 502,
      cause: error
    });
  }
  const serviceBasePath = destinationUrl.pathname.replace(/\/+$/, '');
  if (nextUrl.origin !== destinationUrl.origin
    || (serviceBasePath && nextUrl.pathname !== serviceBasePath
      && !nextUrl.pathname.startsWith(`${serviceBasePath}/`))) {
    throw new AbapIntegrationError('The ABAP service returned a pagination link outside its configured destination.', {
      category: 'abap_invalid_response',
      statusCode: 502
    });
  }
  return nextUrl.href;
}

class AbapClient {
  constructor({
    destinationName = process.env.ABAP_DESTINATION_NAME || 'CREDIT_GUARD_ABAP',
    customersPath = process.env.ABAP_CUSTOMERS_PATH || 'Customers',
    openItemsPath = process.env.ABAP_OPEN_ITEMS_PATH || 'OpenItems',
    timeoutMs = Number(process.env.ABAP_HTTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxPages = Number(process.env.ABAP_MAX_PAGES) || DEFAULT_MAX_PAGES,
    pageSize = Number(process.env.ABAP_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
    destinationResolver = getDestination,
    httpRequest = executeHttpRequest,
    logger = cds.log('abap-integration'),
    now = () => new Date()
  } = {}) {
    this.destinationName = destinationName;
    this.customersPath = validatePath(customersPath, 'ABAP_CUSTOMERS_PATH');
    this.openItemsPath = validatePath(openItemsPath, 'ABAP_OPEN_ITEMS_PATH');
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;
    this.pageSize = pageSize;
    this.destinationResolver = destinationResolver;
    this.httpRequest = httpRequest;
    this.logger = logger;
    this.now = now;
  }

  async resolveDestination() {
    if (!this.destinationName) {
      throw new AbapIntegrationError('ABAP_DESTINATION_NAME is not configured.', {
        category: 'abap_configuration',
        statusCode: 503
      });
    }
    let destination;
    try {
      destination = await this.destinationResolver({ destinationName: this.destinationName });
    } catch (error) {
      this.logFailure('destination_lookup', error);
      throw new AbapIntegrationError('The ABAP destination is unavailable.', {
        category: 'abap_destination_unavailable',
        statusCode: 503,
        cause: error
      });
    }
    if (!destination?.url) {
      throw new AbapIntegrationError('The ABAP destination is unavailable.', {
        category: 'abap_destination_unavailable',
        statusCode: 503
      });
    }
    return destination;
  }

  async request(destination, config, operation, { signal, deadlineAt } = {}) {
    if (signal?.aborted) throw signal.reason || new AbapIntegrationError('ABAP request was cancelled.', {
      category: 'abap_cancelled',
      statusCode: 503
    });
    const remainingMs = deadlineAt === undefined ? this.timeoutMs : deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new AbapIntegrationError('The monitoring execution deadline expired.', {
        category: 'monitoring_deadline_exceeded',
        statusCode: 504
      });
    }
    const startedAt = Date.now();
    try {
      const response = await this.httpRequest(destination, {
        method: 'get',
        timeout: Math.min(this.timeoutMs, remainingMs),
        signal,
        headers: { accept: 'application/json' },
        ...config
      });
      this.logger.info({
        event: 'abap_request',
        operation,
        statusCode: response?.status || 200,
        durationMs: Date.now() - startedAt
      });
      return response?.data;
    } catch (error) {
      const safeError = safeHttpError(error);
      this.logger.warn({
        event: 'abap_request_failed',
        operation,
        category: safeError.category,
        statusCode: error?.response?.status,
        durationMs: Date.now() - startedAt
      });
      throw safeError;
    }
  }

  logFailure(operation, error) {
    this.logger.warn({
      event: 'abap_request_failed',
      operation,
      category: error?.category || 'abap_destination_unavailable'
    });
  }

  async readCollection(path, params, operation, { signal, deadlineAt } = {}) {
    const destination = await this.resolveDestination();
    const rows = [];
    let nextLink;
    let config = { url: path, params };
    for (let page = 0; page < this.maxPages; page += 1) {
      if (signal?.aborted) throw signal.reason || new AbapIntegrationError('ABAP request was cancelled.', {
        category: 'abap_cancelled',
        statusCode: 503
      });
      if (deadlineAt !== undefined && deadlineAt - Date.now() <= 0) {
        throw new AbapIntegrationError('The monitoring execution deadline expired.', {
          category: 'monitoring_deadline_exceeded',
          statusCode: 504
        });
      }
      const data = await this.request(destination, config, operation, { signal, deadlineAt });
      const result = normalizeCollection(data);
      rows.push(...result.rows);
      nextLink = result.nextLink;
      if (!nextLink) return rows;
      config = { url: validateNextLink(nextLink, destination), params: undefined };
    }
    if (nextLink) {
      throw new AbapIntegrationError('The ABAP service exceeded the configured pagination limit.', {
        category: 'abap_pagination_limit',
        statusCode: 502
      });
    }
    return rows;
  }

  async searchCustomer(customerId) {
    const id = validateCustomerId(customerId);
    const escaped = id.replace(/'/g, "''");
    const rows = await this.readCollection(
      this.customersPath,
      { '$filter': `CustomerId eq '${escaped}'`, '$top': 1 },
      'search_customer'
    );
    const matching = rows.filter(row => row?.CustomerId === id);
    if (!matching.length) {
      throw new AbapIntegrationError(`Customer ${id} was not found in the configured ABAP service.`, {
        category: 'abap_customer_not_found',
        statusCode: 404
      });
    }
    if (matching.length !== 1) {
      throw new AbapIntegrationError('The ABAP service returned duplicate customer identifiers.', {
        category: 'abap_invalid_response',
        statusCode: 502
      });
    }
    return normalizeCustomer(matching[0]);
  }

  async listCustomers(options = {}) {
    const rows = await this.readCollection(
      this.customersPath,
      { '$top': this.pageSize },
      'list_customers',
      options
    );
    const customers = rows.map(normalizeCustomer);
    const ids = new Set();
    for (const customer of customers) {
      if (ids.has(customer.ID)) {
        throw new AbapIntegrationError('The ABAP service returned duplicate customer identifiers.', {
          category: 'abap_invalid_response',
          statusCode: 502
        });
      }
      ids.add(customer.ID);
    }
    return customers;
  }

  async getOpenItems(customerId) {
    const id = validateCustomerId(customerId);
    const escaped = id.replace(/'/g, "''");
    const rows = await this.readCollection(
      this.openItemsPath,
      { '$filter': `CustomerId eq '${escaped}'`, '$top': this.pageSize },
      'get_open_items'
    );
    return rows.map(row => normalizeOpenItem(row, id));
  }

  async getCustomerDetails(customerId) {
    const customer = await this.searchCustomer(customerId);
    const openItems = await this.getOpenItems(customer.ID);
    const retrievedAt = this.now().toISOString();
    const currency = customer.currency;
    const itemCurrencies = new Set(openItems.map(item => item.currency));
    if (currency && [...itemCurrencies].some(itemCurrency => itemCurrency !== currency)) {
      throw new AbapIntegrationError('ABAP limit and open-item currencies do not match; exposure was not calculated.', {
        category: 'abap_currency_mismatch',
        statusCode: 502
      });
    }
    return {
      source: 'ABAP Environment via BTP Destination service',
      retrievedAt,
      customer,
      openItems
    };
  }

  async getCreditExposure(customerId) {
    const details = await this.getCustomerDetails(customerId);
    if (!Number.isFinite(details.customer.creditLimit) || !details.customer.currency) {
      throw new AbapIntegrationError('The ABAP service has not provided the credit limit and currency required for analysis.', {
        category: 'abap_credit_data_unavailable',
        statusCode: 503
      });
    }
    const classified = classifyCustomer({
      ...details.customer,
      creditLimit: details.customer.creditLimit,
      lastReviewDate: details.customer.lastReviewDate || ''
    }, details.openItems, this.now());
    return {
      ...details,
      analysisBasis: 'Existing Credit Guard rules applied to the configured ABAP open-item response.',
      analysis: classified
    };
  }

  async listCustomerAnalyses(options = {}) {
    const { signal, deadlineAt } = options;
    const customers = await this.listCustomers(options);
    const rows = await this.readCollection(
      this.openItemsPath,
      { '$top': this.pageSize },
      'list_open_items',
      { signal, deadlineAt }
    );
    const openItems = rows.map(record => {
      const customerId = validateCustomerId(requiredString(record?.CustomerId, 'CustomerId', 'open-item'));
      return normalizeOpenItem(record, customerId);
    });
    try {
      validateUniqueItemOwners(openItems);
    } catch (error) {
      throw new AbapIntegrationError('The ABAP service assigned an open-item identifier to multiple customers.', {
        category: 'abap_invalid_response',
        statusCode: 502,
        cause: error
      });
    }
    const itemsByCustomer = new Map(customers.map(customer => [customer.ID, []]));
    for (const item of openItems) {
      const items = itemsByCustomer.get(item.customer_ID);
      if (!items) {
        throw new AbapIntegrationError('The ABAP service returned an open item for an unknown customer.', {
          category: 'abap_invalid_response',
          statusCode: 502
        });
      }
      items.push(item);
    }
    const retrievedAt = this.now().toISOString();
    return customers.map(customer => {
      if (!Number.isFinite(customer.creditLimit) || !customer.currency) {
        throw new AbapIntegrationError('The ABAP service has not provided the credit limit and currency required for analysis.', {
          category: 'abap_credit_data_unavailable',
          statusCode: 503
        });
      }
      const customerItems = itemsByCustomer.get(customer.ID);
      if (customerItems.some(item => item.currency !== customer.currency)) {
        throw new AbapIntegrationError('ABAP limit and open-item currencies do not match; exposure was not calculated.', {
          category: 'abap_currency_mismatch',
          statusCode: 502
        });
      }
      return {
        source: 'ABAP Environment via BTP Destination service',
        retrievedAt,
        customer,
        openItems: customerItems,
        analysisBasis: 'Existing Credit Guard rules applied to the configured ABAP open-item response.',
        analysis: classifyCustomer({
          ...customer,
          lastReviewDate: customer.lastReviewDate || ''
        }, customerItems, this.now())
      };
    });
  }
}

module.exports = {
  AbapClient,
  AbapIntegrationError,
  normalizeCollection,
  normalizeCustomer,
  normalizeOpenItem,
  safeHttpError,
  validateCustomerId,
  validateNextLink
};
