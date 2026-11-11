# SAP ECC and S/4HANA Credit Management Data Dictionary

> **DATA NOTICE**: `SYNTHETIC - NOT REAL SAP DATA` — All simulator extracts (`db/sap-sim/data/*.csv`) and fixture files (`tests/fixtures/sap-sim/*`) referenced in this repository are 100% synthetic and generated deterministically by `scripts/generate-sap-sim-data.js`.
>
> **SAP TABLE & FIELD VERIFICATION NOTICE**: All SAP table names, technical field names, ABAP dictionary data types, lengths, and domain values documented below have not been validated against a live SAP tenant. **Verify in SE11/SE16N for the target SAP release.**

---

## 1. Scope and Purpose

This document provides the technical data dictionary for SAP ERP Central Component (ECC) and SAP S/4HANA tables relevant to order-to-cash (O2C) and credit management:

1. **Customer Master & Business Partner (CVI)**: `KNA1`, `KNB1`, `KNVV`, `BUT000`, `CVI_CUST_LINK`
2. **Classic Credit Management (FI-AR-CR) vs. S/4HANA FIN-FSCM Credit Management (FIN-FSCM-CR)**: `KNKK`, `KNKA`, `T014` vs. `UKMBP_CMS`, `UKMBP_CMS_SGM`, `UKM_ITEM`, `UKM_TOTALS`
3. **Sales Orders (SD-SLS)**: `VBAK`, `VBAP`, `VBEP`
4. **Outbound Deliveries (LE-SHP)**: `LIKP`, `LIPS`
5. **Billing Documents (SD-BIL)**: `VBRK`, `VBRP`
6. **Receivables, Payments & Clearing (FI-AR / Universal Journal)**: `BKPF`, `BSEG`, `BSID`, `BSAD`, `ACDOCA`

---

## 2. ECC-to-S/4HANA Architectural & Table Compatibility Matrix

*(Verify in SE11/SE16N for the target SAP release.)*

| Functional Domain | SAP ECC 6.0 Primary Tables | SAP S/4HANA Primary Tables / Views | S/4HANA Architectural Change & Compatibility Notes | Used in `MOCK-SAP-GEN-001` (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|
| **Customer Master (General)** | `KNA1` | `BUT000` + `KNA1` (via Customer-Vendor Integration `CVI_CUST_LINK`) | In S/4HANA, Business Partner (`BUT000`) is the leading master object (transaction `BP`). `KNA1` remains populated synchronously via CVI for SD/FI compatibility. | `BUT000.csv` (general BP + synthetic company/country attributes) |
| **Customer Master (Company Code & Sales Area)** | `KNB1` (FI), `KNVV` (SD) | `KNB1`, `KNVV` (synchronized via CVI) | Company-code payment terms/reconciliation account (`KNB1`) and sales-area currency/billing data (`KNVV`) remain active tables synced from BP roles `FLCU00` and `FLCU01`. | Represented as denormalized attributes on `BUT000.csv` in simulator |
| **Credit Profile & Risk Class** | `KNKA` (Central), `KNKK` (Credit Control Area `KKBER`) | `UKMBP_CMS` (BP Credit Master) | Classic `KNKK.CTLPC` (risk category) is replaced by FIN-FSCM-CR `UKMBP_CMS.RISK_CLASS` and `CREDIT_GROUP` on BP role `UKM000`. | Denormalized on `UKMBP_CMS_SGM.csv` (`RISK_CLASS`) |
| **Credit Limit & Segment Master** | `KNKK` (keyed by `KUNNR` + `KKBER`, table `T014`) | `UKMBP_CMS_SGM` (keyed by `PARTNER` + `CREDIT_SGMNT`) | Classic FI-AR Credit Management (`KNKK`/`F.35`/`FD32`) is deprecated in S/4HANA in favor of FIN-FSCM-CR (`UKMBP_CMS_SGM`, transaction `UKM_BP`). | `UKMBP_CMS_SGM.csv` |
| **Credit Exposure & Commitment Line Items** | `S066` (Open order credit value), `S067` (Open delivery/billing value), `KNKK.SKFOR`/`SSOBL` | `UKM_ITEM` (Line items), `UKM_TOTALS` (Aggregated totals by `COMM_TYP`) | LIS info structures `S066`/`S067` are replaced by FIN-FSCM-CR commitment items in `UKM_ITEM` (categories such as `100` Open Orders, `200` Open Invoices, `400` Open Deliveries/Billing). | `UKM_ITEM.csv` (`COMM_TYP`: `OPEN_ORDER`, `OPEN_INVOICE`) |
| **Sales Orders** | `VBAK` (Header), `VBAP` (Item), `VBUK`/`VBUP` (Status) | `VBAK` (Header with embedded status fields), `VBAP` (Item with embedded status fields) | Separate status tables `VBUK` and `VBUP` were eliminated in S/4HANA; overall credit status (`CMGST`) and lifecycle status (`GBSTK`) live directly on `VBAK`/`VBAP`. | `VBAK.csv` |
| **Deliveries** | `LIKP` (Header), `LIPS` (Item), `VBUK`/`VBUP` | `LIKP` (Header with embedded status), `LIPS` (Item with embedded status) | Delivery status fields moved from `VBUK`/`VBUP` directly into `LIKP`/`LIPS`. | Not generated as separate CSV in Step 1 |
| **Billing Documents** | `VBRK` (Header), `VBRP` (Item), `VBUK` | `VBRK` (Header with embedded status), `VBRP` (Item) | Billing status and accounting transfer status (`RFBSK`) reside directly in `VBRK`. | Not generated as separate CSV in Step 1 |
| **Accounting Line Items & Open/Cleared AR** | `BKPF` (Header), `BSEG` (Cluster table), `BSID` (Open AR index), `BSAD` (Cleared AR index) | `BKPF` (Header), `ACDOCA` (Universal Journal), `BSID`/`BSAD` (Compatibility CDS views over `ACDOCA`/`BSEG`) | In S/4HANA, `ACDOCA` is the single source of truth for FI/CO line items. `BSID` (open customer items) and `BSAD` (cleared customer items) exist as compatibility DDL/CDS views (`BSID_VIEW`/`BSAD_VIEW`) so read queries continue to work. | `BSID.csv`, `BSAD.csv` |

---

## 3. Customer Master & Business Partner Tables

*(Verify in SE11/SE16N for the target SAP release.)*

### 3.1 `BUT000` — BP: General Data I (S/4HANA Leading Master) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores central Business Partner master data across all BP roles (`000000` General, `FLCU00` FI Customer, `FLCU01` SD Customer, `UKM000` Credit Management BP).
- **Primary Key**: `CLIENT` (`MANDT`), `PARTNER`
- **Foreign Keys / Relationships**:
  - `BUT000.PARTNER` → `UKMBP_CMS.PARTNER` (`1:1`)
  - `BUT000.PARTNER` → `UKMBP_CMS_SGM.PARTNER` (`1:N`)
  - `BUT000.PARTNER` → `CVI_CUST_LINK.PARTNER_GUID` (via `BUT000.PARTNER_GUID` → `KNA1.KUNNR`)

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client | Implicit in simulator CSV |
| `PARTNER` | PK | `CHAR(10)` | `'0001000001'` | Business Partner Number (ALPHA-padded 10-digit string) | Present in `BUT000.csv` |
| `BPEXT` | | `CHAR(20)` | `'BP-000001'` | Business Partner Number in External System | Present in `BUT000.csv` |
| `TYPE` | | `CHAR(1)` | `'2'` | Business Partner Category (`1` Person, `2` Organization, `3` Group) | Not in CSV |
| `BPKIND` | | `CHAR(4)` | `'0001'` | Business Partner Type | Not in CSV |
| `NAME_ORG1` | | `CHAR(40)` | `'Aarav Precision Components Ltd'` | Name 1 of Organization | Present in `BUT000.csv` |
| `PARTNER_GUID` | | `RAW(16)` | UUID | Business Partner GUID for CVI linkage | Not in CSV |
| `LAND1` | | `CHAR(3)` | `'India'` / `'IN'` | Country Key (in standard SAP stored on `KNA1.LAND1` / `BUT020`/`ADRC`) | Denormalized in `BUT000.csv` |
| `BUKRS` | | `CHAR(4)` | `'BS01'` | Company Code (in standard SAP stored on `KNB1.BUKRS`; included on `BUT000.csv` as synthetic convenience) | Denormalized in `BUT000.csv` |
| `RISK_CLASS` | | `CHAR(3)` | `'A'`, `'B'`, `'C'` | Credit Risk Class (in standard SAP stored on `UKMBP_CMS.RISK_CLASS`) | Denormalized in `BUT000.csv` |
| `CREDIT_SGMNT` | | `CHAR(10)` | `'MAIN'` | Credit Segment | Denormalized in `BUT000.csv` |
| `WAERS` | | `CUKY(5)` | `'INR'` | Currency Key (in standard SAP stored on `KNVV.WAERS` / `KNB1`) | Denormalized in `BUT000.csv` |

### 3.2 `KNA1` — General Data in Customer Master (ECC & S/4HANA CVI) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores client-level customer master identity, address reference, and tax/country classification.
- **Primary Key**: `MANDT`, `KUNNR`
- **Foreign Keys / Relationships**:
  - `KNA1.KUNNR` → `KNB1.KUNNR` (`1:N` by Company Code)
  - `KNA1.KUNNR` → `KNVV.KUNNR` (`1:N` by Sales Area)
  - `KNA1.ADRNR` → `ADRC.ADDRNUMBER` (`N:1` Central Address Management)

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `KUNNR` | PK | `CHAR(10)` | `'0001000001'` | Customer Number (10-char ALPHA conversion exit `CONVERSION_EXIT_ALPHA_INPUT`) |
| `LAND1` | | `CHAR(3)` | `'IN'` | Country Key |
| `NAME1` | | `CHAR(35)` | `'Bharat Precision Eng'` | Customer Name 1 |
| `ORT01` | | `CHAR(35)` | `'Mumbai'` | City |
| `STRAS` | | `CHAR(35)` | `'MIDC Andheri'` | Street and House Number |
| `KTOKD` | | `CHAR(4)` | `'0001'` | Customer Account Group |
| `LOEVM` | | `CHAR(1)` | `' '` or `'X'` | Central Deletion Flag for Master Record |
| `AUFSD` | | `CHAR(2)` | `' '` | Central Customer Order Block |
| `LIFSD` | | `CHAR(2)` | `' '` | Central Customer Delivery Block |
| `FAKSD` | | `CHAR(2)` | `' '` | Central Customer Billing Block |

### 3.3 `KNB1` — Customer Master (Company Code Data) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores accounting-specific parameters for a customer within a company code (`BUKRS`), including reconciliation GL account and default payment terms.
- **Primary Key**: `MANDT`, `KUNNR`, `BUKRS`
- **Foreign Keys**: `KUNNR` → `KNA1.KUNNR`; `BUKRS` → `T001.BUKRS`; `AKONT` → `SKA1.SAKNR`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `KUNNR` | PK | `CHAR(10)` | `'0001000001'` | Customer Number |
| `BUKRS` | PK | `CHAR(4)` | `'1000'` | Company Code |
| `AKONT` | | `CHAR(10)` | `'0000140000'` | Reconciliation Account in General Ledger |
| `ZTERM` | | `CHAR(4)` | `'NT30'` | Terms of Payment Key |
| `ZWELS` | | `CHAR(10)` | `'CT'` | List of Respected Payment Methods |
| `SPERR` | | `CHAR(1)` | `' '` or `'X'` | Posting Block for Company Code |

### 3.4 `KNVV` — Customer Master Sales Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores SD sales-area settings (`VKORG`, `VTWEG`, `SPART`) including order currency, price group, and credit control area assignment.
- **Primary Key**: `MANDT`, `KUNNR`, `VKORG`, `VTWEG`, `SPART`
- **Foreign Keys**: `KUNNR` → `KNA1.KUNNR`; `KKBER` → `T014.KKBER`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `KUNNR` | PK | `CHAR(10)` | `'0001000001'` | Customer Number |
| `VKORG` | PK | `CHAR(4)` | `'1000'` | Sales Organization |
| `VTWEG` | PK | `CHAR(2)` | `'10'` | Distribution Channel |
| `SPART` | PK | `CHAR(2)` | `'00'` | Division |
| `WAERS` | | `CUKY(5)` | `'INR'` | Customer Currency |
| `ZTERM` | | `CHAR(4)` | `'NT30'` | Sales Area Payment Terms |
| `KKBER` | | `CHAR(4)` | `'1000'` | Credit Control Area |

### 3.5 `CVI_CUST_LINK` — Assignment Between Customer and Business Partner — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Maps S/4HANA Business Partner GUID (`BUT000.PARTNER_GUID`) to classic Customer Number (`KNA1.KUNNR`). When number ranges are synchronized, `BUT000.PARTNER === KNA1.KUNNR`.
- **Primary Key**: `MANDT`, `PARTNER_GUID`
- **Foreign Keys**: `PARTNER_GUID` → `BUT000.PARTNER_GUID`; `CUSTOMER` → `KNA1.KUNNR`

---

## 4. Classic Credit Management vs. S/4HANA FIN-FSCM Credit Management

*(Verify in SE11/SE16N for the target SAP release.)*

### 4.1 Classic SAP ECC Credit Management (`KNKK`, `KNKA`, `T014`)
In SAP ECC, credit management is governed by Credit Control Areas (`T014.KKBER`) and table `KNKK`.

#### `KNKK` — Customer Master Credit Management: Control Area Data (ECC) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Holds credit limit, risk category, receivables total (`SKFOR`), special liabilities (`SSOBL`), and credit block (`CRBLB`) per customer and credit control area in SAP ECC.
- **Primary Key**: `MANDT`, `KUNNR`, `KKBER`
- **Foreign Keys**: `KUNNR` → `KNA1.KUNNR`; `KKBER` → `T014.KKBER`; `KNKLI` → `KNA1.KUNNR` (Credit Account)

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | S/4HANA FIN-FSCM Equivalent |
|---|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client | `MANDT` |
| `KUNNR` | PK | `CHAR(10)` | `'0001000001'` | Customer Number | `UKMBP_CMS_SGM.PARTNER` |
| `KKBER` | PK | `CHAR(4)` | `'1000'` | Credit Control Area | `UKMBP_CMS_SGM.CREDIT_SGMNT` |
| `KLIMK` | | `CURR(15,2)` | `1000000.00` | Customer's Credit Limit | `UKMBP_CMS_SGM.CREDIT_LIMIT` |
| `KNKLI` | | `CHAR(10)` | `'0001000001'` | Customer's Account Number with Credit Limit Reference | BP relationship `UKM001` |
| `SKFOR` | | `CURR(15,2)` | `450000.00` | Total Receivables ( for Credit Limit Check ) | `UKM_ITEM` / `UKM_TOTALS` (`COMM_TYP` `200`) |
| `CTLPC` | | `CHAR(3)` | `'B'` | Credit Management: Risk Category | `UKMBP_CMS.RISK_CLASS` |
| `CRBLB` | | `CHAR(1)` | `' '` or `'X'` | Indicator: Blocked by Credit Management | `UKMBP_CMS_SGM.XBLOCKED` |
| `DTREV` | | `DATS(8)` | `'20261015'` | Last Credit Review / Resubmission Date | `UKMBP_CMS_SGM.FOLLOW_UP_DT` / `LIMIT_CHG_DATE` |

---

### 4.2 S/4HANA FIN-FSCM Credit Management (`UKMBP_CMS`, `UKMBP_CMS_SGM`, `UKM_ITEM`, `UKM_TOTALS`) — *Verify in SE11/SE16N for the target SAP release.*

#### `UKMBP_CMS` — SAP Credit Management: Credit Master Data for Business Partner — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores segment-independent credit profile data at the Business Partner level, including score, credit check rule, and risk class.
- **Primary Key**: `CLIENT`, `PARTNER`
- **Foreign Keys**: `PARTNER` → `BUT000.PARTNER`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `CLIENT` | PK | `CLNT(3)` | `'100'` | Client |
| `PARTNER` | PK | `CHAR(10)` | `'0001000001'` | Business Partner Number |
| `RISK_CLASS` | | `CHAR(3)` | `'B'` | Risk Class in Credit Management |
| `CHECK_RULE` | | `CHAR(10)` | `'01'` | Rule for Credit Check and Scoring |
| `CREDIT_GROUP` | | `CHAR(4)` | `'0001'` | Customer Credit Group |
| `OWN_RATING` | | `INT4(10)` | `85` | Calculated Internal Credit Score |

#### `UKMBP_CMS_SGM` — SAP Credit Management: Master Data for Credit Account (Segment Level) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores credit limit, block status, limit validity, and follow-up/review date per Business Partner and Credit Segment (`CREDIT_SGMNT`).
- **Primary Key**: `CLIENT`, `PARTNER`, `CREDIT_SGMNT`
- **Foreign Keys**: `PARTNER` → `BUT000.PARTNER`; `CREDIT_SGMNT` → `UKM_CRED_SGM0C.CREDIT_SGMNT`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `PARTNER` | PK | `CHAR(10)` | `'0001000001'` | Business Partner Number | Present in `UKMBP_CMS_SGM.csv` |
| `CREDIT_SGMNT` | PK | `CHAR(10)` | `'MAIN'` | Credit Segment | Present in `UKMBP_CMS_SGM.csv` |
| `CREDIT_LIMIT` | | `CURR(15,2)` | `'500000.00'` | Credit Limit in Credit Segment Currency | Present in `UKMBP_CMS_SGM.csv` |
| `WAERS` | | `CUKY(5)` | `'INR'` | Segment Currency (in standard SAP defined on segment customizing `UKM_CRED_SGM0C`; included on `UKMBP_CMS_SGM.csv` as `WAERS`) | Present in `UKMBP_CMS_SGM.csv` |
| `LIMIT_VALID_DATE` | | `DATS(8)` | `'20261231'` | Credit Limit Validity End Date (`YYYYMMDD`) | Present in `UKMBP_CMS_SGM.csv` |
| `XBLOCKED` | | `CHAR(1)` | `''` or `'X'` | Indicator: Blocked in Credit Management (`'X'` = blocked, empty = unblocked) | Present in `UKMBP_CMS_SGM.csv` (`'X'` only on `0001000005`) |
| `BLOCK_REASON` | | `CHAR(2)` | `'01'` | Reason for Block in Credit Management | Not in CSV |
| `RISK_CLASS` | | `CHAR(3)` | `'A'`, `'B'`, `'C'` | Credit Risk Class (in standard SAP stored on `UKMBP_CMS.RISK_CLASS`; included in `UKMBP_CMS_SGM.csv` for single-table segment profile extraction) | Present in `UKMBP_CMS_SGM.csv` |
| `FOLLOW_UP_DT` | | `DATS(8)` | `'20260926'` | Resubmission / Credit Review Date (`YYYYMMDD`) | Present in `UKMBP_CMS_SGM.csv` |

#### `UKM_ITEM` — SAP Credit Management: Line Items (Commitment / Exposure Items) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores granular credit commitment items across open orders, open deliveries, open billing documents, and open FI-AR items.
- **Primary Key**: `CLIENT`, `ITEM_GUID` (or logical business key `ITEM_KEY` / `PARTNER`, `CREDIT_SGMNT`, `COMM_TYP`, `OBJKEY`)
- **Foreign Keys**: `PARTNER`, `CREDIT_SGMNT` → `UKMBP_CMS_SGM`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `ITEM_KEY` | Logical Key | `CHAR(16)` | `'I000101'` | Synthetic Line Item Identifier | Present in `UKM_ITEM.csv` |
| `PARTNER` | Logical Key | `CHAR(10)` | `'0001000001'` | Business Partner Number | Present in `UKM_ITEM.csv` |
| `CREDIT_SGMNT` | Logical Key | `CHAR(10)` | `'MAIN'` | Credit Segment | Present in `UKM_ITEM.csv` |
| `BUKRS` | | `CHAR(4)` | `'BS01'` | Company Code | Present in `UKM_ITEM.csv` |
| `COMM_TYP` | Logical Key | `CHAR(15)` / `CHAR(4)` | `'OPEN_ORDER'` or `'OPEN_INVOICE'` | Credit Commitment Type (standard SAP uses numeric codes like `'100'` Open Order, `'200'` FI-AR Open Item, `'400'` Delivery/Billing; simulator uses descriptive symbolic codes `'OPEN_ORDER'` and `'OPEN_INVOICE'`) | Present in `UKM_ITEM.csv` |
| `OBJKEY` | Logical Key | `CHAR(70)` | `'INV-100000'` / `'SO-50000'` | Source Document Object Key (`'INV-' + BSID.BELNR` or `'SO-' + VBAK.VBELN`) | Present in `UKM_ITEM.csv` |
| `AMOUNT` | | `CURR(15,2)` | `'400000.00'` | Credit Exposure Amount in Currency | Present in `UKM_ITEM.csv` |
| `WAERS` | | `CUKY(5)` | `'INR'` | Transaction / Segment Currency | Present in `UKM_ITEM.csv` |
| `NETDT` | | `DATS(8)` | `'20261210'` | Net Due Date / Expected Settlement Date (`YYYYMMDD`) | Present in `UKM_ITEM.csv` |

---

## 5. Sales Orders (`VBAK`, `VBAP`, `VBEP`)

*(Verify in SE11/SE16N for the target SAP release.)*

### 5.1 `VBAK` — Sales Document: Header Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores sales order headers, net order value, sold-to party, sales area, and credit check status.
- **Primary Key**: `MANDT`, `VBELN`
- **Foreign Keys**: `KUNNR` → `KNA1.KUNNR` (Sold-to party); `KKBER` → `T014.KKBER`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client | Implicit |
| `VBELN` | PK | `CHAR(10)` | `'50000'` | Sales Document Number | Present in `VBAK.csv` |
| `VKORG` | | `CHAR(4)` | `'BS04'` | Sales Organization | Present in `VBAK.csv` |
| `VTWEG` | | `CHAR(2)` | `'10'` | Distribution Channel | Present in `VBAK.csv` |
| `SPART` | | `CHAR(2)` | `'00'` | Division | Present in `VBAK.csv` |
| `KUNNR` | | `CHAR(10)` | `'0001000014'` | Sold-To Party Customer Number | Present in `VBAK.csv` |
| `NETWR` | | `CURR(15,2)` | `'250000.00'` | Net Value of the Sales Order in Document Currency | Present in `VBAK.csv` |
| `WAERK` | | `CUKY(5)` | `'USD'` | SD Document Currency | Present in `VBAK.csv` |
| `ERDAT` | | `DATS(8)` | `'20261105'` | Date on Which Record Was Created (`YYYYMMDD`) | Present in `VBAK.csv` |
| `CMGST` | | `CHAR(1)` | `'A'` | Overall Status of Credit Checks (`'A'` Approved, `'B'` Credit check not OK / blocked, `'D'` Released by credit representative) | Present in `VBAK.csv` |
| `GBSTK` | | `CHAR(1)` | `'A'`, `'B'`, `'C'` | Overall Processing Status (`'A'` Not yet processed, `'B'` Partially processed, `'C'` Completely processed) | Not in CSV |

### 5.2 `VBAP` — Sales Document: Item Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores individual sales order line items, material, quantities, item net value (`NETWR`), and billing/delivery status.
- **Primary Key**: `MANDT`, `VBELN`, `POSNR`
- **Foreign Keys**: `VBELN` → `VBAK.VBELN`; `MATNR` → `MARA.MATNR`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `VBELN` | PK | `CHAR(10)` | `'0005000014'` | Sales Document |
| `POSNR` | PK | `NUMC(6)` | `'000010'` | Sales Document Item |
| `MATNR` | | `CHAR(40)` | `'FG-1000'` | Material Number |
| `KWMENG` | | `QUAN(15,3)` | `100.000` | Cumulative Order Quantity in Sales Units |
| `NETWR` | | `CURR(15,2)` | `250000.00` | Net Value of the Order Item in Document Currency |
| `WAERK` | | `CUKY(5)` | `'INR'` | SD Document Currency |
| `ABGRU` | | `CHAR(2)` | `' '` | Reason for Rejection of Quotations and Sales Orders |
| `LFSTA` | | `CHAR(1)` | `'A'`, `'B'`, `'C'` | Delivery Status of Item |

### 5.3 `VBEP` — Sales Document: Schedule Line Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores confirmed quantities (`BMENG`), delivery dates (`EDATU`), and credit-relevant confirmed schedule values.
- **Primary Key**: `MANDT`, `VBELN`, `POSNR`, `ETENR`
- **Foreign Keys**: `VBELN`, `POSNR` → `VBAP`

---

## 6. Outbound Deliveries (`LIKP`, `LIPS`)

*(Verify in SE11/SE16N for the target SAP release.)*

### 6.1 `LIKP` — SD Document: Delivery Header Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores outbound delivery header details, ship-to (`KUNNR`), sold-to (`KUNAG`), goods issue dates (`WADAT_IST`), and goods movement status (`WBSTK`).
- **Primary Key**: `MANDT`, `VBELN`
- **Foreign Keys**: `KUNAG` → `KNA1.KUNNR` (Sold-to Party); `KUNNR` → `KNA1.KUNNR` (Ship-to Party)

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `VBELN` | PK | `CHAR(10)` | `'0080000101'` | Delivery Number |
| `LFART` | | `CHAR(4)` | `'LF'` | Delivery Type |
| `KUNAG` | | `CHAR(10)` | `'0001000001'` | Sold-To Party |
| `KUNNR` | | `CHAR(10)` | `'0001000001'` | Ship-To Party |
| `WADAT` | | `DATS(8)` | `'20261105'` | Planned Goods Movement Date |
| `WADAT_IST` | | `DATS(8)` | `'20261105'` | Actual Goods Movement Date |
| `WBSTK` | | `CHAR(1)` | `'A'`, `'B'`, `'C'` | Total Goods Movement Status |
| `FKSTK` | | `CHAR(1)` | `'A'`, `'B'`, `'C'` | Billing Status of Delivery |

### 6.2 `LIPS` — SD Document: Delivery: Item Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores delivery line items, delivered quantity (`LFIMG`), and reference to originating sales order (`VGBEL`, `VGPOS`).
- **Primary Key**: `MANDT`, `VBELN`, `POSNR`
- **Foreign Keys**: `VBELN` → `LIKP.VBELN`; `VGBEL`, `VGPOS` → `VBAP.VBELN`, `VBAP.POSNR`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `VBELN` | PK | `CHAR(10)` | `'0080000101'` | Delivery |
| `POSNR` | PK | `NUMC(6)` | `'000010'` | Delivery Item |
| `LFIMG` | | `QUAN(13,3)` | `50.000` | Actual Quantity Delivered (in Sales Units) |
| `VGBEL` | | `CHAR(10)` | `'0005000014'` | Document Number of the Reference Document (Sales Order) |
| `VGPOS` | | `NUMC(6)` | `'000010'` | Item Number of the Reference Item |

---

## 7. Billing Documents (`VBRK`, `VBRP`)

*(Verify in SE11/SE16N for the target SAP release.)*

### 7.1 `VBRK` — Billing Document: Header Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores customer invoices, credit memos, and debit memos generated in SD before or during transfer to FI accounting (`RFBSK`). When `RFBSK <> 'C'`, the billing document has not yet posted to FI-AR (`BSID`/`ACDOCA`) and remains an `OPEN_BILLING` credit commitment.
- **Primary Key**: `MANDT`, `VBELN`
- **Foreign Keys**: `KUNRG` → `KNA1.KUNNR` (Payer); `KUNAG` → `KNA1.KUNNR` (Sold-to Party); `BELNR` → `BKPF.BELNR`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `MANDT` | PK | `CLNT(3)` | `'100'` | Client |
| `VBELN` | PK | `CHAR(10)` | `'0090000101'` | Billing Document Number |
| `FKART` | | `CHAR(4)` | `'F2'`, `'G2'` | Billing Type (`F2` Invoice, `G2` Credit Memo, `L2` Debit Memo) |
| `KUNRG` | | `CHAR(10)` | `'0001000001'` | Payer |
| `KUNAG` | | `CHAR(10)` | `'0001000001'` | Sold-To Party |
| `NETWR` | | `CURR(15,2)` | `150000.00` | Net Value in Document Currency |
| `MWSBK` | | `CURR(13,2)` | `27000.00` | Tax Amount in Document Currency |
| `WAERK` | | `CUKY(5)` | `'INR'` | SD Document Currency |
| `FKDAT` | | `DATS(8)` | `'20261101'` | Billing Date for Billing Index and Printout |
| `RFBSK` | | `CHAR(1)` | `'A'`, `'B'`, `'C'` | Status for Transfer to Accounting (`'C'` Posting document has been created) |

### 7.2 `VBRP` — Billing Document: Item Data — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Stores line items of billing documents and links back to the delivery (`VGBEL`/`VGPOS`) and originating sales order (`AUBEL`/`AUPOS`).
- **Primary Key**: `MANDT`, `VBELN`, `POSNR`
- **Foreign Keys**: `VBELN` → `VBRK.VBELN`; `VGBEL`, `VGPOS` → `LIPS`; `AUBEL`, `AUPOS` → `VBAP`

---

## 8. Receivables, Payments & Clearing (`BSID`, `BSAD`, `BKPF`, `BSEG`, `ACDOCA`)

*(Verify in SE11/SE16N for the target SAP release.)*

### 8.1 `BSID` — Accounting: Secondary Index for Customers (Open Items) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Contains all **open** (unsettled / uncleared) customer subledger items in FI-AR. In SAP ECC, `BSID` is a physical transparent index table synchronized with `BSEG`; in SAP S/4HANA, `BSID` is a compatibility view reading open customer subledger lines (`KOART = 'D'`, `AUGBL = ''`) from `ACDOCA`/`BSEG`.
- **Primary Key**: `MANDT`, `BUKRS`, `KUNNR`, `UMSKS`, `UMSKZ`, `AUGDT`, `AUGBL`, `ZUONR`, `GJAHR`, `BELNR`, `BUZEI` (Logical item key: `BUKRS`, `BELNR`, `GJAHR`, `BUZEI`)
- **Foreign Keys**: `KUNNR`, `BUKRS` → `KNB1`; `BUKRS`, `BELNR`, `GJAHR` → `BKPF`; `REBZG`, `REBZJ`, `REBZZ` → Referenced Invoice (`BSID`/`BSAD`)

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `KUNNR` | PK | `CHAR(10)` | `'0001000001'` | Customer Number | Present in `BSID.csv` |
| `BUKRS` | PK | `CHAR(4)` | `'BS01'` | Company Code | Present in `BSID.csv` |
| `BELNR` | PK | `CHAR(10)` | `'100000'` | Accounting Document Number | Present in `BSID.csv` |
| `GJAHR` | PK | `NUMC(4)` | `'2026'` | Fiscal Year | Present in `BSID.csv` |
| `BUZEI` | PK | `NUMC(3)` | `'001'` | Number of Line Item Within Accounting Document | Present in `BSID.csv` |
| `BLART` | | `CHAR(2)` | `'RV'`, `'DG'`, `'DZ'` | Document Type (`'RV'` Billing Doc Transfer / Invoice, `'DG'` Customer Credit Memo, `'DZ'` Customer Payment) | Present in `BSID.csv` (533 `RV`, 1 `DG`, 1 `DZ`) |
| `SHKZG` | | `CHAR(1)` | `'S'` or `'H'` | Debit/Credit Indicator (`'S'` = Soll / Debit, `'H'` = Haben / Credit) | Present in `BSID.csv` |
| `WRBTR` | | `CURR(13,2)` | `'400000.00'` | Amount in Document Currency (always unsigned positive in SAP; sign is determined by `SHKZG`) | Present in `BSID.csv` |
| `WAERS` | | `CUKY(5)` | `'INR'` | Document Currency Key | Present in `BSID.csv` |
| `DMBTR` | | `CURR(13,2)` | `'400000.00'` | Amount in Local Currency | Present in `BSID.csv` |
| `HWAER` | | `CUKY(5)` | `'INR'` | Local Currency Key | Present in `BSID.csv` |
| `ZFBDT` | | `DATS(8)` | `'20261110'` | Baseline Date for Due Date Calculation (`YYYYMMDD`) | Present in `BSID.csv` |
| `ZTERM` | | `CHAR(4)` | `'NT30'` | Terms of Payment Key | Present in `BSID.csv` |
| `ZBD1T` | | `DEC(3)` | `'30'` | Cash Discount Days 1 / Net Payment Terms Days (`due_date = ZFBDT + ZBD1T days`) | Present in `BSID.csv` |
| `REBZG` | | `CHAR(10)` | `'INV-912001'` or `''` | Document No. of the Invoice to Which the Transaction Belongs | Present in `BSID.csv` |
| `BLDAT` | | `DATS(8)` | `'20261105'` | Document Date in Document (`YYYYMMDD`) | Not in CSV (`ZFBDT` is used as `documentDate`) |
| `BUDAT` | | `DATS(8)` | `'20261105'` | Posting Date in the Document (`YYYYMMDD`) | Not in CSV |
| `AUGBL` | | `CHAR(10)` | `' '` | Document Number of the Clearing Document (empty in `BSID` because the item is still open) | Not in CSV |
| `AUGDT` | | `DATS(8)` | `'00000000'` | Clearing Date (empty in `BSID`) | Not in CSV |

### 8.2 `BSAD` — Accounting: Secondary Index for Customers (Cleared Items) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Contains all **cleared** (settled) customer subledger items in FI-AR. In `MOCK-SAP-GEN-001` (`SYNTHETIC - NOT REAL SAP DATA`), `BSAD.csv` contains 1,010 cleared payment items (`BLART = 'DZ'`), each carrying its clearing document number (`AUGBL`), clearing date (`AUGDT`), referenced invoice (`REBZG`), and baseline/terms (`ZFBDT`, `ZBD1T`).
- **Primary Key**: `MANDT`, `BUKRS`, `KUNNR`, `UMSKS`, `UMSKZ`, `AUGDT`, `AUGBL`, `ZUONR`, `GJAHR`, `BELNR`, `BUZEI`
- **Foreign Keys**: `KUNNR`, `BUKRS` → `KNB1`; `BUKRS`, `BELNR`, `GJAHR` → `BKPF`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description | Simulator Note (`SYNTHETIC - NOT REAL SAP DATA`) |
|---|---|---|---|---|---|
| `AUGBL` | PK | `CHAR(10)` | `'P001001'` | Clearing Document Number (non-empty on all `BSAD` rows) | Present in `BSAD.csv` |
| `KUNNR` | PK | `CHAR(10)` | `'0001000010'` | Customer Number | Present in `BSAD.csv` |
| `BUKRS` | PK | `CHAR(4)` | `'BS05'` | Company Code | Present in `BSAD.csv` |
| `REBZG` | | `CHAR(10)` | `'INV-800010'` | Invoice Reference Document Number | Present in `BSAD.csv` |
| `AUGDT` | | `DATS(8)` | `'20261001'` | Clearing Date (`YYYYMMDD`); comparing `AUGDT` against `ZFBDT + ZBD1T` yields days late (`max(0, AUGDT - due_date)`) | Present in `BSAD.csv` |
| `WRBTR` | | `CURR(13,2)` | `'60000.00'` | Amount in Document Currency | Present in `BSAD.csv` |
| `WAERS` | | `CUKY(5)` | `'INR'` | Currency Key | Present in `BSAD.csv` |
| `ZFBDT` | | `DATS(8)` | `'20260911'` | Baseline Date for Due Date Calculation (`YYYYMMDD`) | Present in `BSAD.csv` |
| `ZBD1T` | | `DEC(3)` | `'30'` | Net Payment Terms Days (`due_date = ZFBDT + ZBD1T days`) | Present in `BSAD.csv` |
| `BLART` | | `CHAR(2)` | `'DZ'` | Document Type (`'DZ'` Cleared Customer Payment) | Present in `BSAD.csv` (all 1,010 rows are `DZ`) |
| `BELNR` | PK | `CHAR(10)` | `'200001'` | Accounting Document Number | Not in CSV (`AUGBL` is used as `sourceRecordId`) |
| `GJAHR` | PK | `NUMC(4)` | `'2026'` | Fiscal Year | Not in CSV |
| `BUZEI` | PK | `NUMC(3)` | `'001'` | Line Item Within Accounting Document | Not in CSV |
| `SHKZG` | | `CHAR(1)` | `'S'` or `'H'` | Debit/Credit Indicator | Not in CSV |

### 8.3 `BKPF` & `BSEG` — Accounting Document Header & Segment (ECC & S/4HANA) — *Verify in SE11/SE16N for the target SAP release.*
- **`BKPF` Purpose**: Stores accounting document headers (`MANDT`, `BUKRS`, `BELNR`, `GJAHR`) with document type (`BLART`), posting date (`BUDAT`), document date (`BLDAT`), currency (`WAERS`), and reference (`XBLNR`).
- **`BSEG` Purpose**: Stores operational accounting document line items (`MANDT`, `BUKRS`, `BELNR`, `GJAHR`, `BUZEI`) including account type (`KOART = 'D'` for customers), customer (`KUNNR`), debit/credit indicator (`SHKZG`), amount (`WRBTR`/`DMBTR`), baseline date (`ZFBDT`), payment terms (`ZTERM`/`ZBD1T`), invoice reference (`REBZG`), and clearing document (`AUGBL`/`AUGDT`).

### 8.4 `ACDOCA` — Universal Journal Entry Line Items (S/4HANA Only) — *Verify in SE11/SE16N for the target SAP release.*
- **Purpose**: Single line-item table combining General Ledger (FI-GL), Subledger Accounting (FI-AR/FI-AP), Asset Accounting (FI-AA), Controlling (CO), and Profitability Analysis (CO-PA).
- **Primary Key**: `RCLNT` (Client), `RLDNR` (Ledger, e.g., `'0L'`), `RBUKRS` (Company Code), `GJAHR` (Fiscal Year), `BELNR` (Document Number), `DOCLN` (6-char Universal Journal Line Item)
- **Foreign Keys**: `RBUKRS`, `BELNR`, `GJAHR` → `BKPF`; `KUNNR` → `KNA1.KUNNR`

| Field Name | Key | ABAP Type (Length) | Format / Example | Description |
|---|---|---|---|---|
| `RCLNT` | PK | `CLNT(3)` | `'100'` | Client |
| `RLDNR` | PK | `CHAR(2)` | `'0L'` | Ledger in General Ledger Accounting (`'0L'` Leading Ledger) |
| `RBUKRS` | PK | `CHAR(4)` | `'1000'` | Company Code |
| `GJAHR` | PK | `NUMC(4)` | `'2026'` | Fiscal Year |
| `BELNR` | PK | `CHAR(10)` | `'0000100001'` | Accounting Document Number |
| `DOCLN` | PK | `CHAR(6)` | `'000001'` | Six-Character Posting Item for Ledger |
| `KOART` | | `CHAR(1)` | `'D'` | Account Type (`'D'` Customer) |
| `KUNNR` | | `CHAR(10)` | `'0001000001'` | Customer Number |
| `BLART` | | `CHAR(2)` | `'RV'`, `'DG'`, `'DZ'` | Document Type |
| `BUDAT` | | `DATS(8)` | `'20261105'` | Posting Date |
| `BLDAT` | | `DATS(8)` | `'20261105'` | Document Date |
| `NETDT` | | `DATS(8)` | `'20261205'` | Net Due Date |
| `RWCUR` | | `CUKY(5)` | `'INR'` | Transaction Currency |
| `WSL` | | `CURR(23,2)` | `800000.00` | Amount in Transaction Currency (signed in `ACDOCA`: positive = debit, negative = credit) |
| `RHCUR` | | `CUKY(5)` | `'INR'` | Company Code Currency |
| `HSL` | | `CURR(23,2)` | `800000.00` | Amount in Company Code Currency |
| `AUGBL` | | `CHAR(10)` | `'0000900001'` | Clearing Document Number |
| `AUGDT` | | `DATS(8)` | `'20260820'` | Clearing Date |
| `REBZG` | | `CHAR(10)` | `'0000100010'` | Invoice Reference Document Number |
