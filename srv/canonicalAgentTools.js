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

    default:
      throw new TypeError(`Unsupported canonical agent tool: ${toolName}`);
  }
}

function buildDeterministicNarrative({ portfolio, dossier, preview, connectorStatus }) {
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
    || (/\b(?:limit|increase|raise|propose|draft)\b/i.test(promptText)
      ? Number(promptText.match(/\b(\d{6,9})\b/)?.[1]) || null
      : null);

  let portfolio = null;
  let dossier = null;
  let preview = null;
  let connectorStatus = null;

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
    connectorStatus
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
