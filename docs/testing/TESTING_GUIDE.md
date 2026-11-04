# Testing Guide

## Run the suite

From the repository root:

```powershell
npm.cmd test
```

On other platforms, run `npm test`. The package script invokes Node.js `node:test` and requires no separate test framework.

## Coverage areas

- `tests/rules.test.js`: exposure, overdue date rules, duplicate IDs, validation, utilization/status boundaries, stale-review boundary, and approver routing.
- `tests/credit-service.test.js`: currency-separated portfolio aggregation.
- `tests/api.integration.test.js`: live local CAP server, REST contracts, identities, request/approval transitions, concurrency, and OData restrictions.
- `tests/agent.test.js` and `tests/milestone3-readiness.test.js`: tool validation, permissions, bounded execution, proposals, and synthetic business scenarios.
- `tests/abap.contract.test.js` and `tests/abap.integration.test.js`: static source contract and mocked connector behavior.
- `tests/configuration.test.js`: CAP profiles, role templates, startup guards, App Router, and MTA configuration.
- `tests/llm.test.js`: mocked provider calls, timeout, and fallback configuration.
- `tests/abap.live.integration.test.js`: optional live read-only check, skipped unless its explicit non-production opt-in variables are set.

## Test evidence and limits

The suite uses synthetic fixtures, local CAP/SQLite, and provider/HTTP mocks. A passing test does not establish a successful SAP, BTP, HANA, production JWT, or live LLM connection. The optional ABAP smoke test is a GET-only check and must only target an authorized non-production tenant.

## Other checks

- Run the Cloud Foundry build with `npm run build:cf` when validating the CAP/HANA build artifacts.
- Check Markdown links and Git ignore behavior after documentation or structural changes.
- Keep secrets out of test output. Test-only placeholder strings are not usable credentials.
