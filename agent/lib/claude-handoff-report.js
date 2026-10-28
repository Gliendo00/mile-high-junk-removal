// Site Improvement Agent, Phase 15 — Claude handoff report.
//
// THIS IS A CORE REQUIREMENT of the new workflow: every IMPORTANT
// proposal must automatically generate a copy-ready, self-contained
// report Gerardo can paste directly into Claude. Claude independently
// re-researches the finding, implements the smallest safe
// evidence-backed change on a branch, and nothing merges or deploys
// until Gerardo explicitly approves it (see the fixed CLAUDE
// INSTRUCTIONS section below).
//
// Pure function of its inputs — no I/O, no formatting decisions deferred
// to the caller. Every section is built from REAL values already on the
// finding/classification/page-state passed in; a section with nothing
// applicable is OMITTED entirely rather than rendered with placeholder
// text (see section(), the one place that enforces this).

function evidenceValue(finding, field) {
  const entry = (finding.evidence || []).find((e) => e.field === field);
  return entry ? entry.value : undefined;
}

const EXTERNAL_SOURCE_TYPES = new Set([
  "official-government",
  "official-municipal-utility",
  "search-results-observation",
  "competitor-website",
  "other-authoritative",
]);

function buildGscLines(finding) {
  const query = evidenceValue(finding, "query");
  const metrics = evidenceValue(finding, "metrics");
  if (query && metrics) {
    const landingPage = evidenceValue(finding, "landingPage");
    const trend = evidenceValue(finding, "trend");
    const lines = [
      `- Query: "${query}"`,
      `- Clicks: ${metrics.clicks}, Impressions: ${metrics.impressions}, CTR: ${(metrics.ctr * 100).toFixed(2)}%, Avg. position: ${metrics.position.toFixed(1)}`,
    ];
    if (landingPage) lines.push(`- Ranking page: ${landingPage.file}${landingPage.label ? ` (${landingPage.label})` : ""}`);
    if (trend && trend.state === "available") {
      const posWord = trend.positionDelta > 0 ? "improved" : trend.positionDelta < 0 ? "declined" : "unchanged";
      lines.push(
        `- Trend vs. prior period: position ${posWord}${trend.positionDelta ? ` ${Math.abs(trend.positionDelta).toFixed(1)} spot(s)` : ""}, impressions ${
          trend.impressionsDelta >= 0 ? "+" : ""
        }${trend.impressionsDelta}, clicks ${trend.clicksDelta >= 0 ? "+" : ""}${trend.clicksDelta}`
      );
    } else if (trend && trend.detail) {
      lines.push(`- Trend: ${trend.detail}`);
    }
    return lines;
  }
  const entries = (finding.firstPartyEvidence || []).filter((e) => e.source === "search-console-search-analytics");
  if (!entries.length) return [];
  return entries.slice(0, 3).map((e) => `- ${(e.window && e.window.label) || "GSC"}: ${JSON.stringify(e.observed)}`);
}

function buildGa4Lines(finding) {
  const ga4 = evidenceValue(finding, "ga4");
  if (ga4) {
    const lines = [
      `- Organic sessions: ${ga4.organicSessions}, organic users: ${ga4.organicUsers}, engagement rate: ${Math.round((ga4.engagementRate || 0) * 100)}%`,
    ];
    if (ga4.keyEvents !== undefined && ga4.keyEvents !== null) {
      lines.push(`- Key events: ${ga4.keyEvents} (not treated as confirmed booked jobs unless that mapping is separately verified)`);
    }
    if (ga4.note) lines.push(`- ${ga4.note}`);
    return lines;
  }
  const entries = (finding.firstPartyEvidence || []).filter((e) => e.source === "ga4");
  if (!entries.length) return [];
  return entries.slice(0, 3).map((e) => `- ${(e.window && e.window.label) || "GA4"}: ${JSON.stringify(e.observed)}`);
}

function buildLocalExternalLines(finding, classification) {
  const lines = [];
  for (const r of finding.research || []) {
    if (!EXTERNAL_SOURCE_TYPES.has(r.sourceType)) continue;
    lines.push(`- ${r.source} (${r.sourceType}, ${r.confidence} confidence, accessed ${r.accessedAt}): ${r.recommendation}`);
  }
  const missing = (classification && classification.missingEvidence) || [];
  for (const m of missing) {
    if (/serp|local|map[- ]?pack|external/i.test(m)) lines.push(`- Not yet verified — please check directly: ${m}`);
  }
  return lines;
}

function buildPageStateLines(finding, pageByFile) {
  const lines = [];
  for (const file of finding.pages || []) {
    const page = pageByFile.get(file);
    if (!page) continue;
    lines.push(`${file}:`);
    if (page.title) lines.push(`- Title: ${page.title}`);
    if (page.metaDescription) lines.push(`- Meta description: ${page.metaDescription}`);
    if (page.canonical) lines.push(`- Canonical: ${page.canonical}`);
    if (Array.isArray(page.h1s) && page.h1s.length) lines.push(`- H1: ${page.h1s.join(" | ")}`);
    if (typeof page.wordCount === "number") lines.push(`- Word count: ${page.wordCount}`);
    if (Array.isArray(page.internalLinks)) lines.push(`- Internal links on this page: ${page.internalLinks.length}`);
  }
  return lines;
}

// A real, usefully-narrower restatement of "the smallest version of this
// change" for the finding families where that's genuinely answerable
// from already-known structure (a query, a specific landing page) —
// never invented for types where the finding's own recommendation
// already IS the smallest safe change (e.g. "fix this one broken link").
function smallestSafeChangeFor(finding) {
  const query = evidenceValue(finding, "query");
  const category = evidenceValue(finding, "category");
  const page = (finding.pages || [])[0];
  if (query && page && (category === "near-page-1" || category === "content-gap")) {
    return `A single, narrow addition to ${page} addressing "${query}" (e.g. one new FAQ entry, one short section, or one internal link) — not a broad rewrite, and not a new page.`;
  }
  if (query && page && category === "ctr-opportunity") {
    return `A title/meta description tweak on ${page} targeted at "${query}" — verify live SERP rendering first; if a local pack explains the low CTR, no on-page edit will change that (see LOCAL / EXTERNAL RESEARCH).`;
  }
  return finding.recommendation || null;
}

function buildDoNotChangeLines(finding, classification) {
  const lines = (classification.protectedSignals || []).map((s) => `- ${s}`);
  if (finding.type === "keyword-opportunity-content-gap") {
    lines.push("- Do not create a new, competing page for this query — an existing relevant page already covers the topic (see CURRENT PAGE STATE).");
  }
  return lines;
}

function buildMonitorLines(finding) {
  const query = evidenceValue(finding, "query");
  const page = (finding.pages || [])[0];
  if (query) {
    return [`- GSC clicks, impressions, CTR, and average position for "${query}" on ${page} over the following few weeks.`];
  }
  return [`- Whether this change resolves the underlying finding on the next scan, and whether anything regresses on ${(finding.pages || []).join(", ") || "the affected page(s)"}.`];
}

/**
 * @param {object} finding - a fully classified finding (carries `.research`,
 *   `.firstPartyEvidence`, `.evidence`, `.recommendation`, etc.)
 * @param {object} classification - opportunity-classification.js's result
 *   for this finding ({classification, evidenceConfidence, reason,
 *   evidenceFor, evidenceAgainst, risks, protectedSignals, missingEvidence})
 * @param {object} [context]
 * @param {object[]} [context.pages] - agent/lib/scan.js's scanAllPages()
 *   output for this run, used only to fill in CURRENT PAGE STATE; the
 *   section is simply omitted when not supplied.
 * @returns {string} markdown-ish plain text, ready to paste into Claude.
 */
function buildHandoffReport(finding, classification, context = {}) {
  const pages = Array.isArray(context.pages) ? context.pages : [];
  const pageByFile = new Map(pages.map((p) => [p.file, p]));

  const out = [];
  function section(heading, bodyLines) {
    const body = (bodyLines || []).filter((l) => typeof l === "string" && l.trim().length > 0);
    if (body.length === 0) return;
    if (out.length > 0) out.push("");
    out.push(heading, "", ...body);
  }

  out.push("MILE HIGH JUNK REMOVAL — SITE IMPROVEMENT TASK");

  const title = finding.recommendation || finding.summary;
  section("OPPORTUNITY", [title]);

  section("AGENT CLASSIFICATION", [
    `Importance: ${classification.classification}`,
    `Evidence confidence: ${classification.evidenceConfidence}`,
    `Finding type: ${finding.type}`,
    `Affected page: ${(finding.pages || []).join(", ")}`,
  ]);

  section("WHY THIS WAS SURFACED", [finding.summary, classification.reason]);

  const gscLines = buildGscLines(finding);
  const ga4Lines = buildGa4Lines(finding);
  const firstPartyBody = [];
  if (gscLines.length) firstPartyBody.push("GSC:", ...gscLines);
  if (ga4Lines.length) {
    if (firstPartyBody.length) firstPartyBody.push("");
    firstPartyBody.push("GA4:", ...ga4Lines);
  }
  section("FIRST-PARTY EVIDENCE", firstPartyBody);

  section("LOCAL / EXTERNAL RESEARCH", buildLocalExternalLines(finding, classification));

  section("CURRENT PAGE STATE", buildPageStateLines(finding, pageByFile));

  section("EVIDENCE FOR CHANGE", (classification.evidenceFor || []).map((l) => `- ${l}`));
  section("EVIDENCE AGAINST CHANGE", (classification.evidenceAgainst || []).map((l) => `- ${l}`));
  section(
    "PROTECTED SIGNALS / RISKS",
    [...(classification.protectedSignals || []), ...(classification.risks || [])].map((l) => `- ${l}`)
  );

  section("AGENT RECOMMENDATION", [finding.recommendation]);
  section("SMALLEST SAFE CHANGE", [smallestSafeChangeFor(finding)]);
  section("DO NOT CHANGE", buildDoNotChangeLines(finding, classification));
  section("WHAT TO MONITOR AFTERWARD", buildMonitorLines(finding));

  out.push(
    "",
    "CLAUDE INSTRUCTIONS",
    "",
    "Independently verify this finding before changing code.",
    "Do not assume the Agent is correct.",
    "Review the current production repository and current evidence.",
    "",
    "If the finding is no longer valid or the proposed change is not justified:",
    "- make no code changes",
    "- explain why",
    "",
    "If the finding remains justified:",
    "- make the smallest safe evidence-backed change",
    "- preserve protected rankings and useful content",
    "- do not introduce duplicate/cannibalizing pages",
    "- run relevant tests",
    "- run syntax/diff checks",
    "- review the final diff",
    "- report exactly what changed and why",
    "",
    "Do not merge to main or deploy until Gerardo explicitly approves it."
  );

  return out.join("\n");
}

module.exports = { buildHandoffReport };
