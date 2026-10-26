// Site Improvement Agent, Phase 2 — tests for agent/lib/keyword-
// opportunities.js: intent classification, scoring/classification rules,
// trend handling, GA4 enrichment, query->landing-page preservation,
// deterministic output, and the recentQueryRows() DB-retrieval sibling
// added to agent/lib/search-snapshots.js.
//
// Run with:  node tests/agent-keyword-opportunities.test.js

const assert = require("assert");
const {
  isBranded,
  hasCommercialIntent,
  hasLocalIntent,
  urlToFile,
  classifyLandingPage,
  landingPageRelevance,
  expectedCtrForPosition,
  aggregateByQuery,
  computeTrend,
  buildGa4Enrichment,
  classifyQuery,
  analyzeSnapshot,
} = require("../agent/lib/keyword-opportunities");
const businessProfile = require("../agent/lib/business-profile");

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

const profile = businessProfile.loadProfile();

function gscRow(query, landing_page, { clicks = 0, impressions = 10, ctr, position = 10 } = {}) {
  return { query, landing_page, clicks, impressions, ctr: ctr != null ? ctr : impressions > 0 ? clicks / impressions : 0, position };
}

function classify(query, landingFile, metricsOverrides, opts = {}) {
  const row = gscRow(query, `https://milehighjunkremoval.net/${landingFile === "index.html" ? "" : landingFile}`, metricsOverrides);
  const agg = aggregateByQuery([row]).get(query);
  const trend = opts.trend || { state: "unavailable" };
  const ga4 = opts.ga4 || null;
  return classifyQuery({ agg, trend, ga4, profile });
}

async function main() {
  // --- intent classification ---------------------------------------------

  await test("branded query classification: brand phrase derived from business-profile identity.name", () => {
    assert.strictEqual(isBranded("mile high junk removal", profile), true);
    assert.strictEqual(isBranded("mile high junk removal denver", profile), true);
    assert.strictEqual(isBranded("junk removal denver", profile), false, "generic words shared with the brand name must not themselves count as branded");
  });

  await test("commercial-intent query classification: derived from service-page labels + generic synonyms", () => {
    assert.strictEqual(hasCommercialIntent("furniture removal", profile), true);
    assert.strictEqual(hasCommercialIntent("junk hauling", profile), true);
    assert.strictEqual(hasCommercialIntent("appliance disposal", profile), true);
    assert.strictEqual(hasCommercialIntent("weather forecast denver", profile), false);
  });

  await test("local-intent query classification: known service-area city or 'near me'", () => {
    assert.strictEqual(hasLocalIntent("junk removal aurora", profile), true);
    assert.strictEqual(hasLocalIntent("junk removal near me", profile), true);
    assert.strictEqual(hasLocalIntent("junk removal", profile), false);
  });

  // --- landing-page normalization/classification --------------------------

  await test("urlToFile: joins GSC full URLs and GA4 paths to the same file key", () => {
    assert.strictEqual(urlToFile("https://milehighjunkremoval.net/furniture-removal.html"), "furniture-removal.html");
    assert.strictEqual(urlToFile("/furniture-removal.html"), "furniture-removal.html");
    assert.strictEqual(urlToFile("https://milehighjunkremoval.net/"), "index.html");
    assert.strictEqual(urlToFile("/"), "index.html");
    assert.strictEqual(urlToFile(""), "index.html");
  });

  await test("classifyLandingPage: recognizes home/service/city/specialty/other pages", () => {
    assert.strictEqual(classifyLandingPage("index.html", profile).type, "home");
    assert.strictEqual(classifyLandingPage("furniture-removal.html", profile).type, "service");
    assert.strictEqual(classifyLandingPage("aurora-junk-removal.html", profile).type, "city");
    assert.strictEqual(classifyLandingPage("office-junk-removal.html", profile).type, "specialty");
    assert.strictEqual(classifyLandingPage("some-unrelated-page.html", profile).type, "other");
  });

  // --- CTR benchmark -------------------------------------------------------

  await test("expectedCtrForPosition: monotonically decreasing benchmark, floors beyond page one", () => {
    assert.ok(expectedCtrForPosition(1) > expectedCtrForPosition(5));
    assert.ok(expectedCtrForPosition(5) > expectedCtrForPosition(10));
    assert.strictEqual(expectedCtrForPosition(25), expectedCtrForPosition(99));
  });

  // --- aggregation / query->landing-page preservation ----------------------

  await test("aggregateByQuery: sums metrics across landing pages and preserves the original URL", () => {
    const rows = [
      gscRow("furniture removal", "https://milehighjunkremoval.net/furniture-removal.html", { clicks: 3, impressions: 60, position: 4 }),
      gscRow("furniture removal", "https://milehighjunkremoval.net/", { clicks: 1, impressions: 20, position: 8 }),
    ];
    const map = aggregateByQuery(rows);
    const agg = map.get("furniture removal");
    assert.strictEqual(agg.clicks, 4);
    assert.strictEqual(agg.impressions, 80);
    assert.strictEqual(agg.topLandingPage.url, "https://milehighjunkremoval.net/furniture-removal.html", "dominant (highest-impression) landing page URL must be preserved verbatim");
    assert.ok(Math.abs(agg.position - (4 * 60 + 8 * 20) / 80) < 1e-9, "position must be impression-weighted");
  });

  await test("aggregateByQuery: zero-click queries compute a zero CTR, not NaN/undefined", () => {
    const rows = [gscRow("junk removal aurora", "https://milehighjunkremoval.net/aurora-junk-removal.html", { clicks: 0, impressions: 257, position: 1.4 })];
    const agg = aggregateByQuery(rows).get("junk removal aurora");
    assert.strictEqual(agg.clicks, 0);
    assert.strictEqual(agg.ctr, 0);
  });

  // --- trend handling -------------------------------------------------------

  await test("computeTrend: missing previous-period snapshot -> 'unavailable', never throws", () => {
    const current = aggregateByQuery([gscRow("junk removal", "https://x/", { impressions: 100 })]).get("junk removal");
    const trend = computeTrend(current, null);
    assert.strictEqual(trend.state, "unavailable");
  });

  await test("computeTrend: query absent from prior period -> 'new'", () => {
    const current = aggregateByQuery([gscRow("brand new query", "https://x/", { impressions: 50 })]).get("brand new query");
    const previousMap = aggregateByQuery([gscRow("a different query", "https://x/", { impressions: 50 })]);
    const trend = computeTrend(current, previousMap);
    assert.strictEqual(trend.state, "new");
  });

  await test("computeTrend: low impressions in either period -> 'insufficient-data', avoiding noisy trend claims", () => {
    const current = aggregateByQuery([gscRow("rare query", "https://x/", { impressions: 3 })]).get("rare query");
    const previousMap = aggregateByQuery([gscRow("rare query", "https://x/", { impressions: 50 })]);
    assert.strictEqual(computeTrend(current, previousMap).state, "insufficient-data");
  });

  await test("computeTrend: healthy samples in both periods -> 'available' with signed deltas (position improves = positive)", () => {
    const current = aggregateByQuery([gscRow("junk removal denver", "https://x/", { clicks: 2, impressions: 120, position: 10 })]).get("junk removal denver");
    const previousMap = aggregateByQuery([gscRow("junk removal denver", "https://x/", { clicks: 1, impressions: 100, position: 16 })]);
    const trend = computeTrend(current, previousMap);
    assert.strictEqual(trend.state, "available");
    assert.strictEqual(trend.positionDelta, 6, "moving from position 16 to 10 is an improvement of +6");
    assert.strictEqual(trend.impressionsDelta, 20);
    assert.ok(trend.impressionsPctChange > 0);
  });

  // --- GA4 enrichment -------------------------------------------------------

  await test("buildGa4Enrichment: no matching GA4 row -> null (never forced into the score)", () => {
    assert.strictEqual(buildGa4Enrichment("furniture-removal.html", new Map()), null);
  });

  await test("buildGa4Enrichment: matches by normalized landing-page file and notes engagement quality", () => {
    const ga4Map = new Map([["furniture-removal.html", { landing_page: "/furniture-removal.html", organic_users: 40, organic_sessions: 50, engaged_sessions: 35, engagement_rate: 0.7, key_events: 2 }]]);
    const enriched = buildGa4Enrichment("furniture-removal.html", ga4Map);
    assert.strictEqual(enriched.organicSessions, 50);
    assert.match(enriched.note, /engages organic visitors well/);
  });

  // --- classifyQuery: categories ---------------------------------------------

  await test("branded query performing normally -> Protect/Maintain", () => {
    const result = classify("mile high junk removal", "index.html", { clicks: 15, impressions: 219, ctr: 0.0685, position: 2.2 });
    assert.strictEqual(result.category, "protect-maintain");
  });

  await test("branded query with a severe CTR gap is NOT silently protected — flagged as CTR Opportunity instead", () => {
    const result = classify("mile high junk removal reviews", "index.html", { clicks: 0, impressions: 300, ctr: 0, position: 1.5 });
    assert.strictEqual(result.category, "ctr-opportunity", "clear evidence of a problem overrides the branded default per the product spec");
  });

  await test("strong commercial query, page one, severe CTR gap -> CTR Opportunity (matches live 'junk removal' example)", () => {
    const result = classify("junk removal", "index.html", { clicks: 2, impressions: 915, ctr: 0.0022, position: 5.5 });
    assert.strictEqual(result.category, "ctr-opportunity");
    assert.ok(result.reasons.some((r) => /below the typical rate/.test(r)));
  });

  await test("multiple categories competing: a CTR-opportunity query with commercial intent also qualifies for Priority Now", () => {
    const result = classify("junk hauling", "index.html", { clicks: 0, impressions: 125, ctr: 0, position: 2.7 });
    assert.strictEqual(result.category, "ctr-opportunity");
    assert.ok(result.alsoQualifiesFor.includes("priority-now"));
  });

  await test("near-page-1 classification: commercial+local query just outside page one (matches live 'junk removal denver' example)", () => {
    const result = classify("junk removal denver", "index.html", { clicks: 0, impressions: 107, ctr: 0, position: 16.0 });
    assert.strictEqual(result.category, "near-page-1");
  });

  await test("very-low-ranking content gap: strong impressions, weak position, commercial intent, no dedicated page match", () => {
    const result = classify("residential cleanouts", "index.html", { clicks: 0, impressions: 129, ctr: 0, position: 76.4 });
    assert.strictEqual(result.category, "content-gap");
  });

  await test("strong-performing Protect/Maintain: non-branded query, page one, CTR at/above benchmark", () => {
    const result = classify("furniture removal denver", "furniture-removal.html", { clicks: 10, impressions: 100, ctr: 0.1, position: 3 });
    assert.strictEqual(result.category, "protect-maintain");
  });

  await test("low-impression noise: non-branded query below the evidence floor is excluded, not force-classified", () => {
    const result = classify("obscure long tail phrase", "index.html", { clicks: 0, impressions: 3, ctr: 0, position: 45 });
    assert.strictEqual(result.category, "excluded-low-evidence");
  });

  await test("zero-click queries are handled without error and can still be classified (not auto-excluded just for having 0 clicks)", () => {
    const result = classify("junk removal aurora co", "aurora-junk-removal.html", { clicks: 0, impressions: 207, ctr: 0, position: 1.1 });
    assert.strictEqual(result.metrics.clicks, 0);
    assert.strictEqual(result.category, "ctr-opportunity");
  });

  await test("every classified (non-excluded) query carries category, priority, score, reasons, metrics, landing page, and a recommended action", () => {
    const result = classify("junk removal denver", "index.html", { clicks: 0, impressions: 107, ctr: 0, position: 16.0 });
    assert.ok(result.category);
    assert.ok(result.priority);
    assert.strictEqual(typeof result.score, "number");
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
    assert.ok(result.metrics && typeof result.metrics.impressions === "number");
    assert.ok(result.landingPage && result.landingPage.url);
    assert.ok(typeof result.recommendedAction === "string" && result.recommendedAction.length > 0);
  });

  await test("deterministic scoring: identical input always produces identical output", () => {
    const a = classify("junk removal denver", "index.html", { clicks: 0, impressions: 107, ctr: 0, position: 16.0 });
    const b = classify("junk removal denver", "index.html", { clicks: 0, impressions: 107, ctr: 0, position: 16.0 });
    assert.deepStrictEqual(a, b);
  });

  // --- analyzeSnapshot: full pipeline ----------------------------------------

  await test("empty snapshot: analyzeSnapshot handles zero rows without throwing", () => {
    const result = analyzeSnapshot({ currentRows: [], previousRows: null, ga4Rows: [] });
    assert.strictEqual(result.totalQueriesAnalyzed, 0);
    for (const key of Object.keys(result.categories)) assert.strictEqual(result.categories[key].items.length, 0);
  });

  await test("missing previous-period data: whole-snapshot analysis still runs; every trend reports 'unavailable'", () => {
    const rows = [gscRow("junk removal denver", "https://milehighjunkremoval.net/", { impressions: 107, position: 16 })];
    const result = analyzeSnapshot({ currentRows: rows, previousRows: null, ga4Rows: [] });
    const item = result.categories["near-page-1"].items.find((i) => i.query === "junk removal denver");
    assert.ok(item);
    assert.strictEqual(item.trend.state, "unavailable");
  });

  await test("UI rendering / agent consumption: output is plain JSON-serializable data (no functions/classes), safe to send over the API and render client-side", () => {
    const rows = [
      gscRow("junk removal", "https://milehighjunkremoval.net/", { clicks: 2, impressions: 915, ctr: 0.0022, position: 5.5 }),
      gscRow("mile high junk removal", "https://milehighjunkremoval.net/", { clicks: 15, impressions: 219, ctr: 0.0685, position: 2.2 }),
    ];
    const result = analyzeSnapshot({ currentRows: rows, previousRows: null, ga4Rows: [] });
    const roundTripped = JSON.parse(JSON.stringify(result));
    assert.deepStrictEqual(roundTripped, result);
  });

  await test("categories are capped at limitPerCategory, with an honest 'total' count for the UI's '+N more' line", () => {
    const rows = [];
    for (let i = 0; i < 15; i++) {
      rows.push(gscRow(`junk removal city${i}`, "https://milehighjunkremoval.net/", { clicks: 0, impressions: 50 + i, ctr: 0, position: 2 }));
    }
    const result = analyzeSnapshot({ currentRows: rows, previousRows: null, ga4Rows: [], limitPerCategory: 5 });
    const group = result.categories["ctr-opportunity"];
    assert.strictEqual(group.items.length, 5);
    assert.strictEqual(group.total, 15);
  });

  // --- recentQueryRows() sibling added to search-snapshots.js ----------------

  await test("search-snapshots.js exports the new recentQueryRows() retrieval function without altering existing exports", () => {
    const mod = require("../agent/lib/search-snapshots");
    assert.strictEqual(typeof mod.recentQueryRows, "function");
    assert.strictEqual(typeof mod.latestSource, "function", "pre-existing export must be untouched");
    assert.strictEqual(typeof mod.latestSnapshots, "function", "pre-existing export must be untouched");
  });

  await test("recentQueryRows: property not configured -> fails closed instead of reading another property's data", async () => {
    delete process.env.GSC_SITE_URL;
    const { recentQueryRows } = require("../agent/lib/search-snapshots");
    const result = await recentQueryRows({}, "gsc");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.state, "property_not_configured");
  });

  await test("recentQueryRows: returns the most recent N periods, each with its own rows, newest first", async () => {
    process.env.GSC_SITE_URL = "sc-domain:example.test";
    const { recentQueryRows } = require("../agent/lib/search-snapshots");
    const snapshots = [
      { id: "s2", source: "gsc", property: "sc-domain:example.test", period_end: "2026-10-18" },
      { id: "s1", source: "gsc", property: "sc-domain:example.test", period_end: "2026-09-20" },
    ];
    const rowsBySnapshot = { s2: [{ query: "junk removal", impressions: 10 }], s1: [{ query: "junk removal", impressions: 8 }] };
    const db = {
      from(table) {
        if (table === "search_snapshots") {
          let rows = snapshots.slice();
          const q = {
            select() { return q; },
            eq() { return q; },
            order() { return q; },
            limit(n) { return Promise.resolve({ data: rows.slice(0, n) }); },
          };
          return q;
        }
        const state = { sid: null };
        const q2 = {
          select() { return q2; },
          eq(k, v) {
            if (k === "snapshot_id") state.sid = v;
            return q2;
          },
          order() { return q2; },
          limit(n) { return Promise.resolve({ data: (rowsBySnapshot[state.sid] || []).slice(0, n) }); },
        };
        return q2;
      },
    };
    const result = await recentQueryRows(db, "gsc", { periodsCount: 2 });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.periods.length, 2);
    assert.strictEqual(result.periods[0].snapshot.id, "s2", "newest period_end must be first");
    assert.strictEqual(result.periods[0].rows[0].impressions, 10);
    assert.strictEqual(result.periods[1].rows[0].impressions, 8);
  });

  // --- Phase 2b hardening: post-independent-review adversarial tests ------

  await test("brand false positive: 'mile high movers' is NOT branded (shares the regional nickname, not the business)", () => {
    assert.strictEqual(isBranded("mile high movers", profile), false);
  });

  await test("brand false positive: 'mile high roofing' is NOT branded", () => {
    assert.strictEqual(isBranded("mile high roofing", profile), false);
  });

  await test("brand false positive: 'mile high landscaping' is NOT branded", () => {
    assert.strictEqual(isBranded("mile high landscaping", profile), false);
  });

  await test("'mile high junk removal' remains branded (full business name)", () => {
    assert.strictEqual(isBranded("mile high junk removal", profile), true);
  });

  await test("'mile high junk hauling' remains branded (brand phrase + a stripped business-name word)", () => {
    assert.strictEqual(isBranded("mile high junk hauling", profile), true);
  });

  await test("'mile high removal' remains branded", () => {
    assert.strictEqual(isBranded("mile high removal", profile), true);
  });

  await test("local-pack confidence: local intent + position <=3 + zero clicks softens CTR-gap confidence without leaving CTR Opportunity", () => {
    const result = classify("junk removal aurora", "aurora-junk-removal.html", { clicks: 0, impressions: 257, ctr: 0, position: 1.4 });
    assert.strictEqual(result.category, "ctr-opportunity", "still flagged, never silently dropped");
    assert.strictEqual(result.likelyLocalPack, true);
    assert.match(result.reasons.join(" "), /local 3-pack\/map-pack|classic signature/);
    assert.match(result.recommendedAction, /local 3-pack/);
  });

  await test("non-local CTR gap still behaves normally (no local-pack softening, no local-pack tag)", () => {
    const result = classify("junk hauling", "index.html", { clicks: 0, impressions: 125, ctr: 0, position: 2.7 });
    assert.strictEqual(result.category, "ctr-opportunity");
    assert.strictEqual(result.likelyLocalPack, false);
  });

  await test("local + position<=3 but a REAL click (not zero) is not treated as likely local-pack", () => {
    const result = classify("junk removal near me", "index.html", { clicks: 1, impressions: 348, ctr: 1 / 348, position: 2.6 });
    assert.strictEqual(result.likelyLocalPack, false, "a nonzero click means the local-pack zero-click signature doesn't apply");
  });

  await test("evidence confidence is independent of priority: a 10-impression HIGH-priority query shows lower confidence than a 900-impression HIGH-priority query", () => {
    const low = classify("furniture removal service", "furniture-removal.html", { clicks: 0, impressions: 10, ctr: 0, position: 5 });
    const high = classify("junk removal", "index.html", { clicks: 2, impressions: 915, ctr: 0.0022, position: 5.5 });
    assert.strictEqual(low.priority, "HIGH");
    assert.strictEqual(high.priority, "HIGH");
    assert.strictEqual(low.evidenceConfidence, "MEDIUM");
    assert.strictEqual(high.evidenceConfidence, "HIGH");
    const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    assert.ok(rank[low.evidenceConfidence] < rank[high.evidenceConfidence], "the thin-sample query must show strictly lower confidence despite equal priority");
  });

  await test("topic-aware relevance: a furniture query ranking via the WRONG service page (appliance-disposal.html) does not get full relevance credit", () => {
    const pageInfo = classifyLandingPage("appliance-disposal.html", profile);
    assert.strictEqual(landingPageRelevance("furniture removal", pageInfo, profile), "type-only");
  });

  await test("topic-aware relevance: a furniture query ranking via the CORRECT page (furniture-removal.html) gets full relevance credit", () => {
    const pageInfo = classifyLandingPage("furniture-removal.html", profile);
    assert.strictEqual(landingPageRelevance("furniture removal", pageInfo, profile), "topic-match");
  });

  await test("query switching landing pages between periods suppresses the trend score contribution and flags landingPageChanged", () => {
    const current = aggregateByQuery([gscRow("junk removal denver", "https://milehighjunkremoval.net/new-page.html", { clicks: 2, impressions: 120, position: 5 })]).get("junk removal denver");
    const previousMap = aggregateByQuery([gscRow("junk removal denver", "https://milehighjunkremoval.net/old-page.html", { clicks: 1, impressions: 100, position: 16 })]);
    const trend = computeTrend(current, previousMap);
    assert.strictEqual(trend.landingPageChanged, true);
    const result = classifyQuery({ agg: current, trend, ga4: null, profile });
    assert.ok(!result.reasons.some((r) => /Position improved|Position declined/.test(r)), "trend score contribution must be suppressed, not described as a clean improvement/decline");
    assert.ok(result.reasons.some((r) => /ranking landing page changed/.test(r)));
  });

  await test("primary Priority Now classification actually fires (page-one commercial query with a mild, not severe, CTR shortfall)", () => {
    const result = classify("appliance disposal", "appliance-disposal.html", { clicks: 3, impressions: 100, ctr: 0.03, position: 6 });
    assert.strictEqual(result.category, "priority-now");
  });

  await test("dedicated relevant page exists but ranks poorly -> Content Gap says 'underperformance', not 'missing page', and is more severe/near-miss when position is just past page one", () => {
    const result = classify("office junk removal", "office-junk-removal.html", { clicks: 0, impressions: 496, ctr: 0, position: 21.6 });
    assert.strictEqual(result.category, "content-gap");
    assert.strictEqual(result.contentGapSeverity, "near-miss");
    assert.strictEqual(result.landingPage.relevance, "topic-match");
    assert.match(result.recommendedAction, /underperformance/);
    assert.doesNotMatch(result.recommendedAction, /no clearly dedicated landing page/i);
  });

  await test("Content Gap severity differentiates a near-miss from a very-weak ranking even at similar scores otherwise", () => {
    const nearMiss = classify("office junk removal", "office-junk-removal.html", { clicks: 0, impressions: 496, ctr: 0, position: 21.6 });
    const veryWeak = classify("residential cleanouts", "home-cleanouts.html", { clicks: 0, impressions: 129, ctr: 0, position: 76.4 });
    assert.strictEqual(nearMiss.contentGapSeverity, "near-miss");
    assert.strictEqual(veryWeak.contentGapSeverity, "very-weak-visibility");
    assert.strictEqual(veryWeak.landingPage.relevance, "type-only", "a loosely-related page, not a confirmed topical match");
    assert.ok(nearMiss.score > veryWeak.score, "a near-miss on a topically-matched page must score higher than a very-weak, uncertain-match ranking");
  });

  await test("GA4 wrong-page mismatch never enriches the wrong opportunity", () => {
    const ga4Map = new Map([["appliance-disposal.html", { landing_page: "/appliance-disposal.html", organic_users: 99, organic_sessions: 99, engaged_sessions: 50, engagement_rate: 0.8, key_events: 5 }]]);
    const enriched = buildGa4Enrichment("furniture-removal.html", ga4Map);
    assert.strictEqual(enriched, null, "a GA4 row that exists only for a DIFFERENT page must never be attached to this one");
  });

  await test("intent cleanup: bare 'hauling'/'disposal' no longer false-positive on out-of-scope queries", () => {
    assert.strictEqual(hasCommercialIntent("boat hauling denver", profile), false);
    assert.strictEqual(hasCommercialIntent("medical waste disposal regulations", profile), false);
  });

  await test("intent cleanup: specialty-page vocabulary (derived from business-profile specialtyPages) is picked up when paired with a core action word", () => {
    assert.strictEqual(hasCommercialIntent("same day junk pickup", profile), true);
    assert.strictEqual(hasCommercialIntent("office chair", profile), false, "a specialty word alone, with no service-action word, must not false-positive");
  });

  await test("named constant: the Priority Now CTR ratio threshold is exported, not a bare literal", () => {
    const mod = require("../agent/lib/keyword-opportunities");
    assert.strictEqual(typeof mod.PRIORITY_NOW_CTR_RATIO, "number");
  });

  console.log("");
}

main();
