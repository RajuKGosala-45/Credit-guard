# Deployment and Configuration

## Local setup

Use Node.js 20 LTS for the CAP application and install the locked dependencies:

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
| `CREDIT_GUARD_AGENT_DATA_SOURCE` | `local` by default, or `abap` for the Destination-backed agent provider. |
| `ABAP_DESTINATION_NAME` | Named Destination entry used by the connector. |
| `ABAP_CUSTOMERS_PATH`, `ABAP_OPEN_ITEMS_PATH` | OData collection paths relative to the Destination URL. |
| `ABAP_HTTP_TIMEOUT_MS`, `ABAP_MAX_PAGES`, `ABAP_PAGE_SIZE` | Connector request and pagination bounds. |

Never put credentials in browser variables, tracked files, command output, or logs. Configure BTP credentials through the platform-managed Destination and service bindings.

## Cloud Foundry configuration

The repository contains `mta.yaml`, `xs-security.json`, and an App Router manifest. The MTA descriptor declares CAP server, HDI deployer, App Router, HANA HDI, XSUAA, and Destination service resources. The production startup guard fails closed if required configuration/bindings are absent.

The separate App Router package declares Node.js 22 or 24. Verify compatible Cloud Foundry buildpacks and runtime versions before deployment. CAP production uses the package’s HANA profile.

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
