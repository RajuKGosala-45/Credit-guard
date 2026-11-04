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
   ├── monitoringService.js ── monitoringStore.js ── CDS/HANA
   └── portfolioDataProvider.js ── CAP or read-only ABAP
   └── CAP database ── SQLite locally / HANA in configured production profile
```

## Components

| Component | Location | Responsibility |
|---|---|---|
| Browser interface | `app/credit/` | Portfolio, customers, requests/approvals, monitoring, assistant, and document UI. |
| CDS data model | `db/schema.cds` | Customers, open items, requests, agent history, and monitoring runs/findings/alerts/events/outbox. |
| Local fixtures | `db/data/` | Synthetic CSV customers and open items loaded by CAP. |
| CAP OData | `srv/service.cds` | Reader-protected, read-only `CreditService` projections. |
| REST and static hosting | `srv/server.js` | API routes, authentication gates, health checks, and UI mounting. |
| Shared business service | `srv/creditService.js`, `srv/rules.js` | Data reads, risk calculations, aggregation, request validation, and approval transitions. |
| Portfolio data provider | `srv/portfolioDataProvider.js`, `srv/integrations/abap/` | Selects CAP or ABAP consistently for dashboard, customer, and monitoring reads. |
| Credit monitoring | `srv/monitoringService.js`, `srv/monitoringStore.js`, `srv/monitoringSummary.js` | Read-only snapshots, persisted findings, deduplicated alerts, bounded recovery, and minimized advisory summaries. |
| Agent and model adapter | `srv/agent.js`, `srv/llm.js`, `srv/agentStore.js` | Validated tools, bounded execution, optional provider, and scoped execution/conversation history. |
| Document extraction | `srv/documents.js` | In-memory extraction of PDF, DOCX, and UTF-8 TXT content. |
| ABAP connector | `srv/integrations/abap/` | Destination lookup, OData requests, validation, pagination, and normalization. |
| Cloud Foundry deployment | `mta.yaml`, `approuter/`, `xs-security.json` | MTA modules, XSUAA, HANA, Destination service, and App Router configuration. |

## Data flow and profiles

The local development profile uses CAP mock users, in-memory SQLite, and the synthetic CSV fixtures. `npm run start:persistent` selects a local SQLite file. The production profile is configured for HANA and XSUAA and has a startup guard for expected HANA, XSUAA, and Destination service bindings.

The dashboard, REST customer APIs, and monitoring use the same selected portfolio provider. Local profiles default to CAP fixtures; setting `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` selects the read-only Destination-backed provider. The production MTA selects ABAP. This keeps dashboard and monitoring results aligned, but live ABAP connectivity and HANA behavior have not been validated.

Monitoring applies the existing deterministic credit rules, persists run snapshots and alert lifecycle events, and surfaces alerts in the dashboard. AI summaries are optional aggregate-only advisories. BTP Job Scheduling is bound and a protected idempotent trigger exists, but an external recurring job, interval, OAuth configuration, and service-role assignment still require deployment provisioning. No email, SMS, or push channel is configured.

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
