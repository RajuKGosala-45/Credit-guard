# Milestone 3 BTP Deployment Readiness

**Assessment date:** 2026-11-03  
**Decision:** **Configuration prepared; BTP deployment not verified.** A Cloud Foundry MTA descriptor, XSUAA-protected App Router, service bindings, production startup guard, health routes, and ABAP Destination connector are present. Local configuration/build/tests pass, but no BTP access, service binding, tenant, deployment tools, or live HANA/XSUAA/ABAP verification is available.

## Evidence-based validation

| Area | Local evidence | Result / limit |
|---|---|---|
| CAP production profile | `CDS_ENV=production` resolves `db.kind=hana` with implementation `@cap-js/hana`, and `auth.kind=xsuaa` with label `xsuaa`. No credentials are embedded in `package.json`. | Configuration resolves; no service instances are bound. |
| XSUAA roles | `xs-security.json` parses; tests verify all role-template scope references exist. | Templates exist, but no BTP role collections or user assignments were created or inspected. |
| HANA model | `npm.cmd run build:cf` succeeded and generated HANA tables/views plus the CAP Node.js production module. The build copies the existing `/credit` frontend into the server artifact. | Static compilation/build only; not deployed to an HDI container. |
| Seed data | The verified `build:cf` output contains the demo CSV files but no `.hdbtabledata` import artifacts (`contentHdbtabledata=false`). | Confirm the generated archive contents and use a disposable, isolated HDI container. No demo rows should be deployed by this build configuration. |
| Approval persistence | Source uses a conditional Pending-to-decision update and writes the customer limit and audit row inside a CAP transaction. SQLite integration tests verify one winner under concurrent decisions and one audit event. | HANA transaction/isolation/concurrency behavior is unverified. |
| Authentication | Local integration tests verify anonymous 401s, role-based 403s, development Basic-auth behavior, and server-derived roles. Production auth fails closed when no XSUAA binding is present. | No signed JWT, role claim, browser SSO, or logout flow was exercised. |
| Startup | Local tests start CAP; `/health/live` and `/health/ready` are covered. Production startup rejects missing HANA, XSUAA, Destination service, ABAP destination, or non-ABAP data source. | No Cloud Foundry startup has run with bound platform services. |
| Deployment artifacts | `mta.yaml`, `xs-security.json`, `approuter/xs-app.json`, and an App Router module are present. YAML/JSON contract tests pass. App Router 23.4.0 has a clean isolated npm audit. | `cf`, `mbt`, BTP bindings, and ABAP tenant access are unavailable. MTA archive syntax/build/deploy and real router login remain unverified. App Router requires Node.js 22 or 24; local validation host is Node.js 20.20.2. |

The available app environment example contains only optional Anthropic/provider, timeout, and agent-memory settings. HANA and XSUAA credentials must be provided as platform service bindings; do not place secrets in `.env`, frontend files, or source control. `ANTHROPIC_API_KEY` is optional and is not a SAP credential.

## Browser authentication findings

- Production CAP is configured to use XSUAA. CAP's auth middleware fails closed with “no XSUAA instance bound” in an unbound local production-profile check.
- Custom API routes require a CAP user and enforce permission checks. Local tests verify 401/403 outcomes. Development uses CAP mock identities and is not production authentication.
- App Router now has protected catch-all routes, XSUAA authentication, CSRF protection, logout configuration, and unauthenticated health forwarding. Static configuration is tested only. Login/logout, cookie/session lifecycle, token forwarding, CSRF behavior, and role propagation from real XSUAA JWT claims remain **not validated**.
- The frontend is served by CAP under `/credit`; the MTA routes authenticated App Router traffic to CAP and forwards the auth token. Test browser login/logout and CSRF behavior in the target BTP space before use.
- `/health/live` and `/health/ready` are implemented and covered locally. Cloud Foundry invocation, route exposure, and behavior with actual HANA/Destination/XSUAA bindings remain unverified.

## HANA persistence and approval findings

- Static HANA build produced `.hdbtable` files for CDS entities and `.hdbview` files for read-only service projections. The verified build does not produce `.hdbtabledata` imports for synthetic CSV data.
- `LimitRequests` and `ApprovalHistory` are modeled as persistent CDS entities. The API transaction writes the request status, approved customer limit when applicable, and immutable approval-history record together.
- The concurrent approval test is against local in-memory SQLite, not HANA. No initial schema deployment, actual HANA data insertion/readback, restart durability, rollback-on-failure, backup, restore, or recovery test has been run.
- Define HANA backup/restore ownership, retention, recovery-point/recovery-time targets, and a tested restore procedure before storing real credit records. Verify schema evolution and rollback against a disposable non-production HDI container.

## Exact unresolved deployment requirements

1. Confirm BTP subaccount, region, Cloud Foundry org/space, dedicated non-production landscape, entitlements, and authorized operator access.
2. Select/provision compatible HANA Cloud/HDI, XSUAA, and Destination service plans. The MTA currently requests `hana`/`hdi-shared`, `xsuaa`/`application`, and `destination`/`lite`; verify these exact service offerings/plans exist in the target subaccount.
3. Review the existing MTA modules/resources and build the `.mtar` with an installed MTA build tool. Deploy only in an isolated non-production space.
4. Confirm the verified build excludes `.hdbtabledata`, inspect the final archive, and use a new disposable HDI container. Do not use an existing or production data container.
5. Instantiate/update XSUAA scopes, create BTP role collections from the intended templates, assign test users, and verify actual JWT scopes map to CAP roles.
6. Configure protected App Router routes for `/credit`, `/api`, and `/odata`; validate login, logout, token expiry, role propagation, CSRF, and unauthorized access using test identities.
7. Define and test platform liveness/readiness checks and startup behavior with actual bound services.
8. Deploy to a disposable HANA HDI container; verify schema deployment, request persistence across application restarts, audit immutability, transaction rollback, concurrent decisions, and backup/restore.
9. Record non-production deployment and test evidence. Only then assess production readiness separately.

## Manual non-production deployment sequence

These are gated steps, not commands executed in this review:

1. A BTP administrator supplies the Cloud Foundry API endpoint, org/space, approved HANA/HDI and XSUAA service plans, and test-user identities. Install/authorize Cloud Foundry CLI, its MTA deploy plugin, and the Multi-Target Application build tool (`mbt`).
2. Review the existing `mta.yaml`, HANA deployer, bound XSUAA/HANA/Destination resources, and App Router module/`xs-app.json`. Confirm service instance plans against the actual subaccount; do not copy credentials into files.
3. Confirm no synthetic seed-data import artifacts are included in the generated archive; use a new isolated non-production HDI container.
4. From the project root, run:

   ```powershell
   cf login -a <CF_API_ENDPOINT> -o <ORG> -s <SPACE>
   npm.cmd ci
   npm.cmd run build:cf
   mbt build -p cf
   cf deploy mta_archives\<GENERATED_MTA_ARCHIVE>.mtar
   ```

   `npm.cmd run build:cf` was validated locally and builds both HANA and server artifacts without generated HANA seed imports. `cf login`, `mbt build`, and `cf deploy` were not run; install/authorize tools and verify service plans and the destination before attempting deployment.
5. In BTP cockpit, verify XSUAA scopes, create/assign the approved role collections to test users, then test router login/logout, read-only and requester users, controller/finance approvals, expired/invalid tokens, CSRF, and unauthorized routes.
6. Confirm startup and health checks, then verify HANA-created tables/views, synthetic-data decision, request persistence after restart, audit-row integrity, duplicate/concurrent decisions, and restore from a documented backup.

No BTP deploy, SAP connection, or credit decision was performed.

## ABAP integration status

The read-only connector uses SAP Cloud SDK Destination resolution and HTTP requests, bounded pagination, endpoint-relative paths, same-origin next-link validation, schema checks, timeout/error categorization, source timestamps, and deterministic Credit Guard calculations. Its expected custom RAP/OData contract and ADT/destination setup steps are documented in [SAP_INTEGRATION_SPECIFICATION.md](./SAP_INTEGRATION_SPECIFICATION.md). All current connector tests use mocks. No ABAP service was contacted, so live connectivity and business-field mapping remain unverified.
