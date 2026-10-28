// Site Improvement Agent, Phase 10 — the HARD safety-rule regression
// tests: Curated Official Source Evidence must never reach decision/
// proposal/apply authority. Mirrors tests/agent-firstparty-safety.test.js's
// discipline (prove something STRUCTURAL, never just "currently chooses
// not to"), adapted for Phase 10's narrower scope: this evidence isn't
// even ATTACHED to any finding/rotation pick yet (no attach function
// exists at all — see agent/lib/local-source-intake.js's own header), so
// the safety proof here is really "decision.js/research.js/the proposal
// pipeline never even KNOW this evidence category exists," plus an
// end-to-end behavioral proof that a real run's findings/decisions are
// completely unaffected by whatever local-source evidence is on disk.
//
// Run with:  node tests/agent-local-source-safety.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const AGENT_LIB_DIR = path.join(__dirname, "..", "agent", "lib");

test("agent/lib/decision.js's source never references any Phase 10 identifier (localSourceEvidence, local-source-*) at all", () => {
  const decisionSource = fs.readFileSync(path.join(AGENT_LIB_DIR, "decision.js"), "utf8");
  assert.strictEqual(/localSourceEvidence|local-source/i.test(decisionSource), false, "decision.js must have zero code paths reading Curated Official Source Evidence");
});

test("agent/lib/decision.js does not require()/import any local-source-*.js module", () => {
  const decisionSource = fs.readFileSync(path.join(AGENT_LIB_DIR, "decision.js"), "utf8");
  assert.strictEqual(/require\(["']\.\/local-source/.test(decisionSource), false);
});

test("agent/lib/research.js (the human/Claude-session verdict schema) does not require()/import any local-source-*.js module — the two evidence tracks stay genuinely independent, never one feeding the other silently", () => {
  const researchSource = fs.readFileSync(path.join(AGENT_LIB_DIR, "research.js"), "utf8");
  assert.strictEqual(/require\(["']\.\/local-source/.test(researchSource), false);
});

test("agent/lib/proposals-sync.js (the ONLY module that writes to the CRM/Supabase) does not require()/import any local-source-*.js module", () => {
  const proposalsSyncSource = fs.readFileSync(path.join(AGENT_LIB_DIR, "proposals-sync.js"), "utf8");
  assert.strictEqual(/require\(["']\.\/local-source/.test(proposalsSyncSource), false);
});

test("agent/lib/risk.js (classification -> autoApplyEligible) does not require()/import any local-source-*.js module", () => {
  const riskSource = fs.readFileSync(path.join(AGENT_LIB_DIR, "risk.js"), "utf8");
  assert.strictEqual(/require\(["']\.\/local-source/.test(riskSource), false);
});

test("no finding-producing audit module (agent/lib/*-audit.js) requires any local-source-*.js module — Curated Official Source Evidence cannot influence what gets flagged in the first place", () => {
  const auditFiles = fs.readdirSync(AGENT_LIB_DIR).filter((f) => f.endsWith("-audit.js"));
  assert.ok(auditFiles.length > 0, "sanity check: expected at least one *-audit.js module to exist");
  for (const file of auditFiles) {
    const src = fs.readFileSync(path.join(AGENT_LIB_DIR, file), "utf8");
    assert.strictEqual(/require\(["']\.\/local-source/.test(src), false, `${file} must not require any local-source-*.js module`);
  }
});

// --- Phase 11B additions: candidate SELECTION carries no authority ------

test("agent/lib/local-source-candidates.js's exports carry no verdict/confidence/recommendation/decision authority — it is a pure, network-free SELECTOR, never a judge", () => {
  const candidates = require("../agent/lib/local-source-candidates");
  const entry = {
    id: "x",
    locality: "Example, CO",
    relevantCities: ["denver"],
    domain: "example.gov",
    url: "https://www.example.gov/p",
    topic: "t",
    authorityClass: "official-government",
    expectedTemporality: "temporary",
    humanVerifiedAt: "2026-10-15",
    eligibilityNotes: "n",
  };
  const selected = candidates.selectWeeklyLocalSourceCandidates([{ slug: "denver", name: "Denver", hasPage: true }], [entry]);
  assert.strictEqual(selected.length, 1);
  for (const field of ["verdict", "confidence", "recommendation", "decision", "eligible", "qualifies"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(selected[0], field), false, `selectWeeklyLocalSourceCandidates()'s result must never carry a "${field}" field — relevance is geographic only, never an eligibility/decision verdict`);
  }
});

test("agent/lib/local-source-candidates.js does not require()/import decision.js/research.js/risk.js/proposals-sync.js — a pure selector never reaches into decision authority", () => {
  const src = fs.readFileSync(path.join(AGENT_LIB_DIR, "local-source-candidates.js"), "utf8");
  for (const forbidden of ["./decision", "./research", "./risk", "./proposals-sync"]) {
    assert.strictEqual(src.includes(`require("${forbidden}")`), false, `must not require("${forbidden}")`);
  }
});

test("local-source-evidence.js's own schema has no verdict/confidence/recommendation/decision field — structurally cannot carry a judgment (re-confirmed here as part of the safety narrative, not just in its own unit tests)", () => {
  const { makeLocalSourceEvidence } = require("../agent/lib/local-source-evidence");
  const evidence = makeLocalSourceEvidence({
    sourceUrl: "https://www.example.gov/x",
    sourceDomain: "example.gov",
    authorityClass: "official-government",
    locality: "Example, CO",
    topic: "x",
    discoveryMethod: "known-url",
    extractedSnippet: "some text",
    limitations: "l",
    robots: { checkedAt: "2026-10-15T00:00:00Z", allowed: true },
  });
  for (const field of ["verdict", "confidence", "recommendation", "decision"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(evidence, field), false);
  }
});

test("report.js's localSourceEvidence section is genuinely separate from firstPartyEvidence/firstPartySignals/research — never merged into any of them", () => {
  const { buildReport } = require("../agent/lib/report");
  const record = {
    runId: "r1",
    timestamp: new Date().toISOString(),
    runType: "daily",
    mode: "dry-run",
    summary: { pagesScanned: 1, byCategory: {} },
    findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const { makeLocalSourceEvidence } = require("../agent/lib/local-source-evidence");
  const evidence = makeLocalSourceEvidence({
    sourceUrl: "https://www.example.gov/x",
    sourceDomain: "example.gov",
    authorityClass: "official-government",
    locality: "Example, CO",
    topic: "x",
    discoveryMethod: "known-url",
    extractedSnippet: "some text",
    limitations: "l",
    robots: { checkedAt: "2026-10-15T00:00:00Z", allowed: true },
  });
  const report = buildReport({ record, previousRun: null, localSourceEvidence: { entries: [evidence], warnings: [] } });

  assert.strictEqual(report.localSourceEvidence.count, 1);
  assert.strictEqual(report.localSourceEvidence.disclaimer, "Retrieved official-source evidence — not yet interpreted as a research verdict.");
  // The other three evidence/signal/research sections must be completely
  // unaffected by the presence of local-source evidence.
  assert.strictEqual(report.firstPartyEvidence.gatheredThisRunCount, 0);
  assert.strictEqual(report.firstPartySignals.count, 0);
  assert.strictEqual(report.research.questionsRaisedCount, 0);
  // And never silently nested inside one of them.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(report.firstPartyEvidence, "localSourceEvidence"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(report.research, "localSourceEvidence"), false);
});

// -----------------------------------------------------------------------
// END-TO-END: a real runner.run() produces IDENTICAL findings/decisions
// whether or not local-source evidence files exist on disk — the
// strongest proof available given there is no per-finding attach
// function to unit-test directly in Phase 1.
// -----------------------------------------------------------------------

async function main() {
  await asyncTest("a real dry-run produces byte-identical findings/decisions whether or not a local-source evidence fixture file exists on disk", async () => {
    const os = require("os");
    const { writeLocalSourceEvidence, EVIDENCE_DIR } = require("../agent/lib/local-source-fetch");
    const { makeLocalSourceEvidence } = require("../agent/lib/local-source-evidence");
    const runner = require("../agent/runner");

    const logPathA = path.join(os.tmpdir(), `local-source-safety-a-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
    const logPathB = path.join(os.tmpdir(), `local-source-safety-b-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
    const before = new Set(fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR) : []);
    // loadLocalSourceEvidence() (local-source-intake.js) only ever loads
    // *.json files as evidence — EVIDENCE_DIR also legitimately holds a
    // non-evidence README.md (see agent/research/local-sources/README.md),
    // which `before` (a directory listing) correctly includes but which
    // must never be counted toward the expected evidence count below.
    const beforeEvidenceCount = [...before].filter((f) => f.endsWith(".json")).length;

    try {
      const recordWithout = await runner.run({ mode: "dry-run", runType: "daily", logPath: logPathA, skipLock: true, syncProposals: false });

      const evidence = makeLocalSourceEvidence({
        sourceUrl: "https://www.denvergov.org/My-Property/Recycle-Compost-Trash/Seasonal-Programs/LeafDrop-and-Pumpkin-Recycling",
        sourceDomain: "denvergov.org",
        authorityClass: "official-government",
        locality: "Denver, CO",
        topic: "leafdrop-pumpkin-composting-program",
        discoveryMethod: "known-url",
        extractedSnippet: "LeafDrop and Pumpkin Recycling. Denver's LeafDrop program allows residents to dispose of their fall leaves in an environmentally friendly way.",
        expectedTemporality: "temporary",
        limitations: "test fixture",
        robots: { checkedAt: new Date().toISOString(), allowed: true },
      });
      const written = writeLocalSourceEvidence(evidence, "zzz-test-fixture-local-source-safety.json");

      let recordWith;
      try {
        recordWith = await runner.run({ mode: "dry-run", runType: "daily", logPath: logPathB, skipLock: true, syncProposals: false });
      } finally {
        fs.unlinkSync(written);
      }

      // `id` is assigned from a process-lifetime counter (findings.js's
      // own `nextId()`) that legitimately advances between two
      // runner.run() calls within the SAME test process, regardless of
      // local-source evidence — stripped before comparing so this test
      // isn't a false negative on that unrelated, expected drift.
      // Phase 15 — `opportunityClassification.researchedAt` is a real
      // wall-clock timestamp (agent/lib/opportunity-classification.js),
      // the same category of unavoidable, legitimate drift between two
      // separate runner.run() calls a few milliseconds apart — stripped
      // for the same reason `id` is, never because its presence/shape
      // itself is in question (every OTHER field of it, including the
      // deterministic `fingerprint`, is still compared as-is).
      const stripId = (finding) => {
        const { id, ...rest } = finding;
        if (rest.opportunityClassification) {
          const { researchedAt, ...classificationRest } = rest.opportunityClassification;
          rest.opportunityClassification = classificationRest;
        }
        return rest;
      };
      assert.deepStrictEqual(recordWith.findings.map(stripId), recordWithout.findings.map(stripId), "findings/decisions must be completely unaffected by the presence of local-source evidence on disk");
      assert.deepStrictEqual(recordWith.summary, recordWithout.summary);
      // But the REPORT's own localSourceEvidence section must still
      // honestly reflect what was on disk during each run. Relative to
      // `before.size` (whatever legitimately already exists on disk at
      // test start — e.g. the real, committed Denver LeafDrop diagnostic
      // evidence file), never hardcoded to an assumed-empty directory:
      // this repo's agent/research/local-sources/ is NOT guaranteed empty
      // (a real diagnostic run has already committed one file there),
      // and asserting a literal 0 would make this test depend on that
      // directory's real contents rather than on the actual property
      // under test — that adding exactly one fixture file increases the
      // count by exactly one, on top of whatever already legitimately
      // existed.
      assert.strictEqual(recordWithout.report.localSourceEvidence.count, beforeEvidenceCount, "the pre-fixture run's report must honestly reflect however many legitimate *.json evidence files already exist on disk");
      assert.strictEqual(recordWith.report.localSourceEvidence.count, beforeEvidenceCount + 1, "adding exactly one fixture file must increase the count by exactly one on top of whatever already legitimately existed");
    } finally {
      if (fs.existsSync(logPathA)) fs.unlinkSync(logPathA);
      if (fs.existsSync(logPathB)) fs.unlinkSync(logPathB);
      for (const f of fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR) : []) {
        if (!before.has(f)) fs.unlinkSync(path.join(EVIDENCE_DIR, f));
      }
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
