# Persistence Review

## Current storage configuration

`package.json` configures CAP to use SQLite with `database: ":memory:"`. CAP seeds the database from `db/data/credit-Customers.csv` and `db/data/credit-OpenItems.csv` when the application starts. The schema in `db/schema.cds` defines `Customers`, `OpenItems`, and `LimitRequests`.

## Findings

| Finding | Consequence | Classification |
|---|---|---|
| SQLite database is in memory. | All created requests, decisions, and approved limit changes disappear on process restart; each process/instance has separate state. | **Verified working** as configured; **Critical risk** if used for durable business records. |
| CSV files are the only customer/open-item seed source identified. | Runtime edits do not update the seed files; next restart restores the original synthetic portfolio. No live SAP synchronization was found. | **Verified working** by repository/config review; **Critical risk** if the demo data is mistaken for current SAP data. |
| `LimitRequests` is stored in the same transient database. | Request status and decision history are not durable and cannot serve as an audit record. | **Critical risk** for operational approvals. |
| No migration/versioning workflow was identified in the package scripts or inspected CAP configuration. | Schema evolution, upgrade ordering, and rollback behavior are not defined. | **Needs improvement** before persistent storage adoption. |
| No backup, restore, retention, or disaster-recovery strategy was found. | There is no documented recovery process for business data or audit history. | **Needs improvement** for production readiness. |
| No explicit foreign-key/index/retention strategy was identified beyond CDS associations/compositions. | Query behavior and integrity at larger volumes have not been established. | **Needs testing** and design review before scale-up. |
| No pagination is exposed by the custom list endpoints. | Full customer/request sets are loaded and returned; response cost grows with dataset size. | **Needs improvement** as volume grows. |
| Uploaded file buffers and extracted text are processed in process memory and are not persisted. | Restart loses the operation context; concurrent uploads increase memory pressure. No durable document lifecycle exists. | **Verified working** for current handling; **Needs improvement** for controlled production document workflows. |
| Conversation/task execution history is not persisted. | There is no durable agent history, replay, or audit trail for assistant tool activity. | **Verified working** by source review; **Needs improvement** if agent tasks become operational. |
| CDS uses bounded string fields (notably `LimitRequests.ID : String(12)`), while server code supplies a 36-character UUID and the agent supplies a longer generated ID. | Current SQLite may accept over-length values, but another database/provider may reject or handle them differently. | **Needs improvement** for schema/application consistency; **Needs testing** on any target database. |
| Monetary CDS values use Decimal(15,2), while API accepts JavaScript numeric values without explicit scale/precision rules. | Values may differ or fail at persistence boundaries when switching database providers or using amounts beyond supported precision. | **Needs improvement** and **Needs testing**. |
| No currency column exists in the business schema. | Multiple-currency persistence or aggregation cannot be represented safely. | **Critical risk** if multi-currency SAP data is introduced without a currency model. |

## Persistence readiness conclusion

The existing setup is appropriate for a disposable synthetic demo, not durable production credit-control data. The next design step should define persistence and migration requirements before changing the database; no database or configuration changes were made in this review.

Potential future choices such as PostgreSQL or vector storage are not selected here. The business-data store, document store, audit retention, backup requirements, and migration/rollback approach require explicit design.

## Validation still required

- Restart the app after creating and approving a request to demonstrate the reset behavior.
- Run concurrent server instances to establish isolation behavior.
- Validate type/length constraints against a persistent target database before migration.
- Define backup/restore and migration tests as part of the future persistence plan.

These are **Needs testing**.
