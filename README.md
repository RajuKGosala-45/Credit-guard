# Credit Guard

Credit Guard is a Node.js and SAP CAP demonstration application for reviewing customer credit exposure, overdue items, and credit-limit requests. Its included portfolio is synthetic. The application is not a production credit-decisioning system.

## 1. Project Overview

The project combines a browser dashboard, a CAP/Express backend, deterministic credit rules, a bounded AI assistant, and a read-only SAP ABAP connector. Local development uses synthetic CSV data and an in-memory SQLite database.

## 2. Business Problem

Credit teams need a clear view of customer exposure, approaching limits, overdue balances, and requests awaiting human review. Credit Guard demonstrates those workflows using a small, reproducible portfolio.

## 3. Project Objectives

- Present consistent customer and portfolio risk calculations.
- Support credit-limit requests and auditable human decisions.
- Let an assistant retrieve portfolio information and prepare proposals without approving them.
- Provide a testable, read-only integration boundary for a custom ABAP OData service.

## 4. Key Features

- Portfolio KPIs and exposure groupings.
- Customer summaries, details, open items, synthetic payment history, and risk indicators.
- Limit request submission, approval routing, rejection, and decision history.
- Tool-assisted chat with offline behavior when no model key is configured.
- Optional PDF, DOCX, and UTF-8 TXT text extraction.
- Read-only credit monitoring runs, persisted findings, and in-app alerts.
- Local CAP SQLite profiles and Cloud Foundry/HANA/XSUAA configuration.
- A read-only ABAP OData V4 connector and custom RAP source artifacts.

## 5. System Architecture

```text
Browser (plain HTML, CSS, JavaScript)
  └─ /credit UI ── /api REST routes ── CAP services and SQLite/HANA
                                  ├── shared credit rules
                                  ├── bounded agent and LLM provider
                                  ├── HANA-backed monitoring queue and worker
                                  ├── findings, alerts, and run-status polling
                                  └── optional ABAP provider
                                       └── SAP Cloud SDK Destination
                                           └── custom ABAP OData service
```

CAP hosts the application and database model. Express routes serve the UI and custom JSON API. `srv/creditService.js` and `srv/rules.js` provide shared calculation and approval behavior. The frontend does not contain a separate framework or build pipeline.

See [System architecture](docs/architecture/SYSTEM_ARCHITECTURE.md) for runtime profiles and data flow.

## 6. Technology Stack

- Node.js, Express, and SAP Cloud Application Programming Model (CAP).
- CDS data model with SQLite for local profiles and HANA configuration for Cloud Foundry.
- Plain HTML, CSS, and JavaScript ES modules.
- SAP Cloud SDK connectivity and HTTP client for Destination-based ABAP calls.
- Node.js built-in test runner (`node:test`).
- Optional Anthropic and Gemini provider adapters; neither is required for offline demo mode.

## 7. Repository Structure

```text
app/credit/                 Browser UI
db/                         CDS model and synthetic local CSV data
srv/                        CAP/Express services, rules, agent, integrations
abap/adt/                   Custom ABAP source and ADT setup guide
approuter/                  SAP App Router configuration
tests/                      Unit, integration, and contract tests
docs/                       Current guides and archived milestone reports
mta.yaml                    Cloud Foundry multi-target application descriptor
xs-security.json            XSUAA scopes and role templates
```

CAP paths remain in their conventional locations. See the [full architecture guide](docs/architecture/SYSTEM_ARCHITECTURE.md).
The repository-wide implementation and verification notes are in [COPILOT_PROJECT_HANDOVER.md](COPILOT_PROJECT_HANDOVER.md).

## 8. Application Workflow

The local application loads seeded customer and open-item records through CAP. The dashboard and customer APIs use the shared calculation service. A requester can submit a limit proposal. The request is routed to a human approver; only an authorized decision can update the local customer limit. The current workflow does not write credit changes to SAP.

See the [user guide](docs/user-guide/USER_GUIDE.md).

## 9. AI Agent Capabilities

The assistant can query customer and portfolio information, list pending requests, analyze extracted document text, and prepare a validated limit-request proposal. Tool execution is bounded and permission-checked. The agent cannot approve or reject requests. Offline mode uses deterministic responses and tools; natural-language model responses require an optional provider key.

Complex requests are decomposed into validated tasks and run sequentially through the trusted tool registry. Results are checked before completion; approved read-only tools may receive at most two bounded retries for transient errors. Progress and safe summaries are persisted for the authenticated owner. Eligible pending read-only work can be resumed through the execution API; completed tasks are not repeated, and uncertain running tasks require manual review. Proposal tasks are neither retried nor resumed automatically.

Credit monitoring reuses the configured portfolio provider and deterministic rules. It persists timestamped runs, findings, alert lifecycle events, and an in-app notification outbox. Monitoring is read-only and does not create, approve, or change credit requests. See [AI agent design](docs/ai-agent/AI_AGENT_DESIGN.md) and [API reference](docs/api/API_REFERENCE.md).

## 10. Credit Risk Calculation Rules

Exposure includes qualifying unpaid invoices and sales orders. Overdue amounts use valid due dates, not the source status alone. Utilization is a ratio in the existing API, with a percentage field for display. A zero limit requires manual review. Mixed currencies are not combined.

The precise rules, accepted source statuses, validation, flags, and remaining business assumptions are documented in [Credit risk rules](docs/business/CREDIT_RISK_RULES.md).

## 11. SAP Integration Architecture

The optional connector resolves a configured BTP Destination and reads the custom `Customers` and `OpenItems` OData collections. Connector behavior is tested with mocked responses. The repository includes proposed custom `Z*` RAP/OData source artifacts and synthetic fixtures.

No live ABAP tenant, BTP Destination, or SAP payload has been validated. These artifacts are not SAP standard objects. Read [SAP ABAP integration](docs/sap-integration/SAP_ABAP_INTEGRATION.md) and the [ADT setup guide](abap/adt/README.md).

## 12. Universal data ingestion

The additive ingestion layer provides a persistent source registry, canonical contracts, source adapters, validation, provenance, quality issues, run audit, bounded retries, and transactional snapshot promotion. Source administration and refresh are protected by `CreditAdmin`; readers can inspect source status, run details, and paginated canonical snapshots. It does not change the existing dashboard, credit rules, agent, or monitoring data selection.

Connector settings are trusted server configuration under `cds.requires.creditGuardIngestion.sources`, keyed by each registry entry's `configurationReference`. REST authentication resolves only SAP Destination references; SQL uses a named CAP connection already present in `cds.requires`; repository files must resolve beneath an explicitly approved repository root. Endpoints, SQL, file paths, and credentials are never accepted in registry requests. No source-specific mapping or repository configuration is currently installed, so ingestion records a failed run rather than returning a fake success. No live SAP request was made.

The ABAP ingestion adapter currently supports only the existing customer collection; it does not claim mappings for invoices, sales orders, or payments. XLSX ingestion fails explicitly until an approved parser is available. Incremental retrieval is not promoted because generic merge and deletion/tombstone semantics are not configured. Canonical snapshots are not yet consumed by portfolio decisions or monitoring; customer crosswalks, coherent multi-entity snapshots, and monetary policy mappings require client confirmation. See the [ingestion API](docs/api/API_REFERENCE.md#universal-ingestion) and [system architecture](docs/architecture/SYSTEM_ARCHITECTURE.md).

## 13. Security and Human Approval

The local development profile uses CAP mock identities and does not verify passwords. It is for local demonstration only. Production configuration expects XSUAA, HANA, and a Destination binding, but deployment and production authentication have not been verified.

The server derives permissions from the authenticated CAP identity. AI tools may prepare proposals but do not decide them. See [Security and authorization](docs/security/SECURITY_AND_AUTHORIZATION.md).

### Scheduled monitoring deployment

| Area | Current implementation and caveat |
|---|---|
| Scheduling | The MTA binds SAP BTP Job Scheduling and exposes a protected job trigger. An operator must still provision the recurring Job Scheduler job, interval, OAuth credentials, and role assignment in the target subaccount; no in-process timer is used. |
| Data and rules | The monitoring service uses the selected local or ABAP provider and existing deterministic credit rules. Production MTA configuration selects ABAP, which is also used by dashboard/customer read APIs. |
| Persistence and recovery | CDS/HANA entities store unique run slots, findings, alert state, event history, and recovery/outbox state. Conditional updates and unique constraints provide bounded claim/idempotency behavior, not a distributed transaction with the external scheduler. |
| Alerts | The dashboard exposes role-protected in-app alerts and lifecycle actions. There is no email, SMS, or push-notification provider configured. |

## 14. Installation and Setup

Prerequisites: Node.js 22 LTS and npm are required for both the CAP application and the separate App Router.

```powershell
npm.cmd ci
npm.cmd run dev
```

For non-Windows shells, use `npm ci` and `npm run dev`. Optional environment settings are listed in `.env.example`; copy it to a local `.env` only if you need to configure the optional model provider. Never put real credentials in a tracked file.

## 15. Environment Configuration

The assistant supports `anthropic`, `gemini`, and `offline` through `LLM_PROVIDER` (default: `anthropic`). It runs offline when the selected provider's API key is unset. Configure `ANTHROPIC_API_KEY` for Anthropic or `GEMINI_API_KEY` for Gemini. `LLM_MODEL` optionally overrides the selected provider's model; leave it unset to use the provider's built-in default. `LLM_TIMEOUT_MS` and optional memory settings are also documented in [Deployment and configuration](docs/deployment/DEPLOYMENT_GUIDE.md). Keep API keys in an untracked local `.env` or a secret manager, never in tracked files. The ABAP connector reads its Destination name and OData paths from environment variables; local use still requires a resolvable Destination configuration.

## 16. Running the Application

Run `npm.cmd run dev` from the repository root and open [http://localhost:4005/credit/index.html](http://localhost:4005/credit/index.html). If prompted, use the local mock identity `administrator` with password `test` to run monitoring and prepare limit proposals, or `reader` to inspect data. Other configured identities include `requester`, `controller`, `finance`, `analyst`, `manager`, `approver`, and `monitor`. The mock does not validate passwords; these values are only for local development.

The persistent local profile is available with `npm.cmd run start:persistent`. It writes a local SQLite database, which is ignored by Git. See the [user guide](docs/user-guide/USER_GUIDE.md) for the UI workflow.

### Practical demo walkthrough

The local CSV portfolio contains 13 clearly simulated INR customers with credit limits, invoices/sales orders, overdue invoices, and posted payment history. Credit limits are represented on the customer records in this demo; this is not a separate local credit-account table. The data is not SAP data, and the demo makes no SAP calls. On the Portfolio tab:

1. Review the portfolio totals and freshness label (`UNKNOWN` for the local data source).
2. Select a customer row to inspect exposure, due-date-based invoice status, and payment history. Examples include C005 at exactly 80%, C013 at exactly 100%, and C001 at exactly 120%.
3. Use **Run monitoring** as `administrator` or `monitor`. The run is manual; no automatic schedule is claimed. Review findings, alerts, and run history.
4. Open **Credit assistant** and select **Analyze latest monitoring run** to get a findings-grounded portfolio summary and customer control recommendations. The offline demo uses persisted monitoring findings and works without an AI provider key.
5. To see the approval hand-off, ask the assistant: `Prepare a credit limit request for C003 to INR 1,200,000 because renewed supply contract.` The assistant prepares a proposal only. The user must explicitly submit it and an authorized human must decide it; no AI action changes a limit or creates a posting.

Run `npm.cmd run build` to validate and package the CAP application for the demo build.

## 17. Running Tests

```powershell
npm.cmd test
```

The suite uses Node’s built-in test runner. Tests use synthetic records and mocks unless explicitly described otherwise. The live ABAP smoke test is opt-in and skipped by default. See [Testing guide](docs/testing/TESTING_GUIDE.md).

## 18. API Overview

The authenticated JSON API includes dashboard and customer reads, monitoring runs/findings/alerts, limit-request creation and decisions, approval history, chat, document analysis, agent history, and owner-scoped execution retrieval/recovery. CAP also exposes read-only `CreditService` projections under `/odata/v4/credit`.

See [API reference](docs/api/API_REFERENCE.md) for routes, authorization, payloads, and response behavior.

## 19. Current Limitations

- Seed data is synthetic and small; local development is not connected to SAP.
- The ABAP service has not been activated or live-tested. Connector tests use mocks.
- Credit exposure and overdue semantics are demo rules and require business-owner confirmation before real decisions.
- HANA, XSUAA, App Router sign-in, Cloud Foundry deployment, recovery, and production operations are configured or documented but not validated in a deployed environment.
- A BTP Job Scheduler binding and protected trigger are present, but the recurring job and service-role assignment must be provisioned externally. External email/SMS/push delivery is not configured.
- The ABAP connector and BTP deployment have not been validated against a live tenant. Source timestamps are unknown unless the upstream service supplies them.
- Payment history is synthetic local demo data only; the ABAP provider has no payment mapping. The monitoring workflow does not execute credit actions.
- Anthropic and Gemini LLM adapters are implemented; live provider use requires the corresponding server-side API key.

## 20. Future Enhancements

Next, provision and validate the external BTP Job Scheduler job, verify service-role assignment and authenticated ABAP access in a non-production environment, and select any approved external notification channel. Any SAP write-back requires a separate approved business and authorization design.

## Documentation

Current guides live in [`docs/`](docs/). Earlier milestone reports are retained as point-in-time records in [`docs/archive/reports/`](docs/archive/reports/); their findings may have been superseded by current code and guides.
