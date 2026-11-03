# SAP Data Mapping Requirements

## Status and source evidence

This document defines information required to map SAP data into the existing application model. It does not claim a live SAP connection or prescribe technical SAP field names. No SAP system, service metadata, API documentation, or representative payload was available in the repository review.

### Confirmed application-side fields

The CDS model (`db/schema.cds`) currently stores:

- Customer: `ID`, `name`, `country`, `companyCode`, `creditLimit`, `riskClass`, `lastReviewDate`.
- Open item: `ID`, `customer`, `type`, `amount`, `dueDate`, `status`.
- Limit request: customer reference, current/requested limit, reason, requester, status, routed approver level, decider, created/decision timestamps.
- No currency, credit segment, SAP source key, SAP update timestamp, source-system identity, or data freshness metadata is present in those entities.

These are confirmed fields in the current app, not confirmed SAP source fields.

## Proposed mapping worksheet

| App field / concept | Current meaning in app | SAP field/API requirement | Status / unresolved decision |
|---|---|---|---|
| `Customers.ID` | Demo key such as `C001` | Identify canonical SAP business-partner/customer key and any separate credit-account key; define normalization and uniqueness. | **Unknown.** Do not assume demo IDs match SAP. |
| `Customers.name` | Display name | Identify authoritative display name, language/locale behavior, and whether legal/trading name is needed. | **Unknown.** |
| `Customers.country` | Grouping label | Identify country code/name source and accepted ISO/domain values. | **Unknown.** |
| `Customers.companyCode` | Grouping label | Determine whether company code is applicable to customer credit scope; identify relation to credit segment and organizational assignment. | **Unknown.** A company code must not be assumed equivalent to a credit segment. |
| `Customers.creditLimit` | Limit used as denominator for utilization | Identify authoritative limit, scope (account/segment), currency, validity dates, blocked/expired state, and precision. | **Unknown.** |
| `Customers.riskClass` | One-character demo class used in assistant recommendation | Identify whether SAP provides an equivalent risk class, its domain/customizing, effective date, and mapping. | **Unknown.** Do not map letter classes by intuition. |
| `Customers.lastReviewDate` | Date used for stale-review flag | Identify authoritative review date and applicable review interval/calendar. | **Unknown.** Twelve months is the current app threshold, not confirmed SAP policy. |
| `OpenItems.ID` | Demo open-item identifier | Identify stable source document/item key and composite-key needs. | **Unknown.** |
| `OpenItems.customer` | Link to demo customer | Define relationship to canonical customer key and credit scope. | **Unknown.** |
| `OpenItems.type` | Sample `Invoice` or `SalesOrder` | Enumerate source exposure components and their lifecycle stages; identify whether they are included in authoritative credit exposure and how overlap is avoided. | **Critical unresolved business rule.** No invoice-plus-order summation should be assumed. |
| `OpenItems.amount` | Decimal amount included in exposure | Identify source amount, sign convention, currency, conversion policy, and whether amount is open, net, or committed balance. | **Unknown.** |
| `OpenItems.dueDate` | Seed due date | Identify due date semantics, clearing status, dispute/hold status, grace periods, and time zone/date handling relevant to overdue. | **Unknown.** |
| `OpenItems.status` | `Overdue` or `Open` in sample; only exact `Overdue` counts as overdue | Identify source status/domain and approved overdue computation. Decide whether status is authoritative or overdue is derived from date/state. | **Unknown.** |
| `LimitRequests` | Local approval workflow | Decide whether this is only an application request record, a proxy to SAP workflow, or a source-system workflow record. Define external correlation/status IDs if applicable. | **Unknown.** Current requests are local and transient. |
| Update/freshness metadata | Not modeled | Determine source last-changed timestamp, extraction timestamp, data freshness SLA, and stale-data behavior. | **Missing from current schema; requirement decision needed.** |
| Currency and credit segment | Not modeled | Establish currency key and credit segment/credit account scope for every applicable limit and exposure component. | **Critical unresolved requirement** before aggregation. |

## SAP API/source selection requirements

Do not select a service by name before learning the SAP product and release. The following must be confirmed with the SAP system owner:

1. SAP product, release, hosting model, configured credit-management module, and target landscape.
2. Supported released APIs/services for each required customer, limit, credit exposure, open-item, and approval/workflow data concept.
3. API/service version, entity keys, field domains, units/currency semantics, paging/filter support, delta/change tracking, and documented rate limits.
4. Authentication and network route supported by the landscape; use an approved destination/secret service where applicable.
5. Whether the source is authoritative for each field or whether a curated SAP report/API is the approved source.
6. Whether any write operation is allowed. Until approved, treat the SAP adapter as read-only.

**Reason:** Current repository has no adapter, destination, credentials, or source metadata.

| Recommendation | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|
| Select SAP APIs only after source system/release and field semantics are known. | Future SAP adapter/configuration, `db/schema.cds`, data-mapping documentation | SAP owner, API catalog/metadata access, landscape details | Unreleased or semantically wrong interface; incompatible API versions | Verify service metadata and sample payload against approved field mapping in non-production. |
| Define read-only integration scope first; require separately approved workflow for any write. | Future SAP adapter, `srv/server.js`, `srv/service.cds`, security design | Credit process owner, SAP workflow owner, identity design | Direct writes bypass SAP controls or cause source/application divergence | Test that read identity cannot write; if later approved, test workflow authorization, idempotency, and reconciliation. |
| Obtain masked representative fixtures and expected totals before implementation. | Future test fixtures and adapter tests, `BASELINE_TEST_PLAN.md` | SAP business owner and data steward | Synthetic data fails to reveal edge cases; sensitive data may be exposed | Reconcile fixture results to approved SAP source/report totals; retain masking and provenance evidence. |

## Business decisions required (do not infer)

### Credit exposure

- Is the target metric an SAP credit exposure balance, a custom portfolio calculation, or both?
- Which exposure categories are included: receivables, orders, deliveries, billing, special G/L, or other configured components?
- At what lifecycle stage is each order/item counted?
- How are document transitions handled to prevent counting an order and resulting receivable twice?
- How are cleared, reversed, disputed, blocked, or partially paid items treated?
- Which credit segment/account and organizational scope is being summarized?

### Currency and values

- Is the application single-currency or multi-currency?
- If multi-currency, what currency is the portfolio display currency?
- Which exchange-rate type and effective date are used, and which component owns conversion?
- What rounding, decimal precision, negative balance, and missing-value rules apply?

### Overdue and review rules

- Is overdue based on SAP status, due date, baseline date/payment terms, aging bucket, or another approved rule?
- Are disputes, grace periods, payment plans, and clearing status excluded or handled specially?
- Is the existing `>30%` overdue-share and `12-month` stale-review policy approved, configurable, or demo-only?

### Writes and approval

- Are credit-limit requests recorded locally, sent into a SAP workflow, or both?
- Which system is authoritative after approval?
- Is an approved request automatically written to SAP, or does SAP approval remain a separate required step?
- What external request IDs, status synchronization, idempotency, and failure reconciliation are required?

All questions remain **unconfirmed**. No SAP business logic is invented in this design.

## Mapping acceptance criteria

Do not implement an authoritative SAP calculation until all of these are true:

1. Every app field has a documented source, key, conversion, domain, and owner, or is explicitly identified as app-derived.
2. Exposure categories and no-double-counting policy are signed off by the credit policy owner.
3. Currency/credit-segment scope and exchange-rate rules are documented and testable.
4. Masked fixtures reconcile to approved source totals within an agreed tolerance.
5. Freshness, missing/outage behavior, and read/write scope are approved.
6. Security credentials and service permissions are verified in a non-production SAP environment.
