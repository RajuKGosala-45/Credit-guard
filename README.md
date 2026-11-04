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
- Customer summaries, details, open items, and risk indicators.
- Limit request submission, approval routing, rejection, and decision history.
- Tool-assisted chat with offline behavior when no model key is configured.
- Optional PDF, DOCX, and UTF-8 TXT text extraction.
- Local CAP SQLite profiles and Cloud Foundry/HANA/XSUAA configuration.
- A read-only ABAP OData V4 connector and custom RAP source artifacts.

## 5. System Architecture

```text
Browser (plain HTML, CSS, JavaScript)
  └─ /credit UI ── /api REST routes ── CAP services and SQLite/HANA
                                  ├── shared credit rules
                                  ├── bounded agent and LLM provider
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
- Optional Anthropic provider adapter; it is not required for offline demo mode.

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

## 8. Application Workflow

The local application loads seeded customer and open-item records through CAP. The dashboard and customer APIs use the shared calculation service. A requester can submit a limit proposal. The request is routed to a human approver; only an authorized decision can update the local customer limit. The current workflow does not write credit changes to SAP.

See the [user guide](docs/user-guide/USER_GUIDE.md).

## 9. AI Agent Capabilities

The assistant can query customer and portfolio information, list pending requests, analyze extracted document text, and prepare a validated limit-request proposal. Tool execution is bounded and permission-checked. The agent cannot approve or reject requests. Offline mode uses deterministic responses and tools; natural-language model responses require an optional provider key.

Complex requests are decomposed into validated tasks and run sequentially through the trusted tool registry. Results are checked before completion; approved read-only tools may receive at most two bounded retries for transient errors. Progress and safe summaries are persisted for the authenticated owner. Eligible pending read-only work can be resumed through the execution API; completed tasks are not repeated, and uncertain running tasks require manual review. Proposal tasks are neither retried nor resumed automatically.

There is no background scheduler or autonomous portfolio monitor. See [AI agent design](docs/ai-agent/AI_AGENT_DESIGN.md).

## 10. Credit Risk Calculation Rules

Exposure includes qualifying unpaid invoices and sales orders. Overdue amounts use valid due dates, not the source status alone. Utilization is a ratio in the existing API, with a percentage field for display. A zero limit requires manual review. Mixed currencies are not combined.

The precise rules, accepted source statuses, validation, flags, and remaining business assumptions are documented in [Credit risk rules](docs/business/CREDIT_RISK_RULES.md).

## 11. SAP Integration Architecture

The optional connector resolves a configured BTP Destination and reads the custom `Customers` and `OpenItems` OData collections. Connector behavior is tested with mocked responses. The repository includes proposed custom `Z*` RAP/OData source artifacts and synthetic fixtures.

No live ABAP tenant, BTP Destination, or SAP payload has been validated. These artifacts are not SAP standard objects. Read [SAP ABAP integration](docs/sap-integration/SAP_ABAP_INTEGRATION.md) and the [ADT setup guide](abap/adt/README.md).

## 12. Security and Human Approval

The local development profile uses CAP mock identities and does not verify passwords. It is for local demonstration only. Production configuration expects XSUAA, HANA, and a Destination binding, but deployment and production authentication have not been verified.

The server derives permissions from the authenticated CAP identity. AI tools may prepare proposals but do not decide them. See [Security and authorization](docs/security/SECURITY_AND_AUTHORIZATION.md).

## 13. Installation and Setup

Prerequisites: Node.js 20 LTS is recommended for the CAP application, with npm. The separate App Router manifest requires Node.js 22 or 24.

```powershell
npm.cmd ci
npm.cmd run dev
```

For non-Windows shells, use `npm ci` and `npm run dev`. Optional environment settings are listed in `.env.example`; copy it to a local `.env` only if you need to configure the optional model provider. Never put real credentials in a tracked file.

## 14. Environment Configuration

The assistant runs offline by default when `ANTHROPIC_API_KEY` is unset. Provider, model, timeout, and optional memory settings are described in [Deployment and configuration](docs/deployment/DEPLOYMENT_GUIDE.md). The ABAP connector reads its Destination name and OData paths from environment variables; local use still requires a resolvable Destination configuration.

## 15. Running the Application

Run `npm.cmd run dev` from the repository root and open [http://localhost:4005/credit/index.html](http://localhost:4005/credit/index.html). If prompted, use the local mock identity `reader` with password `test`. Other configured identities are `requester`, `controller`, `finance`, `analyst`, `manager`, `approver`, and `administrator`. The mock does not validate passwords; these values are only for local development.

The persistent local profile is available with `npm.cmd run start:persistent`. It writes a local SQLite database, which is ignored by Git. See the [user guide](docs/user-guide/USER_GUIDE.md) for the UI workflow.

## 16. Running Tests

```powershell
npm.cmd test
```

The suite uses Node’s built-in test runner. Tests use synthetic records and mocks unless explicitly described otherwise. The live ABAP smoke test is opt-in and skipped by default. See [Testing guide](docs/testing/TESTING_GUIDE.md).

## 17. API Overview

The authenticated JSON API includes dashboard and customer reads, limit-request creation and decisions, approval history, chat, document analysis, agent history, and owner-scoped execution retrieval/recovery. CAP also exposes read-only `CreditService` projections under `/odata/v4/credit`.

See [API reference](docs/api/API_REFERENCE.md) for routes, authorization, payloads, and response behavior.

## 18. Current Limitations

- Seed data is synthetic and small; local development is not connected to SAP.
- The ABAP service has not been activated or live-tested. Connector tests use mocks.
- Credit exposure and overdue semantics are demo rules and require business-owner confirmation before real decisions.
- HANA, XSUAA, App Router sign-in, Cloud Foundry deployment, recovery, and production operations are configured or documented but not validated in a deployed environment.
- There is no scheduled monitoring, alert delivery, payment-history model, or autonomous action execution.
- Only the Anthropic LLM adapter is implemented.

## 19. Future Enhancements

After confirming business semantics and obtaining a non-production SAP environment: validate the ABAP service contract, test authenticated Destination connectivity, define data freshness and source-of-truth behavior, add scheduled risk monitoring and alert history, and validate deployment and recovery procedures. Any SAP write-back requires a separate approved business and authorization design.

## Documentation

Current guides live in [`docs/`](docs/). Earlier milestone reports are retained as point-in-time records in [`docs/archive/reports/`](docs/archive/reports/); their findings may have been superseded by current code and guides.
