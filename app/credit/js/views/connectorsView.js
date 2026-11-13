import {
  getV2Connectors,
  testV2Connector,
  discoverV2Schema,
  confirmV2Mappings,
  syncV2Connector,
  getV2SchedulerStatus,
  triggerV2SchedulerCycle
} from '../api.js';
import { recordExtractionRun, state, updateConnectorSyncTimestamp } from '../state.js';
import { escapeHTML } from '../utils.js';

let activeDiscoveredMappings = [];
let activeDiscoveredSourceId = 'FILE-CSV-JSON-UPLOAD';
let schedulerCycleInFlight = false;

export async function renderDataSourcesPanel(container) {
  if (!container) return;
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1.5rem;">
      <!-- ROW 1: FULL-WIDTH ENTERPRISE CONNECTORS SECTION -->
      <section class="card" style="width: 100%;">
        <div class="card-heading">
          <div>
            <p class="eyebrow">ENTERPRISE CONNECTORS &amp; SAP S/4HANA</p>
            <h2>Multi-Source Data Connectors</h2>
          </div>
          <button id="refresh-connectors-btn" class="button secondary" type="button">Refresh connectors</button>
        </div>
        <p id="connectors-action-message" class="form-message" role="status" style="margin-bottom: 0.75rem;"></p>
        <p class="muted">
          Connect enterprise ERP systems, SAP S/4HANA OData services, SAP BTP Destinations, and structured file exports into the 3-layer FIN-FSCM-CR canonical pipeline (RAW → CANONICAL → CALCULATION).
        </p>
        <div id="connectors-status-grid" class="kpi-grid"></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Source ID</th>
                <th>Source Name</th>
                <th>Connector Type</th>
                <th>Config Reference</th>
                <th>Status</th>
                <th>Last Synced</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="connectors-table-body">
              <tr><td colspan="7" class="muted">Loading connectors…</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ROW 2: STRUCTURED ERP FILE CONNECTOR -->
      <div class="connectors-row-2" style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; align-items: start;">
        <section class="card" style="height: 100%;">
          <div class="card-heading">
            <div>
              <p class="eyebrow">STRUCTURED ERP FILE CONNECTOR</p>
              <h2>Upload &amp; Auto-Discover Schema</h2>
            </div>
          </div>
          <p class="muted">
            Upload enterprise tabular exports (CSV, TSV, JSON, OData JSON, or XML). The schema discovery engine auto-detects column headers, infers data types, and proposes confidence-scored mappings into SAP FIN-FSCM-CR canonical entities.
          </p>
          <div class="file-upload-box" style="margin-top: 1rem;">
            <label class="button secondary" style="cursor: pointer; display: inline-block;">
              Choose File (CSV, JSON, XML)
              <input id="structured-file-input" type="file" accept=".csv,.tsv,.json,.xml,text/csv,application/json,application/xml" style="display: none;">
            </label>
            <span id="selected-file-label" class="muted" style="margin-left: 1rem;">No file chosen</span>
            <button id="discover-schema-btn" class="button primary" type="button" disabled style="margin-top: 0.75rem; display: block;">Discover Schema &amp; Propose Mappings</button>
          </div>

          <div id="schema-discovery-results" style="margin-top: 1.5rem; display: none;">
            <div class="card-heading">
              <div>
                <p class="eyebrow">SCHEMA MAPPING PROPOSALS</p>
                <h3>Target Entity: <span id="discovered-primary-entity" class="pill warning"></span></h3>
              </div>
              <div class="document-actions">
                <button id="confirm-sync-btn" class="button primary" type="button">Confirm Mappings &amp; Ingest to Canonical</button>
              </div>
            </div>
            <p id="discovery-meta-text" class="muted"></p>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Source Column</th>
                    <th>Sample Values</th>
                    <th>Canonical Entity</th>
                    <th>Canonical Field</th>
                    <th>Transform Rule</th>
                    <th>Confidence</th>
                    <th>SAP Reference</th>
                    <th>Verified Note</th>
                  </tr>
                </thead>
                <tbody id="proposed-mappings-body"></tbody>
              </table>
            </div>
          </div>
          <p id="connector-sync-message" class="form-message" role="status" style="margin-top: 1rem;"></p>
        </section>
      </div>
    </div>
  `;

  attachConnectorEvents(container);
  await loadConnectorsList(container);
}

export async function renderSchedulerPanel(container) {
  if (!container) return;
  container.innerHTML = `
    <section class="card">
      <div class="card-heading">
        <div>
          <p class="eyebrow">AUTONOMOUS DAEMON · 5-MINUTE HEARTBEAT</p>
          <h2>Autonomous Credit Monitoring Scheduler</h2>
        </div>
        <div class="document-actions">
          <button id="refresh-scheduler-btn" class="button secondary" type="button">Refresh Status</button>
          <button id="trigger-scheduler-btn" class="button primary" type="button">Run Cycle Now</button>
        </div>
      </div>
      <p class="muted">
        Continuously executes delta data extraction, recalculates deterministic FIN-FSCM-CR exposure snapshots across all Business Partners, and dispatches monitoring runs with database mutex slot locking to prevent duplicate jobs.
      </p>
      <div id="scheduler-status-grid" class="kpi-grid">
        <div class="kpi-card"><span class="kpi-label">Daemon Status</span><span class="kpi-value">Loading…</span></div>
      </div>
      <p id="scheduler-action-message" class="form-message" role="status" style="margin-top: 0.75rem;"></p>
    </section>
  `;
  attachSchedulerEvents(container);
  await loadSchedulerStatus(container);
}

async function loadConnectorsList(container) {
  const tbody = container.querySelector('#connectors-table-body');
  const kpiGrid = container.querySelector('#connectors-status-grid');
  try {
    const data = await getV2Connectors();
    state.v2Connectors = data;
    const sources = data.sources || [];
    kpiGrid.style.cssText = 'display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem;';
    kpiGrid.innerHTML = `
      <div class="kpi-card" style="position: relative; overflow: hidden; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #1a73e8;"></div>
        <span class="kpi-label" style="font-size: 0.825rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">Active Sources</span>
        <span class="kpi-value" style="font-size: 1.75rem; font-weight: 700; color: #1a73e8; line-height: 1.2;">${sources.filter(s => s.status === 'ACTIVE').length} / ${sources.length}</span>
        <span class="kpi-subtext" style="font-size: 0.8rem; font-weight: 400; color: #64748b;">Registered connectors</span>
      </div>

      <div class="kpi-card" style="position: relative; overflow: hidden; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #7c3aed;"></div>
        <span class="kpi-label" style="font-size: 0.825rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">Field Mappings</span>
        <span class="kpi-value" style="font-size: 1.75rem; font-weight: 700; color: #7c3aed; line-height: 1.2;">${data.mappingsCount || 0}</span>
        <span class="kpi-subtext" style="font-size: 0.8rem; font-weight: 400; color: #64748b;">in CG_FIELD_MAPPING</span>
      </div>

      <div class="kpi-card" style="position: relative; overflow: hidden; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #0d9488;"></div>
        <span class="kpi-label" style="font-size: 0.825rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">SAP Candidate Services</span>
        <span class="kpi-value" style="font-size: 1.75rem; font-weight: 700; color: #0d9488; line-height: 1.2;">${(data.sapCandidateODataServices || []).length}</span>
        <span class="kpi-subtext" style="font-size: 0.8rem; font-weight: 400; color: #64748b;">OData &amp; CDS Views</span>
      </div>

      <div class="kpi-card" style="position: relative; overflow: hidden; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.04); display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #0b8043;"></div>
        <span class="kpi-label" style="font-size: 0.825rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">HANA Tables</span>
        <span class="kpi-value" style="font-size: 1.75rem; font-weight: 700; color: #0b8043; line-height: 1.2;">${(data.hanaReplicatedTables || []).length}</span>
        <span class="kpi-subtext" style="font-size: 0.8rem; font-weight: 400; color: #64748b;">Replicated Tables</span>
      </div>
    `;

    tbody.innerHTML = sources.map(s => {
      const isStandby = String(s.status || '').toUpperCase() === 'STANDBY';
      const lastSyncedLabel = s.last_sync_at
        ? new Date(s.last_sync_at).toLocaleString()
        : (isStandby ? 'Never (Not connected)' : 'Not yet synced');
      const sourceIdHtml = s.source_id === 'MOCK-SAP-FIN-FSCM'
        ? `<code>${escapeHTML(s.source_id)}</code><br><small class="muted">Simulator ID: <code>MOCK-S4-001</code></small>`
        : `<code>${escapeHTML(s.source_id)}</code>`;
      return `
      <tr>
        <td>${sourceIdHtml}</td>
        <td><strong>${escapeHTML(s.source_name)}</strong></td>
        <td><span class="pill ${s.source_type === 'FILE' ? 'primary' : 'warning'}">${escapeHTML(s.source_type)}</span></td>
        <td><code>${escapeHTML(s.connection_config_ref)}</code></td>
        <td><span class="pill ${s.status === 'ACTIVE' ? 'success' : 'neutral'}">${escapeHTML(s.status)}</span></td>
        <td>${escapeHTML(lastSyncedLabel)}</td>
        <td>
          <button class="button secondary test-conn-btn" data-source-id="${escapeHTML(s.source_id)}" data-source-type="${escapeHTML(s.source_type)}" type="button" style="padding: 0.25rem 0.6rem; font-size: 0.85rem;">Test</button>
          <button class="button secondary sync-conn-btn" data-source-id="${escapeHTML(s.source_id)}" data-source-type="${escapeHTML(s.source_type)}" type="button" style="padding: 0.25rem 0.6rem; font-size: 0.85rem;">Sync</button>
        </td>
      </tr>
    `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="form-message error">${escapeHTML(err.message || 'Failed to load connectors.')}</td></tr>`;
    throw err;
  }
}

export async function loadSchedulerStatus(container = document) {
  const grid = container.querySelector('#scheduler-status-grid');
  if (!grid) return;
  try {
    const sched = await getV2SchedulerStatus();
    state.schedulerStatus = sched;
    const schedState = sched.state
      || (sched.lastRunStatus === 'FAILED' ? 'ERROR' : (sched.status === 'RUNNING' ? 'RUNNING' : 'IDLE'));
    const pillClass = schedState === 'RUNNING' ? 'success' : (schedState === 'ERROR' ? 'error' : 'neutral');
    const lastCycle = sched.lastCycleTime || sched.lastCompletedAt || sched.lastRunAt;
    const nextCycle = sched.nextCycleTime || sched.nextRunAt;
    const lastErrorText = sched.lastError || sched.lastRunError;
    grid.innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">Daemon Status</span>
        <span class="kpi-value"><span class="pill ${pillClass}">${escapeHTML(schedState)}</span></span>
        <span class="kpi-subtext">Interval: ${escapeHTML(sched.intervalMinutes ?? 5)} min (${escapeHTML(sched.intervalMs ?? 300000)} ms)</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Cycle Telemetry</span>
        <span class="kpi-value">${escapeHTML(sched.successfulRuns ?? 0)} / ${escapeHTML(sched.totalRuns ?? 0)}</span>
        <span class="kpi-subtext">Succeeded · ${escapeHTML(sched.skippedRuns ?? 0)} Skipped · ${escapeHTML(sched.failedRuns ?? 0)} Failed</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Last Execution (scheduler cycle)</span>
        <span class="kpi-value" style="font-size: 1rem;">${lastCycle ? escapeHTML(new Date(lastCycle).toLocaleTimeString()) : 'Pending initial'}</span>
        <span class="kpi-subtext">Status: ${escapeHTML(sched.lastRunStatus || sched.lastResult?.status || 'NONE')} · Scheduler cycle duration: ${escapeHTML(sched.lastRunDurationMs ?? 0)} ms${lastErrorText ? ` · Error: ${escapeHTML(lastErrorText)}` : ''}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Next Scheduled Run</span>
        <span class="kpi-value" style="font-size: 1rem;">${nextCycle ? escapeHTML(new Date(nextCycle).toLocaleTimeString()) : '—'}</span>
        <span class="kpi-subtext">Slot Mutex Protected</span>
      </div>
    `;
  } catch (err) {
    state.schedulerStatus = { status: 'ERROR', state: 'ERROR', lastError: err.message };
    grid.innerHTML = `
      <div class="kpi-card" style="grid-column: 1 / -1;">
        <span class="kpi-label">Daemon Status</span>
        <span class="kpi-value"><span class="pill error">ERROR</span></span>
        <span class="kpi-subtext error" style="margin-top: 0.35rem;">${escapeHTML(err.message || 'Scheduler status endpoint failed or timed out.')}</span>
        <div style="margin-top: 0.6rem;">
          <button id="retry-scheduler-status-btn" class="button secondary" type="button" style="padding: 0.3rem 0.75rem; font-size: 0.85rem;">Retry</button>
        </div>
      </div>
    `;
    const retryBtn = grid.querySelector('#retry-scheduler-status-btn');
    retryBtn?.addEventListener('click', () => loadSchedulerStatus(container).catch(() => {}));
  }
}

function attachSchedulerEvents(container) {
  const refreshSchedBtn = container.querySelector('#refresh-scheduler-btn');
  const triggerSchedBtn = container.querySelector('#trigger-scheduler-btn');
  const schedMsgEl = container.querySelector('#scheduler-action-message');

  refreshSchedBtn?.addEventListener('click', async () => {
    refreshSchedBtn.disabled = true;
    const origText = refreshSchedBtn.textContent || 'Refresh Status';
    refreshSchedBtn.textContent = 'Refreshing…';
    if (schedMsgEl) {
      schedMsgEl.textContent = 'Refreshing scheduler daemon status…';
      schedMsgEl.className = 'form-message';
    }
    try {
      await loadSchedulerStatus(container);
      if (schedMsgEl && state.schedulerStatus?.state !== 'ERROR') {
        schedMsgEl.textContent = `Scheduler status updated (${state.schedulerStatus?.state || 'IDLE'}) at ${new Date().toLocaleTimeString()}.`;
        schedMsgEl.className = 'form-message success';
      } else if (schedMsgEl && state.schedulerStatus?.lastError) {
        schedMsgEl.textContent = `Scheduler status failed: ${state.schedulerStatus.lastError}`;
        schedMsgEl.className = 'form-message error';
      }
    } catch (err) {
      if (schedMsgEl) {
        schedMsgEl.textContent = `Scheduler refresh failed: ${err.message}`;
        schedMsgEl.className = 'form-message error';
      }
    } finally {
      refreshSchedBtn.disabled = false;
      refreshSchedBtn.textContent = origText;
    }
  });

  triggerSchedBtn?.addEventListener('click', async () => {
    if (schedulerCycleInFlight) return;
    schedulerCycleInFlight = true;
    triggerSchedBtn.disabled = true;
    triggerSchedBtn.textContent = 'Executing Cycle…';
    if (schedMsgEl) {
      schedMsgEl.textContent = 'Running autonomous exposure recalculation and monitoring job…';
      schedMsgEl.className = 'form-message';
    }
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      const outcome = await triggerV2SchedulerCycle(true);
      const finishedAt = outcome?.run?.completedAt || outcome?.run?.startedAt || new Date().toISOString();
      const durationMs = outcome?.durationMs ?? (Date.now() - startMs);
      const runStatus = outcome?.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
      recordExtractionRun({
        runId: outcome?.runId || `SCHED-CYCLE:${finishedAt}`,
        startedAt,
        finishedAt,
        durationMs,
        sourceId: 'CAP-HANA-CDS',
        sourceName: 'Autonomous Credit Monitoring Scheduler',
        status: runStatus,
        recordCounts: { snapshots: outcome?.snapshotCount ?? 0 },
        error: outcome?.error || null,
        triggeredBy: 'MANUAL'
      });
      updateConnectorSyncTimestamp('ACTIVE', finishedAt);
      if (schedMsgEl) {
        schedMsgEl.textContent = `Cycle ${outcome.status}: Slot ${outcome.slotKey} | Run ID: ${outcome.runId || 'N/A'} | Snapshots Recalculated: ${outcome.snapshotCount ?? 0} | Duration: ${durationMs} ms`;
        schedMsgEl.className = 'form-message success';
      }
      await loadSchedulerStatus(container);
      const connectorsHost = document.querySelector('#connectors-workspace');
      if (connectorsHost && connectorsHost.hasChildNodes()) {
        await loadConnectorsList(connectorsHost).catch(() => {});
      }
      const mockRegEl = document.querySelector('#mock-sap-registration');
      if (mockRegEl) mockRegEl.textContent = 'Registered source';
      if (runStatus === 'COMPLETED') {
        const mockMonBtn = document.querySelector('#run-mock-sap-monitoring');
        if (mockMonBtn && state.session?.permissions?.canMonitor === true) {
          mockMonBtn.hidden = false;
          mockMonBtn.disabled = false;
        }
        const mockMonStatus = document.querySelector('#mock-sap-monitoring-status');
        if (mockMonStatus && !state.mockSapMonitoring) {
          mockMonStatus.textContent = 'Shared extraction run completed; records are ready for an explicit monitoring run.';
        }
      }
    } catch (err) {
      recordExtractionRun({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        sourceId: 'CAP-HANA-CDS',
        sourceName: 'Autonomous Credit Monitoring Scheduler',
        status: 'FAILED',
        error: err.message,
        triggeredBy: 'MANUAL'
      });
      if (schedMsgEl) {
        schedMsgEl.textContent = `Autonomous cycle failed: ${err.message}`;
        schedMsgEl.className = 'form-message error';
      }
    } finally {
      schedulerCycleInFlight = false;
      triggerSchedBtn.disabled = false;
      triggerSchedBtn.textContent = 'Run Cycle Now';
    }
  });
}

function attachConnectorEvents(container) {
  const refreshBtn = container.querySelector('#refresh-connectors-btn');
  const connMsgEl = container.querySelector('#connectors-action-message');
  const fileInput = container.querySelector('#structured-file-input');
  const selectedLabel = container.querySelector('#selected-file-label');
  const discoverBtn = container.querySelector('#discover-schema-btn');
  const confirmBtn = container.querySelector('#confirm-sync-btn');
  const messageEl = container.querySelector('#connector-sync-message');

  let uploadedFileContent = null;
  let uploadedFilename = '';

  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const origText = refreshBtn.textContent || 'Refresh connectors';
    refreshBtn.textContent = 'Refreshing…';
    if (connMsgEl) {
      connMsgEl.textContent = 'Refreshing connector registry…';
      connMsgEl.className = 'form-message';
    }
    try {
      await loadConnectorsList(container);
      const count = state.v2Connectors?.sources?.length ?? 0;
      if (connMsgEl) {
        connMsgEl.textContent = `Connector registry refreshed (${count} registered sources as of ${new Date().toLocaleTimeString()}).`;
        connMsgEl.className = 'form-message success';
      }
    } catch (err) {
      if (connMsgEl) {
        connMsgEl.textContent = `Failed to refresh connectors: ${err.message}`;
        connMsgEl.className = 'form-message error';
      }
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = origText;
    }
  });

  fileInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadedFilename = file.name;
    selectedLabel.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    discoverBtn.removeAttribute('disabled');

    const reader = new FileReader();
    reader.onload = ev => {
      uploadedFileContent = ev.target?.result;
    };
    reader.readAsText(file);
  });

  discoverBtn?.addEventListener('click', async () => {
    if (!uploadedFileContent) return;
    messageEl.textContent = 'Profiling columns and proposing canonical schema mappings…';
    messageEl.className = 'form-message';
    try {
      const discovery = await discoverV2Schema({
        sourceId: 'FILE-CSV-JSON-UPLOAD',
        sourceType: 'FILE',
        filename: uploadedFilename,
        rawContent: uploadedFileContent
      });

      activeDiscoveredMappings = discovery.proposedMappings || [];
      activeDiscoveredSourceId = discovery.sourceId || 'FILE-CSV-JSON-UPLOAD';

      const resultsBox = container.querySelector('#schema-discovery-results');
      const primaryEntityEl = container.querySelector('#discovered-primary-entity');
      const metaText = container.querySelector('#discovery-meta-text');
      const mappingsTbody = container.querySelector('#proposed-mappings-body');

      primaryEntityEl.textContent = discovery.detectedPrimaryEntity || 'CG_BUSINESS_PARTNER';
      metaText.textContent = `Discovered ${discovery.headers?.length || 0} columns across ${discovery.rowCount || 0} rows. Proposed ${activeDiscoveredMappings.length} mappings into canonical tables with average confidence ${((activeDiscoveredMappings.reduce((acc, m) => acc + m.confidence, 0) / (activeDiscoveredMappings.length || 1)) * 100).toFixed(0)}%.`;

      mappingsTbody.innerHTML = activeDiscoveredMappings.map((m, idx) => `
        <tr>
          <td><code>${m.source_field}</code></td>
          <td class="muted">${(discovery.columnProfiles?.find(c => c.sourceField === m.source_field)?.sampleValues || []).slice(0, 2).join(', ')}</td>
          <td><strong>${m.canonical_entity}</strong></td>
          <td><code>${m.canonical_field}</code></td>
          <td><span class="pill neutral">${m.transform_rule}</span></td>
          <td><strong style="color: #0b8043;">${(m.confidence * 100).toFixed(0)}%</strong></td>
          <td><code>${m.sap_reference_table}.${m.sap_reference_field}</code></td>
          <td><small class="muted">${m.verification_note}</small></td>
        </tr>
      `).join('');

      resultsBox.style.display = 'block';
      messageEl.textContent = 'Schema discovery complete. Review proposed mappings above.';
      messageEl.className = 'form-message success';
    } catch (err) {
      messageEl.textContent = `Schema discovery failed: ${err.message}`;
      messageEl.className = 'form-message error';
    }
  });

  confirmBtn?.addEventListener('click', async () => {
    if (!activeDiscoveredMappings.length) return;
    messageEl.textContent = 'Ingesting raw rows into CG_RAW_PAYLOAD, transforming to Canonical, and computing snapshots…';
    messageEl.className = 'form-message';
    try {
      await confirmV2Mappings({
        sourceId: activeDiscoveredSourceId,
        mappings: activeDiscoveredMappings
      });

      const syncResult = await syncV2Connector({
        sourceId: activeDiscoveredSourceId,
        sourceType: 'FILE',
        filename: uploadedFilename,
        rawContent: uploadedFileContent,
        mappings: activeDiscoveredMappings
      });

      messageEl.innerHTML = `
        <strong>Sync Complete!</strong> Staged ${syncResult.counts.rawPayloadsSaved} raw records, upserted ${syncResult.counts.partnersUpserted} Business Partners, ${syncResult.counts.exposureItemsUpserted} exposure items, and recomputed ${syncResult.counts.snapshotsUpdated} deterministic snapshots.
      `;
      messageEl.className = 'form-message success';
      await loadConnectorsList(container);
    } catch (err) {
      messageEl.textContent = `Sync failed: ${err.message}`;
      messageEl.className = 'form-message error';
    }
  });

  container.addEventListener('click', async e => {
    const testBtn = e.target.closest('.test-conn-btn');
    if (testBtn) {
      const sourceId = testBtn.dataset.sourceId;
      const sourceType = testBtn.dataset.sourceType;
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      try {
        const res = await testV2Connector({ sourceId, sourceType });
        messageEl.textContent = `Connector Test Result [${sourceType}]: Connected: ${res.connected} | Mode: ${res.mode} | Message: ${res.message} | Latency: ${res.latencyMs}ms`;
        messageEl.className = 'form-message success';
      } catch (err) {
        messageEl.textContent = `Connector Test Failed: ${err.message}`;
        messageEl.className = 'form-message error';
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test';
      }
    }

    const syncBtn = e.target.closest('.sync-conn-btn');
    if (syncBtn) {
      const sourceId = syncBtn.dataset.sourceId;
      const sourceType = syncBtn.dataset.sourceType;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      try {
        const res = await syncV2Connector({ sourceId, sourceType });
        const finishedAt = new Date().toISOString();
        recordExtractionRun({
          runId: res.syncBatchId || `${sourceId}:${finishedAt}`,
          startedAt,
          finishedAt,
          durationMs: Date.now() - startMs,
          sourceId,
          sourceName: sourceId,
          status: 'COMPLETED',
          recordCounts: res.counts || null,
          triggeredBy: 'MANUAL'
        });
        updateConnectorSyncTimestamp(sourceId, finishedAt);
        messageEl.textContent = `Sync Successful! Batch: ${res.syncBatchId} | Partners: ${res.counts.partnersUpserted} | Exposure Items: ${res.counts.exposureItemsUpserted} | Snapshots: ${res.counts.snapshotsUpdated}`;
        messageEl.className = 'form-message success';
        await loadConnectorsList(container);
      } catch (err) {
        recordExtractionRun({
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          sourceId,
          sourceName: sourceId,
          status: 'FAILED',
          error: err.message,
          triggeredBy: 'MANUAL'
        });
        messageEl.textContent = `Sync Failed: ${err.message}`;
        messageEl.className = 'form-message error';
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
      }
    }
  });
}
