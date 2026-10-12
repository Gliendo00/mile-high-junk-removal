// Site Improvement Agent — cannibalization/content-overlap audit.
//
// Goes beyond exact-duplicate titles/descriptions (seo-audit.js already
// catches those) to look for pages that may be targeting substantially
// overlapping search intent, even with different wording. Uses MULTIPLE
// signals rather than keyword matching alone — title word-overlap,
// description word-overlap, and H1 word-overlap — and requires at least
// two of the three to independently clear a high bar before flagging
// anything, specifically because this site's own comparable pages (e.g.
// two city pages) naturally share a lot of template vocabulary
// ("junk removal", "free estimates", the business name) without that
// being a real overlap problem — a single-signal check, tested against
// this real site during development, produced a 0.56 city-to-city
// description similarity that would have been a false positive at any
// reasonable single threshold.
//
// This NEVER recommends consolidation or deletion — those are high-risk,
// explicitly out of scope here. It only flags the pair for research.

const { makeFinding } = require("./findings");

const OVERLAP_THRESHOLD = 0.75;
const MIN_SIGNALS_REQUIRED = 2;

function words(text) {
  return new Set((text || "").toLowerCase().match(/[a-z]+/g) || []);
}

function jaccard(a, b) {
  const sa = words(a);
  const sb = words(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const w of sa) if (sb.has(w)) intersection += 1;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : intersection / union;
}

function auditCannibalization(pages) {
  const findings = [];
  const seenPairs = new Set();

  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i];
      const b = pages[j];

      const titleSim = jaccard(a.title, b.title);
      const descSim = jaccard(a.metaDescription, b.metaDescription);
      const h1Sim = jaccard((a.h1s || []).join(" "), (b.h1s || []).join(" "));

      // Exact-duplicate titles are already their own, stronger finding
      // (seo-audit.js's duplicate-title, category D) — this check is
      // specifically for high-but-not-identical overlap, so an exact
      // match on title doesn't also need to be re-flagged here.
      const signalsAboveThreshold = [titleSim, descSim, h1Sim].filter(
        (s) => s >= OVERLAP_THRESHOLD && s < 1
      ).length;

      if (signalsAboveThreshold >= MIN_SIGNALS_REQUIRED) {
        const pairKey = [a.file, b.file].sort().join("::");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        findings.push(
          makeFinding({
            type: "overlapping-intent",
            summary: `${a.file} and ${b.file} show high similarity across ${signalsAboveThreshold} independent signals (title/description/H1) — may be targeting overlapping search intent.`,
            pages: [a.file, b.file],
            evidence: [
              { field: "titleSimilarity", value: Math.round(titleSim * 100) / 100 },
              { field: "descriptionSimilarity", value: Math.round(descSim * 100) / 100 },
              { field: "h1Similarity", value: Math.round(h1Sim * 100) / 100 },
            ],
            recommendation: `Research whether ${a.file} and ${b.file} are genuinely differentiated for a searcher, or overlapping enough to warrant review. Never auto-consolidate or delete — that decision is high-risk and requires explicit approval.`,
          })
        );
      }
    }
  }

  return findings;
}

module.exports = { auditCannibalization, jaccard, OVERLAP_THRESHOLD, MIN_SIGNALS_REQUIRED };
