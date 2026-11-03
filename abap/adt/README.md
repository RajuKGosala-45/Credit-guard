# Credit Guard ABAP RAP/OData Demo Service

These are source artifacts for a **custom ABAP Cloud demonstration service**, not SAP standard objects, APIs, tables, or live credit data. They match the relative `Customers` and `OpenItems` collections consumed by `srv/integrations/abap/client.js`. No source code in the connector needs to change for this contract.

The service is read-only. There are deliberately no RAP behavior definitions or create/update/delete operations. The two custom tables contain synthetic demonstration values only. Keep them out of productive systems and do not load these CSVs into a tenant containing business data.

## Object inventory and dependencies

Create these objects in an ABAP Cloud package named `ZCREDIT_GUARD_DEMO` (confirm namespace, package policy, and transport assignment with the tenant owner):

| Sequence | Repository object | Type | Source artifact | Depends on |
|---|---|---|---|---|
| 1 | `ZCG_CUSTOMER` | Database Table | [`source/ZCG_CUSTOMER.asddls`](./source/ZCG_CUSTOMER.asddls) | Package |
| 2 | `ZCG_OPEN_ITEM` | Database Table | [`source/ZCG_OPEN_ITEM.asddls`](./source/ZCG_OPEN_ITEM.asddls) | Package |
| 3 | `ZI_CG_CUSTOMER` | Data Definition / root view entity | [`source/ZI_CG_CUSTOMER.asddls`](./source/ZI_CG_CUSTOMER.asddls) | `ZCG_CUSTOMER` |
| 4 | `ZI_CG_OPEN_ITEM` | Data Definition / root view entity | [`source/ZI_CG_OPEN_ITEM.asddls`](./source/ZI_CG_OPEN_ITEM.asddls) | `ZCG_OPEN_ITEM` |
| 5 | `ZC_CG_CUSTOMER` | Data Definition / projection view | [`source/ZC_CG_CUSTOMER.asddls`](./source/ZC_CG_CUSTOMER.asddls) | `ZI_CG_CUSTOMER` |
| 6 | `ZC_CG_OPEN_ITEM` | Data Definition / projection view | [`source/ZC_CG_OPEN_ITEM.asddls`](./source/ZC_CG_OPEN_ITEM.asddls) | `ZI_CG_OPEN_ITEM` |
| 7 | `ZUI_CREDIT_GUARD` | Service Definition | [`source/ZUI_CREDIT_GUARD.srvd`](./source/ZUI_CREDIT_GUARD.srvd) | Both projection views |
| 8 | `ZUI_CG_CREDIT_GUARD_O4` | Service Binding (created in ADT) | OData V4 - Web API | `ZUI_CREDIT_GUARD` |
| 9 | `ZSC_CG_CREDIT_READ` | Communication Scenario (created in ADT) | ADT scenario editor | Published service binding |

`CustomerId` and `OpenItemId` are limited to 12 characters to fit Credit Guard CDS keys. The service properties are deliberately named exactly as the connector expects: `CustomerId`, `CustomerName`, `CreditLimit`, `Currency`, `ReviewDate`, `Country`, `CompanyCode`, `RiskClass`, `OpenItemId`, `Type`, `Amount`, `DueDate`, and `Status`.

The amount fields use `CURR(15,2)` with explicit currency-code annotations in the CDS entities. No currency conversion, authoritative exposure definition, credit-segment logic, or SAP status mapping is implemented. `Country`, `CompanyCode`, `RiskClass`, `ReviewDate`, and item statuses are demo contract fields until their real semantics are approved.

## Create and activate in ADT

1. Connect ADT to the intended **non-production ABAP Environment** system and create/select a package named `ZCREDIT_GUARD_DEMO`. Select the ABAP Cloud language version and an approved transport or local package as required by the system owner.
2. In the package, use **New > Other ABAP Repository Object > Database Table** to create `ZCG_CUSTOMER`. Replace the generated source with `source/ZCG_CUSTOMER.asddls`, check syntax, and activate.
3. Repeat for `ZCG_OPEN_ITEM` using its source file. Do not add generated or standard SAP fields to the API contract without review.
4. Create Data Definition objects `ZI_CG_CUSTOMER` and `ZI_CG_OPEN_ITEM` with the exact object names; paste their matching `.asddls` source and activate.
5. Create projection Data Definitions `ZC_CG_CUSTOMER` and `ZC_CG_OPEN_ITEM`; paste their source and activate.
6. Create Service Definition `ZUI_CREDIT_GUARD`, paste `source/ZUI_CREDIT_GUARD.srvd`, and activate.
7. Right-click the service definition and choose **New Service Binding**. Name it `ZUI_CG_CREDIT_GUARD_O4`, choose **OData V4 - Web API**, finish creation, activate, then **Publish** the binding. The exact menu labels can vary by ADT version.
8. In the published binding preview, inspect `$metadata`. Verify both entity sets are named exactly `Customers` and `OpenItems`, property spellings match this contract, `CreditLimit` and `Amount` are decimal with 2 fraction digits, and dates serialize as `YYYY-MM-DD`. Confirm the service supports `$filter` on `CustomerId`, `$top`, and server paging before integration.

No behavior definition is needed: the service exposes CDS read projections only. Do not add behavior, actions, or writable projections for this milestone.

## Synthetic test records

[`test-data/customers.csv`](./test-data/customers.csv) and [`test-data/open-items.csv`](./test-data/open-items.csv) are synthetic records. They are **not SAP business data**. They exercise the connector's primary scenario:

- `C1001`, limit EUR 1,000, items EUR 700 `Overdue` + EUR 500 `Open`.
- Expected by current Credit Guard rules: EUR 1,200 exposure and 120% utilization, with EUR 700 overdue.
- `C1002` tests a sales-order item; `C1003` tests zero-limit and overdue edge cases.

Load the CSVs only into the two custom tables in a fresh non-production demo client, using the ABAP Environment/ADT data import facility approved by the tenant administrator. Map the listed columns to the identically named table columns (ABAP identifiers are lowercase; CSV headers are uppercase). The `CLIENT` column is client-managed and is intentionally omitted: inserts must occur in the currently selected client. If the tenant does not provide an approved table-data import workflow, use an administrator-approved one-off loader in the development package; do not make a public OData write operation for seeding.

Verify rows via ADT Data Preview. Ensure the customer and open-item `Currency` values match and that each open item references an existing `CustomerId`. Remove the demo rows through the approved development-data cleanup process before repurposing the package; never run demo cleanup against business records.

## Publish a read-only communication scenario

Communication-scenario authoring is a repository object workflow in ADT, not source syntax in these CDS files:

1. Create a Communication Scenario object named `ZSC_CG_CREDIT_READ` in the same package.
2. Add the published OData V4 Web API binding `ZUI_CG_CREDIT_GUARD_O4` as an **inbound** service. Give the service ID `CREDIT_GUARD_READ` if ADT requests one.
3. Expose only this service in the scenario. Do not add outbound services or write-capable APIs.
4. Activate and publish the communication scenario using the ADT workflow supported by the tenant. Record the scenario and service IDs for the administrator.

## Communication system and arrangement

An ABAP tenant administrator performs these steps in the tenant's communication-management apps; names can vary slightly by release:

1. Create a Communication System for the Credit Guard non-production Cloud Foundry application. Use its approved system ID and technical identity.
2. Create a dedicated inbound Communication User / technical user according to the tenant's supported authentication policy. Use only a non-production credential and rotate it according to policy.
3. Create a Communication Arrangement for scenario `ZSC_CG_CREDIT_READ`, select the Communication System, assign the inbound communication user, and activate the arrangement.
4. Confirm the arrangement exposes the published service's HTTPS URL and permits only the agreed read operations. Do not grant unrelated services or write permissions.
5. Configure the BTP Destination service entry named `CREDIT_GUARD_ABAP` with its URL set to the **actual published service root** copied from the arrangement/binding, not a guessed path. Choose the authentication type supported by the tenant and approved by the security owner; keep credentials in Destination service, never in source code or browser configuration.
6. Bind the Destination service to the CAP server. Add Connectivity only if the confirmed network path requires it. Confirm destination lookups execute as the intended technical communication identity.

ABAP Environment versions and tenant policies differ, so use the actual communication-app labels and offered authentication mechanisms. Do not assume basic authentication, principal propagation, a service URL pattern, or a particular inbound user workflow without tenant confirmation.

## Endpoint and connector verification

After publication, copy the exact Service URL shown by ADT/communication arrangement. Set the Destination URL to that service root. The connector uses these relative paths by default:

- `GET <service-root>/Customers?$filter=CustomerId%20eq%20'C1001'&$top=1`
- `GET <service-root>/OpenItems?$filter=CustomerId%20eq%20'C1001'&$top=100`
- `GET <service-root>/$metadata`

The concrete service root is deployment-specific and is intentionally not fabricated here. Inspect actual metadata and sample JSON; the connector accepts OData V4 `value` collections and follows `@odata.nextLink` only within the configured origin/service path.

Expected response property shape (illustrative synthetic payload; metadata/context URLs are supplied by the deployed service):

```json
{
  "value": [
    {
      "CustomerId": "C1001",
      "CustomerName": "Synthetic ABAP Demo Customer 1001",
      "CreditLimit": 1000.00,
      "Currency": "EUR",
      "ReviewDate": "2025-06-01",
      "Country": "DE",
      "CompanyCode": "1000",
      "RiskClass": "A"
    }
  ]
}
```

```json
{
  "value": [
    {
      "OpenItemId": "I-1001",
      "CustomerId": "C1001",
      "Type": "Invoice",
      "Amount": 700.00,
      "Currency": "EUR",
      "DueDate": "2025-10-01",
      "Status": "Overdue"
    }
  ]
}
```

Local mock suite:

```powershell
node --test tests/abap.integration.test.js
```

This verifies the connector against mocked OData payloads and synthetic fixtures, not a SAP tenant.

An opt-in read-only live smoke test is in `tests/abap.live.integration.test.js`. Run it only from an approved non-production environment with a bound Destination service and the synthetic `C1001` rows loaded. From PowerShell, opt in explicitly:

```powershell
$env:ABAP_LIVE_TEST = '1'
$env:ABAP_LIVE_TEST_NONPRODUCTION = 'I_CONFIRM_NONPRODUCTION'
$env:ABAP_LIVE_TEST_CUSTOMER_ID = 'C1001'
$env:ABAP_DESTINATION_NAME = 'CREDIT_GUARD_ABAP'
node --test tests/abap.live.integration.test.js
```

The test performs GETs only. It is skipped unless all opt-in variables are set. Run it where the SAP Cloud SDK can resolve the bound Destination service; do not copy service keys, passwords, bearer tokens, or `VCAP_SERVICES` contents into source, shell transcripts, or chat. A pass confirms only that one non-production read path worked at that moment; it does not validate production readiness or SAP business semantics.
