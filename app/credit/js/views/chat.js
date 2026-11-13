import { escapeHTML } from '../utils.js';
import { renderStructuredResponseDOM, createEl } from './blockRenderer.js';

const GEMINI_ROUTER_TIMEOUT_MS = 5000;
const GEMINI_TIMEOUT_MS = 20000;
const GEMINI_RETRY_DELAY_MS = 400;
const responseCache = new Map();

let lastRouterContext = null;
let cachedCsrfToken = null;
let customRouterAdapters = null;
let workspaceCtxMod = null;
let workspaceCtxLoadPromise = null;
let trackedLastViewedTab = 'overview';
let tabTrackerAttached = false;

const MAX_SESSION_EXTRACTION_RUNS = 50;
const sessionExtractionRuns = [];

export function resetChatRouterState() {
  lastRouterContext = null;
  responseCache.clear();
  cachedCsrfToken = null;
  sessionExtractionRuns.length = 0;
  trackedLastViewedTab = 'overview';
}

export function setGeminiRouterAdapters(adapters = null) {
  customRouterAdapters = adapters;
}

export function setWorkspaceContextModule(mod = null) {
  workspaceCtxMod = mod;
}

function getWorkspaceCtx() {
  return workspaceCtxMod || (typeof globalThis !== 'undefined' ? globalThis.__CG_WORKSPACE_CONTEXT__ : null);
}

async function ensureWorkspaceContextLoaded() {
  if (getWorkspaceCtx()) return getWorkspaceCtx();
  if (!workspaceCtxLoadPromise && typeof import.meta?.url === 'string' && !import.meta.url.startsWith('data:')) {
    workspaceCtxLoadPromise = import('./workspaceContext.js')
      .then(m => {
        workspaceCtxMod = m.default || m;
        return workspaceCtxMod;
      })
      .catch(() => null);
  }
  if (workspaceCtxLoadPromise) {
    return await workspaceCtxLoadPromise;
  }
  return getWorkspaceCtx();
}

if (typeof import.meta?.url === 'string' && !import.meta.url.startsWith('data:')) {
  ensureWorkspaceContextLoaded();
}

function attachTabTrackerIfNeeded(state) {
  if (tabTrackerAttached || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  tabTrackerAttached = true;
  document.addEventListener('click', event => {
    const tabBtn = event.target?.closest?.('[data-tab]');
    const t = tabBtn?.dataset?.tab || tabBtn?.getAttribute?.('data-tab');
    if (t && t !== 'chat' && t !== 'home') {
      trackedLastViewedTab = t;
      if (state && typeof state === 'object') {
        state.lastViewed = t;
      }
    }
  });
}

export function recordSessionExtractionSnapshot(state) {
  if (!state || typeof state !== 'object') return;
  const ts = state.retrievedAt || state.lastSuccessfulAt || state.portfolioData?.retrievedAt;
  if (!ts) return;
  const status = String(state.extractionStatus || 'SUCCESS').toUpperCase();
  const source = state.portfolioData?.source || 'CAP database (demo)';
  const key = `${ts}::${status}::${source}`;
  if (sessionExtractionRuns.some(item => item._key === key)) return;
  const customersCount = Array.isArray(state.portfolioData?.customers)
    ? state.portfolioData.customers.length
    : (Array.isArray(state.customers) ? state.customers.length : null);
  sessionExtractionRuns.unshift({
    _key: key,
    runTime: ts,
    source,
    status: status === 'FAILED' ? 'FAILED' : 'COMPLETED',
    durationMs: null,
    recordCount: customersCount,
    error: state.lastError || null,
    origin: 'session'
  });
  if (sessionExtractionRuns.length > MAX_SESSION_EXTRACTION_RUNS) {
    sessionExtractionRuns.length = MAX_SESSION_EXTRACTION_RUNS;
  }
}

const TYPO_EXACT_MAP = Object.freeze({
  thier: 'their',
  teh: 'the',
  adn: 'and',
  customr: 'customer',
  customrs: 'customers',
  custmer: 'customer',
  custmers: 'customers',
  customres: 'customers',
  costumer: 'customer',
  costumers: 'customers',
  exposer: 'exposure',
  exposers: 'exposures',
  exposur: 'exposure',
  exposurs: 'exposures',
  utilzation: 'utilisation',
  utilisaton: 'utilisation',
  utlisation: 'utilisation',
  utilization: 'utilisation',
  utilisations: 'utilisation',
  overdu: 'overdue',
  ovrdue: 'overdue',
  invoic: 'invoice',
  invoics: 'invoices',
  invoces: 'invoices',
  limt: 'limit',
  limts: 'limits',
  credti: 'credit',
  crdit: 'credit',
  sourcs: 'sources',
  sorce: 'source',
  sorces: 'sources',
  sorceid: 'source id',
  conector: 'connector',
  conectors: 'connectors',
  connectivty: 'connectivity',
  conectivity: 'connectivity',
  entites: 'entities',
  entitites: 'entities',
  standy: 'standby',
  standbye: 'standby',
  critcal: 'critical',
  critial: 'critical',
  cntry: 'country',
  compny: 'company',
  monitring: 'monitoring',
  monitroing: 'monitoring',
  monitr: 'monitor',
  alrt: 'alert',
  alrts: 'alerts',
  aprov: 'approve',
  aprove: 'approve',
  aproval: 'approval',
  aprovals: 'approvals',
  approvls: 'approvals',
  sumarize: 'summarize',
  sumarise: 'summarise',
  summry: 'summary',
  overveiw: 'overview',
  overviw: 'overview',
  cl: 'credit limit',
  breakfst: 'breakfast',
  brekfast: 'breakfast',
  brkfst: 'breakfast',
  movi: 'movie',
  movis: 'movies',
  sugest: 'suggest',
  wether: 'weather',
  extracton: 'extraction',
  timline: 'timeline',
  timlines: 'timelines',
  timelines: 'timelines',
  refresd: 'refreshed'
});

const FUZZY_LEXICON = Object.freeze([
  'customer', 'customers', 'their', 'exposure', 'exposures', 'utilisation',
  'credit', 'limit', 'limits', 'overdue', 'invoice', 'invoices', 'country',
  'company', 'source', 'sources', 'connector', 'connectors', 'connectivity',
  'status', 'freshness', 'monitoring', 'alert', 'alerts', 'finding', 'findings',
  'approval', 'approvals', 'approve', 'pending', 'request', 'requests', 'requested',
  'requester', 'draft', 'policy', 'formula', 'threshold', 'thresholds', 'audit',
  'history', 'recommend', 'evaluate', 'analysis', 'summary', 'summarize', 'portfolio',
  'breach', 'breached', 'warning', 'active', 'standby', 'critical', 'overview',
  'entity', 'entities', 'connect', 'ready', 'india', 'singapore', 'breakfast',
  'lunch', 'dinner', 'movie', 'movies', 'suggest', 'weather', 'cricket', 'football',
  'recipe', 'joke', 'vacation', 'travel', 'extraction', 'timeline', 'timelines',
  'refresh', 'refreshed', 'ingestion', 'without', 'excluding', 'except',
  'headroom', 'highest', 'lowest', 'recent', 'where', 'changed', 'screen', 'looking',
  'scheduler', 'daemon', 'mapping', 'mappings', 'synced', 'mock'
]);

export function levenshteinDistance(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (s1 === s2) return 0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;
  const prev = Array.from({ length: len2 + 1 }, (_, j) => j);
  const curr = new Array(len2 + 1);
  for (let i = 1; i <= len1; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= len2; j += 1) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= len2; j += 1) prev[j] = curr[j];
  }
  return prev[len2];
}

export function normalizeQueryWithTypoTolerance(rawText) {
  const raw = String(rawText || '').trim().toLowerCase();
  if (!raw) return { normalizedText: '', tokens: [] };
  const rawTokens = raw
    .replace(/['’]s\b/gi, 's')
    .replace(/[^\w\s%₹.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const tokens = rawTokens.flatMap(tok => {
    if (TYPO_EXACT_MAP[tok]) return TYPO_EXACT_MAP[tok].split(' ');
    if (/^\d/.test(tok) || /^(?:ms-)?c\d{3}$/i.test(tok) || /^bs0\d$/i.test(tok) || tok.length < 4) {
      return [tok];
    }
    if (FUZZY_LEXICON.includes(tok)) return [tok];
    const maxDist = tok.length >= 8 ? 2 : 1;
    let bestWord = tok;
    let bestDist = maxDist + 1;
    for (const candidate of FUZZY_LEXICON) {
      if (Math.abs(candidate.length - tok.length) > maxDist) continue;
      if (candidate[0] !== tok[0] && maxDist === 1) continue;
      const dist = levenshteinDistance(tok, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
        if (dist === 1) break;
      }
    }
    return [bestDist <= maxDist ? bestWord : tok];
  });

  return {
    normalizedText: tokens.join(' '),
    tokens
  };
}

export function normalizeCountryCode(rawCountry) {
  const raw = String(rawCountry || '').trim();
  if (!raw) return 'Unspecified';
  const upper = raw.toUpperCase();
  if (upper === 'IN' || upper === 'IND' || upper === 'INDIA' || upper === 'INDIAN') return 'India';
  if (upper === 'AE' || upper === 'ARE' || upper === 'UAE' || upper === 'UNITED ARAB EMIRATES' || upper === 'DUBAI') return 'UAE';
  if (upper === 'SG' || upper === 'SGP' || upper === 'SINGAPORE') return 'Singapore';
  if (upper === 'US' || upper === 'USA' || upper === 'UNITED STATES') return 'United States';
  if (upper === 'GB' || upper === 'GBR' || upper === 'UK' || upper === 'UNITED KINGDOM') return 'United Kingdom';
  if (upper === 'DE' || upper === 'DEU' || upper === 'GERMANY') return 'Germany';
  return raw;
}

export function selectCanonicalPortfolioCustomers(rawCustomers = [], { specificIds = [], includeInactive = false } = {}) {
  const list = Array.isArray(rawCustomers) ? rawCustomers : [];
  const requestedSet = new Set((specificIds || []).map(id => String(id || '').toUpperCase()));
  const hasCanonicalPortfolio = list.some(c => /^C\d{3}$/i.test(String(c?.ID || c?.customer_ID || '')));

  const deduped = new Map();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.ID || c.customer_ID || '').trim().toUpperCase();
    if (!id) continue;
    const isInactive = String(c.status || '').toUpperCase() === 'INACTIVE';
    if (isInactive && !includeInactive && !requestedSet.has(id)) continue;
    if (hasCanonicalPortfolio && /^MS-C\d+/i.test(id) && !requestedSet.has(id)) continue;
    if (!deduped.has(id)) {
      const exposure = Number(c.exposure || 0);
      const creditLimit = Number(c.creditLimit ?? c.limit ?? 0);
      const isNoLimit = creditLimit <= 0;
      const utilisationRatio = isNoLimit
        ? null
        : (typeof c.utilisation === 'number' && Number.isFinite(c.utilisation)
          ? (c.utilisation > 10 ? c.utilisation / 100 : c.utilisation)
          : exposure / creditLimit);
      const utilisationPct = utilisationRatio !== null ? Number((utilisationRatio * 100).toFixed(1)) : null;
      const overdueAmount = Number(c.overdueAmount || 0);
      const overdueInvoiceCount = Number(c.overdueInvoiceCount || 0);
      const status = String(c.status || (isNoLimit ? 'MANUAL_REVIEW' : utilisationPct >= 100 ? 'BREACH' : utilisationPct >= 80 ? 'WARNING' : 'OK')).toUpperCase();
      const rawFlags = Array.isArray(c.flags)
        ? c.flags
        : (typeof c.flags === 'string' && c.flags.trim() ? c.flags.split(',').map(s => s.trim()) : []);
      const flags = isNoLimit && !rawFlags.some(f => /no limit/i.test(f))
        ? ['No limit set', ...rawFlags]
        : rawFlags;

      deduped.set(id, {
        ...c,
        ID: id,
        name: c.name || c.customerName || id,
        country: normalizeCountryCode(c.country),
        companyCode: String(c.companyCode || c.company_code || '—').trim().toUpperCase(),
        creditLimit,
        exposure,
        availableCredit: isNoLimit ? 0 : (creditLimit - exposure),
        isNoLimit,
        utilisationRatio,
        utilisationPct,
        utilisationDisplay: isNoLimit ? 'N/A (no limit)' : `${utilisationPct.toFixed(1)}%`,
        overdueAmount,
        overdueInvoiceCount,
        status,
        riskClass: String(c.riskClass || c.CTLPC || 'Normal').trim(),
        flags,
        isInactive
      });
    }
  }
  return Array.from(deduped.values());
}

function normalizeQuestionKey(question) {
  return String(question || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCacheKey(question, state, contextObj = null, plan = null) {
  const retrievedAt = state?.retrievedAt || state?.portfolioData?.retrievedAt || state?.dashboard?.retrievedAt || 'default';
  const reqCount = Array.isArray(state?.requests) ? state.requests.length : (Array.isArray(state?.approvals) ? state.approvals.length : 0);
  const monTs = state?.monitoringData?.summary?.latestRun?.completedAt || state?.monitoringData?.alerts?.length || 0;
  const v2Len = Array.isArray(state?.v2Connectors?.sources) ? state.v2Connectors.sources.length : 0;
  const mappingsCount = Number(state?.v2Connectors?.mappingsCount ?? 15);
  const extLen = Array.isArray(state?.extractionRuns) ? state.extractionRuns.length : 0;
  const schedRuns = state?.schedulerStatus?.totalRuns ?? 0;
  const currentTab = String(state?.currentTab || 'chat').toLowerCase();
  const lastViewed = String(state?.lastViewed || trackedLastViewedTab || 'overview').toLowerCase();
  const storeVer = `${retrievedAt}::r${reqCount}::m${monTs}::v${v2Len}::mc${mappingsCount}::e${extLen}::s${schedRuns}::${currentTab}:${lastViewed}`;

  if (plan && (plan.intent || plan.entity)) {
    const normalizedPlan = {
      intent: plan.intent || plan.primary,
      entity: plan.entity || null,
      operation: plan.operation || null,
      groupBy: plan.groupBy || null,
      targetTab: plan.targetTab || null,
      entities: plan.entities || {},
      display: plan.display || {}
    };
    return `plan:${JSON.stringify(normalizedPlan)}::${storeVer}`;
  }
  const ctxKey = contextObj?.intent ? `${contextObj.intent}:${JSON.stringify(contextObj.entities || {})}` : 'none';
  return `${normalizeQuestionKey(question)}::${storeVer}::${ctxKey}`;
}

function extractColumnKeysFromSegment(segment) {
  const keys = [];
  let countryCodeAliasUsed = false;
  let working = ` ${String(segment || '').toLowerCase()} `;

  const pushUnique = key => {
    if (!keys.includes(key)) keys.push(key);
  };

  // Detect compound aliases first before stripping matched tokens so "country code" never turns into "country"
  if (/\bcountry\s+code\b/.test(working)) {
    countryCodeAliasUsed = true;
    working = working.replace(/\bcountry\s+code\b/g, ' ');
    if (/\bcountry\b/.test(working)) {
      pushUnique('country');
      working = working.replace(/\bcountries?\b/g, ' ');
    }
    pushUnique('companyCode');
  }

  const orderedPatterns = [
    ['customer', /\b(?:customer\s+names?|names?|customers?)\b/g],
    ['id', /\b(?:source\s+ids?|connector\s+ids?|data\s+source\s+ids?|customer\s+ids?|bp\s+ids?|request\s+ids?|run\s+ids?|ids?)\b/g],
    ['country', /\bcountries?\b/g],
    ['companyCode', /\b(?:company\s+codes?|company|entities?|bukrs)\b/g],
    ['creditLimit', /\b(?:credit\s+limits?|limits?)\b/g],
    ['exposure', /\b(?:exposures?|balances?)\b/g],
    ['availableCredit', /\b(?:available\s+headroom|available\s+credit|remaining\s+credit|headroom)\b/g],
    ['utilisation', /\b(?:utili[sz]ations?|util|usage)\b/g],
    ['overdue', /\b(?:overdue\s+amounts?|overdue\s+balance|past\s+due|arrears|overdue)\b/g],
    ['overdueInvoiceCount', /\b(?:overdue\s+invoices?|invoice\s+count)\b/g],
    ['riskClass', /\b(?:risk\s+class(?:es)?|risk)\b/g],
    ['severity', /\b(?:severity|criticality)\b/g],
    ['status', /\b(?:status|health|state|connectivity)\b/g],
    ['freshness', /\b(?:freshness|age)\b/g],
    ['lastRetrieved', /\b(?:last\s+retrieved|last\s+sync|synced\s+at)\b/g],
    ['requestedBy', /\b(?:requested\s+by|requester)\b/g],
    ['approverLevel', /\b(?:approver(?:\s+role|\s+level)?)\b/g],
    ['runTime', /\b(?:run\s+time|timestamp|started\s+at)\b/g],
    ['source', /\b(?:sources?|connectors?)\b/g],
    ['duration', /\b(?:duration|elapsed)\b/g],
    ['records', /\b(?:records?|record\s+count|customers?\s+processed)\b/g]
  ];

  const found = [];
  const baseText = String(segment || '').toLowerCase();
  const maskedText = baseText.replace(/\bcountry\s+code\b/g, ' __COUNTRY_CODE__ ');

  if (/\b__COUNTRY_CODE__\b/.test(maskedText)) {
    const idx = maskedText.indexOf('__COUNTRY_CODE__');
    found.push({ idx, key: 'companyCode' });
  }

  for (const [key, rx] of orderedPatterns) {
    const localRx = new RegExp(rx.source, 'g');
    let m;
    while ((m = localRx.exec(maskedText)) !== null) {
      found.push({ idx: m.index, key });
    }
  }

  found.sort((a, b) => a.idx - b.idx);
  for (const item of found) {
    pushUnique(item.key);
  }

  return { keys, countryCodeAliasUsed };
}

function parseDisplayPlanFromText(raw, normText, nowMs = Date.now()) {
  const include = [];
  const exclude = [];
  let columnMode = 'default';
  let countryCodeAliasUsed = false;

  // 1. Check exclusion modifiers: "without X", "excluding X", "except X"
  const excludeMatch = normText.match(/\b(?:without|excluding|except(?:\s+for)?|minus)\s+(.+?)(?=\s+(?:sorted\s+by|order\s+by|top\s+\d+|in\s+(?:india|uae|singapore)|last\s+\d+)|$)/i);
  if (excludeMatch) {
    const parsedEx = extractColumnKeysFromSegment(excludeMatch[1]);
    if (parsedEx.keys.length > 0) {
      exclude.push(...parsedEx.keys);
      columnMode = 'exclude';
      if (parsedEx.countryCodeAliasUsed) countryCodeAliasUsed = true;
    }
  }

  // 2. Check explicit "with only X" or "only name and exposure" or "customers only" / "just names"
  if (columnMode === 'default') {
    const withOnlyMatch = normText.match(/\b(?:with\s+only|only\s+show|only|just)\s+(.+?)(?=\s+(?:sorted\s+by|order\s+by|in\s+(?:india|uae|singapore)|top\s+\d+)|$)/i);
    if (withOnlyMatch && !/\b(?:only\s+(?:india|uae|singapore|breached|warning))\b/i.test(withOnlyMatch[0])) {
      const seg = withOnlyMatch[1].trim();
      const parsedOnly = extractColumnKeysFromSegment(seg);
      if (parsedOnly.keys.length > 0) {
        include.push(...parsedOnly.keys);
        columnMode = 'only';
        if (parsedOnly.countryCodeAliasUsed) countryCodeAliasUsed = true;
      }
    }
    if (columnMode === 'default' && /\b(?:customers\s+only|only\s+customers|just\s+names?|names?\s+only)\b/i.test(normText)) {
      include.push('customer', 'id');
      columnMode = 'only';
    }
  }

  // 3. Check inclusion modifiers: "along with X", "also show X", "with X"
  if (columnMode === 'default') {
    const includeMatch = normText.match(/\b(?:along\s+with|also\s+show|plus|including|with)\s+(.+?)(?=\s+(?:sorted\s+by|order\s+by|in\s+(?:india|uae|singapore)|top\s+\d+|last\s+\d+)|$)/i);
    if (includeMatch) {
      const seg = includeMatch[1].trim();
      const isGroupWisePhrase = /^(?:country|company(?:\s+code)?)[-\s]*wise\b/i.test(seg);
      const isFilterPhrase = /\b(?:no\s+(?:credit\s+)?limit|zero\s+limit|utili[sz]ation\s*(?:>=|>|<=|<|above|over|below|under|exceeding)?\s*\d+|overdue\s+invoices?)\b/i.test(seg)
        && !/\b(?:and|country|company|exposure|headroom|risk|status)\b/i.test(seg);
      if (!isFilterPhrase && !isGroupWisePhrase) {
        const parsedInc = extractColumnKeysFromSegment(seg);
        const filteredKeys = parsedInc.keys.filter(k => !(k === 'source' && /\bin\s+sources?\b/i.test(normText)));
        if (filteredKeys.length > 0) {
          include.push(...filteredKeys);
          columnMode = 'include';
          if (parsedInc.countryCodeAliasUsed) countryCodeAliasUsed = true;
        }
      }
    }
  }

  // 3b. Direct Source ID ask (e.g., "Show me SorceID" / "Show source id")
  if (columnMode === 'default' && /\b(?:source\s+ids?|connector\s+ids?|data\s+source\s+ids?)\b/i.test(normText)) {
    include.push('id');
    columnMode = 'include';
  }

  // 4. SortBy & SortDir
  let sortBy = null;
  let sortDir = null;
  if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+overdue|\bmost\s+overdue\b/i.test(normText)) sortBy = 'overdueAmount';
  else if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+utili[sz]ation|\bhighest\s+util/i.test(normText)) sortBy = 'utilisationPct';
  else if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+(?:credit\s+)?limit\b/i.test(normText)) sortBy = 'creditLimit';
  else if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+(?:available\s+)?headroom\b/i.test(normText)) sortBy = 'availableCredit';
  else if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+exposure\b|\btop\s+\d+\b.*\bby\s+exposure\b/i.test(normText)) sortBy = 'exposure';
  else if (/\b(?:sorted|sort|order|rank(?:ed)?)\s+by\s+name\b/i.test(normText)) sortBy = 'name';
  else if (/\b(?:top|bottom|highest|lowest)\b.*\bexposure\b/i.test(normText)) sortBy = 'exposure';
  else if (/\b(?:top|bottom|highest|lowest)\b.*\butili[sz]ation\b/i.test(normText)) sortBy = 'utilisationPct';
  else if (/\b(?:top|bottom|highest|lowest)\b.*\b(?:credit\s+)?limit\b/i.test(normText)) sortBy = 'creditLimit';

  if (/\b(?:lowest|smallest|asc|ascending|bottom)\b/i.test(normText)) sortDir = 'asc';
  else if (/\b(?:highest|largest|desc|descending|top)\b|sort(?:ed)?\s+by/i.test(normText)) {
    sortDir = sortBy === 'name' ? 'asc' : 'desc';
  }

  // 5. Limit ("top 3", "first 5", "last 5 runs", "lowest 3", "bottom 3")
  const limitMatch = normText.match(/\b(?:top|first|last|lowest|bottom|highest|smallest)\s+(\d{1,2})\b(?!\s*(?:hours?|days?|minutes?|mins?|%))/i);
  const limit = limitMatch ? Number(limitMatch[1]) : null;

  // 6. Format
  let format = 'table';
  if (/\bhow\s+many\b|\bcount\s+of\b|\btotal\s+number\s+of\b/i.test(normText)) format = 'count';
  else if (/\b(chart|graph|plot|visuali[sz]e)\b/i.test(normText)) format = 'chart';
  else if (/\bsummary\b|\bsummari[sz]e\b/i.test(normText) && !/\b(list|table|customers|runs|timeline)\b/i.test(normText)) format = 'summary';

  // 7. TimeRange ("last N hours/days", "last hour", "today", "recent")
  let timeRange = null;
  const nowIso = new Date(nowMs).toISOString();
  const relNumMatch = normText.match(/\blast\s+(\d+)\s+(hour|hours|hr|hrs|day|days|minute|minutes|min|mins)\b/i);
  if (relNumMatch) {
    const qty = Number(relNumMatch[1]);
    const unit = relNumMatch[2].toLowerCase();
    const mult = unit.startsWith('min') ? 60000 : unit.startsWith('h') ? 3600000 : 86400000;
    timeRange = { from: new Date(nowMs - qty * mult).toISOString(), to: nowIso };
  } else if (/\blast\s+hour\b/i.test(normText)) {
    timeRange = { from: new Date(nowMs - 3600000).toISOString(), to: nowIso };
  } else if (/\btoday\b/i.test(normText)) {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    timeRange = { from: d.toISOString(), to: nowIso };
  } else if (/\brecent\b/i.test(normText)) {
    timeRange = { from: new Date(nowMs - 86400000).toISOString(), to: nowIso };
  }

  return {
    columns: { include, exclude },
    columnMode,
    countryCodeAliasUsed,
    sortBy,
    sortDir,
    limit,
    format,
    timeRange
  };
}

function extractEntitiesFromText(raw, normText, customers = []) {
  const idMatches = [...raw.matchAll(/\b((?:MS-)?C\d{3})\b/gi)].map(m => m[1].toUpperCase());
  if (idMatches.length === 0 && customers.length > 0) {
    for (const c of customers) {
      const full = c.name.toLowerCase();
      const firstToken = full.split(/\s+/)[0];
      if (normText.includes(full) || (firstToken.length >= 4 && new RegExp(`\\b${firstToken}\\b`, 'i').test(normText))) {
        idMatches.push(c.ID);
        break;
      }
    }
  }

  let country = null;
  if (/\b(india|indian|ind)\b/i.test(normText)) country = 'India';
  else if (/\b(uae|dubai|emirates)\b/i.test(normText)) country = 'UAE';
  else if (/\b(singapore|sgp)\b/i.test(normText)) country = 'Singapore';
  else if (/\b(united states|usa)\b/i.test(normText)) country = 'United States';
  else if (/\b(united kingdom|uk|britain)\b/i.test(normText)) country = 'United Kingdom';
  else if (/\b(germany)\b/i.test(normText)) country = 'Germany';

  const coMatch = raw.match(/\b(BS0[1-5]|1000|2000|3000)\b/i);
  const companyCode = coMatch ? coMatch[1].toUpperCase() : null;

  const pctMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  const aboveNumMatch = !pctMatch ? normText.match(/\b(?:above|over|exceeding|greater than|at least|>=)\s+(\d+(?:\.\d+)?)\b/i) : null;
  const threshold = pctMatch ? Number(pctMatch[1]) : (aboveNumMatch ? Number(aboveNumMatch[1]) : null);

  const amountMatch = raw.match(/(?:to|by|of|₹|inr\s*)\s*([\d,]{4,}(?:\.\d+)?)/i);
  const requestedAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;

  const statuses = [];
  if (/\b(?:ready\s+to\s+connect|standby|offline)\b/i.test(normText)) statuses.push('STANDBY');
  if (/\b(?:active|connected|live|online)\b/i.test(normText)) statuses.push('ACTIVE');
  if (/\b(?:demo|simulated)\b/i.test(normText)) statuses.push('DEMO');
  if (/\bfailed\b/i.test(normText)) statuses.push('FAILED');
  if (/\bpending\b/i.test(normText)) statuses.push('Pending');
  if (/\bapproved\b/i.test(normText)) statuses.push('Approved');
  if (/\brejected\b/i.test(normText)) statuses.push('Rejected');

  let status = null;
  if (/\bbreach(?:ed)?\b/i.test(normText)) status = 'BREACH';
  else if (/\bwarning\b/i.test(normText)) status = 'WARNING';
  else if (/\b(?:healthy|ok)\b/i.test(normText)) status = 'OK';
  else if (/\bmanual\s+review\b/i.test(normText)) status = 'MANUAL_REVIEW';
  else if (statuses.length === 1) status = statuses[0];

  const severity = /\bcritical\b/i.test(normText)
    ? 'CRITICAL'
    : /\bwarning\b/i.test(normText) && /\balerts?\b/i.test(normText)
      ? 'WARNING'
      : null;

  const connectorFilter = /\b(?:sap|btp|hana)\b/i.test(normText) && /\b(?:sources?|connectors?|ids?)\b/i.test(normText)
    ? 'SAP_BTP_HANA'
    : null;

  const neverSynced = /\bnever[\s-]*synced\b|\bnot\s+(?:yet\s+)?synced\b|\bhaven'?t\s+synced\b|\bno\s+sync\s+yet\b/i.test(normText);

  let metric = null;
  if (/\boverdue\b/i.test(normText)) metric = 'overdue';
  else if (/\butili[sz]ation\b/i.test(normText)) metric = 'utilisation';
  else if (/\bcredit\s+limit\b|\blimit\b/i.test(normText)) metric = 'creditLimit';
  else if (/\bexposure\b/i.test(normText)) metric = 'exposure';

  return {
    customerIds: idMatches,
    customerId: idMatches[0] || null,
    country,
    companyCode,
    threshold,
    requestedAmount,
    status,
    statuses,
    severity,
    connectorFilter,
    neverSynced,
    metric
  };
}

const INTENT_HUMAN_LABELS = Object.freeze({
  CUSTOMER_COUNT: 'How many customers are in Credit Guard?',
  CUSTOMER_LIST: 'List customers along with credit limits and exposures',
  UTILISATION_LIST: 'Customers above 80% utilisation',
  HIGH_RISK_CUSTOMERS: 'Show high-risk and breached customers',
  CUSTOMERS_NO_LIMIT: 'Customers with no credit limit configured',
  CUSTOMER_EVALUATION: 'Evaluate customer C001 credit profile',
  LIMIT_REQUEST_DRAFT: 'Prepare a limit request for C001 to INR 1500000',
  LIMIT_INCREASE_RECOMMENDATION: 'Should we approve a limit increase for C001?',
  EXPOSURE_BY_COUNTRY: 'Credit limit with country wise',
  EXPOSURE_BY_COMPANY_CODE: 'Exposure by company code',
  PORTFOLIO_SUMMARY: 'Portfolio credit summary',
  CREDIT_OVERVIEW_SUMMARY: 'Summarize Credit Overview',
  OVERDUE_COLLECTIONS: 'Overdue invoices and collections priority',
  MONITORING_ALERTS: 'Which alerts are critical?',
  MONITORING_ANALYSIS: 'Show monitoring status',
  LIMIT_APPROVALS_STATUS: 'How many pending limit approvals?',
  DATA_SOURCES_STATUS: 'Show me all data sources and active, standby status',
  DATA_EXTRACTION_TIMELINE: 'Show me recent data extraction timelines',
  CDS_ENTITIES_LIST: 'Show CDS entities',
  POLICY_EXPLANATION: 'Explain the credit policy and utilisation formula',
  AUDIT_HISTORY: 'Show audit history for today',
  WORKSPACE_NAVIGATION: 'Where can I see country-wise exposure?',
  SCREEN_CONTEXT: 'What am I looking at?'
});

const INTENT_TO_ENTITY_DEFAULTS = Object.freeze({
  CUSTOMER_COUNT: { entity: 'customers', operation: 'COUNT', targetTab: 'analysis' },
  CUSTOMER_LIST: { entity: 'customers', operation: 'LIST', targetTab: 'analysis' },
  UTILISATION_LIST: { entity: 'customers', operation: 'LIST', targetTab: 'dashboard' },
  HIGH_RISK_CUSTOMERS: { entity: 'customers', operation: 'LIST', targetTab: 'dashboard' },
  CUSTOMERS_NO_LIMIT: { entity: 'customers', operation: 'LIST', targetTab: 'analysis' },
  CUSTOMER_EVALUATION: { entity: 'customers', operation: 'DETAIL', targetTab: 'analysis' },
  LIMIT_REQUEST_DRAFT: { entity: 'limit_requests', operation: 'EXPLAIN', targetTab: 'dashboard' },
  LIMIT_INCREASE_RECOMMENDATION: { entity: 'customers', operation: 'EXPLAIN', targetTab: 'approvals' },
  EXPOSURE_BY_COUNTRY: { entity: 'country_exposure', operation: 'GROUP_BY', groupBy: 'country', targetTab: 'analysis' },
  EXPOSURE_BY_COMPANY_CODE: { entity: 'company_code_exposure', operation: 'GROUP_BY', groupBy: 'companyCode', targetTab: 'analysis' },
  PORTFOLIO_SUMMARY: { entity: 'overview_kpis', operation: 'STATUS_SUMMARY', targetTab: 'overview' },
  CREDIT_OVERVIEW_SUMMARY: { entity: 'overview_kpis', operation: 'STATUS_SUMMARY', targetTab: 'overview' },
  OVERDUE_COLLECTIONS: { entity: 'customers', operation: 'LIST', targetTab: 'dashboard' },
  MONITORING_ALERTS: { entity: 'alerts', operation: 'LIST', targetTab: 'dashboard' },
  MONITORING_ANALYSIS: { entity: 'monitoring_runs', operation: 'STATUS_SUMMARY', targetTab: 'dashboard' },
  LIMIT_APPROVALS_STATUS: { entity: 'limit_requests', operation: 'LIST', targetTab: 'approvals' },
  DATA_SOURCES_STATUS: { entity: 'connectors', operation: 'LIST', targetTab: 'simulator' },
  DATA_EXTRACTION_TIMELINE: { entity: 'extraction_runs', operation: 'LIST', targetTab: 'simulator' },
  CDS_ENTITIES_LIST: { entity: 'cds_entities', operation: 'LIST', targetTab: 'simulator' },
  MOCK_SAP_STAGING: { entity: 'mock_sap_staging', operation: 'LIST', targetTab: 'simulator' },
  POLICY_EXPLANATION: { entity: 'overview_kpis', operation: 'EXPLAIN', targetTab: 'chat' },
  AUDIT_HISTORY: { entity: 'audit_runs', operation: 'LIST', targetTab: 'audit' },
  WORKSPACE_NAVIGATION: { entity: 'tab_navigation', operation: 'NAVIGATE', targetTab: 'analysis' },
  SCREEN_CONTEXT: { entity: 'screen_context', operation: 'EXPLAIN', targetTab: null }
});

function inferTargetTabFromText(normText) {
  if (/\b(?:country[-\s]*wise|company[-\s]*code|exposure\s+analysis|ar\s+portfolio|credit\s+limit.*country)\b/i.test(normText)) return 'analysis';
  if (/\b(?:limit\s+approvals?|pending\s+approvals?|approvals?|approve\s+limit)\b/i.test(normText)) return 'approvals';
  if (/\b(?:portfolio\s*&?\s*monitoring|monitoring|alerts?|findings?|request\s+limit\s+change|limit\s+change)\b/i.test(normText)) return 'dashboard';
  if (/\b(?:sap\s+btp|hana\s+cds|cds\s+entit|connectors?|data\s+sources?|extraction|scheduler)\b/i.test(normText)) return 'simulator';
  if (/\b(?:ai\s+audit\s+history|audit\s+history|agent\s+history|memory\s+status)\b/i.test(normText)) return 'audit';
  if (/\b(?:credit\s+overview|overview|health\s+verdict|attention\s+items?)\b/i.test(normText)) return 'overview';
  if (/\bexposure\b/i.test(normText)) return 'analysis';
  return 'overview';
}

function finalizeWorkspacePlan(plan, normText = '') {
  const intentName = plan.intent || plan.primary || 'CLARIFY';
  const mapped = INTENT_TO_ENTITY_DEFAULTS[intentName] || {};
  const entity = plan.entity || mapped.entity || null;
  let operation = plan.operation || mapped.operation || 'LIST';
  if (!plan.operation) {
    if (plan.display?.format === 'count' || /\b(?:how\s+many|count\s+of)\b/i.test(normText)) operation = 'COUNT';
    else if (/\bwhat\s+changed\b|\bcompare\b/i.test(normText)) operation = 'COMPARE';
    else if (/\bwho\s+requested\b|\blast\s+limit\s+change\b|\bwhich\s+source\s+failed\b|\bwhat\s+did\s+the\s+agent\s+do\s+last\b/i.test(normText)) operation = 'DETAIL';
    else if (Number.isInteger(plan.display?.limit) && plan.display.limit > 0) operation = 'TOP_N';
  }
  const groupBy = plan.groupBy !== undefined ? plan.groupBy : (mapped.groupBy || null);
  const targetTab = plan.targetTab !== undefined ? plan.targetTab : (mapped.targetTab || null);
  const display = plan.display || { columns: { include: [], exclude: [] }, columnMode: 'default', countryCodeAliasUsed: false, sortBy: null, sortDir: null, limit: null, format: 'table', timeRange: null };

  return {
    ...plan,
    entity,
    operation,
    groupBy,
    targetTab,
    filters: plan.entities || {},
    columns: display.columns || { include: [], exclude: [] },
    sortBy: display.sortBy || null,
    sortDir: display.sortDir || null,
    limit: display.limit || null,
    format: display.format || 'table',
    timeRange: display.timeRange || null
  };
}

function getClosestEntitySuggestions(normText) {
  const suggestions = [];
  if (/\b(?:source|sorce|connector|sap|btp|hana|cds)\b/i.test(normText)) {
    suggestions.push(INTENT_HUMAN_LABELS.DATA_SOURCES_STATUS, INTENT_HUMAN_LABELS.CDS_ENTITIES_LIST, INTENT_HUMAN_LABELS.DATA_EXTRACTION_TIMELINE);
  }
  if (/\b(?:approv|limit|request)\b/i.test(normText)) {
    suggestions.push(INTENT_HUMAN_LABELS.LIMIT_APPROVALS_STATUS, INTENT_HUMAN_LABELS.EXPOSURE_BY_COUNTRY, INTENT_HUMAN_LABELS.CUSTOMER_LIST);
  }
  if (/\b(?:alert|monitor|critical|warning|breach)\b/i.test(normText)) {
    suggestions.push(INTENT_HUMAN_LABELS.MONITORING_ALERTS, INTENT_HUMAN_LABELS.MONITORING_ANALYSIS, INTENT_HUMAN_LABELS.UTILISATION_LIST);
  }
  if (/\b(?:overview|kpi|summary|refresh)\b/i.test(normText)) {
    suggestions.push(INTENT_HUMAN_LABELS.CREDIT_OVERVIEW_SUMMARY, INTENT_HUMAN_LABELS.DATA_EXTRACTION_TIMELINE, INTENT_HUMAN_LABELS.WORKSPACE_NAVIGATION);
  }
  if (/\b(?:audit|agent|history|memory)\b/i.test(normText)) {
    suggestions.push(INTENT_HUMAN_LABELS.AUDIT_HISTORY, INTENT_HUMAN_LABELS.DATA_EXTRACTION_TIMELINE, INTENT_HUMAN_LABELS.CREDIT_OVERVIEW_SUMMARY);
  }
  const unique = Array.from(new Set(suggestions));
  const defaults = [
    INTENT_HUMAN_LABELS.CREDIT_OVERVIEW_SUMMARY,
    INTENT_HUMAN_LABELS.DATA_SOURCES_STATUS,
    INTENT_HUMAN_LABELS.LIMIT_APPROVALS_STATUS,
    INTENT_HUMAN_LABELS.EXPOSURE_BY_COUNTRY
  ];
  for (const d of defaults) {
    if (unique.length >= 3) break;
    if (!unique.includes(d)) unique.push(d);
  }
  return unique.slice(0, 3);
}

const FOLLOWUP_REUSABLE_INTENTS = new Set([
  'CUSTOMER_LIST',
  'UTILISATION_LIST',
  'HIGH_RISK_CUSTOMERS',
  'CUSTOMERS_NO_LIMIT',
  'OVERDUE_COLLECTIONS',
  'CUSTOMER_COUNT',
  'EXPOSURE_BY_COUNTRY',
  'EXPOSURE_BY_COMPANY_CODE',
  'DATA_SOURCES_STATUS',
  'MONITORING_ALERTS',
  'LIMIT_APPROVALS_STATUS'
]);

export function classifyClientIntent(question, state = {}, prevContext = null) {
  recordSessionExtractionSnapshot(state);
  const raw = String(question || '').trim();
  const emptyDisplay = { columns: { include: [], exclude: [] }, columnMode: 'default', countryCodeAliasUsed: false, sortBy: null, sortDir: null, limit: null, format: 'table', timeRange: null };

  if (!raw) {
    return finalizeWorkspacePlan({
      primary: 'CLARIFY',
      intent: 'CLARIFY',
      entity: null,
      operation: 'EXPLAIN',
      confidence: 0,
      entities: { customerIds: [], customerId: null, country: null, companyCode: null, threshold: null, status: null, statuses: [], severity: null, metric: null },
      display: emptyDisplay,
      alternatives: [
        INTENT_HUMAN_LABELS.CREDIT_OVERVIEW_SUMMARY,
        INTENT_HUMAN_LABELS.CUSTOMER_LIST,
        INTENT_HUMAN_LABELS.EXPOSURE_BY_COUNTRY
      ]
    });
  }

  const { normalizedText: norm } = normalizeQueryWithTypoTolerance(raw);
  const rawCustomers = state?.portfolioData?.customers || state?.customers || [];
  const customers = selectCanonicalPortfolioCustomers(rawCustomers);
  const entities = extractEntitiesFromText(raw, norm, customers);
  const display = parseDisplayPlanFromText(raw, norm);
  const activeContext = prevContext || state?._chatRouterContext || lastRouterContext;

  const hasCreditDomainSignal = /\b(credit|exposure|exposures|limit|limits|customer|customers|account|accounts|invoice|invoices|overdue|past\s*due|utili[sz]ation|risk|breach|breached|warning|sap|btp|hana|cds|portfolio|country|company|bs0\d|alert|alerts|monitoring|approval|approvals|policy|formula|audit|history|collections?|connector|connectors|connectivity|freshness|source|sources|extraction|timeline|timelines|refresh|refreshed|sync|synced|ingestion|overview|verdict|attention|findings?|standby|ready\s+to\s+connect|critical|memory|screen|tab|requester|requested|scheduler|daemon|mapping|mappings|odata|fscm|mock|c\d{3}|ms-c\d+|ms-ca\d+|msinv-\d+|mspay-\d+)\b/i.test(norm)
    || entities.customerIds.length > 0
    || Boolean(entities.country)
    || Boolean(entities.companyCode);

  const introducesDifferentTopic = /\b(extraction|timeline|timelines|refresh|refreshed|last\s+sync|ingestion|data\s+source|data\s+sources|connectivity|connector|connectors|cds\s+entit|overdue\s+invoices?|pending\s+approvals?|limit\s+approvals?|limit\s+change|monitoring\s+(?:alerts?|status|runs?)|audit\s+history|credit\s+overview|policy\s+rule|formula|exposure\s+by\s+(?:country|company)|country[-\s]*wise|how\s+many\s+customers?|what\s+can\s+you\s+do|where\s+can\s+i|what\s+am\s+i\s+looking\s+at|explain\s+this|help|scheduler|daemon|field\s+mappings?|odata|fscm|mock\s+sap|ms-c\d+)\b/i.test(norm);

  const isFreshFullCustomerPrompt = /\b(give\s+me|show\s+me|list(?:\s+out)?|get|display|find)\s+(?:all\s+)?(?:the\s+)?customers?\b/i.test(norm)
    || /\b(?:top|lowest|bottom|highest)\s+\d+\s+(?:customers?|utili[sz]ation)\b/i.test(norm)
    || /\bcustomers?\s+(?:only|without|excluding|except|along\s+with|with\s+only|above|over|in\s+(?:india|uae|singapore))\b/i.test(norm);

  // 1. Follow-up context handling ONLY when the new question genuinely refines the previous result
  const isFollowUpRefinement = Boolean(
    activeContext
    && FOLLOWUP_REUSABLE_INTENTS.has(activeContext.intent)
    && !introducesDifferentTopic
    && !isFreshFullCustomerPrompt
    && raw.split(/\s+/).length <= 8
    && (
      /^(?:and|what about|how about|filter|those|them)\b/i.test(norm)
      || /^(?:only\s+(?:india|uae|singapore|breached|warning|ok)|just\s+(?:india|uae|singapore))\b/i.test(norm)
      || (Boolean(entities.country) && !/\bexposure\b/i.test(norm))
      || (Boolean(entities.companyCode) && !/\bexposure\b/i.test(norm))
      || /^(?:please\s+)?(?:sort|order|rank)\s+by\b/i.test(norm)
      || /\b(only breached|breached ones|only warning|warning ones|those customers)\b/i.test(norm)
      || /^(?:please\s+)?(?:show|display)\s+(?:all|more)(?:\s+(?:rows|results|of\s+them))?$/i.test(norm)
    )
    && !/\b(hi|hello|bye|thanks|help)\b/i.test(norm)
  );

  if (isFollowUpRefinement) {
    const prevDisplay = activeContext.display || emptyDisplay;
    const mergedEntities = {
      ...(activeContext.entities || {}),
      ...(entities.country ? { country: entities.country } : {}),
      ...(entities.companyCode ? { companyCode: entities.companyCode } : {}),
      ...(entities.threshold !== null ? { threshold: entities.threshold } : {}),
      ...(entities.metric ? { metric: entities.metric } : {}),
      ...(entities.status ? { status: entities.status } : {})
    };
    if (/\b(only breached|breached ones)\b/i.test(norm)) {
      mergedEntities.status = 'BREACH';
    } else if (/\b(only warning|warning ones)\b/i.test(norm)) {
      mergedEntities.status = 'WARNING';
    }

    const mergedDisplay = {
      columns: display.columnMode !== 'default' ? display.columns : (prevDisplay.columns || { include: [], exclude: [] }),
      columnMode: display.columnMode !== 'default' ? display.columnMode : (prevDisplay.columnMode || 'default'),
      countryCodeAliasUsed: display.countryCodeAliasUsed || Boolean(prevDisplay.countryCodeAliasUsed),
      sortBy: display.sortBy || prevDisplay.sortBy || null,
      sortDir: display.sortDir || prevDisplay.sortDir || null,
      limit: display.limit || prevDisplay.limit || null,
      format: display.format !== 'table' ? display.format : (prevDisplay.format || 'table'),
      timeRange: display.timeRange || prevDisplay.timeRange || null
    };

    if (/\b(show all|show more)\b/i.test(norm)) {
      mergedDisplay.showAll = true;
      mergedDisplay.limit = null;
    }

    const filterParts = [];
    if (entities.country) filterParts.push(`Country = ${entities.country}`);
    if (entities.companyCode) filterParts.push(`Company Code = ${entities.companyCode}`);
    if (display.sortBy) filterParts.push(`Sorted by ${display.sortBy}`);
    if (mergedEntities.status && /\b(breached|warning)\b/i.test(norm)) filterParts.push(`Status = ${mergedEntities.status}`);
    if (mergedDisplay.showAll) filterParts.push('Showing all rows');

    return finalizeWorkspacePlan({
      primary: activeContext.intent,
      intent: activeContext.intent,
      confidence: 0.94,
      entities: mergedEntities,
      display: mergedDisplay,
      resolvedFromContext: true,
      contextNote: `Follow-up applied (${activeContext.intent.replace(/_/g, ' ').toLowerCase()}): ${filterParts.join(' · ') || 'refined view'}`
    }, norm);
  }

  // 2. Small talk & Help
  if (/^\s*(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|yo|namaste)[!.,?\s]*$/i.test(norm)
    || (/^\s*(hi|hello|hey|greetings|good\s+(morning|afternoon|evening))\b/i.test(norm) && norm.split(/\s+/).length <= 4 && !hasCreditDomainSignal)) {
    return finalizeWorkspacePlan({ primary: 'GREETING', intent: 'GREETING', entity: null, operation: 'EXPLAIN', confidence: 0.99, entities, display }, norm);
  }
  if (/^\s*(how are you|how r u|how are u|how is it going|how are things|whats up|what's up)[!.,?\s]*$/i.test(norm)) {
    return finalizeWorkspacePlan({ primary: 'HOW_ARE_YOU', intent: 'HOW_ARE_YOU', entity: null, operation: 'EXPLAIN', confidence: 0.99, entities, display }, norm);
  }
  if (/^\s*(thanks|thank you|thankyou|thx|cheers|appreciate it)[!.,?\s]*$/i.test(norm)) {
    return finalizeWorkspacePlan({ primary: 'THANKS', intent: 'THANKS', entity: null, operation: 'EXPLAIN', confidence: 0.99, entities, display }, norm);
  }
  if (/^\s*(bye|goodbye|see you|see ya|take care)[!.,?\s]*$/i.test(norm)) {
    return finalizeWorkspacePlan({ primary: 'GOODBYE', intent: 'GOODBYE', entity: null, operation: 'EXPLAIN', confidence: 0.99, entities, display }, norm);
  }
  if (/\b(what can you do|what do you do|how can you help|your capabilities|what should i ask|help me)\b/i.test(norm)
    || /^\s*help[!.,?\s]*$/i.test(norm)) {
    return finalizeWorkspacePlan({ primary: 'HELP', intent: 'HELP', entity: null, operation: 'EXPLAIN', confidence: 0.98, entities, display }, norm);
  }

  // 2b. Tab-Aware Navigation & Current Screen Context
  if (/\b(?:where\s+(?:can|do)\s+i\s+(?:see|find|view|check)|which\s+tab\s+(?:shows?|has|contains)|how\s+(?:do\s+i|to)\s+(?:open|go\s+to|find|navigate\s+to)|take\s+me\s+to|go\s+to)\b/i.test(norm)) {
    const targetTab = inferTargetTabFromText(norm);
    return finalizeWorkspacePlan({
      primary: 'WORKSPACE_NAVIGATION',
      intent: 'WORKSPACE_NAVIGATION',
      entity: 'tab_navigation',
      operation: 'NAVIGATE',
      targetTab,
      confidence: 0.96,
      entities,
      display: { ...display, format: 'summary' }
    }, norm);
  }

  if (/\b(?:what\s+am\s+i\s+looking\s+at|explain\s+this\s+(?:screen|tab|page)|summari[sz]e\s+this\s+(?:screen|tab|page)|what\s+is\s+on\s+this\s+(?:screen|tab))\b/i.test(norm)) {
    return finalizeWorkspacePlan({
      primary: 'SCREEN_CONTEXT',
      intent: 'SCREEN_CONTEXT',
      entity: 'screen_context',
      operation: 'EXPLAIN',
      targetTab: null,
      confidence: 0.96,
      entities,
      display: { ...display, format: 'summary' }
    }, norm);
  }

  if (/\b(?:what\s+is\s+on|whats\s+on|explain|summari[sz]e)\s+(?:the\s+)?(?:limit\s+approvals?)\s*(?:tab|screen|page)?\b/i.test(norm)) {
    return finalizeWorkspacePlan({
      primary: 'LIMIT_APPROVALS_STATUS',
      intent: 'LIMIT_APPROVALS_STATUS',
      entity: 'limit_requests',
      operation: 'STATUS_SUMMARY',
      targetTab: 'approvals',
      confidence: 0.97,
      entities,
      display
    }, norm);
  }

  if (/\b(?:what\s+is\s+on|whats\s+on|explain|summari[sz]e)\s+(?:the\s+)?(?:credit\s+overview)\s*(?:tab|screen|page)?\b/i.test(norm)
    || /\bwhat\s+changed\s+since\s+(?:the\s+)?last\s+refresh\b/i.test(norm)) {
    return finalizeWorkspacePlan({
      primary: 'CREDIT_OVERVIEW_SUMMARY',
      intent: 'CREDIT_OVERVIEW_SUMMARY',
      entity: 'overview_kpis',
      operation: /\bchanged\b/i.test(norm) ? 'COMPARE' : 'STATUS_SUMMARY',
      targetTab: 'overview',
      confidence: 0.97,
      entities,
      display: { ...display, format: 'summary' }
    }, norm);
  }

  // 3. Explicit Off-Topic detection (ONLY when zero registry/domain signal)
  const offTopicPattern = /\b(movie|movies|film|actor|actress|president|election|politics|weather|forecast|rain|sunny|football|soccer|cricket|nba|sport|sports|recipe|cook|baking|breakfast|lunch|dinner|eat|ate|hungry|coffee|tea|pizza|burger|music|song|capital of|joke|poem|holiday|vacation|hotel|flight)\b/i;
  if (offTopicPattern.test(norm) && !hasCreditDomainSignal) {
    return finalizeWorkspacePlan({ primary: 'OFF_TOPIC', intent: 'OFF_TOPIC', entity: null, operation: 'EXPLAIN', confidence: 0.98, entities, display }, norm);
  }

  // 4. Score-based local classifier across all supported workspace & domain intents
  const scores = {
    CUSTOMER_COUNT: 0,
    CUSTOMER_LIST: 0,
    UTILISATION_LIST: 0,
    HIGH_RISK_CUSTOMERS: 0,
    CUSTOMERS_NO_LIMIT: 0,
    CUSTOMER_EVALUATION: 0,
    LIMIT_REQUEST_DRAFT: 0,
    LIMIT_INCREASE_RECOMMENDATION: 0,
    EXPOSURE_BY_COUNTRY: 0,
    EXPOSURE_BY_COMPANY_CODE: 0,
    PORTFOLIO_SUMMARY: 0,
    CREDIT_OVERVIEW_SUMMARY: 0,
    OVERDUE_COLLECTIONS: 0,
    MONITORING_ALERTS: 0,
    MONITORING_ANALYSIS: 0,
    LIMIT_APPROVALS_STATUS: 0,
    DATA_SOURCES_STATUS: 0,
    DATA_EXTRACTION_TIMELINE: 0,
    CDS_ENTITIES_LIST: 0,
    MOCK_SAP_STAGING: 0,
    POLICY_EXPLANATION: 0,
    AUDIT_HISTORY: 0
  };

  if (entities.customerIds.some(id => /^MS-C\d+/i.test(id))
    || /\bmock[\s-]*sap\b|\bsynthetic\s+staging\b|\bmock\s+(?:customers?|invoices?|credit\s+accounts?|payments?)\b|\bms-ca\d+|\bmsinv-\d+|\bmspay-\d+/i.test(norm)) {
    scores.MOCK_SAP_STAGING += 20;
  }

  if (/\b(cds\s+entit(?:y|ies)|hana\s+(?:replicated\s+)?tables?|odata\s+services?|sap\s+candidate\s+(?:odata\s+)?services?|canonical\s+entit(?:y|ies)|schema\s+discovery|field\s+mappings?|fscm\s+integration)\b/i.test(norm)) {
    scores.CDS_ENTITIES_LIST += 14;
  }

  if (/\b(data\s+extraction|extraction\s+timeline|extraction\s+timelines|extraction\s+history|extraction\s+runs?|when\s+was\s+data\s+(?:last\s+)?refreshed|last\s+refresh|last\s+sync|ingestion\s+runs?|ingestion\s+history|scheduler\s+runs?)\b/i.test(norm)) {
    scores.DATA_EXTRACTION_TIMELINE += 14;
  }

  if (/\bhow many\b.*\b(customer|customers|account|accounts|clients)\b|\b(customer count|number of customers|total customers)\b/i.test(norm)
    && scores.MOCK_SAP_STAGING === 0) {
    scores.CUSTOMER_COUNT += 10;
  }

  if (/\b(list|show|get|display|all|give)\b.*\b(customer|customers|accounts)\b/i.test(norm)
    || /\bcustomers?\b.*\b(credit limit|limits|exposure|exposures|country|company code|without|only|along with|sorted|in\s+(?:india|uae|singapore|bs0\d)|sources|by\s+(?:exposure|credit\s+limit|limit|utilisation|overdue))\b/i.test(norm)
    || /\b(?:top|lowest|bottom|highest)\s+\d+\s+(?:customers?|utili[sz]ation)\b/i.test(norm)
    || (/\butili[sz]ation\b/i.test(norm) && /\b(?:lowest|bottom|highest)\b/i.test(norm) && !/\b(?:above|over|exceed(?:ing)?|>=|at least|below|under)\s+\d+/i.test(norm))) {
    scores.CUSTOMER_LIST += 12;
  }
  if (/\ball\s+customers\b/i.test(norm) && !/\b(above|over|below|under)\s+\d+/i.test(norm)) {
    scores.CUSTOMER_LIST += 3;
  }

  if (/\b(no credit limit|no limit|zero limit|without limit|unconfigured limit)\b/i.test(norm)) {
    scores.CUSTOMERS_NO_LIMIT += 11;
  }

  if (/\butili[sz]ation\b/i.test(norm) && (/\b(above|over|exceed|>=|at least|below|under)\b|\d+\s*%/i.test(norm))
    && !/\bsorted\s+by\s+utili[sz]ation\b/i.test(norm)) {
    scores.UTILISATION_LIST += 13;
  }
  if (/\b(above|over|exceeding)\s+\d+\s*%?/i.test(norm) && /\b(utili[sz]ation|limit|customers)\b/i.test(norm)) {
    scores.UTILISATION_LIST += 4;
  }

  if (/\b(high[-\s]*risk|risky|breached|breaching|critical|flagged)\b.*\b(customer|customers|account|accounts)\b|\bwhich customers are (?:risky|breached)\b/i.test(norm)) {
    scores.HIGH_RISK_CUSTOMERS += 9;
  }

  if (/\b(draft|prepare|create|submit)\b.*\b(limit request|limit change|credit limit)\b/i.test(norm)) {
    scores.LIMIT_REQUEST_DRAFT += 11;
  }

  if (/\b(should we approve|recommend|increase limit|limit increase|what if|simulate|simulation|approve limit)\b/i.test(norm)) {
    scores.LIMIT_INCREASE_RECOMMENDATION += 10;
  }

  if (entities.customerIds.length >= 1 && !/\b(all customers|list customers|exposure by)\b/i.test(norm) && scores.MOCK_SAP_STAGING === 0) {
    scores.CUSTOMER_EVALUATION += 8;
  }
  if (/\b(evaluate|details|profile|check|tell me about|status of|risk for)\b/i.test(norm) && entities.customerIds.length >= 1 && scores.MOCK_SAP_STAGING === 0) {
    scores.CUSTOMER_EVALUATION += 4;
  }

  if (/\b(?:exposure|portfolio|credit\s+limit|limits?)\b.*\b(?:by\s+country|country[-\s]*wise)\b|\bcountry[-\s]*wise\b|\bgeographic\s+exposure\b/i.test(norm)) {
    scores.EXPOSURE_BY_COUNTRY += 13;
  }
  if (/\b(?:exposure|portfolio|credit\s+limit|limits?)\b.*\b(?:by\s+(?:company\s*code|entity|bukrs)|company[-\s]*code[-\s]*wise)\b|\bcompany[-\s]*code\b/i.test(norm)
    && !/\bcustomers?\b.*\b(without|along with|only)\b/i.test(norm)) {
    scores.EXPOSURE_BY_COMPANY_CODE += 12;
  }

  if (/\b(credit overview|health verdict|attention items?)\b/i.test(norm) && !/\bby\s+(?:country|company)\b/i.test(norm)) {
    scores.CREDIT_OVERVIEW_SUMMARY += 12;
  }
  if (/\b(portfolio summary|total exposure|overall exposure|portfolio health|overall utilisation)\b/i.test(norm)
    && !/\bby\s+(?:country|company)\b/i.test(norm)) {
    scores.PORTFOLIO_SUMMARY += 9;
  }

  if (/\b(overdue|past\s*due|delinquent|unpaid|aging|ageing|collections?|dunning)\b/i.test(norm)
    && entities.customerIds.length === 0 && scores.MOCK_SAP_STAGING === 0) {
    scores.OVERDUE_COLLECTIONS += 10;
  }

  if (/\b(active alerts|monitoring alerts|alert events|alerts?)\b/i.test(norm)) {
    scores.MONITORING_ALERTS += 12;
  }
  if (/\b(monitoring run|monitoring status|monitoring summary|when did monitoring last run|findings?|analyze the latest monitoring)\b/i.test(norm)) {
    scores.MONITORING_ANALYSIS += 12;
  }

  if (/\b(pending approvals?|pending limit approvals?|limit approvals?|limit requests?|approval status|pending requests?|who requested.*limit|last limit change)\b/i.test(norm)) {
    scores.LIMIT_APPROVALS_STATUS += 13;
  }

  if (/\b(data source|data sources|connectivity|connector|connectors|sync status|freshness|sap btp|hana cds|source ids?|ready to connect|standby|which source failed|scheduler(?:\s+daemon)?|daemon(?:\s+status)?|autonomous\s+(?:scheduler|daemon)|next\s+cycle|last\s+cycle|never\s+synced|mock-s4-001|mock-sap-fin-fscm)\b/i.test(norm)
    && scores.DATA_EXTRACTION_TIMELINE < 10 && scores.CDS_ENTITIES_LIST < 10 && scores.MOCK_SAP_STAGING < 10) {
    const isCustomerQueryWithSourcesSuffix = scores.CUSTOMER_LIST >= 8 && !/\b(?:source ids?|ready to connect|standby|sap btp|hana|never\s+synced|scheduler|daemon|mock-s4-001|mock-sap-fin-fscm)\b/i.test(norm);
    scores.DATA_SOURCES_STATUS += isCustomerQueryWithSourcesSuffix ? 2 : 13;
  }
  if (entities.neverSynced && scores.MOCK_SAP_STAGING === 0) {
    scores.DATA_SOURCES_STATUS += 14;
  }
  if (/\b(all customers|list customers|customers and their exposures)\b/i.test(norm) && /\bsources?\b/i.test(norm)) {
    scores.CUSTOMER_LIST += 4;
    entities.includeSourceInfo = true;
  }

  if (/\b(how is .* calculated|formula|policy rule|explain .* policy|threshold definition|fin-fscm|governance policy|credit policy)\b/i.test(norm)) {
    scores.POLICY_EXPLANATION += 10;
  }

  if (/\b(audit history|agent history|recent runs|agent runs|execution history|past conversations|what did the agent do|memory status)\b/i.test(norm)) {
    scores.AUDIT_HISTORY += 12;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = ranked[0];
  const scoredAlts = ranked
    .filter(([, s]) => s > 0)
    .slice(0, 3)
    .map(([intentName]) => INTENT_HUMAN_LABELS[intentName])
    .filter(Boolean);
  const alternatives = scoredAlts.length > 0 ? scoredAlts : getClosestEntitySuggestions(norm);

  if (topScore >= 8) {
    if (topIntent === 'UTILISATION_LIST' && entities.threshold === null) {
      entities.threshold = 80;
    }
    let entityOverride = null;
    if (topIntent === 'MONITORING_ANALYSIS' && /\bfindings?\b/i.test(norm)) entityOverride = 'findings';
    else if (topIntent === 'MONITORING_ANALYSIS' && /\b(?:status|last run|runs?)\b/i.test(norm)) entityOverride = 'monitoring_runs';
    else if (topIntent === 'DATA_SOURCES_STATUS' && /\b(?:scheduler(?:\s+daemon)?|daemon(?:\s+status)?|autonomous\s+(?:scheduler|daemon)|next\s+cycle|last\s+cycle|5[-\s]*min(?:ute)?\s+scheduler)\b/i.test(norm)) {
      entityOverride = 'scheduler_status';
    }

    return finalizeWorkspacePlan({
      primary: topIntent,
      intent: topIntent,
      entity: entityOverride,
      confidence: Math.min(0.98, 0.72 + topScore * 0.025),
      entities,
      display,
      alternatives
    }, norm);
  }

  if (!hasCreditDomainSignal && raw.split(/\s+/).length >= 2) {
    return finalizeWorkspacePlan({
      primary: 'OFF_TOPIC',
      intent: 'OFF_TOPIC',
      entity: null,
      operation: 'EXPLAIN',
      confidence: 0.45,
      entities,
      display,
      alternatives
    }, norm);
  }

  return finalizeWorkspacePlan({
    primary: topScore >= 4 ? topIntent : 'CLARIFY',
    intent: topScore >= 4 ? topIntent : 'CLARIFY',
    confidence: topScore >= 4 ? 0.55 : 0.35,
    entities,
    display,
    alternatives: getClosestEntitySuggestions(norm),
    fallbackBestIntent: topScore > 0 ? topIntent : null
  }, norm);
}

function computeFreshnessLabel(retrievedAtIso, extractionStatus = 'SUCCESS') {
  if (extractionStatus === 'FAILED') return 'Failed';
  if (!retrievedAtIso) return 'Fresh';
  const ts = Date.parse(retrievedAtIso);
  if (Number.isNaN(ts)) return 'Fresh';
  const ageMin = Math.max(0, (Date.now() - ts) / 60000);
  if (ageMin < 6) return `Fresh (${ageMin < 1 ? 'just now' : `${Math.floor(ageMin)}m ago`})`;
  if (ageMin <= 15) return `Delayed (${Math.floor(ageMin)}m ago)`;
  return `Stale (${Math.floor(ageMin)}m ago)`;
}

const COLUMN_REGISTRY = Object.freeze({
  customer: { canonicalKey: 'customer', key: 'customer', label: 'Customer', align: 'left', format: 'text' },
  id: { canonicalKey: 'id', key: 'ID', label: 'ID', align: 'left', format: 'text' },
  country: { canonicalKey: 'country', key: 'country', label: 'Country', align: 'left', format: 'text' },
  companyCode: { canonicalKey: 'companyCode', key: 'companyCode', label: 'Company Code', align: 'left', format: 'text' },
  creditLimit: { canonicalKey: 'creditLimit', key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
  exposure: { canonicalKey: 'exposure', key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
  availableCredit: { canonicalKey: 'availableCredit', key: 'availableCredit', label: 'Available Headroom', align: 'right', format: 'currency' },
  utilisation: { canonicalKey: 'utilisation', key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
  overdue: { canonicalKey: 'overdue', key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
  overdueInvoiceCount: { canonicalKey: 'overdueInvoiceCount', key: 'overdueInvoiceCount', label: 'Overdue Invoices', align: 'right', format: 'number' },
  riskClass: { canonicalKey: 'riskClass', key: 'riskClass', label: 'Risk Class', align: 'left', format: 'text' },
  status: { canonicalKey: 'status', key: 'status', label: 'Status', align: 'left', format: 'badge' },
  runTime: { canonicalKey: 'runTime', key: 'runTime', label: 'Run time', align: 'left', format: 'text' },
  source: { canonicalKey: 'source', key: 'source', label: 'Source/connector', align: 'left', format: 'text' },
  duration: { canonicalKey: 'duration', key: 'duration', label: 'Duration', align: 'right', format: 'text' },
  records: { canonicalKey: 'records', key: 'records', label: 'Records', align: 'right', format: 'number' }
});

const INTENT_DEFAULT_COLUMNS = Object.freeze({
  CUSTOMER_LIST: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'utilisation', 'status'],
  UTILISATION_LIST: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'utilisation', 'status'],
  HIGH_RISK_CUSTOMERS: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'utilisation', 'overdue', 'riskClass', 'status'],
  CUSTOMERS_NO_LIMIT: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'status'],
  OVERDUE_COLLECTIONS: ['customer', 'id', 'country', 'overdue', 'overdueInvoiceCount', 'exposure', 'utilisation', 'status'],
  MONITORING_ANALYSIS: ['customer', 'id', 'country', 'companyCode', 'creditLimit', 'exposure', 'utilisation', 'status'],
  DATA_EXTRACTION_TIMELINE: ['runTime', 'source', 'status', 'duration', 'records']
});

function resolveColumnsForIntent(intentName, display = {}) {
  const defaults = INTENT_DEFAULT_COLUMNS[intentName] || INTENT_DEFAULT_COLUMNS.CUSTOMER_LIST;
  const colsPlan = display?.columns || { include: [], exclude: [] };
  const include = Array.isArray(colsPlan.include) ? colsPlan.include.filter(k => COLUMN_REGISTRY[k]) : [];
  const exclude = Array.isArray(colsPlan.exclude) ? colsPlan.exclude.filter(k => COLUMN_REGISTRY[k]) : [];
  const mode = display?.columnMode || (exclude.length > 0 ? 'exclude' : include.length > 0 ? 'include' : 'default');

  let selectedKeys = [...defaults];
  if (mode === 'only' && include.length > 0) {
    selectedKeys = [];
    if (defaults.includes('customer') && !include.includes('customer')) {
      selectedKeys.push('customer');
    }
    for (const k of include) {
      if (!selectedKeys.includes(k)) selectedKeys.push(k);
    }
  } else if (mode === 'include' && include.length > 0) {
    selectedKeys = [];
    if (defaults.includes('customer')) selectedKeys.push('customer');
    if (defaults.includes('id')) selectedKeys.push('id');
    for (const k of include) {
      if (!selectedKeys.includes(k)) selectedKeys.push(k);
    }
  } else if (exclude.length > 0) {
    const excludeSet = new Set(exclude);
    selectedKeys = defaults.filter(k => !excludeSet.has(k) || k === 'customer');
  }

  return selectedKeys.map(k => ({ ...COLUMN_REGISTRY[k] }));
}

function buildCustomerTableColumns() {
  return resolveColumnsForIntent('CUSTOMER_LIST');
}

function toCustomerTableRow(c) {
  return {
    customer: c.name,
    ID: c.ID,
    country: c.country,
    companyCode: c.companyCode,
    creditLimit: c.creditLimit,
    exposure: c.exposure,
    availableCredit: c.availableCredit,
    utilisationPct: c.utilisationPct,
    utilisationDisplay: c.utilisationDisplay,
    isNoLimit: c.isNoLimit,
    overdueAmount: c.overdueAmount,
    overdueInvoiceCount: c.overdueInvoiceCount,
    riskClass: c.riskClass,
    status: c.status
  };
}

function applyEntityFilters(customers, entities = {}) {
  let list = [...customers];
  if (entities.country) {
    const targetCountry = normalizeCountryCode(entities.country).toLowerCase();
    list = list.filter(c => normalizeCountryCode(c.country).toLowerCase() === targetCountry);
  }
  if (entities.companyCode) {
    const targetCo = String(entities.companyCode).trim().toUpperCase();
    list = list.filter(c => String(c.companyCode || '').toUpperCase() === targetCo);
  }
  const activeStatusFilter = entities.status || entities.statusFilter;
  if (activeStatusFilter) {
    const targetStatus = String(activeStatusFilter).toUpperCase();
    list = list.filter(c => String(c.status || '').toUpperCase() === targetStatus);
  }
  return list;
}

function applySorting(list, sortBy = 'exposure', sortDir = 'desc') {
  const key = sortBy || 'exposure';
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (key === 'name') {
      return String(a.name).localeCompare(String(b.name)) * (sortDir === 'desc' ? -1 : 1);
    }
    if (key === 'creditLimit') return ((a.creditLimit - b.creditLimit) * dir) || ((b.exposure - a.exposure));
    if (key === 'availableCredit') return ((a.availableCredit - b.availableCredit) * dir) || ((b.exposure - a.exposure));
    if (key === 'overdueAmount' || key === 'overdue') return ((a.overdueAmount - b.overdueAmount) * dir) || ((b.exposure - a.exposure));
    if (key === 'utilisationPct' || key === 'utilisation') {
      const ua = a.utilisationPct !== null && a.utilisationPct !== undefined ? a.utilisationPct : (dir === 1 ? Infinity : -Infinity);
      const ub = b.utilisationPct !== null && b.utilisationPct !== undefined ? b.utilisationPct : (dir === 1 ? Infinity : -Infinity);
      return ((ua - ub) * dir) || ((b.exposure - a.exposure));
    }
    return ((a.exposure - b.exposure) * dir) || (((b.utilisationPct ?? -1) - (a.utilisationPct ?? -1)));
  });
}

function collectExtractionTimelineRuns(state = {}) {
  recordSessionExtractionSnapshot(state);
  const runsMap = new Map();

  const addRun = r => {
    if (!r || !r.runTime) return;
    const ms = Date.parse(r.runTime);
    if (Number.isNaN(ms)) return;
    const key = `${new Date(ms).toISOString()}::${r.source}::${r.status}`;
    if (!runsMap.has(key)) {
      runsMap.set(key, {
        ...r,
        _ms: ms,
        runTime: new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
        duration: Number.isFinite(r.durationMs) && r.durationMs >= 0
          ? (r.durationMs < 1000 ? `${Math.round(r.durationMs)} ms` : `${(r.durationMs / 1000).toFixed(1)} s`)
          : '—',
        records: r.recordCount !== null && r.recordCount !== undefined ? Number(r.recordCount) : null
      });
    }
  };

  for (const eRun of Array.isArray(state?.extractionRuns) ? state.extractionRuns : []) {
    const ts = eRun.finishedAt || eRun.startedAt;
    if (!ts) continue;
    const rc = eRun.recordCounts;
    const totalCount = rc && typeof rc === 'object'
      ? (rc.total ?? rc.snapshots ?? rc.partnersUpserted ?? rc.customers ?? Object.values(rc).find(v => typeof v === 'number') ?? null)
      : null;
    addRun({
      runTime: ts,
      source: eRun.sourceName || eRun.sourceId || 'Credit Guard Shared Pipeline',
      status: String(eRun.status || 'COMPLETED').toUpperCase(),
      durationMs: eRun.durationMs ?? null,
      recordCount: totalCount,
      triggeredBy: eRun.triggeredBy || 'SCHEDULER',
      error: eRun.error || null,
      origin: 'shared_extraction'
    });
  }

  for (const sRun of sessionExtractionRuns) {
    addRun(sRun);
  }

  const monitoringRuns = Array.isArray(state?.monitoringData?.runs) ? state.monitoringData.runs : [];
  for (const mRun of monitoringRuns) {
    const startMs = mRun.startedAt ? Date.parse(mRun.startedAt) : NaN;
    const endMs = mRun.completedAt ? Date.parse(mRun.completedAt) : NaN;
    const ts = mRun.completedAt || mRun.startedAt || mRun.retrievedAt;
    if (!ts) continue;
    addRun({
      runTime: ts,
      source: mRun.source || 'Monitoring & Portfolio Scheduler',
      status: String(mRun.status || 'COMPLETED').toUpperCase(),
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
      recordCount: Number.isFinite(Number(mRun.customerCount)) ? Number(mRun.customerCount) : (Array.isArray(state?.customers) ? state.customers.length : null),
      error: mRun.errorMessage || null,
      origin: 'monitoring'
    });
  }

  const mockSources = Array.isArray(state?.mockSap?.sources)
    ? state.mockSap.sources
    : (state?.mockSap?.source ? [{ ...state.mockSap.source, latestRun: state.mockSap.latestRun }] : []);
  for (const src of mockSources) {
    const lr = src?.latestRun;
    if (!lr) continue;
    const startMs = lr.startedAt ? Date.parse(lr.startedAt) : NaN;
    const endMs = lr.completedAt ? Date.parse(lr.completedAt) : NaN;
    const ts = lr.completedAt || lr.startedAt || state?.retrievedAt;
    if (!ts) continue;
    addRun({
      runTime: ts,
      source: src.sourceName || 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)',
      status: String(lr.status || 'COMPLETED').toUpperCase(),
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
      recordCount: Number.isFinite(Number(lr.recordCount)) ? Number(lr.recordCount) : null,
      error: lr.errorCount > 0 ? `${lr.errorCount} issues` : null,
      origin: 'sap_simulator'
    });
  }

  return Array.from(runsMap.values()).sort((a, b) => b._ms - a._ms);
}

function buildPlanClarifyFallback(alternatives = []) {
  const alts = Array.isArray(alternatives) && alternatives.length
    ? alternatives.slice(0, 3)
    : [
        INTENT_HUMAN_LABELS.CUSTOMER_LIST,
        INTENT_HUMAN_LABELS.UTILISATION_LIST,
        INTENT_HUMAN_LABELS.DATA_EXTRACTION_TIMELINE
      ];
  return {
    intent: { primary: 'CLARIFY', secondary: [], confidence: 0.45 },
    title: '',
    summary: 'I want to make sure I get this right. Did you mean:',
    clarifyTip: 'Tip: Mentioning a customer ID like C001, specific columns (e.g. country, exposure), or a topic (extraction timelines, overdue) helps me pinpoint the exact answer.',
    headlineBullets: [],
    blocks: [],
    assumptions: [],
    limitations: [],
    suggestedFollowUps: alts
  };
}

export function verifyResponseAgainstPlan(plan, structured) {
  if (!plan || !structured) return { valid: false, reason: 'missing_plan_or_response' };
  const expectedIntent = plan.intent || plan.primary;
  const actualIntent = structured.intent?.primary;
  const normalizedExpected = expectedIntent === 'OUT_OF_SCOPE' ? 'OFF_TOPIC' : expectedIntent;
  const normalizedActual = actualIntent === 'OUT_OF_SCOPE' ? 'OFF_TOPIC' : actualIntent;

  if (normalizedActual === 'CLARIFY' || normalizedExpected === 'CLARIFY') {
    return { valid: true };
  }
  if (normalizedExpected && normalizedActual && normalizedExpected !== normalizedActual) {
    return { valid: false, reason: 'intent_mismatch' };
  }

  const display = plan.display || {};
  const tableBlock = Array.isArray(structured.blocks)
    ? structured.blocks.find(b => b && b.type === 'table')
    : null;

  if (tableBlock && Array.isArray(tableBlock.columns)) {
    const colKeys = new Set(tableBlock.columns.map(c => c.canonicalKey || c.key));
    const inc = Array.isArray(display.columns?.include) ? display.columns.include : [];
    const exc = Array.isArray(display.columns?.exclude) ? display.columns.exclude : [];

    for (const k of inc) {
      if (COLUMN_REGISTRY[k] && !colKeys.has(k) && !colKeys.has(COLUMN_REGISTRY[k].key)) {
        return { valid: false, reason: `missing_requested_column:${k}` };
      }
    }
    for (const k of exc) {
      if (COLUMN_REGISTRY[k] && (colKeys.has(k) || colKeys.has(COLUMN_REGISTRY[k].key))) {
        return { valid: false, reason: `excluded_column_present:${k}` };
      }
    }
    if (Number.isInteger(display.limit) && display.limit > 0 && Array.isArray(tableBlock.rows) && tableBlock.rows.length > display.limit) {
      return { valid: false, reason: 'limit_not_honored' };
    }
  }

  return { valid: true };
}

function buildColumnsDescription(columns = []) {
  return columns
    .map(c => c.label.toLowerCase())
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
}

const INTENT_DEFAULT_SOURCE_TAB = Object.freeze({
  CUSTOMER_COUNT: 'Exposure Analysis',
  CUSTOMER_LIST: 'Exposure Analysis',
  UTILISATION_LIST: 'Portfolio & Monitoring',
  HIGH_RISK_CUSTOMERS: 'Portfolio & Monitoring',
  CUSTOMERS_NO_LIMIT: 'Exposure Analysis',
  CUSTOMER_EVALUATION: 'Exposure Analysis',
  LIMIT_REQUEST_DRAFT: 'Portfolio & Monitoring',
  LIMIT_INCREASE_RECOMMENDATION: 'Limit Approvals',
  EXPOSURE_BY_COUNTRY: 'Exposure Analysis',
  EXPOSURE_BY_COMPANY_CODE: 'Exposure Analysis',
  PORTFOLIO_SUMMARY: 'Credit Overview',
  CREDIT_OVERVIEW_SUMMARY: 'Credit Overview',
  OVERDUE_COLLECTIONS: 'Portfolio & Monitoring',
  MONITORING_ALERTS: 'Portfolio & Monitoring',
  MONITORING_ANALYSIS: 'Portfolio & Monitoring',
  LIMIT_APPROVALS_STATUS: 'Limit Approvals',
  DATA_SOURCES_STATUS: 'SAP BTP & HANA CDS',
  DATA_EXTRACTION_TIMELINE: 'SAP BTP & HANA CDS',
  CDS_ENTITIES_LIST: 'SAP BTP & HANA CDS',
  MOCK_SAP_STAGING: 'SAP BTP & HANA CDS',
  POLICY_EXPLANATION: 'AI Credit Assistance',
  AUDIT_HISTORY: 'AI Audit History',
  WORKSPACE_NAVIGATION: 'Credit Overview',
  SCREEN_CONTEXT: 'Credit Guard'
});

const WORKSPACE_DELEGATED_INTENTS = new Set([
  'WORKSPACE_NAVIGATION',
  'SCREEN_CONTEXT',
  'CREDIT_OVERVIEW_SUMMARY',
  'CDS_ENTITIES_LIST',
  'MOCK_SAP_STAGING',
  'DATA_SOURCES_STATUS',
  'LIMIT_APPROVALS_STATUS',
  'MONITORING_ALERTS',
  'AUDIT_HISTORY'
]);

export function buildLocalStructuredResponse(question, state = {}, overrideClassification = null) {
  recordSessionExtractionSnapshot(state);
  const intentInfo = overrideClassification || classifyClientIntent(question, state);
  const primary = intentInfo.intent || intentInfo.primary || 'CLARIFY';
  const retrievedAt = state?.retrievedAt || state?.portfolioData?.retrievedAt || state?.dashboard?.retrievedAt || new Date().toISOString();
  const formattedSyncTime = String(retrievedAt).slice(0, 19).replace('T', ' ');

  const stampSourceFooter = response => {
    if (!response || typeof response !== 'object') return response;
    const outPrimary = response.intent?.primary || primary;
    if (NO_BADGE_INTENTS.has(outPrimary)) return response;
    return {
      ...response,
      sourceTabLabel: response.sourceTabLabel || INTENT_DEFAULT_SOURCE_TAB[outPrimary] || 'Credit Guard',
      dataAsOf: response.dataAsOf || formattedSyncTime
    };
  };

  return stampSourceFooter(buildLocalStructuredResponseInner(question, state, intentInfo, retrievedAt, formattedSyncTime));
}

function buildLocalStructuredResponseInner(question, state = {}, intentInfo, retrievedAt, formattedSyncTime) {
  const primary = intentInfo.intent || intentInfo.primary || 'CLARIFY';
  const entities = intentInfo.entities || {};
  const display = intentInfo.display || { columns: { include: [], exclude: [] }, columnMode: 'default', sortBy: null, sortDir: null, limit: null, format: 'table', timeRange: null };

  const baseProvenance = {
    sourceType: 'SYNTHETIC_DEMO',
    connectorName: state?.portfolioData?.source || 'Credit Guard Demo Dataset (FIN-FSCM-CR)',
    currency: 'INR',
    lastSyncAt: retrievedAt,
    policyId: 'FIN-FSCM-AUTONOMOUS-POLICY-V1',
    toolsInvoked: ['fetchPortfolioData']
  };

  // --- Conversational & Non-Data Intents (ZERO data badges) ---
  if (primary === 'GREETING') {
    return {
      intent: { primary: 'GREETING', secondary: [], confidence: 0.99 },
      title: '',
      summary: 'Hello! I am the Credit Guard AI assistant. Ask me about customers, exposure, utilisation, overdue invoices, limit approvals, or SAP data sources.',
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'How many customers are in Credit Guard?',
        'Customers above 80% utilisation',
        'Exposure by country'
      ]
    };
  }

  if (primary === 'HOW_ARE_YOU') {
    return {
      intent: { primary: 'HOW_ARE_YOU', secondary: [], confidence: 0.99 },
      title: '',
      summary: 'Doing great and ready to help with Credit Guard portfolio monitoring, exposure analysis, and customer credit checks!',
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'List customers',
        'Overdue invoices',
        'Give me our data sources and connectivity status'
      ]
    };
  }

  if (primary === 'THANKS') {
    return {
      intent: { primary: 'THANKS', secondary: [], confidence: 0.99 },
      title: '',
      summary: "You're welcome! Let me know if you want to explore any customer account, country exposure, or overdue receivables.",
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'Customers above 80% utilisation',
        'Overdue invoices',
        'Evaluate credit risk for C001'
      ]
    };
  }

  if (primary === 'GOODBYE') {
    return {
      intent: { primary: 'GOODBYE', secondary: [], confidence: 0.99 },
      title: '',
      summary: 'Goodbye! Whenever you need portfolio exposure or limit monitoring insights, just ask.',
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'Portfolio summary',
        'Customers above 80% utilisation',
        'Give me our data sources and connectivity status'
      ]
    };
  }

  if (primary === 'HELP') {
    return {
      intent: { primary: 'HELP', secondary: [], confidence: 0.98 },
      title: '',
      summary: 'I can answer questions directly from Bluspring Credit Guard portfolio, monitoring, approval, and SAP connector data:',
      helpGroups: [
        {
          title: 'Customers & Custom Tables',
          description: 'Customer counts, custom columns (e.g. "along with country", "without country", "only name and exposure"), top N sorting, and follow-ups like "and only India?".'
        },
        {
          title: 'Exposure & Overdue Receivables',
          description: 'Portfolio totals, exposure breakdown by country or company code, and ranked overdue invoice collections.'
        },
        {
          title: 'Limit Governance & Simulations',
          description: 'Single-customer risk evaluations (C001–C013), limit increase recommendations, draft limit requests, and pending approvals.'
        },
        {
          title: 'Monitoring, Timelines & Policy',
          description: 'Data extraction timelines, SAP/CAP connector connectivity & freshness, monitoring alerts, credit rules, and agent audit history.'
        }
      ],
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'How many customers are in Credit Guard?',
        'Give me customers along with country and country code',
        'Customers above 80% utilisation',
        'Show me recent data extraction timelines',
        'Overdue invoices',
        'Give me our data sources and connectivity status'
      ]
    };
  }

  if (primary === 'OFF_TOPIC' || primary === 'OUT_OF_SCOPE') {
    return {
      intent: { primary: 'OFF_TOPIC', secondary: [], confidence: 0.98 },
      title: '',
      summary: "I'm the Credit Guard AI assistant, so I can help only with credit and receivables topics in this app (customers, exposure, utilisation, overdue invoices, limits, monitoring, extraction timelines, data sources). Here are some things you can ask:",
      headlineBullets: [],
      blocks: [],
      assumptions: [],
      limitations: [],
      dataProvenance: baseProvenance,
      suggestedFollowUps: [
        'How many customers are in Credit Guard?',
        'Customers above 80% utilisation',
        'Exposure by country',
        'Overdue invoices'
      ]
    };
  }

  if (primary === 'CLARIFY' || primary === 'UNKNOWN') {
    return {
      ...buildPlanClarifyFallback(intentInfo.alternatives),
      dataProvenance: baseProvenance
    };
  }

  // --- Generic Read-Only Workspace Context Engine Delegation ---
  const wsCtx = getWorkspaceCtx();
  const useWorkspaceEngine = Boolean(
    wsCtx?.executeWorkspacePlan
    && (
      WORKSPACE_DELEGATED_INTENTS.has(primary)
      || ['monitoring_runs', 'findings', 'limit_drafts'].includes(intentInfo.entity)
      || ((primary === 'EXPOSURE_BY_COUNTRY' || primary === 'EXPOSURE_BY_COMPANY_CODE') && entities.metric === 'creditLimit')
    )
  );
  if (useWorkspaceEngine) {
    const effectiveState = state && typeof state === 'object'
      ? { ...state, lastViewed: state.lastViewed || state.lastViewedTab || trackedLastViewedTab }
      : { lastViewed: trackedLastViewedTab };
    const wsResponse = wsCtx.executeWorkspacePlan(intentInfo, effectiveState, {
      sessionRuns: sessionExtractionRuns,
      rawQuestion: question
    });
    if (wsResponse) {
      return wsResponse;
    }
  }

  // --- Extraction Timeline Intent (works even before customer array check) ---
  if (primary === 'DATA_EXTRACTION_TIMELINE') {
    const allRuns = collectExtractionTimelineRuns(state);
    let filteredRuns = [...allRuns];
    const hasExplicitWindow = /\b(?:last\s+(?:\d+|hour)|today)\b/i.test(String(question || ''));
    if (display.timeRange?.from || display.timeRange?.to) {
      const fromMs = display.timeRange.from ? Date.parse(display.timeRange.from) : -Infinity;
      const toMs = display.timeRange.to ? Date.parse(display.timeRange.to) : Infinity;
      const windowed = filteredRuns.filter(r => r._ms >= fromMs && r._ms <= toMs);
      if (windowed.length > 0 || hasExplicitWindow) {
        filteredRuns = windowed;
      }
    }
    const maxRuns = display.limit || 10;
    const shownRuns = filteredRuns.slice(0, maxRuns);

    const nowMs = Date.now();
    const oneHourAgoMs = nowMs - 3600000;
    const runsLastHour = allRuns.filter(r => r._ms >= oneHourAgoMs);
    const lastSuccessRun = allRuns.find(r => r.status === 'COMPLETED' || r.status === 'SUCCESS');
    const lastSuccessMs = lastSuccessRun ? lastSuccessRun._ms : (state?.lastSuccessfulAt ? Date.parse(state.lastSuccessfulAt) : NaN);
    const lastAgeMin = Number.isFinite(lastSuccessMs) ? Math.max(0, Math.floor((nowMs - lastSuccessMs) / 60000)) : null;
    const lastAgeText = lastAgeMin === null ? 'not recorded yet' : (lastAgeMin === 0 ? 'just now' : `${lastAgeMin} min ago`);

    const allCompleted = runsLastHour.length > 0 && runsLastHour.every(r => r.status === 'COMPLETED' || r.status === 'SUCCESS');
    const hourStatusText = runsLastHour.length === 0
      ? '0 runs in the last hour'
      : `${runsLastHour.length} ${runsLastHour.length === 1 ? 'run' : 'runs'} in the last hour, ${allCompleted ? 'all COMPLETED' : 'mixed statuses'}`;

    const hasPersistedHistory = Boolean(state?.extractionRuns?.length || state?.monitoringData?.runs?.length || state?.mockSap?.sources?.some(s => s.latestRun) || state?.mockSap?.latestRun);
    const timelineColumns = resolveColumnsForIntent('DATA_EXTRACTION_TIMELINE', display);

    return {
      intent: { primary: 'DATA_EXTRACTION_TIMELINE', secondary: [], confidence: 0.97 },
      showTableAboveFold: true,
      title: 'Data Extraction & Refresh Timeline',
      summary: `Last successful extraction ${lastAgeText}; ${hourStatusText} (showing ${shownRuns.length} ${shownRuns.length === 1 ? 'run' : 'runs'}).`,
      planNote: !hasPersistedHistory
        ? 'Only current session extraction runs are available in memory; persistent scheduler history appears once monitoring runs load.'
        : 'Combined from the shared portfolio freshness store, monitoring scheduler runs, and SAP connector logs.',
      headlineBullets: [],
      blocks: [
        shownRuns.length > 0 ? {
          type: 'table',
          title: 'Recent Data Extraction & Scheduler Runs',
          pageSize: 10,
          showAllByDefault: shownRuns.length <= 10,
          columns: timelineColumns,
          rows: shownRuns
        } : {
          type: 'notice',
          severity: 'info',
          title: 'No Runs in Selected Time Window',
          message: 'No extraction or scheduler runs matched the requested time window.'
        }
      ],
      assumptions: ['Auto-extraction refreshes every 5 minutes in the shared store and triggers monitoring checks automatically.'],
      limitations: !hasPersistedHistory ? ['Historical runs prior to this browser session were not available in local memory yet.'] : [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['fetchPortfolioData', 'get_monitoring_runs'] },
      suggestedFollowUps: [
        'Give me our data sources and connectivity status',
        'Customers above 80% utilisation',
        'Portfolio summary'
      ]
    };
  }

  // --- Deterministic Portfolio & Shared Store Data Intents ---
  const rawList = state?.portfolioData?.customers || state?.customers || [];
  const customers = selectCanonicalPortfolioCustomers(rawList, { specificIds: entities.customerIds || [] });
  const inactiveCustomers = selectCanonicalPortfolioCustomers(rawList, { includeInactive: true })
    .filter(c => c.isInactive);

  if (customers.length === 0 && !['DATA_SOURCES_STATUS', 'AUDIT_HISTORY'].includes(primary)) {
    return null;
  }

  const totalExposure = customers.reduce((sum, c) => sum + c.exposure, 0);
  const totalCreditLimit = customers.reduce((sum, c) => sum + c.creditLimit, 0);
  const overallUtilisationPct = totalCreditLimit > 0
    ? Number(((totalExposure / totalCreditLimit) * 100).toFixed(1))
    : 0;

  if (primary === 'DATA_SOURCES_STATUS') {
    const sources = Array.isArray(state?.v2Connectors?.sources) ? state.v2Connectors.sources : [];
    const activeCount = sources.filter(s => String(s.status || '').toUpperCase() === 'ACTIVE').length;
    const standbyCount = sources.filter(s => String(s.status || '').toUpperCase() === 'STANDBY').length;
    const connectorRows = sources.map(s => {
      const id = s.source_id || s.sourceId || s.id;
      const st = String(s.status || 'STANDBY').toUpperCase();
      const baseName = s.source_name || s.sourceName || s.name || id;
      const connector = id === 'MOCK-SAP-FIN-FSCM' && !/MOCK-S4-001/i.test(baseName)
        ? `${baseName} (Simulator ID: MOCK-S4-001)`
        : baseName;
      return {
        id,
        connector,
        mode: st === 'ACTIVE' ? 'Active (Connected)' : 'Standby (Ready to connect)',
        status: st,
        freshness: s.last_sync_at
          ? computeFreshnessLabel(s.last_sync_at, state?.extractionStatus)
          : (st === 'STANDBY' ? 'Not connected' : 'Not yet synced'),
        lastRetrieved: s.last_sync_at ? String(s.last_sync_at).slice(0, 19).replace('T', ' ') : 'Never'
      };
    });

    return {
      intent: { primary: 'DATA_SOURCES_STATUS', secondary: [], confidence: 0.97 },
      showTableAboveFold: connectorRows.length > 0,
      title: 'SAP BTP & HANA CDS Data Sources',
      summary: connectorRows.length > 0
        ? `${connectorRows.length} registered connectors from /api/v2/connectors (${activeCount} ACTIVE, ${standbyCount} STANDBY).`
        : 'Connector registry from /api/v2/connectors has not loaded in this store snapshot yet.',
      sourceTabLabel: 'SAP BTP & HANA CDS',
      dataAsOf: formattedSyncTime,
      headlineBullets: [],
      blocks: [
        connectorRows.length > 0 ? {
          type: 'table',
          title: 'Registered Connectors & Data Freshness',
          columns: [
            { key: 'id', label: 'Source ID', align: 'left', format: 'text' },
            { key: 'connector', label: 'Connector / Data Source', align: 'left', format: 'text' },
            { key: 'mode', label: 'Connection Status', align: 'left', format: 'text' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' },
            { key: 'freshness', label: 'Freshness', align: 'left', format: 'text' },
            { key: 'lastRetrieved', label: 'Last Retrieved', align: 'left', format: 'text' }
          ],
          rows: connectorRows
        } : {
          type: 'notice',
          severity: 'info',
          title: 'Connectors Not Loaded',
          message: 'Open SAP BTP & HANA CDS or ask again once /api/v2/connectors finishes loading.'
        }
      ],
      assumptions: ['Read directly from /api/v2/connectors shared with SAP BTP & HANA CDS.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['getV2Connectors'] },
      suggestedFollowUps: [
        'Show me recent data extraction timelines',
        'Show CDS entities',
        'Show scheduler daemon status'
      ]
    };
  }

  if (primary === 'CUSTOMER_COUNT') {
    const filtered = applyEntityFilters(customers, entities);
    const scopeLabel = entities.country
      ? ` in ${normalizeCountryCode(entities.country)}`
      : entities.companyCode
        ? ` in company code ${entities.companyCode}`
        : '';

    const byCountry = new Map();
    const byCompany = new Map();
    for (const c of filtered) {
      byCountry.set(c.country, (byCountry.get(c.country) || 0) + 1);
      byCompany.set(c.companyCode, (byCompany.get(c.companyCode) || 0) + 1);
    }

    const countrySummary = Array.from(byCountry.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
    const companySummary = Array.from(byCompany.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');

    const scopeExposure = filtered.reduce((s, c) => s + c.exposure, 0);
    const scopeLimit = filtered.reduce((s, c) => s + c.creditLimit, 0);

    return {
      intent: {
        primary: 'CUSTOMER_COUNT',
        secondary: [],
        confidence: 0.98,
        resolvedFromContext: Boolean(intentInfo.resolvedFromContext),
        contextNote: intentInfo.contextNote || null
      },
      title: 'Credit Guard Customer Count',
      summary: `There are ${filtered.length} active ${filtered.length === 1 ? 'customer' : 'customers'} (${inactiveCustomers.length} inactive)${scopeLabel} in Credit Guard.`,
      headlineBullets: [],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Active Customers', value: String(filtered.length), rawValue: filtered.length, subtitle: `${inactiveCustomers.length} inactive`, severity: 'neutral', valueKind: 'ACTUAL' },
            { label: 'By Country', value: countrySummary || '—', subtitle: `${byCountry.size} countries`, severity: 'neutral', valueKind: 'CALCULATED' },
            { label: 'By Company Code', value: companySummary || '—', subtitle: `${byCompany.size} company codes`, severity: 'neutral', valueKind: 'CALCULATED' },
            { label: 'Combined Exposure', value: formatIndianCurrency(scopeExposure), rawValue: scopeExposure, subtitle: `Limit: ${formatIndianCurrency(scopeLimit)}`, severity: 'neutral', valueKind: 'CALCULATED' }
          ]
        }
      ],
      assumptions: ['Counts reflect active Business Partners loaded in the Credit Guard portfolio store.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_portfolio_summary'] },
      suggestedFollowUps: [
        'List customers',
        'Customers above 80% utilisation',
        'Exposure by country'
      ]
    };
  }

  if (primary === 'CUSTOMER_LIST') {
    const filtered = applyEntityFilters(customers, entities);
    const sortBy = display.sortBy || 'exposure';
    const sortDir = display.sortDir || (sortBy === 'name' ? 'asc' : 'desc');
    const sorted = applySorting(filtered, sortBy, sortDir);
    const activeLimit = !display.showAll && Number.isInteger(display.limit) && display.limit > 0 ? display.limit : null;
    const limited = activeLimit ? sorted.slice(0, activeLimit) : sorted;
    const rows = limited.map(toCustomerTableRow);
    const columns = resolveColumnsForIntent('CUSTOMER_LIST', display);

    const filterLabels = [];
    if (entities.country) filterLabels.push(normalizeCountryCode(entities.country));
    if (entities.companyCode) filterLabels.push(`CoCode ${entities.companyCode}`);
    if (entities.status || entities.statusFilter) filterLabels.push(`Status ${entities.status || entities.statusFilter}`);
    const filterDesc = filterLabels.length ? ` (${filterLabels.join(', ')})` : '';

    const sortPhrase = display.sortBy
      ? ` sorted by ${display.sortBy === 'utilisationPct' ? 'utilisation' : display.sortBy === 'overdueAmount' ? 'overdue amount' : display.sortBy === 'creditLimit' ? 'credit limit' : display.sortBy} (${sortDir === 'asc' ? 'lowest first' : 'highest first'})`
      : '';
    const countPhrase = activeLimit && activeLimit < filtered.length
      ? `${sortDir === 'asc' ? 'Showing lowest' : 'Showing top'} ${rows.length} of ${filtered.length}`
      : `Showing ${rows.length}`;
    const colDesc = display.columnMode && display.columnMode !== 'default'
      ? ` with ${buildColumnsDescription(columns)}`
      : '';
    const excludedDesc = display.columns?.exclude?.length > 0
      ? ` (excluding ${display.columns.exclude.map(k => COLUMN_REGISTRY[k]?.label.toLowerCase() || k).join(' and ')})`
      : '';

    const planNote = display.countryCodeAliasUsed
      ? 'Country code = company code (BSxx) in this dataset.'
      : null;

    const result = {
      intent: {
        primary: 'CUSTOMER_LIST',
        secondary: [],
        confidence: 0.97,
        resolvedFromContext: Boolean(intentInfo.resolvedFromContext),
        contextNote: intentInfo.contextNote || null
      },
      showTableAboveFold: true,
      title: `Customer Credit Limits & Exposures${filterDesc}`,
      summary: `${countPhrase} ${rows.length === 1 ? 'customer' : 'customers'}${filterDesc}${colDesc}${excludedDesc}${sortPhrase}.`,
      planNote,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: `Customers${filterDesc}`,
          pageSize: 10,
          showAllByDefault: Boolean(display.showAll || (activeLimit && rows.length <= activeLimit)),
          columns,
          rows
        },
        ...(entities.includeSourceInfo ? [{
          type: 'keyValue',
          title: 'Source Lineage (Demo INR)',
          items: [
            { label: 'Primary Store', value: baseProvenance.connectorName, valueKind: 'ACTUAL' },
            { label: 'SAP Simulator Source', value: state?.mockSap?.source?.sourceName || 'SAP S/4HANA Credit Simulator (FIN-FSCM-CR)', valueKind: 'ACTUAL' },
            { label: 'Last Retrieved', value: formattedSyncTime, valueKind: 'ACTUAL' }
          ]
        }] : [])
      ],
      assumptions: ['All amounts are in INR; zero-limit accounts display N/A (no limit).'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_portfolio_summary'] },
      suggestedFollowUps: [
        entities.country ? 'List customers' : 'and only India?',
        'Customers above 80% utilisation',
        'Overdue invoices'
      ]
    };

    const check = verifyResponseAgainstPlan({ intent: primary, display }, result);
    return check.valid ? result : { ...buildPlanClarifyFallback(intentInfo.alternatives), dataProvenance: baseProvenance };
  }

  if (primary === 'UTILISATION_LIST' || primary === 'HIGH_RISK_CUSTOMERS' || primary === 'CUSTOMERS_NO_LIMIT') {
    const baseFiltered = applyEntityFilters(customers, entities);
    const threshold = Number.isFinite(entities.threshold) ? entities.threshold : 80;
    let matched = [];
    let desc = '';

    if (primary === 'CUSTOMERS_NO_LIMIT') {
      matched = baseFiltered.filter(c => c.isNoLimit);
      desc = 'with no credit limit configured (N/A)';
    } else if (primary === 'HIGH_RISK_CUSTOMERS') {
      matched = baseFiltered.filter(c => c.status === 'BREACH' || c.status === 'WARNING' || c.isNoLimit || c.riskClass === 'C');
      desc = 'flagged high-risk (breached, warning >= 80%, no limit, or Risk Class C)';
    } else {
      matched = baseFiltered.filter(c => !c.isNoLimit && c.utilisationPct >= threshold);
      desc = `at or above ${threshold}% utilisation`;
    }

    const sortBy = display.sortBy || 'utilisationPct';
    const sortDir = display.sortDir || 'desc';
    const sorted = applySorting(matched, sortBy, sortDir);
    const activeLimit = !display.showAll && Number.isInteger(display.limit) && display.limit > 0 ? display.limit : null;
    const limited = activeLimit ? sorted.slice(0, activeLimit) : sorted;
    const rows = limited.map(toCustomerTableRow);
    const columns = resolveColumnsForIntent(primary, display);
    const matchedExposure = limited.reduce((s, r) => s + r.exposure, 0);

    const result = {
      intent: {
        primary,
        secondary: [],
        confidence: 0.97,
        resolvedFromContext: Boolean(intentInfo.resolvedFromContext),
        contextNote: intentInfo.contextNote || null
      },
      showTableAboveFold: true,
      title: `Matched Customers (${rows.length})`,
      summary: `Found ${rows.length} ${rows.length === 1 ? 'customer' : 'customers'} ${desc} out of ${baseFiltered.length} accounts (combined exposure ${formatIndianCurrency(matchedExposure)}).`,
      planNote: display.countryCodeAliasUsed ? 'Country code = company code (BSxx) in this dataset.' : null,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: `Customers ${desc}`,
          pageSize: 10,
          showAllByDefault: Boolean(display.showAll),
          columns,
          rows
        },
        ...(rows.length > 0 ? [{
          type: 'chart',
          chartType: 'hbar',
          title: 'Utilisation vs 80% / 100% Policy Thresholds',
          unit: 'PERCENT',
          valueKind: 'CALCULATED',
          thresholds: [
            { value: 80, label: 'Warning 80%', severity: 'warning' },
            { value: 100, label: 'Breach 100%', severity: 'critical' }
          ],
          series: [{
            name: 'Utilisation %',
            data: rows.filter(r => r.utilisationPct !== null).map(r => ({
              label: `${r.customer} (${r.ID})`,
              value: r.utilisationPct,
              status: r.status
            }))
          }]
        }] : [])
      ],
      assumptions: ['Zero-limit accounts are flagged MANUAL_REVIEW and shown when requesting no-limit or high-risk accounts.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['list_customers_over_threshold'] },
      suggestedFollowUps: [
        rows[0] ? `Evaluate credit risk for ${rows[0].ID}` : 'Evaluate credit risk for C001',
        'Overdue invoices',
        'Exposure by country'
      ]
    };

    const check = verifyResponseAgainstPlan({ intent: primary, display }, result);
    return check.valid ? result : { ...buildPlanClarifyFallback(intentInfo.alternatives), dataProvenance: baseProvenance };
  }

  if (primary === 'EXPOSURE_BY_COUNTRY' || primary === 'EXPOSURE_BY_COMPANY_CODE') {
    const dim = primary === 'EXPOSURE_BY_COMPANY_CODE' ? 'companyCode' : 'country';
    const dimLabel = dim === 'companyCode' ? 'Company Code' : 'Country';
    const scoped = applyEntityFilters(customers, entities);
    const groupsMap = new Map();

    for (const c of scoped) {
      const key = dim === 'companyCode' ? (c.companyCode || 'Unspecified') : normalizeCountryCode(c.country);
      const curr = groupsMap.get(key) || {
        groupKey: key,
        customerCount: 0,
        creditLimit: 0,
        exposure: 0,
        overdueAmount: 0,
        breachedCount: 0,
        warningCount: 0
      };
      curr.customerCount += 1;
      curr.creditLimit += c.creditLimit;
      curr.exposure += c.exposure;
      curr.overdueAmount += c.overdueAmount;
      if (c.status === 'BREACH') curr.breachedCount += 1;
      else if (c.status === 'WARNING') curr.warningCount += 1;
      groupsMap.set(key, curr);
    }

    const rows = Array.from(groupsMap.values())
      .map(g => {
        const utilPct = g.creditLimit > 0 ? Number(((g.exposure / g.creditLimit) * 100).toFixed(1)) : 0;
        const sharePct = totalExposure > 0 ? Number(((g.exposure / totalExposure) * 100).toFixed(1)) : 0;
        return {
          ...g,
          availableCredit: Math.max(0, g.creditLimit - g.exposure),
          utilisationPct: utilPct,
          utilisationDisplay: `${utilPct.toFixed(1)}%`,
          shareOfTotalPct: sharePct,
          status: g.breachedCount > 0 ? 'BREACH' : g.warningCount > 0 ? 'WARNING' : 'HEALTHY'
        };
      })
      .sort((a, b) => b.exposure - a.exposure);

    return {
      intent: {
        primary,
        secondary: [],
        confidence: 0.97,
        resolvedFromContext: Boolean(intentInfo.resolvedFromContext),
        contextNote: intentInfo.contextNote || null
      },
      showTableAboveFold: true,
      title: `Portfolio Credit Exposure Analysis by ${dimLabel}`,
      summary: `Total portfolio exposure across ${scoped.length} customers is ${formatIndianCurrency(scoped.reduce((s, c) => s + c.exposure, 0))} against ${formatIndianCurrency(scoped.reduce((s, c) => s + c.creditLimit, 0))} in limits (${overallUtilisationPct.toFixed(1)}% portfolio utilisation).`,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: `Exposure Breakdown by ${dimLabel}`,
          columns: [
            { key: 'groupKey', label: dimLabel, align: 'left', format: 'text' },
            { key: 'customerCount', label: 'Customers', align: 'right', format: 'number' },
            { key: 'creditLimit', label: 'Credit Limit', align: 'right', format: 'currency' },
            { key: 'exposure', label: 'Exposure', align: 'right', format: 'currency' },
            { key: 'utilisationPct', label: 'Utilisation', align: 'right', format: 'percent' },
            { key: 'overdueAmount', label: 'Overdue', align: 'right', format: 'currency' },
            { key: 'status', label: 'Cohort Status', align: 'left', format: 'badge' }
          ],
          rows
        },
        {
          type: 'chart',
          chartType: 'donut',
          title: `Exposure Share by ${dimLabel}`,
          subtitle: `Total ${formatIndianCurrency(totalExposure)} across ${rows.length} ${dimLabel.toLowerCase()} cohorts`,
          unit: 'INR',
          valueKind: 'CALCULATED',
          series: [{ name: 'Exposure (INR)', data: rows.map(r => ({ label: r.groupKey, value: r.exposure, sharePct: r.shareOfTotalPct, status: r.status })) }]
        }
      ],
      assumptions: ['Exposure equals open unpaid receivables and open orders calculated deterministically in INR.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['exposure_by', 'get_portfolio_summary'] },
      suggestedFollowUps: [
        dim === 'country' ? 'Exposure by company code' : 'Exposure by country',
        'Customers above 80% utilisation',
        'Overdue invoices'
      ]
    };
  }

  if (primary === 'PORTFOLIO_SUMMARY') {
    const overdueCount = customers.filter(c => c.overdueAmount > 0).length;
    const totalOverdue = customers.reduce((s, c) => s + c.overdueAmount, 0);
    const breachedCount = customers.filter(c => c.status === 'BREACH').length;
    const warningCount = customers.filter(c => c.status === 'WARNING').length;

    return {
      intent: { primary: 'PORTFOLIO_SUMMARY', secondary: [], confidence: 0.97 },
      title: 'Portfolio Credit Summary',
      summary: `Portfolio exposure is ${formatIndianCurrency(totalExposure)} against ${formatIndianCurrency(totalCreditLimit)} total limit (${overallUtilisationPct.toFixed(1)}% utilisation) across ${customers.length} active customers, with ${formatIndianCurrency(totalOverdue)} overdue.`,
      headlineBullets: [],
      blocks: [
        {
          type: 'metrics',
          items: [
            { label: 'Total Exposure', value: formatIndianCurrency(totalExposure), rawValue: totalExposure, subtitle: `${customers.length} active customers`, severity: overallUtilisationPct >= 80 ? 'warning' : 'neutral', valueKind: 'CALCULATED' },
            { label: 'Total Credit Limit', value: formatIndianCurrency(totalCreditLimit), rawValue: totalCreditLimit, subtitle: `Available: ${formatIndianCurrency(Math.max(0, totalCreditLimit - totalExposure))}`, severity: 'neutral', valueKind: 'CALCULATED' },
            { label: 'Overall Utilisation', value: `${overallUtilisationPct.toFixed(1)}%`, rawValue: overallUtilisationPct, subtitle: `${breachedCount} breached · ${warningCount} warning`, severity: overallUtilisationPct >= 100 ? 'critical' : overallUtilisationPct >= 80 ? 'warning' : 'healthy', valueKind: 'CALCULATED' },
            { label: 'Overdue Receivables', value: formatIndianCurrency(totalOverdue), rawValue: totalOverdue, subtitle: `${overdueCount} customers overdue`, severity: totalOverdue > 0 ? 'warning' : 'healthy', valueKind: 'CALCULATED' }
          ]
        }
      ],
      assumptions: ['KPI totals match the live Credit Overview shared store.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_portfolio_summary'] },
      suggestedFollowUps: [
        'List out customers along with credit limit',
        'Customers above 80% utilisation',
        'Exposure by country'
      ]
    };
  }

  if (primary === 'OVERDUE_COLLECTIONS') {
    const scoped = applyEntityFilters(customers, entities);
    const sortBy = display.sortBy || 'overdueAmount';
    const sortDir = display.sortDir || 'desc';
    const sortedOverdue = applySorting(
      scoped.filter(c => c.overdueAmount > 0),
      sortBy,
      sortDir
    );
    const activeLimit = !display.showAll && Number.isInteger(display.limit) && display.limit > 0 ? display.limit : null;
    const overdueCustomers = activeLimit ? sortedOverdue.slice(0, activeLimit) : sortedOverdue;
    const totalOverdue = overdueCustomers.reduce((s, c) => s + c.overdueAmount, 0);
    const totalOverdueInvoices = overdueCustomers.reduce((s, c) => s + c.overdueInvoiceCount, 0);
    const rows = overdueCustomers.map(toCustomerTableRow);
    const columns = resolveColumnsForIntent('OVERDUE_COLLECTIONS', display);

    const result = {
      intent: {
        primary: 'OVERDUE_COLLECTIONS',
        secondary: [],
        confidence: 0.97,
        resolvedFromContext: Boolean(intentInfo.resolvedFromContext),
        contextNote: intentInfo.contextNote || null
      },
      showTableAboveFold: true,
      title: 'Overdue Receivables & Collections Priority',
      summary: `${overdueCustomers.length} of ${scoped.length} customers hold ${formatIndianCurrency(totalOverdue)} in overdue receivables across ${totalOverdueInvoices} past-due invoices.`,
      planNote: display.countryCodeAliasUsed ? 'Country code = company code (BSxx) in this dataset.' : null,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: 'Overdue Customers Ranked by Past-Due Balance',
          pageSize: 10,
          showAllByDefault: Boolean(display.showAll),
          columns,
          rows
        }
      ],
      assumptions: ['Overdue amounts reflect open invoices past their contractual due date.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['list_customers_over_threshold'] },
      suggestedFollowUps: [
        rows[0] ? `Evaluate credit risk for ${rows[0].ID}` : 'Evaluate credit risk for C001',
        'Customers above 80% utilisation',
        'Exposure by country'
      ]
    };

    const check = verifyResponseAgainstPlan({ intent: primary, display }, result);
    return check.valid ? result : { ...buildPlanClarifyFallback(intentInfo.alternatives), dataProvenance: baseProvenance };
  }

  if (primary === 'CUSTOMER_EVALUATION') {
    const targetId = entities.customerIds?.[0] || entities.customerId || 'C001';
    if (/^MS-C\d+/i.test(targetId) && wsCtx?.executeWorkspacePlan) {
      const mockResp = wsCtx.executeWorkspacePlan({ ...intentInfo, entity: 'mock_sap_staging' }, state, { sessionRuns: sessionExtractionRuns, rawQuestion: question });
      if (mockResp) return mockResp;
    }
    const c = customers.find(item => item.ID === targetId);
    if (!c) {
      return {
        intent: { primary: 'CLARIFY', secondary: [], confidence: 0.6 },
        title: '',
        summary: `Customer ${targetId} was not found in Credit Guard (valid IDs are C001–C013). Did you mean:`,
        headlineBullets: [],
        blocks: [],
        assumptions: [],
        limitations: [],
        dataProvenance: baseProvenance,
        suggestedFollowUps: [
          'Evaluate credit risk for C001',
          'List out customers along with credit limit',
          'Customers above 80% utilisation'
        ]
      };
    }

    const openReqs = (state?.requests || []).filter(r => String(r.customer_ID || '').toUpperCase() === c.ID);

    return {
      intent: { primary: 'CUSTOMER_EVALUATION', secondary: [], confidence: 0.97 },
      showTableAboveFold: true,
      title: `Customer Credit Evaluation: ${c.name} (${c.ID})`,
      summary: `${c.name} (${c.ID}) has ${formatIndianCurrency(c.exposure)} exposure against a ${formatIndianCurrency(c.creditLimit)} credit limit (${c.utilisationDisplay} utilisation), ${formatIndianCurrency(c.overdueAmount)} overdue, and status ${c.status}.`,
      headlineBullets: [],
      blocks: [
        {
          type: 'keyValue',
          title: `Account Profile · ${c.name} (${c.ID})`,
          items: [
            { label: 'Customer ID', value: c.ID, valueKind: 'ACTUAL' },
            { label: 'Country / CoCode', value: `${c.country} / ${c.companyCode}`, valueKind: 'ACTUAL' },
            { label: 'Credit Limit', value: formatIndianCurrency(c.creditLimit), valueKind: 'ACTUAL' },
            { label: 'Total Exposure', value: formatIndianCurrency(c.exposure), valueKind: 'CALCULATED' },
            { label: 'Utilisation', value: c.utilisationDisplay, valueKind: 'CALCULATED' },
            { label: 'Available Headroom', value: c.isNoLimit ? 'N/A (No limit)' : formatIndianCurrency(c.availableCredit), valueKind: 'CALCULATED' },
            { label: 'Overdue Balance', value: `${formatIndianCurrency(c.overdueAmount)} (${c.overdueInvoiceCount} inv)`, valueKind: 'CALCULATED' },
            { label: 'Risk Class / Flags', value: `${c.riskClass} · ${c.flags.join(', ') || 'None'}`, valueKind: 'CALCULATED' }
          ]
        },
        ...(openReqs.length ? [{
          type: 'table',
          title: `Limit Requests for ${c.ID}`,
          columns: [
            { key: 'ID', label: 'Request ID', align: 'left', format: 'text' },
            { key: 'currentLimit', label: 'Current Limit', align: 'right', format: 'currency' },
            { key: 'requestedLimit', label: 'Requested Limit', align: 'right', format: 'currency' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' }
          ],
          rows: openReqs
        }] : [])
      ],
      assumptions: ['Customer exposure is aggregated from unpaid invoices and open sales orders in INR.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_customer'] },
      suggestedFollowUps: [
        `Should we approve a limit increase for ${c.ID}?`,
        `Draft limit request for ${c.ID} to ${Math.max(1500000, c.creditLimit + 300000)} because of contract volume`,
        'Customers above 80% utilisation'
      ]
    };
  }

  if (primary === 'LIMIT_REQUEST_DRAFT' || primary === 'LIMIT_INCREASE_RECOMMENDATION') {
    const targetId = entities.customerIds?.[0] || entities.customerId;
    const c = targetId ? customers.find(item => item.ID === targetId) : null;
    if (!c) {
      return {
        intent: { primary: 'CLARIFY', secondary: [], confidence: 0.55 },
        title: '',
        summary: 'Please clarify which customer and target credit limit you want to evaluate or draft:',
        clarifyTip: 'Example: "Should we approve a limit increase for C001 to INR 1500000?"',
        headlineBullets: [],
        blocks: [],
        assumptions: [],
        limitations: [],
        dataProvenance: baseProvenance,
        suggestedFollowUps: [
          'Should we approve a limit increase for C001?',
          'Evaluate credit risk for C002',
          'Pending limit approvals'
        ]
      };
    }

    const proposedLimit = entities.requestedAmount && entities.requestedAmount > 0
      ? entities.requestedAmount
      : Math.max(Math.ceil((c.exposure * 1.25) / 50000) * 50000, c.creditLimit > 0 ? Math.round(c.creditLimit * 1.2) : 500000);
    const projectedUtil = proposedLimit > 0 ? Number(((c.exposure / proposedLimit) * 100).toFixed(1)) : 0;
    const overdueSharePct = c.exposure > 0 ? Number(((c.overdueAmount / c.exposure) * 100).toFixed(1)) : 0;
    const decision = c.isNoLimit
      ? 'MANUAL_REVIEW'
      : (overdueSharePct > 30 || c.riskClass === 'C' || c.riskClass === 'High')
        ? 'REJECT'
        : (c.overdueAmount > 0 ? 'CONDITIONAL_APPROVAL' : 'APPROVE');

    return {
      intent: { primary, secondary: [], confidence: 0.96 },
      showTableAboveFold: true,
      title: `${primary === 'LIMIT_REQUEST_DRAFT' ? 'Draft Credit Limit Request' : 'Policy Limit Recommendation'}: ${c.name} (${c.ID})`,
      summary: `Policy recommendation for ${c.name} (${c.ID}) at ${formatIndianCurrency(proposedLimit)} is ${decision}: utilisation moves from ${c.utilisationDisplay} to ${projectedUtil.toFixed(1)}% (Advisory only · executed: false).`,
      headlineBullets: [],
      blocks: [
        {
          type: 'comparison',
          title: `Current vs Projected (${c.name} · ${c.ID})`,
          simulation: true,
          columns: ['Metric', 'Current (Actual)', 'Projected (Simulated)', 'Delta'],
          rows: [
            { metric: 'Credit Limit', current: formatIndianCurrency(c.creditLimit), projected: formatIndianCurrency(proposedLimit), delta: formatIndianCurrency(proposedLimit - c.creditLimit), valueKind: 'SIMULATED' },
            { metric: 'Credit Exposure', current: formatIndianCurrency(c.exposure), projected: formatIndianCurrency(c.exposure), delta: '₹0', valueKind: 'ACTUAL' },
            { metric: 'Utilisation %', current: c.utilisationDisplay, projected: `${projectedUtil.toFixed(1)}%`, delta: c.isNoLimit ? 'Configures limit' : `${(projectedUtil - c.utilisationPct).toFixed(1)} pts`, valueKind: 'SIMULATED' }
          ]
        },
        {
          type: 'recommendation',
          decision,
          policyChecks: [
            { rule: 'Overdue Share <= 30%', status: overdueSharePct <= 30 ? 'PASS' : 'FAIL', detail: `${overdueSharePct.toFixed(1)}% overdue (${formatIndianCurrency(c.overdueAmount)})` },
            { rule: 'Risk Class Eligibility', status: c.riskClass === 'C' ? 'WARN' : 'PASS', detail: `Risk Class ${c.riskClass}` },
            { rule: 'Approval Authority Routing', status: 'PASS', detail: proposedLimit - c.creditLimit > 500000 && (c.creditLimit === 0 || (proposedLimit - c.creditLimit) / c.creditLimit > 0.25) ? 'Finance Head approval required' : 'Credit Controller approval eligible' }
          ],
          advisoryNote: 'Advisory preview only; submit via Limit Approvals for human sign-off.',
          draftAction: {
            label: `Prefill Limit Request for ${c.ID} (${formatIndianCurrency(proposedLimit)})`,
            prompt: `Prepare a credit limit request for ${c.ID} to INR ${proposedLimit} because ${c.name} requires expanded credit headroom.`
          }
        }
      ],
      assumptions: ['Advisory simulation only; no Credit Guard or SAP limit record has been modified.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_customer'] },
      suggestedFollowUps: [
        `Evaluate credit risk for ${c.ID}`,
        'Pending limit approvals',
        'Customers above 80% utilisation'
      ]
    };
  }

  if (primary === 'LIMIT_APPROVALS_STATUS') {
    const reqs = Array.isArray(state?.requests) ? state.requests : [];
    const pendingReqs = reqs.filter(r => r.status === 'Pending');
    return {
      intent: { primary: 'LIMIT_APPROVALS_STATUS', secondary: [], confidence: 0.96 },
      showTableAboveFold: true,
      title: 'Credit Limit Approval Requests',
      summary: `${pendingReqs.length} pending and ${reqs.length - pendingReqs.length} decided credit-limit requests (${reqs.length} total) in Limit Approvals.`,
      headlineBullets: [],
      blocks: [
        {
          type: 'table',
          title: 'Credit Limit Change Requests',
          columns: [
            { key: 'customer', label: 'Customer', align: 'left', format: 'text' },
            { key: 'ID', label: 'ID', align: 'left', format: 'text' },
            { key: 'currentLimit', label: 'Current Limit', align: 'right', format: 'currency' },
            { key: 'requestedLimit', label: 'Requested Limit', align: 'right', format: 'currency' },
            { key: 'approverLevel', label: 'Approver Role', align: 'left', format: 'text' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' }
          ],
          rows: reqs.map(r => ({
            customer: r.customerName || r.customer_ID || 'Customer',
            ID: r.customer_ID || r.ID,
            currentLimit: Number(r.currentLimit || 0),
            requestedLimit: Number(r.requestedLimit || 0),
            approverLevel: r.approverLevel || 'Credit Controller',
            status: r.status || 'Pending'
          }))
        }
      ],
      assumptions: ['All limit updates require authorized human approval in the Limit Approvals tab.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['list_limit_requests'] },
      suggestedFollowUps: [
        'Should we approve a limit increase for C001?',
        'Customers above 80% utilisation',
        'Overdue invoices'
      ]
    };
  }

  if (primary === 'MONITORING_ALERTS') {
    const alerts = state?.monitoringData?.alerts || [];
    return {
      intent: { primary: 'MONITORING_ALERTS', secondary: [], confidence: 0.95 },
      showTableAboveFold: true,
      title: 'Active Credit Monitoring Alerts',
      summary: `${alerts.length} monitoring ${alerts.length === 1 ? 'alert' : 'alerts'} currently tracked (${alerts.filter(a => a.status === 'ACTIVE').length} active).`,
      headlineBullets: [],
      blocks: [
        ...(alerts.length > 0 ? [{
          type: 'alerts',
          title: 'Monitoring Alerts',
          items: alerts.map(a => ({
            severity: a.severity || 'WARNING',
            customerId: a.customer_ID || a.customerId,
            title: a.title || a.alertType || 'Credit Threshold Alert',
            status: a.status || 'ACTIVE',
            description: a.message || a.description || '',
            recommendedAction: a.recommendedAction || 'Review customer exposure and overdue items.',
            detectedAt: a.detectedAt || a.createdAt
          }))
        }] : [{
          type: 'notice',
          severity: 'info',
          title: 'No Monitoring Alerts Found',
          message: 'No active monitoring alerts are recorded yet. Run monitoring in Portfolio & Monitoring to evaluate thresholds.'
        }])
      ],
      assumptions: ['Alerts follow FIN-FSCM-AUTONOMOUS-POLICY-V1 thresholds (80% warning, 100% breach, 120% critical).'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_monitoring_alerts'] },
      suggestedFollowUps: [
        'Analyze the latest monitoring run',
        'Customers above 80% utilisation',
        'Overdue invoices'
      ]
    };
  }

  if (primary === 'POLICY_EXPLANATION') {
    return {
      intent: { primary: 'POLICY_EXPLANATION', secondary: [], confidence: 0.97 },
      title: 'Policy & Credit Calculation Reference (FIN-FSCM-AUTONOMOUS-POLICY-V1)',
      summary: `Credit Guard evaluates all ${customers.length} active customers (${formatIndianCurrency(totalExposure)} exposure / ${formatIndianCurrency(totalCreditLimit)} limit, ${overallUtilisationPct.toFixed(1)}% utilisation) using deterministic FIN-FSCM-CR rules.`,
      headlineBullets: [
        'Utilisation Formula: (Total Open Receivables & Orders ÷ Credit Limit) × 100%',
        'Thresholds: Healthy < 80% · Warning 80%–99.9% · Breached ≥ 100% · Critical ≥ 120%',
        'Zero-Limit Rule: Accounts with ₹0 limit are flagged N/A (MANUAL_REVIEW)',
        'Approval Routing: <= 25% or <= ₹5,00,000 increase routes to Credit Controller; higher increases route to Finance Head'
      ],
      blocks: [
        {
          type: 'keyValue',
          title: 'Deterministic Policy Thresholds (FIN-FSCM-AUTONOMOUS-POLICY-V1)',
          items: [
            { label: 'Active Portfolio Customers', value: `${customers.length} customers`, valueKind: 'CALCULATED' },
            { label: 'Warning Threshold', value: '80.0% – 99.9% utilisation', valueKind: 'ACTUAL' },
            { label: 'Breach Threshold', value: '>= 100.0% utilisation', valueKind: 'ACTUAL' },
            { label: 'Critical Threshold', value: '>= 120.0% utilisation', valueKind: 'ACTUAL' },
            { label: 'Controller Increase Cap', value: '<= 25% or <= ₹5,00,000 increase', valueKind: 'ACTUAL' }
          ]
        }
      ],
      assumptions: [],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_portfolio_summary'] },
      suggestedFollowUps: [
        'Customers above 80% utilisation',
        'Exposure by country',
        'Give me our data sources and connectivity status'
      ]
    };
  }

  if (primary === 'AUDIT_HISTORY') {
    const executions = state?.agentHistory?.executions || [];
    const conversations = state?.agentHistory?.conversations || [];
    return {
      intent: { primary: 'AUDIT_HISTORY', secondary: [], confidence: 0.95 },
      showTableAboveFold: true,
      title: 'Agent Audit & Execution History',
      summary: `${executions.length} recent agent execution ${executions.length === 1 ? 'run' : 'runs'} and ${conversations.length} saved conversations recorded.`,
      headlineBullets: [],
      blocks: [
        ...(executions.length > 0 ? [{
          type: 'table',
          title: 'Recent Agent Executions',
          columns: [
            { key: 'startedAt', label: 'Started At', align: 'left', format: 'text' },
            { key: 'status', label: 'Status', align: 'left', format: 'badge' },
            { key: 'planStatus', label: 'Plan Status', align: 'left', format: 'text' },
            { key: 'stepCount', label: 'Steps', align: 'right', format: 'number' },
            { key: 'recoveryStatus', label: 'Recovery', align: 'left', format: 'text' }
          ],
          rows: executions.slice(0, 10).map(e => ({
            startedAt: String(e.startedAt || '').slice(0, 19).replace('T', ' '),
            status: String(e.status || 'COMPLETED').toUpperCase(),
            planStatus: e.planStatus || 'COMPLETED',
            stepCount: Number(e.stepCount || 0),
            recoveryStatus: e.recoveryStatus || 'NOT_AVAILABLE'
          }))
        }] : [{
          type: 'notice',
          severity: 'info',
          title: 'Audit History',
          message: 'Agent execution history is tracked in the AI Audit History tab.'
        }])
      ],
      assumptions: ['Audit records reflect persisted CAP execution logs.'],
      limitations: [],
      dataProvenance: { ...baseProvenance, toolsInvoked: ['get_agent_history'] },
      suggestedFollowUps: [
        'Give me our data sources and connectivity status',
        'Customers above 80% utilisation',
        'Portfolio summary'
      ]
    };
  }

  // Default: MONITORING_ANALYSIS
  const breached = customers.filter(c => !c.isNoLimit && c.utilisationPct >= 100);
  const warning = customers.filter(c => !c.isNoLimit && c.utilisationPct >= 80 && c.utilisationPct < 100);
  const noLimit = customers.filter(c => c.isNoLimit);
  const overdue = customers.filter(c => c.overdueAmount > 0);
  const flagged = [...breached, ...warning, ...noLimit].sort((a, b) => (b.utilisationPct ?? 999) - (a.utilisationPct ?? 999));

  return {
    intent: { primary: 'MONITORING_ANALYSIS', secondary: [], confidence: 0.95 },
    showTableAboveFold: true,
    title: 'Portfolio Monitoring & Risk Summary',
    summary: `Across ${customers.length} monitored customers, ${breached.length} are breached (>=100%), ${warning.length} are in warning (80–99.9%), ${noLimit.length} has no limit set, and ${overdue.length} have overdue balances.`,
    headlineBullets: [],
    blocks: [
      {
        type: 'table',
        title: `Flagged Portfolio Accounts (${flagged.length})`,
        columns: buildCustomerTableColumns(),
        rows: flagged.map(toCustomerTableRow)
      }
    ],
    assumptions: ['Monitoring thresholds follow deterministic FIN-FSCM-AUTONOMOUS-POLICY-V1 rules.'],
    limitations: [],
    dataProvenance: { ...baseProvenance, toolsInvoked: ['get_monitoring_analysis'] },
    suggestedFollowUps: [
      'Customers above 80% utilisation',
      'Overdue invoices',
      'Exposure by country'
    ]
  };
}

export function parseCurrencyNumber(str) {
  if (!str) return null;
  const clean = String(str).replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();
  const match = clean.replace(/₹|INR|,|\s/g, '').match(/[-+]?\d*\.?\d+/);
  if (match) {
    const val = parseFloat(match[0]);
    return isNaN(val) ? null : val;
  }
  return null;
}

export function formatIndianCurrency(num) {
  if (num === null || num === undefined || isNaN(Number(num))) return '—';
  return '₹' + Number(num).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export function parseUtilPercent(cell) {
  if (!cell) return null;
  const clean = String(cell).replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();
  if (/N\/A|no\s*limit/i.test(clean)) return null;
  const match = clean.match(/([\d.]+)\s*%/);
  if (match) return parseFloat(match[1]);
  const numMatch = clean.match(/[\d.]+/);
  if (numMatch) {
    const val = parseFloat(numMatch[0]);
    if (val > 0 && val <= 1 && !clean.includes('100')) return Math.round(val * 100);
    return val;
  }
  return null;
}

export function formatBadge(term) {
  const clean = String(term || '').trim().replace(/^[*_`]+|[*_`]+$/g, '');
  const upper = clean.toUpperCase();
  if (upper === 'BREACH' || upper === 'BREACHED' || upper === 'CRITICAL') {
    return `<span class="ai-badge badge-red">${escapeHTML(clean)}</span>`;
  }
  if (upper === 'WARNING' || upper === 'OVERDUE_RISK' || upper === 'STALE_REVIEW' || upper === 'MANUAL_REVIEW') {
    return `<span class="ai-badge badge-amber">${escapeHTML(clean)}</span>`;
  }
  if (upper === 'OVERDUE_AMOUNT' || upper === 'OVERDUE') {
    return `<span class="ai-badge badge-orange">${escapeHTML(clean)}</span>`;
  }
  if (upper === 'OK' || upper === 'HEALTHY' || upper === 'NORMAL' || upper === 'COMPLETED') {
    return `<span class="ai-badge badge-green">${escapeHTML(clean)}</span>`;
  }
  return `<span class="ai-badge badge-gray">${escapeHTML(clean)}</span>`;
}

export function formatRiskFlagsCell(cellText) {
  if (!cellText || cellText === '—' || cellText === '-') return '<span class="muted">—</span>';
  const parts = cellText.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return escapeHTML(cellText);
  return `<div class="badge-group" style="display: flex; flex-wrap: wrap; gap: 4px;">${parts.map(p => formatBadge(p)).join('')}</div>`;
}

export function formatStatusCell(cellText) {
  if (!cellText) return '';
  return formatBadge(cellText);
}

export function formatCustomerCell(cellText) {
  if (!cellText) return '';
  const clean = String(cellText).replace(/[*_`]/g, '').trim();
  const idMatch = clean.match(/\b((?:MS-)?C\d{3})\b/i);
  if (idMatch) {
    const id = idMatch[1].toUpperCase();
    const name = clean.replace(idMatch[0], '').replace(/[()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name) {
      return `<div class="ai-customer-cell"><strong class="ai-customer-name">${escapeHTML(name)}</strong><code class="ai-id-chip">${escapeHTML(id)}</code></div>`;
    }
    return `<code class="ai-id-chip">${escapeHTML(id)}</code>`;
  }
  return `<strong>${escapeHTML(clean)}</strong>`;
}

export function formatCurrencyCell(cellText) {
  if (!cellText || cellText === '—' || cellText === '-') return '<span class="muted">—</span>';
  const num = parseCurrencyNumber(cellText);
  if (num !== null && !isNaN(num)) {
    return `<span class="tabular-num">${formatIndianCurrency(num)}</span>`;
  }
  return escapeHTML(cellText);
}

export function formatUtilisationCell(cellText) {
  const pct = parseUtilPercent(cellText);
  if (pct === null || isNaN(pct)) return escapeHTML(cellText);
  const colorClass = pct >= 100 ? 'breach' : pct >= 80 ? 'warning' : 'healthy';
  const cappedWidth = Math.min(100, Math.max(0, pct));
  return `<div class="ai-util-cell">
    <div class="ai-util-bar-track">
      <div class="ai-util-bar-fill ${colorClass}" style="width: ${cappedWidth}%;"></div>
    </div>
    <span class="ai-util-label ${colorClass}">${pct}%</span>
  </div>`;
}

export function formatInline(text) {
  if (!text) return '';
  let out = text;

  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (match, code) => {
    const placeholder = `___AI_CODE_${codeSpans.length}___`;
    codeSpans.push(`<code class="ai-inline-code">${code}</code>`);
    return placeholder;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\b((?:MS-)?C\d{3})\b/g, '<code class="ai-id-chip">$1</code>');
  out = out.replace(/(₹\s*[\d,]+(?:\.\d+)?|\bINR\s*[\d,]+(?:\.\d+)?)/g, '<strong class="tabular-num">$1</strong>');
  out = out.replace(/\b(\d+(?:\.\d+)?%)\b/g, (match, pct) => {
    const val = parseFloat(pct);
    const cls = val >= 100 ? 'badge-red' : val >= 80 ? 'badge-amber' : 'badge-green';
    return `<span class="ai-badge ${cls}">${pct}</span>`;
  });

  out = out.replace(/\b(BREACH|BREACHED|CRITICAL)\b/g, '<span class="ai-badge badge-red">$1</span>');
  out = out.replace(/\b(WARNING|OVERDUE_RISK|STALE_REVIEW|MANUAL_REVIEW)\b/g, '<span class="ai-badge badge-amber">$1</span>');
  out = out.replace(/\b(OVERDUE_AMOUNT|OVERDUE)\b/g, '<span class="ai-badge badge-orange">$1</span>');
  out = out.replace(/\b(HEALTHY|NORMAL|COMPLETED)\b/g, '<span class="ai-badge badge-green">$1</span>');
  out = out.replace(/\b(OK)\b/g, '<span class="ai-badge badge-green">$1</span>');

  for (let i = 0; i < codeSpans.length; i++) {
    out = out.replace(`___AI_CODE_${i}___`, codeSpans[i]);
  }

  return out;
}

function parseTableRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(cell => cell.trim());
}

function isTableLine(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

function isSeparatorLine(line) {
  const t = line.trim();
  return /^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(t);
}

export function renderMarkdownTableBlock(tableLines) {
  if (tableLines.length < 2) return '';
  const rawHeaders = parseTableRow(tableLines[0]);
  const colNames = rawHeaders.map(h => h.toLowerCase().replace(/[*_`]/g, '').trim());

  let customerColIdx = colNames.findIndex(h => h.includes('customer') || h.includes('client') || h.includes('account'));
  if (customerColIdx === -1 && colNames.length > 0) customerColIdx = 0;

  const limitColIdx = colNames.findIndex(h => h.includes('limit'));
  const exposureColIdx = colNames.findIndex(h => h.includes('exposure'));
  const utilColIdx = colNames.findIndex(h => h.includes('util'));
  const statusColIdx = colNames.findIndex(h => h.includes('status'));
  const flagsColIdx = colNames.findIndex(h => h.includes('flag') || h.includes('risk'));
  const overdueColIdx = colNames.findIndex(h => h.includes('overdue'));

  const dataRows = [];
  for (let i = 2; i < tableLines.length; i++) {
    const line = tableLines[i];
    if (!isTableLine(line)) continue;
    const cells = parseTableRow(line);
    if (cells.length > 0) {
      dataRows.push(cells);
    }
  }

  const headersHtml = rawHeaders.map((h, i) => {
    const isRight = (i === limitColIdx || i === exposureColIdx || i === overdueColIdx || i === utilColIdx);
    return `<th class="${isRight ? 'text-right' : 'text-left'}">${escapeHTML(h)}</th>`;
  }).join('');

  const rowsHtml = dataRows.map(cells => {
    const cellsHtml = cells.map((cell, i) => {
      if (i === customerColIdx) {
        return `<td class="text-left">${formatCustomerCell(cell)}</td>`;
      }
      if (i === limitColIdx || i === exposureColIdx || i === overdueColIdx) {
        return `<td class="text-right tabular-num">${formatCurrencyCell(cell)}</td>`;
      }
      if (i === utilColIdx) {
        return `<td class="text-right">${formatUtilisationCell(cell)}</td>`;
      }
      if (i === statusColIdx) {
        return `<td class="text-left">${formatStatusCell(cell)}</td>`;
      }
      if (i === flagsColIdx) {
        return `<td class="text-left">${formatRiskFlagsCell(cell)}</td>`;
      }
      return `<td class="text-left">${formatInline(escapeHTML(cell))}</td>`;
    }).join('');
    return `<tr class="ai-table-row">${cellsHtml}</tr>`;
  }).join('');

  return `
<div class="ai-table-wrap">
  <table class="ai-table">
    <thead><tr>${headersHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>`;
}

export function formatAssistantReply(rawText) {
  if (!rawText) return '';
  try {
    let text = String(rawText);

    const footerLines = [];
    text = text.replace(/\n*(?:Execution status:\s*([^\n]+)|Plan status:\s*([^\n]+))/gi, (match, s1, s2) => {
      const status = (s1 || s2 || '').trim();
      if (status) footerLines.push(`Execution status: ${status}`);
      return '';
    });

    text = text.replace(/\n*(?:Modules used:\s*([^\n]+))/gi, (match, modules) => {
      if (modules.trim()) footerLines.push(`Modules used: ${modules.trim()}`);
      return '';
    });

    text = text.replace(/\n*(?:Data sources:\s*([^\n]+))/gi, (match, sources) => {
      if (sources.trim()) footerLines.push(`Data sources: ${sources.trim()}`);
      return '';
    });

    text = text.replace(/\n*Response provider:\s*[^\n]*/gi, '');

    let advisoryHtml = '';
    const advisoryRegex = /(?:###?\s*(?:Important Information(?:\s*\/\s*Advisory)?|Advisory|Notice|Disclaimer)[^\n]*|(?:\*\*|__)(?:Important Information(?:\s*\/\s*Advisory)?|Advisory|Notice|Disclaimer):?(?:\*\*|__)|(?:Important Information(?:\s*\/\s*Advisory)?|Advisory):\s*)([\s\S]*?)(?=(?:###|\n\n(?:---|___|\*\*\*)|$))/i;

    const advMatch = text.match(advisoryRegex);
    if (advMatch) {
      const advContent = advMatch[1].trim();
      if (advContent) {
        const cleanAdv = formatInline(escapeHTML(advContent).replace(/\n/g, '<br>'));
        advisoryHtml = `
<details class="ai-advisory-box">
  <summary class="ai-advisory-summary">
    <span class="ai-advisory-icon" aria-hidden="true">ℹ️</span>
    <span class="ai-advisory-title">Important Information / Advisory</span>
    <span class="ai-advisory-hint">(click to expand)</span>
  </summary>
  <div class="ai-advisory-content">
    ${cleanAdv}
  </div>
</details>`;
        text = text.replace(advMatch[0], '');
      }
    }

    const lines = text.split(/\r?\n/);
    const blocksHtml = [];
    let i = 0;
    let isFirstParagraph = true;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      if (isTableLine(line) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && isTableLine(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        blocksHtml.push(renderMarkdownTableBlock(tableLines));
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = formatInline(escapeHTML(headingMatch[2]));
        const tag = level === 1 ? 'h2' : level === 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
        blocksHtml.push(`<${tag} class="ai-heading-${level}">${headingText}</${tag}>`);
        i++;
        continue;
      }

      if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
        blocksHtml.push('<hr class="ai-divider">');
        i++;
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const listItems = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^[-*]\s+/, '');
          listItems.push(`<li>${formatInline(escapeHTML(itemText))}</li>`);
          i++;
        }
        blocksHtml.push(`<ul class="ai-list">${listItems.join('')}</ul>`);
        continue;
      }

      if (/^(?:\d+\.|\(\d+\))\s+/.test(trimmed)) {
        const listItems = [];
        while (i < lines.length && /^(?:\d+\.|\(\d+\))\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^(?:\d+\.|\(\d+\))\s+/, '');
          listItems.push(`<li>${formatInline(escapeHTML(itemText))}</li>`);
          i++;
        }
        blocksHtml.push(`<ol class="ai-list numbered">${listItems.join('')}</ol>`);
        continue;
      }

      const paraLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isTableLine(lines[i]) && !lines[i].trim().startsWith('#') && !/^[-*]\s+/.test(lines[i].trim()) && !/^(?:\d+\.|\(\d+\))\s+/.test(lines[i].trim()) && !/^(?:---|\*\*\*|___)\s*$/.test(lines[i].trim())) {
        paraLines.push(lines[i]);
        i++;
      }
      const rawPara = paraLines.join(' ');
      const pClass = isFirstParagraph ? 'ai-paragraph ai-summary-sentence' : 'ai-paragraph';
      isFirstParagraph = false;
      blocksHtml.push(`<p class="${pClass}">${formatInline(escapeHTML(rawPara))}</p>`);
    }

    let footerHtml = '';
    if (footerLines.length > 0) {
      footerHtml = `
<footer class="ai-answer-footer">
  ${footerLines.map(line => `<span class="ai-footer-item">${escapeHTML(line)}</span>`).join(' <span class="ai-footer-dot">·</span> ')}
</footer>`;
    }

    return `<div class="structured-assistant-reply">${blocksHtml.join('')}${advisoryHtml}${footerHtml}</div>`;
  } catch (error) {
    console.error('Markdown rendering error:', error);
    return `<div class="structured-assistant-reply"><p class="ai-paragraph">${escapeHTML(rawText).replace(/\n/g, '<br>')}</p></div>`;
  }
}

function handleFollowUpInteraction(promptText, { fillOnly = false } = {}) {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const input = document.querySelector('#chat-input');
  const form = document.querySelector('#chat-form');
  if (!input) return;
  input.value = String(promptText || '').trim();
  if (typeof input.focus === 'function') input.focus();
  if (!fillOnly && form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else if (!fillOnly && form && typeof form.dispatchEvent === 'function' && typeof Event === 'function') {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
}

function formatFallbackCategoryShort(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('timeout')) return 'timeout';
  if (r.includes('rate_limit') || r.includes('quota') || r.includes('429')) return 'quota';
  return 'network';
}

const NO_BADGE_INTENTS = new Set([
  'GREETING',
  'HOW_ARE_YOU',
  'THANKS',
  'GOODBYE',
  'HELP',
  'OFF_TOPIC',
  'OUT_OF_SCOPE',
  'CLARIFY',
  'UNKNOWN'
]);

function buildProvenanceHeaderNode(message, structured) {
  if (message.role !== 'assistant') return null;

  const primaryIntent = structured?.intent?.primary || '';
  if (NO_BADGE_INTENTS.has(primaryIntent)) {
    return null;
  }

  const hasLegacyProvider = Boolean(message.provider);
  const isActualFailure = Boolean(
    message.providerFallbackReason
    && !['provider_not_configured', 'offline_configured'].includes(message.providerFallbackReason)
  ) || (message.provider === 'offline' && Boolean(message.providerFallback));

  if (!hasLegacyProvider && !message.localCalculation && !structured) {
    return null;
  }

  const children = [];

  // Enforce STRICTLY ONE source badge per data answer
  if (isActualFailure) {
    const shortReason = formatFallbackCategoryShort(message.providerFallbackReason);
    const humanReason = message.providerFallbackReason
      ? message.providerFallbackReason.replaceAll('_', ' ')
      : 'provider unavailable';
    children.push(createEl('span', {
      className: 'chip review re-badge-offline-fallback',
      text: 'Offline fallback',
      attrs: {
        title: `Gemini failed after retry (${shortReason}: ${humanReason})`
      }
    }));
    children.push(createEl('button', {
      className: 're-retry-gemini-btn',
      text: 'Retry with Gemini',
      attrs: {
        type: 'button',
        'data-retry-gemini': 'true',
        title: `Reason: ${shortReason} (${humanReason}). Click to retry with Gemini.`
      },
      dataset: {
        question: message.questionText || ''
      }
    }));
  } else if (message.headlinePolished || message.provider === 'gemini') {
    children.push(createEl('span', {
      className: 'chip healthy re-badge-gemini-polished',
      text: 'Gemini-polished'
    }));
  } else {
    const tabLabel = message.structuredResponse?.sourceTabLabel;
    const useTabName = tabLabel && ['SAP BTP & HANA CDS', 'Limit Approvals', 'AI Audit History', 'Portfolio & Monitoring'].includes(tabLabel);
    const badgeText = useTabName ? `Calculated from ${tabLabel} data` : 'Calculated from portfolio data';
    children.push(createEl('span', {
      className: 're-badge-calculated-local',
      text: badgeText
    }));
  }

  children.push(createEl('span', {
    className: 'ai-badge badge-amber',
    text: 'DEMO DATA'
  }));

  if (message.modulesUsed?.length) {
    children.push(createEl('span', {
      className: 're-prov-chip',
      text: `Modules: ${message.modulesUsed.join(', ')}`
    }));
  }
  if (message.dataSourcesUsed?.length) {
    children.push(createEl('span', {
      className: 're-prov-chip',
      text: `Sources: ${message.dataSourcesUsed.map(source => source.name).join(', ')}`
    }));
  }

  return createEl('small', { className: 'chat-provenance re-chat-provenance' }, children);
}

export function renderChat(messages, execution = null, permissions = null, { skipScroll = false } = {}) {
  const host = document.querySelector('#chat-messages');
  if (!host) return;
  if (!messages.length) {
    const emptyEl = createEl('p', {
      className: 'empty-state',
      text: 'Ask about exposure, flagged customers, overdue invoices, or a customer ID such as C001. The assistant provides concise, answer-first analytics calculated directly from portfolio data.'
    });
    if (typeof host.replaceChildren === 'function' && typeof document.createElement === 'function') {
      host.replaceChildren(emptyEl);
    } else {
      host.innerHTML = '<p class="empty-state">Ask about exposure, flagged customers, overdue invoices, or a customer ID such as C001. The assistant provides concise, answer-first analytics calculated directly from portfolio data.</p>';
    }
    return;
  }

  const canUseDOM = typeof document !== 'undefined'
    && typeof document.createElement === 'function'
    && typeof host.appendChild === 'function';

  const cardNodes = messages.map((message, idx) => {
    const isUser = message.role === 'user';
    const card = createEl('div', {
      className: `chat-message ${isUser ? 'user' : 'assistant'}`
    });

    const structured = message.structuredResponse
      || (idx === messages.length - 1 && !isUser ? execution?.structuredResponse : null);

    if (isUser) {
      card.appendChild(createEl('div', {
        className: 'chat-role-label user-role-label',
        text: 'You'
      }));
      card.appendChild(createEl('p', {
        className: 're-user-question-text',
        text: message.text || ''
      }));
    } else {
      const headerRow = createEl('div', { className: 'chat-assistant-header-row' }, [
        createEl('span', {
          className: 'chat-role-label assistant-role-label',
          text: 'Credit Guard AI'
        })
      ]);
      const provNode = buildProvenanceHeaderNode(message, structured);
      if (provNode) headerRow.appendChild(provNode);
      card.appendChild(headerRow);

      if (structured && typeof structured === 'object') {
        const domBody = renderStructuredResponseDOM(structured, {
          onFollowUpClick: handleFollowUpInteraction
        });
        if (domBody) card.appendChild(domBody);
      } else {
        const cleanedText = message.provider
          ? String(message.text || '').replace(/\n\nResponse provider: [^\n]*$/, '')
          : String(message.text || '');
        card.appendChild(createEl('div', { className: 'structured-assistant-reply' }, [
          createEl('p', { className: 'ai-paragraph', text: cleanedText })
        ]));
      }
    }

    return card;
  });

  if (canUseDOM) {
    host.replaceChildren(...cardNodes);
  } else {
    host.innerHTML = cardNodes.map(node => (typeof node.toHTML === 'function' ? node.toHTML() : '')).join('');
  }

  renderExecution(execution, permissions);

  if (!skipScroll && typeof host?.querySelectorAll === 'function') {
    const allCards = host.querySelectorAll('.chat-message');
    const targetCard = allCards.length
      ? allCards[allCards.length - 1]
      : (host.lastElementChild || host);
    if (targetCard && typeof targetCard.scrollIntoView === 'function') {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function renderExecution(execution, permissions) {
  const host = document.querySelector('#agent-activity');
  if (!host) return;
  if (!execution) {
    host.innerHTML = `<div style="background: var(--color-white); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 1.5rem; box-shadow: var(--shadow-card);"><p class="muted" style="margin: 0; font-size: 0.95rem;">No AI execution yet. Ask a question in AI Credit Assistance to see the tool activity trace here.</p></div>`;
    return;
  }
  host.hidden = false;
  const statusStr = String(execution.status || '').toUpperCase();
  const isHealthy = statusStr === 'COMPLETED' || statusStr === 'SUCCESS';
  const steps = (execution.steps || []).map(step =>
    `<li style="margin-bottom: 0.35rem;"><strong>${escapeHTML(step.tool)}</strong> <span class="chip ${step.status === 'SUCCESS' ? 'healthy' : 'warning'}">${escapeHTML(step.status)}</span> — <span class="muted">${escapeHTML(step.summary)}</span></li>`
  ).join('');
  const proposals = (execution.preparedActions || []).map(proposal => `<article class="approval-item" style="border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem; background: var(--color-white);">
    <strong>Approval required: ${escapeHTML(proposal.customerName)} · <code>${escapeHTML(proposal.customerId)}</code></strong>
    <p class="muted" style="margin: 0.25rem 0;">${escapeHTML(proposal.reason)}</p>
    <p style="font-family: var(--font-mono); font-size: 0.85rem; margin: 0.25rem 0;">₹${escapeHTML(String(proposal.currentLimit))} → <strong>₹${escapeHTML(String(proposal.requestedLimit))}</strong> · Routed to <strong>${escapeHTML(proposal.approverLevel)}</strong></p>
    ${permissions?.canRequest ? `<button class="button primary" type="button" data-submit-proposal="true" data-proposal-index="${(execution.preparedActions || []).indexOf(proposal)}" style="margin-top: 0.5rem;">Submit request for human approval</button>` : ''}
  </article>`).join('');
  const preview = execution.workflowPreview;
  const workflow = preview ? `<section class="workflow-preview" style="background: var(--color-canvas); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem;">
    <h3 style="font-size: 1rem; margin-bottom: 0.25rem;">${escapeHTML(preview.name)} · Preview only</h3>
    <p class="muted" style="margin-bottom: 0.75rem;">${escapeHTML(preview.source)} No workflow steps have been executed.</p>
    <ol style="padding-left: 1.25rem;">${preview.steps.map(step => `<li style="margin-bottom: 0.5rem;">
      <strong>${escapeHTML(step.module)} · ${escapeHTML(step.operation)}</strong>
      <p class="workflow-step-details muted" style="margin: 0.15rem 0; font-size: 0.8rem;">Depends on: ${escapeHTML(step.dependsOn.length ? step.dependsOn.join(', ') : 'None')} · Roles: ${escapeHTML(step.requiredRoles.join(', '))} · Confirmation: ${escapeHTML(step.confirmation)}</p>
      <p class="workflow-step-details" style="margin: 0; font-size: 0.85rem;">Expected result: ${escapeHTML(step.expectedResult)}</p>
    </li>`).join('')}</ol>
    <ul class="workflow-limitations" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--color-muted);">${preview.limitations.map(limitation => `<li>${escapeHTML(limitation)}</li>`).join('')}</ul>
  </section>` : '';
  host.innerHTML = `<div style="background: var(--color-white); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem; box-shadow: var(--shadow-card);"><p style="font-weight: 600; margin-bottom: 0.5rem;">Execution Status: <span class="chip ${isHealthy ? 'healthy' : 'warning'}">${escapeHTML(execution.status)}</span></p>${steps ? `<p class="muted" style="font-size: 0.85rem; margin-bottom: 0.25rem;">Tool Activity Trace:</p><ul style="padding-left: 1.25rem; font-size: 0.85rem;">${steps}</ul>` : '<p class="muted">No tools invoked for this response.</p>'}${workflow}${proposals}</div>`;
}

async function fetchCsrfHeaderIfNeeded() {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return {};
  const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
  if (host === 'localhost' || host === '127.0.0.1') return {};
  if (cachedCsrfToken) return { 'X-CSRF-Token': cachedCsrfToken };
  try {
    const res = await fetch('/credit/index.html', { headers: { 'X-CSRF-Token': 'Fetch' } });
    const tok = res.headers?.get?.('X-CSRF-Token');
    if (tok && tok.toLowerCase() !== 'required') {
      cachedCsrfToken = tok;
      return { 'X-CSRF-Token': cachedCsrfToken };
    }
  } catch {
    // Ignore CSRF probe errors
  }
  return {};
}

async function postRouterJson(url, body, timeoutMs = GEMINI_ROUTER_TIMEOUT_MS) {
  if (customRouterAdapters?.postJson) {
    return customRouterAdapters.postJson(url, body, timeoutMs);
  }
  if (typeof fetch !== 'function') return null;
  const csrf = await fetchCsrfHeaderIfNeeded();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrf },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getRouterJson(url, timeoutMs = GEMINI_ROUTER_TIMEOUT_MS) {
  if (customRouterAdapters?.getJson) {
    return customRouterAdapters.getJson(url, timeoutMs);
  }
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ...(controller ? [{ signal: controller.signal }] : []));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callSendWithTimeoutAndRetry(send, message, documentContext, conversationId, {
  timeoutMs = GEMINI_TIMEOUT_MS,
  maxRetries = 1,
  retryDelayMs = GEMINI_RETRY_DELAY_MS
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    let timerId = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          const err = new Error('Gemini request timed out after 20s.');
          err.category = 'provider_timeout';
          reject(err);
        }, timeoutMs);
      });
      const result = await Promise.race([
        send(message, documentContext, conversationId),
        timeoutPromise
      ]);
      if (timerId) clearTimeout(timerId);
      const isRetryableFallback = result?.providerFallback
        && ['provider_timeout', 'provider_unavailable', 'rate_limited'].includes(result?.providerFallbackReason);
      if (isRetryableFallback && attempt < maxRetries) {
        continue;
      }
      return result;
    } catch (err) {
      if (timerId) clearTimeout(timerId);
      lastError = err;
    }
  }
  throw lastError || new Error('Request failed after retry.');
}

let retryDelegationAttached = false;
function attachRetryListenerIfNeeded(send, messages, documentContext, state) {
  if (retryDelegationAttached || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  retryDelegationAttached = true;
  document.addEventListener('click', async event => {
    const btn = event.target?.closest?.('[data-retry-gemini="true"]');
    if (!btn) return;
    const question = btn.dataset?.question || messages.filter(m => m.role === 'user').at(-1)?.text;
    if (!question) return;
    const status = document.querySelector('#chat-status');
    if (status) status.textContent = 'Thinking... Retrying with Gemini (5s timeout, 1 retry)…';
    btn.disabled = true;
    try {
      const lastAssistant = messages.filter(m => m.role === 'assistant').at(-1);
      const classifyRes = await postRouterJson('/api/ai/classify-intent', {
        message: question,
        context: state?._chatRouterContext || lastRouterContext
      });
      if (classifyRes?.usedGemini && classifyRes.intent && classifyRes.confidence >= 0.6) {
        const localParsed = classifyClientIntent(question, state, state?._chatRouterContext || lastRouterContext);
        const structured = buildLocalStructuredResponse(question, state, {
          primary: classifyRes.intent,
          intent: classifyRes.intent,
          confidence: classifyRes.confidence,
          entities: { ...(classifyRes.entities || {}), ...(classifyRes.entities?.customerId ? { customerIds: [classifyRes.entities.customerId] } : {}) },
          display: classifyRes.display || localParsed.display
        });
        if (structured && lastAssistant) {
          lastAssistant.structuredResponse = structured;
          lastAssistant.text = structured.summary;
          lastAssistant.provider = 'local';
          lastAssistant.providerFallback = false;
          lastAssistant.providerFallbackReason = null;
          renderChat(messages, state?.agentExecution, state?.session?.permissions);
          return;
        }
      }
      if (typeof send === 'function') {
        const result = await callSendWithTimeoutAndRetry(send, question, documentContext, state?.conversationId);
        if (lastAssistant && result) {
          const actualFail = Boolean(
            result.providerFallback
            && result.providerFallbackReason
            && !['provider_not_configured', 'offline_configured'].includes(result.providerFallbackReason)
          );
          lastAssistant.provider = actualFail ? 'offline' : (result.provider === 'gemini' ? 'gemini' : 'local');
          lastAssistant.providerFallback = actualFail;
          lastAssistant.providerFallbackReason = actualFail ? result.providerFallbackReason : null;
          if (result.structuredResponse) {
            lastAssistant.structuredResponse = result.structuredResponse;
          }
          renderChat(messages, state?.agentExecution, state?.session?.permissions);
        }
      }
    } catch (err) {
      const lastAssistant = messages.filter(m => m.role === 'assistant').at(-1);
      if (lastAssistant) {
        lastAssistant.provider = 'offline';
        lastAssistant.providerFallback = true;
        lastAssistant.providerFallbackReason = err?.category || 'provider_timeout';
        renderChat(messages, state?.agentExecution, state?.session?.permissions);
      }
    } finally {
      if (status) status.textContent = '';
      btn.disabled = false;
    }
  });
}

function updateContextMemory(state, intentInfo) {
  const intentName = intentInfo?.intent || intentInfo?.primary;
  if (!intentName || NO_BADGE_INTENTS.has(intentName) || ['WORKSPACE_NAVIGATION', 'SCREEN_CONTEXT'].includes(intentName)) {
    lastRouterContext = null;
    if (state && typeof state === 'object') {
      state._chatRouterContext = null;
    }
    return;
  }
  const ctx = {
    intent: intentName,
    entity: intentInfo.entity || null,
    operation: intentInfo.operation || null,
    groupBy: intentInfo.groupBy || null,
    targetTab: intentInfo.targetTab || null,
    entities: { ...(intentInfo.entities || {}) },
    display: intentInfo.display ? { ...intentInfo.display } : null
  };
  lastRouterContext = ctx;
  if (state && typeof state === 'object') {
    state._chatRouterContext = ctx;
  }
}

async function maybeEnrichAsyncIntentData(intentInfo, assistantMsg, messages, state) {
  const intentName = intentInfo?.intent || intentInfo?.primary;
  const rerenderUpdated = () => {
    const updated = buildLocalStructuredResponse(assistantMsg.questionText, state, intentInfo);
    if (updated) {
      assistantMsg.structuredResponse = updated;
      assistantMsg.text = updated.summary;
      renderChat(messages, state?.agentExecution, state?.session?.permissions, { skipScroll: true });
    }
  };

  if (intentName === 'DATA_EXTRACTION_TIMELINE' && (!state?.monitoringData?.runs?.length || !state?.mockSap)) {
    const [runsData, mockSapData] = await Promise.all([
      !state?.monitoringData?.runs?.length ? getRouterJson('/api/monitoring/runs?limit=20') : Promise.resolve(null),
      !state?.mockSap ? getRouterJson('/api/mock-sap') : Promise.resolve(null)
    ]);
    if (state && (Array.isArray(runsData) || mockSapData)) {
      if (Array.isArray(runsData)) {
        state.monitoringData = { ...(state.monitoringData || {}), runs: runsData };
      }
      if (mockSapData) {
        state.mockSap = mockSapData;
      }
      rerenderUpdated();
    }
  } else if ((intentName === 'DATA_SOURCES_STATUS' || intentName === 'CDS_ENTITIES_LIST' || intentName === 'MOCK_SAP_STAGING') && (!state?.v2Connectors || !state?.mockSap || !state?.schedulerStatus)) {
    const [v2Data, mockSapData, schedData] = await Promise.all([
      !state?.v2Connectors ? getRouterJson('/api/v2/connectors') : Promise.resolve(null),
      !state?.mockSap ? getRouterJson('/api/mock-sap') : Promise.resolve(null),
      !state?.schedulerStatus ? getRouterJson('/api/v2/monitoring/scheduler-status') : Promise.resolve(null)
    ]);
    if (state && (v2Data || mockSapData || schedData)) {
      if (v2Data) state.v2Connectors = v2Data;
      if (mockSapData) state.mockSap = mockSapData;
      if (schedData) state.schedulerStatus = schedData;
      rerenderUpdated();
    }
  } else if (intentName === 'LIMIT_APPROVALS_STATUS' && !Array.isArray(state?.requests) && !Array.isArray(state?.approvals)) {
    const reqsData = await getRouterJson('/api/limit-requests');
    if (Array.isArray(reqsData) && state) {
      state.requests = reqsData;
      rerenderUpdated();
    }
  } else if (intentName === 'MONITORING_ANALYSIS' && !state?.monitoringData?.runs?.length) {
    const runsData = await getRouterJson('/api/monitoring/runs?limit=20');
    if (Array.isArray(runsData) && state) {
      state.monitoringData = { ...(state.monitoringData || {}), runs: runsData };
      rerenderUpdated();
    }
  } else if (intentName === 'AUDIT_HISTORY' && (!state?.agentHistory?.executions?.length)) {
    const historyData = await getRouterJson('/api/agent/history');
    if (historyData && state) {
      state.agentHistory = historyData;
      rerenderUpdated();
    }
  } else if (intentName === 'MONITORING_ALERTS' && (!state?.monitoringData?.alerts?.length)) {
    const alertsData = await getRouterJson('/api/monitoring/alerts');
    if (Array.isArray(alertsData) && state) {
      state.monitoringData = { ...(state.monitoringData || {}), alerts: alertsData };
      rerenderUpdated();
    }
  }
}

function scheduleBackgroundHeadlinePolish(assistantMsg, message, intentName, messages, state) {
  if (NO_BADGE_INTENTS.has(intentName)) return;
  if (typeof window !== 'undefined' && window.creditGuardDisableGeminiPolish) return;
  postRouterJson('/api/ai/polish-headline', {
    question: message,
    intent: intentName,
    headline: assistantMsg.structuredResponse?.summary || '',
    facts: {
      intent: intentName,
      title: assistantMsg.structuredResponse?.title || ''
    }
  }, GEMINI_ROUTER_TIMEOUT_MS).then(res => {
    if (res?.polished && res.headline && res.headline !== assistantMsg.structuredResponse.summary) {
      assistantMsg.structuredResponse.summary = res.headline;
      assistantMsg.text = res.headline;
      assistantMsg.headlinePolished = true;
      renderChat(messages, state?.agentExecution, state?.session?.permissions, { skipScroll: true });
    }
  }).catch(() => {});
}

export async function handleChatSubmit(event, send, messages, documentContext, state) {
  event.preventDefault();
  attachRetryListenerIfNeeded(send, messages, documentContext, state);
  attachTabTrackerIfNeeded(state);
  await ensureWorkspaceContextLoaded();

  const input = document.querySelector('#chat-input');
  const errorHost = document.querySelector('#chat-error');
  const message = input.value.trim();
  if (!message) return null;
  input.value = '';
  errorHost.textContent = '';
  const status = document.querySelector('#chat-status');
  const submitButton = document.querySelector('#chat-form button[type="submit"]');

  messages.push({ role: 'user', text: message });
  renderChat(messages, state?.agentExecution, state?.session?.permissions);

  const activeCtx = state?._chatRouterContext || lastRouterContext;
  const hasSharedStoreData = Array.isArray(state?.customers) && state.customers.length > 0;
  let classification = (!documentContext && hasSharedStoreData)
    ? classifyClientIntent(message, state, activeCtx)
    : null;
  const cacheKey = getCacheKey(message, state, activeCtx, classification);

  if (!documentContext && responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey);
    const cloned = {
      ...cached,
      structuredResponse: cached.structuredResponse ? { ...cached.structuredResponse } : null,
      questionText: message
    };
    messages.push(cloned);
    renderChat(messages, state?.agentExecution, state?.session?.permissions);
    return cloned;
  }

  if (!documentContext && hasSharedStoreData && classification) {
    // Layer A: High-confidence local match renders INSTANTLY
    if (classification.confidence >= 0.6) {
      const localStructured = buildLocalStructuredResponse(message, state, classification);
      if (localStructured) {
        updateContextMemory(state, classification);
        const assistantMsg = {
          role: 'assistant',
          text: localStructured.summary,
          structuredResponse: localStructured,
          localCalculation: true,
          provider: 'local',
          headlinePolished: false,
          providerFallback: false,
          providerFallbackReason: null,
          questionText: message
        };
        messages.push(assistantMsg);
        responseCache.set(cacheKey, assistantMsg);
        renderChat(messages, state?.agentExecution, state?.session?.permissions);

        maybeEnrichAsyncIntentData(classification, assistantMsg, messages, state).catch(() => {});
        scheduleBackgroundHeadlinePolish(assistantMsg, message, classification.intent, messages, state);

        if (typeof send === 'function' && !NO_BADGE_INTENTS.has(classification.intent)) {
          callSendWithTimeoutAndRetry(send, message, documentContext, state?.conversationId)
            .then(result => {
              if (!result) return;
              state.conversationId = result.conversationId || state.conversationId;
              state.agentExecution = result.execution
                ? { ...result.execution, ...(result.workflowPreview ? { workflowPreview: result.workflowPreview } : {}) }
                : null;
              if (result.preparedActions?.length) {
                state.preparedActions = result.preparedActions;
              }
              renderExecution(state.agentExecution, state.session?.permissions);
            })
            .catch(() => {});
        }
        return { reply: localStructured.summary, structuredResponse: localStructured };
      }
    }

    // Layer A Gemini Intent Classifier for uncertain / ambiguous phrasings (< 0.6 local confidence)
    if (status) status.textContent = 'Thinking...';
    if (submitButton) submitButton.disabled = true;
    try {
      const geminiRes = await postRouterJson('/api/ai/classify-intent', {
        message,
        context: activeCtx
      }, GEMINI_ROUTER_TIMEOUT_MS);

      let neededGeminiFailed = false;
      let failureReason = null;

      if (geminiRes?.usedGemini && geminiRes.intent && geminiRes.confidence >= 0.6) {
        const gEnt = geminiRes.entities || {};
        const gDisp = geminiRes.display || classification.display || {};
        const gCols = gDisp.columns || { include: [], exclude: [] };
        const gMode = gCols.exclude?.length > 0 ? 'exclude' : (gCols.include?.length > 0 ? (classification.display?.columnMode === 'only' ? 'only' : 'include') : (classification.display?.columnMode || 'default'));
        classification = finalizeWorkspacePlan({
          primary: geminiRes.intent,
          intent: geminiRes.intent,
          entity: geminiRes.entity || classification.entity || null,
          operation: geminiRes.operation || classification.operation || null,
          groupBy: geminiRes.groupBy || classification.groupBy || null,
          targetTab: geminiRes.targetTab || classification.targetTab || null,
          confidence: geminiRes.confidence,
          entities: {
            customerIds: Array.isArray(gEnt.customerIds) ? gEnt.customerIds : (gEnt.customerId ? [gEnt.customerId] : []),
            customerId: gEnt.customerId || gEnt.customerIds?.[0] || null,
            country: gEnt.country || null,
            companyCode: gEnt.companyCode || null,
            threshold: typeof gEnt.threshold === 'number' ? gEnt.threshold : null,
            status: gEnt.status || null,
            statuses: Array.isArray(gEnt.statuses) ? gEnt.statuses : (classification.entities?.statuses || []),
            severity: gEnt.severity || classification.entities?.severity || null,
            connectorFilter: classification.entities?.connectorFilter || null,
            metric: gEnt.metric || null
          },
          display: {
            columns: {
              include: Array.isArray(gCols.include) ? gCols.include : [],
              exclude: Array.isArray(gCols.exclude) ? gCols.exclude : []
            },
            columnMode: gMode,
            countryCodeAliasUsed: Boolean(classification.display?.countryCodeAliasUsed),
            sortBy: gDisp.sortBy || null,
            sortDir: gDisp.sortDir || null,
            limit: gDisp.limit || null,
            format: gDisp.format || 'table',
            timeRange: gDisp.timeRange || null
          }
        }, message.toLowerCase());
      } else {
        if (geminiRes && !geminiRes.usedGemini && geminiRes.reason && !['provider_not_configured', 'offline_configured'].includes(geminiRes.reason)) {
          neededGeminiFailed = true;
          failureReason = geminiRes.reason;
        }
        // Fallback to local classifier result or CLARIFY / OFF_TOPIC
        if (classification.fallbackBestIntent && classification.confidence >= 0.45) {
          classification = finalizeWorkspacePlan({
            ...classification,
            primary: classification.fallbackBestIntent,
            intent: classification.fallbackBestIntent
          }, message.toLowerCase());
        }
      }

      const structured = buildLocalStructuredResponse(message, state, classification);
      if (structured) {
        updateContextMemory(state, classification);
        const finalCacheKey = getCacheKey(message, state, activeCtx, classification);
        const assistantMsg = {
          role: 'assistant',
          text: structured.summary,
          structuredResponse: structured,
          localCalculation: true,
          provider: neededGeminiFailed ? 'offline' : 'local',
          headlinePolished: false,
          providerFallback: neededGeminiFailed,
          providerFallbackReason: neededGeminiFailed ? failureReason : null,
          questionText: message
        };
        messages.push(assistantMsg);
        responseCache.set(finalCacheKey, assistantMsg);
        renderChat(messages, state?.agentExecution, state?.session?.permissions);
        maybeEnrichAsyncIntentData(classification, assistantMsg, messages, state).catch(() => {});
        return { reply: structured.summary, structuredResponse: structured };
      }
    } finally {
      if (status) status.textContent = '';
      if (submitButton) submitButton.disabled = false;
    }
  }

  // Fallback to backend /api/chat when documentContext is provided or shared store isn't populated yet
  if (status) status.textContent = 'Thinking...';
  if (submitButton) submitButton.disabled = true;
  try {
    const result = await callSendWithTimeoutAndRetry(send, message, documentContext, state?.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    state.agentExecution = result.execution
      ? { ...result.execution, ...(result.workflowPreview ? { workflowPreview: result.workflowPreview } : {}) }
      : null;
    const actualGeminiFailure = Boolean(
      result.providerFallback
      && result.providerFallbackReason
      && !['provider_not_configured', 'offline_configured'].includes(result.providerFallbackReason)
    );
    const assistantMsg = {
      role: 'assistant',
      text: result.reply,
      structuredResponse: result.structuredResponse || result.execution?.structuredResponse || null,
      localCalculation: !actualGeminiFailure,
      provider: actualGeminiFailure ? 'offline' : (result.provider === 'gemini' ? 'gemini' : 'local'),
      headlinePolished: !actualGeminiFailure && result.provider === 'gemini',
      modulesUsed: result.modulesUsed,
      dataSourcesUsed: result.dataSourcesUsed,
      providerFallback: actualGeminiFailure,
      providerFallbackReason: actualGeminiFailure ? result.providerFallbackReason : null,
      questionText: message
    };
    messages.push(assistantMsg);
    if (!documentContext && assistantMsg.structuredResponse) {
      responseCache.set(cacheKey, assistantMsg);
    }
    renderChat(messages, state.agentExecution, state.session?.permissions);
    if (result.preparedActions?.length) {
      state.preparedActions = result.preparedActions;
    }
    return result;
  } catch (error) {
    errorHost.textContent = error.message;
    return null;
  } finally {
    if (status) status.textContent = '';
    if (submitButton) submitButton.disabled = false;
  }
}

export async function explainCustomer(customer, send, messages, documentContext, state) {
  const question = `Explain and recommend whether to increase the limit for ${customer.name} (${customer.ID}).`;
  const status = document.querySelector('#chat-status');
  messages.push({ role: 'user', text: question });

  const hasSharedStoreData = Array.isArray(state?.customers) && state.customers.length > 0;
  const localStructured = hasSharedStoreData ? buildLocalStructuredResponse(question, state) : null;
  if (localStructured) {
    messages.push({
      role: 'assistant',
      text: localStructured.summary,
      structuredResponse: localStructured,
      localCalculation: true,
      provider: 'local',
      headlinePolished: false,
      providerFallback: false,
      providerFallbackReason: null,
      questionText: question
    });
    renderChat(messages, state?.agentExecution, state?.session?.permissions);
    return;
  }

  if (status) status.textContent = 'Thinking...';
  renderChat(messages, null, state?.session?.permissions);
  try {
    const result = await callSendWithTimeoutAndRetry(send, question, documentContext, state?.conversationId);
    state.conversationId = result.conversationId || state.conversationId;
    state.agentExecution = result.execution || null;
    const actualGeminiFailure = Boolean(
      result.providerFallback
      && result.providerFallbackReason
      && !['provider_not_configured', 'offline_configured'].includes(result.providerFallbackReason)
    );
    messages.push({
      role: 'assistant',
      text: result.reply,
      structuredResponse: result.structuredResponse || result.execution?.structuredResponse || null,
      localCalculation: !actualGeminiFailure,
      provider: actualGeminiFailure ? 'offline' : (result.provider === 'gemini' ? 'gemini' : 'local'),
      headlinePolished: !actualGeminiFailure && result.provider === 'gemini',
      modulesUsed: result.modulesUsed,
      dataSourcesUsed: result.dataSourcesUsed,
      providerFallback: actualGeminiFailure,
      providerFallbackReason: actualGeminiFailure ? result.providerFallbackReason : null,
      questionText: question
    });
    renderChat(messages, state.agentExecution, state.session?.permissions);
  } catch (error) {
    document.querySelector('#chat-error').textContent = error.message;
  } finally {
    if (status) status.textContent = '';
  }
}
