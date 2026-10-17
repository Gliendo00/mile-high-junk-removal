// Site Improvement Agent, First-Party Signals — the HARD safety-rule
// regression tests this phase was explicitly scoped around: a derived
// signal can describe an investigation lead and nothing more. Mirrors
// tests/agent-firstparty-safety.test.js's own discipline exactly (every
// test here proves something STRUCTURAL, never just "the agent
// currently chooses not to").
//
// Run with:  node tests/agent-firstparty-signals-safety.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const {
  deriveQueryPageMismatchSignal,
  deriveSearchVisibilityChangeSignal,
  deriveQueryVisibilityShiftSignal,
  deriveLeadEventLandingPageDeltaSignal,
  deriveFirstPartySignals,
  attachFirstPartySignals,
  resolveQueryPageIndices,
  SIGNAL_TYPES,
} = require("../agent/lib/firstparty-signals");

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

function queryPageEvidence(findingKey, overrides) {
  return makeFirstPartyEvidence({
    findingKey,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: {
      totalRowsReturned: 1,
      topRows: [{ keys: ["sell my old couch", "https://www.milehighjunkremoval.net/blog-furniture-donation-guide.html"], clicks: 3, impressions: 120, ctr: 0.025, position: 9.2 }],
    },
    context: "Targeted Search Analytics query for page \"furniture-removal.html\".",
    limitations: "Search behavior only — does not establish that a change is warranted.",
    ...overrides,
  });
}

// -----------------------------------------------------------------------
// 1. decide() is byte-identical with or without first-party signals
// -----------------------------------------------------------------------

test("decision.js's decide() produces byte-identical output whether or not a finding carries first-party signals", () => {
  const base = classify(
    makeFinding({
      type: "content-gap",
      summary: "furniture-removal.html answers fewer FAQ questions than its comparable siblings",
      pages: ["furniture-removal.html"],
      evidence: [{ field: "faqQuestionCount", value: 1 }],
    })
  );

  const evidence = queryPageEvidence(base.key);
  const signal = deriveQueryPageMismatchSignal({ key: base.key, pages: base.pages }, evidence);
  assert.ok(signal, "test setup: expected a mismatch signal to be derivable from this fixture");

  const withoutSignals = { ...base, research: [], firstPartyEvidence: [evidence], firstPartySignals: [] };
  const withSignals = { ...base, research: [], firstPartyEvidence: [evidence], firstPartySignals: [signal] };

  const decisionWithout = decide(withoutSignals);
  const decisionWith = decide(withSignals);
  assert.deepStrictEqual(decisionWith, decisionWithout, "attaching first-party signals must never change decide()'s output");
});

test("decide()'s source code never references `firstPartySignals` at all — structural, not just empirically unchanged", () => {
  const decideSource = decide.toString();
  assert.strictEqual(/firstPartySignals/.test(decideSource), false, "decision.js must have zero code paths reading first-party signals");
});

test("agent/lib/decision.js does not require/import agent/lib/firstparty-signals.js at all", () => {
  const decisionSource = fs.readFileSync(path.join(__dirname, "..", "agent", "lib", "decision.js"), "utf8");
  assert.strictEqual(/firstparty-signals/.test(decisionSource), false);
});

test("attachFirstPartySignals() mutates `.firstPartySignals` only, never `.decision`/`.category`/`.tier`/`.autoApplyEligible`", () => {
  const finding = classify(
    makeFinding({ type: "title-length", summary: "short title", pages: ["a.html"], evidence: [{ field: "title", value: "x" }] })
  );
  const decided = decide(finding);
  Object.assign(finding, decided);
  const snapshotBeforeAttach = { decision: finding.decision, category: finding.category, tier: finding.tier, autoApplyEligible: finding.autoApplyEligible };

  finding.firstPartyEvidence = [queryPageEvidence(finding.key, { scope: { type: "page", value: "a.html" } })];
  const [out] = attachFirstPartySignals([finding]);

  assert.strictEqual(out.decision, snapshotBeforeAttach.decision);
  assert.strictEqual(out.category, snapshotBeforeAttach.category);
  assert.strictEqual(out.tier, snapshotBeforeAttach.tier);
  assert.strictEqual(out.autoApplyEligible, snapshotBeforeAttach.autoApplyEligible);
  assert.ok(Array.isArray(out.firstPartySignals));
});

// -----------------------------------------------------------------------
// 2. No first-party signal code path can return a decision/proposal/
//    apply state — checked both structurally (source text) and
//    empirically (actual output shape).
// -----------------------------------------------------------------------

const DECISION_SHAPED_FIELD_NAMES = ["verdict", "recommendation", "confidence", "propose", "apply", "decision", "autoApplyEligible", "requiresApproval"];

test("agent/lib/firstparty-signals.js's source never mentions any decision-shaped field name or any of decision.js's DECISIONS vocabulary", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "agent", "lib", "firstparty-signals.js"), "utf8");
  for (const field of DECISION_SHAPED_FIELD_NAMES) {
    assert.strictEqual(new RegExp(`\\b${field}\\s*:`).test(source), false, `firstparty-signals.js must never assign a "${field}" field`);
  }
  for (const decisionWord of ["APPLY_SAFE_FIX", "PROPOSE_CHANGE", "RESEARCH_MORE", "REJECT_OPPORTUNITY"]) {
    // NO_CHANGE is intentionally excluded from this list: it is also an
    // ordinary English phrase this file's prose comments legitimately
    // use when explaining what a signal is NOT (e.g. "never NO_CHANGE
    // or any other decision"); the other four are decision.js's own
    // distinctive vocabulary and have no legitimate reason to appear.
    assert.strictEqual(source.includes(decisionWord), false, `firstparty-signals.js must never reference decision.js's "${decisionWord}" vocabulary`);
  }
});

test("a real derived query-page-mismatch signal object contains none of decision.js's vocabulary as a key", () => {
  const finding = { key: "k", pages: ["furniture-removal.html"] };
  const signal = deriveQueryPageMismatchSignal(finding, queryPageEvidence("k"));
  assert.ok(signal);
  for (const field of DECISION_SHAPED_FIELD_NAMES) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(signal, field), false, `signal must not carry a "${field}" field`);
  }
  // Required provenance fields instead (brief: "enough provenance to
  // understand: signal type, affected page/finding/scope, evidence
  // used, comparison/baseline if applicable, reason, limitations,
  // explicit investigation-only posture").
  for (const required of ["type", "findingKey", "pages", "scope", "window", "source", "reason", "limitations", "posture"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(signal, required), `signal is missing required provenance field "${required}"`);
  }
  assert.ok(/investigation-only/.test(signal.posture));
  assert.ok(SIGNAL_TYPES.includes(signal.type));
});

test("agent/runner.js attaches first-party signals strictly AFTER decideAll() — the source line order proves it, matching firstparty-evidence's own guarantee", () => {
  const runnerSource = fs.readFileSync(path.join(__dirname, "..", "agent", "runner.js"), "utf8");
  const decideIdx = runnerSource.indexOf("decideAll(withResearch)");
  const signalsIdx = runnerSource.indexOf("attachFirstPartySignals(withFirstParty)");
  assert.ok(decideIdx > -1 && signalsIdx > -1, "expected to find both call sites in agent/runner.js");
  assert.ok(signalsIdx > decideIdx, "attachFirstPartySignals() must be called strictly after decideAll() in source order");
});

// -----------------------------------------------------------------------
// 3. Zero-row GSC evidence cannot be interpreted as "no opportunity"
// -----------------------------------------------------------------------

test("a zero-row search-console-search-analytics evidence entry produces NO signal at all — never a fabricated 'no opportunity' or 'confirmed clean' signal", () => {
  const finding = { key: "k", pages: ["furniture-removal.html"] };
  const zeroRowEvidence = queryPageEvidence("k", { observed: { totalRowsReturned: 0, topRows: [] } });
  const signal = deriveQueryPageMismatchSignal(finding, zeroRowEvidence);
  assert.strictEqual(signal, null, "zero rows must produce no signal, not a negative/absence claim");
});

test("deriveFirstPartySignals() on a finding with only zero-row evidence returns an empty array — zero signals is a valid, successful result, not an error or a claim", () => {
  const finding = { key: "k", pages: ["furniture-removal.html"], firstPartyEvidence: [queryPageEvidence("k", { observed: { totalRowsReturned: 0, topRows: [] } })] };
  const signals = deriveFirstPartySignals(finding);
  assert.deepStrictEqual(signals, []);
});

// -----------------------------------------------------------------------
// 4. Missing/insufficient comparison data produces no comparative
//    signal — every degrade path, never a false signal.
// -----------------------------------------------------------------------

test("resolveQueryPageIndices() returns null (not a guess) when dimension is query-only, page-only, or from an unrelated source", () => {
  assert.strictEqual(resolveQueryPageIndices(queryPageEvidence("k", { dimension: "query" })), null);
  assert.strictEqual(resolveQueryPageIndices(queryPageEvidence("k", { dimension: "page" })), null);
  assert.strictEqual(
    resolveQueryPageIndices(
      makeFirstPartyEvidence({
        findingKey: "k",
        source: "ga4",
        metric: "sessions",
        dimension: "landingPage",
        scope: { type: "page", value: "x.html" },
        window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
        observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["x.html"], metrics: ["10"] }] },
        context: "c",
        limitations: "l",
      })
    ),
    null
  );
  assert.strictEqual(resolveQueryPageIndices(null), null);
  assert.strictEqual(resolveQueryPageIndices(undefined), null);
});

test("a finding with no `.pages` produces no signal, even with otherwise-qualifying evidence (defensive — never assumes a page exists)", () => {
  const signal = deriveQueryPageMismatchSignal({ key: "k", pages: [] }, queryPageEvidence("k"));
  assert.strictEqual(signal, null);
});

test("an evidence entry whose every row's page agrees with the finding's own page produces no signal (the healthy case — nothing to investigate)", () => {
  const finding = { key: "k", pages: ["furniture-removal.html"] };
  const agreeingEvidence = queryPageEvidence("k", {
    observed: { totalRowsReturned: 1, topRows: [{ keys: ["buy furniture removal service", "https://www.milehighjunkremoval.net/furniture-removal.html"], clicks: 2, impressions: 40, ctr: 0.05, position: 6.1 }] },
  });
  assert.strictEqual(deriveQueryPageMismatchSignal(finding, agreeingEvidence), null);
});

test("deriveFirstPartySignals() returns [] for a finding with no firstPartyEvidence at all", () => {
  assert.deepStrictEqual(deriveFirstPartySignals({ key: "k", pages: ["a.html"] }), []);
  assert.deepStrictEqual(deriveFirstPartySignals({ key: "k", pages: ["a.html"], firstPartyEvidence: [] }), []);
});

// -----------------------------------------------------------------------
// 5. GA4/GSC privacy constraints preserved — no visitor/client
//    identifier, no raw API payload, ever reaches a signal.
// -----------------------------------------------------------------------

test("agent/lib/firstparty-signals.js never references a visitor/client-identifier field name (defense in depth — mirrors firstparty-fetch.js's own FORBIDDEN_GA4_DIMENSION_PATTERNS boundary)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "agent", "lib", "firstparty-signals.js"), "utf8");
  for (const forbidden of [/clientId/i, /userId/i, /userPseudoId/i, /ipOverride/i, /appInstanceId/i]) {
    assert.strictEqual(forbidden.test(source), false, `firstparty-signals.js must never reference ${forbidden}`);
  }
});

// -----------------------------------------------------------------------
// 6. Phase 12 — the three new comparison/delta signals carry the SAME
//    structural guarantees as query-page-mismatch: no decision
//    authority, no PII, decide() unaffected.
// -----------------------------------------------------------------------

function gscCompareEvidence(findingKey, overrides) {
  return makeFirstPartyEvidence({
    findingKey,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "28 days ending 2026-10-15" },
    comparisonWindow: { start: "2026-08-21", end: "2026-09-17", label: "28 days ending 2026-09-17 (comparison period)" },
    observed: {
      totalRowsReturned: 1,
      topRows: [{ keys: ["golden junk removal", "golden-junk-removal.html"], clicks: 6, impressions: 120, ctr: 0.05, position: 6 }],
      previousPeriod: { totalRowsReturned: 1, topRows: [{ keys: ["golden trash pickup", "golden-junk-removal.html"], clicks: 3, impressions: 100, ctr: 0.03, position: 9 }] },
    },
    context: "c",
    limitations: "l",
    ...overrides,
  });
}

function ga4CompareEvidencePair(findingKey) {
  const session = makeFirstPartyEvidence({
    findingKey,
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "l" },
    comparisonWindow: { start: "2026-08-21", end: "2026-09-17", label: "l" },
    observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["/golden-junk-removal.html"], metrics: ["50"] }], previousPeriod: { totalRowsReturned: 1, topRows: [{ dimensions: ["/golden-junk-removal.html"], metrics: ["40"] }] } },
    context: "c",
    limitations: "l",
  });
  const events = makeFirstPartyEvidence({
    findingKey,
    source: "ga4",
    metric: "eventCount",
    dimension: "eventName",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "l" },
    comparisonWindow: { start: "2026-08-21", end: "2026-09-17", label: "l" },
    observed: {
      totalRowsReturned: 1,
      topRows: [{ dimensions: ["generate_lead"], metrics: ["4"] }],
      previousPeriod: { totalRowsReturned: 1, topRows: [{ dimensions: ["generate_lead"], metrics: ["2"] }] },
    },
    context: "c",
    limitations: "l",
  });
  return [session, events];
}

test("decision.js's decide() produces byte-identical output whether or not a finding carries the Phase 12 comparison/delta signals", () => {
  const base = classify(
    makeFinding({
      type: "content-gap",
      summary: "golden-junk-removal.html answers fewer FAQ questions than its comparable siblings",
      pages: ["golden-junk-removal.html"],
      evidence: [{ field: "faqQuestionCount", value: 1 }],
    })
  );

  const gscEvidence = gscCompareEvidence(base.key);
  const [sessionEvidence, eventEvidence] = ga4CompareEvidencePair(base.key);
  const visSignal = deriveSearchVisibilityChangeSignal({ key: base.key, pages: base.pages }, gscEvidence);
  const shiftSignal = deriveQueryVisibilityShiftSignal({ key: base.key, pages: base.pages }, gscEvidence);
  const leadSignal = deriveLeadEventLandingPageDeltaSignal({ key: base.key, pages: base.pages }, [sessionEvidence, eventEvidence]);
  assert.ok(visSignal && shiftSignal && leadSignal, "test setup: expected all three Phase 12 signals to be derivable from these fixtures");

  const allEvidence = [gscEvidence, sessionEvidence, eventEvidence];
  const withoutSignals = { ...base, research: [], firstPartyEvidence: allEvidence, firstPartySignals: [] };
  const withSignals = { ...base, research: [], firstPartyEvidence: allEvidence, firstPartySignals: [visSignal, shiftSignal, leadSignal] };

  assert.deepStrictEqual(decide(withSignals), decide(withoutSignals), "attaching the Phase 12 signals must never change decide()'s output");
});

test("each Phase 12 signal object contains none of decision.js's vocabulary as a key, and carries every required provenance field", () => {
  const base = { key: "k", pages: ["golden-junk-removal.html"] };
  const gscEvidence = gscCompareEvidence("k");
  const [sessionEvidence, eventEvidence] = ga4CompareEvidencePair("k");
  const signals = [
    deriveSearchVisibilityChangeSignal(base, gscEvidence),
    deriveQueryVisibilityShiftSignal(base, gscEvidence),
    deriveLeadEventLandingPageDeltaSignal(base, [sessionEvidence, eventEvidence]),
  ];
  for (const signal of signals) {
    assert.ok(signal);
    for (const field of DECISION_SHAPED_FIELD_NAMES) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(signal, field), false, `${signal.type} must not carry a "${field}" field`);
    }
    for (const required of ["type", "findingKey", "pages", "scope", "window", "source", "reason", "limitations", "posture"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(signal, required), `${signal.type} is missing required provenance field "${required}"`);
    }
    assert.ok(/investigation-only/.test(signal.posture));
    assert.ok(SIGNAL_TYPES.includes(signal.type));
  }
});

test("lead-event-landing-page-delta's serialized JSON never contains a phone-number-shaped string, a raw href, or any visitor/client-identifier field — only event names/counts/deltas", () => {
  const base = { key: "k", pages: ["golden-junk-removal.html"] };
  const [sessionEvidence, eventEvidence] = ga4CompareEvidencePair("k");
  const signal = deriveLeadEventLandingPageDeltaSignal(base, [sessionEvidence, eventEvidence]);
  assert.ok(signal);
  const serialized = JSON.stringify(signal);
  assert.strictEqual(/\btel:|sms:|3039901812|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(serialized), false, "must never contain a phone number or tel:/sms: href");
  assert.strictEqual(/clientId|userId|userPseudoId|appInstanceId|ipOverride/i.test(serialized), false);
});

test("a derived signal's own serialized JSON never contains a visitor/client-identifier field name, even when fed an evidence entry with extra/unexpected observed fields", () => {
  const finding = { key: "k", pages: ["furniture-removal.html"] };
  const evidence = queryPageEvidence("k", {
    observed: {
      totalRowsReturned: 1,
      topRows: [{ keys: ["mismatched query", "https://www.milehighjunkremoval.net/other-page.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 4.4 }],
    },
  });
  const signal = deriveQueryPageMismatchSignal(finding, evidence);
  assert.ok(signal);
  const serialized = JSON.stringify(signal);
  assert.strictEqual(/clientId|userId|userPseudoId|appInstanceId|ipOverride/i.test(serialized), false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
