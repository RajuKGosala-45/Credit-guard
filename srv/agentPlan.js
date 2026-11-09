const PLAN_VERSION = 1;
const MAX_PLAN_TASKS = 12;
const MAX_TEXT_LENGTH = 500;
const MAX_RESULT_SOURCE_LENGTH = 120;
const MAX_ERROR_CATEGORY_LENGTH = 40;

const TASK_STATUSES = Object.freeze([
  'PENDING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'SKIPPED'
]);
const PLAN_STATUSES = Object.freeze([
  'DRAFT',
  'VALIDATED',
  'IN_PROGRESS',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'BLOCKED',
  'FAILED',
  'REJECTED'
]);
const TASK_RESULT_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED']);
const PROPOSAL_TOOL_NAMES = new Set(['prepare_limit_change']);
const TOOL_RESULT_FIELDS = Object.freeze({
  searchAbapCustomer: ['source', 'retrievedAt', 'customer'],
  getAbapCustomerDetails: ['source', 'retrievedAt', 'customer', 'openItems'],
  getAbapCreditExposure: ['source', 'retrievedAt', 'customer', 'openItems', 'analysisBasis', 'analysis'],
  getAbapOpenItems: ['source', 'retrievedAt', 'customerId', 'currency', 'openItems'],
  analyzeAbapCreditRisk: ['source', 'retrievedAt', 'customer', 'openItems', 'analysisBasis', 'analysis'],
  list_customers_over_threshold: [
    'ID', 'name', 'country', 'companyCode', 'exposure', 'creditLimit', 'availableCredit',
    'utilisation', 'overdueAmount', 'overdueShare', 'overdueInvoiceCount', 'status',
    'riskClass', 'flags', 'currency', 'source', 'retrievedAt'
  ],
  search_customers: ['ID', 'name', 'country', 'companyCode'],
  get_customer: [
    'ID', 'name', 'country', 'companyCode', 'exposure', 'creditLimit', 'availableCredit',
    'utilisation', 'overdueAmount', 'overdueShare', 'overdueInvoiceCount', 'status',
    'riskClass', 'flags', 'currency', 'source', 'retrievedAt', 'openItems', 'payments'
  ],
  exposure_by: ['label', 'currency', 'exposure', 'creditLimit', 'customers', 'utilisation'],
  get_monitoring_analysis: ['runId', 'status', 'summary', 'findings'],
  list_limit_requests: [
    'ID', 'customer_ID', 'currentLimit', 'requestedLimit', 'reason', 'requestedBy',
    'status', 'approverLevel', 'createdAt', 'decidedBy', 'customerName'
  ],
  get_portfolio_summary: [
    'source', 'retrievedAt', 'portfolio', 'exposureByCountry', 'exposureByCompanyCode',
    'exposureByCustomer', 'customers'
  ],
  get_customer_approval_history: ['source', 'retrievedAt', 'customerId', 'requests'],
  get_monitoring_alerts: ['source', 'retrievedAt', 'status', 'alerts'],
  get_data_ingestion_status: ['source', 'retrievedAt', 'sources', 'syntheticMockSapFixture'],
  get_mock_sap_records: ['source', 'retrievedAt', 'entityType', 'records'],
  preview_credit_workflow: [
    'workflowId', 'name', 'source', 'executionAvailable', 'requiresHumanConfirmation',
    'status', 'limitations', 'steps', 'retrievedAt'
  ],
  prepare_limit_change: ['requiresHumanApproval', 'proposal']
});

function assertExactKeys(value, required, optional = [], label = 'Object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains an unsupported field: ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}.`);
  }
}

function assertText(value, label, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be non-empty text of at most ${maxLength} characters.`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
}

function assertStringArray(value, label, pattern = null) {
  if (!Array.isArray(value) || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 80
      || (pattern && !pattern.test(item)))) {
    throw new TypeError(`${label} must be an array of valid strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} must not contain duplicates.`);
  }
}

function validateTask(task, toolMap, taskIds) {
  assertExactKeys(task, [
    'taskId',
    'description',
    'toolName',
    'toolInput',
    'dependencies',
    'taskType',
    'requiredInputs',
    'completionCriteria',
    'status',
    'attemptCount'
  ], ['startedAt', 'completedAt'], 'Task');
  assertIdentifier(task.taskId, 'Task ID');
  if (taskIds.has(task.taskId)) throw new TypeError(`Duplicate task ID: ${task.taskId}.`);
  taskIds.add(task.taskId);
  assertText(task.description, 'Task description');

  const tool = toolMap.get(task.toolName);
  if (!tool) throw new TypeError(`Unknown tool name: ${task.toolName}.`);
  if (task.taskType !== 'READ_ONLY' && task.taskType !== 'PROPOSAL') {
    throw new TypeError(`Task ${task.taskId} has an invalid task type.`);
  }
  const isProposalTool = PROPOSAL_TOOL_NAMES.has(task.toolName);
  if ((task.taskType === 'PROPOSAL') !== isProposalTool) {
    throw new TypeError(`Task ${task.taskId} has a task type that does not match its tool.`);
  }
  if (!TASK_STATUSES.includes(task.status)) {
    throw new TypeError(`Task ${task.taskId} has an invalid status.`);
  }
  if (!Number.isSafeInteger(task.attemptCount) || task.attemptCount < 0 || task.attemptCount > MAX_PLAN_TASKS) {
    throw new TypeError(`Task ${task.taskId} has an invalid attempt count.`);
  }
  if (Object.hasOwn(task, 'startedAt')) assertTimestamp(task.startedAt, `Task ${task.taskId} startedAt`);
  if (Object.hasOwn(task, 'completedAt')) assertTimestamp(task.completedAt, `Task ${task.taskId} completedAt`);

  assertStringArray(task.dependencies, `Task ${task.taskId} dependencies`);
  task.dependencies.forEach(dependency => assertIdentifier(dependency, 'Dependency task ID'));
  if (task.dependencies.includes(task.taskId)) {
    throw new TypeError(`Task ${task.taskId} cannot depend on itself.`);
  }

  const schema = tool.input_schema;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new TypeError(`Tool ${task.toolName} has no supported input schema.`);
  }
  assertStringArray(task.requiredInputs, `Task ${task.taskId} required inputs`, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
  const inputNames = new Set(Object.keys(properties));
  if (task.requiredInputs.some(input => !inputNames.has(input))) {
    throw new TypeError(`Task ${task.taskId} declares an input not accepted by ${task.toolName}.`);
  }
  const requiredToolInputs = schema.required || [];
  if (requiredToolInputs.some(input => !task.requiredInputs.includes(input))) {
    throw new TypeError(`Task ${task.taskId} omits a required input for ${task.toolName}.`);
  }
  if (!task.toolInput || typeof task.toolInput !== 'object' || Array.isArray(task.toolInput)) {
    throw new TypeError(`Task ${task.taskId} toolInput must be an object.`);
  }
  for (const [name, value] of Object.entries(task.toolInput)) {
    const property = properties[name];
    if (!property) throw new TypeError(`Task ${task.taskId} supplies an unsupported input for ${task.toolName}.`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertExactKeys(value, ['$fromTask', 'field', 'mode'], [], `Task ${task.taskId} input reference`);
      assertIdentifier(value.$fromTask, 'Input reference task ID');
      assertText(value.field, 'Input reference field', 80);
      if (value.mode !== 'each' || !task.dependencies.includes(value.$fromTask)) {
        throw new TypeError(`Task ${task.taskId} has an invalid or undeclared input dependency.`);
      }
      if (task.taskType === 'PROPOSAL') {
        throw new TypeError('Proposal task inputs must be explicitly provided, not derived from other tasks.');
      }
      if (task.toolName !== 'get_customer' || name !== 'customer_id'
        || value.$fromTask === task.taskId) {
        throw new TypeError('Only customer detail reads may expand a customer ID from a prerequisite task.');
      }
      continue;
    }
    if (property.enum && !property.enum.includes(value)) {
      throw new TypeError(`Task ${task.taskId} has an invalid value for ${name}.`);
    }
    if (property.type === 'string' && (typeof value !== 'string' || !value.trim())) {
      throw new TypeError(`Task ${task.taskId} input ${name} must be non-empty text.`);
    }
    if (property.type === 'string' && Number.isFinite(property.maxLength) && value.length > property.maxLength) {
      throw new TypeError(`Task ${task.taskId} input ${name} exceeds its maximum length.`);
    }
    if (property.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)
      || (Number.isFinite(property.minimum) && value < property.minimum)
      || (Number.isFinite(property.maximum) && value > property.maximum)
      || (Number.isFinite(property.exclusiveMinimum) && value <= property.exclusiveMinimum))) {
      throw new TypeError(`Task ${task.taskId} input ${name} must be a finite number.`);
    }
  }
  if (requiredToolInputs.some(input => !Object.hasOwn(task.toolInput, input))) {
    throw new TypeError(`Task ${task.taskId} toolInput is missing a required input for ${task.toolName}.`);
  }

  assertExactKeys(task.completionCriteria, ['description', 'requiredFields'], [], 'Completion criteria');
  assertText(task.completionCriteria.description, 'Completion criteria description');
  assertStringArray(
    task.completionCriteria.requiredFields,
    'Completion criteria required fields',
    /^[A-Za-z][A-Za-z0-9_.]{0,79}$/
  );
  const resultFields = TOOL_RESULT_FIELDS[task.toolName];
  if (!task.completionCriteria.requiredFields.length
    || task.completionCriteria.requiredFields.some(field => !resultFields.includes(field))) {
    throw new TypeError(`Task ${task.taskId} has completion criteria unsupported by ${task.toolName}.`);
  }
}

function validateDependencies(tasks) {
  const ids = new Set(tasks.map(task => task.taskId));
  const dependencies = new Map(tasks.map(task => [task.taskId, task.dependencies]));
  const taskById = new Map(tasks.map(task => [task.taskId, task]));
  for (const task of tasks) {
    const references = Object.values(task.toolInput).filter(value =>
      value && typeof value === 'object' && Object.hasOwn(value, '$fromTask'));
    if (references.length > 1) {
      throw new TypeError(`Task ${task.taskId} may contain only one expanded input reference.`);
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new TypeError(`Task ${task.taskId} depends on nonexistent task ${dependency}.`);
      }
      const inputReferences = references.filter(value => value.$fromTask === dependency);
      if (inputReferences.some(inputReference =>
        !['list_customers_over_threshold', 'search_customers'].includes(taskById.get(dependency).toolName)
        || inputReference.field !== 'ID'
        || !taskById.get(dependency).completionCriteria.requiredFields.includes(inputReference.field))) {
        throw new TypeError(`Task ${task.taskId} references a field not guaranteed by task ${dependency}.`);
      }
    }
    if (references.some(reference => !task.dependencies.includes(reference.$fromTask))) {
      throw new TypeError(`Task ${task.taskId} has an input reference without a matching dependency.`);
    }
  }

  for (const task of tasks) {
    if (task.status === 'READY'
      && task.dependencies.some(dependency => taskById.get(dependency).status !== 'COMPLETED')) {
      throw new TypeError(`Task ${task.taskId} cannot be READY until all dependencies are COMPLETED.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) throw new TypeError('Plan tasks contain circular dependencies.');
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    dependencies.get(taskId).forEach(visit);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  tasks.forEach(task => visit(task.taskId));
}

function validatePlanStatus(planStatus, tasks) {
  if (!PLAN_STATUSES.includes(planStatus)) throw new TypeError('Plan has an invalid status.');
  const completedCount = tasks.filter(task => task.status === 'COMPLETED').length;
  if (planStatus === 'COMPLETED' && completedCount !== tasks.length) {
    throw new TypeError('A completed plan must have every task completed.');
  }
  if (planStatus === 'PARTIALLY_COMPLETED'
    && (completedCount === 0 || completedCount === tasks.length)) {
    throw new TypeError('A partially completed plan must contain both completed and incomplete tasks.');
  }
  if (planStatus === 'BLOCKED'
    && (completedCount > 0 || !tasks.some(task => task.status === 'BLOCKED'))) {
    throw new TypeError('A blocked plan must have no completed tasks and at least one blocked task.');
  }
}

function validatePlan(plan, { toolDefinitions, maxTasks = MAX_PLAN_TASKS } = {}) {
  assertExactKeys(plan, [
    'planId',
    'version',
    'objective',
    'status',
    'tasks',
    'createdAt'
  ], [], 'Plan');
  assertIdentifier(plan.planId, 'Plan ID');
  if (plan.version !== PLAN_VERSION) throw new TypeError(`Plan version must be ${PLAN_VERSION}.`);
  assertText(plan.objective, 'Plan objective');
  assertTimestamp(plan.createdAt, 'Plan createdAt');
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_PLAN_TASKS) {
    throw new TypeError(`Maximum task count must be between 1 and ${MAX_PLAN_TASKS}.`);
  }
  if (!Array.isArray(toolDefinitions)) {
    throw new TypeError('Existing tool definitions are required to validate a plan.');
  }
  const toolMap = new Map(toolDefinitions.map(tool => [tool.name, tool]));
  if (toolMap.size !== toolDefinitions.length) throw new TypeError('Tool definitions contain duplicate names.');
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > maxTasks) {
    throw new TypeError(`Plan tasks must contain between 1 and ${maxTasks} tasks.`);
  }

  const taskIds = new Set();
  plan.tasks.forEach(task => validateTask(task, toolMap, taskIds));
  validateDependencies(plan.tasks);
  validatePlanStatus(plan.status, plan.tasks);
  return {
    ...plan,
    tasks: plan.tasks.map(task => ({
      ...task,
      toolInput: { ...task.toolInput },
      dependencies: [...task.dependencies],
      requiredInputs: [...task.requiredInputs],
      completionCriteria: {
        ...task.completionCriteria,
        requiredFields: [...task.completionCriteria.requiredFields]
      }
    }))
  };
}

function validateTaskResult(result, plan = null) {
  assertExactKeys(result, [
    'taskId',
    'status',
    'summary',
    'completedAt'
  ], ['sourceInfo', 'errorCategory'], 'Task result');
  assertIdentifier(result.taskId, 'Task result ID');
  if (!TASK_RESULT_STATUSES.includes(result.status)) {
    throw new TypeError('Task result has an invalid success/failure status.');
  }
  assertText(result.summary, 'Task result summary');
  assertTimestamp(result.completedAt, 'Task result completedAt');
  if (plan && !plan.tasks.some(task => task.taskId === result.taskId)) {
    throw new TypeError(`Task result references unknown task ${result.taskId}.`);
  }
  if (result.status === 'FAILED' && !Object.hasOwn(result, 'errorCategory')) {
    throw new TypeError('A failed task result requires a sanitized error category.');
  }
  if (result.status === 'SUCCEEDED' && Object.hasOwn(result, 'errorCategory')) {
    throw new TypeError('A successful task result cannot contain an error category.');
  }
  if (Object.hasOwn(result, 'errorCategory')
    && (typeof result.errorCategory !== 'string'
      || !/^[a-z][a-z0-9_]{0,39}$/.test(result.errorCategory)
      || result.errorCategory.length > MAX_ERROR_CATEGORY_LENGTH)) {
    throw new TypeError('Task result error category is invalid.');
  }
  if (Object.hasOwn(result, 'sourceInfo')) {
    assertExactKeys(result.sourceInfo, ['source', 'retrievedAt'], [], 'Task result source information');
    assertText(result.sourceInfo.source, 'Task result source', MAX_RESULT_SOURCE_LENGTH);
    assertTimestamp(result.sourceInfo.retrievedAt, 'Task result retrievedAt');
  }
  return { ...result, ...(result.sourceInfo ? { sourceInfo: { ...result.sourceInfo } } : {}) };
}

module.exports = {
  MAX_PLAN_TASKS,
  PLAN_VERSION,
  PLAN_STATUSES,
  TASK_STATUSES,
  TASK_RESULT_STATUSES,
  TOOL_RESULT_FIELDS,
  validatePlan,
  validateTaskResult
};
