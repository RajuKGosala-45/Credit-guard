# SAP Synthetic Simulation Dataset (`MOCK_SAP_GENERATED`)

> **LABEL: SYNTHETIC - NOT REAL SAP DATA**
>
> All table names, field names, and business rules described in this document are written from standard SAP S/4HANA Finance for Credit Management (FIN-FSCM), FI-AR, and SD references for local testing and simulation only.
> **Verify in SE11/SE16N for the target SAP release.**

---

## 1. Overview

The `MOCK_SAP_GENERATED` (`MOCK-SAP-GEN-001`) data source provides a deterministic, seeded 300-Business-Partner synthetic SAP S/4HANA FIN-FSCM dataset for testing Credit Guard's ingestion, canonical validation, projection, and credit-monitoring rules without connecting to a live SAP system.

- **Source ID**: `MOCK-SAP-GEN-001`
- **Source Type**: `MOCK_SAP_GENERATED`
- **Configuration Reference**: `config:mock-sap-generated`
- **Trusted Data Directory**: `db/sap-sim/data/` (gitignored; generated on demand)
- **Default Runtime Expected Results & Notice Output**: `tmp/sap-sim/expected-results.json` and `tmp/sap-sim/SYNTHETIC_NOTICE.txt` (gitignored; default when `--expected-out` is not passed)
- **Committed Baseline Fixture & Notice**: `tests/fixtures/sap-sim/expected-results.json` and `tests/fixtures/sap-sim/SYNTHETIC_NOTICE.txt` (pinned to `seed=42, customers=300, today=2026-11-10`; only overwritten when `--expected-out tests/fixtures/sap-sim/expected-results.json` is explicitly passed)

---

## 2. Generated Tables and Field Formats

**SYNTHETIC - NOT REAL SAP DATA — Verify in SE11/SE16N for the target SAP release.**

The generator (`scripts/generate-sap-sim-data.js`) outputs 6 CSV files under `db/sap-sim/data/`:

| CSV File (`SYNTHETIC - NOT REAL SAP DATA`) | SAP Module | Purpose | Row Count (`seed=42, customers=300`) | Key Fields & Formats (*Verify in SE11/SE16N for the target SAP release.*) |
|---|---|---|---|---|
| `BUT000.csv` | Business Partner | Business Partner general master data (*Verify in SE11/SE16N for the target SAP release.*) | 300 | `PARTNER` (10-digit zero-padded, e.g. `0001000001`), `BPEXT` (`BP-000001`), `NAME_ORG1`, `LAND1`, `BUKRS` (`BS01`..`BS05`), `RISK_CLASS` (`A`/`B`/`C`/`D`), `CREDIT_SGMNT` (`MAIN`), `WAERS` (3-char ISO currency) |
| `UKMBP_CMS_SGM.csv` | FIN-FSCM-CR | Business Partner credit segment profile (*Verify in SE11/SE16N for the target SAP release.*) | 300 | `PARTNER` (10-digit), `CREDIT_SGMNT` (`MAIN`), `CREDIT_LIMIT` (decimal `0.00`..`10000000.00`), `WAERS`, `LIMIT_VALID_DATE` (`YYYYMMDD`), `XBLOCKED` (`X` or empty), `RISK_CLASS`, `FOLLOW_UP_DT` (`YYYYMMDD`) |
| `UKM_ITEM.csv` | FIN-FSCM-CR | Credit management exposure line items (*Verify in SE11/SE16N for the target SAP release.*) | 712 | `ITEM_KEY`, `PARTNER`, `CREDIT_SGMNT`, `BUKRS`, `COMM_TYP` (`OPEN_INVOICE` or `OPEN_ORDER`), `OBJKEY` (`INV-<BELNR>` or `SO-<VBELN>`), `AMOUNT`, `WAERS`, `NETDT` (`YYYYMMDD`) |
| `BSID.csv` | FI-AR | Accounting: Secondary Index for Customers — Open Items (*Verify in SE11/SE16N for the target SAP release.*) | 535 | `KUNNR` (10-digit), `BUKRS`, `BELNR`, `GJAHR` (`2026`), `BUZEI` (`001`), `BLART` (`RV`/`DG`/`DZ`), `SHKZG` (`S`=Debit, `H`=Credit), `WRBTR`, `WAERS`, `DMBTR`, `HWAER`, `ZFBDT` (`YYYYMMDD`), `ZTERM` (`NT30`), `ZBD1T` (`30`), `REBZG` |
| `BSAD.csv` | FI-AR | Accounting: Secondary Index for Customers — Cleared Items (*Verify in SE11/SE16N for the target SAP release.*) | 1,010 | `AUGBL`, `KUNNR` (10-digit), `BUKRS`, `REBZG`, `AUGDT` (`YYYYMMDD`), `WRBTR`, `WAERS`, `ZFBDT` (`YYYYMMDD`), `ZBD1T` (`30`), `BLART` (`DZ`) |
| `VBAK.csv` | SD-SLS | Sales Document: Header Data — Open Sales Orders (*Verify in SE11/SE16N for the target SAP release.*) | 179 | `VBELN` (10-digit), `VKORG`, `VTWEG` (`10`), `SPART` (`00`), `KUNNR` (10-digit), `NETWR`, `WAERK`, `ERDAT` (`YYYYMMDD`), `CMGST` (`A`) |

### Guaranteed Scenarios (`0001000001` – `0001000014`) (`SYNTHETIC - NOT REAL SAP DATA`)

1. `0001000001` (`EXACTLY_80_PERCENT_UTILIZATION`): Limit 500,000 INR, Exposure 400,000 INR (80%) → `WARNING`, flags `["WARNING"]`
2. `0001000002` (`EXACTLY_100_PERCENT_UTILIZATION`): Limit 500,000 INR, Exposure 500,000 INR (100%) → `BREACH`, flags `["BREACH"]`
3. `0001000003` (`EXACTLY_120_PERCENT_UTILIZATION`): Limit 500,000 INR, Exposure 600,000 INR (120%) → `BREACH`, flags `["BREACH", "CRITICAL"]`
4. `0001000004` (`ZERO_CREDIT_LIMIT`): Limit 0.00 INR, Exposure 150,000 INR → `MANUAL_REVIEW`, flags `["NO_LIMIT"]`, utilization `null`
5. `0001000005` (`BLOCKED_ACCOUNT`): `XBLOCKED = 'X'` in `UKMBP_CMS_SGM` (*Verify in SE11/SE16N for the target SAP release.*), Limit 600,000 INR, Exposure 200,000 INR → `HEALTHY`
6. `0001000006` (`OVERDUE_SHARE_ABOVE_30_PERCENT`): Exposure 500,000 INR, Overdue 400,000 INR (80%) → `HEALTHY`, flags `["OVERDUE_RISK"]`
7. `0001000007` (`OVERDUE_SHARE_AT_OR_BELOW_30_PERCENT`): Exposure 500,000 INR, Overdue 100,000 INR (20%) → `HEALTHY`, flags `[]`
8. `0001000008` (`STALE_REVIEW_DATE`): `FOLLOW_UP_DT` in `UKMBP_CMS_SGM` (*Verify in SE11/SE16N for the target SAP release.*) 14 months prior → `HEALTHY`, flags `["STALE_REVIEW"]`
9. `0001000009` (`MIXED_CURRENCY_ITEMS_REJECTED`): Invoices in `INR` (200,000) and `USD` (50,000) → Quarantined during projection (`QUARANTINED_MIXED_CURRENCY`)
10. `0001000010` (`PARTIAL_PAYMENTS_ON_TIME_CLEARING`): Cleared items in `BSAD` (*Verify in SE11/SE16N for the target SAP release.*) with `AUGDT <= ZFBDT + ZBD1T` (`days_late = 0`)
11. `0001000011` (`PARTIAL_PAYMENTS_LATE_CLEARING`): Cleared items in `BSAD` (*Verify in SE11/SE16N for the target SAP release.*) with `AUGDT > ZFBDT + ZBD1T` (`days_late > 0`)
12. `0001000012` (`CREDIT_MEMO_AND_PAYMENT_ON_ACCOUNT_UNMODELED`): `BSID` (*Verify in SE11/SE16N for the target SAP release.*) includes `DG` (credit memo) and `DZ` (payment on account), excluded with persisted quality warnings
13. `0001000013` (`IDENTICAL_DUPLICATE_ROWS`): Identical duplicate invoice row in `BSID`/`UKM_ITEM` (*Verify in SE11/SE16N for the target SAP release.*), deduplicated with `DUPLICATE_SOURCE_IDENTITY` warning
14. `0001000014` (`OPEN_SALES_ORDERS_COMM_TYP`): Open invoice (150,000 USD) + Open sales order in `VBAK` (*Verify in SE11/SE16N for the target SAP release.*) (250,000 USD) projected as `type: 'SalesOrder'`

---

## 3. How to Generate, Extract, and Run Monitoring (`SYNTHETIC - NOT REAL SAP DATA`)

### Date Behavior & Fixed Arguments (`POST /api/mock-sap-generated/load`)
- **Connector & Generator Default Date**: Both `defaultSimClock()` in `srv/integrations/mock-sap-generated/connector.js` and `generateDataset()` / `parseCliArgs()` in `scripts/generate-sap-sim-data.js` default to the **current UTC date** (`new Date().toISOString().slice(0, 10)`). Setting `CREDIT_GUARD_SAP_SIM_AS_OF_DATE=<YYYY-MM-DD>` overrides `defaultSimClock()`.
- **One-Step Load (`POST /api/mock-sap-generated/load`)**:
  - Protected by `requireRole('CreditAdmin')` and `isSapSimEnabled()`.
  - Rejects any query string or request body options (`400 Bad Request`), matching `POST /api/mock-sap-generated/extract`.
  - Runs with **fixed arguments only**: `seed = 42`, `customers = 300`, `today = defaultSimClock().toISOString().slice(0, 10)`, generated into `db/sap-sim/.stage-<uuid>` and moved into `db/sap-sim/data/` (both gitignored). The CSV move is performed per file (via individual `fs.promises.rename` operations, not atomic as a set).
  - Protected by an in-process mutex (`loadInProgress` flag in `srv/integrations/mock-sap-generated/loader.js`) so concurrent `/load` calls return `409 Conflict`.
  - Running `POST /api/mock-sap-generated/extract` at the same moment as `POST /api/mock-sap-generated/load` is not coordinated (`/extract` does not share or check the in-process mutex).
  - Lazily requires `scripts/generate-sap-sim-data.js` after the gate check; if `scripts/` is absent (such as in a stripped package), returns `503 Service Unavailable` without crashing server startup.
  - Executes the `MOCK-SAP-GEN-001` ingestion (projecting 299 customers, 709 open items, 1,010 payments, and 1,010 `CG_PAYMENT_HISTORY` rows atomically once inside `completeIngestionRun`'s transaction) and then triggers one portfolio monitoring run (`executeMonitoringRun` with `runKind: 'MANUAL'`, `source: 'local'`).
- **Environment Flags & Restarting / Reloading in AI Studio**:
  - `CREDIT_GUARD_SAP_SIM=true`: Enables the `MOCK_SAP_GENERATED` source and `/api/mock-sap-generated*` routes when `NODE_ENV=production` or `CDS_ENV=production` (in local development they are enabled by default).
  - `CREDIT_GUARD_SAP_SIM_AUTOLOAD=true`: When `isSapSimEnabled()` is true and `CREDIT_GUARD_SAP_SIM_AUTOLOAD=true` is set, the `cds.on('listening')` startup hook in `srv/server.js` automatically runs `loadGeneratedSapPortfolio` using the synthetic identity `new cds.User({ id: 'sap-sim-autoload', roles: ['CreditAdmin', 'CreditReader'] })`, logging any failure without crashing the server.
  - **How to Restart & Reload in AI Studio**: Because the default development database is in-memory SQLite (`:memory:`), restarting the dev server resets `credit.Customers` to the 13 baseline demo customers (`C001`..`C013`). To reload the 299 generated customers (`312` total) after a restart, either:
    1. Set `CREDIT_GUARD_SAP_SIM=true` and `CREDIT_GUARD_SAP_SIM_AUTOLOAD=true` in the environment before starting the server so the 312-customer portfolio loads automatically on boot, **or**
    2. Call `POST /api/mock-sap-generated/load` with an empty JSON body (`{}`) as `administrator` (`CreditAdmin`).

### A. One-Step Atomic Load Workflow (Recommended — Touches No Tracked Files)

```bash
# 1. Start the CAP server (optionally with CREDIT_GUARD_SAP_SIM_AUTOLOAD=true for automatic startup load)
CREDIT_GUARD_SAP_SIM=true npm run dev

# 2. Trigger atomic generation + extraction + projection + monitoring in one call (CreditAdmin role)
curl -s -u administrator:test -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/api/mock-sap-generated/load | jq .
```

### B. Two-Step CLI Generation & Extraction Workflow (Touches No Tracked Files)

#### Bash / macOS / Linux

```bash
# 1. Generate deterministic 300-BP dataset (seed=42, defaults --today to current UTC date)
#    Writes CSVs to db/sap-sim/data/ and expected-results.json + SYNTHETIC_NOTICE.txt to tmp/sap-sim/ (both gitignored)
node scripts/generate-sap-sim-data.js --seed=42 --customers=300 --out=db/sap-sim/data

# 2. Start the CAP server in development mode
npm run dev

# 3. Inspect synthetic source status (CreditReader role)
curl -s -u reader:test http://localhost:3000/api/mock-sap-generated | jq .

# 4. Trigger extraction & projection (CreditAdmin role)
curl -s -u administrator:test -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/api/mock-sap-generated/extract | jq .

# 5. Trigger portfolio monitoring run
curl -s -u administrator:test -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/api/monitoring/runs | jq .

# 6. Run test suites
npm test
```

#### Windows PowerShell (using `npm.cmd`)

```powershell
# 1. Generate deterministic 300-BP dataset (seed=42) with current UTC date
#    Writes CSVs to db/sap-sim/data/ and expected-results.json + SYNTHETIC_NOTICE.txt to tmp/sap-sim/ (touches no tracked file)
$todayUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
node scripts/generate-sap-sim-data.js --seed=42 --customers=300 --today=$todayUtc --out=db/sap-sim/data

# 2. Start the CAP server (use npm.cmd in PowerShell to avoid execution-policy script wrappers)
$env:CREDIT_GUARD_SAP_SIM_AS_OF_DATE = $todayUtc
npm.cmd run dev

# 3. Or run one-step generate + extract + monitor via POST /api/mock-sap-generated/load
$adminAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("administrator:test"))
Invoke-RestMethod -Uri "http://localhost:3000/api/mock-sap-generated/load" `
  -Method Post `
  -Headers @{ Authorization = "Basic $adminAuth"; "Content-Type" = "application/json" } `
  -Body "{}" | ConvertTo-Json -Depth 6

# 4. Run full test suite and Cloud Foundry build
npm.cmd test
npm.cmd run build:cf
```

### C. Explicit Command to Regenerate the Committed Baseline Fixture (`2026-11-10`)

> **Warning**: The command below writes directly to the tracked files `tests/fixtures/sap-sim/expected-results.json` and `tests/fixtures/sap-sim/SYNTHETIC_NOTICE.txt`. Because the generator is deterministic for `--seed 42 --customers 300 --today 2026-11-10`, running this command will modify tracked files in `git status` **only if the generator logic or `srv/rules.js` changed** (or if line endings differ). Do not run this command for normal daily demos.

```bash
node scripts/generate-sap-sim-data.js --seed 42 --customers 300 --today 2026-11-10 --out db/sap-sim/data --expected-out tests/fixtures/sap-sim/expected-results.json
```

---

## 4. Mapping Decisions & Limitations (`SYNTHETIC - NOT REAL SAP DATA`)

> **SAP Table & Field Notice**: Verify in SE11/SE16N for the target SAP release.

### Mapping Decisions (1–8)
1. **Customer & Credit Account Linkage**: `BUT000` (*Verify in SE11/SE16N for the target SAP release.*) maps to canonical `CUSTOMER`; `UKMBP_CMS_SGM` (*Verify in SE11/SE16N for the target SAP release.*) maps to canonical `CREDIT_ACCOUNT`. `FOLLOW_UP_DT` (`YYYYMMDD`) is converted to ISO `YYYY-MM-DD` and mapped to `customer.lastReviewDate`.
2. **`BSID` Open Invoices**: Only rows in `BSID` (*Verify in SE11/SE16N for the target SAP release.*) with `BLART === 'RV'` and `SHKZG === 'S'` are ingested as canonical `INVOICE` records. `dueDate` is calculated as `ZFBDT + ZBD1T` days.
3. **Unmodeled `BSID` Documents**: Credit memos (`BLART === 'DG'`) and unallocated payments on account (`BLART === 'DZ'`) in `BSID` (*Verify in SE11/SE16N for the target SAP release.*) are excluded from exposure and persisted in `credit.IngestionQualityIssues` (`EXCLUDED_UNMODELED_CREDIT_MEMO`, `EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT`).
4. **Open Sales Orders (`VBAK`)**: Ingested from `VBAK` (*Verify in SE11/SE16N for the target SAP release.*) as canonical `SALES_ORDER` records and projected into `credit.OpenItems` with `type: 'SalesOrder'` (`ID` prefix `MSO`, `dueDate: null`). They are **never** mapped as `Invoice`.
5. **Cleared Payments (`BSAD`) — Option 2B**: Rows in `BSAD` (*Verify in SE11/SE16N for the target SAP release.*) with `BLART === 'DZ'` are ingested as canonical `PAYMENT` records and projected to:
   - `credit.Payments` (`reference = AUGBL`, `postingDate = AUGDT`, `status = 'Cleared'`), and
   - `credit.CG_PAYMENT_HISTORY` (`bp_id = KUNNR`, `company_code = BUKRS`, `payment_doc_no = AUGBL`, `invoice_ref = REBZG`, `payment_date = AUGDT`, `due_date = ZFBDT + ZBD1T`, `days_late = max(0, AUGDT - due_date)`).
6. **Mixed-Currency Quarantine**: Customer `0001000009` (`INR` + `USD` invoices in `SYNTHETIC - NOT REAL SAP DATA`) is quarantined during projection with a persisted `QUARANTINED_MIXED_CURRENCY` warning without failing the extraction run.
7. **Zero-Limit & Blocked Accounts**: Zero-limit accounts (`CREDIT_LIMIT = 0.00` in `UKMBP_CMS_SGM` — *Verify in SE11/SE16N for the target SAP release.*) are ingested and projected normally so `srv/rules.js` classifies them as `MANUAL_REVIEW` (`NO_LIMIT`).
8. **Provenance**: Every canonical record preserves `sourceId`, `sourceEntity`, `sourceRecordId`, `retrievedAt`, `ingestionRunId`, and `mappingVersion`.

### Key Limitations & Open Business Assumptions
- **`decisionEligible: false` vs. `snapshotPromoted: true`**: In `srv/ingestionService.js:591-592`, `promoteSnapshot = !hasErrors && complete` (`true`) while `decisionEligible = promoteSnapshot && fresh && !hasWarnings` (`false`). Because the `MOCK-SAP-GEN-001` synthetic dataset intentionally includes 4 warning-level quality scenarios (`QUARANTINED_MIXED_CURRENCY` for `0001000009`, `EXCLUDED_UNMODELED_CREDIT_MEMO` for `100015`, `EXCLUDED_UNMODELED_PAYMENT_ON_ACCOUNT` for `100016`, and `DUPLICATE_SOURCE_IDENTITY` for `100017`), `hasWarnings` is always `true`, resulting in run status `SUCCEEDED_WITH_WARNINGS`, `snapshotPromoted: true` (all 299 valid customers active in the portfolio), and `decisionEligible: false`.
- **13-Customer Limitation of Autonomous Scan & v2 Canonical Tools (`credit.CG_BUSINESS_PARTNER`)**: Generated customers (`SYNTHETIC - NOT REAL SAP DATA`, 10-digit `PARTNER` IDs `0001000001`..`0001000300`) are projected into `credit.Customers` (`db/schema.cds`), **not** into `credit.CG_BUSINESS_PARTNER`. Consequently, the autonomous scan (`srv/autonomousScheduler.js` / `srv/autonomousDecisionEngine.js`), v2 canonical agent tools (`srv/canonicalAgentTools.js`), v2 exposure snapshots (`credit.CG_EXPOSURE_SNAPSHOT` / `recalculateAllExposureSnapshots` in `srv/exposureCalculator.js`), and the customer 360 dossier (`GET /api/v2/exposure/partners/:bpId` / `getBusinessPartnerCreditDossier` in `srv/canonicalRepository.js`) cover **only the 13 demo customers (`C001`..`C013`)**, while `credit.CG_PAYMENT_HISTORY` also stores the 1,010 cleared payment rows for the generated `PARTNER` IDs.
- **Exact Canonical vs. Projected Row Counts**: A full extraction (`POST /api/mock-sap-generated/extract` or `POST /api/mock-sap-generated/load`) validates **2,322** canonical records across 5 entities (`CUSTOMER = 300`, `CREDIT_ACCOUNT = 300`, `INVOICE = 533`, `SALES_ORDER = 179`, `PAYMENT = 1,010`), deduplicating 1 identical duplicate `BSID` row (`DUPLICATE_SOURCE_IDENTITY`) so **2,321** active canonical rows are promoted to `credit.CanonicalRecords`. During operational projection (`srv/integrations/mock-sap-generated/projection.js`), 1 mixed-currency customer (`0001000009`, with 1 `CUSTOMER`, 1 `CREDIT_ACCOUNT`, and 2 `INVOICE` canonical records in `INR` and `USD`) is quarantined (`0` rows projected for `0001000009`), leaving **299** projected rows in `credit.Customers`, **709** projected rows in `credit.OpenItems` (**530** `Invoice` + **179** `SalesOrder`), **1,010** projected rows in `credit.Payments`, and **1,010** projected rows in `credit.CG_PAYMENT_HISTORY`.
- **Exposure Scope**: Total exposure equals unpaid open invoices (`BSID` `RV`/`S` — *Verify in SE11/SE16N for the target SAP release.*) plus open sales orders (`VBAK` — *Verify in SE11/SE16N for the target SAP release.*). `UKM_ITEM` (*Verify in SE11/SE16N for the target SAP release.*) open deliveries and billing document categories are not generated or used.
- **Blocked Customers (`XBLOCKED = 'X'`)**: Blocked accounts (`0001000005` in `UKMBP_CMS_SGM` — *Verify in SE11/SE16N for the target SAP release.*) are ingested into `credit.Customers`, but `credit.Customers` and `srv/rules.js` do not model a credit block column or flag; `0001000005` is evaluated purely on utilization/overdue/review date (`HEALTHY`).
- **Payment History Scope**: Payment history is populated exclusively from `BSAD` (*Verify in SE11/SE16N for the target SAP release.*) cleared `DZ` rows (all 1,010 rows in `BSAD.csv` have `BLART = 'DZ'`).
- **Shared Portfolio Table (`13 + 299 = 312`)**: The 13 baseline local demo customers (`C001`..`C013`) and the 299 projected generated customers (`0001000001`..`0001000300`, excluding quarantined `0001000009`) coexist in `credit.Customers`. Portfolio queries (`GET /api/customers` and `GET /api/customers/:id`) and monitoring runs (`POST /api/monitoring/runs` or automatic monitoring during `POST /api/mock-sap-generated/load`) over `source: 'local'` evaluate all 312 customers together. Re-extraction replaces only rows belonging to generated customers and never alters the 13 demo customers.
- **Concurrency & File Staging Granularity (`/load` vs `/extract`)**: Staging of the 6 generated synthetic CSV tables moves files individually (`fs.promises.rename` per file, not atomic as a set). Concurrent invocations of `POST /api/mock-sap-generated/load` within the same server process are serialized via an in-process mutex (`loadInProgress`), returning `409 Conflict`. However, running `POST /api/mock-sap-generated/extract` at the same moment as `POST /api/mock-sap-generated/load` is not coordinated (`/extract` does not share or check the mutex).
- **Production Gate (`CREDIT_GUARD_SAP_SIM`)**: When `NODE_ENV=production` or `CDS_ENV=production`, `MOCK_SAP_GENERATED` is disabled by default (not registered in `srv/configuredConnectors.js`, and `GET /api/mock-sap-generated`, `POST /api/mock-sap-generated/extract`, and `POST /api/mock-sap-generated/load` return `403 Forbidden`) unless `CREDIT_GUARD_SAP_SIM=true` is explicitly set.
- **Open Business Assumptions (Verify with Business / SAP Team — Verify in SE11/SE16N for the target SAP release.)**:
  1. Treating `UKMBP_CMS_SGM.FOLLOW_UP_DT` (*Verify in SE11/SE16N for the target SAP release.*) as `lastReviewDate` (in standard FSCM it often represents the next follow-up date rather than the prior review date).
  2. Using `VBAK.NETWR` (*Verify in SE11/SE16N for the target SAP release.*) header net value directly as open sales order credit exposure (`type: 'SalesOrder'`).
  3. Using `BSID.csv` (*Verify in SE11/SE16N for the target SAP release.*) as the single invoice extraction source while `UKM_ITEM.csv` (*Verify in SE11/SE16N for the target SAP release.*) (`OPEN_INVOICE` with `OBJKEY = 'INV-' + BELNR`) mirrors `BSID` for reconciliation only and is not extracted a second time.
  4. Excluding `DG` credit memos and `DZ` payments on account in `BSID` (*Verify in SE11/SE16N for the target SAP release.*) from exposure rather than netting them against receivables.

---

## 5. Deployment Isolation Verification (`npm run build:cf` & MTA)

### Verification Executed
Running `npm run build:cf` executes:
```bash
cds build --production --opts contentHdbtabledata=true
```
Searching `gen/` for any synthetic files:
```bash
find gen -name "*sap-sim*" -o -name "*SYNTHETIC_NOTICE*" -o -name "*expected-results*" -o -name "BUT000.csv" -o -name "UKMBP_CMS_SGM.csv" -o -name "UKM_ITEM.csv" -o -name "BSID.csv" -o -name "BSAD.csv" -o -name "VBAK.csv"
```
**Result**: **0 matches** (`gen/` is completely free of `sap-sim` CSVs, `SYNTHETIC_NOTICE.txt`, and `expected-results.json`). Only the 3 baseline seed CSVs (`credit-Customers.csv`, `credit-OpenItems.csv`, `credit-Payments.csv`) exist under `gen/db/src/gen/data/`.

### Potential Packaging / MTA Conflicts & Proposed Fixes (Not Applied)
1. **Why `db/sap-sim/data/*.csv` Is Excluded Today**:
   - `@sap/cds-dk` (`hana` build task with `csvFileDetection=true`) only copies `.csv` files under `db/` that match a declared CDS entity name (e.g. `credit-Customers.csv`), and blocks all other `.csv` files in `copyNativeContent`.
   - However, `@sap/cds-dk` copies any **non-CSV, non-CDS** file placed inside `db/` into `gen/db/`. For that reason, `SYNTHETIC_NOTICE.txt` and `expected-results.json` are written under `tests/fixtures/sap-sim/` outside `db/`.
2. **Proposed Future Hardening (Do Not Apply Without Approval)**:
   - Move the default generated CSV directory outside `db/` altogether (for example to `tmp/sap-sim/data/` or `tests/fixtures/sap-sim/data/`) so that even if `csvFileDetection=false` is ever set in `package.json` or `mta.yaml`, the HANA HDI deployer module (`db`) can never accidentally pick up files under `db/sap-sim/`.
