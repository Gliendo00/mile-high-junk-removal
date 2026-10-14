// Site Improvement Agent, Phase 5 — change detection vs. the previous run
// (agent/lib/change-detection.js). Proves: a finding seen for the first
// time is "new", one also present in the previous run is "still open", a
// previous-run finding no longer present is "resolved", and proposal
// status (from proposals-sync.js's statusByKey, when sync ran) correctly
// annotates "already proposed" / "previously rejected" / "already
// applied" without a second DB round-trip.
//
// Run with:  node tests/agent-change-detection.test.js

const assert = require("assert");
const { classifyChanges, annotateWithProposalStatus } = require("../agent/lib/change-detection");

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

function finding(key) {
  return { key };
}

test("with no previous run (first ever run), every current finding is 'new' and nothing is 'resolved'", () => {
  const result = classifyChanges([finding("a"), finding("b")], null);
  assert.strictEqual(result.hasPreviousRun, false);
  assert.deepStrictEqual(result.new.sort(), ["a", "b"]);
  assert.deepStrictEqual(result.stillOpen, []);
  assert.deepStrictEqual(result.resolved, []);
});

test("a finding present in both the previous and current run is 'still open', not 'new' — prevents re-notifying on something already seen", () => {
  const previousRun = { runId: "r1", findings: [finding("a")] };
  const result = classifyChanges([finding("a")], previousRun);
  assert.deepStrictEqual(result.new, []);
  assert.deepStrictEqual(result.stillOpen, ["a"]);
});

test("a finding only in the current run (not the previous one) is 'new'", () => {
  const previousRun = { runId: "r1", findings: [finding("a")] };
  const result = classifyChanges([finding("a"), finding("b")], previousRun);
  assert.deepStrictEqual(result.new, ["b"]);
  assert.deepStrictEqual(result.stillOpen, ["a"]);
});

test("a finding in the previous run but absent from the current run is 'resolved'", () => {
  const previousRun = { runId: "r1", findings: [finding("a"), finding("b")] };
  const result = classifyChanges([finding("a")], previousRun);
  assert.deepStrictEqual(result.resolved, ["b"]);
});

test("counts object matches the actual list lengths", () => {
  const previousRun = { runId: "r1", findings: [finding("a"), finding("b")] };
  const result = classifyChanges([finding("a"), finding("c")], previousRun);
  assert.deepStrictEqual(result.counts, { new: 1, stillOpen: 1, resolved: 1 });
});

test("a previous run record with a malformed/missing `findings` array is treated as having zero previous findings, never throws", () => {
  const result = classifyChanges([finding("a")], { runId: "r1" });
  assert.deepStrictEqual(result.new, ["a"]);
});

test("annotateWithProposalStatus maps each finding's key to its synced status, defaulting to null when sync was skipped or didn't cover that key", () => {
  const annotated = annotateWithProposalStatus(
    [finding("a"), finding("b"), finding("c")],
    { a: "proposed", b: "rejected" }
  );
  assert.deepStrictEqual(annotated, [
    { key: "a", proposalStatus: "proposed" },
    { key: "b", proposalStatus: "rejected" },
    { key: "c", proposalStatus: null },
  ]);
});

test("annotateWithProposalStatus never throws when statusByKey is undefined (sync was skipped)", () => {
  const annotated = annotateWithProposalStatus([finding("a")], undefined);
  assert.deepStrictEqual(annotated, [{ key: "a", proposalStatus: null }]);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
