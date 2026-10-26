// Site Improvement Agent, Phase 2 — Search Intelligence: keyword-opportunity
// engine.
//
// Turns the ALREADY-COLLECTED Search Console snapshot rows (agent/lib/
// search-snapshots.js — this module never fetches from Google itself and
// never writes a row) into an explainable, categorized set of search
// opportunities: which real queries deserve attention next, and why.
//
// EVIDENCE, NOT EXECUTION. This module classifies and explains; it never
// creates a Finding, a proposal, or a page, and never writes to the
// filesystem or Supabase. The existing Site Improvement Agent approval/
// execution pipeline (agent/lib/decision.js, proposals-sync.js,
// execute-proposal.js) remains the only path from evidence to an actual
// website change.
//
// DETERMINISTIC AND PURE where it matters: analyzeSnapshot() below is a
// pure function of its inputs — no network, no randomness, no wall-clock
// dependence in the scoring itself. Calling it twice with the same rows
// always produces the same categories/scores/reasons.
//
// EXPLAINABLE SCORING: every classified query carries `score` (a plain
// sum of named, documented point contributions) AND the matching
// human-readable `reasons` for each contribution.
//
// INTENT CLASSIFICATION WITHOUT A HARDCODED KEYWORD LIST: branded
// detection, commercial-intent terms, specialty-service vocabulary, and
// landing-page topical relevance are all DERIVED from agent/context/
// business-profile.json (identity.name, services.pages labels,
// services.specialtyPages filenames, serviceArea city list) rather than a
// second, parallel keyword dictionary that could silently drift out of
// sync with that file.
//
// Phase 2b — post-independent-review hardening. This revision tightens
// four things an external review found were producing overconfident
// recommendations, without changing the five-category architecture:
//   1. CTR Opportunity now flags (never silently assumes away) the
//      specific case most likely to be a SERP/local-pack artifact rather
//      than a real listing defect — see LOCAL_PACK_POSITION_MAX below.
//   2. Brand detection requires the derived phrase to co-occur with an
//      actual word from the business's own name, not a bare two-word
//      substring (see isBranded()).
//   3. Landing-page "relevance" is now topic-aware (derived distinctive
//      vocabulary per page), not just "is this A service/city/specialty
//      page at all" — see landingPageRelevance().
//   4. evidenceConfidence is exposed as its own LOW/MEDIUM/HIGH field,
//      deliberately never folded into `priority` (business-value score).
// See each section below for the specific reasoning.

const { getServiceClient } = require("../../api/_lib/supabase-admin");
const { recentQueryRows } = require("./search-snapshots");
const businessProfile = require("./business-profile");
const { isCityPage, isBlogPage, isUtilityPage } = require("./page-groups");

// -----------------------------------------------------------------------
// Tunable, named constants — every number below has a one-line rationale
// next to it so a reviewer (or a future change) can see WHY, not just
// WHAT.
// -----------------------------------------------------------------------

const MIN_EVIDENCE_IMPRESSIONS = 10;
const STRONG_EVIDENCE_IMPRESSIONS = 50;
const PAGE_ONE_POSITION = 10;
const NEAR_PAGE_ONE_MAX = 20;
const CONTENT_GAP_MIN_POSITION = NEAR_PAGE_ONE_MAX;
// Content Gap severity bands (fix #6) — a position just past page one is a
// meaningfully different situation from a position buried on page six+;
// collapsing both into one undifferentiated "Content Gap" was the
// reviewed behavior this splits apart.
const CONTENT_GAP_NEAR_MISS_MAX = 30;
const CONTENT_GAP_WEAK_VISIBILITY_MAX = 60;
const CONTENT_GAP_NEAR_MISS_POINTS = 2;
const CONTENT_GAP_WEAK_VISIBILITY_POINTS = 0;
const CONTENT_GAP_VERY_WEAK_VISIBILITY_POINTS = -1;

const CTR_GAP_RATIO = 0.4;
const CTR_GAP_POINTS = 3;
// A CTR gap at position <= this, with zero clicks, on a query this module
// already knows is local/city-intent, is the classic signature of
// Google's local 3-pack / map-pack absorbing the click — not evidence the
// listing itself (title/meta) is broken. Still flagged (never silently
// dropped from CTR Opportunity), but at reduced point weight and with its
// own `likelyLocalPack` flag + distinct UI treatment — see classifyQuery().
const LOCAL_PACK_POSITION_MAX = 3;
const CTR_GAP_LOCAL_PACK_POINTS = 1;
// Below CTR_GAP_RATIO is a severe gap (CTR Opportunity); between this and
// CTR_GAP_RATIO is a milder shortfall worth a lighter-touch Priority Now
// nudge rather than an "investigate before changing anything" flag; at or
// above it, the query is already performing near/above the position
// benchmark (Protect/Maintain).
const PRIORITY_NOW_CTR_RATIO = 0.7;

const TREND_MIN_IMPRESSIONS = 5;
const TREND_IMPRESSIONS_PCT_THRESHOLD = 0.25;
const TREND_POSITION_DELTA_THRESHOLD = 1;

const ROW_FETCH_LIMIT = 500;
const DEFAULT_LIMIT_PER_CATEGORY = 10;

const CTR_BENCHMARK_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.028, 0.025];
const CTR_BENCHMARK_BEYOND_PAGE_ONE = 0.015;

function expectedCtrForPosition(position) {
  const p = Math.max(1, Math.round(Number(position) || 1));
  if (p > PAGE_ONE_POSITION) return CTR_BENCHMARK_BEYOND_PAGE_ONE;
  return CTR_BENCHMARK_BY_POSITION[p - 1];
}

// Generic business-entity words stripped from identity.name before using
// what's left as the "is this query branded" phrase, and reused below to
// exclude overly generic words from both topic-token derivation and
// specialty-intent-word derivation (the same "too generic to mean
// anything specific" words apply in all three places).
const GENERIC_BUSINESS_WORDS = new Set(["junk", "removal", "hauling", "llc", "inc", "co", "company", "services", "disposal"]);

function brandPhrase(profile = businessProfile.loadProfile()) {
  const name = (businessProfile.getIdentity(profile).name || "").toLowerCase();
  const tokens = name.split(/\s+/).filter((w) => w && !GENERIC_BUSINESS_WORDS.has(w));
  return tokens.join(" ").trim();
}

// The words REMOVED from the business name when deriving brandPhrase
// (e.g. "junk", "removal" for "Mile High Junk Removal"). A query must
// contain the stripped brand phrase ("mile high") TOGETHER WITH at least
// one of these to count as branded — "mile high movers"/"mile high
// roofing"/"mile high landscaping" contain the phrase but none of the
// business's own words, so they are correctly NOT branded; "mile high
// junk hauling"/"mile high removal" contain the phrase plus a business
// word, so they remain branded. This is what fix #2 changes: previously
// the bare phrase alone was sufficient, which over-matched on "Mile
// High" being a common regional nickname (Denver = "Mile High City").
function strippedBusinessWords(profile = businessProfile.loadProfile()) {
  const name = (businessProfile.getIdentity(profile).name || "").toLowerCase();
  return name.split(/\s+/).filter((w) => w && GENERIC_BUSINESS_WORDS.has(w));
}

function isBranded(query, profile = businessProfile.loadProfile()) {
  const q = query.toLowerCase();
  const fullName = (businessProfile.getIdentity(profile).name || "").toLowerCase().trim();
  if (fullName.length >= 3 && q.includes(fullName)) return true;
  const phrase = brandPhrase(profile);
  if (phrase.length < 3 || !q.includes(phrase)) return false;
  const strippedWords = strippedBusinessWords(profile);
  return strippedWords.some((w) => q.includes(w));
}

// Derived from business-profile.json's own services.pages labels (so this
// list changes automatically if the business's real service lineup
// changes) plus a small, fixed set of generic service-intent COMPOUND
// synonyms. Deliberately no bare, single generic words like "hauling" or
// "disposal" here any more (fix #7) — those over-matched unrelated
// queries ("boat hauling", "medical waste disposal"). Compounds are safe
// because they're specific two-word phrases, not single common words.
const GENERIC_COMMERCIAL_SYNONYMS = [
  "junk removal",
  "junk hauling",
  "cleanout",
  "clean out",
  "trash removal",
  "garbage removal",
  "debris removal",
  "rubbish removal",
  "dumpster rental",
];

// Core service-action words, derived from the synonym compounds above
// (plus two explicit, narrow additions) — used ONLY as the second half of
// an AND-gated check (see hasCommercialIntent): a specialty-concept word
// alone ("office", "same", "day") is too generic to mean anything on its
// own, but "office" + one of these words together is a safe, specific
// signal.
const CORE_ACTION_WORDS = new Set([...GENERIC_COMMERCIAL_SYNONYMS.flatMap((s) => s.split(" ")), "disposal", "pickup"]);

let cachedIntentTerms = null;
function serviceIntentTerms(profile = businessProfile.loadProfile()) {
  if (cachedIntentTerms) return cachedIntentTerms;
  const fromPages = businessProfile.getServicePages(profile).map((p) => p.label.toLowerCase());
  cachedIntentTerms = Array.from(new Set([...fromPages, ...GENERIC_COMMERCIAL_SYNONYMS]));
  return cachedIntentTerms;
}

// Distinctive single-word vocabulary for the business's specialty pages
// (hoa-junk-removal.html -> "hoa", office-junk-removal.html -> "office",
// etc. — see agent/context/business-profile.json's services.specialtyPages),
// stripped of the same generic business words used everywhere else in
// this file. Fix #7's "include specialty-page vocabulary... office,
// commercial, HOA, contractor, property management, same-day" — derived
// from the existing filename list, not a new hardcoded dictionary.
let cachedSpecialtyWords = null;
function specialtyIntentWords(profile = businessProfile.loadProfile()) {
  if (cachedSpecialtyWords) return cachedSpecialtyWords;
  const specialtyPages = (profile.services && profile.services.specialtyPages) || [];
  const words = new Set();
  for (const file of specialtyPages) {
    for (const token of file.replace(/\.html$/, "").split("-")) {
      if (token && !GENERIC_BUSINESS_WORDS.has(token)) words.add(token);
    }
  }
  cachedSpecialtyWords = words;
  return words;
}

function containsWord(lowerQuery, word) {
  return new RegExp(`\\b${word}\\b`).test(lowerQuery);
}

function hasCommercialIntent(query, profile = businessProfile.loadProfile()) {
  const q = query.toLowerCase();
  if (serviceIntentTerms(profile).some((term) => q.includes(term))) return true;
  // A specialty-concept word (e.g. "office", "same"/"day") only counts as
  // commercial intent when paired with an actual service-action word in
  // the SAME query — "office chair" must not match on "office" alone.
  const specialtyWords = specialtyIntentWords(profile);
  const hasSpecialtyWord = [...specialtyWords].some((w) => containsWord(q, w));
  if (!hasSpecialtyWord) return false;
  return [...CORE_ACTION_WORDS].some((w) => containsWord(q, w));
}

function matchedCity(query, profile = businessProfile.loadProfile()) {
  const q = query.toLowerCase();
  const cities = [...businessProfile.getCitiesWithPages(profile), ...businessProfile.getClaimedCitiesWithoutPages(profile)];
  return cities.find((c) => q.includes(c.name.toLowerCase()) || q.includes(c.slug.replace(/-/g, " "))) || null;
}

function hasLocalIntent(query, profile = businessProfile.loadProfile()) {
  const q = query.toLowerCase();
  if (/\bnear me\b/.test(q)) return true;
  return matchedCity(query, profile) !== null;
}

// Normalizes a GSC landing_page (a full URL) or a GA4 landingPage
// (a path, e.g. "/book/") to the same repo-relative file key, so the two
// sources can be joined and so page-groups.js's file-based classifiers
// apply to either.
function urlToFile(value) {
  let p = String(value || "");
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch (_) {
      /* fall through and treat the raw string as a path */
    }
  }
  p = p.split("?")[0].split("#")[0];
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "" ? "index.html" : p;
}

function classifyLandingPage(file, profile = businessProfile.loadProfile()) {
  if (file === "index.html") return { type: "home", label: "Homepage", file };
  if (isUtilityPage(file)) return { type: "utility", label: file, file };
  if (isCityPage(file)) {
    const slug = file.replace(/-junk-removal\.html$/, "");
    const city = [...businessProfile.getCitiesWithPages(profile), ...businessProfile.getClaimedCitiesWithoutPages(profile)].find((c) => c.slug === slug);
    return { type: "city", label: `${city ? city.name : slug} city page`, citySlug: slug, file };
  }
  if (isBlogPage(file)) return { type: "blog", label: file, file };
  const servicePage = businessProfile.getServicePages(profile).find((s) => s.file === file);
  if (servicePage) return { type: "service", label: servicePage.label, file };
  const specialtyPages = (profile.services && profile.services.specialtyPages) || [];
  if (specialtyPages.includes(file)) return { type: "specialty", label: file.replace(/\.html$/, "").replace(/-/g, " "), file };
  return { type: "other", label: file, file };
}

// -----------------------------------------------------------------------
// Topic-aware landing-page relevance (fix #3). Previously ANY service/
// city/specialty page got the full "relevant landing page" credit just
// for being that TYPE of page — a furniture-removal query ranking via
// appliance-disposal.html would have scored full credit. This derives,
// per page, the vocabulary that's actually DISTINCTIVE to it (a word that
// appears on only one service/specialty page, after stripping the same
// generic business words used everywhere else) — "furniture" is
// distinctive to furniture-removal.html, but "removal" is shared across
// multiple pages and carries no real signal. Three tiers, not a boolean:
//   - "topic-match": the query contains the page's own distinctive word
//     (or, for a city page, names that exact city) — full credit.
//   - "type-only": the ranking page is A page of a plausibly relevant
//     type, but topical match to the EXACT query is uncertain — neutral,
//     not a bonus, not a penalty.
//   - "none": home/blog/utility/other, or no distinctive vocabulary at
//     all — the original -1 "no dedicated page" treatment.
// -----------------------------------------------------------------------
const RELEVANCE_TOPIC_MATCH = "topic-match";
const RELEVANCE_TYPE_ONLY = "type-only";
const RELEVANCE_NONE = "none";

const RELEVANT_PAGE_TOPIC_MATCH_POINTS = 2;
const RELEVANT_PAGE_TYPE_ONLY_POINTS = 0;
const NO_RELEVANT_PAGE_POINTS = -1;

function tokenizeLabel(label) {
  return label
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function pageTopicSources(profile) {
  const fromServicePages = businessProfile.getServicePages(profile).map((p) => ({ file: p.file, tokens: tokenizeLabel(p.label) }));
  const specialtyPages = (profile.services && profile.services.specialtyPages) || [];
  const fromSpecialty = specialtyPages.map((file) => ({ file, tokens: tokenizeLabel(file.replace(/\.html$/, "").replace(/-/g, " ")) }));
  return [...fromServicePages, ...fromSpecialty];
}

let cachedPageTopicTokens = null;
function pageTopicTokenMap(profile = businessProfile.loadProfile()) {
  if (cachedPageTopicTokens) return cachedPageTopicTokens;
  const sources = pageTopicSources(profile);
  const frequency = new Map();
  for (const { tokens } of sources) {
    for (const t of new Set(tokens)) frequency.set(t, (frequency.get(t) || 0) + 1);
  }
  const map = new Map();
  for (const { file, tokens } of sources) {
    const distinctive = new Set(tokens.filter((t) => !GENERIC_BUSINESS_WORDS.has(t) && frequency.get(t) === 1));
    map.set(file, distinctive);
  }
  cachedPageTopicTokens = map;
  return map;
}

function pageTopicTokens(file, profile = businessProfile.loadProfile()) {
  return pageTopicTokenMap(profile).get(file) || new Set();
}

function landingPageRelevance(query, pageInfo, profile = businessProfile.loadProfile()) {
  const q = query.toLowerCase();
  if (pageInfo.type === "service" || pageInfo.type === "specialty") {
    const tokens = pageTopicTokens(pageInfo.file, profile);
    if (tokens.size && [...tokens].some((t) => containsWord(q, t))) return RELEVANCE_TOPIC_MATCH;
    return RELEVANCE_TYPE_ONLY;
  }
  if (pageInfo.type === "city") {
    const city = matchedCity(query, profile);
    if (city && pageInfo.citySlug && city.slug === pageInfo.citySlug) return RELEVANCE_TOPIC_MATCH;
    return RELEVANCE_TYPE_ONLY;
  }
  return RELEVANCE_NONE;
}

function hasRelevantLandingPage(relevance) {
  // Branch-ELIGIBILITY use only (e.g. near-page-1's OR condition) — any
  // non-"none" relevance still counts as "a plausible page exists" for
  // deciding whether a category applies at all; the three-tier split
  // above is what differentiates the SCORE/wording within that.
  return relevance !== RELEVANCE_NONE;
}

// -----------------------------------------------------------------------
// Aggregation — GSC's query/page dimension pair means one query can have
// several landing-page rows in a single snapshot; this collapses that to
// one query-level record (summed clicks/impressions, impression-weighted
// average position, a recomputed CTR, and the dominant landing page by
// impressions) without losing the per-page breakdown.
// -----------------------------------------------------------------------
function aggregateByQuery(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const file = urlToFile(r.landing_page);
    let agg = map.get(r.query);
    if (!agg) {
      agg = { query: r.query, clicks: 0, impressions: 0, _positionWeighted: 0, landingPages: [] };
      map.set(r.query, agg);
    }
    agg.clicks += Number(r.clicks) || 0;
    agg.impressions += Number(r.impressions) || 0;
    agg._positionWeighted += (Number(r.position) || 0) * (Number(r.impressions) || 0);
    agg.landingPages.push({ url: r.landing_page, file, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, position: Number(r.position) || 0 });
  }
  for (const agg of map.values()) {
    agg.landingPages.sort((a, b) => b.impressions - a.impressions);
    agg.position = agg.impressions > 0 ? agg._positionWeighted / agg.impressions : agg.landingPages[0].position;
    agg.ctr = agg.impressions > 0 ? agg.clicks / agg.impressions : 0;
    agg.topLandingPage = agg.landingPages[0];
    delete agg._positionWeighted;
  }
  return map;
}

function ga4RowsByFile(rows) {
  const map = new Map();
  for (const r of rows || []) map.set(urlToFile(r.landing_page), r);
  return map;
}

// Trend handling (fix #5): a trend comparison now checks whether the
// DOMINANT ranking page is the same page in both periods. If Google
// switched which page it ranks for this query between periods (a
// canonical change, a redirect, a new page outranking the old one), a
// "position improved by 6 spots" claim would really be comparing two
// different pages, not real movement on one page — so this is flagged
// explicitly and the trend's position/impression deltas are NOT scored
// (see classifyQuery()'s trend-scoring block), though they're still
// returned for transparency/debugging.
function computeTrend(current, previousMap) {
  if (!previousMap) return { state: "unavailable", detail: "No prior-period snapshot available for comparison." };
  const prev = previousMap.get(current.query);
  if (!prev) return { state: "new", detail: "This query did not appear in the prior period's analyzed rows." };
  if (current.impressions < TREND_MIN_IMPRESSIONS || prev.impressions < TREND_MIN_IMPRESSIONS) {
    return { state: "insufficient-data", detail: "Impressions too low in one or both periods for a reliable trend." };
  }
  const landingPageChanged = current.topLandingPage.file !== prev.topLandingPage.file;
  const impressionsDelta = current.impressions - prev.impressions;
  const impressionsPctChange = prev.impressions > 0 ? impressionsDelta / prev.impressions : null;
  const base = {
    state: "available",
    landingPageChanged,
    impressionsDelta,
    impressionsPctChange,
    clicksDelta: current.clicks - prev.clicks,
    positionDelta: prev.position - current.position, // positive = improved (moved up toward position 1)
    ctrDelta: current.ctr - prev.ctr,
    previous: { impressions: prev.impressions, clicks: prev.clicks, position: prev.position, ctr: prev.ctr },
  };
  if (landingPageChanged) {
    return {
      ...base,
      previousLandingPage: prev.topLandingPage.file,
      currentLandingPage: current.topLandingPage.file,
      detail: `The dominant ranking page changed between periods (was ${prev.topLandingPage.file}, now ${current.topLandingPage.file}) — Google may simply be ranking a different page for this query, not moving the same page, so position/impression changes are not described as a clean improvement or decline.`,
    };
  }
  return base;
}

function buildGa4Enrichment(topLandingPageFile, ga4Map) {
  const row = ga4Map.get(topLandingPageFile);
  if (!row) return null;
  let note;
  if (!(row.organic_sessions > 0)) {
    note = "No GA4 organic sessions recorded for this landing page in the period.";
  } else if (row.engagement_rate >= 0.6) {
    note = "This landing page already engages organic visitors well.";
  } else if (row.engagement_rate <= 0.3) {
    note = "This landing page gets organic traffic but has weak engagement.";
  } else {
    note = "This landing page has moderate organic engagement.";
  }
  return {
    organicUsers: row.organic_users,
    organicSessions: row.organic_sessions,
    engagedSessions: row.engaged_sessions,
    engagementRate: row.engagement_rate,
    keyEvents: row.key_events,
    note,
  };
}

const CATEGORY_LABELS = {
  "priority-now": "Priority Now",
  "near-page-1": "Near Page 1",
  "ctr-opportunity": "CTR Opportunity",
  "content-gap": "Content Gap",
  "protect-maintain": "Protect / Maintain",
};

// Evidence confidence (fix #4) — deliberately a SEPARATE axis from
// `priority`. `priority` answers "how much business value is here, given
// what we found"; `evidenceConfidence` answers "how much should you trust
// that read, given the sample size." A 10-impression query can still be a
// real, high-value opportunity (HIGH priority) while carrying LOW
// confidence — the UI must show both, never collapse one into the other.
const EVIDENCE_CONFIDENCE_LABELS = { weak: "LOW", moderate: "MEDIUM", strong: "HIGH" };

const CONTENT_GAP_SEVERITY_LABELS = {
  "near-miss": "Near miss — just past page one",
  "weak-visibility": "Weak visibility",
  "very-weak-visibility": "Very weak visibility",
};

function priorityLevel(category, score) {
  if (category === "protect-maintain") return "MAINTAIN";
  if (score >= 6) return "HIGH";
  if (score >= 3) return "MEDIUM";
  return "LOW";
}

/**
 * Classifies ONE already-aggregated query into a category, with an
 * explainable score and the specific reasons behind it. Pure function —
 * same inputs always produce the same output.
 */
function classifyQuery({ agg, trend, ga4, profile = businessProfile.loadProfile() }) {
  const { query, clicks, impressions, ctr, position, topLandingPage } = agg;
  const branded = isBranded(query, profile);
  const commercial = hasCommercialIntent(query, profile);
  const local = hasLocalIntent(query, profile);
  const pageInfo = classifyLandingPage(topLandingPage.file, profile);
  const relevance = landingPageRelevance(query, pageInfo, profile);
  const relevantPage = hasRelevantLandingPage(relevance);
  const evidence = impressions >= STRONG_EVIDENCE_IMPRESSIONS ? "strong" : impressions >= MIN_EVIDENCE_IMPRESSIONS ? "moderate" : "weak";

  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };

  if (branded) add(0, "Branded query — matches the business's own name, handled as Protect/Maintain by default.");
  if (commercial) add(3, "Commercial service-intent query — matches a core service this business offers.");
  if (local) add(2, "Local/city-intent query — matches this business's service area.");

  if (relevance === RELEVANCE_TOPIC_MATCH) {
    add(RELEVANT_PAGE_TOPIC_MATCH_POINTS, `Existing landing page is topically matched to this query (${pageInfo.label}).`);
  } else if (relevance === RELEVANCE_TYPE_ONLY) {
    add(RELEVANT_PAGE_TYPE_ONLY_POINTS, `Ranking page (${pageInfo.label}) is a plausible page type for this query, but topical match to the exact phrase is uncertain — treated as neutral, not confirmed relevant.`);
  } else if (!branded) {
    add(NO_RELEVANT_PAGE_POINTS, "No clearly matching dedicated landing page found for this query's intent.");
  }

  if (evidence === "weak") add(-5, `Only ${impressions} impression(s) in this period — too little evidence for a confident recommendation.`);
  else if (evidence === "strong") add(2, `${impressions} impressions — strong evidence volume.`);
  else add(1, `${impressions} impressions — moderate evidence volume.`);

  const expectedCtr = expectedCtrForPosition(position);
  const ctrRatio = expectedCtr > 0 ? ctr / expectedCtr : 1;
  const hasCtrGap = position <= PAGE_ONE_POSITION && evidence !== "weak" && ctrRatio < CTR_GAP_RATIO;
  const likelyLocalPack = hasCtrGap && local && position <= LOCAL_PACK_POSITION_MAX && clicks === 0;
  if (hasCtrGap) {
    if (likelyLocalPack) {
      add(
        CTR_GAP_LOCAL_PACK_POINTS,
        `CTR (${(ctr * 100).toFixed(2)}%) is below the typical rate for position ${position.toFixed(1)} (~${(expectedCtr * 100).toFixed(1)}%), but this is a local-intent query ranking in the top ${LOCAL_PACK_POSITION_MAX} with zero clicks — a classic signature of Google's local 3-pack/map-pack absorbing clicks rather than a listing (title/meta) problem. Treated as a lower-confidence signal.`
      );
    } else {
      add(CTR_GAP_POINTS, `CTR (${(ctr * 100).toFixed(2)}%) is well below the typical rate for position ${position.toFixed(1)} (~${(expectedCtr * 100).toFixed(1)}%) — worth investigating.`);
    }
  }

  if (trend && trend.state === "available" && !trend.landingPageChanged) {
    if (trend.positionDelta > TREND_POSITION_DELTA_THRESHOLD) add(1, `Position improved ${trend.positionDelta.toFixed(1)} spot(s) vs. the prior period.`);
    else if (trend.positionDelta < -TREND_POSITION_DELTA_THRESHOLD) add(-1, `Position declined ${Math.abs(trend.positionDelta).toFixed(1)} spot(s) vs. the prior period.`);
    if (trend.impressionsPctChange != null) {
      if (trend.impressionsPctChange >= TREND_IMPRESSIONS_PCT_THRESHOLD) add(1, `Impressions up ${(trend.impressionsPctChange * 100).toFixed(0)}% vs. the prior period.`);
      else if (trend.impressionsPctChange <= -TREND_IMPRESSIONS_PCT_THRESHOLD) add(-1, `Impressions down ${(Math.abs(trend.impressionsPctChange) * 100).toFixed(0)}% vs. the prior period.`);
    }
  } else if (trend && trend.state === "available" && trend.landingPageChanged) {
    reasons.push(`The ranking landing page changed since the prior period (was ${trend.previousLandingPage}, now ${trend.currentLandingPage}) — trend not scored, since the change may reflect Google switching pages rather than real ranking movement.`);
  }

  let category;
  let recommendedAction;
  let contentGapSeverity = null;
  const alsoQualifiesFor = [];

  if (evidence === "weak" && !branded) {
    category = "excluded-low-evidence";
    recommendedAction = "Not enough impressions yet to support a specific recommendation.";
  } else if (hasCtrGap) {
    category = "ctr-opportunity";
    if ((commercial || local) && !branded) alsoQualifiesFor.push("priority-now");
    recommendedAction = likelyLocalPack
      ? "This may well be explained by Google's local 3-pack / map-pack showing above or instead of the organic listing for this query — before touching any title or meta description, check how the live SERP actually renders for this exact query. If a map pack or local panel is absorbing the clicks, no on-page edit will change that."
      : "Investigate before changing anything: check whether a SERP feature, a query-intent mismatch, low-volume noise, a canonical/URL variant, or a landing-page mismatch explains the low clicks — then decide whether the listing itself (title, meta description, schema) genuinely needs a change.";
  } else if (branded) {
    category = "protect-maintain";
    recommendedAction = "No action needed — this branded query is performing as expected. Avoid unrelated rewrites to its landing page.";
  } else if (position <= PAGE_ONE_POSITION && (commercial || local)) {
    if (ctrRatio < PRIORITY_NOW_CTR_RATIO) {
      category = "priority-now";
      recommendedAction = `Already visible on page one for a commercial query with some CTR headroom — review ${pageInfo.label}'s title, meta description, and schema for a conversion-focused improvement.`;
    } else {
      category = "protect-maintain";
      recommendedAction = "Performing at or above the typical rate for this position — avoid unnecessary changes.";
    }
  } else if (position > PAGE_ONE_POSITION && position <= CONTENT_GAP_MIN_POSITION && (commercial || local || relevantPage)) {
    category = "near-page-1";
    recommendedAction = `Commercial/local-intent query ranking just outside page one — review whether ${pageInfo.label} (or a dedicated page) is the intended ranking target before changing content.`;
  } else if (position > CONTENT_GAP_MIN_POSITION && (commercial || local)) {
    category = "content-gap";
    if (position <= CONTENT_GAP_NEAR_MISS_MAX) {
      contentGapSeverity = "near-miss";
      add(CONTENT_GAP_NEAR_MISS_POINTS, "Ranking is just past page one — a near-miss, relatively close to realistic recovery.");
    } else if (position <= CONTENT_GAP_WEAK_VISIBILITY_MAX) {
      contentGapSeverity = "weak-visibility";
      add(CONTENT_GAP_WEAK_VISIBILITY_POINTS, "Ranking is weak — recovery here is less certain than a near-miss.");
    } else {
      contentGapSeverity = "very-weak-visibility";
      add(CONTENT_GAP_VERY_WEAK_VISIBILITY_POINTS, "Ranking is very weak — treat as a longer-shot, lower-confidence content-gap signal.");
    }
    const severityPhrase = { "near-miss": "just past page one", "weak-visibility": "weak", "very-weak-visibility": "very weak" }[contentGapSeverity];
    if (relevance === RELEVANCE_TOPIC_MATCH) {
      recommendedAction = `A topically-matched dedicated page (${pageInfo.label}) already exists for this query, but ranking is ${severityPhrase} (position ${position.toFixed(1)}) — investigate underperformance (content depth, internal linking, page authority, or intent-fit), not a missing page. This is evidence for research, not an automatic rewrite.`;
    } else if (relevance === RELEVANCE_TYPE_ONLY) {
      recommendedAction = `A page of a plausibly related type (${pageInfo.label}) exists, but it's unclear whether it's really targeted at this exact phrasing, and ranking is ${severityPhrase} (position ${position.toFixed(1)}) — review whether this page (or a more specifically worded one) should target this query before concluding content is missing. This is evidence for research, not an automatic rewrite.`;
    } else {
      recommendedAction = `No clearly dedicated landing page was found and ranking is ${severityPhrase} (position ${position.toFixed(1)}) — this may indicate a genuine content gap, but also consider whether this is simply a broad/competitive term before creating anything. This is evidence for research, not an automatic rewrite.`;
    }
  } else {
    category = "excluded-low-evidence";
    recommendedAction = "No clear commercial/local/branded intent detected and no strong signal — not actionable from this evidence alone.";
  }

  return {
    query,
    category,
    categoryLabel: CATEGORY_LABELS[category] || category,
    alsoQualifiesFor,
    priority: priorityLevel(category, score),
    score,
    reasons,
    metrics: { impressions, clicks, ctr, position },
    evidenceStrength: evidence,
    evidenceConfidence: EVIDENCE_CONFIDENCE_LABELS[evidence],
    landingPage: { url: topLandingPage.url, file: topLandingPage.file, label: pageInfo.label, type: pageInfo.type, relevance },
    trend,
    ga4,
    recommendedAction,
    likelyLocalPack,
    contentGapSeverity,
    contentGapSeverityLabel: contentGapSeverity ? CONTENT_GAP_SEVERITY_LABELS[contentGapSeverity] : null,
    intent: { branded, commercial, local },
  };
}

/**
 * Pure classification core — given already-fetched row arrays (no DB, no
 * network), returns the full categorized result.
 */
function analyzeSnapshot({ currentRows, previousRows, ga4Rows, profile = businessProfile.loadProfile(), limitPerCategory = DEFAULT_LIMIT_PER_CATEGORY, now = new Date() } = {}) {
  const currentMap = aggregateByQuery(currentRows);
  const previousMap = previousRows ? aggregateByQuery(previousRows) : null;
  const ga4Map = ga4RowsByFile(ga4Rows);

  const classified = [];
  for (const agg of currentMap.values()) {
    const trend = computeTrend(agg, previousMap);
    const ga4 = buildGa4Enrichment(agg.topLandingPage.file, ga4Map);
    classified.push(classifyQuery({ agg, trend, ga4, profile }));
  }

  const groups = { "priority-now": [], "near-page-1": [], "ctr-opportunity": [], "content-gap": [], "protect-maintain": [] };
  let excludedLowEvidenceCount = 0;
  for (const c of classified) {
    if (c.category === "excluded-low-evidence") {
      excludedLowEvidenceCount += 1;
      continue;
    }
    groups[c.category].push(c);
  }

  const categories = {};
  for (const key of Object.keys(groups)) {
    const sorted = groups[key].slice().sort((a, b) => b.score - a.score || b.metrics.impressions - a.metrics.impressions);
    categories[key] = { label: CATEGORY_LABELS[key], total: sorted.length, items: sorted.slice(0, limitPerCategory) };
  }

  return {
    generatedAt: now.toISOString(),
    totalQueriesAnalyzed: classified.length,
    excludedLowEvidenceCount,
    categories,
  };
}

/**
 * Full entry point: reads the latest + prior GSC snapshot (and the latest
 * GA4 landing-page snapshot, best-effort) from Supabase via
 * search-snapshots.js's recentQueryRows(), then classifies.
 */
async function analyzeKeywordOpportunities({ db, now = new Date(), limitPerCategory } = {}) {
  try {
    if (db === undefined) db = getServiceClient();
  } catch (_) {
    db = null;
  }
  if (!db) return { available: false, state: "storage_error" };

  const gsc = await recentQueryRows(db, "gsc", { limit: ROW_FETCH_LIMIT, periodsCount: 2 });
  if (!gsc.available) return { available: false, state: gsc.state };

  const current = gsc.periods[0];
  const previous = gsc.periods[1] || null;

  let ga4Rows = [];
  try {
    const ga4 = await recentQueryRows(db, "ga4", { limit: ROW_FETCH_LIMIT, periodsCount: 1 });
    if (ga4.available) ga4Rows = ga4.periods[0].rows;
  } catch (_) {
    ga4Rows = [];
  }

  const analysis = analyzeSnapshot({
    currentRows: current.rows,
    previousRows: previous ? previous.rows : null,
    ga4Rows,
    limitPerCategory,
    now,
  });

  return {
    available: true,
    state: "success",
    period: { start: current.snapshot.period_start, end: current.snapshot.period_end, property: current.snapshot.property, collectedAt: current.snapshot.collected_at },
    previousPeriod: previous ? { start: previous.snapshot.period_start, end: previous.snapshot.period_end } : null,
    ...analysis,
  };
}

module.exports = {
  CATEGORY_LABELS,
  EVIDENCE_CONFIDENCE_LABELS,
  CONTENT_GAP_SEVERITY_LABELS,
  MIN_EVIDENCE_IMPRESSIONS,
  STRONG_EVIDENCE_IMPRESSIONS,
  PAGE_ONE_POSITION,
  NEAR_PAGE_ONE_MAX,
  CONTENT_GAP_NEAR_MISS_MAX,
  CONTENT_GAP_WEAK_VISIBILITY_MAX,
  CTR_GAP_RATIO,
  PRIORITY_NOW_CTR_RATIO,
  LOCAL_PACK_POSITION_MAX,
  RELEVANCE_TOPIC_MATCH,
  RELEVANCE_TYPE_ONLY,
  RELEVANCE_NONE,
  expectedCtrForPosition,
  brandPhrase,
  strippedBusinessWords,
  isBranded,
  serviceIntentTerms,
  specialtyIntentWords,
  hasCommercialIntent,
  matchedCity,
  hasLocalIntent,
  urlToFile,
  classifyLandingPage,
  landingPageRelevance,
  hasRelevantLandingPage,
  aggregateByQuery,
  computeTrend,
  buildGa4Enrichment,
  classifyQuery,
  analyzeSnapshot,
  analyzeKeywordOpportunities,
};
