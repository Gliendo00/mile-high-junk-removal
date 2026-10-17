// Site Improvement Agent — research intake.
//
// Reads every committed research result under agent/research/results/
// (one JSON file per result, see agent/lib/research.js for the required
// shape), validates each against that shape, and attaches matching
// results to the findings they answer (matched by Finding.key, a stable
// content-derived key — see findings.js's makeKey).
//
// Fails safe: a missing results directory, an empty directory, or any
// individual file that is missing/malformed is treated as "no research
// available for that finding" (findings proceed with zero attached
// research, which decision.js already handles by requesting more
// research) — never a thrown error that would take down a whole run.
// Malformed files are reported back to the caller so they're visible,
// not silently swallowed forever.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeResearchResult } = require("./research");

const RESULTS_DIR = path.join(config.SITE_ROOT, "agent", "research", "results");

/**
 * @param {string} [dir] - defaults to RESULTS_DIR; injectable so tests
 *   (and Phase 13a's agent/lib/run-synthesis.js) can point this at a
 *   throwaway directory instead of the real, git-tracked results dir —
 *   same optional-path pattern as completed-job-intake.js's
 *   loadCompletedJobEvidence(dir).
 */
function loadResearchResults(dir = RESULTS_DIR) {
  const results = [];
  const warnings = [];

  if (!fs.existsSync(dir)) {
    return { results, warnings };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      const validated = makeResearchResult(parsed);
      results.push(validated);
    } catch (e) {
      warnings.push(`agent/research/results/${file}: ${e.message}`);
    }
  }

  return { results, warnings };
}

/**
 * Attaches any matching research results to each finding's `.research`
 * array (always an array, even when empty — callers never need to guard
 * against it being undefined).
 */
function attachResearch(findings, loaded) {
  const { results, warnings } = loaded || loadResearchResults();
  const byKey = new Map();
  for (const r of results) {
    const list = byKey.get(r.findingKey) || [];
    list.push(r);
    byKey.set(r.findingKey, list);
  }

  for (const finding of findings) {
    finding.research = byKey.get(finding.key) || [];
  }

  return { findings, warnings };
}

module.exports = { loadResearchResults, attachResearch, RESULTS_DIR };
