# Business Rules Inventory

## Scope and evidence

This inventory documents the behavior implemented in `srv/rules.js`, as used by `srv/server.js` and `srv/agent.js`. It describes current behavior, not a policy endorsement. Portfolio data is synthetic; the README identifies the project as a demo and not a live SAP integration.

Each item is classified as **Verified working**, **Needs testing**, **Needs improvement**, or **Critical risk**.

## Customer exposure and utilization

| Rule | Current implementation | Classification |
|---|---|---|
| Exposure | `classifyCustomer` adds `Number(item.amount)` for every associated item passed to it. `customerSummaries` passes all records from `credit.OpenItems`; no filtering by status, type, or due date is performed. | **Verified working** for the implemented sum; **Needs testing** against approved business definitions. |
| Overdue amount | Adds amounts only for items whose status is exactly `Overdue`. Due date is not used to determine overdue status. | **Verified working** for the implemented status-based sum; **Needs improvement** if due date should be authoritative or status values can vary. |
| Utilization | `exposure / creditLimit` when the limit is positive; `Infinity` when exposure is positive and limit is zero; otherwise zero. | **Verified working** in the rule smoke checks. |
| Overdue share | `overdueAmount / exposure` when exposure is positive; otherwise zero. | **Verified working** in the rule smoke checks. |
| Portfolio utilization | Dashboard computes total exposure divided by total credit limit, or zero when total limit is zero. This is a weighted aggregate, not the average of customer percentages. | **Verified working** as implemented; **Needs testing** against an authoritative portfolio definition. |
| Grouped exposure | Grouped by country, company code, or customer name; sums exposure and limits and derives group utilization. Rows sort by exposure descending. | **Verified working** by source inspection; **Needs testing** via API/UI integration. |

### Exposure-definition limitation

The current formula sums invoices and sales orders together, as present in the seed data. It does not distinguish committed order exposure from receivables or establish whether the two categories overlap. No connected SAP source or approved exposure definition was found.

- **Classification: Critical risk** if the demo calculation is used as authoritative production credit exposure.
- Before production use, confirm the applicable SAP credit exposure definition, included item categories, deduplication rules, currency conversion, and credit segment.

## Customer status and flags

Configuration constants in `srv/rules.js`:

| Rule | Implemented threshold | Classification |
|---|---:|---|
| Warning | Utilization is at least 80% and at most 100% | **Verified working** |
| Breach | Utilization is greater than 100% and at most 120% | **Verified working** |
| Critical | Utilization is greater than 120% | **Verified working** |
| No limit | Limit is exactly zero and exposure is positive | **Verified working** |
| Overdue risk | Overdue share is strictly greater than 30% | **Verified working** |
| Stale review | Review date is strictly earlier than the current date minus 12 UTC months | **Needs testing** at month-end, leap-year, invalid-date, and timezone boundaries |

The status precedence is `NO_LIMIT`, `CRITICAL`, `BREACH`, `WARNING`, `OVERDUE_RISK`, then `HEALTHY`. `OVERDUE_RISK` and `STALE_REVIEW` can appear in `flags` even when another status takes precedence. An invalid or absent review date does not add `STALE_REVIEW`.

- **Classification: Verified working** for the threshold boundaries exercised in the rule smoke checks.
- **Classification: Needs testing** for dates and malformed data at integration boundaries.

## Limit request routing

For increases, calculate `increase = max(0, requestedLimit - currentLimit)`. The request routes to **Credit Controller** if the increase is at most 25% of current limit **or** at most INR 5,00,000; otherwise it routes to **Finance Head**. Decreases have zero increase and route to **Credit Controller**.

- **Classification: Verified working** for the tested threshold boundary and routing logic.
- **Classification: Needs testing** for zero/current-limit edge cases through the API and for the business approval policy owner's confirmation.
- **Classification: Needs improvement** because `routeApprover` itself assumes valid numeric inputs; validation is performed by the public request route but not by every caller.

## Approval hierarchy

`canDecide` assigns Credit Controller level 1 and Finance Head level 2. Finance Head can decide requests routed to either role; Credit Controller can decide only controller-routed requests. Unknown roles or routed roles fail closed through the level lookup.

- **Classification: Verified working** for the tested role hierarchy.
- **Classification: Critical risk** if treated as real authorization: the route accepts `role` from the client request and does not verify the caller's authenticated identity or server-issued entitlements. See `SECURITY_AND_APPROVAL_REVIEW.md`.

## Validation and calculation limitations

- Monetary values are converted with JavaScript `Number`; malformed values can become `NaN` and propagate through sums. Seed rows and the CDS model provide expected types, but there is no general validation in `classifyCustomer`.
  - **Classification: Needs improvement** for production-grade input/data validation.
- `Infinity` is valid internally for a positive exposure with zero limit. JSON serialization converts non-finite numeric values to `null`, so API consumers may not receive the internal value as a number.
  - **Classification: Needs testing** for the UI/API representation and **Needs improvement** for an explicit, stable wire representation.
- The model has no currency field; current sample data is INR-denominated.
  - **Classification: Critical risk** if inputs from multiple currencies are ever combined without currency conversion.

## Baseline verification performed

A Node.js smoke check against the current `srv/rules.js` passed for utilization boundaries (79.9%, 80%, 100%, just above 100%, 120%, just above 120%), zero-limit behavior, 30% versus greater-than-30% overdue share, request-routing thresholds, and approver hierarchy.

- **Classification: Verified working** for these isolated deterministic cases only.
- API persistence, transaction behavior, date-edge behavior, and business-definition correctness remain **Needs testing**.
