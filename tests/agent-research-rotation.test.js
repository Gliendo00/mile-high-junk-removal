// Site Improvement Agent, Phase 5 — weekly research rotation
// (agent/lib/research-rotation.js). Proves: prioritization covers the
// WHOLE claimed service area (not just Denver), a claimed-but-pageless
// city scores a real boost without being auto-queued for page creation,
// real signals (open findings, completed-job evidence) move the score,
// staleness tracking persists and actually changes future priority, and
// a malformed prior rotation-state file fails safe instead of throwing.
//
// Run with:  node tests/agent-research-rotation.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  computePriorities,
  loadRotationState,
  saveRotationState,
  markReviewed,
} = require("../agent/lib/research-rotation");
const businessProfile = require("../agent/lib/business-profile");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const TMP_STATE_PATH = path.join(os.tmpdir(), `agent-rotation-test-${process.pid}.json`);

function cleanup() {
  if (fs.existsSync(TMP_STATE_PATH)) fs.unlinkSync(TMP_STATE_PATH);
}

test("loadRotationState() returns an empty-but-valid state when no file exists yet", () => {
  cleanup();
  const state = loadRotationState(TMP_STATE_PATH);
  assert.deepStrictEqual(state, { byCitySlug: {} });
});

test("loadRotationState() fails safe (empty state, never throws) on a malformed prior state file", () => {
  fs.writeFileSync(TMP_STATE_PATH, "{ this is not valid json");
  const state = loadRotationState(TMP_STATE_PATH);
  assert.deepStrictEqual(state, { byCitySlug: {} });
  cleanup();
});

test("computePriorities() draws from the WHOLE claimed service area (business-profile.js), not just the cities with pages — a never-reviewed, pageless city can outrank a reviewed, paged one", () => {
  const state = { byCitySlug: {} };
  // Mark every city-with-a-page as reviewed yesterday, leaving the
  // claimed-but-pageless cities (and nothing else) unreviewed.
  const now = new Date("2026-10-14T00:00:00Z");
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  for (const c of businessProfile.getCitiesWithPages()) {
    state.byCitySlug[c.slug] = { lastReviewedAt: yesterday };
  }
  const picks = computePriorities({ state, currentFindings: [], now, limit: 5 });
  const pageless = new Set(businessProfile.getClaimedCitiesWithoutPages().map((c) => c.slug));
  assert.ok(picks.some((p) => pageless.has(p.slug)), "expected at least one claimed-but-pageless city to surface in the top picks");
});

test("computePriorities() never silently proposes creating a page — a pageless city's `hasPage` is false and its reasons say 'evaluate', not 'create'", () => {
  const picks = computePriorities({ state: { byCitySlug: {} }, currentFindings: [], limit: 20 });
  const pagelessPick = picks.find((p) => !p.hasPage);
  assert.ok(pagelessPick, "expected at least one pageless city in an unlimited-ish pick list");
  assert.ok(pagelessPick.reasons.some((r) => /evaluate, don't auto-create/i.test(r)));
});

test("an open daily-audit finding on a city's page raises that city's score above an otherwise-identical city with no open findings", () => {
  const state = { byCitySlug: {} };
  for (const c of businessProfile.getCitiesWithPages()) {
    state.byCitySlug[c.slug] = { lastReviewedAt: new Date().toISOString() };
  }
  const denverFile = businessProfile.cityPageFile("denver");
  const findings = [{ decision: "PROPOSE_CHANGE", pages: [denverFile] }];
  const picks = computePriorities({ state, currentFindings: findings, limit: businessProfile.getAllServiceAreaCities().length });
  const denver = picks.find((p) => p.slug === "denver");
  const aurora = picks.find((p) => p.slug === "aurora");
  assert.ok(denver.score > aurora.score, "a city with an open finding on its page should score higher than one with none, all else equal");
});

test("completed-job evidence for a city raises that city's score", () => {
  const state = { byCitySlug: {} };
  for (const c of businessProfile.getCitiesWithPages()) {
    state.byCitySlug[c.slug] = { lastReviewedAt: new Date().toISOString() };
  }
  const picks = computePriorities({
    state,
    currentFindings: [],
    completedJobCitySummary: { Denver: 5 },
    limit: businessProfile.getAllServiceAreaCities().length,
  });
  const denver = picks.find((p) => p.slug === "denver");
  const aurora = picks.find((p) => p.slug === "aurora");
  assert.ok(denver.score > aurora.score);
});

test("markReviewed() + saveRotationState() persist, and a freshly-reviewed city drops out of next week's top picks in favor of a never-reviewed one", () => {
  cleanup();
  let state = loadRotationState(TMP_STATE_PATH);
  const firstPicks = computePriorities({ state, currentFindings: [], limit: 1 });
  const firstPickSlug = firstPicks[0].slug;

  state = markReviewed(state, [firstPickSlug], "run-1", new Date());
  saveRotationState(state, TMP_STATE_PATH);

  const reloaded = loadRotationState(TMP_STATE_PATH);
  assert.ok(reloaded.byCitySlug[firstPickSlug] && reloaded.byCitySlug[firstPickSlug].lastReviewedAt);

  const secondPicks = computePriorities({ state: reloaded, currentFindings: [], limit: 1 });
  assert.notStrictEqual(secondPicks[0].slug, firstPickSlug, "the just-reviewed city should not immediately win the top pick again");
  cleanup();
});

test("computePriorities() respects `limit` and never returns more picks than requested", () => {
  const picks = computePriorities({ state: { byCitySlug: {} }, currentFindings: [], limit: 2 });
  assert.strictEqual(picks.length, 2);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
