# SAP Integration Readiness Specification

**Status:** A read-only Destination-service connector now targets a proposed custom RAP/OData contract and is validated with mocked responses. No SAP system, metadata document, API catalog, credentials, or representative payload was available; no live connectivity is claimed. No standard SAP API names or source fields are asserted.

## Source-system decisions required

SAP system owners and business stakeholders must confirm:

1. Product and release (for example, the actual S/4HANA deployment type/version), configured credit-management module, landscape, and target non-production system.
2. The authoritative source for customer master, credit account/segment, limit, exposure, receivables, orders, overdue status, and review date.
3. Released API/service identifiers and versions for those concepts, supported filters/paging/delta mechanisms, documented rate limits, and sample metadata/payloads.
4. Approved network route, identity flow, secret/destination management, and service-account permissions.
5. Whether the integration is read-only. Any write-back requires separate approval, SAP workflow ownership, and an idempotency/reconciliation design.

Until these are supplied, the integration must remain read-only. The current connector is limited to the custom contract below; it does not call presumed standard SAP credit APIs and must not be treated as an implemented mapping to a real tenant.

## Data mapping requirements

| Business concept | Existing app representation | SAP mapping required from owner |
|---|---|---|
| Customer master | `Customers.ID`, `name`, `country`, `companyCode` | Canonical customer/business-partner key, credit account relation, display name/language, country code, organizational scope, and stable key/uniqueness rules. |
| Credit limit | `Customers.creditLimit` (`Decimal(15,2)`) | Authoritative limit, valid-from/to and blocked/expired semantics, applicable credit segment/account, currency, precision, and source timestamp. |
| Credit exposure | Sum of current app `OpenItems.amount` values | Determine whether to consume an authoritative SAP exposure balance or calculate from components. Enumerate included components and transition states; prevent double-counting orders, deliveries, billing, and receivables. |
| Open receivables | `OpenItems` rows with type, amount, due date, and status | Authoritative open amount, document/item keys, sign/clearing/reversal/dispute semantics, baseline/due-date rules, and relationship to customer/segment. |
| Sales orders | `OpenItems.type = 'SalesOrder'` | Determine which lifecycle stages count, commitment/release rules, rejected/cancelled status, and when order exposure is reduced as delivery/billing occurs. |
| Overdue amount | Current app sums items whose status is exactly `Overdue` | Decide whether overdue is supplied or derived; define due-date baseline, payment terms, clearing state, grace period, disputes, payment plans, aging, and timezone/date rules. |
| Currency | Not modeled | Specify currency per limit and exposure component, display/aggregation currency, exchange-rate type/source/date, conversion/rounding policy, and handling of missing/incompatible currencies. |
| Credit segment | Not modeled | Define the credit-management scope and mapping to customer, company code, limit, and exposure. Company code is not assumed to be a credit segment. |
| Credit review date | `Customers.lastReviewDate` | Identify authoritative source/date and owner-approved review interval. Existing 12-calendar-month stale-review rule is application behavior, not confirmed SAP policy. |
| Freshness | Not modeled | Require source change timestamp, extraction timestamp, data latency SLA, delta/retry strategy, stale-data warning/failure behavior, and reconciliation cadence. |
| Limit request/approval | Local `LimitRequests` and `ApprovalHistory` | Decide whether request stays local, is submitted to SAP workflow, or is mirrored. Define system of record, external correlation IDs, approved write path, status synchronization, idempotency, and reconciliation. |

The repository-side model and unresolved items are listed in [SAP_DATA_MAPPING_REQUIREMENTS.md](./SAP_DATA_MAPPING_REQUIREMENTS.md). Current values and rules are synthetic/demo values only.

## Integration contract to agree before implementation

- **Read model:** identify each authoritative SAP object and approved API from metadata, then map to stable application keys without inventing fields.
- **Scope:** include credit segment and currency in keys/aggregations where owners confirm they apply; do not merge unlike currencies or segments.
- **Data quality:** define duplicate, missing, negative, reversed, stale, and partial-response handling. Never silently treat absent amounts as zero.
- **Freshness:** show source/as-of timestamps and define an explicit stale-source policy.
- **Reconciliation:** agree comparison totals with an approved SAP report/source and masked fixtures; define tolerances and evidence.
- **Security:** use platform-managed destinations/secrets and least-privilege read permissions. Do not expose credentials to the browser or logs.
- **Writes:** disabled until a separately approved SAP process and authorization model exist. Local proposal/approval must not be described as an SAP credit-limit update.
- **Operations:** define timeouts, retry/backoff, rate limits, paging, outage behavior, monitoring, and audit correlation before connecting.

## Acceptance gates

1. SAP owner supplies source product/release, API metadata, authorization/network design, and masked representative payloads.
2. Credit-policy owner signs off exposure components, no-double-counting, currency/segment aggregation, overdue semantics, and review policy.
3. Data owners approve field mapping, freshness SLA, missing/outage behavior, and source-of-truth per field.
4. Fixture tests reconcile expected values with an approved source report.
5. Non-production integration uses read-only permissions and verifies pagination, deltas, timeouts, authorization failures, and stale data.
6. Any write-back remains blocked pending a separately approved workflow and end-to-end reconciliation test.

No SAP connection or data access was attempted.

## Proposed custom RAP/OData contract (not an SAP standard)

The connector defaults to relative collection paths `Customers` and `OpenItems` under the administrator-configured `CREDIT_GUARD_ABAP` destination. It accepts OData v2 (`d.results`/`d.__next`) and v4 (`value`/`@odata.nextLink`) collection shapes, uses `$filter` and `$top`, and follows only same-origin links below the configured service path. This contract is a proposal for a custom `Z*` service and has not been validated against an ABAP tenant.

Suggested artifacts for an isolated demonstration system:

- Package: `ZCREDIT_GUARD_DEMO` (name subject to namespace and transport-owner approval).
- Customer entity/view: `ZI_CG_CUSTOMER`; service projection name `Customers`.
- Open-item entity/view: `ZI_CG_OPEN_ITEM`; service projection name `OpenItems`.
- Service definition: `ZUI_CREDIT_GUARD`, exposing those two collections.
- OData V4 Web API service binding, published only in the non-production tenant.
- Read-only RAP behavior and an inbound communication scenario exposing only the published read service.
- Synthetic data in explicitly custom `Z*` persistence tables only. Synthetic records must be labeled as demo data and never presented as live SAP credit data.

| Contract property | OData type / constraint | Connector behavior | Availability and owner confirmation |
|---|---|---|---|
| `CustomerId` | `Edm.String`, 1-12 characters | Required; exact-match key and open-item filter | Proposed custom key; map from an approved customer/business-partner identifier. Existing Credit Guard key is `String(12)`. |
| `CustomerName` | `Edm.String` | Required | Proposed display label; source and language selection unknown. |
| `CreditLimit` | `Edm.Decimal(15,2)` | Required for analysis; non-negative | Custom demo value unless SAP owner identifies an approved source and confirms segment/currency semantics. |
| `Currency` | `Edm.String(3)` | Required for analysis; must match every returned item | Proposed ISO-style currency code; allowed code set and conversion semantics require owner confirmation. |
| `ReviewDate` | `Edm.Date`, nullable | Optional; normalized to `lastReviewDate` | Source and policy are unknown; existing 12-month rule is application behavior, not SAP policy. |
| `Country` | `Edm.String(40)`, nullable | Optional | Existing app display field; source/mapping unknown. |
| `CompanyCode` | `Edm.String(4)`, nullable | Optional | Existing app field; must not be treated as a credit segment without owner confirmation. |
| `RiskClass` | `Edm.String(1)`, nullable | Optional | Existing app display/rule field; mapping and classification semantics unknown. |
| `OpenItemId` | `Edm.String(1..12)` | Required; unique within response key space | Proposed custom key. If a real source identifier exceeds 12 characters, the owner must approve a stable mapping; do not truncate it. |
| `CustomerId` (open item) | `Edm.String(1..12)` | Required; must equal requested customer | Must map to the same approved key as the customer collection. |
| `Type` | `Edm.String(20)` | Required | Candidate values include application values such as invoice/order, not asserted SAP document categories. |
| `Amount` | `Edm.Decimal(15,2)` | Required and finite; missing amounts fail the response | Amount sign, clearing, reversal, and exposure inclusion rules remain unconfirmed. |
| `Currency` (open item) | `Edm.String(3)` | Required and must match the customer currency | No conversion is performed. |
| `DueDate` | `Edm.Date`, nullable | Optional | Date baseline, timezone, terms, and overdue policy require business-owner definition. |
| `Status` | `Edm.String(10)` | Required | Candidate application status. Mapping from SAP lifecycle/clearing states is not defined. |

These are field names and limits of the proposed custom integration contract, not SAP dictionary fields. The connector currently normalizes the supported properties into Credit Guard objects, rejects missing required amounts and currency mismatches, and applies the existing deterministic application rules. It does not derive authoritative SAP exposure.

## ADT implementation and publication checklist

These steps are for an authorized developer in an isolated ABAP Environment tenant; they have not been executed:

1. Confirm tenant release, ABAP Cloud language version, namespace ownership, transport/package policy, and whether approved credit-management APIs/data exist. Use the custom `Z*` entities only if no appropriate approved read service exists.
2. In ADT, create the approved customer package and custom persistence/view entities for the exact contract fields above. Use synthetic records only in a clearly isolated demonstration client/system. Define lengths, decimal precision, keys, nullability, and authorization checks explicitly.
3. Implement a read-only RAP business object or read-only CDS service. Do not define create/update/delete behavior for either collection. Add server-side authorization checks for the agreed communication identity.
4. Create a service definition exposing the two agreed collection names (`Customers`, `OpenItems`), then create and publish an OData V4 Web API service binding. Confirm the final service root and `$metadata` against the connector’s expected names and types; change connector path/config only to match the real, reviewed service.
5. Create the supported inbound communication scenario for that service and publish it. In the tenant administration UI, create the communication system/arrangement and dedicated communication user using the authentication method allowed by the tenant and security owner. Grant only read access.
6. Export `$metadata` and masked representative payloads. Validate IDs, decimal serialization, date serialization, paging links, filters, and returned statuses; update the contract mapping only after owner review.
7. Configure the BTP Destination service entry named `CREDIT_GUARD_ABAP`: HTTPS URL set to the published service root, the tenant-approved authentication type and communication-user mapping, and only required additional properties. Do not put credentials in this repository. Add a Connectivity service binding only if the confirmed network route requires it.
8. Grant the Cloud Foundry application access to the Destination service, deploy only to a non-production space, and verify a read-only request with the approved identity. Confirm that credentials and authorization headers never appear in application logs.
9. Run connector fixtures against masked tenant samples, test missing/extra fields, no-match, pagination, timeout and 401/403 cases, and reconcile calculations with a business-approved report before any demonstration.

Usable copy/paste ABAP Cloud source, synthetic CSV test rows, exact object dependency order, ADT creation/activation steps, communication setup, endpoint configuration, and an opt-in non-production GET smoke test are now in [`abap/adt/README.md`](../../../abap/adt/README.md). The source is intentionally custom `Z*` content; no standard SAP object or API is assumed. The local contract checks and the live smoke test are `tests/abap.contract.test.js` and `tests/abap.live.integration.test.js` respectively.

## Current application setup and boundaries

- Environment settings: `ABAP_DESTINATION_NAME` (default `CREDIT_GUARD_ABAP`), `ABAP_CUSTOMERS_PATH` (default `Customers`), `ABAP_OPEN_ITEMS_PATH` (default `OpenItems`), `ABAP_HTTP_TIMEOUT_MS` (default 10000), `ABAP_MAX_PAGES` (default 20), and `ABAP_PAGE_SIZE` (default 100).
- The app requests GET only through the BTP Destination service SDK. It does not accept a URL from a user, log secrets, or expose an SAP write operation.
- In production, `CREDIT_GUARD_AGENT_DATA_SOURCE=abap` is required. If the destination or ABAP service fails, the tool returns a controlled error; it never substitutes local demo data.
- The ABAP agent tools require the server-derived `CreditReader` permission. Calculations use existing Credit Guard deterministic rules; the LLM is not the calculator.
- Mock-based tests verify connector validation/security paths and agent behavior. They do not prove tenant authentication, API availability, data semantics, or live connectivity.
