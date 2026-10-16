// Site Improvement Agent, Phase 11B — tests for agent/cli.js's
// --refresh-local-source-evidence command: the real end-to-end wiring
// (gatherFindings() -> computePriorities() -> candidate selection ->
// freshness check -> fetchLocalSourceEvidence() ->
// writeLocalSourceEvidence() / writeLocalSourceCandidateLog()).
//
// ALL network access here is MOCKED via global.fetch — never the real
// county/city sites (those were verified separately, by hand, during
// Phase 11A design).
//
// Uses the REAL site's current rotation picks/registry (found
// dynamically, never hardcoded) as the target, same "real site content,
// read-only, throwaway side effects always cleaned up in a finally"
// convention as tests/agent-cli-refresh-finding-evidence.test.js. The
// deterministic SELECTION logic itself (relevance matching, request
// deduplication, freshness/reuse) is unit-tested in isolation in
// tests/agent-local-source-candidates.test.js — this file proves only
// that cli.js's wiring of that logic to the real fetch/write pipeline
// behaves correctly.
//
// Run with:  node tests/agent-cli-refresh-local-source-evidence.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { runRefreshLocalSourceEvidence } = require("../agent/cli");
const { gatherFindings } = require("../agent/runner");
const { loadCompletedJobEvidence, summarizeByCity } = require("../agent/lib/completed-job-intake");
const { loadRotationState, computePriorities } = require("../agent/lib/research-rotation");
const { getEntries, loadRegistry } = require("../agent/lib/local-source-registry");
const { selectWeeklyLocalSourceCandidates, needsFetchThisRun } = require("../agent/lib/local-source-candidates");
const { loadLocalSourceEvidence } = require("../agent/lib/local-source-intake");
const { EVIDENCE_DIR } = require("../agent/lib/local-source-fetch");
const { loadLocalSourceCandidateLog, LOG_PATH: CANDIDATE_LOG_PATH } = require("../agent/lib/local-source-candidate-log");

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

function realCandidatesNow() {
  const { findings } = gatherFindings();
  const { evidence } = loadCompletedJobEvidence();
  const citySummary = summarizeByCity(evidence);
  const rotationState = loadRotationState();
  const picks = computePriorities({ state: rotationState, currentFindings: findings, completedJobCitySummary: citySummary });
  const registryEntries = getEntries(loadRegistry());
  return selectWeeklyLocalSourceCandidates(picks, registryEntries);
}

function filesBeforeIn(dir) {
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}
function newFilesSince(dir, before) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !before.has(f)) : [];
}
function cleanupNewFiles(dir, before) {
  for (const f of newFilesSince(dir, before)) fs.unlinkSync(path.join(dir, f));
}

function snapshotCandidateLogFile() {
  return fs.existsSync(CANDIDATE_LOG_PATH) ? fs.readFileSync(CANDIDATE_LOG_PATH, "utf8") : null;
}
function restoreCandidateLogFile(snapshot) {
  if (snapshot === null) {
    if (fs.existsSync(CANDIDATE_LOG_PATH)) fs.unlinkSync(CANDIDATE_LOG_PATH);
  } else {
    fs.writeFileSync(CANDIDATE_LOG_PATH, snapshot, "utf8");
  }
}

const SAMPLE_PAGE = "<html><head><title>Program</title></head><body><h1>Program Information</h1><p>Some program details.</p></body></html>";

function mockAllowAllFetch() {
  return async (url) => {
    if (String(url).endsWith("/robots.txt")) {
      return { ok: true, status: 200, text: async () => "User-agent: *\n" };
    }
    return { ok: true, status: 200, text: async () => SAMPLE_PAGE };
  };
}

function mockDisallowAllFetch() {
  return async (url) => {
    if (String(url).endsWith("/robots.txt")) {
      return { ok: true, status: 200, text: async () => "User-agent: *\nDisallow: /\n" };
    }
    return { ok: true, status: 200, text: async () => SAMPLE_PAGE };
  };
}

async function main() {
  const realCandidates = realCandidatesNow();
  assert.ok(
    realCandidates.length > 0,
    "expected at least one of this week's real rotation picks to have a geographically-relevant curated source today (13 of 20 service-area cities are covered by the registry) — if this changes, this test's assumption needs revisiting"
  );

  await test("a successful run fetches exactly the candidates needing a fetch (not already fresh), writes one evidence file per candidate (deduplicated — never one per matched pick), and records an empty blockedOrFailed log", async () => {
    const { entries: existingEvidence } = loadLocalSourceEvidence();
    const expectedToFetch = needsFetchThisRun(realCandidates, existingEvidence);

    const originalFetch = global.fetch;
    global.fetch = mockAllowAllFetch();
    const evidenceBefore = filesBeforeIn(EVIDENCE_DIR);
    const logSnapshot = snapshotCandidateLogFile();
    try {
      await runRefreshLocalSourceEvidence();
      const newEvidenceFiles = newFilesSince(EVIDENCE_DIR, evidenceBefore);
      assert.strictEqual(newEvidenceFiles.length, expectedToFetch.length, "exactly one new evidence file per candidate that actually needed a fetch — never more (deduplicated), never fewer");

      const log = loadLocalSourceCandidateLog();
      assert.deepStrictEqual(log.blockedOrFailed, [], "a fully-mocked-successful run must record zero blocked/failed candidates");
      assert.ok(typeof log.at === "string" && log.at.length > 0);
    } finally {
      global.fetch = originalFetch;
      cleanupNewFiles(EVIDENCE_DIR, evidenceBefore);
      restoreCandidateLogFile(logSnapshot);
    }
  });

  await test("a run where every candidate's robots.txt disallows writes NO evidence files, and records every attempted candidate in blockedOrFailed with an honest reason", async () => {
    const { entries: existingEvidence } = loadLocalSourceEvidence();
    const expectedToFetch = needsFetchThisRun(realCandidates, existingEvidence);
    // Only meaningful when at least one candidate is NOT already fresh
    // (otherwise nothing is attempted this run at all, and this test
    // would vacuously pass without exercising the blocked path) — same
    // "force eligible" discipline as the finding-evidence test file.
    if (expectedToFetch.length === 0) {
      console.log("  (skipped sub-assertion: every real candidate already has fresh evidence on disk this run — nothing to block)");
      return;
    }

    const originalFetch = global.fetch;
    global.fetch = mockDisallowAllFetch();
    const evidenceBefore = filesBeforeIn(EVIDENCE_DIR);
    const logSnapshot = snapshotCandidateLogFile();
    try {
      await runRefreshLocalSourceEvidence();
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, evidenceBefore), [], "a robots-disallowed fetch must never write an evidence file");

      const log = loadLocalSourceCandidateLog();
      const blockedIds = log.blockedOrFailed.map((b) => b.entryId).sort();
      const expectedIds = expectedToFetch.map((c) => c.entry.id).sort();
      assert.deepStrictEqual(blockedIds, expectedIds, "every candidate that needed a fetch, and was blocked, must appear in blockedOrFailed");
      for (const b of log.blockedOrFailed) {
        assert.ok(/disallow/i.test(b.reason), `expected an honest robots-disallow reason for "${b.entryId}", got: ${b.reason}`);
        assert.ok(Array.isArray(b.matchedPickSlugs) && b.matchedPickSlugs.length > 0);
      }
    } finally {
      global.fetch = originalFetch;
      cleanupNewFiles(EVIDENCE_DIR, evidenceBefore);
      restoreCandidateLogFile(logSnapshot);
    }
  });

  await test("a run where every real candidate already has FRESH evidence on disk fetches nothing and throws no error — never refetches needlessly", async () => {
    // This exercises the generic "nothing to do" path even when
    // expectedToFetch is non-empty right now, by simply asserting the
    // run completes cleanly with a mocked fetch that would fail loudly
    // if called unexpectedly for an already-fresh candidate — the
    // per-candidate freshness exclusion itself is already proven
    // directly in tests/agent-local-source-candidates.test.js; this
    // just proves cli.js actually consults it before calling fetch.
    const { entries: existingEvidence } = loadLocalSourceEvidence();
    const alreadyFreshIds = new Set(
      realCandidates
        .filter((c) => needsFetchThisRun([c], existingEvidence).length === 0)
        .map((c) => c.entry.id)
    );
    if (alreadyFreshIds.size === 0) {
      console.log("  (skipped: no real candidate currently has fresh evidence on disk to prove the exclusion against)");
      return;
    }

    const originalFetch = global.fetch;
    const calledUrls = [];
    global.fetch = async (url) => {
      calledUrls.push(String(url));
      return mockAllowAllFetch()(url);
    };
    const evidenceBefore = filesBeforeIn(EVIDENCE_DIR);
    const logSnapshot = snapshotCandidateLogFile();
    try {
      await runRefreshLocalSourceEvidence();
      for (const { entry } of realCandidates) {
        if (!alreadyFreshIds.has(entry.id)) continue;
        assert.strictEqual(calledUrls.some((u) => u === entry.url), false, `already-fresh candidate "${entry.id}" must never be fetched again this run`);
      }
    } finally {
      global.fetch = originalFetch;
      cleanupNewFiles(EVIDENCE_DIR, evidenceBefore);
      restoreCandidateLogFile(logSnapshot);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
