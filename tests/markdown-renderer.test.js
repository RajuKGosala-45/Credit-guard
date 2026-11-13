const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const appRoot = path.join(__dirname, '..', 'app', 'credit', 'js');
let moduleSequence = 0;

async function loadChatModule() {
  const utils = await fs.readFile(path.join(appRoot, 'utils.js'), 'utf8');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(utils).toString('base64')}`;
  let blockRendererSource = await fs.readFile(path.join(appRoot, 'views', 'blockRenderer.js'), 'utf8');
  blockRendererSource = blockRendererSource.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  const blockRendererUrl = `data:text/javascript;base64,${Buffer.from(blockRendererSource).toString('base64')}`;
  let source = await fs.readFile(path.join(appRoot, 'views', 'chat.js'), 'utf8');
  source = source.replaceAll("'../utils.js'", `'${utilsUrl}'`);
  source = source.replaceAll("'./blockRenderer.js'", `'${blockRendererUrl}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleSequence += 1}`;
  return import(moduleUrl);
}

test('renders markdown headings, bold, code, bullets, and thin dividers', async () => {
  const { formatAssistantReply } = await loadChatModule();
  const input = [
    '## Main Section',
    '### Sub Section',
    'Here is **bold text** and `inline_code`.',
    '---',
    '- First bullet point',
    '- Second bullet point',
    '1. First ordered item',
    '2. Second ordered item'
  ].join('\n');

  const html = formatAssistantReply(input);
  assert.match(html, /<h3 class="ai-heading-2">Main Section<\/h3>/);
  assert.match(html, /<h4 class="ai-heading-3">Sub Section<\/h4>/);
  assert.match(html, /<strong>bold text<\/strong>/);
  assert.match(html, /<code class="ai-inline-code">inline_code<\/code>/);
  assert.match(html, /<hr class="ai-divider">/);
  assert.match(html, /<ul class="ai-list"><li>First bullet point<\/li><li>Second bullet point<\/li><\/ul>/);
  assert.match(html, /<ol class="ai-list numbered"><li>First ordered item<\/li><li>Second ordered item<\/li><\/ol>/);
});

test('escapes raw HTML to prevent XSS and falls back safely on invalid input', async () => {
  const { formatAssistantReply } = await loadChatModule();
  const xssInput = 'Alert <script>alert("hack")</script> and <img src=x onerror=alert(1)>';
  const html = formatAssistantReply(xssInput);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x/);
});

test('applies colored status badges to BREACH, WARNING, OVERDUE_AMOUNT, OK, and customer ID chips', async () => {
  const { formatAssistantReply } = await loadChatModule();
  const text = 'Customer C001 is in BREACH. Customer C002 has WARNING status with OVERDUE_AMOUNT. C003 is OK and HEALTHY.';
  const html = formatAssistantReply(text);

  assert.match(html, /<code class="ai-id-chip">C001<\/code>/);
  assert.match(html, /<span class="ai-badge badge-red">BREACH<\/span>/);
  assert.match(html, /<span class="ai-badge badge-amber">WARNING<\/span>/);
  assert.match(html, /<span class="ai-badge badge-orange">OVERDUE_AMOUNT<\/span>/);
  assert.match(html, /<span class="ai-badge badge-green">OK<\/span>/);
  assert.match(html, /<span class="ai-badge badge-green">HEALTHY<\/span>/);
});

test('renders markdown table with Indian currency, utilisation progress bar, and split risk badges without injecting unconditional KPI cards or charts', async () => {
  const { formatAssistantReply } = await loadChatModule();
  const markdownTable = [
    'Portfolio analysis for flagged accounts:',
    '| Customer | Limit | Exposure | Utilisation % | Status | Risk Flags |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Aarav Components (C001) | ₹10,00,000 | ₹12,00,000 | 120% | BREACH | BREACH, OVERDUE_AMOUNT |',
    '| Bharat Electricals (C002) | ₹8,00,000 | ₹7,20,000 | 90% | WARNING | OVERDUE_RISK |',
    '| Chennai Logistics (C003) | ₹5,00,000 | ₹4,25,000 | 85% | WARNING | STALE_REVIEW |',
    '| Delhi Dynamics (C004) | ₹15,00,000 | ₹9,00,000 | 60% | OK | NORMAL |'
  ].join('\n');

  const html = formatAssistantReply(markdownTable);

  // 1. Table structure
  assert.match(html, /<table class="ai-table">/);
  assert.match(html, /<thead/);
  assert.match(html, /<tbody/);

  // 2. Customer cell formatting
  assert.match(html, /<strong class="ai-customer-name">Aarav Components<\/strong>/);
  assert.match(html, /<code class="ai-id-chip">C001<\/code>/);

  // 3. Indian Currency formatting
  assert.match(html, /₹12,00,000/);
  assert.match(html, /₹10,00,000/);
  assert.match(html, /₹7,20,000/);

  // 4. Utilisation cell with colored progress bar and real label
  assert.match(html, /ai-util-cell/);
  assert.match(html, /ai-util-bar-fill breach/);
  assert.match(html, /style="width: 100%;"/);
  assert.match(html, /<span class="ai-util-label breach">120%<\/span>/);
  assert.match(html, /<span class="ai-util-label warning">90%<\/span>/);
  assert.match(html, /<span class="ai-util-label healthy">60%<\/span>/);

  // 5. Risk flags split into multiple badges
  assert.match(html, /<span class="ai-badge badge-red">BREACH<\/span>/);
  assert.match(html, /<span class="ai-badge badge-orange">OVERDUE_AMOUNT<\/span>/);
  assert.match(html, /<span class="ai-badge badge-amber">OVERDUE_RISK<\/span>/);

  // 6. Does NOT unconditionally prepend KPI cards or chart to plain markdown tables
  assert.doesNotMatch(html, /<div class="ai-kpi-summary-grid">/);
  assert.doesNotMatch(html, /Customer Utilisation vs Policy Thresholds/);
});

test('collapses advisory into yellow info box and moves execution status to muted footer', async () => {
  const { formatAssistantReply } = await loadChatModule();
  const input = [
    'Flagged customer overview complete.',
    '### Important Information / Advisory',
    'Credit recommendations are advisory only. Never increase limits without authorized human controller sign-off.',
    'Execution status: COMPLETED (3/3 tasks completed).',
    'Modules used: Customers, Monitoring',
    'Data sources: Credit Guard CAP database'
  ].join('\n');

  const html = formatAssistantReply(input);

  assert.match(html, /<details class="ai-advisory-box">/);
  assert.match(html, /<summary class="ai-advisory-summary">/);
  assert.match(html, /Important Information \/ Advisory/);
  assert.match(html, /\(click to expand\)/);
  assert.match(html, /Credit recommendations are advisory only/);

  assert.match(html, /<footer class="ai-answer-footer">/);
  assert.match(html, /Execution status: COMPLETED \(3\/3 tasks completed\)/);
  assert.match(html, /Modules used: Customers, Monitoring/);
  assert.match(html, /Data sources: Credit Guard CAP database/);
});
