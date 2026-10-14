// Site Improvement Agent, Phase 5B — hard regression guard: a claimed-
// but-pageless service-area city (the real gap Phase 5 discovered —
// business-profile.json's 20 claimed cities vs. 13 actual city pages)
// must NEVER, by itself, produce a PROPOSE_CHANGE finding, a new-page
// recommendation, an assumed-demand claim, or any decision.js outcome at
// all. It is ONLY ever a research-rotation INVESTIGATION signal (agent/
// README.md's "Service-area page-gap rule").
//
// This holds structurally today (the daily audits only ever scan files
// that exist on disk — see scan.js's listPageFiles() — so a pageless
// city is never even scanned, let alone turned into a finding), but
// Rocky explicitly asked for a hard regression test proving it, not just
// an architectural argument — this file is that proof, at every layer
// the data passes through.
//
// Run with:  node tests/agent-service-area-guard.test.js

const assert = require("assert");
const { computePriorities } = require("../agent/lib/research-rotation");
const { buildReport } = require("../agent/lib/report");
const businessProfile = require("../agent/lib/business-profile");
const { scanAllPages } = require("../agent/lib/scan");

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

test("a rotation pick's shape carries ONLY investigation signal fields (slug/name/hasPage/score/reasons) — never a decision, recommendation, or 'create this page' field of any kind", () => {
  const picks = computePriorities({ state: { byCitySlug: {} }, currentFindings: [], limit: businessProfile.getAllServiceAreaCities().length });
  const pagelessPicks = picks.filter((p) => !p.hasPage);
  assert.ok(pagelessPicks.length > 0, "expected at least one pageless city to appear in an unlimited-ish pick list");
  for (const pick of picks) {
    const keys = Object.keys(pick).sort();
    assert.deepStrictEqual(keys, ["hasPage", "name", "pageFile", "reasons", "score", "slug"]);
    assert.ok(!("decision" in pick));
    assert.ok(!("recommendation" in pick));
    assert.ok(!("proposeNewPage" in pick));
  }
});

test("every pageless city's rotation reason is phrased as evidence to evaluate, never a conclusion that the site is deficient or that demand exists", () => {
  const picks = computePriorities({ state: { byCitySlug: {} }, currentFindings: [], limit: businessProfile.getAllServiceAreaCities().length });
  const pagelessPicks = picks.filter((p) => !p.hasPage);
  for (const pick of pagelessPicks) {
    const reasonText = pick.reasons.join(" ");
    assert.ok(/evaluate, don't auto-create/i.test(reasonText));
    assert.ok(!/demand|should create|needs a page|deficient/i.test(reasonText));
  }
});

test("a claimed-but-pageless city is never among the pages the daily/weekly audit pipeline actually scans — there is structurally no file for it to become a finding about", () => {
  const scannedFiles = new Set(scanAllPages().map((p) => p.file));
  for (const city of businessProfile.getClaimedCitiesWithoutPages()) {
    const wouldBeFile = businessProfile.cityPageFile(city.slug);
    assert.ok(!scannedFiles.has(wouldBeFile), `${wouldBeFile} must not exist as a scanned page — ${city.name} has no dedicated page`);
  }
});

test("buildReport()'s rotation section is a pure pass-through of computePriorities()'s picks — it never derives a proposal/finding from them, and the report's `proposals`/`technicalIssues` sections are computed ONLY from `findings`, never from `rotationPriorities`", () => {
  const rotationPriorities = [
    { slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed by this rotation", "claimed as a service area (site's own areaServed) but has no dedicated page yet — evaluate, don't auto-create"] },
  ];
  const record = {
    runId: "r1", timestamp: "2026-10-14T04:15:00.000Z", runType: "weekly", mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} }, findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const report = buildReport({ record, previousRun: null, rotationPriorities });
  assert.strictEqual(report.proposals.createdOrUpdatedCount, 0, "zero findings means zero proposals, regardless of what the rotation picked");
  assert.strictEqual(report.technicalIssues.actionableOpen, 0);
  assert.strictEqual(report.healthSummary.status, "all-clear", "a pageless-city rotation pick alone must never make a run look like it needs attention");
  assert.deepStrictEqual(report.rotation.picks[0], rotationPriorities[0]);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
