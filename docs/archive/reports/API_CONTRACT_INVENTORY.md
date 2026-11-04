# API Contract Inventory

## Scope

The custom Express routes are registered in `srv/server.js` beneath `/api`. The browser client in `app/credit/js/api.js` consumes these endpoints. CAP also exposes the `CreditService` projections from `srv/service.cds` under `/odata/v4/credit`.

The classifications below describe source-level behavior. No live HTTP/API integration suite is present in `package.json`.

## Custom REST endpoints

| Method and path | Contract / behavior | Validation and errors | Classification |
|---|---|---|---|
| `GET /api/dashboard` | Returns KPI totals and exposure groupings for country, company code, and customer. | Database or calculation errors return HTTP 500 with an error message. | **Verified working** by implementation review; **Needs testing** through runtime API and frontend. |
| `GET /api/customers` | Returns all customer summaries with exposure, overdue amount/share, utilization, flags, and status. | Errors return HTTP 500 with an error message. | **Verified working** by implementation review; **Needs testing** through runtime API. |
| `GET /api/customers/:id` | Returns one customer summary plus that customer's open items. | Missing ID returns HTTP 404; database errors return HTTP 500. | **Verified working** by implementation review; **Needs testing** for encoding, missing IDs, and runtime behavior. |
| `GET /api/limit-requests[?status=...]` | Returns requests newest first, enriched with customer name. Optional `status` is passed to the database filter. | An unrecognized status is not rejected; it ordinarily produces an empty result. Errors return HTTP 500. | **Needs improvement** for explicit query validation and **Needs testing** for database ordering/filter semantics. |
| `POST /api/limit-requests` | Accepts `{ customerId, requestedLimit, reason, requestedBy? }`; creates a pending request and returns it with HTTP 201. | Requires customer ID, a finite positive numeric limit, and nonblank reason. Unknown customer returns 404; invalid input returns 400. `reason` length and runtime types for optional requester are not fully validated. | **Verified working** for source-level validation; **Needs testing** via HTTP; **Needs improvement** for length/type/decimal precision validation. |
| `POST /api/limit-requests/:id/decision` | Accepts `{ decision, role, decidedBy? }`; supports Approved or Rejected. Approval updates the customer limit and the request in a database transaction; rejection updates request state. | Invalid decision/role returns 400, missing request 404, non-pending request 409, insufficient role 403. Other errors return HTTP 500. | **Verified working** for the intended source-level branches; **Needs testing** for transaction/race behavior; **Critical risk** because role is caller-supplied, not authenticated. |
| `POST /api/chat` | Accepts `{ message, documentContext? }`; returns the assistant result, including an offline indicator. A document context can be included by the browser. | Empty message and malformed/oversized context return 400; assistant/provider errors return HTTP 502 with an error message. | **Verified working** for source-level validation; **Needs testing** for provider failure, boundary payloads, and response contract; **Needs improvement** for error redaction/logging. |
| `POST /api/documents/analyze` | Accepts multipart form field `document`; extracts text and returns filename, extracted text/metadata, assistant reply, and offline indicator. | Upload limit is 10 MiB, one file, one field, two parts. Upload parser errors return 400 or 413; missing file 400; extraction error 422; other errors 502. | **Verified working** for source-level limits and branches; **Needs testing** with representative/malformed files and runtime parser behavior. |

## Shared HTTP behavior

- JSON parsing middleware is mounted at `/api` using `express.json()` with its Express default body limit; no project-specific JSON size limit is configured.
  - **Classification: Needs improvement** for a deliberate limit aligned with message/document context contracts.
- Route handlers catch exceptions and return JSON errors. They do not call an application logger before returning them.
  - **Classification: Needs improvement**; see `SECURITY_AND_APPROVAL_REVIEW.md`.
- The request API uses `crypto.randomUUID()` for request IDs, while the CDS field is declared `String(12)`. The agent tool constructs a different ID that is also longer than 12 characters.
  - **Classification: Needs improvement** for contract consistency and database portability.
- API responses can include non-finite utilization values internally. JSON serialization encodes `Infinity` as `null`.
  - **Classification: Needs testing** for consumer expectations and **Needs improvement** for explicit API representation.
- No pagination, sorting controls beyond request creation date, or API versioning are present.
  - **Classification: Needs improvement** before growing datasets or committing to a stable external API contract.

## CAP OData surface

`CreditService` exposes projections for `Customers`, `OpenItems`, and `LimitRequests` at `/odata/v4/credit`. The model uses standard CAP entity projections; no read-only restrictions or authorization annotations were found in the service definition.

- **Classification: Verified working** that these projections are defined.
- **Classification: Critical risk** if exposed outside a controlled demo: generic entity operations may provide direct data access/mutation that bypasses the intended custom approval route. Verify actual CAP auth mode and reachable operations before deployment.

## Client/server contract notes

`app/credit/js/api.js` calls the custom endpoints listed above, sets JSON content type for JSON bodies, and reports server error messages to the UI. Document uploads use `FormData`. The approvals UI submits the selected role from the browser, which is a UI convenience rather than an authorization credential.

- **Classification: Verified working** by source review.
- **Classification: Critical risk** to treat the frontend role selector as trusted authorization.

## Runtime API validation still required

Exercise every route against a running CAP service, covering normal, malformed, missing, unauthorized, boundary, and database-failure responses. The detailed suite is in `BASELINE_TEST_PLAN.md`.

- **Classification: Needs testing**.
