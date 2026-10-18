// Site Improvement Agent, Phase 13a — synthesis orchestration.
//
// The one place that actually WRITES a cross-source-synthesis
// research.js result file. Everything it reads is already on disk —
// this never runs scan.js/the audit modules, never touches the network,
// and never calls decision.js/risk.js/proposals-sync.js. Run explicitly
// via `node agent/cli.js --run-synthesis` (recommended as part of the
// weekly cadence, same operational slot as --refresh-finding-evidence/
// --refresh-lead-event-evidence — see agent/README.md's Phase 13a
// section — but not hard-restricted to runType "weekly": it is pure and
// idempotent, so running it at any time is safe, just only useful once
// first-party/completed-job/local-source evidence has actually been
// refreshed).
//
// CANDIDATE SELECTION: reads the most recent run already appended to
// agent/history/log.ndjson (never re-runs gatherFindings() itself — see
// evidence-dossier.js's header on why) and considers a persisted finding
// a candidate when:
//   1. its type is one of evidence-dossier.js's IN_SCOPE_FINDING_TYPES,
//   2. AND it has no research yet, OR every research result already
//      attached to it is itself a prior cross-source-synthesis result
//      (never a human-authored one — synthesis must never second-guess
//      or duplicate alongside genuine human/Claude research; see
//      cross-source-synthesis.js's header).
//
// FRESHNESS/PROVENANCE: for each candidate, a fresh dossier + fingerprint
// is computed from CURRENT evidence. If a prior cross-source-synthesis
// result already exists for this findingKey with the IDENTICAL
// fingerprint, nothing is written (the existing conclusion is still
// current — no redundant file, no git noise). If the fingerprint
// differs (or none exists yet):
//
//   - if sufficiency now meets this finding type's threshold (or a
//     premise-level contradiction exists), a NEW supports/contradicts
//     file is written;
//   - otherwise, if a PRIOR cross-source-synthesis result for this
//     finding was itself authoritative (supports-opportunity or
//     contradicts-opportunity — see cross-source-synthesis.js's
//     AUTHORITATIVE_VERDICTS), a NEW `inconclusive` file is written
//     explicitly SUPERSEDING it — see "STALE-SUPPORT SUPERSESSION"
//     below, the single most important correctness property this
//     module provides;
//   - otherwise (nothing was ever concluded for this finding), nothing
//     is written, preserving decision.js's RESEARCH_MORE path exactly.
//
// A written file NEVER overwrites the old one (matches research.js's
// own "evidence files are never overwritten" convention) and its
// `accessedAt` is guaranteed STRICTLY LATER than any prior
// cross-source-synthesis result for the same finding (see
// nextAccessedAt() below) — decision.js's EXISTING pickLatestResearch()
// already prefers the most recent `accessedAt`, so the newer conclusion
// naturally supersedes the older one with zero changes to decision.js's
// own logic (pickLatestResearch() itself gained one small, narrow
// addition — preferring any human/Claude-authored result over a
// cross-source-synthesis one regardless of timestamp — see that
// function's own header in decision.js).
//
// STALE-SUPPORT SUPERSESSION: without the `inconclusive`-supersession
// behavior above, an old synthesis result that once reached
// supports-opportunity/contradicts-opportunity would remain the ONLY
// (and therefore "latest") cross-source-synthesis result for that
// finding FOREVER, even after the evidence that produced it goes
// stale, disappears, or is recomputed as insufficient — silently
// leaving a since-invalidated PROPOSE_CHANGE/REJECT_OPPORTUNITY
// authoritative. This module closes that gap by writing an explicit,
// append-only superseding result (never a deletion/overwrite) the very
// first time a re-run's fingerprint changes AND the new dossier no
// longer reaches the old conclusion.
//
// FAIL-SAFE: one candidate's malformed dossier/evidence/validation error
// is caught and reported in `errors`, never thrown — it must never block
// any other candidate, and must never produce a half-written or
// malformed file (the file is only ever written after
// makeResearchResult() has successfully validated the full shape).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { readAllRuns, latestByRunId } = require("./history");
const { RESULTS_DIR, loadResearchResults } = require("./research-intake");
const { makeResearchResult } = require("./research");
const { loadCompletedJobEvidence } = require("./completed-job-intake");
const { loadLocalSourceEvidence } = require("./local-source-intake");
const { assembleDossier, computeDossierFingerprint, IN_SCOPE_FINDING_TYPES } = require("./evidence-dossier");
const { buildSynthesisResultArgs } = require("./cross-source-synthesis");

/**
 * True when every research result already attached to this finding (if
 * any) is itself a prior cross-source-synthesis output — i.e. no genuine
 * human/Claude research exists yet for it. A finding with ANY
 * non-synthesis research is left alone entirely (synthesis never
 * overrides or duplicates alongside real research).
 * @param {object} finding - persisted-shape finding
 */
function isSynthesisCandidate(finding) {
  if (!IN_SCOPE_FINDING_TYPES.includes(finding.type)) return false;
  const research = Array.isArray(finding.research) ? finding.research : [];
  if (research.length === 0) return true;
  return research.every((r) => r.sourceType === "cross-source-synthesis");
}

function slugForFindingKey(findingKey) {
  return String(findingKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function existingSynthesisForKey(existingResults, findingKey) {
  const matches = existingResults.filter((r) => r.findingKey === findingKey && r.sourceType === "cross-source-synthesis");
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => new Date(b.accessedAt) - new Date(a.accessedAt))[0];
}

function writeSynthesisResult(resultArgs, resultsDir) {
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const validated = makeResearchResult(resultArgs);
  const filename = `${slugForFindingKey(validated.findingKey)}__cross-source-synthesis-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`;
  const fullPath = path.join(resultsDir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return { filePath: fullPath, result: validated };
}

/**
 * The `accessedAt` a NEW synthesis result must use: `now`, unless a
 * prior cross-source-synthesis result for this exact finding has an
 * `accessedAt` at or after `now` (two writes landing in the same
 * millisecond is astronomically unlikely in a real single-threaded
 * run, but this is the correctness-critical ordering
 * pickLatestResearch() relies on, so it is guaranteed rather than left
 * to chance or array-iteration order). Always strictly later than
 * `priorSynthesis.accessedAt` when one exists.
 * @param {Date} now
 * @param {object|null} priorSynthesis
 */
function nextAccessedAt(now, priorSynthesis) {
  if (!priorSynthesis) return now.toISOString();
  const priorMs = new Date(priorSynthesis.accessedAt).getTime();
  const nowMs = now.getTime();
  return new Date(Math.max(nowMs, priorMs + 1)).toISOString();
}

/**
 * @param {object} [options]
 * @param {string} [options.logPath] - defaults to config.HISTORY_LOG_PATH
 * @param {string} [options.resultsDir] - defaults to research-intake.js's RESULTS_DIR
 * @param {string} [options.completedJobsDir]
 * @param {Date} [options.now]
 * @param {number} [options.rulesVersion] - TEST-ONLY override passed straight
 *   through to evidence-dossier.js's computeDossierFingerprint() (see that
 *   function's own header) — lets a test simulate "the classification
 *   rules changed" without touching the real SYNTHESIS_RULES_VERSION
 *   constant. Production callers (agent/cli.js's --run-synthesis) never
 *   pass this, so real runs always use the real constant.
 * @returns {{candidates:number, written:object[], superseded:object[], unchanged:string[], belowThreshold:string[], errors:object[], warnings:string[]}}
 */
function runSynthesis(options = {}) {
  const logPath = options.logPath || config.HISTORY_LOG_PATH;
  const resultsDir = options.resultsDir || RESULTS_DIR;
  const now = options.now || new Date();

  const written = [];
  const superseded = [];
  const unchanged = [];
  const belowThreshold = [];
  const errors = [];
  const warnings = [];

  const runs = latestByRunId(readAllRuns(logPath));
  if (runs.length === 0) {
    return { candidates: 0, written, superseded, unchanged, belowThreshold, errors, warnings: ["no run history found — nothing to synthesize"] };
  }
  const latestRun = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  const findings = Array.isArray(latestRun.findings) ? latestRun.findings : [];

  const candidates = findings.filter(isSynthesisCandidate);
  if (candidates.length === 0) {
    return { candidates: 0, written, superseded, unchanged, belowThreshold, errors, warnings };
  }

  const { evidence: completedJobEvidence, warnings: completedJobWarnings } = loadCompletedJobEvidence(options.completedJobsDir);
  const { entries: localSourceEvidence, warnings: localSourceWarnings } = loadLocalSourceEvidence();
  const { results: existingResults, warnings: researchWarnings } = loadResearchResults(resultsDir);
  warnings.push(...completedJobWarnings, ...localSourceWarnings, ...researchWarnings);

  for (const finding of candidates) {
    try {
      const dossier = assembleDossier(finding, { completedJobEvidence, localSourceEvidence, now });
      const fingerprint = computeDossierFingerprint(finding, { completedJobEvidence, localSourceEvidence, rulesVersion: options.rulesVersion });

      const priorSynthesis = existingSynthesisForKey(existingResults, finding.key);
      if (priorSynthesis && priorSynthesis.synthesisFingerprint === fingerprint) {
        unchanged.push(finding.key);
        continue;
      }

      const resultArgs = buildSynthesisResultArgs(finding, dossier, {
        fingerprint,
        priorVerdict: priorSynthesis ? priorSynthesis.verdict : null,
      });
      if (!resultArgs) {
        belowThreshold.push(finding.key);
        continue;
      }

      resultArgs.accessedAt = nextAccessedAt(now, priorSynthesis);
      const { filePath, result } = writeSynthesisResult(resultArgs, resultsDir);
      const entry = { findingKey: finding.key, type: finding.type, verdict: result.verdict, sufficiency: result.sufficiency, filePath };

      // A write is a SUPERSESSION (not a fresh conclusion) exactly when
      // a prior authoritative result existed and this new one is the
      // `inconclusive` result that retracts it — see
      // cross-source-synthesis.js's AUTHORITATIVE_VERDICTS/priorVerdict
      // handling, the single source of truth for when this happens.
      if (priorSynthesis && result.verdict === "inconclusive" && priorSynthesis.verdict !== "inconclusive") {
        superseded.push({ ...entry, priorVerdict: priorSynthesis.verdict });
      } else {
        written.push(entry);
      }
    } catch (e) {
      errors.push({ findingKey: finding.key, message: e && e.message ? e.message : String(e) });
    }
  }

  return { candidates: candidates.length, written, superseded, unchanged, belowThreshold, errors, warnings };
}

module.exports = { runSynthesis, isSynthesisCandidate, slugForFindingKey, existingSynthesisForKey };
