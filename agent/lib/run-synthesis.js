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
// differs (or none exists yet), and sufficiency now meets this finding
// type's threshold, a NEW file is written (never overwriting the old
// one — matches research.js's own "evidence files are never overwritten"
// convention) with a fresh `accessedAt`; decision.js's EXISTING
// pickLatestResearch() already prefers the most recent `accessedAt`, so
// the newer conclusion naturally supersedes the older one with zero
// changes to decision.js.
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
 * @param {object} [options]
 * @param {string} [options.logPath] - defaults to config.HISTORY_LOG_PATH
 * @param {string} [options.resultsDir] - defaults to research-intake.js's RESULTS_DIR
 * @param {string} [options.completedJobsDir]
 * @param {Date} [options.now]
 * @returns {{candidates:number, written:object[], unchanged:string[], belowThreshold:string[], errors:object[], warnings:string[]}}
 */
function runSynthesis(options = {}) {
  const logPath = options.logPath || config.HISTORY_LOG_PATH;
  const resultsDir = options.resultsDir || RESULTS_DIR;
  const now = options.now || new Date();

  const written = [];
  const unchanged = [];
  const belowThreshold = [];
  const errors = [];
  const warnings = [];

  const runs = latestByRunId(readAllRuns(logPath));
  if (runs.length === 0) {
    return { candidates: 0, written, unchanged, belowThreshold, errors, warnings: ["no run history found — nothing to synthesize"] };
  }
  const latestRun = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  const findings = Array.isArray(latestRun.findings) ? latestRun.findings : [];

  const candidates = findings.filter(isSynthesisCandidate);
  if (candidates.length === 0) {
    return { candidates: 0, written, unchanged, belowThreshold, errors, warnings };
  }

  const { evidence: completedJobEvidence, warnings: completedJobWarnings } = loadCompletedJobEvidence(options.completedJobsDir);
  const { entries: localSourceEvidence, warnings: localSourceWarnings } = loadLocalSourceEvidence();
  const { results: existingResults, warnings: researchWarnings } = loadResearchResults(resultsDir);
  warnings.push(...completedJobWarnings, ...localSourceWarnings, ...researchWarnings);

  for (const finding of candidates) {
    try {
      const dossier = assembleDossier(finding, { completedJobEvidence, localSourceEvidence, now });
      const fingerprint = computeDossierFingerprint(finding, { completedJobEvidence, localSourceEvidence });

      const priorSynthesis = existingSynthesisForKey(existingResults, finding.key);
      if (priorSynthesis && priorSynthesis.synthesisFingerprint === fingerprint) {
        unchanged.push(finding.key);
        continue;
      }

      const resultArgs = buildSynthesisResultArgs(finding, dossier, { fingerprint });
      if (!resultArgs) {
        belowThreshold.push(finding.key);
        continue;
      }

      const { filePath, result } = writeSynthesisResult(resultArgs, resultsDir);
      written.push({ findingKey: finding.key, type: finding.type, verdict: result.verdict, sufficiency: result.sufficiency, filePath });
    } catch (e) {
      errors.push({ findingKey: finding.key, message: e && e.message ? e.message : String(e) });
    }
  }

  return { candidates: candidates.length, written, unchanged, belowThreshold, errors, warnings };
}

module.exports = { runSynthesis, isSynthesisCandidate, slugForFindingKey, existingSynthesisForKey };
