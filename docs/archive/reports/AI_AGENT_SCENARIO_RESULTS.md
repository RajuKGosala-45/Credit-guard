# Milestone 3 AI Agent Scenario Results

**Result:** **7/7 scenarios passed** in deterministic tests against synthetic in-memory fixtures or mocked ABAP responses. The agent's provider was stubbed; no live LLM, BTP, HANA, SAP, or credit operation was used.

| Scenario | Verification | Result |
|---|---|---|
| Analyse one customer | `get_customer` returned calculated customer exposure, utilization, and risk fields; execution completed with a recorded tool step. | Pass |
| Find customers above 90% utilization | `list_customers_over_threshold({min_utilisation: 0.9})` returned only fixture customers at/above the supplied cutoff. Fixture: C001 120%, C002 95%. | Pass |
| Identify overdue high-risk customers | C001 returned risk class `C`, overdue amount 700/total exposure 1,200, overdue share above 30%, and `OVERDUE_RISK`. | Pass |
| Explain limit breach | Tool output showed C001 exposure 1,200 greater than limit 1,000; the response was grounded in that result. | Pass |
| Prepare limit increase | `prepare_limit_change` validated C002's proposal and returned its Controller routing; it did not insert a request. | Pass |
| Request confirmation before submission | Prepared action required human approval/confirmation. Registry exposes no submit/approve/reject tool, and no request was written. Submission remains a separate explicit UI/API action. | Pass |
| Analyse C1001 using ABAP data | Mocked Destination/OData responses passed schema and currency checks; existing deterministic rules returned EUR 1,200 exposure vs EUR 1,000 limit. Source, retrieval timestamp, and customer ID were recorded in execution history. An unavailable destination returns a controlled 503 without local-data fallback. | Pass (mock only) |

These are synthetic test values and not SAP data. `riskClass: C` is the fixture classification; its business definition still needs owner confirmation. The threshold tool is inclusive (`>=`), matching its documented “at or above” behavior.

## Permission, history, and error checks

- Agent tools apply the authenticated CAP user's server-derived reader/requester roles; the existing suite verifies denied proposal-tool access for a reader-only user.
- Agent execution is bounded by step, tool-call, and timeout limits. Existing tests verify timeout/step-limit failures and safe provider-failure categorization/fallback.
- Existing API integration tests verify user-isolated conversation/execution history and clear operations.
- These checks use local CAP/SQLite and provider mocks. They do not prove real LLM output quality, production JWT role mapping, HANA history durability, or SAP semantic correctness.

## Reproduction

```powershell
npm.cmd test
```

The six portfolio scenarios are in [tests/milestone3-readiness.test.js](../../../tests/milestone3-readiness.test.js); ABAP connector and source-contract tests are in [tests/abap.integration.test.js](../../../tests/abap.integration.test.js) and `tests/abap.contract.test.js`. The latest complete run passed **65 tests, 0 failed, 1 opt-in live test skipped**.
