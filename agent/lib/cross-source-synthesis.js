// Site Improvement Agent, Phase 13a — deterministic cross-source
// synthesis.
//
// Turns an evidence-dossier.js dossier into EITHER a research.js-shaped
// result (reusing the EXISTING finding -> research-intake.js ->
// finding.research[] -> decision.js -> proposal channel, completely
// unchanged) OR nothing at all (in which case decision.js's existing
// RESEARCH_MORE path is preserved exactly as it is today). This module
// never writes a file itself (see agent/lib/run-synthesis.js for that)
// and never imports risk.js/decision.js/proposals-sync.js — it has no
// way to mutate a finding's category/tier/autoFix/autoApplyEligible, and
// nothing it returns confers any new auto-apply authority: a result this
// module produces still only ever reaches decision.js's EXISTING
// category-C research branch, which already requires `requiresApproval:
// true` for any resulting PROPOSE_CHANGE.
//
// CATEGORICAL, NEVER NUMERIC — no 0-100 score anywhere in this module,
// matching the brief's explicit instruction and research.js's own
// existing confidence/verdict vocabulary.
//
// Sufficiency counts only families whose status is "supports" or
// "contradicts" — "insufficient-data"/"not-applicable"/"unavailable"/
// "different-question" never count as a vote either way (absence of
// evidence is not evidence of absence, and a family that answers a
// different question is not a vote on THIS question). `site` is always
// "not-applicable" (see evidence-dossier.js's header on why) — it is
// never a candidate for the "exactly one"/"two or more" counts below,
// which is what keeps "partially-corroborated" from being trivially,
// circularly true for every category-C finding the moment it's created
// (which would effectively hand every category-C opportunity an
// automatic first corroborator for free, and quietly erode
// decision.js's existing RESEARCH_MORE boundary — exactly the failure
// mode `site` being non-voting is designed to prevent).
//
// STALE-SUPPORT SUPERSESSION (see buildSynthesisResultArgs()'s own
// `priorVerdict` handling below, and agent/lib/run-synthesis.js's
// header): a result this module built once is NEVER assumed to remain
// valid forever just because nothing newer gets written. When evidence
// that once supported (or contradicted) an opportunity later becomes
// insufficient, this module is told the finding's prior verdict and
// explicitly writes a superseding `inconclusive` result instead of
// silently doing nothing — see that function's own comment for exactly
// why "write nothing" is only safe when nothing was ever concluded in
// the first place.

const { SUFFICIENCY_LEVELS, FAMILY_STATUSES } = require("./research");

const SUFFICIENCY_RANK = { unsupported: 0, "partially-corroborated": 1, corroborated: 2 };

/**
 * @param {object} families - dossier.families (evidence-dossier.js's assembleDossier() output)
 * @returns {{sufficiency:string, supportingFamilies:string[], contradictingFamilies:string[]}}
 */
function classifySufficiency(families) {
  const supportingFamilies = [];
  const contradictingFamilies = [];
  for (const key of Object.keys(families || {})) {
    const status = families[key] && families[key].status;
    if (status === "supports") supportingFamilies.push(key);
    else if (status === "contradicts") contradictingFamilies.push(key);
  }

  let sufficiency;
  if (contradictingFamilies.length > 0) sufficiency = "contradicted";
  else if (supportingFamilies.length >= 2) sufficiency = "corroborated";
  else if (supportingFamilies.length === 1) sufficiency = "partially-corroborated";
  else sufficiency = "unsupported";

  return { sufficiency, supportingFamilies, contradictingFamilies };
}

// Opportunity-class proposal thresholds (Phase 13a) — verified against
// the five IN_SCOPE_FINDING_TYPES (agent/lib/evidence-dossier.js) and
// agent/lib/risk.js's own category-C RULES. Only content-gap and
// coverage-gap-candidate get the lowered "partially-corroborated is
// enough" bar the brief described — both are produced by audit modules
// already tuned conservatively against this exact site (see
// agent/README.md's Phase 3 section on content-gap-audit.js/
// coverage-audit.js's own false-positive tuning). The other three
// (structural-inconsistency, duplicate-meta-description,
// overlapping-intent) require full "corroborated" (2+ independent
// supporting families) — a materially stricter bar, left there
// deliberately rather than blindly reusing the same threshold for every
// type (see this repo's own instruction to verify, not assume, per
// finding type).
const OPPORTUNITY_CLASS_RULES = {
  "content-gap": { minSufficiency: "partially-corroborated" },
  "coverage-gap-candidate": { minSufficiency: "partially-corroborated" },
  "structural-inconsistency": { minSufficiency: "corroborated" },
  "duplicate-meta-description": { minSufficiency: "corroborated" },
  "overlapping-intent": { minSufficiency: "corroborated" },
};

function meetsThreshold(findingType, sufficiency) {
  const rule = OPPORTUNITY_CLASS_RULES[findingType];
  if (!rule) return false; // unknown/out-of-scope type — never eligible, fail safe
  return SUFFICIENCY_RANK[sufficiency] >= SUFFICIENCY_RANK[rule.minSufficiency];
}

function limitationsText(dossier, sufficiency) {
  const families = dossier.families || {};
  const notes = Object.keys(families)
    .filter((k) => k !== "site")
    .map((k) => `${k}: ${families[k].status}`)
    .join("; ");
  return (
    `Categorical cross-source synthesis (sufficiency: ${sufficiency}) over already-gathered evidence only — this is a deterministic COMBINATION, not a new fetch or a human reading-comprehension judgment. Per-family read: ${notes}. ` +
    `This does not establish search volume, visitor intent, or guaranteed outcomes, and never overrides a finding type's existing risk/approval requirements — any resulting proposal still requires explicit human review before anything is written or executed.`
  );
}

// A verdict from a PRIOR cross-source-synthesis result that was, at the
// time, actually authoritative/actionable (decision.js resolves either
// of these to something other than a plain "keep researching" outcome:
// supports -> PROPOSE_CHANGE, contradicts -> REJECT_OPPORTUNITY).
// "inconclusive" is deliberately NOT in this set — superseding an
// already-inconclusive result every time its fingerprint merely jitters
// (while sufficiency stays below threshold) would just manufacture
// repeated no-op files; see buildSynthesisResultArgs()'s own comment at
// its call site below.
const AUTHORITATIVE_VERDICTS = new Set(["supports-opportunity", "contradicts-opportunity"]);

/**
 * @param {object} finding - persisted-shape finding (see agent/lib/run-synthesis.js)
 * @param {object} dossier - evidence-dossier.js's assembleDossier() output for this finding
 * @param {object} [options]
 * @param {string} [options.fingerprint] - this dossier's computeDossierFingerprint() value
 * @param {string} [options.priorVerdict] - the MOST RECENT prior cross-source-synthesis
 *   result's `verdict` for this exact finding, if any (see agent/lib/run-synthesis.js's
 *   "stale-support supersession" section) — lets this function tell "nothing has ever been
 *   concluded for this finding" (safe to simply write nothing, preserving RESEARCH_MORE)
 *   apart from "something WAS concluded, and the evidence that supported it has since
 *   changed enough that it no longer does" (which must NOT be left silently authoritative —
 *   see below).
 * @returns {object|null} args ready for research.js's makeResearchResult(), or null ONLY
 *   when sufficiency does not meet this finding type's threshold AND no prior
 *   authoritative conclusion exists to supersede (decision.js's existing RESEARCH_MORE
 *   path is the correct outcome in that case — this function writes nothing rather than
 *   manufacture a weak/inconclusive artifact for a finding that was never concluded).
 */
function buildSynthesisResultArgs(finding, dossier, options = {}) {
  const { sufficiency, supportingFamilies, contradictingFamilies } = classifySufficiency(dossier.families);

  let verdict;
  let confidence;
  let recommendation;

  if (sufficiency === "contradicted") {
    verdict = "contradicts-opportunity";
    confidence = contradictingFamilies.length >= 2 ? "high" : "medium";
    recommendation = `Cross-source synthesis found a premise-level contradiction (${contradictingFamilies.join(", ")}) — this opportunity does not appear warranted as stated.`;
  } else if (meetsThreshold(finding.type, sufficiency)) {
    verdict = "supports-opportunity";
    confidence = sufficiency === "corroborated" ? "high" : "medium";
    recommendation = `Cross-source synthesis found ${sufficiency} corroboration (${supportingFamilies.join(", ") || "none"}) — sufficient, for this finding type, to warrant a human-reviewed proposal. This records a recommendation only; nothing is executed automatically.`;
  } else if (AUTHORITATIVE_VERDICTS.has(options.priorVerdict)) {
    // STALE-SUPPORT SUPERSESSION: a PRIOR cross-source-synthesis result
    // for this exact finding was authoritative (it drove a real
    // PROPOSE_CHANGE or REJECT_OPPORTUNITY), and the CURRENT dossier no
    // longer reaches that conclusion — the evidence that supported it
    // went stale, disappeared, became insufficient, or the fingerprint
    // simply changed enough that the old conclusion can no longer be
    // honestly reaffirmed. Leaving that old file as the only
    // cross-source-synthesis result for this finding would let
    // decision.js's pickLatestResearch() keep treating it as
    // authoritative FOREVER, purely because nothing newer was ever
    // written — exactly the "an old synthesis result must not remain
    // authoritative forever" failure this function exists to prevent.
    // So: explicitly write a NEW result with research.js's existing
    // `inconclusive` verdict (decision.js already resolves this to
    // NO_CHANGE, "researched... insufficient evidence" — the same,
    // already-understood outcome a weak human research result
    // produces, never a new decision category). The OLD file is never
    // deleted or mutated — append-only provenance is preserved; this
    // new file simply has a later `accessedAt`, which is what
    // pickLatestResearch() already uses to prefer it.
    verdict = "inconclusive";
    confidence = "low";
    recommendation =
      `Cross-source synthesis previously found this opportunity ${options.priorVerdict === "supports-opportunity" ? "corroborated" : "contradicted"}, ` +
      `but the underlying evidence has since changed (current sufficiency: ${sufficiency}) and no longer reaches that conclusion. ` +
      `This result explicitly supersedes the prior one rather than leaving it silently authoritative — it does not itself assert the opposite conclusion, only that the earlier one is no longer supported by current evidence.`;
  } else {
    // Nothing was EVER concluded for this finding (no prior
    // authoritative result to supersede) and the current dossier still
    // isn't sufficient for this finding type — never manufacture a weak
    // artifact; decision.js's existing RESEARCH_MORE path already
    // handles "not enough evidence yet" correctly and honestly.
    return null;
  }

  const evidence = Object.keys(dossier.families).map((key) => {
    const f = dossier.families[key];
    return `${key}: ${f.status} — ${f.detail}`;
  });

  return {
    findingKey: finding.key,
    question: options.question || finding.summary,
    source: "deterministic cross-source evidence synthesis (agent/lib/cross-source-synthesis.js)",
    sourceType: "cross-source-synthesis",
    evidence,
    confidence,
    limitations: limitationsText(dossier, sufficiency),
    verdict,
    recommendation,
    sufficiency,
    familyBreakdown: Object.keys(dossier.families).map((key) => ({
      family: key,
      status: dossier.families[key].status,
      detail: dossier.families[key].detail,
      evidenceRefs: dossier.families[key].evidenceRefs || [],
    })),
    synthesisFingerprint: options.fingerprint || null,
    temporality: "unknown",
  };
}

module.exports = {
  SUFFICIENCY_RANK,
  OPPORTUNITY_CLASS_RULES,
  classifySufficiency,
  meetsThreshold,
  buildSynthesisResultArgs,
};
