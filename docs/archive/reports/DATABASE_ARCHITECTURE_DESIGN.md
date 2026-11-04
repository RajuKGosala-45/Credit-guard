# Database Architecture Design

## Current state verified

- `package.json` configures CAP's database as SQLite with `database: ":memory:"`.
- CAP loads customer and open-item demo data from `db/data/credit-Customers.csv` and `db/data/credit-OpenItems.csv`.
- `db/schema.cds` contains `Customers`, `OpenItems`, and `LimitRequests`.
- Changes to requests, approvals, and customer limits are volatile and are lost on process restart.
- The CSV data is synthetic; it is not a synchronized SAP snapshot.
- No database migration, backup, or restore process was found.

Therefore, a database migration does not have a durable production dataset to transfer today. The existing model and seed data still need to be preserved. If the running demo contains state that must survive a cutover, export and verify it before stopping that process; do not assume it can be recovered after restart.

## Storage options

| Option | Benefits | Tradeoffs / constraints | Assessment |
|---|---|---|---|
| SQLite file-backed | Lowest-friction continuation of the current demo; no database server; usable for local single-instance persistence and migration rehearsal. | Single-file operations and concurrency/availability are not a production multi-instance strategy; backup/locking and deployment volume must be managed; not a natural shared store across instances. | Suitable as an interim local development option only if durable local state is needed. It does not solve production-scale, HA, or operational requirements. |
| PostgreSQL | Mature relational database, transactions, constraints, backup/replication options, broad hosting choices, suitable for CAP business entities and audit history. | Requires selecting a CAP-compatible adapter/version, managed service/operations, credentials/networking, migration/backup ownership, and validating CDS Decimal/string semantics. New dependency/configuration is not approved here. | **Preferred general-purpose candidate** if the organization has no mandated database and wants a vendor-neutral persistent relational store. |
| SAP HANA Cloud | Potential fit if the target landscape already uses SAP BTP/HANA and integration/governance requirements favor it; relational database with enterprise SAP operations. | Product/subscription/landscape fit is unknown; ownership and cost; adapter/deployment support and operational procedures must be confirmed. | Candidate only after SAP/BTP architecture owners confirm fit; no assumption that HANA is available. |
| Other managed relational DB (for example MySQL/MariaDB) | May align with existing organization standards and managed services. | CAP adapter compatibility, SQL semantics, transaction behavior, decimal/length handling, and operational support must be verified. | Consider only if an existing platform standard makes it preferable; no evidence currently favors it over PostgreSQL. |
| Vector extension/store | Could support future document retrieval if RAG is approved. | No RAG corpus, retention policy, embedding/provider, or retrieval requirement is established. Vector data should not be mixed into the business-data decision prematurely. | Out of scope for Phase 1.5; decide separately after AI/data-governance design. |

## Recommendation and design principles

Select PostgreSQL as the working candidate for a vendor-neutral persistent relational store, subject to architecture-owner approval and a compatibility spike. If the organization standardizes on SAP HANA Cloud or another managed SQL platform, prefer that standard after confirming CAP support and lifecycle ownership.

Preserve the current customer, open-item, and limit-request concepts and their relationships. Do not silently alter credit calculations, approval policy, or data semantics as part of a storage move. Separate seed/bootstrap data loading from recurring application startup so production tables cannot be reset by demo CSV imports.

| Recommendation | Reason | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|---|
| Approve target DB/platform before code or dependency changes; PostgreSQL is the default candidate only. | Current `:memory:` state is volatile; production requires shared, durable transactions. | `package.json`, CAP configuration, deployment configuration, `db/schema.cds` | Platform/ops ownership, CAP-supported adapter/version, network and secrets process | Adapter incompatibility, cost, operational burden, vendor choice without ownership | Compile/deploy a non-production schema; run CAP CRUD, transaction, decimal, and concurrency tests. |
| Preserve entity concepts and associations; make schema deltas explicit and versioned. | Protects existing application functionality and supports controlled migration. | `db/schema.cds`, seed CSVs, persistence configuration | Data dictionary, approved currency/ID policy | Schema-only move may perpetuate unresolved business semantics | CDS compilation, migration diff review, model-level relationship and constraint tests. |
| Replace startup reseeding with an explicit one-time seed/import process for production. | Current demo seed behavior is appropriate for ephemeral demo data but unsafe for live persistence. | `db/data/`, `package.json`, CAP deployment/configuration, future import scripts | Deployment lifecycle decision, source-of-truth decision | Seed run could duplicate/overwrite data; drift between seed and system of record | Repeat deployment/startup and prove no reset/duplication; verify import counts and reconciliation. |
| Define identifier and numeric precision compatibility before choosing provider. | CDS uses `String(12)` IDs but code supplies UUID/longer IDs; amounts use `Decimal(15,2)` but API validation is incomplete. | `db/schema.cds`, `srv/server.js`, `srv/agent.js` | Decision on ID format, max amount, decimal/rounding policy | Data truncation/rejection or client contract breakage | Load boundary values and existing IDs through target provider; test migration and API compatibility. |

## Migration strategy from in-memory SQLite

### Phase A — Inventory and freeze definitions

1. Confirm this project is still using only synthetic seed records and identify any live process whose in-memory requests/decisions must be retained.
2. Export a point-in-time snapshot of live in-memory tables if preserving transient state is required. Validate row counts, IDs, relationships, and checksums; record that data is not recoverable after process exit.
3. Snapshot the current schema, CSV seeds, package lock, configuration, and current branch/worktree state.
4. Resolve ID width, decimal precision, currency scope, and schema migration ownership before target schema deployment.

### Phase B — Non-production target rehearsal

1. Provision an isolated target database; store credentials only in the approved secret mechanism.
2. Use the supported CAP adapter and database deployment mechanism selected for the exact CAP version.
3. Deploy the preserved CDS entities and compare generated target schema against reviewed expectations.
4. Import synthetic CSV data once through a controlled repeat-safe import process; do not let routine server startup overwrite business records.
5. Run rule, API, transactional approval, access-control, persistence, and concurrent-write tests against the target database.
6. Measure backup, restore, and migration execution; confirm application behavior matches the SQLite demo where semantics are intended to be preserved.

### Phase C — Controlled cutover

1. Back up the target database and verify restoration before enabling writes.
2. Use a maintenance window or an explicitly approved cutover method; do not dual-write without a separately designed consistency protocol.
3. Load only the agreed synthetic/current data snapshot; reconcile all row counts, keys, associations, monetary totals, and expected dashboard outputs.
4. Run read-only smoke tests, then narrowly enable approved write flows after security gates pass.
5. Monitor errors and reconciliation; retain an export and rollback plan for the cutover window.

### Data migration boundary

- Customer and open-item CSVs are synthetic seed inputs; they can be imported for demo parity but are not an SAP migration.
- Runtime limit requests/decisions are ephemeral. Export them only if a running demo's user explicitly requires preservation.
- Do not label imported seed data as production truth.
- Do not add SAP data until field mappings and currency/exposure semantics are approved.

## Backup, restore, and rollback

| Recommendation | Reason | Affected files / owners | Dependencies | Risks | Validation |
|---|---|---|---|---|---|
| Define RPO, RTO, retention, encryption, access, and backup ownership. | No current durable recovery strategy exists; approvals require reliable retention. | Future deployment/operations configuration; `db/schema.cds` for retained entities | Business continuity and compliance owners | Backup exists but is unusable, unauthorized, or outside retention rules | Restore into isolated environment; compare row counts, audit events, and financial totals; record measured RPO/RTO. |
| Take a verified pre-migration snapshot and preserve the original SQLite demo path. | Enables recovery without destructive changes to current demo behavior. | Database deployment/runbook, `package.json`, existing SQLite configuration | Approved migration window and data owners | Rollback can lose writes made after cutover | Test rollback before production; document how post-cutover writes are reconciled. |
| Use forward-compatible, versioned schema migrations and staged rollback strategy. | Database schema changes may not be safely reversed after data writes. | `db/schema.cds`, migration/deployment tooling (not selected) | Target adapter and migration framework decision | Down migration may discard data or make rollback impossible | Test upgrade and rollback on a copy; reject migration if rollback semantics are not understood. |
| Avoid automatic demo CSV reseeding against persistent business tables. | Prevents startup from resetting or duplicating production state. | Seed/import configuration and deployment startup | Seed mode/environment policy | Incorrect environment flag could still seed production | Verify production startup with seeded fixture marker absent and existing rows unchanged. |

## Release gates

- No database switch until adapter compatibility, schema diff, persistence tests, backup/restore, and rollback rehearsal pass.
- No production approval workflow until durable request/decision audit and authorization controls are verified.
- No mixed-currency or SAP import until currency and source semantics are approved.
- No vector-store dependency until retrieval use, retention, and provider are separately approved.
