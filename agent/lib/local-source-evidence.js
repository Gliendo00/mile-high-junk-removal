// Site Improvement Agent, Phase 10 -- normalized Curated Official Source
// evidence schema.
//
// This is NOT a research.js result and must never be mistaken for one:
// research.js's shape (verdict/confidence/recommendation) represents a
// human-or-Claude-session's actual READING-COMPREHENSION JUDGMENT about
// whether a source genuinely supports a finding -- a judgment call this
// module's purely mechanical GET-and-extract can never honestly make.
// This shape has NO verdict/confidence/recommendation field at all (same
// hard structural rule agent/lib/firstparty-evidence.js already
// enforces for Search Console/GA4 data), and nothing in agent/lib/
// decision.js, agent/lib/research.js, or the proposal pipeline ever
// reads it. It exists purely to prove retrieval happened and to hand a
// human (or Claude session) an already-fetched, already-bounded
// starting point -- see agent/README.md's Phase 10 section.
//
// Reuses research.js's EXISTING SOURCE_TYPES/TEMPORALITY_VALUES/
// FRESHNESS_WINDOWS_DAYS vocabulary rather than inventing a second,
// conflicting taxonomy -- that vocabulary is already proven in
// production (the real Denver LeafDrop research result in agent/
// research/results/ uses it), and research.js's own authority hierarchy
// is exactly what this module needs too.

const { SOURCE_TYPES, TEMPORALITY_VALUES, DEFAULT_TEMPORALITY, FRESHNESS_WINDOWS_DAYS } = require("./research");

// Phase 1 only. Deliberately a closed, tiny enum: "known-url" is the
// ONLY discovery method this phase implements (a fetch of exactly the
// URL a local-source-registry.js entry declares). A future phase adding
// sitemap-keyword discovery would ADD a value here, never silently
// reinterpret "known-url" to also mean something broader.
const DISCOVERY_METHODS = ["known-url"];

// A hard cap on the extracted text snippet -- never persist an entire
// fetched page. Matches firstparty-fetch.js's own MAX_ROWS precedent
// ("do not store giant raw API payloads") applied to raw HTML/text
// instead of API rows.
const MAX_SNIPPET_CHARS = 2000;

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`local-source evidence requires a non-empty string for "${fieldName}"`);
  }
}

/**
 * Mechanical freshness read, same spirit and same underlying
 * FRESHNESS_WINDOWS_DAYS as research.js's own computeFreshness() (reused
 * directly, not re-derived) -- never a substitute for the evidence's own
 * `limitations` text, just a date-driven signal a report can act on
 * without re-reading prose.
 * @returns {{status:"needs-classification"|"fresh"|"aging"|"stale", ageDays:number, temporality:string}}
 */
function computeLocalSourceFreshness(evidence, now = new Date()) {
  const temporality = evidence.expectedTemporality || DEFAULT_TEMPORALITY;
  const retrievedAt = new Date(evidence.retrievedAt);
  const ageDays = Math.max(0, Math.round((now.getTime() - retrievedAt.getTime()) / (24 * 60 * 60 * 1000)));

  if (temporality === "unknown") {
    return { status: "needs-classification", ageDays, temporality };
  }

  const window = FRESHNESS_WINDOWS_DAYS[temporality];
  let status = "fresh";
  if (ageDays >= window.stale) status = "stale";
  else if (ageDays >= window.aging) status = "aging";
  return { status, ageDays, temporality };
}

/**
 * @param {object} args
 * @param {string} args.sourceUrl - the exact URL retrieved (must be the registry entry's own `url`)
 * @param {string} args.sourceDomain - the registry entry's own declared domain
 * @param {string} args.authorityClass - one of research.js's SOURCE_TYPES
 * @param {string} args.locality - e.g. "Denver, CO"
 * @param {string} args.topic - e.g. "leafdrop-pumpkin-composting-program"
 * @param {string} args.discoveryMethod - one of DISCOVERY_METHODS ("known-url" in Phase 1)
 * @param {string} [args.retrievedAt] - ISO timestamp; defaults to now
 * @param {string} args.extractedSnippet - bounded (<= MAX_SNIPPET_CHARS) plain-text extract; never raw HTML
 * @param {string} [args.expectedTemporality] - one of research.js's TEMPORALITY_VALUES; defaults to "unknown"
 * @param {string} args.limitations - required, like every other evidence shape here -- what this does NOT establish
 * @param {object} args.robots - { checkedAt: string, allowed: true } -- a fetch MUST have an explicit robots allow;
 *   this constructor refuses to build evidence for anything else (see below)
 */
function makeLocalSourceEvidence(args) {
  if (!args || typeof args !== "object") throw new Error("makeLocalSourceEvidence requires an object");

  assertNonEmptyString(args.sourceUrl, "sourceUrl");
  assertNonEmptyString(args.sourceDomain, "sourceDomain");
  assertNonEmptyString(args.locality, "locality");
  assertNonEmptyString(args.topic, "topic");
  assertNonEmptyString(args.limitations, "limitations");

  if (!SOURCE_TYPES.includes(args.authorityClass)) {
    throw new Error(`local-source evidence authorityClass must be one of ${SOURCE_TYPES.join(", ")}, got "${args.authorityClass}"`);
  }
  if (!DISCOVERY_METHODS.includes(args.discoveryMethod)) {
    throw new Error(`local-source evidence discoveryMethod must be one of ${DISCOVERY_METHODS.join(", ")}, got "${args.discoveryMethod}"`);
  }
  if (args.expectedTemporality !== undefined && !TEMPORALITY_VALUES.includes(args.expectedTemporality)) {
    throw new Error(`local-source evidence expectedTemporality must be one of ${TEMPORALITY_VALUES.join(", ")}, got "${args.expectedTemporality}"`);
  }

  if (typeof args.extractedSnippet !== "string" || args.extractedSnippet.trim().length === 0) {
    throw new Error("local-source evidence requires a non-empty extractedSnippet — evidence may not assert a retrieval with zero observed text");
  }
  if (args.extractedSnippet.length > MAX_SNIPPET_CHARS) {
    throw new Error(`local-source evidence extractedSnippet exceeds the ${MAX_SNIPPET_CHARS}-character bound — bound it BEFORE calling makeLocalSourceEvidence(); never persist unbounded page text`);
  }

  // A fetch that was never actually confirmed allowed by robots.txt must
  // structurally be unable to produce evidence at all -- never "evidence
  // exists, but robots said no" as two independently-settable fields
  // that could drift apart.
  if (!args.robots || typeof args.robots !== "object" || typeof args.robots.checkedAt !== "string" || !args.robots.checkedAt.trim()) {
    throw new Error("local-source evidence requires robots.checkedAt (a non-empty timestamp string)");
  }
  if (args.robots.allowed !== true) {
    throw new Error("makeLocalSourceEvidence refuses to construct evidence for a fetch robots.txt did not explicitly allow");
  }

  return {
    sourceUrl: args.sourceUrl,
    sourceDomain: args.sourceDomain,
    authorityClass: args.authorityClass,
    locality: args.locality,
    topic: args.topic,
    discoveryMethod: args.discoveryMethod,
    retrievedAt: args.retrievedAt || new Date().toISOString(),
    extractedSnippet: args.extractedSnippet,
    expectedTemporality: args.expectedTemporality || DEFAULT_TEMPORALITY,
    limitations: args.limitations,
    robots: { checkedAt: args.robots.checkedAt, allowed: true },
  };
}

module.exports = {
  makeLocalSourceEvidence,
  computeLocalSourceFreshness,
  DISCOVERY_METHODS,
  MAX_SNIPPET_CHARS,
};
