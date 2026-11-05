# Credit Guard — Project Handover

## Purpose and audit boundary

This document records the repository state and implementation evidence for the next engineering session. It is a read-only audit except for creating this handover document. No source, configuration, test, fixture, Git, or `test-results.json` content was changed as part of the audit. No SAP, BTP, database, or other external system was contacted.

The handover distinguishes **code present** from **configuration present**, **tests with mocks** from **live integration**, and **synthetic demo behavior** from approved credit policy. Repository documentation and archived reports are not proof of deployed behavior.

## Executive summary

Credit Guard is a Node.js 22 / SAP CAP and Express demonstration application. It has a plain JavaScript browser interface, synthetic local portfolio data, deterministic risk calculations, a human-reviewed limit-request workflow, a bounded AI assistant, read-only ABAP OData integration code, persisted monitoring workflows, and a separate canonical ingestion subsystem.

The local demo is the most complete, verifiable use case. It does **not** establish production readiness, live SAP connectivity, approval of the business thresholds, automated external notifications, recurring scheduler provisioning, or integration of canonical ingestion snapshots into the application’s existing credit calculations.

| Area | Current status | What is and is not established |
|---|---|---|
| Local portfolio/dashboard and customer views | **Implemented; synthetic demo** | CAP CSV fixtures and APIs drive a working local browser workflow. Data is not live SAP data. |
| Credit calculations | **Implemented; business policy requires confirmation** | Deterministic rules are shared by local and ABAP paths. The current guides describe the inclusive demo boundaries; client policy approval remains outstanding. |
| Limit request and human decision workflow | **Implemented in application code** | The agent cannot approve or directly change a limit. Production identity, persistence, and approval policy still require deployment verification. |
| AI assistant | **Implemented with offline and optional provider paths** | Bounded, allowlisted tool/plan execution and human-reviewed proposals are present. A real provider call and its privacy approval are not established. |
| SAP ABAP OData connector | **Partially implemented; live connection unverified** | Destination-backed, read-only `Customers` and `OpenItems` client, normalization and paging exist. Tests mock SAP responses. |
| Monitoring, findings, alerts and history | **Implemented in application code** | Durable queue/worker and alert lifecycle are present. Local browser workflow was exercised; HANA multi-instance and deployed behavior are not established. |
| Scheduled monitoring | **Partially implemented; requires external BTP setup** | A protected job-trigger endpoint and Job Scheduler service declaration exist. No recurring job, OAuth setup, or assigned job role is evidenced. |
| Source registry and canonical ingestion | **Implemented as additive code; source mappings absent** | Registry, connectors, validators and snapshot storage exist, but no configured mappings are supplied, SAP ingestion maps only customers, and current decision reads do not consume snapshots. |
| External alert delivery | **Not configured** | In-app alerts/outbox exist; no email, SMS, or push destination is configured. |
| Production readiness | **Not established** | A successful build or mock-based tests do not establish BTP deployment, real identity, HANA concurrency, live SAP, policy sign-off, or operational readiness. |

## Repository state and history

### Git baseline

- Branch: `main`.
- `HEAD`: `6954c9070d1c80a1f9be581c986e1c650bf5fa85` — `Implement monitoring worker reliability and CSRF` (2026-11-04).
- The repository has six commits from 2026-10-31 through 2026-11-04. The main progression is initial application, risk/SAP integration, bounded agent orchestration, scheduled monitoring, and monitoring-worker/CSRF reliability.
- Before adding this handover, the working tree already had **29 modified tracked files** and **14 untracked files**. These changes include demo features, Phase 2B ingestion work, tests and `test-results.json`. There were no staged changes.
- Preserve those existing changes. They are not represented by `HEAD`; do not reset, restore, or treat the committed tree as the complete current implementation.
- `test-results.json` is untracked, was not changed, and has SHA-256 `6DB164821A1EB142126A7634571579891281A1097103EE205233D11CC5A382E0`. It is an invalid JSON diagnostic artifact, not a valid test-results report.
- `gen/` and `node_modules/` were present locally but are generated/dependency directories, excluded from the tracked project inventory.

### Main project areas

| Path | Responsibility |
|---|---|
| `app/credit/` | Static HTML/CSS/JavaScript dashboard, customer, monitoring, chat, approval and request views. |
| `db/schema.cds`, `db/data/` | CAP data model and synthetic CSV fixtures. Current work adds payment fixtures and monitoring/agent/ingestion persistence entities. |
| `srv/server.js` | Express routes, auth gates, health endpoints, static UI mounting, document analysis and API error responses. |
| `srv/creditService.js`, `srv/rules.js` | Portfolio/customer services, currency-aware aggregation, limit-request transitions and deterministic risk calculations. |
| `srv/portfolioDataProvider.js`, `srv/integrations/abap/` | Local/ABAP source selection and read-only Destination-based OData integration. |
| `srv/monitoringService.js`, `srv/monitoringStore.js`, `srv/monitoringWorker.js`, `srv/monitoringSummary.js` | Monitoring queue/run lifecycle, persistence, claims/recovery, findings, alerts and advisory summaries. |
| `srv/agent.js`, `srv/agentPlan.js`, `srv/agentStore.js`, `srv/llm.js` | Tool registry, plan validation, bounded execution, optional provider adapter and owner-scoped execution/conversation storage. |
| `srv/sourceRegistry.js`, `srv/sourceRegistryStore.js`, `srv/connectorManager.js`, `srv/configuredConnectors.js`, `srv/canonicalData.js`, `srv/ingestionRuntime.js`, `srv/ingestionService.js`, `srv/ingestionStore.js` | Additive source registry, connector contracts, canonical mapping/validation, ingestion runs and snapshots. |
| `srv/service.cds` | CAP OData projection/service definitions; existing credit projections are read-only. |
| `abap/adt/` | Proposed custom RAP/CDS/OData artifacts and synthetic fixtures; not activated or verified in a tenant. |
| `mta.yaml`, `approuter/`, `xs-security.json` | Cloud Foundry MTA, App Router and XSUAA deployment descriptors. Descriptors are not evidence of provisioned services. |
| `docs/` | Current usage/design/deployment guides and archived milestone reports. Some current documentation has drift; see below. |
| `tests/` | Node built-in test-runner unit, integration, contract, mock-connector and opt-in external-profile tests. |

## Runtime and architecture

- Runtime requirements in the root package are Node.js `^22.0.0`; the observed local runtime was Node `v22.21.1` and npm `10.9.4`.
- CAP owns the CDS model, database lifecycle and identity integration. Express supplies custom REST endpoints, health checks and the browser UI. The UI is plain JavaScript; there is no frontend framework/build pipeline.
- Local development uses CAP mock identities and in-memory SQLite with synthetic CSV data. A persistent local SQLite profile is available. Production configuration targets HANA and XSUAA.
- The architecture is a single CAP application with in-process services and a monitoring worker, not a set of separate microservices.
- The default data source is local unless `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` is selected. The Cloud Foundry descriptor selects `abap`; this selection is configuration, not proof that SAP connectivity works. An ABAP failure is intended to fail explicitly rather than substitute the local portfolio.
- The additive ingestion subsystem has its own registry and persisted canonical snapshots. It is not the selected portfolio provider and is not a data source for the current dashboard, monitoring rules, or existing decision calculations.

## Business data and credit calculations

### Current application records

The application’s established credit workflow uses customers, open items, credit-limit requests and approval history. The demo work adds payment history and persists monitoring runs/findings/alerts/events/outbox, agent execution/conversation state, and ingestion registry/run/quality/checkpoint/snapshot state. These application records are not all part of one transactional SAP snapshot.

The local seed data is synthetic and clearly designated as demo data in the application. It includes customer credit limits, invoices/open items, overdue examples and payments. The demonstrated threshold cases include C005 at 80%, C013 at 100%, and C001 at 120%.

### Deterministic rules

Rules live in `srv/rules.js`; the assistant is not the authority for exposure or thresholds.

- Exposure includes qualifying unpaid invoices and sales orders. In the existing rule contract, item types are `Invoice` and `SalesOrder`, and qualifying statuses are `Open` and `Overdue` (case-insensitive).
- The due date, not just a source status, determines overdue amount: a valid date-only due date strictly before the current UTC calendar date is overdue. Missing/invalid due dates do not count as overdue.
- Identical duplicate item IDs are counted once; conflicting duplicate IDs and item IDs associated with different customers are rejected.
- A zero limit produces `MANUAL_REVIEW` and null utilization. Utilization is a ratio in the API; `utilisationPercent` is for percentage display.
- Current code classifies utilization at/above 80% as warning, at/above 100% as breach, and at/above 120% as critical. The 120% case is both breached and critical.
- Overdue risk uses an overdue share strictly above 30%; stale review uses a 12-calendar-month interval. These values and definitions are application behavior, not client-approved policy.
- Mixed currencies are kept in separate portfolio buckets; no exchange-rate conversion is implemented. Existing rule paths still use JavaScript `Number` for monetary calculations. The additive canonical data layer represents financial decimals as strings, and selected aggregate outputs use integer minor units, but that does not make all existing decision calculations precision-safe.

### Business-rule documentation alignment

At the start of this integration review, `docs/business/CREDIT_RISK_RULES.md` contradicted the current `srv/rules.js` boundary behavior and the requested practical-demo thresholds. The guide was aligned to the already implemented demo behavior (80% warning, 100% breach, 120% critical) without changing calculation code or tests. These demo thresholds remain unapproved as client credit policy; obtain credit-policy owner confirmation before operational use.

Other still-unconfirmed policy/data semantics include whether sales orders count as exposure, source status/reversal/clearing semantics, currency and credit-segment treatment, timezone/date interpretation, data freshness requirements, and the 80%, 30%, and review-age thresholds.

## User-facing and API capabilities

The existing UI supports the customer portfolio, customer details/payments, credit requests and human approval/rejection, assistant chat, and monitoring runs/history/findings/alerts. The monitoring view has a protected manual Run Monitoring action and refreshes run results; dashboard information includes portfolio exposure/utilization and monitoring/risk information. The demo workflow was exercised in a browser during the earlier implementation session.

Important custom endpoints in `srv/server.js` include:

| Endpoint family | Access/control |
|---|---|
| `GET /health/live`, `GET /health/ready` | Health probes. |
| `/api/dashboard`, `/api/customers`, `/api/customers/:id`, `/api/customers/:id/payments` | `CreditReader`. |
| `/api/limit-requests` and `/:id/history` | Reader/requester roles; decision transition uses authenticated identity and eligibility checks. |
| `/api/monitoring/runs`, `/summary`, `/alerts` and their detail routes | Reader for portfolio views; `CreditMonitor`/`CreditAdmin` for manual run, recovery and alert lifecycle operations. |
| `POST /api/monitoring/jobs/run` | `CreditMonitorJob` service role. |
| `/api/ingestion/sources`, source status/snapshot/run routes | Source administration and refresh require `CreditAdmin`; status and snapshot reads require `CreditReader`. |
| `/api/chat`, `/api/agent/*` | Reader-gated, owner-scoped history/executions and bounded execution recovery. |
| `POST /api/documents/analyze` | Reader-gated PDF, DOCX and UTF-8 TXT extraction in memory; separate optional feature, not the primary business data-ingestion workflow. |

The App Router is configured for CSRF protection. The browser uses the normal CSRF-token flow; a loopback-only fallback was added for standalone local CAP development, not as a general production bypass.

## SAP integration assessment

### Verified in repository code (not a live SAP verification)

- `srv/integrations/abap/client.js` resolves a named SAP BTP Destination using SAP Cloud SDK and performs HTTP reads. Defaults documented in the repository are destination `CREDIT_GUARD_ABAP` and relative OData collections `Customers` and `OpenItems`; environment overrides are supported.
- The connector accepts OData v4 and common v2 collection response shapes. It follows pagination links, bounds page count and page size, applies request timeouts, rejects pagination links that leave the configured destination, and supports cancellation/deadlines.
- Customer fields expected by the current custom contract are `CustomerId`, `CustomerName`, `CreditLimit`, `Currency`, `ReviewDate`, `Country`, `CompanyCode`, and `RiskClass`.
- Open-item fields are `OpenItemId`, `CustomerId`, `Type`, `Amount`, `Currency`, `DueDate`, and `Status`.
- The current client validates required IDs/names, date formats, amount finiteness, currency format, customer ownership, key lengths and cross-record consistency. Amounts in this pre-existing credit path are converted to `Number`.
- Error handling classifies timeout, unauthorized, missing-endpoint, invalid-response and unavailable cases. Errors presented to callers are sanitized; tests use mocked Destination/OData behavior.
- `abap/adt/source/` contains proposed custom `Z*` CDS/service artifacts and synthetic CSV fixtures. They are not SAP standard objects and have not been activated in an ABAP tenant.

### Not established

No live Destination resolution, SAP authentication, service metadata, tenant reachability, actual payload, real source timestamp, or SAP business semantics were verified. The connector’s expected names are a repository-defined custom contract, not a claim that those entities exist in a client SAP system. No SAP write operation is part of this connector.

The additive ingestion adapter reuses this boundary but currently maps only `CUSTOMER`. It does not provide ingestion mappings for credit accounts, invoices, sales orders, payments, or allocations.

## Source registry and ingestion subsystem

The registry accepts source categories `SAP_S4HANA_ODATA`, `SQL_DATABASE`, `SAP_HANA`, `REST_API`, `CSV_XLSX`, and `JSON_XML`. Records contain source identity/type, enabled state, supported canonical entities, mapping version, authentication/configuration references, and registry timestamps. References are identifiers, not credentials. The API does not accept arbitrary endpoints, SQL statements, file paths or URLs from source-registration callers. Disabled sources cannot be selected.

Canonical entity types are:

- `CUSTOMER`
- `CREDIT_ACCOUNT`
- `INVOICE`
- `SALES_ORDER`
- `PAYMENT`
- `PAYMENT_ALLOCATION`

The canonical validators define required/optional fields and reusable provenance (`sourceId`, `sourceEntity`, `sourceRecordId`, optional source timestamp, retrieval/ingestion timestamps, run ID and mapping version). Amounts are decimal strings, currencies are three-letter uppercase codes, and dates/timestamps are validated. Validation/mapping covers identifiers, required fields, duplicates, conflicting canonical-customer identities and missing provenance. It does not invent missing values.

Connector and runtime code also includes bounded reads/retries/deadlines, cancellation, source-level locking, record/page bounds, audit/quality issues, and transactional snapshot promotion. The configured connector manager has SAP OData, SQL/CAP, REST and approved repository-file adapters; CSV, JSON and flat XML parsing are present. XLSX fails explicitly without an approved parser. These are code paths and tests, not evidence that any source is configured or operational.

Critical boundaries:

1. No source-specific mappings/configuration are provided under `cds.requires.creditGuardIngestion.sources`; attempted refresh without valid configuration must fail, not produce an empty successful portfolio.
2. The SAP ingestion mapping is customer-only.
3. Snapshot persistence does not change current application reads; dashboards, monitoring and agent credit calculations still use the local/ABAP provider and existing credit model.
4. Customer crosswalks, cross-entity snapshot consistency, source deletion/tombstone semantics, and approved credit-use mappings remain open design/business decisions.
5. Ingestion contract support is not permission to accept user-supplied hosts, SQL or local paths; source configuration must remain trusted server-side configuration.

## Monitoring, alerting and scheduling

- Manual monitoring requests are persisted and return a queued run. A worker polls the database queue, uses persisted claims/leases and token-guarded transitions, and supports bounded execution, cancellation, shutdown drain and lease recovery.
- Runs persist findings and alert lifecycle events. Duplicate alert prevention is implemented. In-app alerts can be acknowledged and manually resolved by authorized monitoring roles.
- Alert resolution is conservative: automatic resolution requires a completed, complete, non-empty snapshot with verified fresh source data. Unknown/stale freshness and partial/failed/empty results do not clear active alerts.
- Deterministic findings remain authoritative; an optional AI summary/advisory has a separate bounded timeout. Monitoring does not change credit limits or requests.
- The endpoint for scheduled execution and `CreditMonitorJob` authorization exist. `mta.yaml` declares a Job Scheduler binding, but a recurring job, interval, OAuth credentials/configuration, and service-role assignment are external provisioning tasks and were not verified.
- The outbox is persisted, but no external email/SMS/push delivery integration is configured. Do not describe alerts as externally delivered.
- Local tests and a local browser demo do not establish HANA transaction/concurrency behavior. The HANA integration suite is opt-in and must only be run against the explicitly disposable isolated schema described in the deployment guide.

## AI assistant and document handling

- `srv/agent.js` provides an allowlisted tool registry; server-side role checks remain authoritative. The agent can retrieve customer/portfolio data, inspect thresholds and requests, and prepare a limit-change proposal.
- Model-produced plans are validated against server-defined contracts in `srv/agentPlan.js`; plan execution is sequential and bounded (up to 12 plan tasks, 12 tool calls, six model calls and a 20-second overall execution limit by default). Read retries are bounded and apply only to eligible transient failures.
- Offline mode uses deterministic tools/replies. An optional Anthropic adapter is configured server-side. No provider key is required for offline mode; no live provider call was established in this audit.
- The agent cannot approve/reject requests or directly write a limit. Proposal submission remains a separate explicit user/API action, followed by authorized human approval.
- Execution progress and safe summaries are owner-scoped. Conversation memory is opt-in. Uploaded documents are processed in memory; configured model use can transmit chat/document content to Anthropic, so privacy/provider approval is required before using confidential or regulated data.
- The document-analysis route exists as a separate optional feature. It must not be confused with the primary server-side enterprise ingestion workflow or represented as a requirement for portfolio processing.

## Security, configuration and deployment readiness

- XSUAA role templates, CAP auth configuration, App Router routes and role-gated APIs are present. Local mock authentication is for development only. Configuration and route tests do not verify deployed JWT propagation, role collections, SSO, or user assignments.
- Source credentials are intended to remain in server-side platform bindings/Destinations; the registry stores references, not secrets. Logs/responses should not contain credentials.
- The MTA describes CAP server, HANA/HDI deployer, App Router, XSUAA, Destination and Job Scheduler resources. Production startup checks require expected production profile and bindings. A descriptor or startup guard does not prove a successful deployment or correctly provisioned tenant.
- Production prerequisites include Node.js 22 support in the target buildpack/stack, provisioned HANA/XSUAA/Destination services, a working named Destination and approved ABAP service, HDI schema deployment, role collections, and an operational owner for worker/scheduler recovery.
- The archived dependency security report is dated 2026-11-03 and recorded development-tool advisories at that time. It is historical evidence only, not a current audit. Re-run dependency audit in a trusted environment before a production release; do not make a major CAP toolchain upgrade without compatibility review.

## Tests and verification evidence

The repository has 24 test files:

- SAP: `abap.contract.test.js`, `abap.integration.test.js`, `abap.live.integration.test.js`
- Agent: `agent.test.js`, `agent-plan.test.js`, `agent-orchestration.test.js`, `agent-store.test.js`, `llm.test.js`
- APIs/business rules: `api.integration.test.js`, `credit-service.test.js`, `rules.test.js`, `frontend-api-csrf.test.js`
- Monitoring: `monitoring-api.test.js`, `monitoring-service.test.js`, `monitoring-store.test.js`, `monitoring-summary.test.js`, `monitoring-worker.test.js`, `hana-monitoring.integration.test.js`
- Ingestion: `source-registry.test.js`, `source-registry-api.test.js`, `configured-connectors.test.js`, `ingestion.test.js`
- Configuration/readiness: `configuration.test.js`, `milestone3-readiness.test.js`

The prior practical-demo implementation run recorded **240 total tests: 238 passed, 0 failed, 2 skipped**. It also recorded a successful `npm.cmd run build`, 62 JavaScript syntax checks, `git diff --check`, and a browser workflow on local port 4006. The skipped live/external-profile tests do not establish SAP or HANA operation. These results are from the preceding implementation session; they were not rerun for this documentation-only audit. Use `npm.cmd test` for the ordinary suite and run opt-in external tests only after verifying their isolated target and explicit opt-in settings.

Useful local commands:

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd test
npm.cmd run build
```

Local development is documented on port 4005; the earlier browser validation used port 4006. Confirm port availability and current scripts before reuse. `npm.cmd run start:persistent` selects the local persistent SQLite profile.

## Documentation drift and open risks

1. **Risk thresholds:** current guide and code disagree at exactly 100% and 120%; resolve with the policy owner.
2. **Agent design guide:** `docs/ai-agent/AI_AGENT_DESIGN.md` still says there is no background monitor/scheduler/alert service, which is stale relative to the monitoring worker, persisted in-app alert/outbox code and scheduler trigger. External recurrence and delivery are still absent.
3. **Archived reports:** `docs/archive/reports/` documents earlier milestones and proposals. Treat them as historical, not authoritative descriptions of current code.
4. **Canonical/legacy amount types:** canonical ingestion preserves decimal strings, but existing rule and SAP credit paths use floating-point `Number`; do not cut canonical/production monetary data over without an approved precision and rounding plan.
5. **Source truth and policy:** the custom ABAP data contract and synthetic data have not been reconciled with client SAP metadata, business meanings, or approved credit policy.
6. **Deployment assumptions:** BTP service bindings, identities, HANA transaction behavior, buildpack support, scheduler provisioning, shutdown recovery and notification delivery are not verified.
7. **Current working tree:** demo and Phase 2B changes are uncommitted. Keep them intact; review their combined diff before staging or creating a release.
8. **Diagnostic artifact:** `test-results.json` is invalid JSON and untracked. Preserve it unless its owner explicitly authorizes cleanup.

## Recommended next steps

1. Review the current uncommitted diff and this handover before any cleanup, staging, or additional implementation.
2. Obtain credit-policy owner decisions for exposure eligibility, threshold boundaries, overdue/freshness semantics, currency handling, and rounding/precision.
3. Reconcile `docs/business/CREDIT_RISK_RULES.md` with the approved rules and ensure boundary tests assert the signed-off outcomes.
4. Obtain SAP owner metadata and masked non-production fixtures; confirm destination, entity/field mappings, source timestamps, pagination expectations and least-privilege read access. Verify a real connection only when explicitly authorized.
5. Add approved source configuration and complete entity mappings only after source semantics and customer/account crosswalks are agreed. Keep canonical snapshots isolated until completeness, consistency, freshness and promotion behavior are validated.
6. Plan an explicit, tested cutover from current local/ABAP reads to canonical snapshots; do not change decision inputs as a side effect of connector work.
7. Provision and verify BTP identity, HANA/HDI, Destination, Job Scheduler recurrence/role, and any alert-delivery channels in a non-production space.
8. Reconcile stale current documentation, including the agent background-monitor statement, and rerun the ordinary suite/build plus isolated target-specific integration checks.

## Handover constraints

- Do not overwrite or remove existing uncommitted Phase 2B/demo changes.
- Do not modify or delete `test-results.json`.
- Do not infer live SAP/BTP functionality from environment-selection values, MTA declarations, mocks, or source artifacts.
- Do not change business thresholds, financial semantics, dependencies, configuration or external services without the appropriate approval.
- Keep the dashboard and existing API contracts stable unless an approved change explicitly requires otherwise.
