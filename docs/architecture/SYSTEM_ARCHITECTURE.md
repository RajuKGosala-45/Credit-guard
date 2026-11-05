# System Architecture

## Runtime overview

Credit Guard is a single SAP CAP application with an Express extension and a static browser client. CAP owns service lifecycle, CDS model deployment, database access, and identity integration. Express adds the JSON API, health checks, and static UI hosting.

```text
Browser UI (/credit)
   │ same-origin JSON requests
   ▼
Express routes (/api) ── CAP identity middleware
   ├── creditService.js ── rules.js
   ├── agent.js ── llm.js (optional provider)
   │             └── integrations/abap
   ├── monitoringService.js ── monitoringStore.js ── CDS/HANA queue/claims
   │                          └── monitoringWorker.js ── bounded scan/advisory
   ├── portfolioDataProvider.js ── CAP or read-only ABAP
   └── ingestionRuntime.js ── source registry ── connector manager
                              ├── ABAP / REST / CAP SQL-HANA
                              ├── approved CSV / JSON / flat XML repository
                              └── CDS ingestion runs, quality issues, checkpoints, and snapshots
CAP database ── SQLite locally / HANA in configured production profile
```

## Components

| Component | Location | Responsibility |
|---|---|---|
| Browser interface | `app/credit/` | Portfolio, customers, requests/approvals, monitoring, assistant, and document UI. |
| CDS data model | `db/schema.cds` | Customers, open items, requests, agent history, and monitoring jobs/findings/alerts/events/outbox/worker lock. |
| Local fixtures | `db/data/` | Synthetic CSV customers and open items loaded by CAP. |
| CAP OData | `srv/service.cds` | Reader-protected, read-only `CreditService` projections. |
| REST and static hosting | `srv/server.js` | API routes, authentication gates, health checks, and UI mounting. |
| Shared business service | `srv/creditService.js`, `srv/rules.js` | Data reads, risk calculations, aggregation, request validation, and approval transitions. |
| Portfolio data provider | `srv/portfolioDataProvider.js`, `srv/integrations/abap/` | Selects CAP or ABAP consistently for dashboard, customer, and monitoring reads. |
| Ingestion runtime | `srv/ingestionRuntime.js`, `srv/sourceRegistryStore.js`, `srv/connectorManager.js`, `srv/configuredConnectors.js`, `srv/ingestionService.js`, `srv/ingestionStore.js` | Trusted source configuration, read-only adapters, canonical mapping/validation, quality assessment, run audit, and transaction-safe snapshot promotion. |
| Canonical data | `srv/canonicalData.js`, `db/schema.cds` | Decimal-string financial contracts, provenance, source records, quality issues, checkpoints, and source locks. |
| Credit monitoring | `srv/monitoringService.js`, `srv/monitoringStore.js`, `srv/monitoringWorker.js`, `srv/monitoringSummary.js` | Durable queue, atomic single-portfolio claims, deadline-bounded read-only snapshots, findings, deduplicated alerts, and advisory summaries. |
| Agent and model adapter | `srv/agent.js`, `srv/llm.js`, `srv/agentStore.js` | Validated tools, bounded execution, optional provider, and scoped execution/conversation history. |
| Document extraction | `srv/documents.js` | In-memory extraction of PDF, DOCX, and UTF-8 TXT content. |
| ABAP connector | `srv/integrations/abap/` | Destination lookup, OData requests, validation, pagination, and normalization. |
| Cloud Foundry deployment | `mta.yaml`, `approuter/`, `xs-security.json` | MTA modules, XSUAA, HANA, Destination service, and App Router configuration. |

## Data flow and profiles

The local development profile uses CAP mock users, in-memory SQLite, and the synthetic CSV fixtures. `npm run start:persistent` selects a local SQLite file. The production profile is configured for HANA and XSUAA and has a startup guard for expected HANA, XSUAA, and Destination service bindings.

The dashboard, REST customer APIs, and monitoring use the same selected portfolio provider. Local profiles default to CAP fixtures; setting `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` selects the read-only Destination-backed provider. The production MTA selects ABAP. This keeps dashboard and monitoring results aligned, but live ABAP connectivity and HANA behavior have not been validated.

Monitoring requests persist queued runs and return HTTP 202. The CAP process polls HANA and claims work using a singleton portfolio lock, run lease, and claim token; jobs therefore survive process restarts and expired leases can be reclaimed without overlapping scans across service instances. A worker-side deadline is propagated to ABAP requests and pagination, while optional aggregate AI advisories have a separate timeout. Deterministic findings remain authoritative. BTP Job Scheduling is bound and a protected idempotent trigger exists, but an external recurring job, interval, OAuth configuration, and service-role assignment still require deployment provisioning. No email, SMS, or push channel is configured.

## Universal ingestion

Source metadata lives in `credit.DataSources`; secrets and actual endpoints are resolved outside registry records. `createConfiguredIngestionRuntime()` reads trusted source mappings from `cds.requires.creditGuardIngestion.sources`. REST credentials are looked up only through SAP Destination references, SQL connections must name an existing CAP service, and file reads must stay beneath one of the configured `approvedRepositoryRoots`. Source configuration is not installed in the current repository/deployment descriptor, so a refresh with no mapping produces a persisted `FAILED` run instead of a success-shaped empty snapshot.

The connector layer has test coverage with synthetic data. The SAP adapter reuses the existing ABAP client and currently maps only the existing `Customers` collection; live SAP connectivity and business field mappings remain unverified. CSV, JSON, and flat XML are parsed in-process; XLSX is unavailable until an approved parser is configured. REST and SQL adapters enforce allowlists and use GET/CAP SELECT operations respectively. Ingestion uses bounded pages, record sizes, retries, deadlines, cancellation, idempotency, and a per-source lease.

Canonical records and provenance are persisted transactionally. A failed, partial, conflicting, or empty run cannot replace a promoted snapshot. Stale or timestamp-unknown snapshots are marked ineligible. Incremental retrieval is not promoted because universal merge and deletion/tombstone semantics are not configured. Snapshot status is available through the ingestion API and the portfolio provider, but current dashboard, agent, and monitoring reads continue using their existing local/ABAP paths; no canonical data is fed to existing floating-point credit calculations. Customer crosswalks, cross-entity snapshot consistency, and approved credit-use mappings require client confirmation before that integration.

## Entry points and commands

- Local development: `npm run dev` (`cds watch`, port 4005).
- CAP service: `srv/server.js`, registered through CAP bootstrap.
- Frontend entry: `app/credit/index.html` and `app/credit/js/main.js`.
- CAP model: `db/schema.cds` and `srv/service.cds`.
- Tests: `npm test` (`node --test`).
- Cloud Foundry build: `npm run build:cf`, called as part of the MTA build.

## Architectural boundaries

Business calculations belong in `srv/rules.js`, not in the browser or LLM. HTTP handlers use `srv/creditService.js` for shared operations. The agent has no tool for deciding requests or directly changing credit limits. The ABAP connector is separate from the local provider and currently read-only.

## Operational limits

The seed portfolio is synthetic and small. Local in-memory data resets on restart. Conversation memory is disabled unless explicitly enabled. Scheduled monitoring depends on external Job Scheduler provisioning; alerts are in-app only. Deployment configuration is not evidence of a successful BTP deployment.
