# AI Agent Design

## Implemented behavior

`srv/agent.js` provides an `AgentController` and validated tool registry. Tools cover customer lookup, utilization-threshold listing, exposure grouping, request listing, proposal preparation, and optional read-only ABAP customer analysis.

The controller uses Anthropic to create a structured task plan, validates it against the server-owned tool registry, and executes validated tasks sequentially. The default global limits remain six model calls, twelve tool invocations, and a 20-second overall timeout. Tool inputs are checked server-side and tool permissions are derived from the current CAP user at execution time. Portfolio calculations come from the deterministic rules and credit service, not model-generated financial arithmetic.

## Provider and offline mode

`srv/llm.js` implements the provider interface and an Anthropic adapter. No API key is required for local development. Without a configured provider, deterministic offline replies call the same registered tools but cannot interpret arbitrary natural-language requests as flexibly as a language model.

Provider failure during plan generation may fall back to the existing deterministic offline replies; this mode does not produce a structured plan. Provider failure during final response generation preserves the completed task outcomes and returns a deterministic execution summary. Execution metadata records fallback and its category. Missing provider configuration is also recorded as an offline fallback. The provider timeout defaults to 15 seconds and accepts positive whole milliseconds up to 120 seconds. Provider credentials remain server-side.

## Proposal and approval boundary

The agent can prepare a validated proposal. It does not create the request until the user explicitly submits the prepared proposal through the normal API. The tool registry contains no approve/reject operation and cannot directly update a credit limit. A separately authorized human must decide the submitted request.

## Data sources and history

The local CAP database is the default agent source. `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` selects the read-only ABAP provider. ABAP responses include source and retrieval timestamp. An unavailable ABAP destination fails explicitly; it does not silently substitute local data.

Execution progress and safe summaries are stored for authenticated users. Conversation storage is opt-in with `AGENT_MEMORY_ENABLED=true`; saved conversations are user-scoped. Raw tool results and uploaded document files are not retained as execution history. Read-only task inputs and threshold-result customer IDs are retained only as needed for recovery; proposal inputs are replaced with placeholders in stored plan data.

## Document handling

The document route extracts PDF, DOCX, or UTF-8 TXT text in memory. The upload is limited to 10 MiB and model context to 20,000 characters. Document text is untrusted input. When an LLM provider is configured, chat and extracted content may be sent to that provider.

## Not implemented

There is no autonomous scheduler, background monitor, outbound alert service, vector database/RAG pipeline, or autonomous business-action execution. Planning is limited to one bounded request and the existing registered tools.

## Orchestration planning contract — Phase 1

Phase 1 added the versioned plan/task/result contract and validators in `srv/agentPlan.js`, with contract tests in `tests/agent-plan.test.js`. Phase 2 integrates this contract into the agent workflow; the contract remains the validation boundary for all model-generated plans.

### Plan and task structures

The plan has exactly these fields:

```text
Plan {
  planId: string,
  version: 1,
  objective: string,
  status: PlanStatus,
  tasks: Task[],
  createdAt: canonical ISO timestamp
}
```

Each task has exactly these fields:

```text
Task {
  taskId: string,
  description: string,
  toolName: existing registered tool name,
  toolInput: validated arguments for that registered tool,
  dependencies: taskId[],
  taskType: "READ_ONLY" | "PROPOSAL",
  requiredInputs: registered tool input names[],
  completionCriteria: {
    description: string,
    requiredFields: string[]
  },
  status: TaskStatus,
  attemptCount: integer from 0 through 12,
  startedAt?: canonical ISO timestamp,
  completedAt?: canonical ISO timestamp
}
```

`requiredInputs` names the existing tool’s inputs. `toolInput` is internal to execution and is checked against the selected tool's server-defined schema; it is omitted from the public plan summary. A dynamic customer detail input may refer only to an `ID` from a completed `list_customers_over_threshold` task, and is expanded into sequential `get_customer` calls. `completionCriteria` is declarative text/field metadata, not code, and its fields must be supported by that tool's known output shape. Plans and tasks reject unknown fields, including permission/role grants, shell, SQL, code, and arbitrary function names.

### Status values

- `TaskStatus`: `PENDING`, `READY`, `RUNNING`, `COMPLETED`, `FAILED`, `BLOCKED`, `SKIPPED`.
- `PlanStatus`: `DRAFT`, `VALIDATED`, `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `BLOCKED`, `FAILED`, `REJECTED`.
- A task may be `READY` only when every dependency is `COMPLETED`. Dependencies are rechecked immediately before each sequential execution.
- A plan marked `COMPLETED` must have all tasks completed. A plan marked `PARTIALLY_COMPLETED` must contain at least one completed task and at least one incomplete task.

### Task result

The result contract is:

```text
TaskResult {
  taskId: string,
  status: "SUCCEEDED" | "FAILED",
  summary: single-line safe summary (maximum 500 characters),
  sourceInfo?: {
    source: string,
    retrievedAt: canonical ISO timestamp
  },
  completedAt: canonical ISO timestamp,
  errorCategory?: sanitized lowercase identifier
}
```

Failed results require an error category; successful results cannot carry one. Extra fields such as raw tool payloads are rejected. The contract bounds summary/source fields but cannot itself detect or redact PII or secrets: any future result producer must create a safe summary and must not persist raw customer/tool output as a task result.

### Implemented validation rules

`validatePlan` requires the existing tool definitions as an allowlist and rejects missing/invalid fields and IDs, duplicate IDs, unknown tools, unrecognized task types/statuses, unsupported input names, missing required tool inputs, missing dependencies, self/circular dependencies, invalid completion criteria, duplicate dependency/criteria entries, and unsupported plan/task fields. The default task maximum is 12; callers may lower it but cannot raise it above 12. Proposal classification is reserved for `prepare_limit_change`; that tool cannot be represented as read-only, and other existing tools cannot be labeled proposal tasks. The validator does not grant authorization; existing per-tool server-side role checks remain authoritative.

`validateTaskResult` validates the bounded result shape, summary, optional source metadata, timestamp, outcome/error-category relationship, and the result task’s membership in the plan. Result summaries are intentionally generated from fixed server-side templates. Length and shape checks are not PII detection or redaction; result producers must minimize data and must never put raw customer/tool output into a result summary.

### Phase 2: integrated planning and sequential execution

The agent asks Anthropic for a plan using a server-authored planning-tool schema. The model cannot define tools or permissions. `buildPlan` adds a server-generated plan ID, status, and attempt counters, then `validatePlan` checks the result against the existing `toolDefinitions`. Invalid plans are rejected before any business tool runs. Clarification questions are returned without execution.

Validated tasks execute sequentially through the existing registry. The registry continues to validate each input and perform the authenticated CAP user's role check at the moment of execution; a plan cannot grant access. A tool failure marks that task failed, blocks its dependents, and allows independent tasks to continue. Dynamic customer-detail fan-out counts each registered-tool call, including retries, against the global twelve-call limit. When the budget is exhausted, remaining work is reported as failed/blocked rather than complete.

The public response adds a structured plan without `toolInput`, safe task result summaries, and an execution summary. Existing `reply`, `offline`, `preparedActions`, and `execution` fields remain. The authenticated chat API returns this response to the caller.

Proposal preparation is separate from submission and approval. A `PROPOSAL` task can reference only `prepare_limit_change`; it is allowed only when the current request explicitly contains the customer ID, amount, and reason. The tool still performs its existing requester-role check. A prepared proposal requires a separate user action to submit, and a separately authorized human must approve or reject it.

No ranking formula is introduced. If a request asks for a ranking without naming an existing criterion (such as utilization, overdue amount/share, risk class, or existing flags), the server requires clarification and suppresses final ranking synthesis even if the planner omits that question. A task plan may use only the deterministic results returned by existing tools.

### Phase 3: evaluation, retries, persistence, and recovery

Each registered tool result is checked against the tool-specific expected shape and the task's required completion fields before its task can become `COMPLETED`. Empty, malformed, unexpected, or criteria-incomplete results become failures. Result summaries and source metadata use bounded, sanitized structures; this is data minimization, not general PII detection or redaction.

The executor may retry only explicitly allowlisted `READ_ONLY` tools. It allows at most two retries after the first attempt for network errors/timeouts, HTTP 429, and HTTP 500/502/503/504. Backoff is bounded (100 ms then 200 ms) and retries stop when the global execution deadline or tool-call budget leaves insufficient room. HTTP 400/401/403, validation/authorization errors, proposal tasks, and any non-read-only operation are not retried. Each executed attempt and its sanitized outcome is recorded. Retry policy is server-owned and cannot be changed by model output.

`AgentExecutions` and `AgentExecutionSteps` are updated transactionally as execution progresses. The saved record includes owner, execution and plan identifiers/version, task states, attempt counts, timestamps, safe results, sanitized errors, and recovery status. Stored plans include only the inputs needed to resume; proposal inputs are replaced with non-sensitive placeholders. Dynamic customer fan-out stores only the source customer IDs needed to resolve pending `get_customer` tasks, not the raw customer results. Execution detail/history endpoints omit internal plan inputs and recovery data.

`GET /api/agent/executions/:id` reads one execution owned by the authenticated user. `POST /api/agent/executions/:id/recover` claims and resumes eligible saved work. Recovery revalidates the stored plan/version, uses the trusted current tool registry, preserves completed tasks, rechecks dependencies, and executes only eligible pending read-only tasks. Proposal tasks are never resumed. A conditional database update claims recovery to prevent concurrent recovery requests for one execution. If a stale execution contains a `RUNNING` task, its outcome is uncertain; it is marked for manual review and is not automatically repeated. Stale claims older than 60 seconds can be reclaimed only when no task is running.

The execution summary reports execution ID, plan status, completed/failed/blocked/pending task counts, safe summaries for completed work, sanitized failure categories, and recovery availability. A plan is `COMPLETED` only when every task completed; it is `PARTIALLY_COMPLETED` when useful work completed but some tasks did not; it is `BLOCKED` when no work completed and at least one task is blocked; otherwise it is `FAILED`. Validation/safety rejection remains `REJECTED`. These are database-backed, best-effort recovery guarantees—not exactly-once execution for arbitrary external side effects. Proposal/write operations are excluded from automatic retry and recovery; an uncertain running task requires manual review.

### Phase 3 limitations and later work

There is no progress UI, automatic cleanup/retention policy for execution records, autonomous scheduler, or recovery of proposal/write operations. Phase 3 does not add parallel execution, general-purpose code generation, RAG, embeddings, vector storage, or long-term plan memory. Production deployment, database-specific concurrency behavior, and SAP/ABAP failure modes still require validation in their target environments.
