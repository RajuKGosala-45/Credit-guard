import {
  getV2Connectors,
  testV2Connector,
  discoverV2Schema,
  confirmV2Mappings,
  syncV2Connector,
  getV2SchedulerStatus,
  triggerV2SchedulerCycle
} from '../api.js';

let activeDiscoveredMappings = [];
let activeDiscoveredSourceId = 'FILE-CSV-JSON-UPLOAD';

export async function renderConnectorsPanel(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="content-grid">
      <section class="card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">ENTERPRISE CONNECTORS &amp; SAP S/4HANA</p>
            <h2>Multi-Source Data Connectors</h2>
          </div>
          <button id="refresh-connectors-btn" class="button secondary" type="button">Refresh connectors</button>
        </div>
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

      <section class="card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">STRUCTURED ERP FILE CONNECTOR</p>
            <h2>Upload &amp; Auto-Discover Schema</h2>
          </div>
        </div>
        <p class="muted">
          Upload enterprise tabular exports (CSV, TSV, JSON, OData JSON, or XML). The schema discovery engine auto-detects column headers, infers data types, and proposes confidence-scored mappings into SAP FIN-FSCM-CR canonical entities.
        </p>
        <div class="file-upload-box">
          <label class="button secondary" style="cursor: pointer; display: inline-block;">
            Choose File (CSV, JSON, XML)
            <input id="structured-file-input" type="file" accept=".csv,.tsv,.json,.xml,text/csv,application/json,application/xml" style="display: none;">
          </label>
          <span id="selected-file-label" class="muted" style="margin-left: 1rem;">No file chosen</span>
          <button id="discover-schema-btn" class="button primary" type="button" disabled style="margin-left: 1rem;">Discover Schema &amp; Propose Mappings</button>
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
  `;

  attachConnectorEvents(container);
  await loadConnectorsList(container);
}

export async function renderDataSourcesPanel(container) {
  return renderConnectorsPanel(container);
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
  if (!tbody || !kpiGrid) return;
  try {
    const data = await getV2Connectors();
    const sources = data.sources || [];
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">Active Sources</span>
        <span class="kpi-value">${sources.filter(s => s.status === 'ACTIVE').length}</span>
        <span class="kpi-subtext">of ${sources.length} registered</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Field Mappings</span>
        <span class="kpi-value">${data.mappingsCount || 0}</span>
        <span class="kpi-subtext">in CG_FIELD_MAPPING</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">SAP Candidate Services</span>
        <span class="kpi-value">${(data.sapCandidateODataServices || []).length}</span>
        <span class="kpi-subtext">OData &amp; CDS views</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">HANA Tables</span>
        <span class="kpi-value">${(data.hanaReplicatedTables || []).length}</span>
        <span class="kpi-subtext">Replicated tables</span>
      </div>
    `;

    tbody.innerHTML = sources.map(s => `
      <tr>
        <td><code>${s.source_id}</code></td>
        <td><strong>${s.source_name}</strong></td>
        <td><span class="pill ${s.source_type === 'FILE' ? 'primary' : 'warning'}">${s.source_type}</span></td>
        <td><code>${s.connection_config_ref}</code></td>
        <td><span class="pill ${s.status === 'ACTIVE' ? 'success' : 'neutral'}">${s.status}</span></td>
        <td>${s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : 'Never'}</td>
        <td>
          <button class="button secondary test-conn-btn" data-source-id="${s.source_id}" data-source-type="${s.source_type}" type="button" style="padding: 0.25rem 0.6rem; font-size: 0.85rem;">Test</button>
          <button class="button secondary sync-conn-btn" data-source-id="${s.source_id}" data-source-type="${s.source_type}" type="button" style="padding: 0.25rem 0.6rem; font-size: 0.85rem;">Sync</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="form-message error">${err.message || 'Failed to load connectors.'}</td></tr>`;
  }
}

export async function loadSchedulerStatus(container = document) {
  const grid = container.querySelector('#scheduler-status-grid');
  if (!grid) return;
  try {
    const sched = await getV2SchedulerStatus();
    const isRunning = sched.status === 'RUNNING';
    grid.innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">Daemon Status</span>
        <span class="kpi-value"><span class="pill ${isRunning ? 'success' : 'warning'}">${sched.status || 'STANDBY'}</span></span>
        <span class="kpi-subtext">Interval: ${sched.intervalMinutes ?? 5} min (${sched.intervalMs ?? 300000} ms)</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Cycle Telemetry</span>
        <span class="kpi-value">${sched.successfulRuns ?? 0} / ${sched.totalRuns ?? 0}</span>
        <span class="kpi-subtext">Succeeded · ${sched.skippedRuns ?? 0} Skipped · ${sched.failedRuns ?? 0} Failed</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Last Execution</span>
        <span class="kpi-value" style="font-size: 1rem;">${sched.lastCompletedAt ? new Date(sched.lastCompletedAt).toLocaleTimeString() : 'Pending initial'}</span>
        <span class="kpi-subtext">Status: ${sched.lastRunStatus || 'NONE'} (${sched.lastRunDurationMs ?? 0} ms)</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Next Scheduled Run</span>
        <span class="kpi-value" style="font-size: 1rem;">${sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleTimeString() : '—'}</span>
        <span class="kpi-subtext">Slot Mutex Protected</span>
      </div>
    `;
  } catch (err) {
    grid.innerHTML = `<div class="kpi-card"><span class="kpi-label">Daemon Status</span><span class="kpi-subtext error">${err.message}</span></div>`;
  }
}

function attachSchedulerEvents(container) {
  const refreshSchedBtn = container.querySelector('#refresh-scheduler-btn');
  const triggerSchedBtn = container.querySelector('#trigger-scheduler-btn');
  const schedMsgEl = container.querySelector('#scheduler-action-message');

  refreshSchedBtn?.addEventListener('click', () => loadSchedulerStatus(container));

  triggerSchedBtn?.addEventListener('click', async () => {
    triggerSchedBtn.disabled = true;
    triggerSchedBtn.textContent = 'Executing Cycle…';
    if (schedMsgEl) {
      schedMsgEl.textContent = 'Running autonomous exposure recalculation and monitoring job…';
      schedMsgEl.className = 'form-message';
    }
    try {
      const outcome = await triggerV2SchedulerCycle(true);
      if (schedMsgEl) {
        schedMsgEl.textContent = `Cycle ${outcome.status}: Slot ${outcome.slotKey} | Run ID: ${outcome.runId || 'N/A'} | Snapshots Recalculated: ${outcome.snapshotCount ?? 0} | Duration: ${outcome.durationMs ?? 0} ms`;
        schedMsgEl.className = 'form-message success';
      }
      await loadSchedulerStatus(container);
    } catch (err) {
      if (schedMsgEl) {
        schedMsgEl.textContent = `Autonomous cycle failed: ${err.message}`;
        schedMsgEl.className = 'form-message error';
      }
    } finally {
      triggerSchedBtn.disabled = false;
      triggerSchedBtn.textContent = 'Run Cycle Now';
    }
  });
}

function attachConnectorEvents(container) {
  const refreshBtn = container.querySelector('#refresh-connectors-btn');
  const fileInput = container.querySelector('#structured-file-input');
  const selectedLabel = container.querySelector('#selected-file-label');
  const discoverBtn = container.querySelector('#discover-schema-btn');
  const confirmBtn = container.querySelector('#confirm-sync-btn');
  const messageEl = container.querySelector('#connector-sync-message');

  let uploadedFileContent = null;
  let uploadedFilename = '';

  refreshBtn?.addEventListener('click', () => loadConnectorsList(container));

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
      try {
        const res = await syncV2Connector({ sourceId, sourceType });
        messageEl.textContent = `Sync Successful! Batch: ${res.syncBatchId} | Partners: ${res.counts.partnersUpserted} | Exposure Items: ${res.counts.exposureItemsUpserted} | Snapshots: ${res.counts.snapshotsUpdated}`;
        messageEl.className = 'form-message success';
        await loadConnectorsList(container);
      } catch (err) {
        messageEl.textContent = `Sync Failed: ${err.message}`;
        messageEl.className = 'form-message error';
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
      }
    }
  });
}
