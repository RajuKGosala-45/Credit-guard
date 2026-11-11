const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

test('all 6 SAP BTP & HANA CDS sections reside exclusively within #simulator-panel in index.html', async () => {
  const html = await fs.readFile(path.join(projectRoot, 'app', 'credit', 'index.html'), 'utf8');

  // Verify #simulator-panel does not have inline display: flex
  assert.match(
    html,
    /<section id="simulator-panel" class="tab-panel">/,
    '#simulator-panel must have clean class="tab-panel" with no inline display style overriding visibility'
  );
  assert.doesNotMatch(
    html,
    /<section id="simulator-panel"[^>]*style="[^"]*display:\s*flex/i,
    '#simulator-panel must NOT have inline display: flex style'
  );

  // Extract simulator panel content
  const simPanelStartIndex = html.indexOf('<section id="simulator-panel"');
  assert.ok(simPanelStartIndex !== -1, 'simulator panel must exist in index.html');
  const simPanelContent = html.slice(simPanelStartIndex);

  // Verify all 6 SAP BTP & HANA CDS sections/markers are inside #simulator-panel:
  // 1. Multi-Source Data Connectors (#sec-connectors)
  // 2. Upload & Auto-Discover Schema (contained within #connectors-workspace in #sec-connectors)
  // 3. Autonomous Credit Monitoring Scheduler (#sec-scheduler / #scheduler-workspace)
  // 4. SAP S/4HANA FSCM & BTP Data Integration (#sec-sap-integration)
  // 5. CANONICAL CAP / HANA INGESTION – Latest Extraction & Validation
  // 6. DETERMINISTIC FSCM RULES ENGINE – Monitoring Results
  assert.ok(simPanelContent.includes('id="sec-connectors"'), 'sec-connectors must be inside #simulator-panel');
  assert.ok(simPanelContent.includes('id="sec-scheduler"'), 'sec-scheduler must be inside #simulator-panel');
  assert.ok(simPanelContent.includes('id="sec-sap-integration"'), 'sec-sap-integration must be inside #simulator-panel');
  assert.ok(simPanelContent.includes('CANONICAL CAP / HANA INGESTION'), 'Extraction & Validation must be inside #simulator-panel');
  assert.ok(simPanelContent.includes('DETERMINISTIC FSCM RULES ENGINE'), 'Rules Engine Monitoring Results must be inside #simulator-panel');

  // Verify none of the other tab panels contain these SAP BTP & HANA CDS sections:
  const mainShellIndex = html.indexOf('class="page-shell"');
  assert.ok(mainShellIndex !== -1, 'page-shell must exist in index.html');
  const otherPanelsContent = html.slice(mainShellIndex, simPanelStartIndex);

  assert.doesNotMatch(otherPanelsContent, /id="sec-connectors"/, 'sec-connectors must NOT exist in other panels');
  assert.doesNotMatch(otherPanelsContent, /id="sec-scheduler"/, 'sec-scheduler must NOT exist in other panels');
  assert.doesNotMatch(otherPanelsContent, /id="sec-sap-integration"/, 'sec-sap-integration must NOT exist in other panels');
  assert.doesNotMatch(otherPanelsContent, /id="connectors-workspace"/, 'connectors-workspace must NOT exist in other panels');
  assert.doesNotMatch(otherPanelsContent, /id="scheduler-workspace"/, 'scheduler-workspace must NOT exist in other panels');
});

test('CSS rules in layout.css enforce strict tab-panel display isolation with !important', async () => {
  const css = await fs.readFile(path.join(projectRoot, 'app', 'credit', 'css', 'layout.css'), 'utf8');

  // .tab-panel must be hidden with display: none !important
  assert.match(
    css,
    /\.tab-panel\s*\{[\s\S]*?display:\s*none\s*!important;/,
    '.tab-panel must be display: none !important to prevent any leakage'
  );

  // .tab-panel.active must be display: block !important
  assert.match(
    css,
    /\.tab-panel\.active\s*\{[\s\S]*?display:\s*block\s*!important;/,
    '.tab-panel.active must be display: block !important'
  );

  // #simulator-panel.active must be display: flex !important
  assert.match(
    css,
    /#simulator-panel\.active\s*\{[\s\S]*?display:\s*flex\s*!important;/,
    '#simulator-panel.active must be display: flex !important'
  );
});

test('main.js switchTab cleanly removes any inline display style from all tab panels', async () => {
  const js = await fs.readFile(path.join(projectRoot, 'app', 'credit', 'js', 'main.js'), 'utf8');

  assert.match(
    js,
    /panel\.style\.removeProperty\('display'\)/,
    'switchTab must call removeProperty("display") to ensure clean state across tab switches'
  );
});
