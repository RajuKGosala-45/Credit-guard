# Phase 2 Implementation Plan

## Status

**Proposed only — Phase 2 implementation has not started.** This plan is based on the six Phase 1 reports and the source review performed for Phase 1.5. It assumes the existing browser frontend and current business functionality are preserved. No frameworks, packages, source changes, database changes, or SAP integrations are approved by this document.

## Principles and boundaries

- Keep CAP/Node as the authoritative business-data and credit-rule layer unless an approved architecture decision changes that.
- Do not change the frontend architecture.
- Do not build an advanced AI agent in this phase.
- Keep current business behavior until an owner approves a defined change.
- Do not treat synthetic CSV data or demo calculations as live SAP truth.
- Resolve authentication/authorization before exposing approval mutations.
- No automatic destructive migration or removal of files.

## Workstreams and sequence

| Order / gate | Proposed work | Reason | Affected files (expected; no changes made) | Dependencies | Risks | Validation / exit criteria |
|---|---|---|---|---|---|---|
| 0 — Approval gate | Review/approve this risk register, security design, DB design, SAP mapping requirements, and implementation plan. Confirm intended deployment scope: local demo, internal pilot, or production. | Security/storage choices depend on threat model and operation scope. | Design reports; no runtime files | Product, credit policy, security, database, and SAP owners | Unclear scope leads to inappropriate controls or unnecessary architecture | Written decisions for scope, risk acceptance, database owner, identity owner, and which workstream is authorized. |
| 1 — Baseline characterization | Create an automated test baseline for existing rule behavior and API contracts before changing them. Add coverage for status boundaries, route behavior, CRUD exposure, data loss/reset, and current UI workflow. | Current repo has no test command; avoid regressions and establish measured behavior. | `package.json`, future test files, `srv/rules.js`, `srv/server.js`, `srv/agent.js`, `db/schema.cds` | Approval to add tests; deterministic test setup | Test harness may couple to demo runtime; current edge behavior may be undocumented | Unit and integration tests run reproducibly; preserve known current demo behavior; clearly mark intentional changes. |
| 2 — Security foundation | Integrate approved identity provider with CAP; define server principal and role mapping; enforce permissions on REST and OData; eliminate client-supplied approver authorization; enforce requester/approver separation; constrain AI identity to proposal-only. | Approval controls currently trust body fields and OData restrictions are unverified. | `srv/server.js`, `srv/service.cds`, CAP/package/deployment auth config, `app/credit/js/api.js`, `app/credit/js/views/approvals.js`, `srv/agent.js` | Identity provider, claims, entitlement matrix, CAP deployment profile, separation-of-duties policy | Misconfigured roles lock out users or grant excess access; frontend needs compatibility adjustments | Anonymous and unauthorized access denied; role tampering ineffective; AI cannot decide; OData direct mutation blocked; S-01 and OData tests pass. |
| 3 — Approval integrity | Make decision transition atomic and concurrency-safe; define how stale requests/current-limit changes are handled; add durable actor/outcome audit records. | Current pre-check/update sequence has race potential and no durable audit. | `srv/server.js`, `srv/rules.js`, `db/schema.cds`, tests | Security principal, persistent store choice, policy for stale/competing requests | Lock contention; changed response behavior; audit data retention obligations | Exactly one decision succeeds for a Pending request; no lost same-customer update; transactions roll back cleanly; audit rows identify validated actor. |
| 4 — Persistent database | Provision approved target (PostgreSQL candidate unless org standard says otherwise); add supported CAP adapter/config; implement staged schema deployment, controlled import, backup, restore, and rollback. Preserve entities/workflows; don't migrate synthetic seeds as production truth. | Current in-memory DB discards requests, decisions, and accepted limits. | `package.json`, `package-lock.json`, CAP config, `db/schema.cds`, `db/data/`, deployment/import/migration scripts, tests | Database owner/platform, ID/precision policy, security secrets process, backup/RPO/RTO | Schema incompatibility, seed overwrite, data loss, provider lock-in | Schema deploy succeeds; restart retains intended records; one-time seed/import does not reset data; backup restore and rollback rehearsal pass. |
| 5 — Business/SAP semantics decision gate | Confirm exposure definition, component mapping, currency, overdue, segment, limit, and freshness rules. Obtain masked fixtures and approved expected totals. | Current invoice + sales-order sum is unverified and currency is absent. | `srv/rules.js`, `db/schema.cds`, future SAP mapping docs/tests, API contracts | Credit policy owner, SAP system/release/API owner, data steward | Premature rules can misstate risk/exposure; scope may require schema changes | Signed mapping and reconciliation examples; unresolved items remain explicitly non-authoritative. No integration until approved. |
| 6 — SAP read-only integration (conditional) | Only if explicitly authorized after gate 5: add an adapter for the selected supported SAP API, with validated identity, paging, freshness, retry, and reconciliation behavior. Start read-only. | There is no live integration and seed data is synthetic. | New adapter/config modules, `db/schema.cds` if approved, `srv/server.js`/domain services, tests, documentation | SAP access/metadata, credentials/destination, network route, field map, masked fixtures | Data drift, API limits, source outages, privacy/security exposure | Non-production integration; approved fixture reconciliation; access least-privilege; outage/freshness tests; no writes. |
| 7 — Operational hardening | Add sanitized structured errors/logs, correlation IDs, monitoring, rate/concurrency limits, privacy controls, and runbooks. | Error details are returned directly; resource controls and operational procedures are absent. | `srv/server.js`, `srv/agent.js`, `srv/documents.js`, deployment logging/edge config, operational documentation | Logging/privacy policy, traffic profile, provider approval | Logging may leak sensitive data; excessive throttling may affect usability | Secret/data-leak review, load tests, alert validation, documented response and recovery exercise. |

## Required tests before any modernization merge

### Business and calculations

- Every existing utilization, overdue-share, no-limit, status precedence, stale-date, and routing boundary is covered.
- Aggregates reconcile to deterministic fixtures.
- Any changed exposure definition is approved and has a before/after reconciliation record.
- Currency handling and zero/negative/missing amounts have explicit tests.

### API and workflow

- Each endpoint has success, validation, not-found, conflict, dependency-failure, and output-shape tests.
- Request input respects CDS max lengths and numeric precision.
- Approval and rejection preserve atomicity; duplicate and concurrent submissions behave deterministically.
- Agent proposal can only create a valid Pending item; there is no agent decision capability.

### Security

- Anonymous/ordinary identities cannot access prohibited data or write approvals.
- Request body cannot choose authenticated actor or effective role.
- Self-approval is denied; all permitted role paths are tested.
- Direct OData create/update/delete cannot bypass guarded workflow.
- Error responses and logs disclose no secrets, SQL, stack traces, local paths, or unapproved document text.

### Persistence and operations

- Data survives restart and multi-instance operation on target DB.
- Migration is repeat-safe; no automatic seed overwrite.
- Backup/restore and rollback are rehearsed.
- Database/provider constraints match declared IDs and decimal policy.

### SAP, only if authorized

- API metadata/version matches landscape.
- Masked fixtures reconcile to approved source totals.
- Paging, rate limit, outage, freshness, and permission behavior are tested.
- No SAP write occurs without separately approved workflow design and authorization.

## Explicitly out of scope until separate approval

- Replacing or redesigning the frontend.
- Introducing Python/FastAPI, React/Next.js, LangGraph, vector databases, or any other framework.
- Replacing the current AI assistant with an advanced agent.
- Changing credit risk thresholds or exposure definitions.
- Connecting to SAP, inventing SAP field names, or writing to SAP.
- Deleting, renaming, or replacing existing files.
- Database cutover, production deployment, or migration of live data.

## Approval requested before execution

Before Phase 2 begins, approve or amend:

1. Target usage scope and threat model.
2. Identity provider and role/permission matrix, including separation of duties.
3. OData default read-only policy and authorized mutation path.
4. Database platform and operating owner; PostgreSQL is only a candidate, not an approved change.
5. ID, monetary precision, currency, backup, retention, and rollback policies.
6. SAP system/API and business mapping decisions—or confirmation that SAP remains out of scope.
7. The test gates and workstream order above.
