// Site Improvement Agent, Phase 5 — weekly research rotation.
//
// Produces a short, PRIORITIZED shortlist of service-area topics worth a
// deeper look this week — never "research every city every week" (see
// agent/README.md's weekly-mode section), and never performs the research
// itself (this module has no network access, same as every other part of
// the offline runner/library — see research.js's header for why).
//
// Scoring is a small, fully-documented, deterministic sum of real signals
// — no invented search-volume/demand numbers, no 0-100 "SEO score." Every
// factor below is either (a) derived from this repo's own data (page
// existence, open findings, completed-job evidence) or (b) how long it's
// been since a topic was last reviewed, tracked in
// agent/history/research-rotation-state.json (git-tracked, like
// agent/history/log.ndjson — see history.js's header for the same
// durable-without-a-database reasoning).
//
// Covers the WHOLE service area (business-profile.js's
// getAllServiceAreaCities(), not just the 13 cities with pages) — a
// claimed-but-pageless city scores its own "evaluate whether a page is
// warranted" signal rather than being silently skipped.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const businessProfile = require("./business-profile");

const DEFAULT_STATE_PATH = path.join(config.SITE_ROOT, "agent", "history", "research-rotation-state.json");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function loadRotationState(statePath = DEFAULT_STATE_PATH) {
  if (!fs.existsSync(statePath)) {
    return { byCitySlug: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.byCitySlug !== "object" || parsed.byCitySlug === null) {
      // Malformed prior state — fail safe to "nothing reviewed yet" rather
      // than throwing (see agent/README.md's failure-safety section: a
      // corrupt side-file must never crash a run).
      return { byCitySlug: {} };
    }
    return parsed;
  } catch (e) {
    return { byCitySlug: {} };
  }
}

function saveRotationState(state, statePath = DEFAULT_STATE_PATH) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

function daysSince(isoString, now) {
  if (!isoString) return Infinity; // never reviewed — maximally overdue
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return Infinity;
  return Math.max(0, Math.round((now.getTime() - then) / MS_PER_DAY));
}

/**
 * @param {object} options
 * @param {object} [options.state] - rotation state (loadRotationState()'s shape); defaults to loading it
 * @param {object[]} [options.currentFindings] - this run's decided findings, to score "open issues on this city's page"
 * @param {object} [options.completedJobCitySummary] - city -> count, from completed-job-intake.js's summarizeByCity()
 * @param {Date} [options.now]
 * @param {number} [options.limit] - how many topics to surface this week (default 3 — see agent/README.md: "rotate intelligently", not "review everything")
 */
function computePriorities(options = {}) {
  const now = options.now || new Date();
  const state = options.state || loadRotationState();
  const findings = options.currentFindings || [];
  const completedJobCitySummary = options.completedJobCitySummary || {};
  const limit = options.limit || 3;

  const citiesWithPages = new Set(businessProfile.getCitySlugs());
  const allCities = businessProfile.getAllServiceAreaCities();

  const openFindingsByPage = {};
  for (const f of findings) {
    if (f.decision === "NO_CHANGE") continue; // not an open issue
    for (const page of f.pages || []) {
      openFindingsByPage[page] = (openFindingsByPage[page] || 0) + 1;
    }
  }

  const scored = allCities.map((city) => {
    const hasPage = citiesWithPages.has(city.slug);
    const pageFile = hasPage ? businessProfile.cityPageFile(city.slug) : null;
    const lastReviewedAt = (state.byCitySlug[city.slug] || {}).lastReviewedAt || null;
    const ageDays = daysSince(lastReviewedAt, now);
    const openFindings = pageFile ? openFindingsByPage[pageFile] || 0 : 0;
    const completedJobSignal = completedJobCitySummary[city.name] || 0;

    const reasons = [];
    // Factor 1: staleness of last deep review. Capped so one ancient city
    // can't mathematically dominate every other factor forever; "never
    // reviewed" (Infinity) is clamped to the cap, not literally infinite.
    const stalenessScore = Math.min(ageDays === Infinity ? 52 : Math.floor(ageDays / 7), 52);
    reasons.push(
      lastReviewedAt
        ? `last deep-reviewed ${ageDays} day(s) ago`
        : "never deep-reviewed by this rotation"
    );

    // Factor 2: a claimed-but-pageless city is itself worth evaluating —
    // NOT a queue of pages to create (see business-profile.json's note),
    // just a real, evidenced gap worth looking at this week.
    const noPageScore = hasPage ? 0 : 8;
    if (!hasPage) reasons.push("claimed as a service area (site's own areaServed) but has no dedicated page yet — evaluate, don't auto-create");

    // Factor 3: open mechanical findings already on this city's page —
    // a city already flagged by the daily audits is a more concrete
    // reason to look deeper than a city with nothing wrong.
    const openFindingsScore = Math.min(openFindings * 3, 12);
    if (openFindings > 0) reasons.push(`${openFindings} open daily-audit finding(s) on ${pageFile}`);

    // Factor 4: real completed-job signal (publication-safe evidence
    // only — see completed-job-intake.js) — several real jobs in a city
    // recently is a genuine, non-invented signal worth a look.
    const completedJobScore = Math.min(completedJobSignal * 2, 10);
    if (completedJobSignal > 0) reasons.push(`${completedJobSignal} publication-safe completed-job evidence entr(ies) for this city`);

    const score = stalenessScore + noPageScore + openFindingsScore + completedJobScore;

    return {
      slug: city.slug,
      name: city.name,
      hasPage,
      pageFile,
      score,
      reasons,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Pure — caller decides whether/when to persist the result (the runner
// does, after a weekly run completes). Marks every selected topic as
// reviewed "now"; everything else in state is left untouched.
function markReviewed(state, selectedSlugs, runId, now = new Date()) {
  const next = { byCitySlug: { ...state.byCitySlug } };
  for (const slug of selectedSlugs) {
    next.byCitySlug[slug] = { lastReviewedAt: now.toISOString(), lastReviewedRunId: runId };
  }
  return next;
}

module.exports = {
  DEFAULT_STATE_PATH,
  loadRotationState,
  saveRotationState,
  computePriorities,
  markReviewed,
};
