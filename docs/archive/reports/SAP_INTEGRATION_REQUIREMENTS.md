# SAP Integration Requirements and Unknowns

## Current-state finding

No live SAP integration adapter, destination configuration, credentials flow, SAP SDK dependency, remote OData client, or external SAP service definition was found in the inspected repository. `db/data/*.csv` contains synthetic customer and open-item records. The README explicitly describes the project as a demo and says it is not connected to a live ERP.

- **Classification: Verified working** that the current application is a synthetic-data demo, based on repository/configuration review.
- **Classification: Critical risk** if its computed exposure or status is represented as current SAP credit data.

## Requirements to settle before integration

| Topic | Requirement / open question | Classification |
|---|---|---|
| SAP product and deployment | Identify source system/version: SAP S/4HANA or ECC; on-premise, private cloud, or public cloud; SAP Credit Management/FSCM or another system. Identify DEV/QA/PROD landscape and owners. | **Needs testing** / discovery; currently unknown. |
| Authoritative exposure definition | Define whether the intended value is SAP credit exposure by credit segment and which receivables, sales orders, deliveries, billing documents, special G/L, disputes, and commitments are included or excluded. Define overlap and reconciliation rules. | **Critical risk** until approved; **Needs testing** against SAP reports/API results. |
| Source interface | Select supported OData/API/CDS view/BAPI or approved integration service for each entity. Confirm release compatibility, service version, pagination, filtering, and field semantics. | **Needs improvement**; no source interface is configured. |
| Customer identity | Map SAP Business Partner/customer IDs to current `Customers.ID`; define company-code and credit-segment relationships, duplicate handling, renamed/deactivated customers, and merge rules. | **Needs improvement**; current data model/seed does not define the SAP key mapping. |
| Credit limit semantics | Establish which limit (credit segment/account), currency, validity dates, status, risk class, and review date are authoritative. Define how SAP represents zero, missing, blocked, or expired limits. | **Needs improvement**; these source semantics are not modeled or verified. |
| Currency and amount semantics | Confirm source currency per amount, exchange-rate type/date, rounding, decimal scale, and whether portfolio totals may span currencies. Current schema has no currency field and sample data is INR-only. | **Critical risk** if multi-currency values are aggregated; **Needs testing** with representative SAP records. |
| Overdue logic | Confirm whether SAP status, due date, clearing status, dispute status, grace periods, and aging buckets define overdue. Current rule relies only on status exactly equal to `Overdue`. | **Needs improvement** until business owner and SAP field mapping agree. |
| Read/write scope | Decide whether Phase 1+ integration is read-only. For limit changes, define whether the application creates a SAP workflow request, writes only after SAP approval, or remains a local demo request system. Do not write credit limits directly without SAP authorization and workflow design. | **Critical risk** until the write path and approvals are approved. |
| Authentication and authorization | Select supported integration identity (OAuth client credentials, principal propagation, certificates, or approved destination service); define user-to-SAP authorization, least privilege, secret storage, rotation, and audit attribution. | **Critical risk** until designed and tested. |
| Connectivity | Define network path, SAP BTP Destination/Connectivity needs, allowlists, TLS/certificates, proxy, DNS, timeout, and environment-specific configuration. | **Needs improvement**; no connectivity setup exists. |
| Reliability | Define rate limits, retries/backoff, idempotency, pagination checkpoints, incremental/full-sync strategy, freshness SLAs, outage/degraded mode, and reconciliation alerts. | **Needs improvement**; no integration reliability strategy exists. |
| Audit and privacy | Define what SAP data and user identifiers may be cached, logged, sent to an LLM, retained, or exported. Establish data residency and retention obligations. | **Critical risk** for confidential/regulated business data until approved. |
| Test fixtures | Obtain masked representative SAP records and expected exposure/reconciliation totals; retain synthetic fixtures for automated offline tests. | **Needs testing**; no SAP fixture or reconciliation suite was found. |
| Operational ownership | Assign owners for SAP API changes, credentials, incident response, monitoring, and transport/deployment. | **Needs improvement**; ownership is not documented in the repository. |

## Minimum discovery questions

1. Which SAP product/system is the source of truth for credit exposure and limits?
2. Which SAP credit segment and customer identifier should map to this application's customer records?
3. What exact exposure components should be included, and how should invoice/order overlap be prevented?
4. Which currencies are supported and what exchange-rate policy applies?
5. Is the first SAP integration read-only? If not, what SAP workflow and authenticated approval controls authorize writes?
6. Which integration pattern and identity mechanism are supported in the target landscape?
7. What freshness, availability, audit, retention, and data-protection requirements apply?

## Recommendation

Keep the current CSV-backed demo isolated from SAP until the above decisions have owners and test evidence. Treat a future SAP adapter as a controlled integration boundary; keep deterministic credit calculations in the business layer and reconcile them with authoritative SAP values rather than assuming a generic sum of invoices and sales orders is equivalent.

- **Classification: Needs improvement** before production integration.
- No SAP code, configuration, or credentials were added as part of this review.
