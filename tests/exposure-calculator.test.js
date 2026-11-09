const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const {
  calculatePartnerExposureSnapshot,
  calculatePaymentBehaviour,
  calculatePortfolioRollups,
  classifyThresholdStatus
} = require('../srv/exposureCalculator');
const {
  getBusinessPartnerCreditDossier,
  getCanonicalPortfolioAnalytics,
  recalculateAllExposureSnapshots
} = require('../srv/canonicalRepository');

test('classifyThresholdStatus enforces exact deterministic FIN-FSCM-CR utilization boundaries', () => {
  assert.equal(classifyThresholdStatus({ utilizationPct: 0, creditLimit: 100000, totalExposure: 0 }), 'NORMAL');
  assert.equal(classifyThresholdStatus({ utilizationPct: 79.99, creditLimit: 100000, totalExposure: 79990 }), 'NORMAL');
  assert.equal(classifyThresholdStatus({ utilizationPct: 80.0, creditLimit: 100000, totalExposure: 80000 }), 'WARNING');
  assert.equal(classifyThresholdStatus({ utilizationPct: 94.99, creditLimit: 100000, totalExposure: 94990 }), 'WARNING');
  assert.equal(classifyThresholdStatus({ utilizationPct: 95.0, creditLimit: 100000, totalExposure: 95000 }), 'CRITICAL');
  assert.equal(classifyThresholdStatus({ utilizationPct: 100.0, creditLimit: 100000, totalExposure: 100000 }), 'CRITICAL');
  assert.equal(classifyThresholdStatus({ utilizationPct: 100.01, creditLimit: 100000, totalExposure: 100010 }), 'BREACH');
  assert.equal(classifyThresholdStatus({ utilizationPct: 50.0, creditLimit: 100000, totalExposure: 50000, creditBlocked: true }), 'BLOCKED');
  assert.equal(classifyThresholdStatus({ utilizationPct: 999.99, creditLimit: 0, totalExposure: 25000 }), 'BLOCKED');
});

test('calculatePartnerExposureSnapshot computes exact 4-category exposure, ageing buckets, and risk score', () => {
  const partner = {
    bp_id: 'BP-TEST-1',
    bp_name: 'Precision Hydraulics Ltd',
    company_code: 'BS01',
    country_code: 'India',
    credit_segment: 'MAIN',
    risk_class: 'B',
    currency: 'INR'
  };
  const segment = {
    bp_id: 'BP-TEST-1',
    credit_segment: 'MAIN',
    credit_limit: 1000000,
    currency: 'INR',
    credit_blocked: false,
    risk_class: 'B'
  };
  const exposureItems = [
    { item_id: 'E1', bp_id: 'BP-TEST-1', exposure_category: 'OPEN_ORDER', amount: 200000 },
    { item_id: 'E2', bp_id: 'BP-TEST-1', exposure_category: 'OPEN_DELIVERY', amount: 150000 },
    { item_id: 'E3', bp_id: 'BP-TEST-1', exposure_category: 'OPEN_BILLING', amount: 100000 },
    { item_id: 'E4', bp_id: 'BP-TEST-1', exposure_category: 'OPEN_INVOICE', amount: 500000 }
  ];
  // Reference date: 2026-11-09
  const openReceivables = [
    { receivable_id: 'R1', bp_id: 'BP-TEST-1', due_date: '2026-10-25', amount_local_curr: 100000, clearing_status: 'OPEN' }, // 15 days overdue -> 0..30
    { receivable_id: 'R2', bp_id: 'BP-TEST-1', due_date: '2026-09-25', amount_local_curr: 150000, clearing_status: 'OPEN' }, // 45 days overdue -> 31..60
    { receivable_id: 'R3', bp_id: 'BP-TEST-1', due_date: '2026-08-25', amount_local_curr: 120000, clearing_status: 'OPEN' }, // 76 days overdue -> 61..90
    { receivable_id: 'R4', bp_id: 'BP-TEST-1', due_date: '2026-07-01', amount_local_curr: 130000, clearing_status: 'OPEN' }  // 131 days overdue -> 90+
  ];
  const payments = [
    { payment_id: 'P1', bp_id: 'BP-TEST-1', amount: 200000, due_date: '2026-09-01', payment_date: '2026-09-01' },
    { payment_id: 'P2', bp_id: 'BP-TEST-1', amount: 100000, due_date: '2026-09-01', payment_date: '2026-09-11' } // 10 days late
  ];

  const snap = calculatePartnerExposureSnapshot({
    partner,
    segment,
    exposureItems,
    openReceivables,
    payments,
    referenceDate: '2026-11-09'
  });

  assert.equal(snap.open_orders_amount, 200000);
  assert.equal(snap.open_deliveries_amount, 150000);
  assert.equal(snap.open_billing_amount, 100000);
  assert.equal(snap.open_ar_amount, 500000);
  assert.equal(snap.total_exposure, 950000);
  assert.equal(snap.available_credit, 50000);
  assert.equal(snap.utilization_pct, 95);
  assert.equal(snap.threshold_status, 'CRITICAL');

  assert.equal(snap.overdue_amount, 500000);
  assert.equal(snap.overdue_count, 4);
  assert.equal(snap.ageing_0_30, 100000);
  assert.equal(snap.ageing_31_60, 150000);
  assert.equal(snap.ageing_61_90, 120000);
  assert.equal(snap.ageing_90_plus, 130000);

  const pmtBehaviour = calculatePaymentBehaviour(payments);
  assert.equal(pmtBehaviour.avgDaysLate, 5);
  assert.equal(pmtBehaviour.onTimePaymentRatePct, 50);
  assert.equal(snap.diagnostics.composite_risk_score, 57);
});

test('getCanonicalPortfolioAnalytics and getBusinessPartnerCreditDossier return deterministic multi-dimensional rollups', async () => {
  const db = await cds.connect.to('db');
  await cds.deploy(['db/schema.cds']).to(db);

  await recalculateAllExposureSnapshots(db, { referenceDate: '2026-11-09' });
  const portfolio = await getCanonicalPortfolioAnalytics(db, { referenceDate: '2026-11-09' });

  assert.equal(portfolio.summary.customersMonitored, 13);
  assert.equal(portfolio.summary.totalCreditLimit, 10400000);
  assert.equal(portfolio.summary.totalExposure, 6535000);
  assert.equal(portfolio.summary.overallUtilizationPct, 62.84);
  assert.ok(portfolio.byCountry.length >= 3); // India, UAE, Singapore
  assert.ok(portfolio.byCompanyCode.length === 5); // BS01..BS05

  const indiaFiltered = await getCanonicalPortfolioAnalytics(db, {
    countryCode: 'India',
    referenceDate: '2026-11-09'
  });
  assert.ok(indiaFiltered.snapshots.every(s => s.country_code === 'India'));

  const dossier = await getBusinessPartnerCreditDossier(db, 'C001', { referenceDate: '2026-11-09' });
  assert.equal(dossier.partner.bp_id, 'C001');
  assert.equal(dossier.partner.bp_name, 'Aarav Components');
  assert.equal(Number(dossier.snapshot.total_exposure), 1200000);
  assert.equal(Number(dossier.snapshot.credit_limit), 1000000);
  assert.equal(dossier.snapshot.threshold_status, 'BREACH');
  assert.ok(dossier.exposureItems.length >= 3);
});
