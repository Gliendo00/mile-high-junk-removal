// Site Improvement Agent — append-only activity history.
//
// Every run (dry-run or apply-safe) appends exactly one JSON line to
// agent/history/log.ndjson, which is committed to git like any other
// source file: that gives every logged run a durable, reversible,
// diffable record for free, with no database required for Phase 1.
//
// buildDashboardSummary() reduces the log into the plain-English shape the
// CRM Home dashboard's "Website & Marketing Activity" row described in the
// product spec ("Today: - Improved X - Fixed Y - Researched Z — no change
// made"). Nothing calls it yet — it exists so a future read-only admin
// endpoint can serve it without needing to touch this module.

const fs = require("fs");
const path = require("path");
const config = require("../config");

function ensureLogFile(logPath) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "");
}

function appendRun(record, logPath = config.HISTORY_LOG_PATH) {
  ensureLogFile(logPath);
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

function readAllRuns(logPath = config.HISTORY_LOG_PATH) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function describeFinding(finding) {
  if (finding.status === "applied") return `Fixed: ${finding.summary}`;
  if (finding.category === "E" || finding.riskLevel === "unknown") {
    return `Researched: ${finding.summary} — no change made`;
  }
  return `Identified opportunity: ${finding.summary}`;
}

/**
 * Reduces run records into the dashboard's "Today / Recent activity" shape.
 * @param {object[]} runs - as returned by readAllRuns()
 * @param {number} limit - max runs to include, most recent first
 */
function buildDashboardSummary(runs, limit = 10) {
  const sorted = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const recent = sorted.slice(0, limit);
  return recent.map((run) => ({
    runId: run.runId,
    timestamp: run.timestamp,
    mode: run.mode,
    lines: run.findings.length === 0
      ? ["No worthwhile change today."]
      : run.findings.map(describeFinding),
  }));
}

module.exports = { appendRun, readAllRuns, buildDashboardSummary, describeFinding };
