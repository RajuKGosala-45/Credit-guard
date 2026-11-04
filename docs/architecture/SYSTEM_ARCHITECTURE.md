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
   └── CAP database ── SQLite locally / HANA in configured production profile
```

## Components

| Component | Location | Responsibility |
|---|---|---|
| Browser interface | `app/credit/` | Portfolio, customers, requests/approvals, assistant, and document UI. |
| CDS data model | `db/schema.cds` | Customers, open items, requests, decision history, and agent history. |
| Local fixtures | `db/data/` | Synthetic CSV customers and open items loaded by CAP. |
| CAP OData | `srv/service.cds` | Reader-protected, read-only `CreditService` projections. |
| REST and static hosting | `srv/server.js` | API routes, authentication gates, health checks, and UI mounting. |
| Shared business service | `srv/creditService.js`, `srv/rules.js` | Data reads, risk calculations, aggregation, request validation, and approval transitions. |
| Agent and model adapter | `srv/agent.js`, `srv/llm.js`, `srv/agentStore.js` | Validated tools, bounded execution, optional provider, and scoped execution/conversation history. |
| Document extraction | `srv/documents.js` | In-memory extraction of PDF, DOCX, and UTF-8 TXT content. |
| ABAP connector | `srv/integrations/abap/` | Destination lookup, OData requests, validation, pagination, and normalization. |
| Cloud Foundry deployment | `mta.yaml`, `approuter/`, `xs-security.json` | MTA modules, XSUAA, HANA, Destination service, and App Router configuration. |

## Data flow and profiles

The local development profile uses CAP mock users, in-memory SQLite, and the synthetic CSV fixtures. `npm run start:persistent` selects a local SQLite file. The production profile is configured for HANA and XSUAA and has a startup guard for expected HANA, XSUAA, and Destination service bindings.

The normal dashboard and REST customer APIs read the CAP database. Agent customer tools select the local provider by default and can select the ABAP provider by configuration. Selecting ABAP for the agent does not automatically replace dashboard data. Production deployment, live ABAP connectivity, and HANA behavior have not been validated.

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

The seed portfolio is synthetic and small. Local in-memory data resets on restart. Conversation memory is disabled unless explicitly enabled. The application has no scheduled monitoring or outbound alert delivery. Deployment configuration is not evidence of a successful BTP deployment.
