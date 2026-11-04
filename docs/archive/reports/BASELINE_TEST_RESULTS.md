# Baseline and Stabilization Test Results

## Latest run

- Command: `npm.cmd test`
- Runner: Node.js built-in `node:test`
- Runtime: Node.js 20.20.2
- Result: **65 tests passed, 0 failed, 1 intentionally skipped**
- API tests run against a temporary CAP server, configured development mock identities, in-memory SQLite, and synthetic CSV data.
- AI provider responses and database calls in unit tests are mocked. No live LLM, BTP, HANA, or SAP connection was used.

| Area | Result |
|---|---:|
| Agent tool validation, permissions, bounded execution, and provider fallback | Passed |
| API contracts, validation, CAP identity/role enforcement, and user-scoped history | Passed |
| Request/approval/rejection transitions, concurrent decisions, and audit history | Passed |
| OData authentication and read-only create/update/delete restrictions | Passed |
| CAP profiles, XSUAA role templates, and fail-closed production auth configuration | Passed |
| Six deterministic AI business-scenario tests | Passed |
| ABAP connector validation, pagination, timeout/auth errors, unsafe next links, and deterministic analysis | Passed with mocked Destination/OData responses |
| ABAP CDS/service source contract and synthetic fixture keys/currencies | Passed static checks; ABAP activation requires ADT |
| Live ABAP connector smoke test | Intentionally skipped without explicit non-production opt-in and Destination binding |
| App Router/MTA configuration and production build settings | Passed |
| Exposure, utilization, stale review, overdue classification, missing amounts, routing | Passed |
| Total | **65 passed, 0 failed, 1 skipped** |

## Stabilization corrections verified

- AI and REST limit requests reject nonpositive/non-finite limits, blank reasons, and reasons longer than the CDS `String(500)` field.
- Request IDs fit the CDS `String(12)` key.
- Date-only review dates are compared against a UTC date boundary for the 12-calendar-month stale-review rule.
- Missing, null, empty, and non-finite open-item amounts now fail explicitly instead of producing `NaN` exposure and utilization.
- Authentication/authorization is enforced on the custom API and OData service. Client-supplied requester, approver role, and decision-maker fields are ignored.
- Requesters cannot approve or reject their own requests. Only CAP-derived controller/finance roles can decide requests routed to their level or lower.
- Approval and rejection require a bounded decision reason; transition and immutable audit history are written transactionally. A concurrent-decision integration test verifies only one decision succeeds.
- OData projections require the reader role and are read-only.
- Development UI access triggers a CAP Basic-auth sign-in challenge so the existing same-origin frontend can use its authenticated browser session.
- Production CAP configuration selects XSUAA/HANA, and the auth configuration fails closed when no XSUAA binding is present. This verifies configuration behavior only, not a BTP deployment.
- AI proposal tools prepare validated details without creating a request. Explicit user confirmation submits it through the ordinary protected request API. Tools reuse the shared `srv/creditService.js` calculations and workflow.
- Agent steps, tool calls, and provider calls are bounded. Conversation memory is opt-in and user-scoped; users can clear their own agent history.
- Six additional scenarios exercise customer analysis, utilization threshold listing, overdue/high-risk identification, breach explanation, proposal preparation, and the explicit confirmation boundary using mocked provider responses and synthetic records.
- Read-only ABAP integration tools require `CreditReader`, report the configured source and retrieval timestamp, keep offline execution history, reject incompatible currency/missing financial fields, and do not fall back to local fixtures when ABAP is unavailable.
- Customer and open-item identifiers returned from ABAP are checked against the existing CDS `String(12)` key limits.
- Production build command `npm.cmd run build:cf` compiles both CAP server and HANA deployment artifacts, then copies the existing `/credit` frontend into the generated server module. Generated output was checked to contain the frontend and **0 `.hdbtabledata` seed imports**.
- App Router 23.4.0 is locked separately and has 0 reported vulnerabilities. Its Node.js 22/24 runtime requirement is not exercised on the local Node.js 20.20.2 host.
- ABAP source and activation instructions are under `abap/adt/`. Local tests verify exact expected property names and synthetic fixtures, but cannot compile or activate ABAP source without an ABAP Environment tenant.

## Historical baseline

Before stabilization, the Phase 2A characterization run completed **25 tests: 19 passed and 6 failed**. The six assertions identified invalid AI limits/reasons, overlong REST reasons, overlong IDs, and the 12-month stale-review boundary. A characterization test also exposed missing amounts propagating `NaN`. These cases are now regression checks and pass under the corrected behavior.

## Remaining coverage and limitations

- HANA transaction/concurrency behavior, concurrent requests against the same customer, and production workload behavior are not tested.
- Local persistent SQLite startup and data retention are configured, but backup/restore, failure recovery, HANA migration, and production database operations are not tested.
- Production XSUAA behavior is tested only for fail-closed startup without a binding. BTP service bindings, role-collection assignment, deployment-level browser sign-in/approuter, and live JWT flows remain unconfigured and untested.
- Provider timeout and failure categorization are unit-tested; live provider behavior, rate limits, long-running production workloads, browser automation, and upload stress/resource limits remain untested.
- Credit exposure semantics still require confirmation from the business/SAP owners; no SAP rule was inferred or changed.
- Only the Anthropic provider adapter is implemented. No live SAP service, API mapping, or SAP business-data source is configured.
- The production-profile HANA build is local-only; generated `.hdbtabledata` imports are disabled. HDI/HANA deployment, schema/persistence/concurrency/backup validation remain untested.
- Root `npm audit` reports 18 vulnerabilities in the development CAP CLI dependency tree (3 critical, 7 high, 8 moderate); root `npm audit --omit=dev` and `npm audit --prefix approuter` report zero. A non-breaking root fix is not available; npm's remediation requires a major `@sap/cds-dk` upgrade. See `DEPENDENCY_SECURITY_REPORT.md`.
- No BTP service, live ABAP tenant, production authentication, or real SAP data was available. See `AUTHENTICATION_VALIDATION_RESULTS.md`, `HANA_VALIDATION_RESULTS.md`, and `SAP_INTEGRATION_SPECIFICATION.md`.
- The optional live ABAP smoke test performs GET requests only and remains skipped unless explicitly enabled as documented in `abap/adt/README.md`.

## Reproduction

From the repository root on Windows:

```powershell
npm.cmd test
```
