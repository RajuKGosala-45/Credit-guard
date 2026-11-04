# API Reference

The browser uses the same-origin JSON endpoints below. All `/api` endpoints require an authenticated CAP identity; role-protected operations also enforce the relevant server-derived role. JSON responses use UTF-8. Errors generally use `{ "error": "..." }`.

Browser state-changing requests go through the shared frontend API helper. With App Router CSRF protection enabled, the helper first sends an authenticated same-origin `GET /credit/index.html` carrying `X-CSRF-Token: Fetch`, reads the returned token, and uses the browser-managed same-origin session cookie. It caches the token in memory for the page session and attaches `X-CSRF-Token` to POST, PUT, PATCH, and DELETE requests. Reads do not fetch a token. If a write is rejected, the cached token is invalidated for the next user-initiated operation; the rejected write is never retried automatically.

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

In local profiles these endpoints use the CAP database. When `CREDIT_GUARD_AGENT_DATA_SOURCE=abap`, dashboard and customer reads use the configured ABAP provider, keeping them aligned with monitoring. Response shapes are retained; ABAP-backed responses include source and retrieval metadata.

## Credit monitoring

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/monitoring/summary` | `CreditReader` | Latest run and findings, last successful completion, and active/acknowledged alert counts. |
| GET | `/api/monitoring/runs[?limit=N]` | `CreditReader` | Bounded run history. |
| GET | `/api/monitoring/runs/latest` | `CreditReader` | Latest run, or 404 if no run exists. |
| GET | `/api/monitoring/runs/:id` | `CreditReader` | One portfolio run and its findings, regardless of initiator. |
| GET | `/api/monitoring/runs/:id/findings` | `CreditReader` | Findings for any portfolio run. |
| POST | `/api/monitoring/runs` | `CreditMonitor` or `CreditAdmin` | Enqueue an on-demand read-only run; returns `202 Accepted` with the run ID and current status. |
| POST | `/api/monitoring/jobs/run` | `CreditMonitorJob` | Enqueue a scheduled run; accepts only a canonical `scheduledFor` ISO timestamp, and the slot is idempotent. Returns `202 Accepted`. |
| POST | `/api/monitoring/runs/:id/recover` | `CreditMonitor` or `CreditAdmin` | Queue an eligible failed/stale run for bounded recovery; returns `202 Accepted`. |
| GET | `/api/monitoring/alerts[?status=ACTIVE]` | `CreditReader` | List portfolio alerts (`ACTIVE` includes acknowledged alerts; filters also accept `ACKNOWLEDGED`, `RESOLVED`, `ALL`). |
| GET | `/api/monitoring/alerts/:id` | `CreditReader` | Read alert state and lifecycle events. |
| POST | `/api/monitoring/alerts/:id/acknowledge` | `CreditMonitor` or `CreditAdmin` | Acknowledge an alert. |
| POST | `/api/monitoring/alerts/:id/resolve` | `CreditMonitor` or `CreditAdmin` | Manually resolve an alert. |

Monitoring statuses include `QUEUED`, `RUNNING`, `COMPLETED`, `PARTIAL`, `STALE`, and `FAILED`. Poll `GET /api/monitoring/runs/:id` for status and terminal results. The durable worker claims persisted jobs with a database lease; a portfolio-wide lock prevents overlapping scans. Freshness is `UNKNOWN` unless the upstream source supplies a data timestamp; retrieval time alone is not represented as source-data freshness. Findings use the existing deterministic credit rules. Optional AI text is an aggregate-only advisory and is not a decision or a new risk score.

Automatic alert resolution requires a `COMPLETED`, complete, non-empty snapshot with verified `FRESH` source data. Unknown or stale freshness, partial or failed runs, and empty portfolios preserve active and acknowledged alerts. Monitoring operators can still resolve alerts manually.

All authenticated `CreditReader` users can view portfolio-wide monitoring summaries, history, latest runs, run details, findings and alerts, regardless of who initiated a run. Public run responses omit the initiating user identity. `CreditMonitor` and `CreditAdmin` can execute manual runs, recover eligible runs, acknowledge alerts and manually resolve alerts. Only the `CreditMonitorJob` service role can trigger scheduled execution. Monitoring is read-only with respect to customer credit limits and limit requests. The scheduler binding does not provision the recurring Job Scheduler job, interval, OAuth configuration, or service-role assignment; those remain deployment tasks. No external email/SMS/push provider is configured.

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
