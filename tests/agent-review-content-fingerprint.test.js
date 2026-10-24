// Site Improvement Agent, Phase 14 hotfix — tests for
// agent/lib/proposals-sync.js's computeReviewContentFingerprint() and
// canonicalizeForFingerprint(), the shared canonicalization both
// proposals-sync.js (sync time) and execute-proposal.js (execute time)
// call to decide whether a proposal's underlying finding has materially
// changed since it was approved.
//
// Background (second controlled Phase 14 execution test, proposal
// 6ad71748-...): a freshly generated, immediately approved, never-
// touched proposal still failed the freshness check. Root cause:
// Postgres's `jsonb` type does not preserve object key insertion order
// on storage/retrieval — a plain JS object written to a jsonb column
// can come back out with its keys reordered, even though every key/
// value pair is byte-identical. `proposedFix: finding.autoFix` was
// embedded as a raw object straight into JSON.stringify(), with none of
// the order-insensitivity `evidence` already had — so two semantically
// identical fix descriptions produced two different fingerprint
// strings purely because one came fresh from a scan and the other came
// back out of a jsonb column. canonicalizeForFingerprint() (recursively
// sorts every object's own keys; never reorders arrays, which ARE
// semantically meaningful) closes that gap for both `proposedFix` and
// every evidence value.
//
// Run with:  node tests/agent-review-content-fingerprint.test.js

const assert = require("assert");
const { computeReviewContentFingerprint, canonicalizeForFingerprint } = require("../agent/lib/proposals-sync");

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

const AUTO_FIX = { kind: "rewrite-href", file: "blog/example-page.html", from: "/old-link", to: "/new-link" };

function baseFinding(overrides = {}) {
  return {
    decision: "PROPOSE_CHANGE",
    summary: "blog/example-page.html still contains a broken internal link.",
    evidence: [{ file: "blog/example-page.html", field: "href", value: "/old-link" }],
    research: [],
    autoFix: AUTO_FIX,
    ...overrides,
  };
}

// Returns a NEW object with the SAME key/value pairs as `obj`, in a
// DELIBERATELY different key order — simulating exactly what a real
// Postgres jsonb round-trip can do to an object's key order.
function withReorderedKeys(obj) {
  const reordered = {};
  for (const key of Object.keys(obj).sort().reverse()) {
    reordered[key] = obj[key];
  }
  return reordered;
}

test("a freshly generated, immediately approved, unchanged proposal passes freshness", () => {
  const fresh = baseFinding();
  const stored = baseFinding(); // a separate, but content-identical, object
  assert.strictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("a real evidence VALUE change fails freshness", () => {
  const fresh = baseFinding();
  const stored = baseFinding({ evidence: [{ file: fresh.evidence[0].file, field: "href", value: "/some-other-value" }] });
  assert.notStrictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("a summary change fails freshness when materially relevant", () => {
  const fresh = baseFinding();
  const stored = baseFinding({ summary: "A completely different summary now." });
  assert.notStrictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("a proposed_fix change (e.g. a different `to` value) fails freshness", () => {
  const fresh = baseFinding();
  const stored = baseFinding({ autoFix: { ...AUTO_FIX, to: "/a-different-destination" } });
  assert.notStrictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("a decision change fails freshness", () => {
  const fresh = baseFinding();
  const stored = baseFinding({ decision: "NO_CHANGE" });
  assert.notStrictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("approval/execution lifecycle metadata on a DB row (reviewed_by, reviewed_at, status, execution, id, updated_at) does NOT affect the fingerprint", () => {
  const fresh = baseFinding();
  // A real agent_proposals row carries many columns computeReviewContent
  // Fingerprint() must never read — only the 5 fields it actually
  // destructures should matter. Build a row-shaped object with the SAME
  // content fields plus a pile of lifecycle metadata around it.
  const rowShaped = {
    ...baseFinding(),
    id: "0945f338-214c-4b83-ac8a-5499fb5d5d07",
    status: "applying",
    reviewed_by: "owner@milehighjunkremoval.net",
    reviewed_at: "2026-10-22T20:00:00.000Z",
    review_note: "looks good",
    updated_at: "2026-10-22T21:08:42.000Z",
    execution: { requestedAt: "2026-10-22T21:00:00.000Z", requestedBy: "owner@milehighjunkremoval.net", startedAt: "2026-10-22T21:00:05.000Z" },
  };
  assert.strictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(rowShaped));
});

test("JSON key ordering alone — in proposedFix AND in an evidence item — never causes a false mismatch (the exact bug behind proposals 0945f338-... and 6ad71748-...)", () => {
  const fresh = baseFinding();
  const stored = baseFinding({
    autoFix: withReorderedKeys(AUTO_FIX),
    evidence: [withReorderedKeys(fresh.evidence[0])],
  });
  // Prove the reordering actually happened (guards against this test
  // accidentally passing because withReorderedKeys() is a no-op).
  assert.notDeepStrictEqual(Object.keys(stored.autoFix), Object.keys(fresh.autoFix));
  assert.strictEqual(computeReviewContentFingerprint(fresh), computeReviewContentFingerprint(stored));
});

test("canonicalizeForFingerprint() sorts nested object keys recursively but preserves array order (which IS semantically meaningful)", () => {
  const value = { b: 1, a: { d: 4, c: 3 }, arr: [{ y: 2, x: 1 }, { b: 2, a: 1 }] };
  const canonical = canonicalizeForFingerprint(value);
  assert.deepStrictEqual(Object.keys(canonical), ["a", "arr", "b"]);
  assert.deepStrictEqual(Object.keys(canonical.a), ["c", "d"]);
  // Array ORDER is untouched — only each element's own object keys sort.
  assert.deepStrictEqual(Object.keys(canonical.arr[0]), ["x", "y"]);
  assert.deepStrictEqual(Object.keys(canonical.arr[1]), ["a", "b"]);
  assert.strictEqual(canonical.arr[0].y, 2);
  assert.strictEqual(canonical.arr[1].a, 1);
});

test("canonicalizeForFingerprint(null) and canonicalizeForFingerprint(undefined) both pass through unchanged (no proposed_fix is a real, common case)", () => {
  assert.strictEqual(canonicalizeForFingerprint(null), null);
  assert.strictEqual(canonicalizeForFingerprint(undefined), undefined);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
