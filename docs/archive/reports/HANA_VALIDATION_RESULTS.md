# HANA Validation Results

**Status:** Local production-profile compilation and deployment-artifact generation passed. No HANA Cloud instance or HDI container was available, so no HANA deployment or database behavior is claimed.

## Verified locally

- The production CAP profile selects `@cap-js/hana`; production startup validation rejects SQLite and missing HANA service bindings.
- `npm.cmd run build:cf` successfully generated the HANA tables/views, CAP production Node.js module, and HDI deployer metadata.
- The production build option `contentHdbtabledata=false` was verified in generated output: no `.hdbtabledata` seed imports were emitted. Demo CSV files may remain in generated output but are not configured as HANA import artifacts.
- HANA deployment includes modeled request, approval-history, and agent-execution persistence entities.
- SQLite integration tests cover transactional approval and audit writes, duplicate/concurrent decisions, and durable model operations at the application layer. They are not HANA tests.

## Not validated

- Service entitlement/plan availability, HDI container creation, MTA archive build/deploy, initial schema deployment, actual HANA insert/readback, restart durability, rollback, locking/isolation, or concurrent approvals on HANA.
- HANA backup/restore, recovery objectives, schema evolution, and production operational monitoring.
- Final `.mtar` archive contents; `cf` and `mbt` are not available in the local environment.

## Required non-production validation

1. Confirm HANA Cloud/HDI entitlement and approved service plans in the target BTP subaccount.
2. Build the MTA with the reviewed `mta.yaml`; inspect the generated archive to verify no synthetic seed imports and deploy only to a new disposable HDI container.
3. Verify created tables/views, read/write access, transaction rollback, audit integrity, repeated and concurrent approval decisions, and data retention across restarts.
4. Test failure/recovery and schema-update/rollback procedures, then exercise the documented HANA backup and restore plan.
5. Do not store real credit records until backup, retention, access, and recovery ownership are approved.

No HANA connection, deployment, or migration was attempted.
