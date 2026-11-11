#!/usr/bin/env node
/**
 * scripts/generate-sap-sim-data.js
 *
 * Seeded synthetic SAP S/4HANA FIN-FSCM data generator.
 *
 * LABEL: SYNTHETIC - NOT REAL SAP DATA
 * Table and field names are written from memory and standard FSCM/FI/SD schema references.
 * Verify in SE11/SE16N for the target SAP release.
 *
 * Emits CSV tables and notice under db/sap-sim/data:
 *  - BUT000.csv         (Business Partner master)
 *  - UKMBP_CMS_SGM.csv  (FSCM Credit Management account & segment)
 *  - UKM_ITEM.csv       (FSCM Credit exposure items)
 *  - BSID.csv           (FI Customer open items: RV invoices, DG credit memos, DZ payments)
 *  - BSAD.csv           (FI Customer cleared items)
 *  - VBAK.csv           (SD Sales document header for open orders)
 *  - SYNTHETIC_NOTICE.txt
 *
 * Emits expected-results.json ONLY to tests/fixtures/sap-sim/expected-results.json (or --expected-out)
 * with independently computed exposure, overdue, and utilization per scenario according to srv/rules.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { classifyCustomer } = require('../srv/rules');

function subtractCalendarMonths(date, months) {
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth(),
    Math.min(date.getUTCDate(), lastDay)
  ));
}

// Mulberry32 seeded 32-bit PRNG
function createPrng(seed) {
  let s = Math.trunc(Number(seed) || 42) >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCliArgs(argv) {
  const options = {
    seed: 42,
    customers: 300,
    out: path.join('db', 'sap-sim', 'data'),
    expectedOut: path.join('tests', 'fixtures', 'sap-sim', 'expected-results.json'),
    today: new Date().toISOString().slice(0, 10)
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed' && argv[i + 1] !== undefined) {
      options.seed = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      options.seed = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--customers' && argv[i + 1] !== undefined) {
      options.customers = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--customers=')) {
      options.customers = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--out' && argv[i + 1] !== undefined) {
      options.out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      options.out = arg.split('=')[1];
    } else if (arg === '--expected-out' && argv[i + 1] !== undefined) {
      options.expectedOut = argv[++i];
    } else if (arg.startsWith('--expected-out=')) {
      options.expectedOut = arg.split('=')[1];
    } else if (arg === '--today' && argv[i + 1] !== undefined) {
      options.today = argv[++i];
    } else if (arg.startsWith('--today=')) {
      options.today = arg.split('=')[1];
    }
  }

  return options;
}

function formatSapDate(d) {
  if (typeof d === 'string' && /^\d{8}$/.test(d)) return d;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d.replace(/-/g, '');
  const date = d instanceof Date ? d : new Date(d);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function parseSapDateToIso(sapDateStr) {
  if (!sapDateStr || sapDateStr.length !== 8) return null;
  return `${sapDateStr.slice(0, 4)}-${sapDateStr.slice(4, 6)}-${sapDateStr.slice(6, 8)}`;
}

function addDaysToIso(isoDateStr, days) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

const COMPANY_CODES = ['BS01', 'BS02', 'BS03', 'BS04', 'BS05'];
const COUNTRIES = ['India', 'UAE', 'Singapore', 'Germany', 'USA'];
const COMPANY_PREFIXES = [
  'Aarav', 'Desert Star', 'Merlion', 'Indus', 'Gulf Horizon', 'Monsoon',
  'Lotus', 'Pearl Coast', 'Orchid', 'Saffron', 'Lion City', 'Bluewater',
  'Northstar', 'Apex', 'Zenith', 'Summit', 'Vanguard', 'Pinnacle',
  'Horizon', 'Aurora', 'Atlas', 'Nova', 'Pacific', 'Atlantic', 'Solaria'
];
const COMPANY_SUFFIXES = [
  'Enterprises', 'Trading LLC', 'Systems Ltd', 'Retail Group', 'Logistics',
  'Industrial Corp', 'Foods', 'Digital', 'Textiles', 'Supplies',
  'Services', 'Components', 'Holdings', 'Solutions', 'International'
];

function generateDataset(options) {
  const prng = createPrng(options.seed);
  const customerCount = Math.max(options.customers || 300, 14);
  const todayIso = options.today;
  const todaySap = formatSapDate(todayIso);
  const todayDate = new Date(`${todayIso}T00:00:00.000Z`);

  // Target tables
  const BUT000 = [];
  const UKMBP_CMS_SGM = [];
  const UKM_ITEM = [];
  const BSID = [];
  const BSAD = [];
  const VBAK = [];

  const scenarioCustomers = {};
  const allCustomerEvaluations = {};

  let invoiceSeq = 100000;
  let orderSeq = 50000;

  // 14 Guaranteed Scenarios
  // All review dates are past dates within the last 12 months, except Scenario 8 which is 14 months old (stale)
  const scenarioDefs = [
    {
      partner: '0001000001',
      scenarioName: 'EXACTLY_80_PERCENT_UTILIZATION',
      description: 'Exactly 80% utilization: limit 500,000 INR, exposure 400,000 INR, status WARNING, flag WARNING',
      name: 'Aarav Precision Components Ltd',
      country: 'India',
      bukrs: 'BS01',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '500000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -45)),
      openItems: [
        { type: 'INVOICE', amount: '400000.00', currency: 'INR', dueOffset: 30 }
      ]
    },
    {
      partner: '0001000002',
      scenarioName: 'EXACTLY_100_PERCENT_UTILIZATION',
      description: 'Exactly 100% utilization: limit 500,000 INR, exposure 500,000 INR, status BREACH, flag BREACH only',
      name: 'Desert Star Global Trading',
      country: 'UAE',
      bukrs: 'BS02',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '500000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -60)),
      openItems: [
        { type: 'INVOICE', amount: '500000.00', currency: 'INR', dueOffset: 15 }
      ]
    },
    {
      partner: '0001000003',
      scenarioName: 'EXACTLY_120_PERCENT_UTILIZATION',
      description: 'Exactly 120% utilization: limit 500,000 INR, exposure 600,000 INR, status BREACH, flags BREACH and CRITICAL',
      name: 'Merlion Advanced Systems Pte',
      country: 'Singapore',
      bukrs: 'BS03',
      riskClass: 'C',
      currency: 'INR',
      creditLimit: '500000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -90)),
      openItems: [
        { type: 'INVOICE', amount: '600000.00', currency: 'INR', dueOffset: 20 }
      ]
    },
    {
      partner: '0001000004',
      scenarioName: 'ZERO_CREDIT_LIMIT',
      description: 'Zero credit limit: limit 0 INR, exposure 150,000 INR, status MANUAL_REVIEW, flag NO_LIMIT, utilization null',
      name: 'Indus Retail Ventures',
      country: 'India',
      bukrs: 'BS04',
      riskClass: 'C',
      currency: 'INR',
      creditLimit: '0.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -30)),
      openItems: [
        { type: 'INVOICE', amount: '150000.00', currency: 'INR', dueOffset: 10 }
      ]
    },
    {
      partner: '0001000005',
      scenarioName: 'BLOCKED_ACCOUNT',
      description: 'Blocked account in SAP FSCM: XBLOCKED = X in UKMBP_CMS_SGM',
      name: 'Gulf Horizon Logistics LLC',
      country: 'UAE',
      bukrs: 'BS05',
      riskClass: 'C',
      currency: 'INR',
      creditLimit: '600000.00',
      xblocked: 'X',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -15)),
      openItems: [
        { type: 'INVOICE', amount: '200000.00', currency: 'INR', dueOffset: 25 }
      ]
    },
    {
      partner: '0001000006',
      scenarioName: 'OVERDUE_SHARE_ABOVE_30_PERCENT',
      description: 'Overdue share strictly above 30%: exposure 500,000 INR, overdue 400,000 INR (80%), flag OVERDUE_RISK',
      name: 'Monsoon Heavy Logistics',
      country: 'India',
      bukrs: 'BS01',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '1000000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -75)),
      openItems: [
        { type: 'INVOICE', amount: '400000.00', currency: 'INR', dueOffset: -20 },
        { type: 'INVOICE', amount: '100000.00', currency: 'INR', dueOffset: 30 }
      ]
    },
    {
      partner: '0001000007',
      scenarioName: 'OVERDUE_SHARE_AT_OR_BELOW_30_PERCENT',
      description: 'Overdue share <= 30%: exposure 500,000 INR, overdue 100,000 INR (20%), no OVERDUE_RISK flag',
      name: 'Lotus Industrial Corporation',
      country: 'India',
      bukrs: 'BS02',
      riskClass: 'A',
      currency: 'INR',
      creditLimit: '1000000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -120)),
      openItems: [
        { type: 'INVOICE', amount: '100000.00', currency: 'INR', dueOffset: -10 },
        { type: 'INVOICE', amount: '400000.00', currency: 'INR', dueOffset: 45 }
      ]
    },
    {
      partner: '0001000008',
      scenarioName: 'STALE_REVIEW_DATE',
      description: 'Stale review date: FOLLOW_UP_DT earlier than 12 calendar months before --today, flag STALE_REVIEW',
      name: 'Pearl Coast Marine Supplies',
      country: 'UAE',
      bukrs: 'BS03',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '800000.00',
      xblocked: '',
      // Subtract 14 calendar months so it is strictly earlier than 12 months before today
      followUpDt: formatSapDate(subtractCalendarMonths(todayDate, 14)),
      openItems: [
        { type: 'INVOICE', amount: '300000.00', currency: 'INR', dueOffset: 30 }
      ]
    },
    {
      partner: '0001000009',
      scenarioName: 'MIXED_CURRENCY_ITEMS_REJECTED',
      description: 'Deliberately mixed-currency items: rejected by rules.js calculateExposure (REJECTED_MIXED_CURRENCY)',
      name: 'Orchid Digital Technologies',
      country: 'Singapore',
      bukrs: 'BS04',
      riskClass: 'A',
      currency: 'INR',
      creditLimit: '750000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -100)),
      openItems: [
        { type: 'INVOICE', amount: '200000.00', currency: 'INR', dueOffset: 30 },
        { type: 'INVOICE', amount: '50000.00', currency: 'USD', dueOffset: 40 }
      ]
    },
    {
      partner: '0001000010',
      scenarioName: 'PARTIAL_PAYMENTS_ON_TIME_CLEARING',
      description: 'Partial payments with on-time clearing in BSAD (AUGDT <= ZFBDT + ZBD1T)',
      name: 'Saffron Modern Textiles',
      country: 'India',
      bukrs: 'BS05',
      riskClass: 'A',
      currency: 'INR',
      creditLimit: '900000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -110)),
      openItems: [
        { type: 'INVOICE', amount: '250000.00', currency: 'INR', dueOffset: 30 }
      ],
      clearedItems: [
        {
          rebzg: 'INV-800010',
          amount: '60000.00',
          zfbdt: formatSapDate(addDaysToIso(todayIso, -60)),
          zbd1t: '30',
          augdt: formatSapDate(addDaysToIso(todayIso, -40)) // cleared 10 days before due
        },
        {
          rebzg: 'INV-800010',
          amount: '40000.00',
          zfbdt: formatSapDate(addDaysToIso(todayIso, -60)),
          zbd1t: '30',
          augdt: formatSapDate(addDaysToIso(todayIso, -31)) // cleared on due date
        }
      ]
    },
    {
      partner: '0001000011',
      scenarioName: 'PARTIAL_PAYMENTS_LATE_CLEARING',
      description: 'Partial payments with late clearing in BSAD (AUGDT > ZFBDT + ZBD1T)',
      name: 'Lion City Engineering Supplies',
      country: 'Singapore',
      bukrs: 'BS01',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '400000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -80)),
      openItems: [
        { type: 'INVOICE', amount: '120000.00', currency: 'INR', dueOffset: 20 }
      ],
      clearedItems: [
        {
          rebzg: 'INV-800011',
          amount: '50000.00',
          zfbdt: formatSapDate(addDaysToIso(todayIso, -75)),
          zbd1t: '30',
          augdt: formatSapDate(addDaysToIso(todayIso, -30)) // 15 days late
        },
        {
          rebzg: 'INV-800011',
          amount: '50000.00',
          zfbdt: formatSapDate(addDaysToIso(todayIso, -75)),
          zbd1t: '30',
          augdt: formatSapDate(addDaysToIso(todayIso, -15)) // 30 days late
        }
      ]
    },
    {
      partner: '0001000012',
      scenarioName: 'CREDIT_MEMO_AND_PAYMENT_ON_ACCOUNT_UNMODELED',
      description: 'Credit memo (DG) and payment on account (DZ) in BSID unmodeled in canonical invoice projection',
      name: 'Bluewater Marine Services LLC',
      country: 'UAE',
      bukrs: 'BS02',
      riskClass: 'A',
      currency: 'INR',
      creditLimit: '1200000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -40)),
      openItems: [
        { type: 'INVOICE', amount: '350000.00', currency: 'INR', dueOffset: 45 }
      ],
      extraBsidItems: [
        { blart: 'DG', shkzg: 'H', wrbtr: '35000.00', rebzg: 'INV-912001' },
        { blart: 'DZ', shkzg: 'H', wrbtr: '40000.00', rebzg: '' }
      ]
    },
    {
      partner: '0001000013',
      scenarioName: 'IDENTICAL_DUPLICATE_ROWS',
      description: 'Identical duplicate open items in UKM_ITEM: rules engine deduplicates without error',
      name: 'Northstar Heavy Industries',
      country: 'India',
      bukrs: 'BS03',
      riskClass: 'B',
      currency: 'INR',
      creditLimit: '1000000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -50)),
      openItems: [
        { type: 'INVOICE', amount: '250000.00', currency: 'INR', dueOffset: 30, duplicate: true }
      ]
    },
    {
      partner: '0001000014',
      scenarioName: 'OPEN_SALES_ORDERS_COMM_TYP',
      description: 'Open sales orders (COMM_TYP: OPEN_ORDER) contributing to exposure category 200',
      name: 'Apex Global Networks Corp',
      country: 'USA',
      bukrs: 'BS04',
      riskClass: 'A',
      currency: 'USD',
      creditLimit: '600000.00',
      xblocked: '',
      followUpDt: formatSapDate(addDaysToIso(todayIso, -35)),
      openItems: [
        { type: 'INVOICE', amount: '150000.00', currency: 'USD', dueOffset: 25 },
        { type: 'SALESORDER', amount: '250000.00', currency: 'USD', dueOffset: 40 }
      ]
    }
  ];

  function processCustomer(customerDef) {
    const {
      partner,
      scenarioName,
      description,
      name,
      country,
      bukrs,
      riskClass,
      currency,
      creditLimit,
      xblocked,
      followUpDt,
      openItems = [],
      clearedItems = [],
      extraBsidItems = []
    } = customerDef;

    // 1. BUT000
    // Exact fields matching MOCK_SAP_FIN_FSCM_ENTITIES:
    // PARTNER, BPEXT, NAME_ORG1, LAND1, BUKRS, RISK_CLASS, CREDIT_SGMNT, WAERS
    const bpext = `BP-${partner.slice(-6)}`;
    BUT000.push({
      PARTNER: partner,
      BPEXT: bpext,
      NAME_ORG1: name,
      LAND1: country,
      BUKRS: bukrs,
      RISK_CLASS: riskClass,
      CREDIT_SGMNT: 'MAIN',
      WAERS: currency
    });

    // 2. UKMBP_CMS_SGM
    // Exact fields matching MOCK_SAP_FIN_FSCM_ENTITIES:
    // PARTNER, CREDIT_SGMNT, CREDIT_LIMIT, WAERS, LIMIT_VALID_DATE, XBLOCKED, RISK_CLASS, FOLLOW_UP_DT
    UKMBP_CMS_SGM.push({
      PARTNER: partner,
      CREDIT_SGMNT: 'MAIN',
      CREDIT_LIMIT: creditLimit,
      WAERS: currency,
      LIMIT_VALID_DATE: '20261231',
      XBLOCKED: xblocked || '',
      RISK_CLASS: riskClass,
      FOLLOW_UP_DT: followUpDt
    });

    // Process open items for UKM_ITEM, BSID, VBAK
    const ruleItems = [];

    for (let idx = 0; idx < openItems.length; idx += 1) {
      const oi = openItems[idx];
      const itemKey = `I${partner.slice(-4)}${String(idx + 1).padStart(2, '0')}`;
      const isSo = oi.type === 'SALESORDER';
      // Verifiable mirror relation: UKM_ITEM.OBJKEY = 'INV-' + BSID.BELNR
      // For sales orders: UKM_ITEM.OBJKEY = 'SO-' + VBAK.VBELN
      const docRawSeq = isSo ? String(orderSeq++) : String(invoiceSeq++);
      const docNum = isSo ? `SO-${docRawSeq}` : `INV-${docRawSeq}`;
      const dueIso = addDaysToIso(todayIso, oi.dueOffset);
      const netdt = formatSapDate(dueIso);
      const commTyp = isSo ? 'OPEN_ORDER' : 'OPEN_INVOICE';

      // UKM_ITEM exact fields:
      // ITEM_KEY, PARTNER, CREDIT_SGMNT, BUKRS, COMM_TYP, OBJKEY, AMOUNT, WAERS, NETDT
      const ukmRow = {
        ITEM_KEY: itemKey,
        PARTNER: partner,
        CREDIT_SGMNT: 'MAIN',
        BUKRS: bukrs,
        COMM_TYP: commTyp,
        OBJKEY: docNum,
        AMOUNT: oi.amount,
        WAERS: oi.currency,
        NETDT: netdt
      };
      UKM_ITEM.push(ukmRow);

      if (oi.duplicate) {
        // Push exact duplicate row to UKM_ITEM
        UKM_ITEM.push({ ...ukmRow });
      }

      // BSID (open invoices)
      // Exactly matches UKM_ITEM: BELNR = docRawSeq => OBJKEY = 'INV-' + BELNR
      if (!isSo) {
        BSID.push({
          KUNNR: partner,
          BUKRS: bukrs,
          BELNR: docRawSeq,
          GJAHR: '2026',
          BUZEI: '001',
          BLART: 'RV',
          SHKZG: 'S',
          WRBTR: oi.amount,
          WAERS: oi.currency,
          DMBTR: oi.amount,
          HWAER: oi.currency,
          ZFBDT: formatSapDate(addDaysToIso(dueIso, -30)),
          ZTERM: 'NT30',
          ZBD1T: '30',
          REBZG: ''
        });
      } else {
        // VBAK (sales document header)
        // Exactly matches UKM_ITEM: VBELN = docRawSeq => OBJKEY = 'SO-' + VBELN
        VBAK.push({
          VBELN: docRawSeq,
          VKORG: bukrs,
          VTWEG: '10',
          SPART: '00',
          KUNNR: partner,
          NETWR: oi.amount,
          WAERK: oi.currency,
          ERDAT: formatSapDate(addDaysToIso(todayIso, -5)),
          CMGST: 'A'
        });
      }

      ruleItems.push({
        ID: itemKey,
        customer_ID: partner,
        type: oi.type,
        amount: Number(oi.amount),
        currency: oi.currency,
        dueDate: dueIso,
        status: 'OPEN'
      });
    }

    // Extra BSID items (credit memos, payments on account)
    for (const extra of extraBsidItems) {
      BSID.push({
        KUNNR: partner,
        BUKRS: bukrs,
        BELNR: String(invoiceSeq++),
        GJAHR: '2026',
        BUZEI: '001',
        BLART: extra.blart,
        SHKZG: extra.shkzg,
        WRBTR: extra.wrbtr,
        WAERS: currency,
        DMBTR: extra.wrbtr,
        HWAER: currency,
        ZFBDT: todaySap,
        ZTERM: 'NT30',
        ZBD1T: '30',
        REBZG: extra.rebzg || ''
      });
    }

    // Cleared items (BSAD)
    for (let cIdx = 0; cIdx < clearedItems.length; cIdx += 1) {
      const ci = clearedItems[cIdx];
      const augbl = `P${partner.slice(-4)}${String(cIdx + 1).padStart(2, '0')}`;
      BSAD.push({
        AUGBL: augbl,
        KUNNR: partner,
        BUKRS: bukrs,
        REBZG: ci.rebzg || `INV-${invoiceSeq++}`,
        AUGDT: ci.augdt,
        WRBTR: ci.amount,
        WAERS: currency,
        ZFBDT: ci.zfbdt || formatSapDate(addDaysToIso(ci.augdt, -30)),
        ZBD1T: ci.zbd1t || '30',
        BLART: 'DZ'
      });
    }

    // Evaluate expected results via rules.js classifyCustomer
    const customerRuleObj = {
      ID: partner,
      creditLimit: Number(creditLimit),
      currency,
      lastReviewDate: parseSapDateToIso(followUpDt)
    };

    let evaluation = null;
    if (scenarioName === 'MIXED_CURRENCY_ITEMS_REJECTED') {
      evaluation = {
        partner,
        name,
        currency,
        creditLimit: Number(creditLimit),
        expectedOutcome: 'REJECTED_MIXED_CURRENCY',
        exposure: null,
        overdueAmount: null,
        overdueShare: null,
        overdueInvoiceCount: null,
        utilisation: null,
        utilisationPercent: null,
        status: null,
        flags: [],
        note: 'Rejected by rules.js calculateExposure: Credit exposure cannot combine different currencies.'
      };
    } else {
      const classified = classifyCustomer(customerRuleObj, ruleItems, todayDate);
      evaluation = {
        partner,
        name,
        currency: classified.currency,
        creditLimit: classified.creditLimit,
        exposure: classified.exposure,
        overdueAmount: classified.overdueAmount,
        overdueShare: classified.overdueShare,
        overdueInvoiceCount: classified.overdueInvoiceCount,
        utilisation: classified.utilisation,
        utilisationPercent: classified.utilisationPercent,
        status: classified.status,
        flags: classified.flags
      };
    }

    if (scenarioName) {
      scenarioCustomers[scenarioName] = {
        partner,
        description,
        ...evaluation
      };
    }
    allCustomerEvaluations[partner] = evaluation;
  }

  // 1. Process 14 Guaranteed Scenarios
  for (const scenario of scenarioDefs) {
    processCustomer(scenario);
  }

  // 2. Procedural Customers (15 to customerCount)
  // All review dates are past dates within the last 12 months, except ~8% stale past dates (>12 months ago)
  // No customer has a review date later than today!
  for (let i = 15; i <= customerCount; i += 1) {
    const partner = String(1000000 + i).padStart(10, '0');
    const pVal = prng();
    const currency = pVal < 0.10 ? 'USD' : pVal < 0.20 ? 'EUR' : 'INR';
    const country = currency === 'USD' ? 'USA' : currency === 'EUR' ? 'Germany' : COUNTRIES[Math.floor(prng() * 3)];
    const bukrs = COMPANY_CODES[Math.floor(prng() * COMPANY_CODES.length)];
    const riskClass = prng() < 0.4 ? 'A' : prng() < 0.75 ? 'B' : 'C';

    const pfx = COMPANY_PREFIXES[Math.floor(prng() * COMPANY_PREFIXES.length)];
    const sfx = COMPANY_SUFFIXES[Math.floor(prng() * COMPANY_SUFFIXES.length)];
    const name = `${pfx} ${sfx} ${i}`;

    const limitBase = currency === 'INR' ? 500000 : 100000;
    const limitMultiplier = Math.floor(prng() * 10) + 2; // 2x to 11x
    const limitNum = limitBase * limitMultiplier;
    const creditLimit = `${limitNum}.00`;

    // Follow-up date: strictly past dates.
    // ~8% stale (>12 months ago: 13-18 months in the past), 92% non-stale (10 to 300 days in the past)
    const isStale = prng() < 0.08;
    const followUpDt = isStale
      ? formatSapDate(subtractCalendarMonths(todayDate, 13 + Math.floor(prng() * 6)))
      : formatSapDate(addDaysToIso(todayIso, - (10 + Math.floor(prng() * 300))));

    // Open items (1 to 4 items)
    const itemCount = Math.floor(prng() * 4) + 1;
    const openItems = [];
    for (let k = 0; k < itemCount; k += 1) {
      const isSo = prng() < 0.25;
      const type = isSo ? 'SALESORDER' : 'INVOICE';
      const amountChunk = Math.round((limitNum * (0.05 + prng() * 0.35)) / 1000) * 1000;
      const isOverdue = !isSo && prng() < 0.25;
      const dueOffset = isOverdue
        ? -1 * (Math.floor(prng() * 45) + 1)
        : Math.floor(prng() * 60) + 5;

      openItems.push({
        type,
        amount: `${amountChunk}.00`,
        currency,
        dueOffset
      });
    }

    // Cleared items (BSAD): 3 to 4 cleared items per customer
    const clearedCount = Math.floor(prng() * 2) + 3;
    const clearedItems = [];
    for (let c = 0; c < clearedCount; c += 1) {
      const clearAmount = Math.round((limitNum * (0.05 + prng() * 0.2)) / 1000) * 1000;
      const daysAgo = 30 + Math.floor(prng() * 120);
      const zfbdtIso = addDaysToIso(todayIso, -daysAgo);
      const isLate = prng() < 0.25;
      const clearingDaysOffset = isLate
        ? 30 + Math.floor(prng() * 20) + 1 // > 30 days after baseline
        : Math.floor(prng() * 28) + 1;     // <= 30 days after baseline
      const augdtIso = addDaysToIso(zfbdtIso, clearingDaysOffset);

      clearedItems.push({
        rebzg: `INV-${invoiceSeq++}`,
        amount: `${clearAmount}.00`,
        zfbdt: formatSapDate(zfbdtIso),
        zbd1t: '30',
        augdt: formatSapDate(augdtIso)
      });
    }

    processCustomer({
      partner,
      name,
      country,
      bukrs,
      riskClass,
      currency,
      creditLimit,
      xblocked: '',
      followUpDt,
      openItems,
      clearedItems
    });
  }

  const expectedResults = {
    label: 'SYNTHETIC - NOT REAL SAP DATA',
    metadata: {
      generatedAt: `${todayIso}T00:00:00.000Z`,
      seed: options.seed,
      customerCount,
      asOfDate: todayIso,
      rulesVersion: 'srv/rules.js',
      disclaimer: 'SYNTHETIC - NOT REAL SAP DATA. Table and field names written from memory. Verify in SE11/SE16N for target SAP release.'
    },
    scenarioCustomers,
    allCustomers: allCustomerEvaluations
  };

  return {
    tables: {
      BUT000,
      UKMBP_CMS_SGM,
      UKM_ITEM,
      BSID,
      BSAD,
      VBAK
    },
    expectedResults
  };
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const str = String(v);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n') + '\n';
}

const SYNTHETIC_NOTICE_TEXT = `SYNTHETIC - NOT REAL SAP DATA
=============================
This dataset contains synthetic demonstration records for SAP S/4HANA FIN-FSCM integration testing.
All records, business partner identifiers, credit limits, exposure items, and accounting documents
are procedurally generated and do not represent any real company or actual SAP production instance.

Table and field names are written from memory and standard FSCM/FI/SD schema references:
Verify in SE11/SE16N for the target SAP release.

DUPLICATE EXPOSURE SOURCES RULE:
--------------------------------
In SAP S/4HANA, open customer invoices exist in FI receivables (BSID) and are mirrored into FSCM
Credit Management (UKM_ITEM) with COMM_TYP = 'OPEN_INVOICE'.
The mirror relationship in this dataset is exact and verifiable:
  UKM_ITEM.OBJKEY = 'INV-' + BSID.BELNR
Open sales orders originate in SD (VBAK) and are mirrored into FSCM as:
  UKM_ITEM.OBJKEY = 'SO-' + VBAK.VBELN (COMM_TYP = 'OPEN_ORDER')

Exposure Calculation Rule:
Exposure must NEVER sum both UKM_ITEM (OPEN_INVOICE) and BSID.
Ingestion must either:
  (A) Ingest unified FSCM exposure items from UKM_ITEM alone (both OPEN_INVOICE and OPEN_ORDER), OR
  (B) Ingest FI open items from BSID (invoices) plus SD open orders from VBAK, with deduplication on OBJKEY.
The baseline in expected-results.json calculates exposure across distinct open invoices and orders without double-counting.

MAPPING ASSUMPTION:
-------------------
In SAP S/4HANA FSCM, FOLLOW_UP_DT in UKMBP_CMS_SGM represents the next scheduled review date or follow-up date.
In this integration, mapping FOLLOW_UP_DT to the canonical customer.lastReviewDate is an unconfirmed business assumption.
Verify field semantics against your organization's FSCM configuration in SE11/SE16N.
`;

function writeDataset(options, dataset) {
  const { out: outDir, expectedOut: expectedJsonPath } = options;

  // Ensure output directories exist
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(expectedJsonPath), { recursive: true });

  const filesWritten = [];

  // Write CSV tables strictly under outDir (e.g. db/sap-sim/data)
  for (const [tableName, rows] of Object.entries(dataset.tables)) {
    const csvContent = toCsv(rows);
    const targetFile = path.join(outDir, `${tableName}.csv`);
    fs.writeFileSync(targetFile, csvContent, 'utf8');
    filesWritten.push({ file: targetFile, records: rows.length });
  }

  // Write SYNTHETIC_NOTICE.txt strictly under outDir
  const noticePath = path.join(outDir, 'SYNTHETIC_NOTICE.txt');
  fs.writeFileSync(noticePath, SYNTHETIC_NOTICE_TEXT, 'utf8');
  filesWritten.push({ file: noticePath, records: 'NOTICE' });

  // Write expected-results.json ONLY to expectedJsonPath (e.g. tests/fixtures/sap-sim/expected-results.json)
  fs.writeFileSync(expectedJsonPath, JSON.stringify(dataset.expectedResults, null, 2) + '\n', 'utf8');
  filesWritten.push({
    file: expectedJsonPath,
    scenarioCount: Object.keys(dataset.expectedResults.scenarioCustomers).length,
    totalCustomerCount: Object.keys(dataset.expectedResults.allCustomers).length
  });

  return filesWritten;
}

function main() {
  const options = parseCliArgs(process.argv);
  const dataset = generateDataset(options);
  const written = writeDataset(options, dataset);

  console.log(`[generate-sap-sim-data] Successfully generated dataset with seed=${options.seed}, customers=${options.customers}, today=${options.today}:`);
  for (const item of written) {
    if (item.records !== undefined) {
      console.log(`  - ${item.file} (${item.records} rows)`);
    } else {
      console.log(`  - ${item.file} (${item.scenarioCount} scenarios, ${item.totalCustomerCount || ''} customers)`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createPrng,
  generateDataset,
  parseCliArgs,
  writeDataset
};
