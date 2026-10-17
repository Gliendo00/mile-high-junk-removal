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
  // Phase 13a — a deterministic combination of already-gathered evidence
  // families (site audit, GSC, GA4, completed jobs, curated local
  // source), never a new fetch of its own — see
  // agent/lib/cross-source-synthesis.js. Produced by code, not a human/
  // Claude reading comprehension judgment, so it carries the additional
  // `familyBreakdown`/`sufficiency` fields below for full inspectability.
  "cross-source-synthesis",
];

// Phase 13a — the bounded categorical status of one evidence family
// within a cross-source-synthesis result's `familyBreakdown`. Deliberately
// never a 0-100 score — see agent/lib/cross-source-synthesis.js's header.
const FAMILY_STATUSES = [
  "supports", // affirmatively, relevantly supports the premise
  "contradicts", // affirmatively, relevantly conflicts with the premise (premise-aware — see cross-source-synthesis.js)
  "insufficient-data", // evidence was gathered but is too thin/zero/stale to say either way — NEVER treated as contradiction
  "not-applicable", // this family's evidence does not bear on this finding type's premise at all
  "unavailable", // not yet gathered (or, for curated local-source evidence, gathered but its semantic relevance to this premise has not been confirmed)
  "different-question", // evidence exists and is real, but answers a materially different question than this premise
];

// Phase 13a — cross-family sufficiency, categorical (never numeric/
// weighted) — see agent/lib/cross-source-synthesis.js's header.
const SUFFICIENCY_LEVELS = ["corroborated", "partially-corroborated", "unsupported", "contradicted"];

const CONFIDENCE_LEVELS = ["low", "medium", "high"];

const VERDICTS = [
  "supports-opportunity", // evidence found genuinely supports acting on the finding
  "contradicts-opportunity", // evidence found that the "opportunity" isn't real/warranted
  "inconclusive", // evidence gathered but doesn't clearly settle it either way
];

// Phase 5 (daily/weekly operating system) — freshness/temporality.
// Optional and defaulted ("unknown") so the two real Phase 3 research
// files keep validating unchanged; new research going forward should set
// this explicitly. See agent/README.md's "Temporary/seasonal information"
// section: a municipal program's dates are real evidence TODAY but must
// never be silently treated as evergreen — this is the mechanical flag
// that lets computeFreshness() below tell the difference instead of
// relying only on prose in `limitations`.
const TEMPORALITY_VALUES = [
  "evergreen", // durable fact unlikely to change on any predictable schedule (e.g. a zoning rule)
  "temporary", // time-bound (a seasonal program, a dated promotion, an annual event)
  "unknown", // not yet classified — treated as needing a human look, not silently assumed evergreen
];

const DEFAULT_TEMPORALITY = "unknown";

// How many days before each temporality is considered "aging"/"stale".
// Not business facts — just a conservative, documented default so the
// agent has SOME mechanical staleness signal instead of relying purely on
// prose in `limitations` forever. "unknown" has no age bands at all: it is
// always flagged as needing classification, regardless of age.
const FRESHNESS_WINDOWS_DAYS = {
  temporary: { aging: 21, stale: 45 },
  evergreen: { aging: 270, stale: 365 },
};

/**
 * Computes a mechanical freshness read on a research result — never a
 * replacement for the human-written `limitations` text, just a
 * complementary, date-driven signal a report can act on without re-reading
 * prose. Pure function of the result + "now" (injectable for tests).
 * @returns {{status: "needs-classification"|"fresh"|"aging"|"stale", ageDays: number, temporality: string}}
 */
function computeFreshness(researchResult, now = new Date()) {
  const temporality = researchResult.temporality || DEFAULT_TEMPORALITY;
  const accessedAt = new Date(researchResult.accessedAt);
  const ageDays = Math.max(0, Math.round((now.getTime() - accessedAt.getTime()) / (24 * 60 * 60 * 1000)));

  if (temporality === "unknown") {
    return { status: "needs-classification", ageDays, temporality };
  }

  const window = FRESHNESS_WINDOWS_DAYS[temporality];
  let status = "fresh";
  if (ageDays >= window.stale) status = "stale";
  else if (ageDays >= window.aging) status = "aging";

  return { status, ageDays, temporality };
}

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
 * @param {string} [args.temporality] - one of TEMPORALITY_VALUES; defaults to "unknown" (never silently "evergreen")
 * @param {string} [args.publishedAt] - ISO date the source itself was published/last updated, if known/stated
 * @param {string} [args.locality] - the specific place this research concerns, e.g. "Denver, CO" — distinct from `findingKey`'s pages, since a finding can span multiple pages
 * @param {string} [args.topic] - a short topic label for rotation/report grouping, e.g. "yard-waste-seasonal-program"
 * @param {object[]} [args.familyBreakdown] - Phase 13a, required when `sourceType` is
 *   "cross-source-synthesis" (optional/ignored otherwise) — one entry per evidence family
 *   considered: {family: string, status: one of FAMILY_STATUSES, detail: non-empty string,
 *   evidenceRefs?: string[]}. Bounded, inspectable summaries only — never a raw payload dump
 *   (see agent/lib/evidence-dossier.js's header).
 * @param {string} [args.sufficiency] - Phase 13a, required when `sourceType` is
 *   "cross-source-synthesis" — one of SUFFICIENCY_LEVELS, the categorical cross-family
 *   corroboration read that produced this result's `verdict`.
 * @param {string} [args.synthesisFingerprint] - Phase 13a, optional — a deterministic
 *   fingerprint of exactly which evidence inputs produced this result (see
 *   agent/lib/evidence-dossier.js's computeDossierFingerprint()), so a later run can tell
 *   "the underlying evidence hasn't changed, no need to write a new file" apart from "the
 *   evidence changed, this conclusion may now be stale" — never used to silently mutate this
 *   file; only to decide whether a NEWER file should be written (research results are never
 *   overwritten — see this module's own existing convention).
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
  if (args.temporality !== undefined && !TEMPORALITY_VALUES.includes(args.temporality)) {
    throw new Error(`research result temporality must be one of ${TEMPORALITY_VALUES.join(", ")}, got "${args.temporality}"`);
  }
  if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
    throw new Error("research result requires at least one evidence entry — a result may not assert a verdict with zero observed evidence");
  }
  for (const item of args.evidence) {
    assertNonEmptyString(item, "evidence[]");
  }

  const isSynthesis = args.sourceType === "cross-source-synthesis";
  if (isSynthesis || args.sufficiency !== undefined) {
    if (!SUFFICIENCY_LEVELS.includes(args.sufficiency)) {
      throw new Error(`research result sufficiency must be one of ${SUFFICIENCY_LEVELS.join(", ")}, got "${args.sufficiency}"`);
    }
  }
  if (isSynthesis || args.familyBreakdown !== undefined) {
    if (!Array.isArray(args.familyBreakdown) || args.familyBreakdown.length === 0) {
      throw new Error("research result familyBreakdown must be a non-empty array when sourceType is cross-source-synthesis");
    }
    for (const entry of args.familyBreakdown) {
      if (!entry || typeof entry !== "object") throw new Error("research result familyBreakdown entries must be objects");
      assertNonEmptyString(entry.family, "familyBreakdown[].family");
      assertNonEmptyString(entry.detail, "familyBreakdown[].detail");
      if (!FAMILY_STATUSES.includes(entry.status)) {
        throw new Error(`research result familyBreakdown[].status must be one of ${FAMILY_STATUSES.join(", ")}, got "${entry.status}"`);
      }
      if (entry.evidenceRefs !== undefined && !Array.isArray(entry.evidenceRefs)) {
        throw new Error("research result familyBreakdown[].evidenceRefs must be an array when present");
      }
    }
  }
  if (args.synthesisFingerprint !== undefined && args.synthesisFingerprint !== null) {
    assertNonEmptyString(args.synthesisFingerprint, "synthesisFingerprint");
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
    temporality: args.temporality || DEFAULT_TEMPORALITY,
    publishedAt: args.publishedAt || null,
    locality: args.locality || null,
    topic: args.topic || null,
    // Distinguishes this from a finding's own (internal, scan-derived)
    // evidence array — INTERNAL EVIDENCE lives on finding.evidence, this
    // is EXTERNAL EVIDENCE (or, for sourceType "internal-repo-review", a
    // deeper internal look than the original scan performed, or for
    // sourceType "cross-source-synthesis", a deterministic COMBINATION of
    // already-gathered evidence families — see
    // agent/lib/cross-source-synthesis.js), and decision.js's reasoning
    // about these is INFERENCE, kept separate from all of them as
    // decision.reason.
    kind: args.sourceType === "internal-repo-review" ? "internal-deep-review" : isSynthesis ? "cross-source-synthesis" : "external",
    familyBreakdown: args.familyBreakdown || null,
    sufficiency: args.sufficiency || null,
    synthesisFingerprint: args.synthesisFingerprint || null,
  };
}

module.exports = {
  makeResearchResult,
  computeFreshness,
  SOURCE_TYPES,
  FAMILY_STATUSES,
  SUFFICIENCY_LEVELS,
  CONFIDENCE_LEVELS,
  VERDICTS,
  TEMPORALITY_VALUES,
  DEFAULT_TEMPORALITY,
  FRESHNESS_WINDOWS_DAYS,
};
