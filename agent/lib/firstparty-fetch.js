// Site Improvement Agent, Phase 6 — targeted first-party evidence fetch.
//
// This is the ONLY module in the agent that actually touches the network
// for Search Console / GA4 — same architectural role as
// completed-job-fetch.js (Phase 5B) for Supabase: a separate, explicit
// step, never called by agent/runner.js/gatherFindings(), invoked only via
// `node agent/cli.js --fetch-firstparty=<request.json>` (see cli.js) by a
// research-capable orchestrator session that already decided (from a
// finding's own evidence, or a RESEARCH_MORE question) that a TARGETED
// first-party query is warranted — never "pull everything, every run"
// (brief §1/§2: no full-dataset dumps, no inspecting every page daily).
//
// Each fetch* function here calls exactly one targeted API request (or,
// for URL Inspection, one request per URL in a short explicit list),
// normalizes the result through firstparty-evidence.js's
// makeFirstPartyEvidence() (bounded to MAX_ROWS — never "hundreds of
// rows"), and returns it for the CLI wrapper to write to
// agent/research/firstparty/*.json. A request this agent cannot serve
// (missing credentials, API error, quota, insufficient data) degrades to
// {skipped:true, reason}, exactly like every other optional-integration
// path in this codebase (api/_lib/supabase-admin.js's getServiceClient(),
// completed-job-fetch.js) — never thrown.
//
// Also invoked, unchanged, via `--fetch-firstparty-strict=` (Phase 7D —
// the Golden Search Console diagnostic) and by `--refresh-rotation-
// evidence` (Phase 7B, agent/lib/rotation-evidence.js's
// buildRotationEvidenceRequest()) — both pass `rotationSlug` instead of
// `findingKey` on the request object. Every fetch* function below
// threads BOTH fields straight through to makeFirstPartyEvidence()
// untouched, even though only one is ever set on a given request — see
// tests/agent-cli-fetch-firstparty-strict.test.js for the regression
// that caught this being silently dropped once already.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { querySearchAnalytics, inspectUrl, isSearchConsoleConfigured } = require("./search-console-client");
const { runReport, isGa4Configured } = require("./ga4-client");
const { makeFirstPartyEvidence } = require("./firstparty-evidence");

const EVIDENCE_DIR = path.join(config.SITE_ROOT, "agent", "research", "firstparty");

// A targeted query already returns few rows by request (rowLimit), but
// this is a hard, independent cap on what ever reaches the normalized
// evidence shape — defense in depth against a request that asked for more
// than it should have (brief: "do not store giant raw API payloads").
const MAX_ROWS = 10;

// PRIVACY (agent/README.md's Phase 6 "Privacy" section): this agent uses
// aggregate analytics only. These dimension names identify an individual
// visitor/client/session, not aggregate behavior — requesting any of them
// is refused here, BEFORE agent/lib/ga4-client.js is ever called, so no
// network request is attempted with a disallowed dimension in the first
// place (see tests/agent-firstparty-safety.test.js).
const FORBIDDEN_GA4_DIMENSION_PATTERNS = [/clientId/i, /userId/i, /userPseudoId/i, /ipOverride/i, /appInstanceId/i];

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// GSC: ~2-3 day reporting lag before data is complete (brief §6 — "do not
// compare incomplete recent data against complete historical periods
// without accounting for reporting lag"). GA4: near-real-time, but a
// 1-day buffer keeps the final day from being a partial-day undercount.
function computeWindow(days, lagDays) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end), label: `${days} days ending ${iso(end)}` };
}

// Phase 12 — the immediately-preceding, EQUAL-length, NON-OVERLAPPING
// comparison period for `currentWindow` (itself already lag-adjusted by
// computeWindow() above): ends the day before `currentWindow.start`,
// spans the same number of days. Never reapplies a reporting lag of its
// own — it is already further in the past than any lag could reach,
// since it ends strictly before the (already lag-adjusted) current
// window begins. This is the ONLY place either comparison window's
// dates are derived, used identically by both
// fetchSearchAnalyticsEvidence() and fetchGa4Evidence() below, so "equal
// duration, non-overlapping, lag-respecting" is a single, shared
// guarantee rather than something each caller could independently get
// slightly wrong.
function computeComparisonWindow(currentWindow, days) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const end = new Date(`${currentWindow.start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: iso(start), end: iso(end), label: `${days} days ending ${iso(end)} (comparison period)` };
}

/**
 * Targeted Search Analytics query — e.g. "query/page evidence for the
 * Aurora opportunity this finding raised", not a full-site dump.
 * @param {object} args
 * @param {string} [args.findingKey]
 * @param {string} [args.rotationSlug] - Phase 7B/7D: mutually independent of
 *   findingKey — see firstparty-evidence.js's header. Must be threaded
 *   through to makeFirstPartyEvidence() below exactly like findingKey;
 *   dropping it silently is the exact bug tests/agent-cli-fetch-firstparty-
 *   strict.test.js exists to catch (a rotation pick's evidence would be
 *   fetched and written, but never attach back to the pick that asked
 *   for it).
 * @param {object} args.scope - {type, value} — see firstparty-evidence.js
 * @param {number} [args.days] - default 28
 * @param {string[]} [args.dimensions] - default ["query","page"]
 * @param {object[]} [args.dimensionFilterGroups] - raw Search Console filter groups
 * @param {string} [args.context]
 * @param {string} [args.requestFingerprint] - threaded straight through to
 *   makeFirstPartyEvidence() untouched, same pattern as findingKey/rotationSlug
 *   above — see finding-evidence.js's needsFindingEvidenceRefresh() for the
 *   one caller that actually uses it today.
 * @param {string} [args.purpose] - threaded straight through to makeFirstPartyEvidence()
 *   untouched, same pattern as the fields above — "operational" (the default when omitted)
 *   or "diagnostic" (set explicitly by a diagnostic request file, e.g.
 *   agent/diagnostics/golden-search-console-request.json — never inferred here from
 *   `strict`/anything else; see firstparty-evidence.js's EVIDENCE_PURPOSES header).
 * @param {boolean} [args.compareToPreviousPeriod] - Phase 12: when true, also queries the
 *   immediately-preceding, equal-length, non-overlapping period (computeComparisonWindow()
 *   above) with the IDENTICAL dimensions/dimensionFilterGroups/rowLimit, and populates the
 *   evidence's existing (previously always-null) `comparisonWindow` field plus a new
 *   `observed.previousPeriod` (same bounded shape as `observed` itself). The comparison
 *   fetch is best-effort: if IT specifically fails/skips, the current period's evidence is
 *   still returned successfully, just with no comparison attached (comparisonWindow stays
 *   null) — a transient problem fetching the PAST must never take down evidence for the
 *   PRESENT. See agent/lib/firstparty-signals.js's search-visibility-change/
 *   query-visibility-shift detectors, the only consumers of this field today.
 * @param {function} [args.fetchImpl] - injectable for tests
 */
async function fetchSearchAnalyticsEvidence({
  findingKey,
  rotationSlug,
  scope,
  days,
  dimensions,
  dimensionFilterGroups,
  context,
  requestFingerprint,
  purpose,
  compareToPreviousPeriod,
  fetchImpl,
} = {}) {
  if (!isSearchConsoleConfigured()) {
    return { skipped: true, reason: "Search Console not configured (GOOGLE_SERVICE_ACCOUNT_JSON / GSC_SITE_URL missing)" };
  }
  if (!scope || !scope.type || !scope.value) {
    return { skipped: true, reason: "fetchSearchAnalyticsEvidence requires a scope {type, value}" };
  }

  const windowDays = days || 28;
  const window = computeWindow(windowDays, 3);
  const dims = dimensions && dimensions.length ? dimensions : ["query", "page"];
  const result = await querySearchAnalytics({
    startDate: window.start,
    endDate: window.end,
    dimensions: dims,
    dimensionFilterGroups,
    rowLimit: MAX_ROWS,
    fetchImpl,
  });
  if (result.skipped) return result;

  const boundRows = (rows) =>
    rows.slice(0, MAX_ROWS).map((r) => ({
      keys: r.keys,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));

  let comparisonWindow = null;
  let previousPeriod = null;
  if (compareToPreviousPeriod) {
    const prevWindow = computeComparisonWindow(window, windowDays);
    // IDENTICAL dimensions/dimensionFilterGroups/rowLimit — only the
    // date range differs, so a delta between the two periods is never
    // confounded by a filter/shape mismatch.
    const prevResult = await querySearchAnalytics({
      startDate: prevWindow.start,
      endDate: prevWindow.end,
      dimensions: dims,
      dimensionFilterGroups,
      rowLimit: MAX_ROWS,
      fetchImpl,
    });
    if (!prevResult.skipped) {
      comparisonWindow = prevWindow;
      previousPeriod = { totalRowsReturned: prevResult.rows.length, topRows: boundRows(prevResult.rows) };
    }
    // A skipped comparison fetch is NOT propagated as a failure of the
    // whole request — see this function's own jsdoc above. The current
    // period's evidence below is still written normally, just without
    // a comparison attached.
  }

  const evidence = makeFirstPartyEvidence({
    findingKey,
    rotationSlug,
    requestFingerprint,
    purpose,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: dims.join("+"),
    scope,
    window,
    comparisonWindow,
    observed: {
      totalRowsReturned: result.rows.length,
      topRows: boundRows(result.rows),
      ...(previousPeriod ? { previousPeriod } : {}),
    },
    context: context || `Targeted Search Analytics query for ${scope.type} "${scope.value}" over ${window.label}.`,
    limitations:
      "Search Console clicks/impressions/CTR/position reflect search-result behavior only — not visitor intent, conversion value, or site quality — and do not by themselves establish that a page change is warranted.",
  });
  return { skipped: false, evidence };
}

/**
 * Targeted URL Inspection — for a short, explicit list of important URLs
 * (never every page). One evidence entry per URL.
 * @param {object} args
 * @param {string} [args.findingKey]
 * @param {string} [args.rotationSlug] - see fetchSearchAnalyticsEvidence()'s jsdoc
 * @param {string[]} args.urls - fully-qualified URLs to inspect
 * @param {string} [args.context]
 * @param {string} [args.purpose] - see fetchSearchAnalyticsEvidence()'s jsdoc
 * @param {function} [args.fetchImpl]
 */
async function fetchUrlInspectionEvidence({ findingKey, rotationSlug, urls, context, purpose, fetchImpl } = {}) {
  if (!isSearchConsoleConfigured()) {
    return { skipped: true, reason: "Search Console not configured (GOOGLE_SERVICE_ACCOUNT_JSON / GSC_SITE_URL missing)" };
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return { skipped: true, reason: "fetchUrlInspectionEvidence requires a non-empty urls[] array" };
  }

  const evidence = [];
  for (const url of urls) {
    const result = await inspectUrl({ inspectionUrl: url, fetchImpl });
    if (result.skipped) return result; // fail the whole targeted batch honestly rather than partially
    const idx = result.result.indexStatusResult || {};
    const today = new Date().toISOString().slice(0, 10);
    evidence.push(
      makeFirstPartyEvidence({
        findingKey,
        rotationSlug,
        purpose,
        source: "search-console-url-inspection",
        metric: "indexStatus",
        scope: { type: "page", value: url },
        window: { start: today, end: today, label: "point-in-time inspection" },
        observed: {
          verdict: idx.verdict || null,
          coverageState: idx.coverageState || null,
          googleCanonical: idx.googleCanonical || null,
          userCanonical: idx.userCanonical || null,
          lastCrawlTime: idx.lastCrawlTime || null,
        },
        context: context || `Targeted URL Inspection for ${url}.`,
        limitations:
          "A single point-in-time inspection — indexing/canonical state can change, and this does not by itself establish an indexing or canonical problem requiring action.",
      })
    );
  }
  return { skipped: false, evidence };
}

/**
 * Targeted GA4 report — e.g. landing-page sessions/engagement/conversions
 * for the page(s) a finding concerns, not a site-wide analytics dump.
 * @param {object} args
 * @param {string} [args.findingKey]
 * @param {string} [args.rotationSlug] - see fetchSearchAnalyticsEvidence()'s jsdoc
 * @param {object} args.scope - {type, value}
 * @param {number} [args.days] - default 28
 * @param {string[]} [args.dimensions] - default ["landingPage"]
 * @param {string[]} [args.metrics] - default ["sessions","engagementRate","conversions"]
 * @param {object} [args.dimensionFilter] - raw GA4 FilterExpression
 * @param {string} [args.context]
 * @param {string} [args.purpose] - see fetchSearchAnalyticsEvidence()'s jsdoc
 * @param {boolean} [args.compareToPreviousPeriod] - Phase 12: see fetchSearchAnalyticsEvidence()'s
 *   jsdoc — identical contract (same dimensions/metrics/dimensionFilter reused for the
 *   comparison period, best-effort, populates comparisonWindow/observed.previousPeriod).
 * @param {function} [args.fetchImpl]
 */
async function fetchGa4Evidence({ findingKey, rotationSlug, scope, days, dimensions, metrics, dimensionFilter, context, purpose, compareToPreviousPeriod, fetchImpl } = {}) {
  if (!isGa4Configured()) {
    return { skipped: true, reason: "GA4 not configured (GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID missing)" };
  }
  if (!scope || !scope.type || !scope.value) {
    return { skipped: true, reason: "fetchGa4Evidence requires a scope {type, value}" };
  }

  const dims = dimensions && dimensions.length ? dimensions : ["landingPage"];
  for (const dim of dims) {
    if (FORBIDDEN_GA4_DIMENSION_PATTERNS.some((p) => p.test(dim))) {
      return {
        skipped: true,
        reason: `GA4 dimension "${dim}" is a visitor/client-identifier dimension and is never requested by this agent (privacy boundary) — no request was sent`,
      };
    }
  }

  const windowDays = days || 28;
  const window = computeWindow(windowDays, 1);
  const mets = metrics && metrics.length ? metrics : ["sessions", "engagementRate", "conversions"];
  const result = await runReport({
    startDate: window.start,
    endDate: window.end,
    dimensions: dims,
    metrics: mets,
    dimensionFilter,
    limit: MAX_ROWS,
    fetchImpl,
  });
  if (result.skipped) return result;

  const boundRows = (rows) =>
    rows.slice(0, MAX_ROWS).map((r) => ({
      dimensions: (r.dimensionValues || []).map((d) => d.value),
      metrics: (r.metricValues || []).map((m) => m.value),
    }));

  let comparisonWindow = null;
  let previousPeriod = null;
  if (compareToPreviousPeriod) {
    const prevWindow = computeComparisonWindow(window, windowDays);
    // IDENTICAL dimensions/metrics/dimensionFilter — only the date
    // range differs.
    const prevResult = await runReport({
      startDate: prevWindow.start,
      endDate: prevWindow.end,
      dimensions: dims,
      metrics: mets,
      dimensionFilter,
      limit: MAX_ROWS,
      fetchImpl,
    });
    if (!prevResult.skipped) {
      comparisonWindow = prevWindow;
      previousPeriod = { totalRowsReturned: prevResult.rows.length, topRows: boundRows(prevResult.rows) };
    }
    // Best-effort, same rule as fetchSearchAnalyticsEvidence() above — a
    // skipped comparison fetch never fails the current period's result.
  }

  const dimNames = result.dimensionHeaders.map((h) => h.name);
  const metricNames = result.metricHeaders.map((h) => h.name);
  const evidence = makeFirstPartyEvidence({
    findingKey,
    rotationSlug,
    purpose,
    source: "ga4",
    metric: (metricNames.length ? metricNames : mets).join("+"),
    dimension: (dimNames.length ? dimNames : dims).join("+"),
    scope,
    window,
    comparisonWindow,
    observed: {
      totalRowsReturned: result.rows.length,
      topRows: boundRows(result.rows),
      ...(previousPeriod ? { previousPeriod } : {}),
    },
    context: context || `Targeted GA4 report for ${scope.type} "${scope.value}" over ${window.label}.`,
    limitations:
      "GA4 aggregate session/engagement/conversion data reflects visitor behavior only, and does not by itself establish that a page change would improve outcomes.",
  });
  return { skipped: false, evidence };
}

/**
 * Dispatches a single JSON request object (see cli.js's
 * --fetch-firstparty=<path> flag) to the matching fetch* function above.
 */
async function fetchFirstPartyEvidence(request) {
  if (!request || typeof request !== "object") {
    return { skipped: true, reason: "fetchFirstPartyEvidence requires a request object" };
  }
  switch (request.type) {
    case "search-analytics":
      return fetchSearchAnalyticsEvidence(request);
    case "url-inspection":
      return fetchUrlInspectionEvidence(request);
    case "ga4":
      return fetchGa4Evidence(request);
    default:
      return { skipped: true, reason: `unknown first-party evidence request type "${request.type}" (expected "search-analytics", "url-inspection", or "ga4")` };
  }
}

/**
 * Writes one or more normalized evidence entries to their own file under
 * agent/research/firstparty/ — one file per fetch (never overwritten,
 * unlike completed-job-fetch.js's single rolling snapshot: each targeted
 * fetch is its own piece of evidence, git-tracked and diffable like
 * agent/research/results/*.json).
 */
function writeFirstPartyEvidence(entryOrEntries, outFile, dir = EVIDENCE_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  if (entries.length === 0) throw new Error("writeFirstPartyEvidence requires at least one evidence entry");
  const first = entries[0];
  // Pre-acceptance hardening (audit finding #6, baseline 2bff317) —
  // Date.now() alone is millisecond-resolution and collided in practice
  // (a reproducible test flake: two writes for the same source/
  // findingKey issued back-to-back can land in the same millisecond,
  // producing the SAME filename and silently overwriting the first
  // file's evidence, with no error). A short crypto-random suffix closes
  // this — the same pattern agent/lib/run-synthesis.js's own
  // writeSynthesisResult() already uses for exactly this reason.
  const fileName = outFile || `${slugify(first.source)}__${slugify(first.findingKey || first.scope.value)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = {
  fetchSearchAnalyticsEvidence,
  fetchUrlInspectionEvidence,
  fetchGa4Evidence,
  fetchFirstPartyEvidence,
  writeFirstPartyEvidence,
  computeComparisonWindow,
  EVIDENCE_DIR,
  MAX_ROWS,
  FORBIDDEN_GA4_DIMENSION_PATTERNS,
};
