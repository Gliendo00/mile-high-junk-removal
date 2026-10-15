// Site Improvement Agent, First-Party Signals — derives bounded,
// investigation-only signals from normalized first-party evidence
// (firstparty-evidence.js's shape) already attached to a finding.
//
// HARD STRUCTURAL RULE (mirrors firstparty-evidence.js's own header):
// this module is NEVER imported by agent/lib/decision.js, and nothing it
// returns has a verdict/confidence/recommendation/propose/apply field —
// a signal can describe what was observed and why it might be worth a
// human's attention, and nothing more. It cannot create, escalate,
// approve, reject, or apply anything; it cannot itself cause a website
// change. See tests/agent-firstparty-signals-safety.test.js for the
// regression proof: decide() produces byte-identical output for two
// findings that differ ONLY in whether `.firstPartySignals` is
// populated, same discipline tests/agent-firstparty-safety.test.js
// already proved for `.firstPartyEvidence` itself.
//
// `agent/runner.js`'s gatherFindings() calls attachFirstPartySignals()
// strictly AFTER both decideAll() (decision.js) and
// attachFirstPartyEvidence() (firstparty-intake.js) — same ordering
// guarantee firstparty-intake.js's header already documents for
// `.firstPartyEvidence`. A signal is derived FROM already-attached
// evidence; it is never itself a source of new evidence, and it never
// triggers a new fetch.
//
// WHY ONLY ONE SIGNAL TYPE TODAY ("query-page-mismatch"):
//
// This module was proposed with four candidate signal concepts:
// weak-ctr-despite-impressions, query-page-mismatch,
// declined-vs-prior-period, landing-page-weak-conversion-vs-comparable.
// Implementing all four would have meant inventing either an arbitrary
// magic-number threshold or a comparison baseline this codebase doesn't
// actually assemble anywhere — both explicitly ruled out. Only
// query-page-mismatch survives that bar today:
//
//   - query-page-mismatch: computable from a SINGLE already-realistic
//     evidence entry. fetchSearchAnalyticsEvidence()'s own DEFAULT
//     dimensions (agent/lib/firstparty-fetch.js, when a caller doesn't
//     override them) are already `["query", "page"]` — so any Search
//     Console evidence fetched with default dimensions already carries,
//     per query row, which URL Google actually associates with it. This
//     signal is a direct, no-threshold comparison: does any returned
//     row's page differ from the finding's own subject page? No
//     averaging, no baseline, no magic number — either a row's page
//     matches the finding's page(s) or it doesn't.
//
//   - weak-ctr-despite-impressions: "weak" requires a baseline. The only
//     non-arbitrary baselines available would be (a) a same-site
//     comparable-page CTR average, which nothing in this codebase
//     currently assembles — each first-party fetch targets ONE scope at
//     a time (one page, one city, or the whole site), and there is no
//     mechanism that co-locates a subject page's evidence with its
//     comparable siblings' evidence in one place, the way
//     content-gap-audit.js/coverage-audit.js do for purely internal,
//     network-free page facts — or (b) an external CTR-by-position
//     benchmark curve, which would itself be exactly the kind of
//     invented, non-site-specific magic number this phase was told to
//     avoid. Deferred until a comparable-evidence-gathering mechanism
//     exists (see "Future extension" below).
//
//   - landing-page-weak-conversion-vs-comparable: same problem as
//     weak-ctr, for GA4 instead of GSC — "vs comparable" requires GA4
//     evidence for the subject page AND its comparable siblings to
//     exist at the same time, which nothing currently assembles.
//     Deferred for the same reason.
//
//   - declined-vs-prior-period: the schema has a `comparisonWindow`
//     field (firstparty-evidence.js), but NO caller anywhere in this
//     codebase (fetchSearchAnalyticsEvidence/fetchUrlInspectionEvidence/
//     fetchGa4Evidence) ever populates it — it is always null in
//     practice. An honest alternative is comparing TWO separately
//     fetched, time-separated evidence entries attached to the SAME
//     finding — structurally possible (firstparty-intake.js already
//     attaches every matching entry, not just the first), but the
//     repository today has no finding with more than one attached
//     evidence entry, and firstparty-candidates.js's own candidacy rule
//     deliberately never re-flags a finding that already has evidence
//     attached (see that file's header, point 3) — so this precondition
//     essentially never occurs today, outside a human manually
//     re-fetching the exact same finding/scope later by hand. Deferred
//     until a concrete, intentional re-fetch mechanism exists for
//     findings (the way rotation-evidence.js's staleness-triggered
//     refresh already exists for rotation picks, but nothing analogous
//     exists for findings yet).
//
// Future extension: a later, separately-authorized phase could widen
// firstparty-candidates.js to request GSC/GA4 evidence for a
// comparable GROUP of pages at once (not just one), which would make
// weak-ctr-despite-impressions and landing-page-weak-conversion-vs-
// comparable honestly computable using the SAME relative/proportional
// comparison style agent/lib/content-gap-audit.js already uses
// internally (`count < avg * 0.5`) — but that is new evidence-gathering
// scope, not something this module should backfill by inventing data.

const { normalizePageIdentifierForComparison } = require("./page-identity");

const SIGNAL_TYPES = ["query-page-mismatch"];

const QUERY_PAGE_MISMATCH_LIMITATIONS =
  "Search Console's query/page attribution reflects which URL Google currently associates with a search query in results — it does not establish searcher intent, content quality, or that any specific action (redirect, consolidation, rewrite) would improve outcomes. This is an investigation lead only, derived from a single evidence window, and is never sufficient on its own to justify a change.";

/**
 * A search-console-search-analytics evidence entry is eligible for the
 * query-page-mismatch comparison only when its OWN dimension list
 * includes both "query" and "page" — i.e. each returned row can be
 * attributed to a specific page. Any other shape (query-only,
 * page-only, a different source entirely) degrades to "not eligible"
 * here, never a fabricated comparison.
 * @returns {{queryIndex:number, pageIndex:number}|null}
 */
function resolveQueryPageIndices(evidence) {
  if (!evidence || evidence.source !== "search-console-search-analytics") return null;
  if (typeof evidence.dimension !== "string" || !evidence.dimension) return null;
  const dims = evidence.dimension.split("+");
  const queryIndex = dims.indexOf("query");
  const pageIndex = dims.indexOf("page");
  if (queryIndex === -1 || pageIndex === -1) return null;
  return { queryIndex, pageIndex };
}

/**
 * Derives at most one query-page-mismatch signal from one evidence
 * entry, for one finding. Returns null (never a signal) whenever:
 *   - the evidence isn't a query+page-dimensioned Search Console entry
 *     (resolveQueryPageIndices() above),
 *   - the finding has no pages recorded (defensive — findings.js
 *     already requires at least one, but this module never assumes),
 *   - every returned row's page matches the finding's own page(s)
 *     (the healthy case — nothing to investigate), or
 *   - the evidence returned zero rows (a legitimate "no signal found"
 *     result — NEVER interpreted as "no opportunity exists"; it simply
 *     produces no mismatch signal, exactly as it produces no finding
 *     either way. See tests/agent-firstparty-signals-safety.test.js).
 * @param {object} finding - must carry `.key` and `.pages` (repo-relative file names)
 * @param {object} evidence - one normalized firstparty-evidence.js entry
 */
function deriveQueryPageMismatchSignal(finding, evidence) {
  const indices = resolveQueryPageIndices(evidence);
  if (!indices) return null;
  if (!Array.isArray(finding.pages) || finding.pages.length === 0) return null;

  const observed = evidence.observed || {};
  const rows = Array.isArray(observed.topRows) ? observed.topRows : [];
  if (rows.length === 0) return null;

  const subjectPages = new Set(finding.pages.map(normalizePageIdentifierForComparison));

  const mismatchedQueries = [];
  for (const row of rows) {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    const rawQuery = keys[indices.queryIndex];
    const rawPage = keys[indices.pageIndex];
    if (rawPage === undefined) continue; // malformed row — skip, never guess
    const normalizedRowPage = normalizePageIdentifierForComparison(rawPage);
    if (subjectPages.has(normalizedRowPage)) continue; // agrees with this finding's own page — not a mismatch
    mismatchedQueries.push({
      query: rawQuery !== undefined ? rawQuery : null,
      observedPage: rawPage,
      clicks: typeof row.clicks === "number" ? row.clicks : null,
      impressions: typeof row.impressions === "number" ? row.impressions : null,
      ctr: typeof row.ctr === "number" ? row.ctr : null,
      position: typeof row.position === "number" ? row.position : null,
    });
  }

  if (mismatchedQueries.length === 0) return null;

  const count = mismatchedQueries.length;
  return {
    type: "query-page-mismatch",
    findingKey: finding.key,
    pages: finding.pages,
    scope: evidence.scope,
    window: evidence.window,
    source: evidence.source,
    evidenceFetchedAt: evidence.fetchedAt,
    mismatchedQueries,
    reason: `Search Console shows ${count} quer${count === 1 ? "y" : "ies"} over ${evidence.window.label} returning a different URL than this finding's own page(s) — worth investigating whether this page's content/internal linking/canonical setup genuinely serves these queries, or whether a different page is already meeting that intent.`,
    limitations: QUERY_PAGE_MISMATCH_LIMITATIONS,
    posture: "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it.",
  };
}

const SIGNAL_DETECTORS = [deriveQueryPageMismatchSignal];

/**
 * Derives every signal this module currently knows how to compute from
 * one finding's already-attached `.firstPartyEvidence` array. Always
 * returns an array, possibly empty — "zero signals" is the expected,
 * successful result whenever evidence is absent, ineligible, or simply
 * shows no mismatch, never an error and never itself meaningful (an
 * empty array must never be read as "confirmed no issue" — see this
 * module's `limitations` text on every signal it DOES produce for the
 * same discipline applied to the positive case).
 * @param {object} finding - a decided finding with `.firstPartyEvidence` already attached
 */
function deriveFirstPartySignals(finding) {
  const evidenceList = Array.isArray(finding.firstPartyEvidence) ? finding.firstPartyEvidence : [];
  const signals = [];
  for (const evidence of evidenceList) {
    for (const detector of SIGNAL_DETECTORS) {
      const signal = detector(finding, evidence);
      if (signal) signals.push(signal);
    }
  }
  return signals;
}

/**
 * Attaches `.firstPartySignals` (always an array, even when empty) to
 * every finding — mirrors firstparty-intake.js's attachFirstPartyEvidence()
 * exactly. MUST be called after BOTH decision.js's decideAll() and
 * firstparty-intake.js's attachFirstPartyEvidence() in any pipeline that
 * wants the structural guarantee described in this file's header to
 * hold (decision.js itself never reads this field regardless of call
 * order, but calling it after is what makes the ordering itself proof,
 * not just an unused capability — same reasoning
 * firstparty-intake.js's header applies to `.firstPartyEvidence`).
 */
function attachFirstPartySignals(findings) {
  for (const finding of findings) {
    finding.firstPartySignals = deriveFirstPartySignals(finding);
  }
  return findings;
}

module.exports = {
  SIGNAL_TYPES,
  deriveQueryPageMismatchSignal,
  deriveFirstPartySignals,
  attachFirstPartySignals,
  resolveQueryPageIndices,
};
