// Site Improvement Agent, Phase 11B — small, OVERWRITTEN-each-run log of
// what cli.js's --refresh-local-source-evidence step actually attempted
// and could NOT complete (robots-disallow, network/HTTP failure, an
// unexpected redirect, an unknown registry id).
//
// WHY THIS EXISTS: a skipped local-source fetch writes NO evidence file
// at all (by design — see local-source-fetch.js's header: "a skip must
// never be mistaken for a genuine result"). That is correct, but it
// also means a LATER, separate process (report.js's weekly report,
// built by the main `--weekly` Agent pass that runs AFTER this refresh
// step, in its own `node` process) has no way to tell "relevant,
// selected, but blocked/failed this run" apart from "relevant, selected,
// never yet attempted" just by looking at the evidence directory — both
// look identical (no file). The brief explicitly requires Weekly's
// report to be able to answer "which source was blocked/failed" — this
// tiny file is what makes that honestly answerable across the process
// boundary, mirroring how agent/history/research-rotation-state.json
// already bridges state between the refresh step and the final report.
//
// Deliberately NOT a history/audit trail — OVERWRITTEN every run, not
// appended. It only ever needs to answer "what happened the LAST time
// this ran," same scope as a successful fetch's own evidence file
// (which already carries its own permanent, git-tracked record). This
// file carries no verdict/confidence/recommendation of any kind — just
// a plain, structured echo of local-source-fetch.js's own `reason`
// strings, same as cli.js already console.logs.

const fs = require("fs");
const path = require("path");
const config = require("../config");

const LOG_PATH = path.join(config.SITE_ROOT, "agent", "history", "local-source-candidate-log.json");

function writeLocalSourceCandidateLog(log, logPath = LOG_PATH) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n", "utf8");
  return logPath;
}

/**
 * Fails safe exactly like research-rotation.js's loadRotationState():
 * a missing or malformed log is "nothing known," never a thrown error —
 * a corrupt side-file must never crash a run or a report build.
 */
function loadLocalSourceCandidateLog(logPath = LOG_PATH) {
  if (!fs.existsSync(logPath)) {
    return { at: null, workflowStartedAt: null, blockedOrFailed: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blockedOrFailed)) {
      return { at: null, workflowStartedAt: null, blockedOrFailed: [] };
    }
    return parsed;
  } catch (e) {
    return { at: null, workflowStartedAt: null, blockedOrFailed: [] };
  }
}

module.exports = { LOG_PATH, writeLocalSourceCandidateLog, loadLocalSourceCandidateLog };
