# Baseline Test Plan

## Automated-test baseline

The suite runs with `npm.cmd test` using Node.js's built-in test runner. It includes rule unit tests, AI tool-path tests with mocked provider/database calls, and HTTP integration tests against a temporary CAP server using the configured in-memory SQLite database and synthetic CSV data. It requires no additional test framework or live SAP/LLM credentials.

`BASELINE_TEST_RESULTS.md` records the automated baseline run and separates existing application defects from test-harness failures.

- Rule threshold, exposure, routing, request/decision API, and response-contract coverage is automated.
- Persistence, browser automation, provider failure/timeout, upload resource limits, and SAP integration behavior remain **Needs testing**. API identity/authorization and OData read-only behavior have focused automated coverage.
- The suite is a baseline characterization, not proof of production readiness.

## Test cases

| ID | Area | Scenario and expected result | Classification |
|---|---|---|---|
| R-01 | Utilization | Exposure 79.9% is Healthy; 80% and 100% are Warning; just over 100% through 120% is Breach; above 120% is Critical. | **Verified working** by automated unit tests. |
| R-02 | Zero limit | Positive exposure with zero limit is `NO_LIMIT` and internal utilization is Infinity; zero exposure and zero limit yields utilization 0. | **Verified working** by automated unit tests. |
| R-03 | Overdue share | Exactly 30% overdue is not `OVERDUE_RISK`; greater than 30% is. | **Verified working** by automated unit tests. |
| R-04 | Stale review | Exactly 12 months and older-than-12-month dates, month-end, leap-year, invalid, and missing values. | Exact date boundary and invalid/missing values **Verified working** by automated tests; broader month-end/leap-year coverage **Needs testing**. |
| R-05 | Group totals | Verify every customer, country, and company-code total reconciles to seed item amounts; test zero-limit group utilization and JSON serialization. | **Verified working** for seed totals and finite group totals in API integration tests; other edge cases **Needs testing**. |
| R-06 | Calculation data | Verify status values, sign/precision assumptions, and whether invoice plus sales-order amounts are non-overlapping exposure. | **Needs testing**; production definition is **Critical risk** until authoritative policy is established. |
| A-01 | Customer APIs | Dashboard, customer list, customer detail, unknown customer, and API error path return documented shape/status. | **Verified working** for dashboard, list, customer detail, unknown ID, chat offline/empty-message, and document text/unsupported-extension cases; database failure path **Needs testing**. |
| A-02 | Request creation | Valid customer and limit creates one Pending request with correct current limit, routing, and timestamp. | **Verified working** by API integration test. |
| A-03 | Request input validation | Missing customer, unknown customer, empty/whitespace reason, nonnumeric/zero/negative/infinite limit, wrong JSON types, long reason/requester, decimals, and over-precision values. Invalid input should fail with client error and no insert. | Invalid/missing values, reason length, and 12-character ID width **Verified working**; remaining CDS numeric/type boundaries **Needs testing**. |
| A-04 | Request listing | No status, each valid status, invalid status, ordering, and empty history. | **Needs testing**; Pending filter/enrichment covered by API integration test. |
| A-05 | Decision validation | Invalid decision/role, missing ID, already-decided request, insufficient claimed role, approved request, and rejected request return intended status and do not partially mutate data. | **Verified working** for sequential transitions, duplicate decisions, invalid decisions, missing IDs, server-derived role enforcement, and requester/approver separation; concurrency **Needs testing**. |
| A-06 | Approval atomicity | Inject persistence errors in each transaction step; verify no partial limit/status update. | **Needs testing**. |
| A-07 | Approval concurrency | Simultaneous approve/reject requests for one request; concurrent decisions for two requests for the same customer. Ensure exactly one valid decision and no stale limit overwrite. | **Needs testing**; implementation is **Needs improvement**. |
| A-08 | OData | Enumerate allowed read/write operations for all projections and verify authorization prevents direct mutation around approval controls. | **Verified working** for authenticated reader access and denied unauthenticated/create/update/delete requests against the test CAP runtime; production deployment config **Needs testing**. |
| C-01 | Assistant offline | No key configured: query customer, portfolio threshold, pending requests, and unknown customer; response clearly states offline mode and does not claim model generation. | Customer lookup and explicit offline response **Verified working**; portfolio, pending-request, and unknown-customer chat patterns **Needs testing**. |
| C-02 | Assistant provider | Valid provider, invalid key/model, timeout, rate limit, malformed provider response, unsupported tool, and six-step exhaustion. | **Needs testing**. |
| C-03 | Tool validation | Malformed tool arguments, nonpositive limits, excessive reason, duplicate/retried proposal, and generated ID length. Ensure only Pending requests are created. | Valid proposal, invalid limit/reason rejection, requester permission, and unknown customer are **Verified working**; duplicate/retried proposal and remaining malformed arguments **Needs testing**. |
| D-01 | Document upload | Valid PDF/DOCX/TXT; unsupported extension; empty file; extension/signature mismatch; malformed file; scanned PDF; UTF-8 failure; exact and over 10 MiB boundaries. | UTF-8 TXT success and unsupported extension **Verified working**; remaining formats/boundaries **Needs testing**. |
| D-02 | Document context | Empty/oversized text, unusual filename, `extractedCharacters` mismatch, truncation flag, and prompt-injection content; ensure text is treated as untrusted. | **Needs testing**. |
| D-03 | Upload load | Concurrent max-size uploads and parser failure; verify bounded memory and clear errors. | **Needs testing**; resource protections are **Needs improvement**. |
| U-01 | Browser smoke | Load dashboard, switch groupings, inspect customer detail, submit request, open approvals, decide valid request, and verify dashboard reflects approved limit. | **Needs testing**. |
| U-02 | Browser errors | API unavailable, malformed response, and validation errors are presented without breaking UI. | **Needs testing**. |
| P-01 | Persistence | Create request/approve, restart server, verify seeded state reset; document this as intentional demo behavior. | **Needs testing**; durability is a **Critical risk** outside demo use. |
| S-01 | Authorization | Attempt every read/write API and OData operation as unauthenticated, ordinary, controller, and finance identities. A caller cannot elevate role by editing JSON. | Core custom API and OData authorization, role spoofing, and separation of duties **Verified working** in integration tests; exhaustive route matrix and production identity-provider setup **Needs testing**. |
| S-02 | Error/data privacy | Confirm no keys, stack traces, SQL, local file paths, or provider secrets appear in API errors/logs; confirm data sent to configured LLM is approved. | **Needs testing**; data egress is a **Critical risk** for sensitive data. |

## Remaining baseline coverage

The tests do not yet exercise all plan items. Prioritize concurrent approval behavior, persistence durability/rollback, document resource limits, production identity-provider setup, and full UI interactions. Preserve the deterministic seed dataset and keep test cases independent of execution order.
