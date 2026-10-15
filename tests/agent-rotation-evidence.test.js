// Site Improvement Agent, Phase 7B — tests for agent/lib/rotation-
// evidence.js: the bridge that lets a weekly rotation pick (agent/lib/
// research-rotation.js) actually get a targeted first-party evidence
// check instead of being selected and never reviewed (see that file's
// header for the full root-cause writeup this closes).
//
// Mirrors tests/agent-firstparty-candidates.test.js's structure and
// rigor for the analogous mechanical-finding case.
//
// Run with:  node tests/agent-rotation-evidence.test.js

const assert = require("assert");
const { SOURCE, isRotationEvidenceCandidate, buildRotationEvidenceRequest, classifyRotationConclusion, freshlyEvidencedRotationSlugs } = require("../agent/lib/rotation-evidence");
const { makeFirstPartyEvidence, FRESHNESS_WINDOWS_DAYS } = require("../agent/lib/firstparty-evidence");

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

function pick(overrides) {
  return { slug: "golden", name: "Golden", hasPage: false, pageFile: null, score: 60, reasons: ["never deep-reviewed"], ...overrides };
}

function evidenceFor(pickSlug, totalRowsReturned, overrides) {
  return makeFirstPartyEvidence({
    rotationSlug: pickSlug,
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query",
    scope: { type: "city", value: "Golden" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned, topRows: [] },
    context: "test",
    limitations: "test",
    ...overrides,
  });
}

// --- isRotationEvidenceCandidate ---------------------------------------

test("a pageless pick (hasPage: false) is a candidate", () => {
  assert.strictEqual(isRotationEvidenceCandidate(pick({ hasPage: false })), true);
});

test("a pick with an existing page (hasPage: true) is NEVER a candidate — it already goes through the ordinary daily/firstparty-candidates.js pipeline for that page", () => {
  assert.strictEqual(isRotationEvidenceCandidate(pick({ hasPage: true })), false);
});

test("a null/undefined pick is never a candidate (defensive)", () => {
  assert.strictEqual(isRotationEvidenceCandidate(null), false);
  assert.strictEqual(isRotationEvidenceCandidate(undefined), false);
});

// --- buildRotationEvidenceRequest ---------------------------------------

test("buildRotationEvidenceRequest() produces a ready-to-fetch search-analytics request — no orchestrator judgment needed, unlike firstparty-candidates.js's questions", () => {
  const req = buildRotationEvidenceRequest(pick());
  assert.strictEqual(req.type, "search-analytics");
  assert.strictEqual(req.rotationSlug, "golden");
  assert.deepStrictEqual(req.scope, { type: "city", value: "Golden" });
  assert.ok(Array.isArray(req.dimensionFilterGroups) && req.dimensionFilterGroups.length === 1);
  const filter = req.dimensionFilterGroups[0].filters[0];
  assert.strictEqual(filter.dimension, "query");
  assert.strictEqual(filter.operator, "contains");
  assert.strictEqual(filter.expression, "golden");
  assert.ok(typeof req.context === "string" && req.context.includes("Golden"));
});

test("buildRotationEvidenceRequest() never pre-fills a findingKey — a rotation pick is never a Finding", () => {
  const req = buildRotationEvidenceRequest(pick());
  assert.strictEqual(req.findingKey, undefined);
});

test("buildRotationEvidenceRequest() respects an explicit `days` override, defaulting to 28", () => {
  assert.strictEqual(buildRotationEvidenceRequest(pick()).days, 28);
  assert.strictEqual(buildRotationEvidenceRequest(pick(), { days: 7 }).days, 7);
});

test("buildRotationEvidenceRequest() lowercases the city name for the query filter, regardless of input casing", () => {
  const req = buildRotationEvidenceRequest(pick({ name: "Castle Rock" }));
  assert.strictEqual(req.dimensionFilterGroups[0].filters[0].expression, "castle rock");
});

// --- classifyRotationConclusion -----------------------------------------

test("no evidence entry, Search Console configured -> conclusion null, researched false, reason explains 'not researched this run'", () => {
  const result = classifyRotationConclusion(null, { searchConsoleConfigured: true });
  assert.strictEqual(result.conclusion, null);
  assert.strictEqual(result.researched, false);
  assert.ok(/not researched this run/i.test(result.reason));
});

test("no evidence entry, Search Console NOT configured -> conclusion null, researched false, reason explains the integration gap specifically", () => {
  const result = classifyRotationConclusion(null, { searchConsoleConfigured: false });
  assert.strictEqual(result.conclusion, null);
  assert.strictEqual(result.researched, false);
  assert.ok(/not configured/i.test(result.reason));
});

test("evidence entry with zero matching query rows -> NO_CHANGE, researched true, honest evidence-grounded reason", () => {
  const entry = evidenceFor("golden", 0);
  const result = classifyRotationConclusion(entry);
  assert.strictEqual(result.conclusion, "NO_CHANGE");
  assert.strictEqual(result.researched, true);
  assert.ok(/zero organic search queries/i.test(result.reason));
});

test("a zero-rows NO_CHANGE reason explicitly states the limitation: a first-party query-absence finding is NOT evidence that no local opportunity exists, and never closes the door on future research for this city — the exact distinction this regression guards", () => {
  const result = classifyRotationConclusion(evidenceFor("golden", 0));
  assert.strictEqual(result.conclusion, "NO_CHANGE");
  // Must explicitly deny the overclaim, not just omit it.
  assert.ok(/does NOT establish that no local opportunity exists/i.test(result.reason), `reason must explicitly deny the "no opportunity" overclaim; got: ${result.reason}`);
  // Must explicitly name at least one real reason GSC absence isn't proof of absence.
  assert.ok(/without naming the city|already shows up for|little to measure/i.test(result.reason), `reason must explain WHY zero rows isn't proof of no opportunity; got: ${result.reason}`);
  // Must explicitly state this never justifies creating a page (symmetry with the RESEARCH_MORE branch).
  assert.ok(/never justifies creating a page/i.test(result.reason));
  // Must explicitly state this never forecloses future research for this city.
  assert.ok(/never closes the door|future research/i.test(result.reason), `reason must explicitly state this doesn't block future research; got: ${result.reason}`);
});

test("evidence entry with at least one matching query row -> RESEARCH_MORE (NEVER PROPOSE_CHANGE), researched true", () => {
  const entry = evidenceFor("golden", 3);
  const result = classifyRotationConclusion(entry);
  assert.strictEqual(result.conclusion, "RESEARCH_MORE");
  assert.strictEqual(result.researched, true);
  assert.ok(/3 real organic search queries/i.test(result.reason));
  assert.ok(/external.*research is warranted/i.test(result.reason));
  assert.ok(/never justifies creating a page|alone never justifies/i.test(result.reason));
});

// --- freshlyEvidencedRotationSlugs ---------------------------------------
// The behavioral half of the "zero evidence must never permanently
// abandon future research for a city" requirement: cli.js's
// --refresh-rotation-evidence must re-check a city once its existing
// evidence goes stale, not skip it forever because SOME evidence file
// (however old) happens to exist.

function evidenceAgedDays(rotationSlug, ageDays, now) {
  const fetchedAt = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  return evidenceFor(rotationSlug, 0, { fetchedAt });
}

test("freshlyEvidencedRotationSlugs() includes a slug with FRESH evidence (just fetched)", () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const entries = [evidenceAgedDays("golden", 0, now)];
  const slugs = freshlyEvidencedRotationSlugs(entries, now);
  assert.ok(slugs.has("golden"));
});

test("freshlyEvidencedRotationSlugs() EXCLUDES a slug whose only evidence is STALE — it must be treated as a candidate again, never permanently skipped", () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const staleAgeDays = FRESHNESS_WINDOWS_DAYS[SOURCE].stale + 1;
  const entries = [evidenceAgedDays("golden", staleAgeDays, now)];
  const slugs = freshlyEvidencedRotationSlugs(entries, now);
  assert.strictEqual(slugs.has("golden"), false, "stale evidence must not count as 'already evidenced' — the city must become a candidate again");
});

test("freshlyEvidencedRotationSlugs() ignores entries with no rotationSlug (finding-keyed evidence), and is resilient to an empty/undefined list", () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const findingEntry = makeFirstPartyEvidence({
    findingKey: "sitemap-missing-url::x.html",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    scope: { type: "page", value: "x.html" },
    window: { start: "2026-10-01", end: "2026-10-14", label: "14 days" },
    observed: { totalRowsReturned: 0 },
    context: "test",
    limitations: "test",
  });
  assert.strictEqual(freshlyEvidencedRotationSlugs([findingEntry], now).size, 0);
  assert.strictEqual(freshlyEvidencedRotationSlugs([], now).size, 0);
  assert.strictEqual(freshlyEvidencedRotationSlugs(undefined, now).size, 0);
});

test("classifyRotationConclusion() can NEVER return PROPOSE_CHANGE, for any input — structurally capped", () => {
  const cases = [null, evidenceFor("golden", 0), evidenceFor("golden", 1), evidenceFor("golden", 999)];
  for (const c of cases) {
    const result = classifyRotationConclusion(c, { searchConsoleConfigured: true });
    assert.notStrictEqual(result.conclusion, "PROPOSE_CHANGE");
    assert.ok([null, "NO_CHANGE", "RESEARCH_MORE"].includes(result.conclusion));
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
