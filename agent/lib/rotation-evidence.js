// Site Improvement Agent, Phase 7B — weekly rotation first-party-evidence
// bridge.
//
// THE GAP THIS CLOSES: agent/lib/research-rotation.js's computePriorities()
// has always produced a scored shortlist of service-area topics worth a
// deep review this week (agent/README.md §4/§11) — but nothing ever
// actually performed that review. A rotation pick is NOT a Finding (it
// never goes through classifyAll()/decideAll()), so it was never eligible
// for either existing evidence-gathering path: decision.js's RESEARCH_MORE
// (category-C findings only) or firstparty-candidates.js's CANDIDATE_TYPES
// (a small, fixed set of EXISTING-page mechanical finding types — a
// pageless city structurally cannot match any of them). The result,
// observed in a real Weekly run: 3 rotation picks selected, zero evidence
// gathered, Search Console/GA4 both left in sourcesNotConsulted, and the
// report gave no way to tell "selected" apart from "actually reviewed."
//
// WHAT THIS MODULE DOES, AND DOESN'T: for a rotation pick that is a
// claimed-but-pageless service area (`!pick.hasPage` — §11's rule stays
// intact: this is never a "create this page" decision, only a genuine,
// first-party-grounded "is there any real signal here worth a human/
// orchestrator's further research" check), the ONLY mechanical,
// judgment-free evidence available is Search Console Search Analytics:
// does the property's own real search query data contain ANY query
// mentioning this city's name? That's a plain API call with a
// mechanically-derivable request shape — no AI/research-provider
// judgment needed to construct it, unlike a finding's firstparty-
// candidates.js question (which hands the orchestrator only a question +
// a hint, because the right scope/URL genuinely varies). GA4 is
// deliberately NOT queried here: without a page, there is no
// landingPage-dimension GA4 query that would mean anything (see
// classifyConclusion()'s own note).
//
// This module builds the request and classifies the result; it never
// fetches anything itself (no network access — matches every other
// *-candidates.js/*-rotation.js module in this codebase) and is never
// imported by decision.js (a rotation pick was already structurally
// incapable of reaching decision.js at all).
//
// EXTERNAL research (municipal/county/competitor sources — the OTHER
// half of a genuine deep review, per agent/README.md's evidence
// hierarchy) is explicitly, deliberately NOT implemented here: that
// requires a research-capable orchestrator session with real web access
// (WebSearch/WebFetch), which this unattended GitHub Actions runner does
// not have and must not fake (see agent/README.md's Phase 7 section). A
// rotation pick's conclusion from this module alone is capped at
// NO_CHANGE or RESEARCH_MORE — NEVER PROPOSE_CHANGE — precisely because
// first-party search-query evidence alone can never justify creating a
// page (agent/README.md §11's rule, enforced here the same way
// decision.js enforces it for findings: structurally, not by convention
// alone).

const SOURCE = "search-console-search-analytics";

/**
 * A rotation pick is a first-party-evidence candidate only when it's a
 * claimed-but-pageless service area — a city that already has a page
 * goes through the ordinary daily audit pipeline and
 * firstparty-candidates.js's existing mechanism instead; duplicating
 * that here would be exactly the "every page gets Search Console every
 * week" over-fetching the architecture has always refused to do.
 * @param {object} pick - research-rotation.js's computePriorities() shape: {slug, name, hasPage, ...}
 */
function isRotationEvidenceCandidate(pick) {
  return Boolean(pick) && pick.hasPage === false;
}

/**
 * Mechanically derives a ready-to-fetch Search Analytics request for a
 * pageless rotation pick — no orchestrator judgment needed (contrast
 * firstparty-candidates.js's buildFirstPartyEvidenceQuestion(), which
 * deliberately only hands back a question because the right scope
 * varies per finding). `rotationSlug` (not `findingKey`) is how
 * firstparty-intake.js's attachRotationEvidence() will later match the
 * written evidence back to this pick.
 * @param {object} pick - {slug, name, ...}
 * @param {object} [options]
 * @param {number} [options.days] - default 28, matches firstparty-fetch.js's own default
 */
function buildRotationEvidenceRequest(pick, options = {}) {
  const days = options.days || 28;
  return {
    type: "search-analytics",
    rotationSlug: pick.slug,
    scope: { type: "city", value: pick.name },
    days,
    dimensions: ["query"],
    dimensionFilterGroups: [
      {
        filters: [{ dimension: "query", operator: "contains", expression: pick.name.toLowerCase() }],
      },
    ],
    context: `Weekly rotation deep-review — does this property's real Search Console query data contain any organic search query mentioning "${pick.name}" (a claimed service area with no dedicated page yet)?`,
  };
}

/**
 * Classifies an ATTACHED Search Analytics evidence entry for a rotation
 * pick into the pick's own honest, capped conclusion — mirrors
 * decision.js's spirit (never assert more than the evidence supports)
 * without importing decision.js at all (a rotation pick is still never a
 * Finding).
 *
 * - No evidence entry at all -> conclusion null; `reason` explains WHY
 *   (not yet researched this run vs. integration not configured — the
 *   caller supplies which, from firstPartyIntegrations, since this
 *   module has no env/config access of its own).
 * - Evidence entry present, zero matching query rows observed ->
 *   NO_CHANGE: ONLY "this specific first-party check found no signal" —
 *   NEVER "no local opportunity exists in this city." This is a hard
 *   requirement, not a style preference: Search Console only reports
 *   impressions for queries this PROPERTY already surfaced in search
 *   results for — a claimed-but-pageless city structurally has little
 *   or nothing for it to have impressions on in the first place, a real
 *   searcher may describe the service without ever naming the city at
 *   all, and even a real, current local opportunity can show zero rows
 *   in any one 28-day window. Zero rows is real, honestly-reported
 *   evidence of ABSENCE-OF-SIGNAL — never evidence of ABSENCE-OF-
 *   OPPORTUNITY, and never grounds to stop investigating this city in
 *   the future (the weekly rotation will reconsider it again regardless
 *   of this conclusion — see research-rotation.js's own staleness
 *   scoring, which this module never overrides). The returned `reason`
 *   text states this limitation explicitly every time, not just in this
 *   comment, since the reason string is what actually reaches the
 *   report/CRM a human reads.
 * - Evidence entry present, at least one matching query row observed ->
 *   RESEARCH_MORE: real search interest exists; a page decision still
 *   requires the external research this environment cannot perform
 *   (NEVER auto-escalated to PROPOSE_CHANGE — see this file's header).
 *
 * @param {object|null} evidenceEntry - the (single) attached
 *   search-console-search-analytics entry for this pick, or null/undefined
 * @param {object} [options]
 * @param {boolean} [options.searchConsoleConfigured] - only consulted when evidenceEntry is absent
 */
function classifyRotationConclusion(evidenceEntry, options = {}) {
  if (!evidenceEntry) {
    if (options.searchConsoleConfigured === false) {
      return { conclusion: null, researched: false, reason: "not researched — Search Console is not configured in this environment" };
    }
    return { conclusion: null, researched: false, reason: "not researched this run — no first-party evidence was fetched for this pick (see the --refresh-rotation-evidence step's own log for why)" };
  }
  const rows = (evidenceEntry.observed && evidenceEntry.observed.totalRowsReturned) || 0;
  if (rows > 0) {
    return {
      conclusion: "RESEARCH_MORE",
      researched: true,
      reason: `Search Console shows ${rows} real organic search quer${rows === 1 ? "y" : "ies"} mentioning this city over ${evidenceEntry.window.label} — genuine external/local research is warranted before any page decision; first-party evidence alone never justifies creating a page.`,
    };
  }
  return {
    conclusion: "NO_CHANGE",
    researched: true,
    reason: `Search Console shows zero organic search queries mentioning this city over ${evidenceEntry.window.label} — this specific first-party check found no signal. This does NOT establish that no local opportunity exists: searchers may describe the service without naming the city, Search Console only reflects queries for content this site already shows up for, and a city with no dedicated page naturally has little to measure in the first place. This result alone never justifies creating a page, and never closes the door on researching this city again in a future week's rotation.`,
  };
}

/**
 * Which rotationSlugs currently have FRESH (non-stale) evidence — used
 * by cli.js's --refresh-rotation-evidence to decide which candidates
 * still need a fetch this run. STALE evidence is deliberately treated
 * as if it didn't exist at all: a zero-row result is honest evidence
 * of "no signal back then," and must never calcify into "no signal
 * forever" by permanently suppressing a re-check — see
 * classifyRotationConclusion()'s header for the full reasoning this
 * enforces structurally, not just in wording.
 * @param {object[]} entries - loaded first-party evidence entries (agent/lib/firstparty-intake.js's loadFirstPartyEvidence().entries)
 * @param {Date} [now]
 * @returns {Set<string>} rotationSlugs with fresh-or-aging (not stale) evidence
 */
function freshlyEvidencedRotationSlugs(entries, now = new Date()) {
  const { computeFirstPartyFreshness } = require("./firstparty-evidence");
  const slugs = new Set();
  for (const e of entries || []) {
    if (e.rotationSlug && computeFirstPartyFreshness(e, now).status !== "stale") {
      slugs.add(e.rotationSlug);
    }
  }
  return slugs;
}

module.exports = { SOURCE, isRotationEvidenceCandidate, buildRotationEvidenceRequest, classifyRotationConclusion, freshlyEvidencedRotationSlugs };
