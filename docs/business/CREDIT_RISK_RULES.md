# Credit Risk Rules

This guide describes the deterministic behavior in `srv/rules.js` as consumed by `srv/creditService.js` and the ABAP provider. These are application rules for a synthetic demo; they are not confirmed SAP policy.

## Exposure eligibility

An item consumes credit only when both conditions are met:

| Field | Accepted values |
|---|---|
| Type | `Invoice`, `SalesOrder` (case-insensitive comparison) |
| Status | `Open`, `Overdue` (case-insensitive comparison) |

All other types and statuses are excluded from exposure. A qualifying record with a missing or invalid due date still contributes exposure, but it does not contribute overdue amount.

Records with the same item ID and identical data are counted once. Conflicting records with the same ID are rejected. The local service and ABAP portfolio validation also reject an item ID assigned to different customers.

## Overdue amount

An item is overdue when it qualifies for exposure and has a valid date-only due date earlier than the current UTC calendar date. A due date equal to today is not overdue. The source `Overdue` status does not supersede the due-date rule.

Missing or malformed dates are treated as unknown, not overdue. Confirm the business timezone and source date semantics before using non-demo data.

## Monetary and currency validation

Amounts and limits must be finite, non-negative numbers. Invalid source values produce an explicit validation error rather than contaminating totals with `NaN`.

When currency is provided, all eligible items for a customer must use the same currency as each other and the customer’s limit. Currency is represented as a three-letter code. The local CDS schema has no currency field; local seed values are synthetic INR. Portfolio aggregation keeps distinct currencies separate and does not present a combined cross-currency amount.

## Utilization and classification

The internal/API `utilisation` value is a ratio to preserve the established contract. For example, `0.8` is 80%. `utilisationPercent` is provided as a percentage value.

| Condition | Main status | Additional flag |
|---|---|---|
| Credit limit is zero | `MANUAL_REVIEW` | `NO_LIMIT` |
| Exposure is greater than a positive limit | `BREACH` | `CRITICAL` when exposure is more than 120% of the limit |
| Utilization is at least 80%, with exposure no greater than the limit | `WARNING` | `WARNING` flag |
| Utilization is below 80% | `HEALTHY` | None required |

At exactly 100%, the customer is `WARNING`. A breach begins only above 100%. A zero limit returns `null` utilization, including when exposure is zero; it never returns `Infinity`.

## Additional indicators

- `OVERDUE_RISK` is added when overdue amount is strictly more than 30% of qualifying exposure.
- `STALE_REVIEW` is added when the valid review date is earlier than the date exactly 12 calendar months before the current UTC date.
- These flags do not replace the main status.
- Missing or invalid review dates do not set `STALE_REVIEW`.

## Unconfirmed business assumptions

Business and SAP owners must confirm item eligibility, whether sales orders should be included with receivables, reversal/clearing semantics, currency and credit-segment treatment, the business timezone, overdue policy, the 80% and 30% thresholds, the 12-month review interval, and critical-risk labeling. No standard SAP exposure calculation is inferred here.
