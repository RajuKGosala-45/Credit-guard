# SAP ABAP Integration

## Current integration boundary

`srv/integrations/abap/client.js` uses SAP Cloud SDK Destination resolution and HTTP requests to call relative OData collection paths. The default destination name is `CREDIT_GUARD_ABAP`; the default collection paths are `Customers` and `OpenItems`. These can be overridden with environment variables.

The connector supports OData v4 and common v2 collection shapes, pagination, bounded page counts, request timeouts, same-origin pagination-link checks, response validation, currency checks, and normalization into Credit Guard objects. It uses existing deterministic rules for analysis. Connector behavior is tested with mocked Destination and OData responses.

## Expected custom service contract

The connector expects:

- `Customers`: `CustomerId`, `CustomerName`, `CreditLimit`, `Currency`, `ReviewDate`, `Country`, `CompanyCode`, `RiskClass`.
- `OpenItems`: `OpenItemId`, `CustomerId`, `Type`, `Amount`, `Currency`, `DueDate`, `Status`.

Collection paths are relative to the configured Destination URL. Do not configure an Eclipse local test-client URL as a production Destination.

## Source artifacts

`abap/adt/source/` contains proposed custom `Z*` CDS/service artifacts. `abap/adt/test-data/` contains synthetic CSV rows. The artifacts are not SAP standard content and have not been activated in an ABAP tenant.

Use [the ADT guide](../../abap/adt/README.md) for the object dependency sequence, activation steps, OData V4 binding publication, communication scenario/arrangement setup, and optional non-production smoke test.

## Local and deployed configuration

The connector resolves a BTP Destination through the SAP Cloud SDK. A Destination service instance binding and the named destination entry are distinct configuration. A service binding in Cloud Foundry does not automatically make that destination resolvable from an unbound local process.

Expected variables include `ABAP_DESTINATION_NAME`, `ABAP_CUSTOMERS_PATH`, `ABAP_OPEN_ITEMS_PATH`, `ABAP_HTTP_TIMEOUT_MS`, `ABAP_MAX_PAGES`, and `ABAP_PAGE_SIZE`. Do not put credentials in the frontend or commit service keys.

## Verification status

Automated connector tests use mocks and synthetic records. No authenticated request to a real ABAP tenant has succeeded in this repository. Do not claim live connectivity, real customer data, or validated SAP business semantics.

Before a real non-production connection, owners must confirm service metadata, field meanings, item eligibility, currency and credit-segment semantics, data freshness, communication-user permissions, and source-of-truth rules. Keep the initial integration read-only.
