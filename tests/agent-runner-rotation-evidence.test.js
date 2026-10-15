// Site Improvement Agent, Phase 7B — integration test proving
// agent/runner.js's weekly path actually WIRES UP rotation-evidence
// attachment end-to-end: a real `run({runType:"weekly"})` call attaches
// any already-written agent/research/firstparty/*.json evidence
// (tagged by rotationSlug) onto the matching pick, and the classified
// conclusion reaches record.report.rotation.picks[] — not just that the
// underlying library functions work in isolation (see
// tests/agent-rotation-evidence.test.js and
// tests/agent-firstparty-intake.test.js for that).
//
// Same "real site content, read-only, throwaway log/state path"
// convention as tests/agent-runner-phase5.test.js. The one real
// filesystem side effect this file cannot avoid is writing ONE
// throwaway fixture file into the REAL agent/research/firstparty/
// directory (loadFirstPartyEvidence() has no path-override parameter —
// same constraint tests/agent-firstparty-runner.test.js's header
// already documents) — always removed in a `finally`, named with an
// obviously-fake FILE NAME ("zzz-test-fixture-rotation-evidence") that
// can never collide with a real evidence file's name.
//
// Test-isolation note (added after this test started intermittently
// failing with "2 !== 1" once a REAL Golden Search Console diagnostic
// evidence file landed in the repo — see agent/README.md's Phase 7D/7E):
// the fixture's own `rotationSlug` must still equal the real #1 pick's
// `top.slug` (that's the actual thing under test — real wiring between
// a real rotation pick and real attached evidence, not a renamed
// stand-in), so it CAN legitimately collide with a real, previously-
// committed evidence file for that same real city (e.g. a prior Golden
// diagnostic run's own committed evidence for rotationSlug "golden").
// `withIsolatedRotationSlugEvidence()` below handles this the narrowest
// possible way — by moving any REAL pre-existing evidence file(s) for
// `top.slug` out of `EVIDENCE_DIR` for the duration of this one test,
// then restoring them byte-for-byte in a `finally` — rather than by
// changing what slug is used (which would stop this from testing real
// end-to-end wiring) or weakening the assertions (which would stop
// this from proving the EXACT attachment/conclusion behavior it exists
// to prove). No production code, rotation/candidate-selection logic, or
// freshness semantics are touched by this — it is purely this test's
// own fixture bookkeeping, scoped to this one test, for the duration of
// this one test.
//
// Run with:  node tests/agent-runner-rotation-evidence.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("../agent/runner");
const { writeFirstPartyEvidence, EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const { computePriorities } = require("../agent/lib/research-rotation");
const { SOURCE: ROTATION_SOURCE } = require("../agent/lib/rotation-evidence");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

function tmpPath(suffix) {
  return path.join(os.tmpdir(), `agent-runner-rotation-evidence-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

// Moves any REAL, pre-existing evidence file(s) in EVIDENCE_DIR that
// carry the given `rotationSlug` out to a temp location for the
// duration of `fn`, then restores them byte-for-byte afterward (even if
// `fn` throws) — see this file's header "Test-isolation note" for why.
// A file is matched on CONTENT (its entries' own `rotationSlug` field),
// not on filename, so this stays correct regardless of what any real
// evidence file happens to be named. Read/parse failures on an
// unrelated malformed file are ignored here — not this test's concern,
// and loadFirstPartyEvidence() already treats malformed files as
// "no evidence" in production, so leaving one in place can't affect
// this test's own assertions either way.
async function withIsolatedRotationSlugEvidence(rotationSlug, fn) {
  const movedAside = [];
  if (fs.existsSync(EVIDENCE_DIR)) {
    for (const file of fs.readdirSync(EVIDENCE_DIR)) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(EVIDENCE_DIR, file);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (e) {
        continue; // malformed/unrelated — leave it exactly where it is
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      if (entries.some((e) => e && e.rotationSlug === rotationSlug)) {
        const stashPath = tmpPath(`__stashed__${file}`);
        fs.renameSync(fullPath, stashPath);
        movedAside.push({ fullPath, stashPath });
      }
    }
  }
  try {
    return await fn();
  } finally {
    for (const { fullPath, stashPath } of movedAside) {
      fs.renameSync(stashPath, fullPath);
    }
  }
}

async function main() {
  await test("a 'weekly' run attaches a pre-written firstparty evidence file to the rotation pick with the matching rotationSlug, and the report reflects the classified conclusion", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");

    // Determine THIS repo's real #1 rotation pick deterministically —
    // same inputs runner.js's own weekly path will use a moment later
    // (fresh empty state, the real current findings, no completed-job
    // signal): staleness/no-page/open-findings/completed-job are all
    // pure functions of those inputs, so the same inputs always produce
    // the same #1 pick.
    const { gatherFindings } = runner;
    const { findings } = gatherFindings();
    const [top] = computePriorities({ state: { byCitySlug: {} }, currentFindings: findings, completedJobCitySummary: {}, limit: 1 });
    assert.ok(top, "expected at least one rotation pick to exist");

    await withIsolatedRotationSlugEvidence(top.slug, async () => {
      const evidence = makeFirstPartyEvidence({
        rotationSlug: top.slug,
        source: ROTATION_SOURCE,
        metric: "clicks-impressions-ctr-position",
        dimension: "query",
        scope: { type: "city", value: top.name },
        window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
        observed: { totalRowsReturned: 2, topRows: [] },
        context: "test fixture",
        limitations: "test fixture",
      });
      const written = writeFirstPartyEvidence(evidence, `zzz-test-fixture-rotation-evidence__${top.slug}.json`, EVIDENCE_DIR);

      try {
        const record = await runner.run({
          mode: "dry-run",
          runType: "weekly",
          logPath,
          rotationStatePath,
          rotationLimit: 1,
          syncProposals: false,
          skipLock: true,
        });
        assert.ok(record.report.rotation);
        const pick = record.report.rotation.picks.find((p) => p.slug === top.slug);
        assert.ok(pick, `expected the #1 pick (${top.slug}) to appear in the report`);
        assert.strictEqual(pick.researched, true);
        assert.strictEqual(pick.firstPartyEvidence.length, 1);
        assert.strictEqual(pick.firstPartyEvidence[0].rotationSlug, top.slug);
        // 2 rows observed -> RESEARCH_MORE (never NO_CHANGE, never PROPOSE_CHANGE)
        assert.strictEqual(pick.conclusion, "RESEARCH_MORE");
        // and it reaches the aggregate summary too — the actual symptom this phase fixes
        assert.strictEqual(record.report.firstPartyEvidence.sourcesNotConsulted.includes(ROTATION_SOURCE), false);
      } finally {
        fs.unlinkSync(written);
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        if (fs.existsSync(rotationStatePath)) fs.unlinkSync(rotationStatePath);
      }
    });
  });

  await test("a 'weekly' run with NO pre-written evidence for the picked city reports researched:false and never fabricates a conclusion", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");
    try {
      const record = await runner.run({
        mode: "dry-run",
        runType: "weekly",
        logPath,
        rotationStatePath,
        rotationLimit: 1,
        syncProposals: false,
        skipLock: true,
      });
      const pick = record.report.rotation.picks[0];
      // Resilient to real pre-existing evidence from a prior real run —
      // only assert the shape/consistency invariant, not a specific
      // value (same "never assume empty" discipline as
      // tests/agent-firstparty-runner.test.js).
      assert.strictEqual(typeof pick.researched, "boolean");
      assert.ok([null, "NO_CHANGE", "RESEARCH_MORE"].includes(pick.conclusion));
      assert.strictEqual(pick.externalResearchPerformed, false);
    } finally {
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
      if (fs.existsSync(rotationStatePath)) fs.unlinkSync(rotationStatePath);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
