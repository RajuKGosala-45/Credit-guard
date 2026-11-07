# Deployment and Configuration

## Local setup

Use Node.js 22 LTS for both the CAP application and App Router, and install the locked dependencies:

```powershell
npm.cmd ci
npm.cmd run dev
```

The development profile uses mock authentication and in-memory SQLite. The persistent local profile is started with `npm.cmd run start:persistent` and writes `credit-guard.sqlite`, which is ignored by Git.

## Environment variables

Copy `.env.example` to `.env` only when local overrides are required. The template has no real credential.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Optional server-side model credential. Leave unset for offline mode. |
| `LLM_PROVIDER` | Optional provider selection; the implemented remote adapter is Anthropic. |
| `LLM_MODEL` | Optional Anthropic model name. |
| `LLM_TIMEOUT_MS` | Positive whole-number provider timeout in milliseconds; defaults to `15000` and is limited to `120000`. |
| `AGENT_MEMORY_ENABLED` | Enables user-scoped conversation persistence when set to `true`. |
| `CREDIT_GUARD_AGENT_DATA_SOURCE` | `local` by default, or `abap` for the Destination-backed agent, dashboard/customer, and monitoring provider. |
| `CREDIT_GUARD_SYNTHETIC_DEMO` | Must be exactly `true` to run the production profile with the local synthetic portfolio. It is an explicit demo-only opt-in and must not be enabled with the ABAP source. |
| `ABAP_DESTINATION_NAME` | Named Destination entry used by the connector. |
| `ABAP_CUSTOMERS_PATH`, `ABAP_OPEN_ITEMS_PATH` | OData collection paths relative to the Destination URL. |
| `ABAP_HTTP_TIMEOUT_MS`, `ABAP_MAX_PAGES`, `ABAP_PAGE_SIZE` | Connector request and pagination bounds. |
| `MONITORING_WORKER_POLL_MS` | Durable queue polling interval; defaults to `1000`, maximum `30000`. |
| `MONITORING_WORKER_DRAIN_TIMEOUT_MS` | Maximum graceful worker shutdown drain; defaults to `8000` and is limited to `120000`. Set below the Cloud Foundry process termination grace period. |
| `MONITORING_EXECUTION_DEADLINE_MS` | Overall worker scan deadline; defaults to `120000`, maximum `600000`. ABAP request timeouts are capped to the remaining budget. |
| `MONITORING_ADVISORY_TIMEOUT_MS` | Separate optional AI-summary deadline; defaults to `10000`, maximum `30000`. A timeout uses the deterministic summary. |

Never put credentials in browser variables, tracked files, command output, or logs. Configure BTP credentials through the platform-managed Destination and service bindings.

## Cloud Foundry configuration

The repository contains `mta.yaml`, `xs-security.json`, and an App Router manifest. The MTA descriptor selects `CREDIT_GUARD_AGENT_DATA_SOURCE=local` with `CREDIT_GUARD_SYNTHETIC_DEMO=true` for a HANA-backed synthetic client demo. The startup guard still requires the production HANA and XSUAA profiles, plus the Job Scheduler binding; it rejects local production data unless the opt-in is exactly `true`. ABAP mode remains read-only and requires an explicit ABAP Destination name and Destination service binding. The production UI labels the data as demo data; approvals update only local synthetic Credit Guard records and never SAP credit limits.

The MTA also binds SAP BTP Job Scheduling and exposes `/api/monitoring/jobs/run`. Binding the service alone does not create a recurring job. The synthetic demo needs no recurring job; monitoring can be started by an authorized user in the UI. Before enabling scheduled monitoring, provision the external Job Scheduler job and interval, configure its OAuth client/credentials, grant the service identity the `CreditMonitorJob` role and `CreditReader` scope, and verify authenticated calls in a non-production subaccount. The endpoint accepts a canonical `scheduledFor` timestamp and enforces a unique run slot. Do not configure a job until role assignment, source access, and operational ownership are validated.

The monitoring dashboard provides in-app alert visibility and acknowledgment/resolution. Automatic alert resolution requires a complete, non-empty run with verified fresh source data; unknown or stale freshness does not clear active alerts. No external notification destination is configured. Monitoring and dashboard/customer reads use the same selected data provider; production configuration selects ABAP.

Monitoring requests are persisted in HANA as `QUEUED` jobs and return HTTP 202. The CAP service process also runs the worker loop; the queue and singleton portfolio lease are persisted in HANA, so queued work survives process restarts and expired worker leases can be reclaimed. On CAP shutdown, the worker stops polling and claiming jobs, aborts the active run's read signal, and waits up to `MONITORING_WORKER_DRAIN_TIMEOUT_MS` for the operation to settle. If the run settles safely during the drain, its claim is requeued or completed through token-guarded transactional state changes. If the drain expires, the worker deliberately keeps the persisted claim and portfolio lock; process termination and lease expiry provide recovery rather than releasing the lock while an operation may still be active. A lease-expired run is conditionally requeued on worker restart, subject to the existing attempt limit. The existing one-instance service deployment needs no additional CF module or service binding. Database claims are conditional and token-guarded, so scaling additional server instances does not permit simultaneous portfolio scans. Provision the new CDS entities through the normal HDI deployer flow before deploying the updated service. Configure the drain timeout below the actual Cloud Foundry termination grace period and keep the execution deadline plus lease policy within the operational restart window.

Validate shutdown behavior in a non-production space by stopping/restarting the CAP process during an ABAP page read and during run persistence. Confirm that ABAP requests observe cancellation, queued work is retried after clean drain, timed-out drains retain the lock until lease expiry, and recovered jobs cannot be completed by a stale worker token. Graceful-shutdown timing and HANA transaction rollback/commit behavior depend on the target Cloud Foundry and HANA services and are not established by local tests.

The opt-in HANA concurrency suite is `tests/hana-monitoring.integration.test.js`. It requires an explicitly selected production/HANA profile, an HDI schema deployed from the current CDS model, and a disposable schema containing no monitoring runs, findings, alerts, alert events, or outbox rows. It also requires a HANA connection pool able to grant two concurrent connections. Only after verifying those conditions, set `CREDIT_GUARD_HANA_INTEGRATION=1` and `CREDIT_GUARD_HANA_TEST_DISPOSABLE=1` in the isolated test process and run `npm.cmd test -- tests/hana-monitoring.integration.test.js`. The suite checks competing claims through independent HANA transactions, first-time singleton creation, duplicate scheduled slots, transactional rollback, lease reclaim during stale completion, null lock fields, affected-row guards, and stale-token failure/requeue rejection. It deletes its synthetic monitoring records and idle singleton lock; never point it at a shared or production schema. Without both opt-in flags, Node skips the suite without connecting to HANA. Local SQLite and the transaction-aware test double do not establish HANA concurrency behavior.

The dashboard polls the authenticated run-detail endpoint until the run reaches a terminal status. Scheduler retries for the same canonical slot return the existing run rather than creating duplicate jobs. Failed runs do not resolve alerts; recovery is explicitly queued by an authorized monitoring operator and remains bounded by the stored attempt count.

The root CAP package and the separate App Router package both declare `engines.node: ^22.0.0`; the generated `gen/srv/package.json` must retain the CAP declaration so Cloud Foundry selects the same runtime for the server. CAP production uses the package’s HANA profile.

The Cloud Foundry Node.js buildpack documentation selects the runtime from `engines.node`, and the current upstream Node.js buildpack release notes list Node.js 22 builds for `cflinuxfs4` and `cflinuxfs5`. The MTA continues to select `nodejs_buildpack`. This does not verify the buildpack release or stack enabled in a particular SAP BTP subaccount: before deployment, confirm that target space's installed `nodejs_buildpack` offers Node.js 22 and supports the selected stack.

The App Router route for application traffic keeps `csrfProtection: true`. The browser API helper obtains a token with an authenticated same-origin `GET /credit/index.html` request and `X-CSRF-Token: Fetch`, then sends the returned token on every state-changing request. Fetch uses same-origin credentials so the browser sends the App Router session cookie; the client does not read or manually copy HttpOnly cookies. A token-rejected write is reported and is not retried; the next deliberate write obtains a fresh token. Do not disable CSRF protection. This frontend flow has automated mocked-fetch coverage only: validate token response headers, session-cookie continuity, and protected writes through the actual App Router in a non-production deployment before rollout. The lockfile resolves `@sap/approuter` to 23.4.0; verify behavior against that deployed version.

Typical build commands:

```powershell
npm.cmd run build:cf
mbt build
```

The MTA build requires the Multi-Target Application Build Tool. Deployment additionally requires a target Cloud Foundry organization/space with the required service entitlements and a running SAP HANA Cloud database. The MTA provisions the HDI container, XSUAA, Destination service, Job Scheduler, CAP service, and App Router. In synthetic demo mode, the Destination service instance is present for the existing deployment shape, but no named ABAP destination or SAP connection is required. The Job Scheduler service instance is provisioned, but no scheduled job is necessary for the demo.

### HANA-backed synthetic client demo

The Cloud Foundry MTA intentionally uses the local portfolio provider with an explicit demo opt-in. The production profile still uses HANA persistence and XSUAA authentication. `npm run build:cf` generates HDI table and `.hdbtabledata` artifacts from the synthetic CSVs under `db/data/`; the HDI deployer imports them when the database module is deployed. The generated synthetic customers, open items, and payments are demo-only records. Do not set `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` in this demo deployment, and do not present local approval decisions as SAP credit-limit updates.

Before deploying, in the SAP BTP cockpit verify:

1. Cloud Foundry is enabled and a target org/space exists; the space has sufficient app memory/disk quota.
2. SAP HANA Cloud is entitled, a HANA Cloud database is created and running, and the subaccount can provision the `hana` / `hdi-shared` service plan.
3. The subaccount is entitled for `xsuaa` / `application`, `destination` / `lite`, and `jobscheduler` / `standard`. These are declared by `mta.yaml`; confirm that the trial subaccount actually offers each plan before deployment.
4. The installed `nodejs_buildpack` supports Node.js 22 on the target stack. Both app packages declare Node.js `^22.0.0`.
5. The updated XSUAA application configuration has been applied and an administrator can assign the `ReadOnlyBusinessUser`, `CreditAnalyst`, `CreditManager`, `CreditApprover`, `Administrator`, or `CreditMonitorOperator` role collection to demo users as appropriate.
6. No ABAP Destination entry is required for this synthetic deployment. If later switching the deployed application to ABAP, use a separately reviewed deployment configuration with `CREDIT_GUARD_AGENT_DATA_SOURCE=abap`, `ABAP_DESTINATION_NAME`, a bound Destination service, and an authorized named destination. ABAP read paths remain GET-only; requests and approvals remain disabled in that mode.

Typical PowerShell deployment sequence (use your own BTP API endpoint, org and space; do not put credentials in command-line arguments):

```powershell
cf login -a <CF_API_ENDPOINT>
cf target -o <ORG> -s <SPACE>
cf marketplace -s hana
cf marketplace -s xsuaa
cf marketplace -s destination
cf marketplace -s jobscheduler
npm.cmd ci
npm.cmd run build:cf
mbt build -t mta_archives
cf deploy mta_archives/credit-guard_1.0.0.mtar
cf apps
```

The MTA creates its declared service instances; an HDI container is not a substitute for creating and starting the underlying HANA Cloud database. If any declared service plan is unavailable in the trial, deployment will fail until the needed entitlement/instance is available; do not silently remove production startup checks. The command above builds a deployment archive and starts deployment, but does not itself prove successful runtime operation.

### Post-deployment validation checklist

1. Wait for the HDI deployer to finish successfully and inspect its deployment logs for successful table/data artifact import; do not print service credentials or full `VCAP_SERVICES`.
2. Confirm CAP and App Router apps are started and healthy; request the App Router’s public `/health/ready` endpoint and expect HTTP 200.
3. Open the App Router URL in a normal browser and verify XSUAA login, logout, and CSRF-protected state-changing requests.
4. Assign a least-privilege demo role collection. Verify a reader can view the portfolio but cannot submit requests or decide approvals; verify requester and approver roles in local synthetic mode.
5. Confirm the dashboard contains the synthetic seeded portfolio, open a customer, run monitoring, inspect persisted findings, and exercise an agent read/tool interaction without configuring an external LLM credential.
6. Submit a synthetic credit-limit request and approve/reject it with a reason. Verify audit history and explicitly confirm that the approval changes only Credit Guard’s local synthetic HANA row, not SAP.
7. Restart the CAP app and verify seeded data and request/approval/monitoring records persist. Review logs for startup errors without exposing credentials or customer payloads.
8. Do not claim SAP connectivity, live source freshness, or SAP write-back. For ABAP mode, separately verify a non-production named Destination and read-only source access; no such validation is part of this deployment checklist.

## SAP Destination

The `credit-guard-destination` service instance is not itself the named destination entry. Create/configure the named destination `CREDIT_GUARD_ABAP` (or set the variable to the approved entry name) with the ABAP service base URL and supported authentication. Grant only the required read permissions.

Local development needs a locally resolvable Destination configuration; a BTP service binding is not automatically available on a developer workstation. Do not paste credentials into source or commit service keys.

## Validation status

No Cloud Foundry deployment, HANA provisioning, App Router browser login, or real ABAP connection is claimed. Configuration tests validate repository content and fail-closed checks only. Follow the [SAP integration guide](../sap-integration/SAP_ABAP_INTEGRATION.md) before attempting non-production connectivity.
