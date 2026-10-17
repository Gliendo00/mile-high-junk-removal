// Site Improvement Agent, First-Party Signals — functional/correctness
// tests for agent/lib/firstparty-signals.js's query-page-mismatch
// detector (the only implemented signal type this phase — see that
// file's header for why the other three candidate signal concepts are
// deliberately deferred). Safety/non-decision-influence properties are
// covered separately in tests/agent-firstparty-signals-safety.test.js.
//
// Run with:  node tests/agent-firstparty-signals.test.js

const assert = require("assert");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const { deriveQueryPageMismatchSignal, deriveFirstPartySignals, attachFirstPartySignals, resolveQueryPageIndices, SIGNAL_TYPES } = require("../agent/lib/firstparty-signals");

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

function evidenceWithRows(rows, overrides) {
  return makeFirstPartyEvidence({
    findingKey: "furniture-removal::furniture-removal.html",
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: rows.length, topRows: rows },
    context: "test fixture",
    limitations: "test fixture",
    ...overrides,
  });
}

const FINDING = { key: "furniture-removal::furniture-removal.html", pages: ["furniture-removal.html"] };

test("SIGNAL_TYPES — Phase 12 adds three comparison/delta signals alongside the original query-page-mismatch; batch-relative-rank/weak-ctr-vs-comparable remain deliberately unimplemented", () => {
  assert.deepStrictEqual(SIGNAL_TYPES, ["query-page-mismatch", "search-visibility-change", "query-visibility-shift", "lead-event-landing-page-delta"]);
});

test("resolveQueryPageIndices() finds query/page positions regardless of declared order", () => {
  assert.deepStrictEqual(resolveQueryPageIndices(evidenceWithRows([], { dimension: "query+page" })), { queryIndex: 0, pageIndex: 1 });
  assert.deepStrictEqual(resolveQueryPageIndices(evidenceWithRows([], { dimension: "page+query" })), { queryIndex: 1, pageIndex: 0 });
  assert.deepStrictEqual(resolveQueryPageIndices(evidenceWithRows([], { dimension: "query+page+device" })), { queryIndex: 0, pageIndex: 1 });
});

test("a single mismatched row produces one signal naming exactly that query/page pair, with full provenance", () => {
  const evidence = evidenceWithRows([
    { keys: ["sell my old couch", "https://www.milehighjunkremoval.net/blog-furniture-donation-guide.html"], clicks: 3, impressions: 120, ctr: 0.025, position: 9.2 },
  ]);
  const signal = deriveQueryPageMismatchSignal(FINDING, evidence);
  assert.ok(signal);
  assert.strictEqual(signal.type, "query-page-mismatch");
  assert.strictEqual(signal.findingKey, FINDING.key);
  assert.deepStrictEqual(signal.pages, ["furniture-removal.html"]);
  assert.deepStrictEqual(signal.scope, evidence.scope);
  assert.deepStrictEqual(signal.window, evidence.window);
  assert.strictEqual(signal.source, "search-console-search-analytics");
  assert.strictEqual(signal.mismatchedQueries.length, 1);
  assert.strictEqual(signal.mismatchedQueries[0].query, "sell my old couch");
  assert.strictEqual(signal.mismatchedQueries[0].observedPage, "https://www.milehighjunkremoval.net/blog-furniture-donation-guide.html");
  assert.strictEqual(signal.mismatchedQueries[0].clicks, 3);
  assert.strictEqual(signal.mismatchedQueries[0].impressions, 120);
  assert.strictEqual(signal.mismatchedQueries[0].ctr, 0.025);
  assert.strictEqual(signal.mismatchedQueries[0].position, 9.2);
});

test("a row whose page agrees with the finding's own page (any URL form) is excluded from mismatchedQueries", () => {
  const evidence = evidenceWithRows([
    { keys: ["furniture removal denver", "https://www.milehighjunkremoval.net/furniture-removal.html"], clicks: 5, impressions: 80, ctr: 0.0625, position: 3.1 }, // agrees
    { keys: ["sell my old couch", "https://milehighjunkremoval.net/blog-furniture-donation-guide.html"], clicks: 2, impressions: 60, ctr: 0.033, position: 11.0 }, // mismatch (apex host, still same identity logic)
  ]);
  const signal = deriveQueryPageMismatchSignal(FINDING, evidence);
  assert.ok(signal);
  assert.strictEqual(signal.mismatchedQueries.length, 1);
  assert.strictEqual(signal.mismatchedQueries[0].query, "sell my old couch");
});

test("multiple mismatched rows are all captured, in the order returned, up to whatever the (already upstream-bounded) evidence provides", () => {
  const evidence = evidenceWithRows([
    { keys: ["q1", "https://www.milehighjunkremoval.net/a.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    { keys: ["q2", "https://www.milehighjunkremoval.net/b.html"], clicks: 2, impressions: 20, ctr: 0.1, position: 3 },
    { keys: ["q3", "https://www.milehighjunkremoval.net/c.html"], clicks: 3, impressions: 30, ctr: 0.1, position: 4 },
  ]);
  const signal = deriveQueryPageMismatchSignal(FINDING, evidence);
  assert.strictEqual(signal.mismatchedQueries.length, 3);
  assert.deepStrictEqual(signal.mismatchedQueries.map((m) => m.query), ["q1", "q2", "q3"]);
});

test("a malformed row missing the page key is skipped, never guessed at", () => {
  const evidence = evidenceWithRows([{ keys: ["q1"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }]);
  const signal = deriveQueryPageMismatchSignal(FINDING, evidence);
  assert.strictEqual(signal, null);
});

test("non-numeric/missing clicks|impressions|ctr|position fields normalize to null, never NaN or a fabricated number", () => {
  const evidence = evidenceWithRows([{ keys: ["q1", "https://www.milehighjunkremoval.net/other.html"] }]);
  const signal = deriveQueryPageMismatchSignal(FINDING, evidence);
  assert.ok(signal);
  const row = signal.mismatchedQueries[0];
  assert.strictEqual(row.clicks, null);
  assert.strictEqual(row.impressions, null);
  assert.strictEqual(row.ctr, null);
  assert.strictEqual(row.position, null);
});

test("deriveFirstPartySignals() aggregates signals across multiple attached evidence entries on the same finding", () => {
  const evidenceA = evidenceWithRows([{ keys: ["q1", "https://www.milehighjunkremoval.net/other-a.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }]);
  const evidenceB = evidenceWithRows([{ keys: ["q2", "https://www.milehighjunkremoval.net/other-b.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }]);
  const finding = { ...FINDING, firstPartyEvidence: [evidenceA, evidenceB] };
  const signals = deriveFirstPartySignals(finding);
  assert.strictEqual(signals.length, 2);
  assert.deepStrictEqual(signals.map((s) => s.mismatchedQueries[0].query), ["q1", "q2"]);
});

test("deriveFirstPartySignals() produces no signal from a LONE GA4/URL-Inspection evidence entry — the single-evidence detectors (query-page-mismatch/search-visibility-change/query-visibility-shift) only ever derive from search-console-search-analytics evidence, and the lead-event-landing-page-delta detector needs a CORRELATED PAIR of GA4 entries (see its own dedicated tests), never just one", () => {
  const ga4Evidence = makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["furniture-removal.html"], metrics: ["5"] }] },
    context: "c",
    limitations: "l",
  });
  const urlInspectionEvidence = makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "search-console-url-inspection",
    metric: "indexStatus",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-10-14", end: "2026-10-14", label: "point-in-time inspection" },
    observed: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: null, userCanonical: null, lastCrawlTime: null },
    context: "c",
    limitations: "l",
  });
  const finding = { ...FINDING, firstPartyEvidence: [ga4Evidence, urlInspectionEvidence] };
  assert.deepStrictEqual(deriveFirstPartySignals(finding), []);
});

test("attachFirstPartySignals() sets `.firstPartySignals` (always an array) on every finding, in place, and returns the same array", () => {
  const findingWithMismatch = { ...FINDING, firstPartyEvidence: [evidenceWithRows([{ keys: ["q1", "https://www.milehighjunkremoval.net/other.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }])] };
  const findingWithNoEvidence = { key: "k2", pages: ["b.html"], firstPartyEvidence: [] };
  const out = attachFirstPartySignals([findingWithMismatch, findingWithNoEvidence]);
  assert.strictEqual(out[0].firstPartySignals.length, 1);
  assert.deepStrictEqual(out[1].firstPartySignals, []);
});

test("real committed evidence files in agent/research/firstparty/ currently produce zero query-page-mismatch signals (none of them carry both query+page dimensions) — documents today's actual baseline rather than assuming it", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "agent", "research", "firstparty");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let totalSignals = 0;
  for (const file of files) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const finding = { key: entry.findingKey || "x", pages: ["placeholder.html"] };
      const signal = deriveQueryPageMismatchSignal(finding, entry);
      if (signal) totalSignals += 1;
    }
  }
  assert.strictEqual(totalSignals, 0, "if this ever fails, a real committed evidence file now carries query+page dimensions — update this test's documentation comment, it is not a bug");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
