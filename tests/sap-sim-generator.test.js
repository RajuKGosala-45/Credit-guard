const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPrng,
  generateDataset,
  writeDataset
} = require('../scripts/generate-sap-sim-data');

const EXPECTED_SCENARIO_KEYS = [
  'EXACTLY_80_PERCENT_UTILIZATION',
  'EXACTLY_100_PERCENT_UTILIZATION',
  'EXACTLY_120_PERCENT_UTILIZATION',
  'ZERO_CREDIT_LIMIT',
  'BLOCKED_ACCOUNT',
  'OVERDUE_SHARE_ABOVE_30_PERCENT',
  'OVERDUE_SHARE_AT_OR_BELOW_30_PERCENT',
  'STALE_REVIEW_DATE',
  'MIXED_CURRENCY_ITEMS_REJECTED',
  'PARTIAL_PAYMENTS_ON_TIME_CLEARING',
  'PARTIAL_PAYMENTS_LATE_CLEARING',
  'CREDIT_MEMO_AND_PAYMENT_ON_ACCOUNT_UNMODELED',
  'IDENTICAL_DUPLICATE_ROWS',
  'OPEN_SALES_ORDERS_COMM_TYP'
];

test('PRNG and generator determinism: identical seed and options produce byte-for-byte identical CSVs and expected-results.json', () => {
  const prng1 = createPrng(42);
  const prng2 = createPrng(42);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(prng1(), prng2());
  }

  const tmpRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-sim-gen-1-'));
  const tmpRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-sim-gen-2-'));

  try {
    const opts1 = {
      seed: 42,
      customers: 300,
      today: '2026-11-10',
      out: path.join(tmpRoot1, 'data'),
      expectedOut: path.join(tmpRoot1, 'fixtures', 'expected-results.json')
    };
    const opts2 = {
      seed: 42,
      customers: 300,
      today: '2026-11-10',
      out: path.join(tmpRoot2, 'data'),
      expectedOut: path.join(tmpRoot2, 'fixtures', 'expected-results.json')
    };

    writeDataset(opts1, generateDataset(opts1));
    writeDataset(opts2, generateDataset(opts2));

    const files1 = fs.readdirSync(opts1.out).sort();
    const files2 = fs.readdirSync(opts2.out).sort();
    assert.deepEqual(files1, files2);
    assert.deepEqual(files1, [
      'BSAD.csv',
      'BSID.csv',
      'BUT000.csv',
      'UKMBP_CMS_SGM.csv',
      'UKM_ITEM.csv',
      'VBAK.csv'
    ]);

    for (const file of files1) {
      const content1 = fs.readFileSync(path.join(opts1.out, file), 'utf8');
      const content2 = fs.readFileSync(path.join(opts2.out, file), 'utf8');
      assert.equal(content1, content2, `CSV output mismatch for ${file}`);
    }

    const exp1 = fs.readFileSync(opts1.expectedOut, 'utf8');
    const exp2 = fs.readFileSync(opts2.expectedOut, 'utf8');
    assert.equal(exp1, exp2, 'expected-results.json output must be byte-for-byte identical');
  } finally {
    fs.rmSync(tmpRoot1, { recursive: true, force: true });
    fs.rmSync(tmpRoot2, { recursive: true, force: true });
  }
});

test('SAP field formats: 10-digit zero-padded PARTNER/KUNNR, YYYYMMDD dates, SHKZG S/H, BLART RV/DG/DZ, and XBLOCKED=X only on blocked scenario', () => {
  const dataset = generateDataset({
    seed: 42,
    customers: 300,
    today: '2026-11-10'
  });

  const { BUT000, UKMBP_CMS_SGM, UKM_ITEM, BSID, BSAD, VBAK } = dataset.tables;
  assert.equal(BUT000.length, 300);
  assert.equal(UKMBP_CMS_SGM.length, 300);

  for (const row of BUT000) {
    assert.match(row.PARTNER, /^\d{10}$/, `Invalid PARTNER format: ${row.PARTNER}`);
    assert.ok(['INR', 'USD', 'EUR'].includes(row.WAERS));
  }

  let blockedCount = 0;
  for (const row of UKMBP_CMS_SGM) {
    assert.match(row.PARTNER, /^\d{10}$/);
    assert.match(row.LIMIT_VALID_DATE, /^\d{8}$/);
    assert.match(row.FOLLOW_UP_DT, /^\d{8}$/);
    if (row.PARTNER === '0001000005') {
      assert.equal(row.XBLOCKED, 'X');
      blockedCount += 1;
    } else {
      assert.equal(row.XBLOCKED, '');
    }
  }
  assert.equal(blockedCount, 1);

  for (const row of BSID) {
    assert.match(row.KUNNR, /^\d{10}$/);
    assert.match(row.ZFBDT, /^\d{8}$/);
    assert.ok(['S', 'H'].includes(row.SHKZG), `Unexpected SHKZG: ${row.SHKZG}`);
    assert.ok(['RV', 'DG', 'DZ'].includes(row.BLART), `Unexpected BLART in BSID: ${row.BLART}`);
  }

  for (const row of BSAD) {
    assert.match(row.KUNNR, /^\d{10}$/);
    assert.match(row.AUGDT, /^\d{8}$/);
    assert.match(row.ZFBDT, /^\d{8}$/);
    assert.equal(row.BLART, 'DZ');
  }

  for (const row of VBAK) {
    assert.match(row.KUNNR, /^\d{10}$/);
    assert.match(row.ERDAT, /^\d{8}$/);
  }

  for (const row of UKM_ITEM) {
    assert.match(row.PARTNER, /^\d{10}$/);
    assert.match(row.NETDT, /^\d{8}$/);
    assert.ok(['OPEN_INVOICE', 'OPEN_ORDER'].includes(row.COMM_TYP));
  }
});

test('Scenario coverage and directory placement: all 14 scenarios exist, only CSVs under db/sap-sim/data, and expected-results.json + SYNTHETIC_NOTICE.txt under tests/fixtures/sap-sim', () => {
  const outDir = path.join('db', 'sap-sim', 'data');
  const committedExpectedPath = path.join('tests', 'fixtures', 'sap-sim', 'expected-results.json');
  const committedNoticePath = path.join('tests', 'fixtures', 'sap-sim', 'SYNTHETIC_NOTICE.txt');

  const tmpFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-sim-fixtures-'));
  const tmpExpectedOut = path.join(tmpFixtureDir, 'expected-results.json');
  const tmpNoticeOut = path.join(tmpFixtureDir, 'SYNTHETIC_NOTICE.txt');

  try {
    const options = {
      seed: 42,
      customers: 300,
      today: '2026-11-10',
      out: outDir,
      expectedOut: tmpExpectedOut
    };
    writeDataset(options, generateDataset(options));

    const outFiles = fs.readdirSync(outDir).sort();
    assert.deepEqual(outFiles, [
      'BSAD.csv',
      'BSID.csv',
      'BUT000.csv',
      'UKMBP_CMS_SGM.csv',
      'UKM_ITEM.csv',
      'VBAK.csv'
    ]);
    assert.equal(fs.existsSync(path.join(outDir, 'expected-results.json')), false);
    assert.equal(fs.existsSync(path.join(outDir, 'SYNTHETIC_NOTICE.txt')), false);

    assert.equal(fs.existsSync(tmpExpectedOut), true);
    assert.equal(fs.existsSync(tmpNoticeOut), true);
    assert.equal(fs.existsSync(committedExpectedPath), true);
    assert.equal(fs.existsSync(committedNoticePath), true);

    const committedNoticeText = fs.readFileSync(committedNoticePath, 'utf8');
    assert.match(committedNoticeText, /SYNTHETIC - NOT REAL SAP DATA/);
    assert.match(committedNoticeText, /Verify in SE11\/SE16N/i);
    assert.equal(fs.readFileSync(tmpNoticeOut, 'utf8'), committedNoticeText);

    const committedExpectedRaw = fs.readFileSync(committedExpectedPath, 'utf8');
    const tmpExpectedRaw = fs.readFileSync(tmpExpectedOut, 'utf8');
    assert.equal(tmpExpectedRaw, committedExpectedRaw);

    const expected = JSON.parse(committedExpectedRaw);
    assert.equal(expected.label, 'SYNTHETIC - NOT REAL SAP DATA');
    assert.equal(expected.metadata.asOfDate, '2026-11-10');
    assert.equal(expected.metadata.seed, 42);
    assert.equal(expected.metadata.customerCount, 300);
    assert.deepEqual(Object.keys(expected.scenarioCustomers), EXPECTED_SCENARIO_KEYS);
    assert.equal(Object.keys(expected.allCustomers).length, 300);
  } finally {
    fs.rmSync(tmpFixtureDir, { recursive: true, force: true });
  }
});
