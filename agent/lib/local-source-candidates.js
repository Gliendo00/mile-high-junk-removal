// Site Improvement Agent, Phase 11B — deterministic local-source
// candidate eligibility for Weekly.
//
// THE GAP THIS CLOSES: Phase 10 built a curated registry and a fetch
// pipeline, but deliberately wired NOTHING to decide when a registry
// entry is actually worth fetching (its only consumer was the one-off
// manual diagnostic). The brief for this phase is explicit: Weekly must
// NOT simply fetch every registry URL every week — it must ask, for the
// location/topic it is currently investigating, whether a curated
// authoritative source is relevant, and only THAT should become a fetch
// candidate.
//
// GEOGRAPHIC RELEVANCE, NOT PROGRAM ELIGIBILITY — this is the single
// most important rule in this file, and it is enforced by NAMING, not
// just by comment: every function here answers "is this registry entry
// relevant to this city" (a lookup against the entry's own curated
// `relevantCities` — see local-source-registry.js's validateEntry()
// header), and nothing here ever asserts, returns, or implies that a
// resident of a matched city is ELIGIBLE for whatever the source
// describes. That boundary is carried on the registry entry itself
// (`eligibilityNotes`, required) and on the evidence local-source-fetch.js
// eventually writes (`limitations`, required) — this module never reads
// either field to make a decision, it only passes the matched entry
// through so a report can surface them.
//
// This module is a pure, network-free SELECTOR, same category as
// rotation-evidence.js/finding-evidence.js/firstparty-candidates.js: it
// decides WHICH already-curated registry entries are worth asking
// local-source-fetch.js to retrieve, and computes request
// deduplication/freshness — it never fetches anything itself, and it is
// never imported by decision.js (see tests/agent-local-source-safety.test.js).

const { computeLocalSourceFreshness } = require("./local-source-evidence");

/**
 * Registry entries GEOGRAPHICALLY RELEVANT to one city slug — i.e.
 * entries whose own curated `relevantCities` includes it. This is the
 * ONLY relevance test in this codebase; it is deliberately not a
 * "jurisdiction engine" (no boundary lookup, no address matching) — see
 * this file's header and agent/lib/local-source-registry.js's
 * validateEntry() for why that line is drawn here.
 * @param {string} citySlug
 * @param {object[]} registryEntries - local-source-registry.js's getEntries() shape
 */
function getRelevantSourcesForCity(citySlug, registryEntries) {
  return (registryEntries || []).filter((entry) => Array.isArray(entry.relevantCities) && entry.relevantCities.includes(citySlug));
}

/**
 * For this week's rotation picks (research-rotation.js's
 * computePriorities() shape — {slug, name, hasPage, ...}), returns a
 * DEDUPLICATED list of candidate registry entries: one entry per unique
 * registry id, even when several picks are relevant to the SAME source
 * (e.g. Lakewood and Golden are both relevant to the Jefferson County
 * SLASH entry) — see this file's header on request deduplication. Each
 * candidate records EVERY matching pick's slug, never just the first,
 * so a report can show which pick(s) made a shared source relevant this
 * week.
 * @param {object[]} picks
 * @param {object[]} registryEntries
 * @returns {{entry:object, matchedPickSlugs:string[]}[]}
 */
function selectWeeklyLocalSourceCandidates(picks, registryEntries) {
  const byId = new Map();
  for (const pick of picks || []) {
    const relevant = getRelevantSourcesForCity(pick.slug, registryEntries);
    for (const entry of relevant) {
      if (!byId.has(entry.id)) byId.set(entry.id, { entry, matchedPickSlugs: [] });
      byId.get(entry.id).matchedPickSlugs.push(pick.slug);
    }
  }
  return Array.from(byId.values());
}

/**
 * This week's rotation picks with NO geographically-relevant curated
 * source at all — an honest "no curated authoritative source for this
 * location/topic" signal, same spirit as Phase 10's own explicit
 * non-goal ("a locality/topic with no curated entry correctly surfaces
 * as external discovery unavailable — never faked"). Never silently
 * omitted from a report.
 * @returns {string[]} the slugs of picks with zero relevant sources
 */
function picksWithNoRelevantSource(picks, registryEntries) {
  return (picks || []).filter((pick) => getRelevantSourcesForCity(pick.slug, registryEntries).length === 0).map((p) => p.slug);
}

/**
 * Of `candidates` (selectWeeklyLocalSourceCandidates()'s shape), which
 * ones actually need a fetch THIS run — i.e. have no evidence on disk
 * yet, or only STALE evidence. Matches evidence to a registry entry by
 * `sourceUrl === entry.url` (guaranteed identical — see
 * local-source-fetch.js's fetchLocalSourceEvidence(), which always
 * writes `sourceUrl: entry.url`), taking the MOST RECENT evidence file
 * per url when more than one has accumulated over time (Phase 10 never
 * overwrites evidence files — one file per fetch). FRESH or AGING
 * evidence is reused (no fetch); only STALE evidence (or no evidence at
 * all) is eligible — a stale temporary source is never silently treated
 * as still current, and is never permanently suppressed from a future
 * refresh either, same rule rotation-evidence.js's
 * freshlyEvidencedRotationSlugs() already enforces for first-party
 * evidence.
 * @param {{entry:object, matchedPickSlugs:string[]}[]} candidates
 * @param {object[]} evidenceEntries - local-source-intake.js's loadLocalSourceEvidence().entries
 * @param {Date} [now]
 */
function needsFetchThisRun(candidates, evidenceEntries, now = new Date()) {
  const latestByUrl = latestEvidenceByUrl(evidenceEntries);
  return (candidates || []).filter(({ entry }) => {
    const latest = latestByUrl.get(entry.url);
    if (!latest) return true;
    return computeLocalSourceFreshness(latest, now).status === "stale";
  });
}

/**
 * The most recently-retrieved evidence entry per sourceUrl — the single
 * reusable helper both needsFetchThisRun() above and report.js's own
 * weekly-candidates section need, so freshness/reuse classification is
 * computed exactly once, the same way, in both places.
 * @param {object[]} evidenceEntries
 * @returns {Map<string, object>} sourceUrl -> most recent evidence entry
 */
function latestEvidenceByUrl(evidenceEntries) {
  const latestByUrl = new Map();
  for (const e of evidenceEntries || []) {
    const existing = latestByUrl.get(e.sourceUrl);
    if (!existing || new Date(e.retrievedAt) > new Date(existing.retrievedAt)) latestByUrl.set(e.sourceUrl, e);
  }
  return latestByUrl;
}

module.exports = {
  getRelevantSourcesForCity,
  selectWeeklyLocalSourceCandidates,
  picksWithNoRelevantSource,
  needsFetchThisRun,
  latestEvidenceByUrl,
};
