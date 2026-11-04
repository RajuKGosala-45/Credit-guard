# Credit Guard

Credit Guard is a runnable SAP Cloud Application Programming Model (CAP) demo for monitoring customer credit exposure and handling credit-limit requests. The sample portfolio represents Bluspring Enterprises and uses synthetic INR-denominated data.

The application combines a browser-based portfolio dashboard, a CAP/Express JSON API, configurable SQLite/HANA persistence, document text extraction, and a bounded AI agent. The agent can inspect portfolio data and prepare proposals; a user must explicitly submit them, and a separately authorized human approver must decide them.

> **Demo only:** This project is not a production credit-decisioning system. Data is synthetic. Development uses CAP mock identities; production requires a configured CAP JWT/XSUAA identity provider and deployment-level browser sign-in.

## Contents

- [Features](#features)
- [Architecture and project layout](#architecture-and-project-layout)
- [Prerequisites and setup](#prerequisites-and-setup)
- [Run and open the application](#run-and-open-the-application)
- [Portfolio and credit rules](#portfolio-and-credit-rules)
- [Using the application](#using-the-application)
- [Credit assistant](#credit-assistant)
- [Document analysis](#document-analysis)
- [API reference](#api-reference)
- [Data model and seed data](#data-model-and-seed-data)
- [Demo walkthrough](#demo-walkthrough)
- [Testing and verification](#testing-and-verification)
- [Troubleshooting](#troubleshooting)
- [Limitations and security notes](#limitations-and-security-notes)

## Features

- Portfolio KPIs and exposure breakdowns by country, company code, or customer.
- Customer exposure, credit limit, utilisation, overdue amount, risk class, open items, and risk flags.
- Limit-change requests routed to a Credit Controller or Finance Head.
- Human approval and rejection workflow with decision history.
- Credit assistant with portfolio lookup tools, customer recommendations, and pending-request summaries.
- Optional document analysis for PDF, DOCX, and UTF-8 TXT files.
- Offline deterministic assistant mode when no Anthropic API key is configured.

## Architecture and project layout

```text
app/credit/                 Browser UI (HTML, CSS, ES modules)
  css/                      Design tokens, base styles, layout, components
  js/                       API client, state, event wiring, and view modules
db/
  schema.cds                Credit entities, approval audit, and agent history
  data/                     CSV seed data loaded by CAP
srv/
  service.cds               OData CreditService projections
  server.js                 REST endpoints and static UI hosting
  creditService.js          Shared credit calculations and request/approval workflows
  rules.js                  Shared risk classification and approval-routing rules
  agent.js                  Bounded agent controller and permission-checked tools
  llm.js                    Provider abstraction and Anthropic adapter
  agentStore.js             User-scoped conversation and execution history
  documents.js              PDF/DOCX/TXT extraction and text-length limit
abap/adt/
  source/                   Custom read-only RAP/OData CDS source for a demo ABAP tenant
  test-data/                Explicitly synthetic customer and open-item CSV fixtures
xs-security.json            XSUAA scopes and role templates
.env.example                Optional environment variable template
package.json                Scripts and dependencies
```

The shared credit service is used by both REST endpoints and agent tools so calculations, request validation, and decision rules do not diverge. CAP hosts the custom API under `/api`, the UI under `/credit`, and the OData service under `/odata/v4/credit`.

The development profile uses in-memory SQLite and CAP mock identities. `npm.cmd run start:persistent` selects a local SQLite database at `credit-guard.sqlite`; back up that file before upgrades and do not treat it as a production backup strategy. The production profile is configured for HANA and XSUAA, but deployment bindings, BTP role-collection assignments, browser SSO/approuter configuration, backups, and production operation have not been provisioned or validated. No database migration or live SAP integration is included.

The frontend is plain HTML, CSS, and JavaScript modules; it does not require a separate frontend build step. Its initial load requests dashboard totals and customers, and it loads approval requests when the Approvals tab is opened.

The ABAP source in [`abap/adt/README.md`](../../../abap/adt/README.md) is a proposed custom `Z*` service contract for a non-production ABAP Environment tenant. It is not SAP standard content and has not been activated or connected to an ABAP system. The service is read-only and the supplied CSV records are synthetic.

## Prerequisites and setup

- Windows and **Node.js 20 LTS** are recommended. The SQLite native dependency may not work reliably with newer Node versions.
- npm, included with Node.js.
- Dependencies are already installed in this workspace; for a fresh checkout, install them with `npm.cmd install`.
- An Anthropic API key is optional. No external service is required for offline mode.

From PowerShell:

```powershell
Set-Location 'C:\Users\HP\Documents\Credit-guard'
node --version
npm.cmd install
npm.cmd run dev
```

The development server runs on port `4005`. It watches the CAP project and reloads the server when backend files change. Keep this terminal open while using the app; press **Ctrl+C** in that terminal to stop it.

The development profile prompts for HTTP Basic sign-in when opening the UI. Use one of the server-configured mock identities: `reader`, `requester`, `controller`, `finance`, `analyst`, `manager`, `approver`, or `administrator`. These identities have fixed server-side roles; the development mock does not verify passwords and is not suitable for production. The browser's authentication cache is used for same-origin API requests. The production XSUAA role templates are defined in `xs-security.json`; a deployed environment still needs correct service bindings and user role collections.

To run against the local persistent profile, use a separate terminal and stop it with **Ctrl+C**:

```powershell
npm.cmd run start:persistent
```

This keeps demo data and approvals across restarts in a local file, not in a managed production database. Do not copy production data into this profile or delete/replace an existing database file during an upgrade.

### Optional Anthropic configuration

Create a local `.env` from the template, then add a key if live model responses are desired:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `ANTHROPIC_API_KEY` and, optionally, `LLM_MODEL`. The default model name is `claude-sonnet-5-5`. Never commit `.env` or share its contents. Without a key, requests use offline demo mode. With a key, chat and extracted document text are sent to Anthropic.

## Run and open the application

After `npm.cmd run dev` reports that the server is listening, open:

**[http://localhost:4005/credit/index.html](http://localhost:4005/credit/index.html)**

Other useful local URLs:

- CAP landing page: [http://localhost:4005/](http://localhost:4005/)
- OData service: [http://localhost:4005/odata/v4/credit/](http://localhost:4005/odata/v4/credit/)
- Dashboard API: [http://localhost:4005/api/dashboard](http://localhost:4005/api/dashboard)

On startup, the terminal should report successful deployment to the in-memory database, seeded CSV files, and a server listening on port `4005`. The initial dashboard should show 12 customers, total exposure of INR 55,35,000, total credit limit of INR 94,00,000, overall utilisation of about 58.9%, and 2 customers above their credit limits.

## Portfolio and credit rules

### Exposure and utilisation

- Exposure includes unpaid `Invoice` and `SalesOrder` items whose status is `Open` or `Overdue`. Paid, closed, cancelled, and unsupported item types/statuses do not consume credit. Duplicate records with the same item ID are counted once; conflicting duplicate records are rejected.
- An item is overdue only when it is credit-consuming and its valid due date is earlier than the current business date. Missing or invalid due dates do not qualify as overdue. The source `Overdue` status does not override the due-date check.
- The business date currently uses the server's UTC calendar date; confirm the business timezone before using non-demo data.
- Utilisation is calculated as `(exposure / creditLimit) * 100` for display. The existing API `utilisation` field remains a ratio (for example, `0.8` means 80%) for compatibility; `utilisationPercent` carries the percentage value. A zero limit produces `null` utilisation, never `Infinity` or `NaN`, and requires `MANUAL_REVIEW`.
- Overdue share is `overdueAmount / exposure`, or zero when exposure is zero.
- Amounts must be finite and non-negative. Exposure is not combined across currencies; mixed-currency portfolio totals are returned by currency rather than as one misleading total. The current seed portfolio is synthetic INR data, not live ERP data.

### Status thresholds

The shared rules in `srv/rules.js` apply these thresholds:

| Condition | Flag/status |
|---|---|
| Credit limit is zero, with or without exposure | `MANUAL_REVIEW` status and `NO_LIMIT` flag |
| Exposure is greater than the credit limit | `BREACH` status; `CRITICAL` flag is retained above 120% |
| Utilisation is at least 80% and exposure does not exceed the limit | `WARNING` |
| Utilisation is below 80% | `HEALTHY` |
| Overdue items exceed 30% of exposure | `OVERDUE_RISK` flag |
| Last review is more than 12 months old | `STALE_REVIEW` flag |

Exactly 100% utilisation is `WARNING`; only exposure greater than the limit is `BREACH`. The main status priority is `MANUAL_REVIEW`, `BREACH`, `WARNING`, then `HEALTHY`. Overdue and stale-review flags can accompany any main status. A review exactly 12 months old is not stale; overdue share must be strictly greater than 30%.

### Approval routing

For a limit increase, calculate the increase over the current limit. The request routes to **Credit Controller** when the increase is at most 25% of the current limit **or** at most INR 5,00,000. Otherwise it routes to **Finance Head**. Decreases are accepted as requests and route to the controller.

- A Credit Controller may decide controller-routed requests only.
- A Finance Head may decide requests routed to either role.
- Approval updates the customer's limit and request status; rejection only updates the request.
- Agent proposals are validated and prepared only. The user must explicitly submit a proposal as a normal request; the AI agent cannot approve or reject it.

## Using the application

### Portfolio

The Portfolio tab displays KPI cards and exposure groupings. Use the Country, Company code, and Customer controls to change the grouping. Select a customer row to inspect its open items and review date. Select **Explain & recommend** to ask the assistant about that customer.

### Limit requests and approvals

1. In Portfolio, select a customer, enter a positive new credit limit, and provide a business reason.
2. Submit the request. The UI shows the assigned approver role.
3. Open Approvals to review pending requests and decision history.
4. The approver role comes from the authenticated server identity, never from frontend input or the request body. Use a separate browser profile/private window authenticated as `controller` or `finance` to decide a request created by another user. If the authenticated role is insufficient, the API refuses the decision.

### Credit assistant

Open the Credit assistant tab and ask questions such as:

- `What customers are above 80% utilisation?`
- `Explain and recommend whether to increase the limit for C001.`
- `How many requests are pending?`
- `Create a pending limit request for C001 with a new limit of 1200000 because of a renewed contract.`

Offline mode is deterministic: it supports customer lookups, pending-request summaries, threshold listings, and document extraction/matching. It is not a language model and may not interpret arbitrary questions. With an Anthropic key, the model can use the same permission-checked database tools through a provider interface. The controller limits a chat request to six agent steps, twelve tool calls, and a 20-second execution timeout; provider calls have a separate timeout. Provider failure falls back to the deterministic response and is shown in execution metadata.

When `AGENT_MEMORY_ENABLED=true`, conversation messages and execution summaries are stored with user ownership. It is off by default. Users can inspect and clear their own conversation and execution history; approval audit history is immutable and is not cleared with agent history. Raw tool arguments/results and uploaded document text are not persisted in agent history.

### Document analysis

Choose a PDF, DOCX, or UTF-8 TXT file up to 10 MB in the assistant panel, then select **Read and analyze**. Follow-up questions use the extracted document text until **Remove document** is selected. Extraction and chat context are held in memory; the app does not save uploaded files. Only the first 20,000 characters are passed for analysis. Scanned/image-only PDFs need OCR before upload.

## API reference

All custom API responses use JSON. Errors have the shape `{ "error": "..." }`. Request bodies for JSON endpoints use `Content-Type: application/json`, except document upload, which uses multipart form data.

| Method and path | Purpose |
|---|---|
| `GET /api/dashboard` | KPIs and exposure groupings |
| `GET /api/customers` | Customer summaries with calculated risk fields |
| `GET /api/customers/:id` | One customer summary and its open items |
| `GET /api/limit-requests` | All requests, newest first |
| `GET /api/limit-requests?status=Pending` | Filter requests by `Pending`, `Approved`, or `Rejected` |
| `POST /api/limit-requests` | Create a pending limit request |
| `POST /api/limit-requests/:id/decision` | Approve or reject a pending request |
| `GET /api/limit-requests/:id/history` | Read immutable decision audit entries |
| `POST /api/chat` | Send a message, optionally with browser-held document context |
| `POST /api/documents/analyze` | Extract and analyze multipart field `document` |
| `GET /api/agent/history` | List the authenticated user's conversations and execution summaries |
| `GET /api/agent/conversations/:id` | Read one owned conversation |
| `DELETE /api/agent/conversations/:id` | Clear one owned conversation |
| `DELETE /api/agent/history` | Clear the authenticated user's agent history |
| `GET /api/agent/executions` | List the authenticated user's execution summaries |

### Request examples

Create a request:

```json
{
  "customerId": "C001",
  "requestedLimit": 1200000,
  "reason": "Renewed customer contract"
}
```

Decide a request:

```json
{
  "decision": "Approved",
  "reason": "Reviewed against the renewed contract."
}
```

Decision reasons are required and limited to 500 characters.

`requestedBy`, `role`, and `decidedBy` values supplied by clients are not trusted. The server records the authenticated CAP identity and derives its roles from the configured identity provider.

Send a chat message:

```json
{
  "message": "Explain C001"
}
```

The OData `CreditService` exposes the `Customers`, `OpenItems`, and `LimitRequests` projections at `/odata/v4/credit`. The custom API is the interface used by the demo frontend.

## Data model and seed data

The CDS model defines:

- **Customers**: ID, name, country, company code, credit limit, risk class, and last review date.
- **OpenItems**: ID, associated customer, item type, amount, due date, and status.
- **LimitRequests**: ID, associated customer, current/requested limit, reason, requester, status, approver level, decision maker, and timestamps.
- **ApprovalHistory**: append-only requester/approver identities, transition, decision reason, and timestamp.
- **AgentConversations / AgentMessages**: opt-in, user-owned chat history.
- **AgentExecutions / AgentExecutionSteps**: user-owned execution status and bounded tool-step summaries.

Seed files:

- `db/data/credit-Customers.csv`: 12 synthetic customers, IDs `C001`–`C012`.
- `db/data/credit-OpenItems.csv`: 36 synthetic open items, three per customer.

The sample spans India, UAE, and Singapore and five company codes (`BS01`–`BS05`). Seed CSV data initializes the development profile. The in-memory profile is reset on restart; the persistent SQLite profile stores local changes in `credit-guard.sqlite`. HANA deployment is configured in the production CAP profile, but neither deployment nor migration has been performed.

## Demo walkthrough

This sequence exercises the dashboard, customer details, role routing, approval enforcement, recalculation, and assistant:

1. Start the server and open the app. Confirm INR 55,35,000 total exposure, INR 94,00,000 total credit limit, about 58.9% overall utilisation, 12 customers, and 2 breached customers.
2. Change the exposure grouping among Country, Company code, and Customer.
3. Select **Aarav Components (C001)**. Inspect its three open items, status, risk class, and overdue share. Use **Explain & recommend** or ask the assistant about `C001`.
4. Submit a request for C001 with new limit `2000000` and a reason such as `Expanded contract for demo`. Its increase is over both routing thresholds, so it should go to Finance Head.
5. In a separate browser session, authenticate as `controller` and try to approve it. The request should be refused because the authenticated role is insufficient.
6. Authenticate as `finance` in a separate session and approve it. The request should appear in decision history.
7. Return to Portfolio. The customer limit and aggregate portfolio utilisation should reflect the approval.
8. (Optional) Upload a readable TXT/DOCX/PDF that mentions `C001` and ask follow-up questions. Confirm the document is not required for normal portfolio chat, then remove its context.

## Testing and verification

Run the automated baseline unit and CAP API integration tests with:

```powershell
npm.cmd test
```

The suite uses Node.js's built-in test runner and starts a temporary CAP server on an available local port for API integration checks. No additional test framework is required. Unit tests mock provider calls; API tests use the in-memory SQLite database and synthetic CSV fixtures. The tests do not connect to SAP or require an LLM API key.

`BASELINE_TEST_RESULTS.md` records stabilization regressions, current coverage, and limitations.

The ABAP CDS/source contract and synthetic fixture checks run as part of `npm.cmd test`; the connector is tested with mocked OData responses. A separate live read-only smoke test is skipped unless explicitly enabled and is documented in [`abap/adt/README.md`](../../../abap/adt/README.md). Do not enable it outside an approved non-production ABAP tenant.

Also use the following manual smoke and behavior checks after starting the development server.

### Browser smoke checks

- Open the UI URL and verify the dashboard loads without a global error.
- Change all three exposure groupings and confirm rows render.
- Open a customer detail and confirm its open items display.
- Submit an invalid/empty request and confirm the form reports validation feedback.
- Submit a valid request and verify it appears under Approvals as Pending. For an AI-prepared proposal, explicitly confirm submission in the UI.
- Authenticate separately as an authorized and unauthorized approver, then verify the approved limit and decision history. Authorization is derived from the authenticated server identity, not frontend input.
- In assistant offline mode, query `C001`, ask about pending requests, and ask which customers are above 80%.
- Upload a valid text-based document; also try no file, an unsupported extension, a file over 10 MB, and an image-only/scanned PDF.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Browser cannot connect | Confirm the `npm.cmd run dev` terminal is still running and listening on port 4005. |
| Port 4005 is already in use | Stop the other process using that port or change the CAP port and update the browser URL accordingly. |
| Dashboard shows an API error | Check the server terminal for startup or database errors, then reload the page. |
| SQLite native module fails to load | Use Node.js 20 LTS, then reinstall dependencies if necessary. |
| Assistant reports offline mode | This is expected when `ANTHROPIC_API_KEY` is blank or absent. |
| Anthropic requests fail | Check the key, model name, network access, and server log. Never paste the API key into an issue or chat. |
| Document has no readable text | Use a text-based PDF/DOCX/TXT or OCR the scanned document before uploading. |
| Data reverted | The SQLite database is in memory and is recreated from CSV seeds on restart. |

## Limitations and security notes

- Seed values are synthetic and intended only for demos; the app is not connected to a live ERP.
- CAP mock identities in development have fixed server-side roles but do not verify passwords. Production XSUAA/HANA configuration is present but has not been validated on BTP; role collections, bindings, browser SSO/approuter, audit retention, and operational procedures remain deployment work.
- Local persistent SQLite is for development only. Production backup/restore, retention, recovery, scaling, and migration procedures are not implemented or tested.
- Approvals use a conditional pending-state update in a transaction and record immutable audit events, but production concurrency behavior has not been validated on HANA.
- Agent history is opt-in. The agent has bounded steps/tool calls and a timeout; offline responses are deterministic, not generative AI. Only the Anthropic provider is implemented.
- Uploaded files are processed in memory and not saved. Legacy DOC files, scanned PDFs, and image-only files are unsupported. Extracted text is capped at 20,000 characters.
- When using the Anthropic integration, both chat prompts and extracted document text are sent to Anthropic. Do not upload sensitive or personal data to this demo.
- Never commit `.env` or expose API keys. `.env.example` contains placeholders only.
