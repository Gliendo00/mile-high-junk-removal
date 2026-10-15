// Site Improvement Agent, Phase 6 — normalized first-party evidence schema.
//
// GSC/GA4/URL Inspection raw API payloads never flow into decision.js and
// are never persisted to git history (brief: "do not scatter raw API
// responses throughout decision.js"; "do not store giant raw API payloads
// in git history"). Every piece of first-party evidence this agent ever
// surfaces is normalized through makeFirstPartyEvidence() first — a
// small, inspectable record carrying exactly: source, metric/dimension,
// the exact time window queried, scope (what page/query/city this is
// about), the observed value, freeform context, and required
// limitations — mirroring research.js's makeResearchResult() validation
// discipline (a result may not assert anything without recorded evidence,
// source, and limitations).
//
// HARD STRUCTURAL RULE (not just a convention — see
// agent/lib/firstparty-intake.js's header for exactly how this is wired
// in): this shape has NO verdict/confidence/recommendation field, and
// agent/lib/decision.js never requires, reads, or imports this module at
// all. A metric cannot independently produce PROPOSE_CHANGE or
// APPLY_SAFE_FIX because nothing in the decision pipeline has any code
// path that looks at this data — see tests/agent-firstparty-safety.test.js
// for the regression proof (decide() output is byte-identical whether or
// not a finding carries first-party evidence).

const SOURCES = [
  "search-console-search-analytics",
  "search-console-url-inspection",
  "ga4",
];

const SCOPE_TYPES = ["page", "query", "city", "site"];

// How many days before each source's evidence is "aging"/"stale" — see
// agent/README.md's Phase 6 "freshness/comparison windows" section.
// Search Console has a real ~2-3 day reporting lag and is naturally
// noisier day-to-day than GA4; URL Inspection is a point-in-time check
// whose underlying indexing state can legitimately change within days.
// Conservative, documented defaults — not business facts.
const FRESHNESS_WINDOWS_DAYS = {
  "search-console-search-analytics": { aging: 10, stale: 21 },
  "search-console-url-inspection": { aging: 14, stale: 30 },
  ga4: { aging: 7, stale: 14 },
};

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`first-party evidence requires a non-empty string for "${fieldName}"`);
  }
}

/**
 * Mechanical freshness read, same spirit as research.js's
 * computeFreshness() — never a substitute for the evidence's own
 * `limitations` text, just a date-driven signal a report can act on
 * without re-reading prose.
 * @returns {{status:"fresh"|"aging"|"stale", ageDays:number}}
 */
function computeFirstPartyFreshness(evidence, now = new Date()) {
  const fetchedAt = new Date(evidence.fetchedAt);
  const ageDays = Math.max(0, Math.round((now.getTime() - fetchedAt.getTime()) / (24 * 60 * 60 * 1000)));
  const window = FRESHNESS_WINDOWS_DAYS[evidence.source] || { aging: 14, stale: 30 };
  let status = "fresh";
  if (ageDays >= window.stale) status = "stale";
  else if (ageDays >= window.aging) status = "aging";
  return { status, ageDays };
}

/**
 * @param {object} args
 * @param {string} [args.findingKey] - the Finding.key this evidence informs, if any — see
 *   findings.js's makeKey. Optional: some evidence isn't tied to one
 *   specific finding, and is still valid evidence, just not attached to
 *   any finding by firstparty-intake.js's attachFirstPartyEvidence().
 * @param {string} [args.rotationSlug] - Phase 7B: the weekly-rotation pick
 *   (agent/lib/research-rotation.js's `slug`) this evidence informs, if
 *   any — mutually independent of `findingKey` (a rotation pick is a
 *   claimed-but-pageless service area, never a Finding). Attached by
 *   firstparty-intake.js's attachRotationEvidence(), same pattern as
 *   findingKey/attachFirstPartyEvidence() but a separate key space.
 * @param {string} args.source - one of SOURCES
 * @param {string} args.metric - e.g. "clicks-impressions-ctr-position", "indexStatus", "sessions"
 * @param {string} [args.dimension] - e.g. "query", "page", "device" — null for a single aggregate metric
 * @param {object} args.scope - {type: one of SCOPE_TYPES, value: string} — what this evidence is ABOUT
 * @param {object} args.window - {start, end, label} — the exact date range queried (required — see brief §6: never omit the window)
 * @param {object} [args.comparisonWindow] - same shape, the prior period compared against, if any
 * @param {*} args.observed - the normalized, BOUNDED observed value(s) — e.g.
 *   {totalRowsReturned, topRows:[...]} (capped — see firstparty-fetch.js's
 *   MAX_ROWS) or {verdict, coverageState, googleCanonical, userCanonical}.
 *   Never the raw API response.
 * @param {string} args.context - what was queried and why, in plain language (ties back to the finding/question)
 * @param {string} args.limitations - required, like research.js — what this evidence does NOT establish
 * @param {string} [args.fetchedAt] - ISO timestamp; defaults to now
 */
function makeFirstPartyEvidence(args) {
  if (!args || typeof args !== "object") throw new Error("makeFirstPartyEvidence requires an object");

  if (!SOURCES.includes(args.source)) {
    throw new Error(`first-party evidence source must be one of ${SOURCES.join(", ")}, got "${args.source}"`);
  }
  assertNonEmptyString(args.metric, "metric");
  assertNonEmptyString(args.context, "context");
  assertNonEmptyString(args.limitations, "limitations");

  if (
    !args.scope ||
    typeof args.scope !== "object" ||
    !SCOPE_TYPES.includes(args.scope.type) ||
    typeof args.scope.value !== "string" ||
    !args.scope.value.trim()
  ) {
    throw new Error(`first-party evidence requires scope.type (one of ${SCOPE_TYPES.join(", ")}) and a non-empty scope.value`);
  }

  if (!args.window || typeof args.window !== "object" || !args.window.start || !args.window.end || !args.window.label) {
    throw new Error("first-party evidence requires window.start, window.end, and window.label");
  }

  if (args.observed === undefined || args.observed === null) {
    throw new Error("first-party evidence requires an `observed` value — evidence may not assert nothing was observed");
  }

  if (args.findingKey !== undefined && args.findingKey !== null) {
    assertNonEmptyString(args.findingKey, "findingKey");
  }
  if (args.rotationSlug !== undefined && args.rotationSlug !== null) {
    assertNonEmptyString(args.rotationSlug, "rotationSlug");
  }

  return {
    findingKey: args.findingKey || null,
    rotationSlug: args.rotationSlug || null,
    source: args.source,
    metric: args.metric,
    dimension: args.dimension || null,
    scope: { type: args.scope.type, value: args.scope.value },
    window: { start: args.window.start, end: args.window.end, label: args.window.label },
    comparisonWindow: args.comparisonWindow
      ? { start: args.comparisonWindow.start, end: args.comparisonWindow.end, label: args.comparisonWindow.label }
      : null,
    observed: args.observed,
    context: args.context,
    limitations: args.limitations,
    fetchedAt: args.fetchedAt || new Date().toISOString(),
  };
}

module.exports = {
  makeFirstPartyEvidence,
  computeFirstPartyFreshness,
  SOURCES,
  SCOPE_TYPES,
  FRESHNESS_WINDOWS_DAYS,
};
