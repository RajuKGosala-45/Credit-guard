# Phase 1.5 Risk Register

## Scope and evidence

This register rechecks the six Phase 1 reports against the current repository sources, including `srv/server.js`, `srv/service.cds`, `srv/rules.js`, `srv/agent.js`, `db/schema.cds`, `package.json`, seed CSVs, and README. It is an analysis/design deliverable only. No source was changed, and no live SAP system or deployment configuration was available.

Risk levels indicate potential impact if this demo is used beyond its stated scope; they do not imply that a production incident has occurred.

## Register

| ID | Risk | Level | Current evidence / confidence | Affected files | Required disposition and validation |
|---|---|---|---|---|---|
| R-01 | Approval role and actor attribution are supplied by the request body, not derived from authenticated identity. | **Critical** | Confirmed in `srv/server.js`; frontend sends `role` and `decidedBy` from `app/credit/js/views/approvals.js`. README says authentication is mocked. | `srv/server.js`, `srv/rules.js`, `srv/service.cds`, `app/credit/js/views/approvals.js`, CAP auth configuration | Design trusted identity/entitlement checks before decision handling. Prove role tampering is rejected for unauthenticated and unauthorized callers. |
| R-02 | OData projections may permit generic write operations that bypass custom approval checks. | **Critical, conditional** | `srv/service.cds` exposes projections without authorization or read-only annotations. Actual endpoint reachability, CAP auth mode, and generic CRUD behavior were not runtime-tested. | `srv/service.cds`, `db/schema.cds`, CAP auth configuration | Default business-data entities to read-only; permit changes only through an authorized workflow. Test GET/POST/PATCH/DELETE against the real deployment profile. |
| R-03 | Concurrent decisions can race; successful response is not conditioned on confirming the pending-state update affected one row. Distinct pending requests can also carry stale `currentLimit`. | **High** (Critical if used for authoritative production limits) | The route checks Pending before transaction; within transaction it conditionally updates status but does not check affected-row count. No concurrency test exists. | `srv/server.js`, `db/schema.cds` | Define atomic compare-and-set/locking and stale-request policy. Race approve/reject and same-customer requests; exactly one valid state transition must win. |
| R-04 | Decisions are not durable and cannot be treated as audit records. | **Critical** | `package.json` sets SQLite `:memory:`; README documents reset on restart. | `package.json`, `db/schema.cds`, `db/data/`, future deployment configuration | Choose persistent store and retention/audit strategy before real approvals. Verify restart persistence, backup, restore, and audit history. |
| R-05 | Exposure is a demo sum of all open-item amounts, including invoices and sales orders, with no SAP reconciliation or overlap rule. | **Critical** if treated as authoritative | `srv/rules.js` sums amounts; `srv/server.js` passes all open items; seed CSV contains `Invoice` and `SalesOrder`; README labels sample synthetic. | `srv/rules.js`, `srv/server.js`, `db/schema.cds`, `db/data/`, SAP mapping requirements | Obtain business-approved exposure definition and SAP reconciliation examples before changing calculations. Do not invent inclusion/deduplication behavior. |
| R-06 | Monetary aggregation has no currency dimension or conversion policy. | **Critical** for multi-currency data | `db/schema.cds` has Decimal fields but no currency field; sample data is INR. | `db/schema.cds`, seed data, calculation/API contract, SAP integration | Confirm currency scope, exchange rate/date/type, and rounding before importing mixed-currency records. Test reconciliation across currencies. |
| R-07 | CAP authentication configuration and API route protection are not established in repository configuration. | **High** | No auth provider/strategy or route-level authorization appears in inspected package, service CDS, or server routes. Runtime/deployment configuration was not supplied. | `package.json`, `srv/server.js`, `srv/service.cds`, deployment files not present | Identify intended identity provider and CAP production profile. Verify every REST/OData route's unauthenticated and authenticated behavior in the target environment. |
| R-08 | Agent proposal path bypasses public route validation and writes request IDs longer than CDS `String(12)`. | **High** | `srv/agent.js` converts input to Number, inserts directly, and generates a longer ID; public API uses UUID length 36. | `srv/agent.js`, `srv/server.js`, `db/schema.cds` | Consolidate request validation and ID strategy before agent/write expansion. Test invalid tool arguments and target database length constraints. |
| R-09 | Request/decision input validation does not enforce all schema bounds or robust runtime types. | **Medium** | `srv/server.js` validates a subset; CDS sets reason/name/ID bounds; optional display-name fields use string operations. | `srv/server.js`, `srv/agent.js`, `db/schema.cds` | Specify payload schemas, numeric scale, bounds, and errors; test malformed types and persistence limits. |
| R-10 | Raw caught error messages are returned to clients and no route-level structured logging/correlation is evident. | **Medium** | Catch blocks return `error.message`; no explicit logger is used in custom routes. CAP may still log elsewhere; this was not runtime-verified. | `srv/server.js`, `srv/agent.js`, operational configuration | Define sanitized client errors and server-side diagnostic logging. Verify no secrets, paths, SQL, stack traces, or provider payloads leak. |
| R-11 | Upload, chat, and reads lack application-level rate limits; upload storage is memory-backed. | **High** before untrusted exposure | `multer.memoryStorage()` and per-file cap are present; no app throttling found. Concurrent resource impact is not measured. | `srv/server.js`, `srv/documents.js`, deployment edge configuration | Define resource budgets and request throttling at suitable layers. Load-test simultaneous uploads and provider calls. |
| R-12 | Chat/document text can be sent to configured Anthropic service; provider/data handling is not approved in repository evidence. | **High** for confidential data | `srv/agent.js` calls Anthropic when configured; README warns text is sent and not to upload sensitive data. | `srv/agent.js`, `.env.example`, privacy/operations policy | Approve provider, data classes, retention, region, and user notice before sensitive use. Test offline mode and data-egress controls. |
| R-13 | Current persistence has no migration, backup, restore, or rollback process; only synthetic CSV seeds survive a restart. | **High** for production transition | `package.json`, `db/data/`, and README support demo reset; no migration/backup scripts were found. | `package.json`, `db/schema.cds`, `db/data/`, deployment/operations documents | Approve storage target and migration runbook. Demonstrate backup restore and rollback on a representative non-production copy. |
| R-14 | No automated project test command or test suite exists; critical decisions are not protected by regression tests. | **High** before modernization | `package.json` has no test script; Phase 1 test plan lists cases but the executed check only covered isolated rule boundaries. | `package.json`, `srv/rules.js`, `srv/server.js`, `srv/agent.js`, future test files | Add tests only after implementation approval. Make critical baseline cases pass before changing auth, persistence, or workflows. |
| R-15 | SAP system, API, identifiers, exposure semantics, and read/write authority are unknown. | **High / blocking** for SAP integration | No SAP adapter, destination, credentials, or remote API configuration was found; no live SAP access. | `db/schema.cds`, `srv/rules.js`, future SAP adapter/configuration | Complete business and system discovery; obtain masked fixtures and reconciliation evidence before selecting API or mapping. |
| R-16 | ID fields and monetary schema constraints may not match application inputs or a future database provider. | **Medium** | CDS IDs use `String(12)`; custom API uses UUID; Decimal(15,2) values are accepted without explicit scale/precision validation. | `db/schema.cds`, `srv/server.js`, `srv/agent.js`, persistence config | Set an explicit identifier/precision policy and verify migration/provider behavior before persistent cutover. |

## Go/no-go gates

### Must be resolved before production approval actions

- R-01, R-02, R-03, R-04, R-07, and R-10.
- Approval policy owner confirms thresholds and separation-of-duties requirements.
- Automated authorization, concurrency, and transaction tests pass.

### Must be resolved before authoritative exposure or SAP integration

- R-05, R-06, and R-15.
- Approved field-level mapping, source API selection, currency treatment, and reconciliation fixtures exist.

### Must be resolved before durable production records

- R-04, R-13, and R-16.
- Backup/restore, migration, rollback, persistence, and retention tests pass.

### Must be resolved before untrusted/public exposure

- R-07, R-09, R-10, R-11, and R-12.
- Security and load tests are run in a representative deployment profile.

## Evidence limitations

- CAP runtime/deployment authentication settings were not available for verification.
- No live OData method probes were performed; mutability risk is conditional on runtime configuration.
- No SAP system was accessible; SAP fields and calculations below remain requirements/questions, not confirmed SAP semantics.
- The repository had a pre-existing uncommitted `srv/server.js` change. It was not edited as part of this phase.
