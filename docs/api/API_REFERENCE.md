# API Reference

The browser uses the same-origin JSON endpoints below. All `/api` endpoints require an authenticated CAP identity; role-protected operations also enforce the relevant server-derived role. JSON responses use UTF-8. Errors generally use `{ "error": "..." }`.

## Health

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health/live` | Anonymous | Process liveness. |
| GET | `/health/ready` | Anonymous | Checks whether the CAP database handle is available. |

## Portfolio and customer reads

These endpoints require `CreditReader`.

| Method | Path | Response |
|---|---|---|
| GET | `/api/dashboard` | `kpis` and exposure groupings by country, company code, and customer. Currency totals are separated where needed. |
| GET | `/api/customers` | Customer summaries with exposure, overdue amount/share, utilization, flags, and status. |
| GET | `/api/customers/:id` | One summary plus open items annotated with whether they consume credit and are overdue. |

## Limit requests

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/limit-requests[?status=Pending]` | `CreditReader` | List requests, optionally filtered by `Pending`, `Approved`, or `Rejected`. |
| POST | `/api/limit-requests` | `CreditRequester` | Create a pending request. |
| POST | `/api/limit-requests/:id/decision` | Authenticated eligible approver | Approve or reject a pending request. |
| GET | `/api/limit-requests/:id/history` | `CreditReader` | Read immutable decision audit entries. |

Create-request body:

```json
{
  "customerId": "C001",
  "requestedLimit": 1200000,
  "reason": "Renewed customer contract"
}
```

Decision body:

```json
{
  "decision": "Approved",
  "reason": "Reviewed against the renewed contract."
}
```

Decision must be `Approved` or `Rejected`; a nonblank reason of at most 500 characters is required. The server derives the requester, approver, and roles from the authenticated identity. Body-supplied identity/role values are not authorization inputs. A requester cannot decide their own request.

## Agent and document routes

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/api/chat` | `CreditReader` | Send a message and optional browser-held document context. |
| POST | `/api/documents/analyze` | `CreditReader` | Extract and analyze multipart field `document` (PDF, DOCX, or UTF-8 TXT; 10 MiB upload cap). |
| GET | `/api/agent/history` | `CreditReader` | List the caller’s conversations and execution summaries. |
| GET | `/api/agent/conversations/:id` | `CreditReader` | Read one owned conversation. |
| DELETE | `/api/agent/conversations/:id` | `CreditReader` | Delete one owned conversation. |
| DELETE | `/api/agent/history` | `CreditReader` | Delete the caller’s agent history. |
| GET | `/api/agent/executions` | `CreditReader` | List execution summaries. |
| GET | `/api/agent/executions/:id` | `CreditReader` | Read one execution owned by the caller. |
| POST | `/api/agent/executions/:id/recover` | `CreditReader` | Claim and resume eligible pending read-only tasks for an owned execution. |

Chat messages are limited to 1,000 characters; extracted context is limited to 20,000 characters. Uploaded files are processed in memory and are not stored by the application. When configured, document/chat content can be sent to the external LLM provider.

Structured chat responses include a public plan without tool inputs, safe task results, and an `executionSummary` with execution ID, plan status, completed/failed/blocked/pending counts, sanitized failures, and recovery availability. Existing `reply`, `offline`, `preparedActions`, and `execution` fields remain. Errors include a safe execution summary when one is available.

Execution records are owner-scoped. The detail endpoint omits stored tool inputs and recovery-only customer IDs. Recovery validates the saved plan version and claims the execution with a conditional database update; it never repeats completed work and resumes only eligible read-only tasks. A stale running task requires manual review. Proposal tasks are never retried or automatically resumed. Read-only retries are bounded to two retries for transient network failures, timeouts, HTTP 429, and HTTP 500/502/503/504 responses; authentication, authorization, validation, and proposal failures are not retried. The 20-second overall execution timeout and twelve-tool-call budget include retries.

## CAP OData

`CreditService` is exposed at `/odata/v4/credit`. Its `Customers`, `OpenItems`, `LimitRequests`, and `ApprovalHistory` projections require `CreditReader` and are annotated read-only. The custom REST workflow remains the interface for request decisions.

## Compatibility notes

Utilization is a ratio in the `utilisation` property (`0.8` means 80%); `utilisationPercent` is a percentage. A zero limit gives `null` utilization and `MANUAL_REVIEW`. Do not sum values across currencies.
