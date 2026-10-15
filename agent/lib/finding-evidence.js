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

const { isBlogPage } = require("./page-groups");

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
 *
 * For a page isBlogPage() classifies as a blog post, the leading
 * "blog-" is ALSO stripped first — that token is this repo's own
 * repository/page-type convention (see page-groups.js's BLOG_PAGE_RE),
 * never part of a real search topic, so leaving it in produced a
 * semantically weak filter term (e.g. "blog seasonal cleanout guide"
 * instead of "seasonal cleanout guide"). City/service pages have no
 * such structural prefix and are completely unaffected — this never
 * widens into H1/title parsing or any other guessed-keyword source.
 * @param {string} page - a repo-relative file name, e.g. "furniture-removal.html"
 */
function deriveQueryFilterTerm(page) {
  let base = String(page).replace(/\.html$/i, "");
  if (isBlogPage(page)) base = base.replace(/^blog-/, "");
  return base.replace(/-/g, " ").trim();
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
    // Recorded onto the written evidence (firstparty-fetch.js threads
    // this straight through to makeFirstPartyEvidence()) so
    // needsFindingEvidenceRefresh() below can tell "this evidence was
    // fetched using the query term deriveQueryFilterTerm() would
    // produce TODAY" apart from "this evidence was fetched using some
    // OLDER term" — the latter must never be treated as a redundant
    // repeat just because it is still date-fresh. See that function's
    // own header.
    requestFingerprint: term,
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

/**
 * The requestFingerprint recorded on findingKey's MOST RECENTLY FETCHED
 * fresh-or-aging (never stale — same rule freshlyEvidencedFindingKeys()
 * applies) search-console-search-analytics entry, or `undefined` when
 * there is no such entry at all. Returns `null` specifically when the
 * most recent fresh-or-aging entry predates this field (every entry
 * written before this phase) — `needsFindingEvidenceRefresh()` below
 * treats `null` exactly like a mismatch, never like "confirmed current."
 *
 * Deliberately the MOST RECENT matching entry, not just the first one
 * encountered: evidence files are never overwritten (each fetch is its
 * own new file — see firstparty-fetch.js's writeFirstPartyEvidence()),
 * so more than one fresh-or-aging entry can legitimately exist for the
 * same key at once (e.g. an older, pre-fix evidence file sitting
 * alongside a newer, corrected one). The most recent attempt is the
 * authoritative answer to "what term did we most recently check this
 * with" — an older entry's fingerprint (or its ABSENCE of one) must
 * never override what a newer, already-corrected fetch recorded.
 * @param {object[]} entries
 * @param {string} findingKey
 * @param {Date} [now]
 * @returns {string|null|undefined}
 */
function freshFindingEvidenceFingerprint(entries, findingKey, now = new Date()) {
  const { computeFirstPartyFreshness } = require("./firstparty-evidence");
  let mostRecent = null; // {fetchedAt, fingerprint} | null
  for (const e of entries || []) {
    if (e.source !== SOURCE || e.findingKey !== findingKey) continue;
    if (computeFirstPartyFreshness(e, now).status === "stale") continue;
    if (!mostRecent || new Date(e.fetchedAt).getTime() > new Date(mostRecent.fetchedAt).getTime()) {
      mostRecent = { fetchedAt: e.fetchedAt, fingerprint: e.requestFingerprint || null };
    }
  }
  return mostRecent ? mostRecent.fingerprint : undefined;
}

/**
 * True when `finding` genuinely needs a --refresh-finding-evidence
 * fetch this run: either no fresh-or-aging evidence exists for it at
 * all, or the fresh-or-aging evidence on file was recorded under a
 * DIFFERENT query term than deriveQueryFilterTerm() would produce for it
 * RIGHT NOW (including evidence written before requestFingerprint
 * existed, which always reads as a mismatch).
 *
 * This is the deliberate, narrow mechanism that lets a corrected
 * deriveQueryFilterTerm() (e.g. the "blog-" prefix fix above) self-heal
 * its own prior evidence — a finding whose existing evidence used the
 * OLD, weaker term is automatically re-eligible for exactly one honest
 * re-fetch with the CURRENT term, with no manual one-time deletion of
 * the obsolete evidence file and no weakening of the freshness windows
 * for anything else. Evidence is never deleted by this — the obsolete
 * file stays on disk/in git history; it is simply no longer treated as
 * "already answered" for this candidate going forward.
 * @param {object} finding
 * @param {object[]} entries
 * @param {Date} [now]
 */
function needsFindingEvidenceRefresh(finding, entries, now = new Date()) {
  const recorded = freshFindingEvidenceFingerprint(entries, finding.key, now);
  if (recorded === undefined) return true; // no fresh-or-aging evidence at all
  return recorded !== deriveQueryFilterTerm(finding.pages[0]);
}

module.exports = {
  SOURCE,
  QUERY_PAGE_CANDIDATE_TYPES,
  isQueryPageEvidenceCandidate,
  deriveQueryFilterTerm,
  buildQueryPageEvidenceRequest,
  freshlyEvidencedFindingKeys,
  freshFindingEvidenceFingerprint,
  needsFindingEvidenceRefresh,
};
