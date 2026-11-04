# User Guide

## Sign in locally

Start the app with `npm.cmd run dev` and open `http://localhost:4005/credit/index.html`. If the browser prompts for credentials, use `reader` as the username and `test` as the local mock password. Other available mock usernames are `requester`, `controller`, `finance`, `analyst`, `manager`, `approver`, and `administrator`. The mock provider does not verify passwords; these values are for local demonstration only.

## Portfolio

The Portfolio tab shows aggregate exposure, limits, utilization, customer counts, and groupings by country, company code, or customer. Select a customer row to inspect the calculated summary and open items. A zero-limit customer is labeled **Manual review**. The portfolio is synthetic demo data, not live SAP data.

## Credit requests and approvals

1. Select a customer and enter a positive requested limit and a business reason.
2. Submit the request. The server validates it and assigns the approver level.
3. An eligible, different user opens Approvals and chooses Approve or Reject with a decision reason.
4. An approval updates the local customer limit and writes decision history. A rejection does not update the limit.

The agent cannot approve requests. Use different mock identities to demonstrate requester/approver separation.

## Assistant

The assistant can answer supported questions about customer exposure, utilization thresholds, and pending requests. Offline mode is deterministic rather than a general-purpose language model. If an Anthropic provider is configured, messages are sent to that provider for interpretation and tool selection.

It can prepare a limit proposal, but the user must explicitly submit it and an authorized human must decide it.

## Document analysis

Upload a PDF, DOCX, or UTF-8 TXT file up to 10 MiB. The app extracts text in memory and limits analysis context to 20,000 characters. Scanned PDFs require OCR. With an LLM key configured, extracted text may be sent to Anthropic. Do not upload confidential data without approval.

## Data and persistence

The default development profile uses synthetic CSV seed records in in-memory SQLite; records reset when the process restarts. `npm.cmd run start:persistent` uses a local SQLite file and retains application changes between restarts. This is not a managed backup or production database.
