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
| `ABAP_DESTINATION_NAME` | Named Destination entry used by the connector. |
| `ABAP_CUSTOMERS_PATH`, `ABAP_OPEN_ITEMS_PATH` | OData collection paths relative to the Destination URL. |
| `ABAP_HTTP_TIMEOUT_MS`, `ABAP_MAX_PAGES`, `ABAP_PAGE_SIZE` | Connector request and pagination bounds. |
| `MONITORING_WORKER_POLL_MS` | Durable queue polling interval; defaults to `1000`, maximum `30000`. |
| `MONITORING_WORKER_DRAIN_TIMEOUT_MS` | Maximum graceful worker shutdown drain; defaults to `8000` and is limited to `120000`. Set below the Cloud Foundry process termination grace period. |
| `MONITORING_EXECUTION_DEADLINE_MS` | Overall worker scan deadline; defaults to `120000`, maximum `600000`. ABAP request timeouts are capped to the remaining budget. |
| `MONITORING_ADVISORY_TIMEOUT_MS` | Separate optional AI-summary deadline; defaults to `10000`, maximum `30000`. A timeout uses the deterministic summary. |

Never put credentials in browser variables, tracked files, command output, or logs. Configure BTP credentials through the platform-managed Destination and service bindings.

## Cloud Foundry configuration

The repository contains `mta.yaml`, `xs-security.json`, and an App Router manifest. The MTA descriptor declares CAP server, HDI deployer, App Router, HANA HDI, XSUAA, and Destination service resources. The production startup guard fails closed if required configuration/bindings are absent.

The MTA also binds SAP BTP Job Scheduling and exposes `/api/monitoring/jobs/run`. Binding the service alone does not create a recurring job. Before enabling scheduled monitoring, provision the external Job Scheduler job and interval, configure its OAuth client/credentials, grant the service identity the `CreditMonitorJob` role and `CreditReader` scope, and verify authenticated calls in a non-production subaccount. The endpoint accepts a canonical `scheduledFor` timestamp and enforces a unique run slot. Do not configure a job until role assignment, source access, and operational ownership are validated.

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

The MTA build requires the Multi-Target Application Build Tool. Deployment additionally requires a target Cloud Foundry organization/space with the required service entitlements, service instances, and authorized destination entry.

## SAP Destination

The `credit-guard-destination` service instance is not itself the named destination entry. Create/configure the named destination `CREDIT_GUARD_ABAP` (or set the variable to the approved entry name) with the ABAP service base URL and supported authentication. Grant only the required read permissions.

Local development needs a locally resolvable Destination configuration; a BTP service binding is not automatically available on a developer workstation. Do not paste credentials into source or commit service keys.

## Validation status

No Cloud Foundry deployment, HANA provisioning, App Router browser login, or real ABAP connection is claimed. Configuration tests validate repository content and fail-closed checks only. Follow the [SAP integration guide](../sap-integration/SAP_ABAP_INTEGRATION.md) before attempting non-production connectivity.
