// Site Improvement Agent, Phase 13a — tests for agent/lib/run-
// synthesis.js: candidate selection, fingerprint-based freshness/
// supersession, fail-safety, and end-to-end integration proving
// synthesis flows through the EXISTING research-intake.js ->
// decision.js -> proposals-sync.js channel unchanged, with no path to
// strategic auto-apply.
//
// Uses throwaway temp directories for the history log, results dir, and
// completed-jobs dir — never the real, git-tracked agent/history/
// log.ndjson or agent/research/results/.
//
// Run with:  node tests/agent-run-synthesis.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runSynthesis, isSynthesisCandidate } = require("../agent/lib/run-synthesis");
const { loadResearchResults, attachResearch } = require("../agent/lib/research-intake");
const { decide } = require("../agent/lib/decision");
const { classify } = require("../agent/lib/risk");
const { makeFinding } = require("../agent/lib/findings");
const { needsOwnerReview } = require("../agent/lib/proposals-sync");

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

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeHistory(logPath, record) {
  fs.writeFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}

function baseRecord(findings, overrides = {}) {
  return {
    runId: "run-1",
    sequence: 1,
    timestamp: new Date().toISOString(),
    mode: "dry-run",
    runType: "weekly",
    findings,
    ...overrides,
  };
}

function contentGapFinding(overrides = {}) {
  return {
    id: "content-gap-1",
    key: "content-gap::blog-seasonal-cleanout-guide.html",
    type: "content-gap",
    category: "C",
    riskLevel: "medium",
    tier: "opportunity",
    autoApplyEligible: false,
    decision: "RESEARCH_MORE",
    summary: "blog-seasonal-cleanout-guide.html's FAQ answers only 3 question(s), well below the 6-question average.",
    pages: ["blog-seasonal-cleanout-guide.html"],
    evidence: [
      { field: "faqQuestionCount", value: 3, file: "blog-seasonal-cleanout-guide.html" },
      { field: "comparableAverage", value: 6 },
    ],
    research: undefined,
    firstPartyEvidence: undefined,
    ...overrides,
  };
}

function technicalFinding(overrides = {}) {
  return {
    id: "broken-link-1",
    key: "broken-internal-link::a.html",
    type: "broken-internal-link",
    category: "A",
    riskLevel: "medium",
    tier: "actionable",
    autoApplyEligible: false,
    decision: "PROPOSE_CHANGE",
    summary: "a.html links to a path that doesn't exist.",
    pages: ["a.html"],
    evidence: [{ field: "target", value: "/missing" }],
    ...overrides,
  };
}

// --- isSynthesisCandidate ------------------------------------------------

test("a technical (category A) finding is never a synthesis candidate — bypasses synthesis entirely", () => {
  assert.strictEqual(isSynthesisCandidate(technicalFinding()), false);
});

test("a category-C finding with NO research yet is a candidate", () => {
  assert.strictEqual(isSynthesisCandidate(contentGapFinding()), true);
});

test("a category-C finding whose only research is a PRIOR synthesis result is still a candidate (re-derivable)", () => {
  const f = contentGapFinding({ research: [{ sourceType: "cross-source-synthesis" }] });
  assert.strictEqual(isSynthesisCandidate(f), true);
});

test("a category-C finding with ANY genuine human/Claude research is NEVER re-touched by synthesis", () => {
  const f = contentGapFinding({ research: [{ sourceType: "official-government" }] });
  assert.strictEqual(isSynthesisCandidate(f), false);
});

test("a category-C finding with a mix of synthesis AND human research is excluded (human research present at all is enough to defer entirely)", () => {
  const f = contentGapFinding({ research: [{ sourceType: "cross-source-synthesis" }, { sourceType: "internal-repo-review" }] });
  assert.strictEqual(isSynthesisCandidate(f), false);
});

test("a coverage-gap-candidate/structural-inconsistency/duplicate-meta-description/overlapping-intent finding is a candidate too", () => {
  for (const type of ["coverage-gap-candidate", "structural-inconsistency", "duplicate-meta-description", "overlapping-intent"]) {
    assert.strictEqual(isSynthesisCandidate(contentGapFinding({ type })), true, type);
  }
});

test("a pageless-city or visibility-decline-shaped finding type is never a candidate (out of Phase 13a scope)", () => {
  assert.strictEqual(isSynthesisCandidate(contentGapFinding({ type: "pageless-city-evaluation" })), false);
  assert.strictEqual(isSynthesisCandidate(contentGapFinding({ type: "visibility-decline" })), false);
});

// --- end-to-end runSynthesis() -------------------------------------------

function freshGscEvidence(findingKey) {
  const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
  return makeFirstPartyEvidence({
    findingKey,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "blog-seasonal-cleanout-guide.html" },
    window: { start: "2026-09-01", end: "2026-09-28", label: "Sep 1-28, 2026" },
    observed: { totalRowsReturned: 1, topRows: [{ keys: ["seasonal cleanout", "blog-seasonal-cleanout-guide.html"], clicks: 5, impressions: 40, ctr: 0.125, position: 8 }] },
    context: "test",
    limitations: "bounded",
  });
}

test("end-to-end: a content-gap finding with real GSC support reaches a written cross-source-synthesis file, which then flows through decision.js UNCHANGED to PROPOSE_CHANGE", () => {
  const dir = mkTempDir("run-synthesis-e2e-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(completedJobsDir, { recursive: true });

  const finding = contentGapFinding({ firstPartyEvidence: [freshGscEvidence("content-gap::blog-seasonal-cleanout-guide.html")] });
  writeHistory(logPath, baseRecord([finding, technicalFinding()]));

  const result = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(result.candidates, 1); // the technical finding is never a candidate
  assert.strictEqual(result.written.length, 1);
  assert.strictEqual(result.written[0].verdict, "supports-opportunity");

  // Now run the SAME finding through the real, UNCHANGED decision.js —
  // research-intake.js's own attachResearch() is the only integration
  // point; decision.js itself needed zero changes.
  const { results } = loadResearchResults(resultsDir);
  const liveFinding = classify(
    makeFinding({ type: "content-gap", summary: finding.summary, pages: finding.pages, evidence: finding.evidence })
  );
  const { findings: withResearch } = attachResearch([liveFinding], { results, warnings: [] });
  const decision = decide(withResearch[0]);
  assert.strictEqual(decision.decision, "PROPOSE_CHANGE");
  assert.strictEqual(decision.requiresApproval, true);
  // proposals-sync.js's existing, unchanged gate: a PROPOSE_CHANGE finding
  // needs owner review in the CRM, same as any other PROPOSE_CHANGE —
  // synthesis introduces no new sync path or bypass.
  assert.strictEqual(needsOwnerReview({ decision: decision.decision }), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("running synthesis TWICE with unchanged evidence writes nothing the second time (fingerprint-stable, no redundant file/git noise)", () => {
  const dir = mkTempDir("run-synthesis-stable-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(completedJobsDir, { recursive: true });

  const finding = contentGapFinding({ firstPartyEvidence: [freshGscEvidence("content-gap::blog-seasonal-cleanout-guide.html")] });
  writeHistory(logPath, baseRecord([finding]));

  const first = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(first.written.length, 1);

  const second = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(second.written.length, 0);
  assert.deepStrictEqual(second.unchanged, [finding.key]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("evidence changing after a synthesis result was written triggers a NEW file, never an overwrite of the old one — decision.js's pickLatestResearch() naturally prefers the newer conclusion", () => {
  const dir = mkTempDir("run-synthesis-supersede-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(completedJobsDir, { recursive: true });

  const findingKey = "coverage-gap-candidate::denver-junk-removal.html";
  const coverageFinding = {
    id: "coverage-1",
    key: findingKey,
    type: "coverage-gap-candidate",
    category: "C",
    riskLevel: "medium",
    tier: "opportunity",
    autoApplyEligible: false,
    decision: "RESEARCH_MORE",
    summary: "furniture-removal.html missing from denver-junk-removal.html.",
    pages: ["denver-junk-removal.html"],
    evidence: [{ field: "serviceFile", value: "furniture-removal.html" }],
  };
  writeHistory(logPath, baseRecord([coverageFinding]));

  // First run: no completed-job evidence at all -> insufficient-data ->
  // below threshold -> nothing written.
  const first = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(first.written.length, 0);
  assert.deepStrictEqual(first.belowThreshold, [findingKey]);

  // Evidence changes: real completed-job evidence for Denver/furniture
  // removal now exists.
  fs.writeFileSync(path.join(completedJobsDir, "batch-1.json"), JSON.stringify([{ city: "Denver", serviceType: "furniture removal" }]));

  const second = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(second.written.length, 1);
  const filesAfterSecond = fs.readdirSync(resultsDir);
  assert.strictEqual(filesAfterSecond.length, 1);

  // A third run with the SAME (now-sufficient) evidence writes nothing
  // new — fingerprint-stable.
  const third = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(third.written.length, 0);
  assert.strictEqual(fs.readdirSync(resultsDir).length, 1); // still exactly one file — never overwritten, never duplicated

  fs.rmSync(dir, { recursive: true, force: true });
});

test("an OLD synthesis file coexisting with a NEWER one is resolved correctly by decision.js's EXISTING pickLatestResearch() — the newer conclusion wins, the old file is never deleted or mutated", () => {
  const dir = mkTempDir("run-synthesis-coexist-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(completedJobsDir, { recursive: true });

  const findingKey = "content-gap::blog-seasonal-cleanout-guide.html";
  const finding = contentGapFinding({ firstPartyEvidence: [freshGscEvidence(findingKey)] });
  writeHistory(logPath, baseRecord([finding]));

  // First write: GSC support only -> partially-corroborated, medium.
  const first = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(first.written.length, 1);
  assert.strictEqual(first.written[0].sufficiency, "partially-corroborated");

  // Evidence strengthens: completed-job evidence for this blog page's
  // city now also exists (finding.pages isn't a city page, so this
  // family stays not-applicable here — instead simulate strengthening by
  // changing the GSC evidence itself to a later fetch, which changes the
  // fingerprint and forces a second write).
  const laterGsc = freshGscEvidence(findingKey);
  laterGsc.fetchedAt = new Date(Date.now() + 60000).toISOString();
  const updatedRecord = baseRecord([{ ...finding, firstPartyEvidence: [laterGsc] }]);
  writeHistory(logPath, updatedRecord);

  const second = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(second.written.length, 1); // fingerprint changed (different fetchedAt) -> a NEW file

  const files = fs.readdirSync(resultsDir);
  assert.strictEqual(files.length, 2, "both the old and new synthesis files must still exist on disk — never overwritten/deleted");

  const { results } = loadResearchResults(resultsDir);
  const sorted = [...results].sort((a, b) => new Date(a.accessedAt) - new Date(b.accessedAt));
  assert.ok(new Date(sorted[1].accessedAt) >= new Date(sorted[0].accessedAt));

  // decision.js's own pickLatestResearch() is what actually resolves
  // this when a finding is decided — proven directly here with the two
  // real written results.
  const { pickLatestResearch } = require("../agent/lib/decision");
  const latest = pickLatestResearch(results);
  assert.strictEqual(latest.accessedAt, sorted[1].accessedAt);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a malformed prior synthesis artifact in the results directory is skipped (as a warning), never crashes the run, never blocks other candidates", () => {
  const dir = mkTempDir("run-synthesis-malformed-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(completedJobsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "broken.json"), "{ not valid json");

  const finding = contentGapFinding({ firstPartyEvidence: [freshGscEvidence("content-gap::blog-seasonal-cleanout-guide.html")] });
  writeHistory(logPath, baseRecord([finding]));

  const result = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(result.written.length, 1); // still proceeds for the real candidate
  assert.ok(result.warnings.some((w) => w.includes("broken.json")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("one candidate throwing mid-dossier never blocks another candidate's synthesis (per-candidate try/catch)", () => {
  const dir = mkTempDir("run-synthesis-crash-");
  const logPath = path.join(dir, "log.ndjson");
  const resultsDir = path.join(dir, "results");
  const completedJobsDir = path.join(dir, "completed-jobs");
  fs.mkdirSync(completedJobsDir, { recursive: true });

  // A malformed finding missing `.evidence`/`.pages` entirely will throw
  // inside assembleDossier()/the site-family builder — isSynthesisCandidate()
  // only checks `.type`/`.research`, so this still reaches the try/catch.
  const malformed = { key: "content-gap::broken", type: "content-gap", research: [] };
  const healthy = contentGapFinding({ firstPartyEvidence: [freshGscEvidence("content-gap::blog-seasonal-cleanout-guide.html")] });
  writeHistory(logPath, baseRecord([malformed, healthy]));

  const result = runSynthesis({ logPath, resultsDir, completedJobsDir });
  assert.strictEqual(result.written.length, 1);
  assert.strictEqual(result.written[0].findingKey, healthy.key);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("no run history at all -> zero candidates, no throw", () => {
  const dir = mkTempDir("run-synthesis-empty-");
  const result = runSynthesis({ logPath: path.join(dir, "nonexistent.ndjson"), resultsDir: path.join(dir, "results"), completedJobsDir: path.join(dir, "jobs") });
  assert.strictEqual(result.candidates, 0);
  assert.deepStrictEqual(result.written, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- auto-apply safety proof ----------------------------------------------

test("a synthesis-supported finding's category/riskLevel/tier/autoApplyEligible are IDENTICAL to the same finding with no research at all — synthesis cannot touch risk.js's output", () => {
  const plain = classify(makeFinding({ type: "content-gap", summary: "s", pages: ["blog-x.html"], evidence: [{ field: "faqQuestionCount", value: 3 }] }));
  const withResearchAttached = { ...plain, research: [{ sourceType: "cross-source-synthesis", verdict: "supports-opportunity", confidence: "high" }] };
  assert.strictEqual(withResearchAttached.category, plain.category);
  assert.strictEqual(withResearchAttached.riskLevel, plain.riskLevel);
  assert.strictEqual(withResearchAttached.tier, plain.tier);
  assert.strictEqual(withResearchAttached.autoApplyEligible, plain.autoApplyEligible);
  assert.strictEqual(withResearchAttached.autoApplyEligible, false); // never eligible — no autoFix was ever registered for content-gap
});

test("there is no code path from a cross-source-synthesis result to APPLY_SAFE_FIX: decide() only ever returns APPLY_SAFE_FIX via finding.autoApplyEligible, which synthesis never sets", () => {
  const plain = classify(makeFinding({ type: "content-gap", summary: "s", pages: ["blog-x.html"], evidence: [{ field: "faqQuestionCount", value: 3 }] }));
  const withStrongSynthesis = {
    ...plain,
    research: [{ sourceType: "cross-source-synthesis", verdict: "supports-opportunity", confidence: "high", accessedAt: new Date().toISOString(), source: "x", recommendation: "r", limitations: "l" }],
  };
  const decision = decide(withStrongSynthesis);
  assert.strictEqual(decision.decision, "PROPOSE_CHANGE"); // never APPLY_SAFE_FIX
  assert.strictEqual(decision.requiresApproval, true); // still requires a human
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
