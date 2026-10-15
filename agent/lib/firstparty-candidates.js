// Site Improvement Agent, Phase 6 lifecycle-tightening — identifies
// which DECIDED findings are first-party-evidence CANDIDATES: findings
// whose own nature is an indexing/visibility question a targeted
// Search Console/URL Inspection check could genuinely inform. This is
// what lets a daily run PAUSE (via the exact same `research_pending` /
// `--resume` mechanism Phase 5B already built for external research —
// see report.js's computeRunStatus()) to let an orchestrator gather
// real evidence BEFORE finalizing, instead of only after (the gap the
// first live Phase 6 validation surfaced: the sitemap-missing-url/
// privacy-policy.html finding's evidence was fetched only after that
// run had already finalized as "completed").
//
// Deliberately narrow (brief: "fetch only when a real finding/question
// warrants it"; "do not make every Daily run fetch every Google
// source"; "smallest coherent change"):
//
// 1. Only a small, fixed set of finding types whose own definition IS
//    an indexing-consistency question (CANDIDATE_TYPES below) — the
//    exact pattern the real validation surfaced. Category-C findings
//    already have their own evidence-gathering path (external research
//    via decision.js's RESEARCH_MORE); extending first-party-evidence
//    candidacy to them too is a documented, deliberately-deferred
//    future option (see agent/README.md), not something this pass does.
// 2. Never an "observation"-tier finding — decision.js already
//    resolves those to NO_CHANGE as "not actionable on its own" (see
//    decision.js's own header); re-opening that settled question just
//    to go fetch more evidence would be exactly the manufactured work
//    the brief warns against.
// 3. Never a finding that ALREADY has first-party evidence attached —
//    once answered, it stays answered (that evidence persists in
//    report.firstPartyEvidence for as long as the finding itself keeps
//    recurring).
// 4. Only a finding that is NEW this run (per change-detection.js's
//    `new` list) — once a candidate finding has been through one full
//    cycle without anyone gathering evidence for it, it does NOT keep
//    blocking every subsequent daily run forever. An orchestrator can
//    always choose to investigate an older still-open finding anyway
//    (nothing stops a manual `--fetch-firstparty` + `--resume` for it),
//    but the deterministic pipeline itself only proposes pausing for
//    something genuinely new.
//
// This module NEVER fetches anything, and is NEVER imported by
// decision.js (same hard separation firstparty-evidence.js's header
// describes) — it only identifies candidates and describes what KIND
// of check would help, mirroring decision.js's buildResearchQuestion()
// (a narrow question + a source-type HINT, not a ready-made request).
// The actual fetch stays the orchestrator's separate, explicit job via
// `node agent/cli.js --fetch-firstparty=<request.json>`.

const CANDIDATE_TYPES = new Set([
  "sitemap-missing-url",
  "robots-sitemap-conflict",
  "canonical-mismatch",
  "missing-canonical",
  "orphan-page",
]);

/**
 * @param {object} finding - a decided finding (post decideAll(), post attachFirstPartyEvidence())
 * @param {object} [options]
 * @param {boolean} [options.isNewThisRun] - from change-detection.js's `new` list; when explicitly
 *   `false`, this finding already went through at least one prior run and is excluded (see this
 *   file's header, point 4). Omitted (undefined) when a caller only cares about the type/tier/
 *   decision/evidence rules in isolation (e.g. a unit test) — treated as "yes, eligible on that count."
 */
function isFirstPartyEvidenceCandidate(finding, options = {}) {
  if (!CANDIDATE_TYPES.has(finding.type)) return false;
  if (finding.tier === "observation") return false;
  if (finding.decision === "APPLY_SAFE_FIX") return false;
  if (Array.isArray(finding.firstPartyEvidence) && finding.firstPartyEvidence.length > 0) return false;
  if (options.isNewThisRun === false) return false;
  return true;
}

function questionTextFor(finding) {
  const page = finding.pages[0];
  switch (finding.type) {
    case "sitemap-missing-url":
      return `${page} is missing from sitemap.xml — does Google's own view of this URL (indexing state, declared canonical, any existing search visibility) support adding it, or is its absence actually consistent with how this page is meant to be treated (e.g. a deliberate noindex)?`;
    case "robots-sitemap-conflict":
      return `${page} is listed in sitemap.xml but disallowed by robots.txt — does Google's own indexing state for this URL show it's actually affected by this conflict?`;
    case "canonical-mismatch":
    case "missing-canonical":
      return `${page}'s canonical tag is missing or inconsistent with its peers — does Google's own selected canonical for this URL agree with what the page declares (or should declare)?`;
    case "orphan-page":
      return `${page} isn't linked from anywhere else on the site — does it already have organic search visibility worth preserving, before treating its lack of internal links as low-priority?`;
    default:
      return `${finding.summary} — does Google's own first-party view of this URL help clarify whether this is a real issue?`;
  }
}

/**
 * Mirrors decision.js's buildResearchQuestion() shape — a narrow
 * question plus a HINT of what kind of first-party check would help,
 * never a ready-made, pre-filled fetch request (the orchestrator still
 * derives the real scope/URL, same as it already does for external
 * research questions).
 */
function buildFirstPartyEvidenceQuestion(finding) {
  return {
    findingKey: finding.key,
    findingType: finding.type,
    pages: finding.pages,
    question: questionTextFor(finding),
    suggestedRequestTypes: ["url-inspection", "search-analytics"],
  };
}

module.exports = { CANDIDATE_TYPES, isFirstPartyEvidenceCandidate, buildFirstPartyEvidenceQuestion };
