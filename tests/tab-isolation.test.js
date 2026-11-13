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

test('fixed viewport layout locks global page scroll and delegates vertical scrolling to .workspace-main', async () => {
  const [variablesCss, baseCss, layoutCss, html, js] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'css', 'variables.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'css', 'base.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'css', 'layout.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'index.html'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'js', 'main.js'), 'utf8')
  ]);

  assert.match(variablesCss, /--sidebar-width:\s*280px;/, '--sidebar-width must be 280px so grid track matches .app-sidebar width with zero overlap');
  assert.match(baseCss, /html,\s*body\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow:\s*hidden;/, 'html and body must lock height to 100dvh with overflow: hidden');
  assert.match(layoutCss, /\.workspace-shell\s*\{[\s\S]*?flex:\s*1\s+1\s+0%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/, '.workspace-shell must fill remaining viewport height with overflow: hidden');
  assert.match(layoutCss, /\.app-sidebar\s*\{[\s\S]*?width:\s*var\(--sidebar-width\);[\s\S]*?border-right:\s*1px\s+solid\s+#DCE3ED;/i, '.app-sidebar must have consistent width and 1px solid #DCE3ED right divider');
  assert.match(layoutCss, /\.workspace-main\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-x:\s*hidden;/, '.workspace-main must scroll independently on the Y axis');
  assert.match(layoutCss, /\.page-shell\s*\{[\s\S]*?padding:\s*1\.5rem\s+1\.75rem\s+2rem;/, '.page-shell must maintain 1.75rem (28px) horizontal padding from the sidebar divider');
  assert.doesNotMatch(html, /calc\(100vh\s*-\s*4\.5rem\)/, 'index.html must not use hardcoded calc(100vh - 4.5rem) that overflows the header');
  assert.match(js, /if\s*\(wsMain\)\s*wsMain\.scrollTop\s*=\s*0;/, 'switchTab must reset .workspace-main scrollTop when changing tabs');
});

test('KPI cards preserve all four metrics and apply refined enterprise typography and pastel themes', async () => {
  const [componentsCss, dashboardJs] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'css', 'components.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'js', 'views', 'dashboard.js'), 'utf8')
  ]);

  assert.match(dashboardJs, /'Total exposure'/, 'Total exposure KPI label must be preserved');
  assert.match(dashboardJs, /'Total credit limit'/, 'Total credit limit KPI label must be preserved');
  assert.match(dashboardJs, /'Overall utilisation'/, 'Overall utilisation KPI label must be preserved');
  assert.match(dashboardJs, /'Overdue invoices'/, 'Overdue invoices KPI label must be preserved');
  assert.match(dashboardJs, /kpi-card--exposure/, 'Exposure card theme class must be applied');
  assert.match(dashboardJs, /kpi-card--limit/, 'Limit card theme class must be applied');
  assert.match(dashboardJs, /kpi-card--utilisation/, 'Utilisation card theme class must be applied');
  assert.match(dashboardJs, /kpi-card--overdue/, 'Overdue card theme class must be applied');
  assert.match(componentsCss, /\.kpi-value\s*\{[\s\S]*?font-family:\s*var\(--font-body\);[\s\S]*?font-variant-numeric:\s*tabular-nums;/, '.kpi-value must use consistent body font family with tabular numerals');
});

test('Workspace navigation separates AI Credit Assistance (#chat-panel), Credit Overview (#overview-panel), and AI Audit History (#audit-panel) in exact 7-tab order', async () => {
  const [html, js] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'index.html'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'app', 'credit', 'js', 'main.js'), 'utf8')
  ]);

  const tabMatches = [...html.matchAll(/<button[^>]*class="tab[^"]*"[^>]*data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(
    tabMatches,
    ['chat', 'overview', 'dashboard', 'analysis', 'approvals', 'simulator', 'audit'],
    'Sidebar navigation must follow the exact 7-tab order: chat, overview, dashboard, analysis, approvals, simulator, audit'
  );

  const chatStart = html.indexOf('<section id="chat-panel"');
  const overviewStart = html.indexOf('<section id="overview-panel"');
  const dashboardStart = html.indexOf('<section id="dashboard-panel"');
  const auditStart = html.indexOf('<section id="audit-panel"');
  assert.ok(chatStart !== -1 && overviewStart > chatStart && dashboardStart > overviewStart && auditStart > dashboardStart, '#audit-panel must follow after other panels');

  const chatContent = html.slice(chatStart, overviewStart);
  const overviewContent = html.slice(overviewStart, dashboardStart);
  const auditContent = html.slice(auditStart);

  assert.doesNotMatch(chatContent, /id="kpis"/, '#chat-panel must be a dedicated AI workspace without #kpis');
  assert.match(chatContent, /id="sec-chat-control"/, '#chat-panel must retain AI Credit Control');
  assert.doesNotMatch(chatContent, /id="sec-audit-memory"/, '#chat-panel must not retain Audit & Memory');
  assert.doesNotMatch(chatContent, /id="sec-enterprise-integration"/, '#chat-panel must not retain Enterprise Integration');
  assert.doesNotMatch(chatContent, /id="sec-execution-status"/, '#chat-panel must not retain Execution Status');

  assert.match(auditContent, /id="sec-audit-memory"/, '#audit-panel must contain Audit & Memory');
  assert.match(auditContent, /id="sec-enterprise-integration"/, '#audit-panel must contain Enterprise Integration');
  assert.match(auditContent, /id="sec-execution-status"/, '#audit-panel must contain Execution Status');

  assert.match(overviewContent, /id="kpis"/, '#overview-panel must contain #kpis');
  assert.match(overviewContent, /id="overview-health-verdict"/, '#overview-panel must contain portfolio health verdict banner');
  assert.match(overviewContent, /id="overview-attention-list"/, '#overview-panel must contain attention needed section');
  assert.match(overviewContent, /id="overview-shortcuts"/, '#overview-panel must contain navigation shortcuts section');
  assert.doesNotMatch(overviewContent, /id="overview-country-exposure"/, '#overview-panel must not duplicate country exposure bar chart');
  assert.doesNotMatch(overviewContent, /id="overview-company-exposure"/, '#overview-panel must not duplicate company-code exposure bar chart');

  assert.match(js, /function openAiCreditAssistanceWorkspace[\s\S]*?switchTab\('chat'\)/, 'Quick AI Ask helper must navigate directly to AI Credit Assistance (chat)');
});




