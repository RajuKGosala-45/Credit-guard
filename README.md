# Credit Guard

Credit Guard is a runnable SAP Cloud Application Programming Model (CAP) demo for monitoring customer credit exposure and handling credit-limit requests. The sample portfolio represents Bluspring Enterprises and uses synthetic INR-denominated data.

The application combines a browser-based portfolio dashboard, a CAP/Express JSON API, an in-memory SQLite database, document text extraction, and an optional Anthropic-powered assistant. The assistant can explain portfolio data and create pending requests, but only a human approver can approve or reject a request.

> **Demo only:** This project is not a production credit-decisioning or access-control system. Data is synthetic, authentication is mocked by CAP, and the approval-role selector is not authorization.

## Contents

- [Features](#features)
- [Architecture and project layout](#architecture-and-project-layout)
- [Prerequisites and setup](#prerequisites-and-setup)
- [Run and open the application](#run-and-open-the-application)
- [Portfolio and credit rules](#portfolio-and-credit-rules)
- [Using the application](#using-the-application)
- [Assistant and document analysis](#assistant-and-document-analysis)
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
  schema.cds                Customers, OpenItems, and LimitRequests entities
  data/                     CSV seed data loaded by CAP
srv/
  service.cds               OData CreditService projections
  server.js                 Custom REST endpoints and static UI hosting
  rules.js                  Shared risk classification and approval-routing rules
  agent.js                  Assistant tools, offline behavior, Anthropic integration
  documents.js              PDF/DOCX/TXT extraction and text-length limit
.env.example                Optional environment variable template
package.json                Scripts and dependencies
```

The CAP service loads the CDS model and seeds SQLite from `db/data`. The configured database is in memory, so a server restart starts a fresh demo. CAP hosts the custom API under `/api`, the UI under `/credit`, and the OData service under `/odata/v4/credit`.

The frontend is plain HTML, CSS, and JavaScript modules; it does not require a separate frontend build step. Its initial load requests dashboard totals and customers, and it loads approval requests when the Approvals tab is opened.

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

- Exposure is the sum of a customer's open invoices and sales orders.
- Utilisation is `exposure / creditLimit`. A zero limit with positive exposure is treated as infinite utilisation and flagged `NO_LIMIT`.
- Overdue share is `overdueAmount / exposure`, or zero when exposure is zero.
- Portfolio totals aggregate customer exposure and limits. These are sample open-item balances, not live ERP data.

### Status thresholds

The shared rules in `srv/rules.js` apply these thresholds:

| Condition | Flag/status |
|---|---|
| Exposure exists and credit limit is zero | `NO_LIMIT` |
| Utilisation is greater than 120% | `CRITICAL` |
| Utilisation is greater than 100% and at most 120% | `BREACH` |
| Utilisation is at least 80% and at most 100% | `WARNING` |
| Overdue items exceed 30% of exposure | `OVERDUE_RISK` flag |
| Last review is more than 12 months old | `STALE_REVIEW` flag |

Status precedence is `NO_LIMIT`, `CRITICAL`, `BREACH`, `WARNING`, `OVERDUE_RISK`, then `HEALTHY`. Overdue and stale-review flags can accompany another status. A review exactly 12 months old is not stale; overdue share must be strictly greater than 30%.

### Approval routing

For a limit increase, calculate the increase over the current limit. The request routes to **Credit Controller** when the increase is at most 25% of the current limit **or** at most INR 5,00,000. Otherwise it routes to **Finance Head**. Decreases are accepted as requests and route to the controller.

- A Credit Controller may decide controller-routed requests only.
- A Finance Head may decide requests routed to either role.
- Approval updates the customer's limit and request status; rejection only updates the request.
- The AI agent may create a pending request, but cannot make a decision.

## Using the application

### Portfolio

The Portfolio tab displays KPI cards and exposure groupings. Use the Country, Company code, and Customer controls to change the grouping. Select a customer row to inspect its open items and review date. Select **Explain & recommend** to ask the assistant about that customer.

### Limit requests and approvals

1. In Portfolio, select a customer, enter a positive new credit limit, and provide a business reason.
2. Submit the request. The UI shows the assigned approver role.
3. Open Approvals to review pending requests and decision history.
4. Choose the active demo role and approve or reject a request. If the role is too junior, the API refuses the decision.

### Credit assistant

Open the Credit assistant tab and ask questions such as:

- `What customers are above 80% utilisation?`
- `Explain and recommend whether to increase the limit for C001.`
- `How many requests are pending?`
- `Create a pending limit request for C001 with a new limit of 1200000 because of a renewed contract.`

Offline mode is deterministic: it supports customer lookups, pending-request summaries, threshold listings, and document extraction/matching. It is not a language model and may not interpret arbitrary questions. With an Anthropic key, the model can use the same bounded database tools. Tool calls are limited to six agent steps per chat request.

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
| `POST /api/chat` | Send a message, optionally with browser-held document context |
| `POST /api/documents/analyze` | Extract and analyze multipart field `document` |

### Request examples

Create a request:

```json
{
  "customerId": "C001",
  "requestedLimit": 1200000,
  "reason": "Renewed customer contract",
  "requestedBy": "Demo user"
}
```

Decide a request:

```json
{
  "decision": "Approved",
  "role": "Finance Head",
  "decidedBy": "Demo approver"
}
```

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

Seed files:

- `db/data/credit-Customers.csv`: 12 synthetic customers, IDs `C001`–`C012`.
- `db/data/credit-OpenItems.csv`: 36 synthetic open items, three per customer.

The sample spans India, UAE, and Singapore and five company codes (`BS01`–`BS05`). Seed data is loaded into SQLite each time the in-memory CAP server starts. Changes made through the UI are therefore temporary.

## Demo walkthrough

This sequence exercises the dashboard, customer details, role routing, approval enforcement, recalculation, and assistant:

1. Start the server and open the app. Confirm INR 55,35,000 total exposure, INR 94,00,000 total credit limit, about 58.9% overall utilisation, 12 customers, and 2 breached customers.
2. Change the exposure grouping among Country, Company code, and Customer.
3. Select **Aarav Components (C001)**. Inspect its three open items, status, risk class, and overdue share. Use **Explain & recommend** or ask the assistant about `C001`.
4. Submit a request for C001 with new limit `2000000` and a reason such as `Expanded contract for demo`. Its increase is over both routing thresholds, so it should go to Finance Head.
5. In Approvals, select **Credit Controller** and try to approve it. The request should be refused because the selected role is insufficient.
6. Select **Finance Head** and approve it. The request should appear in decision history.
7. Return to Portfolio. The customer limit and aggregate portfolio utilisation should reflect the approval.
8. (Optional) Upload a readable TXT/DOCX/PDF that mentions `C001` and ask follow-up questions. Confirm the document is not required for normal portfolio chat, then remove its context.

## Testing and verification

There is currently no automated test script or test directory in `package.json`. Use the following manual smoke and behavior checks after starting the development server.

### Browser smoke checks

- Open the UI URL and verify the dashboard loads without a global error.
- Change all three exposure groupings and confirm rows render.
- Open a customer detail and confirm its open items display.
- Submit an invalid/empty request and confirm the form reports validation feedback.
- Submit a valid request and verify it appears under Approvals as Pending.
- Test both an allowed and a disallowed approver role, then verify the approved limit and decision history.
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
- CAP uses mocked authentication in development. The approver dropdown is a role simulation, not identity verification or authorization.
- The SQLite database is in-memory. There is no durable storage, production audit retention, or pagination.
- The demo checks that a request is still Pending before a decision, but it does not provide production-grade concurrent decision handling.
- The assistant has a six-step tool-call limit. Offline responses are deterministic text and pattern matching, not generative AI.
- Uploaded files are processed in memory and not saved. Legacy DOC files, scanned PDFs, and image-only files are unsupported. Extracted text is capped at 20,000 characters.
- When using the Anthropic integration, both chat prompts and extracted document text are sent to Anthropic. Do not upload sensitive or personal data to this demo.
- Never commit `.env` or expose API keys. `.env.example` contains placeholders only.
