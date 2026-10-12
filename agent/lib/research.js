// Site Improvement Agent — external/structured research result schema.
//
// This module does NOT perform research — it has no network access, by
// design (see agent/README.md's "External research" section). It defines
// the structured shape a research result must have, and validates it on
// construction, so a research result can never be vague, unsourced, or
// missing its own limitations.
//
// Research is actually performed by whoever (or whatever) can reach the
// network — in Phase 2 that's a Claude-driven session with web
// search/fetch available, run deliberately and separately from this
// offline runner — and the result is written as one JSON file per result
// under agent/research/results/ (git-tracked, reviewable, diffable), each
// conforming to this exact shape. agent/lib/research-intake.js reads and
// validates every file in that directory and attaches matching results to
// the findings they answer.

const SOURCE_TYPES = [
  "official-government", // a city/county/state .gov page or official program info
  "official-municipal-utility", // e.g. a municipal waste/recycling utility's own site
  "search-results-observation", // what currently appears in search results — NOT search volume/ranking data
  "competitor-website", // a competitor's own site, for landscape understanding only — never copied
  "other-authoritative", // e.g. an industry body, a reputable local news source
  "internal-repo-review", // deeper review of this repo's own files/history — not external, but still "more evidence than the audit alone had"
];

const CONFIDENCE_LEVELS = ["low", "medium", "high"];

const VERDICTS = [
  "supports-opportunity", // evidence found genuinely supports acting on the finding
  "contradicts-opportunity", // evidence found that the "opportunity" isn't real/warranted
  "inconclusive", // evidence gathered but doesn't clearly settle it either way
];

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`research result requires a non-empty string for "${fieldName}"`);
  }
}

/**
 * @param {object} args
 * @param {string} args.findingKey - the Finding.key this research answers (see findings.js's makeKey)
 * @param {string} args.question - the exact question that was researched
 * @param {string} args.source - where the evidence came from (a URL, or a named official source)
 * @param {string} args.sourceType - one of SOURCE_TYPES
 * @param {string} [args.accessedAt] - ISO timestamp the source was consulted; defaults to now
 * @param {string[]} args.evidence - concrete facts observed, each attributable to `source`
 * @param {string} args.confidence - one of CONFIDENCE_LEVELS
 * @param {string} args.limitations - what this research does NOT establish (required — a research
 *   result claiming no limitations is almost always overconfident, so this is never optional)
 * @param {string} args.verdict - one of VERDICTS
 * @param {string} args.recommendation - what the agent should conclude/do given this evidence
 */
function makeResearchResult(args) {
  if (!args || typeof args !== "object") throw new Error("makeResearchResult requires an object");

  assertNonEmptyString(args.findingKey, "findingKey");
  assertNonEmptyString(args.question, "question");
  assertNonEmptyString(args.source, "source");
  assertNonEmptyString(args.limitations, "limitations");
  assertNonEmptyString(args.recommendation, "recommendation");

  if (!SOURCE_TYPES.includes(args.sourceType)) {
    throw new Error(`research result sourceType must be one of ${SOURCE_TYPES.join(", ")}, got "${args.sourceType}"`);
  }
  if (!CONFIDENCE_LEVELS.includes(args.confidence)) {
    throw new Error(`research result confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}, got "${args.confidence}"`);
  }
  if (!VERDICTS.includes(args.verdict)) {
    throw new Error(`research result verdict must be one of ${VERDICTS.join(", ")}, got "${args.verdict}"`);
  }
  if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
    throw new Error("research result requires at least one evidence entry — a result may not assert a verdict with zero observed evidence");
  }
  for (const item of args.evidence) {
    assertNonEmptyString(item, "evidence[]");
  }

  return {
    findingKey: args.findingKey,
    question: args.question,
    source: args.source,
    sourceType: args.sourceType,
    accessedAt: args.accessedAt || new Date().toISOString(),
    evidence: args.evidence,
    confidence: args.confidence,
    limitations: args.limitations,
    verdict: args.verdict,
    recommendation: args.recommendation,
    // Distinguishes this from a finding's own (internal, scan-derived)
    // evidence array — INTERNAL EVIDENCE lives on finding.evidence, this
    // is EXTERNAL EVIDENCE (or, for sourceType "internal-repo-review", a
    // deeper internal look than the original scan performed), and
    // decision.js's reasoning about the two is INFERENCE, kept separate
    // from both as decision.reason.
    kind: args.sourceType === "internal-repo-review" ? "internal-deep-review" : "external",
  };
}

module.exports = { makeResearchResult, SOURCE_TYPES, CONFIDENCE_LEVELS, VERDICTS };
