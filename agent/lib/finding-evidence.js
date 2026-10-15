// Site Improvement Agent — weekly finding-level query/page evidence
// bridge: closes the "query-page-mismatch can never fire against real
// data because nothing ever requests query+page evidence without a
// human hand-composing the request" gap (see agent/README.md's new
// phase for the full root-cause writeup).
//
// Mirrors agent/lib/rotation-evidence.js's architecture almost exactly
// — same separation of concerns (candidate rule / mechanical request
// builder / freshness check, three small pure functions, zero network
// access here), same reason for existing (a category of evidence-worthy
// target that neither of the two EXISTING evidence-gathering paths
// reaches): a rotation pick is never a Finding (rotation-evidence.js's
// own gap), and a category-C finding was never in
// firstparty-candidates.js's CANDIDATE_TYPES (that module's own header,
// point 1, calls this out explicitly as "a documented,
// deliberately-deferred future option" — this file is that option,
// finally built, as its OWN separate mechanism rather than by widening
// CANDIDATE_TYPES itself, so the existing daily pause/resume semantics
// for CANDIDATE_TYPES are completely untouched).
//
// NARROW ON PURPOSE (brief: "do not simply fetch GSC for every
// finding/page"; "a technical finding like a broken link should not
// trigger Search Console performance research merely because it has a
// URL"):
//
// 1. Only two finding types, both asking the SAME kind of question —
//    "is this page's own content/depth adequate for what it's actually
//    about?" — for which real Search Console query text about this
//    page's own topic is the single most direct, non-fabricated
//    evidence available:
//      - "content-gap" (content-gap-audit.js): FAQ depth vs comparable
//        siblings.
//      - "structural-inconsistency" (consistency-audit.js): missing
//        FAQ schema or thin word count vs comparable siblings.
//    Every other category-C type was deliberately left out:
//    "coverage-gap-candidate"'s question is about a MISSING
//    cross-reference to a different service, not this page's own
//    adequacy — the natural query term would be the missing service's
//    name, not this page's own identity, and a real query landing on
//    the general service page instead of a city page is often normal,
//    not a mismatch worth flagging. "overlapping-intent" (2 pages) and
//    "duplicate-meta-description" (2+ pages) need a genuinely different,
//    GROUP-scoped request shape this module's single-target design
//    doesn't attempt. "research-gap" is never actually emitted by any
//    audit module (dead type in risk.js's RULES table).
// 2. Never an "observation"-tier finding, same rule
//    firstparty-candidates.js already applies, same reason (decision.js
//    already resolves those to NO_CHANGE as "not actionable on its own"
//    — re-opening that settled question just to fetch more evidence
//    would be exactly the manufactured work the brief warns against).
// 3. Never a finding whose own type could ever be autoApplyEligible —
//    defensive, matches firstparty-candidates.js's own
//    `decision === "APPLY_SAFE_FIX"` exclusion (neither candidate type
//    here has ever had an autoFix registered — only link-audit.js's two
//    mechanical finding types do — but this stays a structural
//    guarantee, not an assumption).
// 4. Only a SINGLE-page finding (`finding.pages.length === 1`) — both
//    candidate types are always single-page by construction of their
//    own audit modules today, but this module never assumes that stays
//    true; a finding that doesn't fit the single-target shape is simply
//    not a candidate, never force-fit.
//
// FRESHNESS, NOT PERMANENT SUPPRESSION (the explicit design decision
// from this phase's own investigation report): firstparty-candidates.js's
// EXISTING CANDIDATE_TYPES mechanism (daily, pause/resume-based) treats
// "already has ANY evidence, ever" as permanent disqualification — a
// posture that made sense for that daily/human-orchestrated pause
// mechanism, but is too blunt for this autonomous, mechanical weekly
// refresh. This module instead mirrors rotation-evidence.js's own
// `freshlyEvidencedRotationSlugs()` pattern exactly:
// `freshlyEvidencedFindingKeys()` below treats STALE evidence (per
// firstparty-evidence.js's existing, unchanged freshness windows for
// "search-console-search-analytics") as absent, so a finding is
// re-checked again once enough time passes rather than being
// permanently abandoned after one fetch — the same "a zero-row result
// is honest evidence of 'no signal THEN,' never 'no signal forever'"
// principle rotation-evidence.js's own header already documents. The
// EXISTING CANDIDATE_TYPES mechanism's permanent-suppression rule is
// NOT changed by this file — that is a deliberately separate,
// already-shipped lifecycle this phase does not touch.
//
// This module NEVER fetches anything (no network access, matches every
// other *-candidates.js/*-evidence.js module in this codebase) and is
// NEVER imported by decision.js or firstparty-signals.js — it only
// identifies candidates and mechanically builds a ready-to-fetch
// request, mirroring rotation-evidence.js's buildRotationEvidenceRequest()
// (not firstparty-candidates.js's buildFirstPartyEvidenceQuestion(),
// which deliberately hands back only a QUESTION because the right
// scope varies per finding and needs a human/orchestrator's judgment —
// here, the right scope is always "this finding's own single page,"
// mechanically derivable with zero judgment, same reasoning
// rotation-evidence.js's header gives for why ITS request needs no
// judgment either).

const SOURCE = "search-console-search-analytics";

const QUERY_PAGE_CANDIDATE_TYPES = new Set(["content-gap", "structural-inconsistency"]);

/**
 * @param {object} finding - a decided finding (post decideAll(), post attachFirstPartyEvidence())
 */
function isQueryPageEvidenceCandidate(finding) {
  if (!finding || !QUERY_PAGE_CANDIDATE_TYPES.has(finding.type)) return false;
  if (finding.tier === "observation") return false;
  if (finding.decision === "APPLY_SAFE_FIX") return false;
  if (!Array.isArray(finding.pages) || finding.pages.length !== 1) return false;
  return true;
}

/**
 * Mechanically derives a search query term FROM the page's own file
 * name — the same transform agent/lib/decision.js's questionTextFor()
 * already uses for service names (`.replace(".html","").replace(/-/g,"
 * ")`), reused here rather than re-invented. Not a guessed keyword, not
 * an assumption about demand — just this page's own existing identity,
 * turned into the string a real searcher might plausibly type.
 * @param {string} page - a repo-relative file name, e.g. "furniture-removal.html"
 */
function deriveQueryFilterTerm(page) {
  return String(page)
    .replace(/\.html$/i, "")
    .replace(/-/g, " ")
    .trim();
}

/**
 * Mechanically derives a ready-to-fetch Search Analytics request for a
 * single-page content-opportunity finding — no orchestrator judgment
 * needed (mirrors rotation-evidence.js's buildRotationEvidenceRequest()
 * exactly). Deliberately filters by QUERY, never by page: a page-level
 * dimensionFilterGroups entry would force every returned row's "page"
 * column to trivially equal the filtered page, making a query-page
 * mismatch structurally impossible to ever detect — the entire point of
 * requesting the "page" dimension alongside "query" is to let it reveal
 * where a real query ACTUALLY lands, unconstrained. `scope` still
 * records which page this evidence is ABOUT (firstparty-evidence.js's
 * existing, purely descriptive field — see that file's header), kept
 * completely separate from what the request's `dimensionFilterGroups`
 * actually sends to the API.
 * @param {object} finding - a finding that passed isQueryPageEvidenceCandidate()
 * @param {object} [options]
 * @param {number} [options.days] - default 28, matches firstparty-fetch.js's own default
 */
function buildQueryPageEvidenceRequest(finding, options = {}) {
  const days = options.days || 28;
  const page = finding.pages[0];
  const term = deriveQueryFilterTerm(page);
  return {
    type: "search-analytics",
    findingKey: finding.key,
    scope: { type: "page", value: page },
    days,
    dimensions: ["query", "page"],
    dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: term }] }],
    context: `Weekly first-party-evidence refresh for "${finding.type}" on ${page} — does this property's real Search Console query data mentioning "${term}" (this page's own topic) land on ${page}, or on a different URL? Deliberately NOT page-filtered — see this module's own header on why a page filter would make a mismatch structurally undetectable.`,
  };
}

/**
 * Which findingKeys currently have FRESH (non-stale)
 * search-console-search-analytics evidence — used by cli.js's
 * --refresh-finding-evidence to decide which candidates still need a
 * fetch this run. Mirrors rotation-evidence.js's
 * freshlyEvidencedRotationSlugs() exactly (same freshness windows, same
 * "stale is treated as absent" behavior) — see this file's own header
 * on why freshness, not permanent suppression, is the right rule here.
 * @param {object[]} entries - loaded first-party evidence entries (agent/lib/firstparty-intake.js's loadFirstPartyEvidence().entries)
 * @param {Date} [now]
 * @returns {Set<string>} findingKeys with fresh-or-aging (not stale) search-analytics evidence
 */
function freshlyEvidencedFindingKeys(entries, now = new Date()) {
  const { computeFirstPartyFreshness } = require("./firstparty-evidence");
  const keys = new Set();
  for (const e of entries || []) {
    if (e.source === SOURCE && e.findingKey && computeFirstPartyFreshness(e, now).status !== "stale") {
      keys.add(e.findingKey);
    }
  }
  return keys;
}

module.exports = {
  SOURCE,
  QUERY_PAGE_CANDIDATE_TYPES,
  isQueryPageEvidenceCandidate,
  deriveQueryFilterTerm,
  buildQueryPageEvidenceRequest,
  freshlyEvidencedFindingKeys,
};
