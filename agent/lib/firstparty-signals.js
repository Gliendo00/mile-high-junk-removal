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
const { classifySufficiency } = require("./firstparty-sufficiency");
const { LEAD_EVENT_NAMES, INSTRUMENTED_SINCE, isEventFullyInstrumentedForWindow } = require("./lead-event-instrumentation");

// Phase 12 — three additions, all following query-page-mismatch's own
// contract exactly (no verdict/confidence/recommendation field; a
// required `limitations`; an explicit `posture: "investigation-only"`)
// and all closing gaps THIS module's own header already documented as
// the reason the three originally-proposed signals were deferred:
//   - search-visibility-change / query-visibility-shift: now possible
//     because agent/lib/firstparty-fetch.js's fetchSearchAnalyticsEvidence()
//     can finally populate the schema's own comparisonWindow field (see
//     that file's `compareToPreviousPeriod` option) — this was the
//     EXACT, named blocker for "declined-vs-prior-period" above.
//   - lead-event-landing-page-delta: a narrower, more honest substitute
//     for "landing-page-weak-conversion-vs-comparable" — compares a
//     page against ITS OWN prior period (never an invented/unverifiable
//     comparable-group average), and uses raw GA4 `eventName`+
//     `eventCount` rather than `conversions`/`keyEvents` (which depend
//     on GA4 Admin-console key-event configuration this agent's
//     `analytics.readonly` scope cannot see or verify).
//   - `weak-ctr-despite-impressions` and the comparable-group version of
//     `landing-page-weak-conversion` remain NOT implemented — both still
//     need the comparable-*group*-fetch mechanism this module's header
//     already said doesn't exist; nothing in Phase 12 builds it.
//   - `batch-relative-rank` (comparing several of this week's rotation
//     picks against each other) was explicitly considered and
//     explicitly REJECTED for this phase: the weekly batch is
//     rotation-selected, not a designed comparable cohort, and ranking
//     within an incidental batch would manufacture a number Phase 13
//     could later overweight. Deferred indefinitely, not just to "a
//     later phase" — revisit only if a genuine comparable-cohort
//     mechanism is deliberately built first.

const SIGNAL_TYPES = ["query-page-mismatch", "search-visibility-change", "query-visibility-shift", "lead-event-landing-page-delta"];

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

// --- Phase 12: shared, pure helpers (no network, no imports beyond
// firstparty-sufficiency.js/lead-event-instrumentation.js above) -------

/**
 * Sums a bounded set of Search Console rows (search-analytics
 * evidence's own `topRows`/`previousPeriod.topRows` shape) into ONE
 * scope-level total. `ctr`/`position` are never naively averaged across
 * rows — `ctr` is recomputed from the summed clicks/impressions
 * (mathematically correct), and `position` is an impressions-weighted
 * average (the standard, correct way to combine GSC's own per-row
 * average-position values) — both are `null`, never a fabricated 0,
 * when `impressions` is 0 (a true zero-denominator case).
 * @param {object[]} topRows
 */
function aggregateSearchAnalyticsTotals(topRows) {
  const rows = Array.isArray(topRows) ? topRows : [];
  let impressions = 0;
  let clicks = 0;
  let weightedPositionSum = 0;
  for (const r of rows) {
    const imp = typeof r.impressions === "number" ? r.impressions : 0;
    const clk = typeof r.clicks === "number" ? r.clicks : 0;
    impressions += imp;
    clicks += clk;
    if (typeof r.position === "number") weightedPositionSum += r.position * imp;
  }
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? weightedPositionSum / impressions : null,
    rowCount: rows.length,
  };
}

/**
 * Absolute + relative delta between two periods' value for ONE metric —
 * ALWAYS computed and reported together, never one without the other
 * (brief: "a 2% CTR at position 9 may mean something entirely different
 * from 2% at position 1" — absolute movement alone, or relative alone,
 * can each mislead on its own). `relativeDelta` is the literal string
 * `"not-computable"` (never a fabricated Infinity/NaN/0%) whenever the
 * previous value is 0 or either value isn't a real number — a
 * zero-denominator percentage is never invented.
 * @param {number|null} currentValue
 * @param {number|null} previousValue
 */
function computeMetricDelta(currentValue, previousValue) {
  if (typeof currentValue !== "number" || typeof previousValue !== "number") {
    return { current: currentValue, previous: previousValue, absoluteDelta: null, relativeDelta: "not-computable" };
  }
  const absoluteDelta = currentValue - previousValue;
  const relativeDelta = previousValue === 0 ? "not-computable" : absoluteDelta / previousValue;
  return { current: currentValue, previous: previousValue, absoluteDelta, relativeDelta };
}

const SEARCH_VISIBILITY_CHANGE_LIMITATIONS =
  "This compares the SAME scope's own observable Search Console performance across two comparable, non-overlapping windows — it means only that impressions/clicks/CTR/position changed between them. It does NOT explain WHY (seasonality, a SERP feature, a competitor, an algorithm update, and genuine demand change are all indistinguishable from this data alone), and it does NOT by itself recommend or justify any action. A relativeDelta of \"not-computable\" means the prior period had zero for that metric — never treat that as a fabricated 0%/∞% change.";

/**
 * @param {object} finding - must carry `.key` and `.pages`
 * @param {object} evidence - one normalized firstparty-evidence.js entry
 */
function deriveSearchVisibilityChangeSignal(finding, evidence) {
  if (!evidence || evidence.source !== "search-console-search-analytics") return null;
  if (!evidence.comparisonWindow || !evidence.observed || !evidence.observed.previousPeriod) return null;
  if (!Array.isArray(finding.pages) || finding.pages.length === 0) return null;

  const current = aggregateSearchAnalyticsTotals(evidence.observed.topRows);
  const previous = aggregateSearchAnalyticsTotals(evidence.observed.previousPeriod.topRows);
  const sufficiency = classifySufficiency(current.impressions + previous.impressions, "gsc-impressions");
  if (sufficiency === "insufficient") return null;

  return {
    type: "search-visibility-change",
    findingKey: finding.key,
    pages: finding.pages,
    scope: evidence.scope,
    window: evidence.window,
    comparisonWindow: evidence.comparisonWindow,
    source: evidence.source,
    evidenceFetchedAt: evidence.fetchedAt,
    sufficiency,
    impressions: computeMetricDelta(current.impressions, previous.impressions),
    clicks: computeMetricDelta(current.clicks, previous.clicks),
    ctr: computeMetricDelta(current.ctr, previous.ctr),
    position: computeMetricDelta(current.position, previous.position),
    reason: `Search Console's observable performance for this scope changed between ${evidence.comparisonWindow.label} and ${evidence.window.label}${
      sufficiency === "limited" ? " — based on a thin, limited data volume; treat with extra caution" : ""
    }.`,
    limitations: SEARCH_VISIBILITY_CHANGE_LIMITATIONS,
    posture: "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it.",
  };
}

const QUERY_VISIBILITY_SHIFT_LIMITATIONS =
  "This compares two BOUNDED (not exhaustive) sets of top queries Search Console returned for this scope. A query absent from one period's set means only that it was not present in the bounded result set this evidence captured — NEVER that \"the site stopped ranking for this query\" or that true search volume reached zero. A query can fall out of a bounded top-N list, or below Search Console's own low-volume anonymization/thresholding, without that representing any real change in underlying performance. This is an investigation lead only, never evidence that a query's true ranking changed.";

/**
 * @param {object} finding
 * @param {object} evidence
 */
function deriveQueryVisibilityShiftSignal(finding, evidence) {
  const indices = resolveQueryPageIndices(evidence);
  if (!indices) return null;
  if (!evidence.comparisonWindow || !evidence.observed || !evidence.observed.previousPeriod) return null;
  if (!Array.isArray(finding.pages) || finding.pages.length === 0) return null;

  const currentRows = Array.isArray(evidence.observed.topRows) ? evidence.observed.topRows : [];
  const previousRows = Array.isArray(evidence.observed.previousPeriod.topRows) ? evidence.observed.previousPeriod.topRows : [];
  if (currentRows.length === 0 && previousRows.length === 0) return null; // both-zero -- no signal, never fabricated

  const normalizedQuery = (row) => {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    const q = keys[indices.queryIndex];
    return typeof q === "string" && q.trim() ? q.toLowerCase().trim() : null;
  };
  const byQuery = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = normalizedQuery(row);
      if (key && !map.has(key)) map.set(key, row);
    }
    return map;
  };
  const currentByQuery = byQuery(currentRows);
  const previousByQuery = byQuery(previousRows);

  const toSummary = (row) => {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    return {
      query: keys[indices.queryIndex] !== undefined ? keys[indices.queryIndex] : null,
      clicks: typeof row.clicks === "number" ? row.clicks : null,
      impressions: typeof row.impressions === "number" ? row.impressions : null,
      position: typeof row.position === "number" ? row.position : null,
    };
  };

  const gainedQueries = [];
  for (const [key, row] of currentByQuery) {
    if (!previousByQuery.has(key)) gainedQueries.push(toSummary(row));
  }
  const lostQueries = [];
  for (const [key, row] of previousByQuery) {
    if (!currentByQuery.has(key)) lostQueries.push(toSummary(row));
  }
  if (gainedQueries.length === 0 && lostQueries.length === 0) return null; // identical bounded sets -- nothing to report

  return {
    type: "query-visibility-shift",
    findingKey: finding.key,
    pages: finding.pages,
    scope: evidence.scope,
    window: evidence.window,
    comparisonWindow: evidence.comparisonWindow,
    source: evidence.source,
    evidenceFetchedAt: evidence.fetchedAt,
    gainedQueries,
    lostQueries,
    reason: `Between ${evidence.comparisonWindow.label} and ${evidence.window.label}, ${gainedQueries.length} quer${gainedQueries.length === 1 ? "y" : "ies"} newly appear and ${lostQueries.length} quer${
      lostQueries.length === 1 ? "y" : "ies"
    } no longer appear in this evidence's bounded top-query result set for this scope.`,
    limitations: QUERY_VISIBILITY_SHIFT_LIMITATIONS,
    posture: "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it.",
  };
}

const LEAD_EVENT_LANDING_PAGE_DELTA_LIMITATIONS =
  "Raw GA4 eventName+eventCount counts for this landing page, never the `conversions`/`keyEvents` metric (those depend on GA4 Admin-console key-event configuration this agent cannot see or verify). Session movement is always reported alongside event-count movement — an event-count change that merely tracks a traffic change is a traffic story, not a page-conversion story. This does NOT establish causation (this page's content did not necessarily cause the change), and does NOT estimate revenue or closed-job value, which this agent never touches. Any event whose comparisonAvailable is false has no trustworthy prior-period comparison because it was not yet instrumented for the full comparison window — its `previous`/`delta` are null, and this is NEVER evidence of zero prior engagement, only evidence that measurement did not exist yet.";

function numberFromGa4MetricRow(row, metricIndex) {
  const raw = row && Array.isArray(row.metrics) ? row.metrics[metricIndex] : undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function mapGa4RowsByDimension(rows) {
  const map = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const dims = Array.isArray(row.dimensions) ? row.dimensions : [];
    const key = dims[0];
    if (typeof key !== "string" || !key) continue;
    map[key] = numberFromGa4MetricRow(row, 0);
  }
  return map;
}

/**
 * UNLIKE the other detectors above, this one needs TWO correlated GA4
 * evidence entries for the SAME finding at once (a landing-page session
 * total, and an eventName-broken-down event-count report — see
 * agent/lib/lead-event-candidates.js's header for why this is two
 * separate GA4 requests rather than one: GA4's own `sessions` metric,
 * when broken down by eventName, counts sessions that included THAT
 * event, not the landing page's total session volume) — so it receives
 * the finding's WHOLE evidence list, not one entry at a time (see this
 * module's deriveFirstPartySignals() for the one place that calls it
 * differently from the single-evidence detectors above).
 * @param {object} finding
 * @param {object[]} evidenceList - finding.firstPartyEvidence
 */
function deriveLeadEventLandingPageDeltaSignal(finding, evidenceList) {
  if (!Array.isArray(finding.pages) || finding.pages.length === 0) return null;
  const list = Array.isArray(evidenceList) ? evidenceList : [];
  const sessionEntry = list.find((e) => e.source === "ga4" && e.dimension === "landingPage");
  const eventEntry = list.find((e) => e.source === "ga4" && e.dimension === "eventName");
  if (!sessionEntry || !eventEntry) return null;
  if (!sessionEntry.comparisonWindow || !sessionEntry.observed || !sessionEntry.observed.previousPeriod) return null;
  if (!eventEntry.comparisonWindow || !eventEntry.observed || !eventEntry.observed.previousPeriod) return null;

  const currentSessions = numberFromGa4MetricRow(sessionEntry.observed.topRows[0], 0);
  const previousSessions = numberFromGa4MetricRow(sessionEntry.observed.previousPeriod.topRows[0], 0);
  const sufficiency = classifySufficiency(currentSessions + previousSessions, "ga4-sessions");
  if (sufficiency === "insufficient") return null;

  const currentByEvent = mapGa4RowsByDimension(eventEntry.observed.topRows);
  const previousByEvent = mapGa4RowsByDimension(eventEntry.observed.previousPeriod.topRows);
  const eventNames = new Set([...Object.keys(currentByEvent), ...Object.keys(previousByEvent)]);

  const events = [];
  for (const name of eventNames) {
    if (!LEAD_EVENT_NAMES.includes(name)) continue; // defensive — the request itself already filters to this list server-side
    const current = currentByEvent[name] || 0;
    const comparisonAvailable = isEventFullyInstrumentedForWindow(name, eventEntry.comparisonWindow.start);
    const previous = comparisonAvailable ? previousByEvent[name] || 0 : null;
    events.push({
      eventName: name,
      current,
      previous,
      delta: comparisonAvailable ? computeMetricDelta(current, previous) : null,
      comparisonAvailable,
      note: comparisonAvailable
        ? null
        : `No trustworthy prior-period comparison — "${name}" has only been instrumented since ${INSTRUMENTED_SINCE[name]}, which is after this comparison window began. This is NOT evidence of zero prior engagement.`,
    });
  }
  if (events.length === 0) return null;

  return {
    type: "lead-event-landing-page-delta",
    findingKey: finding.key,
    pages: finding.pages,
    scope: eventEntry.scope,
    window: eventEntry.window,
    comparisonWindow: eventEntry.comparisonWindow,
    source: "ga4",
    evidenceFetchedAt: eventEntry.fetchedAt,
    sufficiency,
    sessions: computeMetricDelta(currentSessions, previousSessions),
    events,
    reason: `Raw GA4 lead-event counts for this landing page between ${eventEntry.comparisonWindow.label} and ${eventEntry.window.label}, alongside this landing page's own session volume over the same two periods${
      sufficiency === "limited" ? " — based on a thin, limited session volume; treat with extra caution" : ""
    }.`,
    limitations: LEAD_EVENT_LANDING_PAGE_DELTA_LIMITATIONS,
    posture: "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it.",
  };
}

// Single-evidence detectors: called once PER attached evidence entry
// (unchanged dispatch shape query-page-mismatch has always used).
const SIGNAL_DETECTORS = [deriveQueryPageMismatchSignal, deriveSearchVisibilityChangeSignal, deriveQueryVisibilityShiftSignal];

/**
 * Derives every signal this module currently knows how to compute from
 * one finding's already-attached `.firstPartyEvidence` array. Always
 * returns an array, possibly empty — "zero signals" is the expected,
 * successful result whenever evidence is absent, ineligible, or simply
 * shows no mismatch/change, never an error and never itself meaningful
 * (an empty array must never be read as "confirmed no issue" — see this
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
  // lead-event-landing-page-delta is the one EXCEPTION to the
  // single-evidence-at-a-time loop above — see its own header on why it
  // structurally needs the whole list at once. Called exactly once per
  // finding, additively, never replacing the loop above.
  const leadEventSignal = deriveLeadEventLandingPageDeltaSignal(finding, evidenceList);
  if (leadEventSignal) signals.push(leadEventSignal);
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
  deriveSearchVisibilityChangeSignal,
  deriveQueryVisibilityShiftSignal,
  deriveLeadEventLandingPageDeltaSignal,
  deriveFirstPartySignals,
  attachFirstPartySignals,
  resolveQueryPageIndices,
  aggregateSearchAnalyticsTotals,
  computeMetricDelta,
};
