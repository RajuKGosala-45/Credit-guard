// ============================================================================
// PHASE 5: GEMINI AI CREDIT AGENT — CANONICAL FIN-FSCM-CR TOOL & BRIEFING SERVICE
// Working Rule 3: GEMINI_API_KEY is read strictly from server-side process.env.
// Working Rule 4: All financial numbers come exclusively from deterministic code
// (exposureCalculator / canonicalRepository). Gemini is used only for narrative
// explanation, risk summarization, and action recommendations.
// Working Rule 5: All SAP references carry verified: false and verificationNote.
// ============================================================================

const { createLlmProvider } = require('./llm');
const { getPublicDatabaseStatus } = require('./hanaConnection');
const { SAP_VERIFICATION_NOTE } = require('./canonicalSchemaMetadata');
const {
  getBusinessPartnerCreditDossier,
  getCanonicalPortfolioAnalytics,
  listDataSources,
  listFieldMappings
} = require('./canonicalRepository');
const { ensureDefaultEnterpriseSources } = require('./connectors/connectorRegistry');
const {
  listEnrichedCanonicalLimitRequests,
  previewCanonicalLimitChange
} = require('./limitWorkflowService');

const CANONICAL_AGENT_TOOLS = Object.freeze([
  {
    name: 'get_canonical_portfolio_exposure',
    description: 'Retrieve deterministic FIN-FSCM-CR portfolio exposure rollups by Country, Company Code, Credit Segment, Risk Class, Exposure Category (Open Orders, Open Deliveries, Open Billing, Open AR), and Ageing Buckets (0-30, 31-60, 61-90, 90+ days).',
    parameters: {
      type: 'object',
      properties: {
        countryCode: { type: 'string', description: 'Optional country filter (e.g., India, UAE, Singapore)' },
        companyCode: { type: 'string', description: 'Optional company code filter (e.g., BS01, BS02, BS03, BS04, BS05)' },
        thresholdStatus: { type: 'string', enum: ['NORMAL', 'WARNING', 'CRITICAL', 'BREACH', 'BLOCKED'] }
      }
    }
  },
  {
    name: 'get_business_partner_dossier',
    description: 'Retrieve complete deterministic FIN-FSCM-CR credit dossier for one Business Partner (BUT000 master, UKMBP_CMS_SGM credit limit, UKM_ITEM line items, ACDOCA/BSID open receivables, BSAD payment history, ageing buckets, and composite risk score).',
    parameters: {
      type: 'object',
      properties: {
        bpId: { type: 'string', description: 'Business Partner ID (e.g., C001..C013)' }
      },
      required: ['bpId']
    }
  },
  {
    name: 'preview_canonical_limit_change',
    description: 'Run a deterministic before/after simulation for a proposed credit limit change, returning projected utilization, threshold status, required approval authority (Credit Controller vs Finance Head), and SAP UKMBP_CMS_SGM target metadata.',
    parameters: {
      type: 'object',
      properties: {
        bpId: { type: 'string', description: 'Business Partner ID (e.g., C001)' },
        requestedLimit: { type: 'number', description: 'Proposed credit limit in segment currency' }
      },
      required: ['bpId', 'requestedLimit']
    }
  },
  {
    name: 'get_connector_and_mapping_status',
    description: 'Retrieve active enterprise data source connectors (FILE, SAP_ODATA, SAP_BTP_DEST, HANA, REST_API, MOCK_SAP), field mapping verification counts, and HANA/SQLite persistence status.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_autonomous_monitoring_status',
    description: 'Retrieve the real-time operational status, cycle interval, last run timestamp, run duration, and telemetry of the autonomous 5-minute continuous monitoring scheduler.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'trigger_autonomous_monitoring_cycle',
    description: 'Trigger an immediate autonomous data recalculation and monitoring execution cycle across all credit segments without waiting for the 5-minute timer.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force execution even if scheduled slot was already run' }
      }
    }
  },
  {
    name: 'evaluate_autonomous_credit_decision',
    description: 'Evaluate a Business Partner against the deterministic Autonomous Credit Policy (FIN-FSCM-AUTONOMOUS-POLICY-V1), returning AUTO_APPROVE, AUTO_REJECT, or ESCALATE_TO_HUMAN with policy rule IDs and evidence.',
    parameters: {
      type: 'object',
      properties: {
        bpId: { type: 'string', description: 'Business Partner ID (e.g., C001..C013)' },
        requestedLimit: { type: 'number', description: 'Optional proposed credit limit in segment currency' }
      },
      required: ['bpId']
    }
  },
  {
    name: 'execute_autonomous_policy_sweep',
    description: 'Scan the portfolio or pending limit requests using the Autonomous Credit Decision Engine to identify auto-approvable low-risk adjustments, auto-rejections, and human escalations.',
    parameters: {
      type: 'object',
      properties: {
        processPending: { type: 'boolean', description: 'If true, process pending limit requests in the approval queue' },
        autoCreateAndExecute: { type: 'boolean', description: 'If true, proactively create and execute governed workflows for flagged accounts' }
      }
    }
  }
]);

async function executeCanonicalAgentTool(db, toolName, args = {}) {
  switch (toolName) {
    case 'get_canonical_portfolio_exposure':
      return getCanonicalPortfolioAnalytics(db, {
        countryCode: args.countryCode || null,
        companyCode: args.companyCode || null,
        thresholdStatus: args.thresholdStatus || null,
        referenceDate: args.referenceDate || '2026-11-09'
      });

    case 'get_business_partner_dossier': {
      const bpId = String(args.bpId || args.customerId || args.customer_id || 'C001').trim();
      return getBusinessPartnerCreditDossier(db, bpId, {
        referenceDate: args.referenceDate || '2026-11-09'
      });
    }

    case 'preview_canonical_limit_change': {
      const bpId = String(args.bpId || args.customerId || args.customer_id || 'C001').trim();
      const requestedLimit = Number(args.requestedLimit || args.new_limit || 1500000);
      return previewCanonicalLimitChange(db, {
        bpId,
        requestedLimit,
        referenceDate: args.referenceDate || '2026-11-09'
      });
    }

    case 'get_connector_and_mapping_status': {
      await ensureDefaultEnterpriseSources(db);
      const [sources, mappings, requests] = await Promise.all([
        listDataSources(db),
        listFieldMappings(db),
        listEnrichedCanonicalLimitRequests(db)
      ]);
      return {
        database: getPublicDatabaseStatus(process.env),
        sapVerificationDefault: false,
        sapVerificationNote: SAP_VERIFICATION_NOTE,
        sources,
        fieldMappingsCount: mappings.length,
        verifiedByUserCount: mappings.filter(m => m.verified_by_user).length,
        sapReferenceVerifiedCount: mappings.filter(m => m.sap_reference_verified).length,
        activeWorkflowRequestsCount: requests.length
      };
    }

    case 'get_autonomous_monitoring_status': {
      const { getAutonomousSchedulerInstance } = require('./autonomousScheduler');
      const instance = getAutonomousSchedulerInstance();
      return instance ? instance.getStatus() : { status: 'STANDBY', message: 'Autonomous monitoring scheduler is not active.' };
    }

    case 'trigger_autonomous_monitoring_cycle': {
      const { getAutonomousSchedulerInstance } = require('./autonomousScheduler');
      const instance = getAutonomousSchedulerInstance();
      if (!instance) {
        return { status: 'SKIPPED', message: 'Autonomous monitoring scheduler is not active.' };
      }
      return instance.executeCycle({ force: args.force !== false, triggeredBy: 'AI_AGENT' });
    }

    case 'evaluate_autonomous_credit_decision': {
      const { evaluateCustomerAutonomousDecision } = require('./autonomousDecisionEngine');
      const bpId = String(args.bpId || args.customerId || args.customer_id || 'C001').trim();
      return evaluateCustomerAutonomousDecision(db, bpId, {
        requestedLimit: args.requestedLimit,
        referenceDate: args.referenceDate || '2026-11-09'
      });
    }

    case 'execute_autonomous_policy_sweep': {
      const {
        evaluatePortfolioAutonomousActions,
        processPendingRequestsAutonomously
      } = require('./autonomousDecisionEngine');
      if (args.processPending) {
        return processPendingRequestsAutonomously(db, {
          referenceDate: args.referenceDate || '2026-11-09'
        });
      }
      return evaluatePortfolioAutonomousActions(db, {
        referenceDate: args.referenceDate || '2026-11-09',
        autoCreateAndExecute: Boolean(args.autoCreateAndExecute)
      });
    }

    default:
      throw new TypeError(`Unsupported canonical agent tool: ${toolName}`);
  }
}

function buildDeterministicNarrative({
  portfolio,
  dossier,
  preview,
  connectorStatus,
  schedulerStatus,
  cycleOutcome,
  autonomousEvaluation,
  autonomousSweep
}) {
  const lines = [];
  if (dossier) {
    const snap = dossier.snapshot;
    const diag = dossier.diagnostics || {};
    lines.push(
      `### Business Partner Credit Dossier: ${dossier.partner.bp_name} (${dossier.partner.bp_id})`,
      `- **Company Code / Country**: ${dossier.partner.company_code} (${dossier.partner.country_code}) | **Credit Segment**: ${snap.credit_segment} | **Risk Class**: ${diag.risk_class || dossier.partner.risk_class}`,
      `- **Credit Limit**: ${Number(snap.credit_limit).toLocaleString('en-IN')} ${dossier.partner.currency} | **Total Exposure**: ${Number(snap.total_exposure).toLocaleString('en-IN')} ${dossier.partner.currency} | **Available Credit**: ${Number(snap.available_credit).toLocaleString('en-IN')} ${dossier.partner.currency}`,
      `- **Utilisation & Threshold Status**: **${Number(snap.utilization_pct).toFixed(2)}%** (**${snap.threshold_status}**) | **Composite Risk Score**: **${diag.composite_risk_score ?? 0}/100**`,
      `- **Exposure Breakdown**: Open Orders: ${Number(snap.open_orders_amount).toLocaleString('en-IN')}, Open Deliveries: ${Number(snap.open_deliveries_amount).toLocaleString('en-IN')}, Open Billing: ${Number(snap.open_billing_amount).toLocaleString('en-IN')}, Open AR: ${Number(snap.open_ar_amount).toLocaleString('en-IN')}`,
      `- **Overdue & Ageing Buckets**: Overdue Total: ${Number(snap.overdue_amount).toLocaleString('en-IN')} (${snap.overdue_count} items) | 0–30d: ${Number(snap.ageing_0_30).toLocaleString('en-IN')} | 31–60d: ${Number(snap.ageing_31_60).toLocaleString('en-IN')} | 61–90d: ${Number(snap.ageing_61_90).toLocaleString('en-IN')} | 90+d: ${Number(snap.ageing_90_plus).toLocaleString('en-IN')}`
    );
  }

  if (preview) {
    lines.push(
      `### Credit Limit Change Simulation (${preview.bp_name} — ${preview.bp_id})`,
      `- **Proposed Change**: ${Number(preview.current_limit).toLocaleString('en-IN')} → **${Number(preview.requested_limit).toLocaleString('en-IN')} ${preview.currency}** (${preview.delta_amount >= 0 ? '+' : ''}${preview.delta_pct}%)`,
      `- **Projected Utilisation**: ${preview.current_utilization_pct}% (${preview.current_threshold_status}) → **${preview.projected_utilization_pct}% (${preview.projected_threshold_status})**`,
      `- **Approval Routing**: Routed to **${preview.approver_level}** | **SAP Target**: \`${preview.sap_target.table}.${preview.sap_target.field}\` (\`verified: false\` — ${preview.sap_target.verificationNote})`
    );
  }

  if (portfolio && !dossier) {
    const s = portfolio.summary;
    lines.push(
      `### FIN-FSCM-CR Portfolio Exposure Summary (${s.customersMonitored} Business Partners)`,
      `- **Total Exposure**: ${Number(s.totalExposure).toLocaleString('en-IN')} INR | **Total Credit Limit**: ${Number(s.totalCreditLimit).toLocaleString('en-IN')} INR | **Overall Utilisation**: **${s.overallUtilizationPct}%**`,
      `- **Threshold Distribution**: Breached (>100%): **${s.statusCounts.BREACH}** | Critical (95–100%): **${s.statusCounts.CRITICAL}** | Warning (80–94.9%): **${s.statusCounts.WARNING}** | Normal (<80%): **${s.statusCounts.NORMAL}**`,
      `- **Exposure by Country**: ${portfolio.byCountry.map(c => `${c.countryCode}: ${Number(c.totalExposure).toLocaleString('en-IN')} (${c.utilizationPct}%)`).join(' · ')}`,
      `- **Exposure by Company Code**: ${portfolio.byCompanyCode.map(c => `${c.companyCode}: ${Number(c.totalExposure).toLocaleString('en-IN')} (${c.utilizationPct}%)`).join(' · ')}`
    );
  }

  if (connectorStatus && !dossier && !preview && !portfolio) {
    lines.push(
      `### Enterprise Data Sources & Persistence Status`,
      `- **Database Mode**: ${connectorStatus.database.mode} (${connectorStatus.database.driver})`,
      `- **Registered Connectors**: ${connectorStatus.sources.length} (${connectorStatus.sources.map(s => `${s.source_id} [${s.source_type}]`).join(', ')})`,
      `- **Field Mappings**: ${connectorStatus.fieldMappingsCount} total (${connectorStatus.verifiedByUserCount} user-confirmed; SAP reference default \`verified: false\` — ${connectorStatus.sapVerificationNote})`
    );
  }

  if (schedulerStatus && !dossier && !preview && !portfolio) {
    lines.push(
      `### Autonomous Credit Monitoring Scheduler Status`,
      `- **Operational Status**: **${schedulerStatus.status}** | **Cycle Interval**: ${schedulerStatus.intervalMinutes} min (${schedulerStatus.intervalMs} ms)`,
      `- **Run History**: Total: ${schedulerStatus.totalRuns} · Succeeded: ${schedulerStatus.successfulRuns} · Failed: ${schedulerStatus.failedRuns} · Skipped: ${schedulerStatus.skippedRuns}`,
      `- **Timestamps**: Last run: ${schedulerStatus.lastRunAt || 'None yet'} | Next scheduled: ${schedulerStatus.nextRunAt || 'None scheduled'}`,
      `- **Last Run Status**: **${schedulerStatus.lastRunStatus}** (Duration: ${schedulerStatus.lastRunDurationMs} ms)`
    );
  }

  if (cycleOutcome && !dossier && !preview && !portfolio) {
    lines.push(
      `### Autonomous Monitoring Cycle Execution Result`,
      `- **Outcome**: **${cycleOutcome.status}** | **Slot Key**: \`${cycleOutcome.slotKey}\``,
      `- **Run ID**: \`${cycleOutcome.runId || 'N/A'}\` | **Duration**: ${cycleOutcome.durationMs} ms`,
      `- **Snapshots Recalculated**: ${cycleOutcome.snapshotCount ?? 'N/A'}`
    );
  }

  if (autonomousEvaluation) {
    const ev = autonomousEvaluation.evidence;
    lines.push(
      `### Policy-Governed Autonomous Decision (${autonomousEvaluation.bp_name} — ${autonomousEvaluation.bp_id})`,
      `- **Policy Outcome**: **${autonomousEvaluation.decision}** | **Policy Rule**: \`${autonomousEvaluation.matched_rule_id}\` (\`${autonomousEvaluation.policy_id}\`)`,
      `- **Target Limit Evaluation**: ${Number(ev.current_limit).toLocaleString('en-IN')} → **${Number(ev.requested_limit).toLocaleString('en-IN')} ${autonomousEvaluation.currency}** (${ev.delta_amount >= 0 ? '+' : ''}${ev.delta_pct}%)`,
      `- **Authority & Governance**: **${autonomousEvaluation.required_human_authority}**`,
      `- **Policy Explanation**: ${autonomousEvaluation.explanation}`
    );
  }

  if (autonomousSweep && !dossier) {
    if (autonomousSweep.recommendations) {
      lines.push(
        `### Autonomous Portfolio Policy Scan (${autonomousSweep.policy_id})`,
        `- **Scanned**: ${autonomousSweep.total_partners_scanned} Business Partners | **Flagged for Action**: ${autonomousSweep.flagged_partners_count}`,
        `- **Autonomous Breakdown**: Auto-Approvable: **${autonomousSweep.auto_approvable_count}** · Auto-Rejectable: **${autonomousSweep.auto_rejectable_count}** · Human Escalation: **${autonomousSweep.human_escalation_count}**`
      );
      for (const rec of autonomousSweep.recommendations.slice(0, 6)) {
        lines.push(
          `  - **${rec.bp_name} (${rec.bp_id})**: Limit ${Number(rec.current_limit).toLocaleString('en-IN')} → ${Number(rec.proposed_limit).toLocaleString('en-IN')} INR | Decision: **${rec.decision}** (\`${rec.matched_rule_id}\`) — ${rec.explanation}`
        );
      }
    } else {
      lines.push(
        `### Autonomous Pending Queue Sweep (${autonomousSweep.policy_id})`,
        `- **Requests Evaluated**: ${autonomousSweep.evaluated_count} | **Auto-Approved**: **${autonomousSweep.auto_approved_count}** | **Auto-Rejected**: **${autonomousSweep.auto_rejected_count}** | **Escalated to Human**: **${autonomousSweep.escalated_to_human_count}**`
      );
    }
  }

  return lines.join('\n');
}

async function runCanonicalAgentQuery(db, {
  question = '',
  bpId = null,
  requestedLimit = null
} = {}) {
  const promptText = String(question || '').trim();
  const executedTools = [];

  // Detect Business Partner ID in question (e.g., C001..C013) if not explicitly passed
  const bpMatch = bpId || promptText.match(/\b(C0(?:0[1-9]|1[0-3]))\b/i)?.[1]?.toUpperCase() || null;
  const limitMatch = requestedLimit
    || (/\b(?:limit|increase|raise|propose|draft|approve)\b/i.test(promptText)
      ? Number(promptText.match(/\b(\d{6,9})\b/)?.[1]) || null
      : null);

  let portfolio = null;
  let dossier = null;
  let preview = null;
  let connectorStatus = null;
  let schedulerStatus = null;
  let cycleOutcome = null;
  let autonomousEvaluation = null;
  let autonomousSweep = null;

  if (bpMatch) {
    dossier = await executeCanonicalAgentTool(db, 'get_business_partner_dossier', { bpId: bpMatch });
    executedTools.push({ tool: 'get_business_partner_dossier', args: { bpId: bpMatch } });
    if (limitMatch && limitMatch > 0) {
      preview = await executeCanonicalAgentTool(db, 'preview_canonical_limit_change', {
        bpId: bpMatch,
        requestedLimit: limitMatch
      });
      executedTools.push({
        tool: 'preview_canonical_limit_change',
        args: { bpId: bpMatch, requestedLimit: limitMatch }
      });
    }
    if (/\b(?:autonomous|auto-approve|policy|decision|should we approve|eligible)\b/i.test(promptText)) {
      autonomousEvaluation = await executeCanonicalAgentTool(db, 'evaluate_autonomous_credit_decision', {
        bpId: bpMatch,
        requestedLimit: limitMatch || undefined
      });
      executedTools.push({
        tool: 'evaluate_autonomous_credit_decision',
        args: { bpId: bpMatch, ...(limitMatch ? { requestedLimit: limitMatch } : {}) }
      });
    }
  } else if (/\b(?:policy|auto-approve|autonomous decision|which customers need a credit limit|recommend|actions should credit guard take)\b/i.test(promptText)) {
    const processPending = /\b(?:pending|queue|requests)\b/i.test(promptText);
    autonomousSweep = await executeCanonicalAgentTool(db, 'execute_autonomous_policy_sweep', {
      processPending
    });
    executedTools.push({
      tool: 'execute_autonomous_policy_sweep',
      args: { processPending }
    });
  } else if (/\b(?:trigger|run now|force run|execute monitoring)\b/i.test(promptText)
    && /\b(?:autonomous|scheduler|cycle|monitoring|cron)\b/i.test(promptText)) {
    cycleOutcome = await executeCanonicalAgentTool(db, 'trigger_autonomous_monitoring_cycle', { force: true });
    executedTools.push({ tool: 'trigger_autonomous_monitoring_cycle', args: { force: true } });
  } else if (/\b(?:autonomous|scheduler|heartbeat|cron|cadence|recurring)\b/i.test(promptText)) {
    schedulerStatus = await executeCanonicalAgentTool(db, 'get_autonomous_monitoring_status', {});
    executedTools.push({ tool: 'get_autonomous_monitoring_status', args: {} });
  } else if (/\b(?:connector|source|mapping|hana|odata|schema)\b/i.test(promptText)) {
    connectorStatus = await executeCanonicalAgentTool(db, 'get_connector_and_mapping_status', {});
    executedTools.push({ tool: 'get_connector_and_mapping_status', args: {} });
  } else {
    portfolio = await executeCanonicalAgentTool(db, 'get_canonical_portfolio_exposure', {});
    executedTools.push({ tool: 'get_canonical_portfolio_exposure', args: {} });
  }

  const deterministicBriefing = buildDeterministicNarrative({
    portfolio,
    dossier,
    preview,
    connectorStatus,
    schedulerStatus,
    cycleOutcome,
    autonomousEvaluation,
    autonomousSweep
  });

  // Invoke server-side Gemini LLM strictly for explanation & recommendations over the deterministic tool results
  let reply = deterministicBriefing;
  let provider = 'deterministic-fallback';
  let llmUsed = false;

  const llm = createLlmProvider();
  if (llm) {
    try {
      const response = await llm.sendMessage({
        system: [
          'You are the Credit Guard Enterprise AI Credit Analyst aligned with SAP S/4HANA Credit Management (FIN-FSCM-CR).',
          'CRITICAL RULE: Every financial figure (exposure, credit limit, utilization %, overdue amount, ageing buckets, risk score) MUST be quoted verbatim from the provided DETERMINISTIC_TOOL_RESULTS JSON.',
          'Never invent, recalculate, or alter any number. Note that SAP table/API references carry verified=false ("verify in SE11/SE16N or SAP Business Accelerator Hub").',
          'Provide a concise, executive analysis answering the user question and recommending concrete credit control or collections actions.'
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: `User Question: ${promptText || 'Provide an executive credit risk summary.'}\n\nDETERMINISTIC_TOOL_RESULTS:\n${JSON.stringify({
              portfolio: portfolio ? { summary: portfolio.summary, byCountry: portfolio.byCountry, byCompanyCode: portfolio.byCompanyCode, ageingBreakdown: portfolio.ageingBreakdown } : undefined,
              dossier: dossier ? { partner: dossier.partner, snapshot: dossier.snapshot, diagnostics: dossier.diagnostics } : undefined,
              preview: preview || undefined,
              connectorStatus: connectorStatus || undefined
            })}`
          }
        ],
        tools: []
      });
      const textBlock = (response?.content || []).find(b => b.type === 'text' && b.text?.trim());
      if (textBlock) {
        reply = textBlock.text.trim();
        provider = llm.name || 'gemini';
        llmUsed = true;
      }
    } catch {
      // Keep deterministic briefing if Gemini times out or is unavailable
    }
  }

  return {
    reply,
    deterministicBriefing,
    provider,
    llmUsed,
    executedTools,
    sapVerificationDefault: false,
    sapVerificationNote: SAP_VERIFICATION_NOTE,
    data: {
      portfolio,
      dossier,
      preview,
      connectorStatus
    }
  };
}

module.exports = {
  CANONICAL_AGENT_TOOLS,
  buildDeterministicNarrative,
  executeCanonicalAgentTool,
  runCanonicalAgentQuery
};
