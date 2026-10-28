// Site Improvement Agent — append-only activity history.
//
// Every run (dry-run or apply-safe) appends exactly one JSON line to
// agent/history/log.ndjson, which is committed to git like any other
// source file: that gives every logged run a durable, reversible,
// diffable record for free, with no database required.
//
// buildDashboardSummary() reduces the log into the compact ACTIVITY VIEW
// the CRM Home dashboard's "Website & Marketing Activity" row wants (see
// api/admin/bookings.js's ?view=agent-activity and admin/home.js) — a
// short list of {icon, text} lines per run, never the full findings
// payload (evidence/research/etc. stay in the log file itself, for
// anyone who opens it directly).

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

// Phase 5B — a run that needed external research is recorded as TWO
// append-only lines sharing the same `runId` (see runner.js's
// `resumeRunId`): an initial `research_pending` line, then a `completed`
// (or `failed`) line once the orchestrator's research has been ingested
// and the run is resumed — `sequence` increments each time (1, 2, ...).
// The committed log itself NEVER rewrites the first line (append-only is
// still an absolute rule — see this file's own header) — this function
// is what every CONSUMER of readAllRuns() should call before building a
// user-facing list, so a resumed run is shown ONCE, as its latest/
// current state, never as two confusing "before research"/"after
// research" entries. A record with no `sequence` field (every pre-
// Phase-5B record) is treated as sequence 1, so old history still works.
// Phase 15 — "do not repeatedly research the exact same suppressed
// opportunity every day... reconsider only when evidence materially
// changes." WATCH/LOW_SUPPRESS/PROTECT findings never reach
// agent_proposals (see proposals-sync.js's needsProposal()), so this
// git-tracked, append-only log IS their only persisted memory — exactly
// the "log-only, re-derive each run" design: nothing here is ever
// mutated, a later run simply reads back the most recent entry for a
// given finding key and compares its `fingerprint`
// (opportunity-classification.js's computeClassificationFingerprint())
// to decide whether anything material has actually changed, rather than
// re-flagging an unchanged suppressed item as newly surfaced every run.
// Returns `null` (never throws) when the key has no classification
// recorded in any run, or `runs` is empty/malformed — same fail-safe
// posture every other reader of this log already follows.
function latestClassificationByKey(runs, key) {
  try {
    const sorted = [...(Array.isArray(runs) ? runs : [])].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    for (const run of sorted) {
      const list = Array.isArray(run.opportunityClassifications) ? run.opportunityClassifications : [];
      const match = list.find((c) => c && c.key === key);
      if (match) return match;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function latestByRunId(runs) {
  const byId = new Map();
  for (const run of runs) {
    const seq = run.sequence || 1;
    const existing = byId.get(run.runId);
    if (!existing || seq >= (existing.sequence || 1)) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values()];
}

// Plain-text description of one finding's outcome. Prefers Phase 2's
// `decision` field when present; falls back to the plainer Phase 1
// status/category heuristic for any older-shaped record still in the log
// (the log is append-only and never rewritten, so old entries never gain
// a `decision` field retroactively).
function describeFinding(finding) {
  if (finding.decision) {
    switch (finding.decision) {
      case "APPLY_SAFE_FIX":
        if (finding.status === "applied") return `Fixed: ${finding.summary}`;
        if (finding.status === "reverted") return `Attempted fix reverted after validation failed: ${finding.summary}`;
        return `Found a fixable issue, but couldn't apply it safely: ${finding.summary}`;
      case "RESEARCH_MORE":
        return `Researching: ${finding.summary} — pending`;
      case "NO_CHANGE":
        // Phase 3: an observation-tier finding never implies research was
        // (or should have been) attempted — see risk.js/decision.js's
        // weak-finding-semantics handling. Checked before the
        // research-array branch so a tier:"observation" finding never
        // misreports "insufficient evidence" (which reads as "we looked
        // and it wasn't enough") when the real story is "this was never
        // strong enough evidence to look into in the first place."
        if (finding.tier === "observation") {
          return `Observed: ${finding.summary} — not actionable on its own`;
        }
        return finding.research && finding.research.length
          ? `Researched: ${finding.summary} — no change made — insufficient evidence`
          : `Reviewed: ${finding.summary} — no change needed`;
      case "REJECT_OPPORTUNITY":
        return `Rejected opportunity: ${finding.summary}`;
      case "PROPOSE_CHANGE":
      default:
        return `Found: ${finding.summary} — review/apply status`;
    }
  }

  // Phase 1 fallback (no `decision` field on this record).
  if (finding.status === "applied") return `Fixed: ${finding.summary}`;
  if (finding.category === "E" || finding.riskLevel === "unknown") {
    return `Researched: ${finding.summary} — no change made`;
  }
  return `Identified opportunity: ${finding.summary}`;
}

function iconForFinding(finding) {
  if (finding.decision === "APPLY_SAFE_FIX") {
    return finding.status === "applied" ? "check" : "flag";
  }
  if (finding.decision === "NO_CHANGE" && finding.tier === "observation") return "observation";
  if (finding.decision === "RESEARCH_MORE" || finding.decision === "NO_CHANGE") return "research";
  if (finding.decision === "REJECT_OPPORTUNITY") return "reject";
  if (finding.decision === "PROPOSE_CHANGE") return "flag";
  // Phase 1 fallback.
  if (finding.status === "applied") return "check";
  if (finding.category === "E" || finding.riskLevel === "unknown") return "research";
  return "flag";
}

function activityLine(finding) {
  return { icon: iconForFinding(finding), text: describeFinding(finding) };
}

/**
 * Reduces run records into the dashboard's "Today / Recent activity" shape:
 * a short list of {icon, text} lines per run, always led by a "Checked N
 * pages" line so the owner sees the agent actually ran even on a run with
 * zero findings.
 * @param {object[]} runs - as returned by readAllRuns()
 * @param {number} limit - max runs to include, most recent first
 */
function buildDashboardSummary(runs, limit = 10) {
  const deduped = latestByRunId(runs);
  const sorted = [...deduped].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const recent = sorted.slice(0, limit);
  return recent.map((run) => {
    const pagesScanned = run.summary && typeof run.summary.pagesScanned === "number" ? run.summary.pagesScanned : null;
    // Phase 4 hardening — defense-in-depth: fall back to an empty array
    // rather than throwing, if a log entry is ever missing `findings`
    // (a future schema change, a hand-edited line). Every caller of this
    // function should already be wrapped in its own try/catch (see
    // api/admin/bookings.js's handleAgentActivity()), but this function
    // staying throw-safe on its own is a second, independent guard.
    const findings = Array.isArray(run.findings) ? run.findings : [];
    const lines = [];
    if (pagesScanned !== null) {
      lines.push({ icon: "check", text: `Checked ${pagesScanned} page${pagesScanned === 1 ? "" : "s"}` });
    }
    // Phase 15 — "no proposal" can still mean the Agent did useful work
    // (see report.js's opportunityResearch section, this run's richer
    // counterpart) — one terse line here so Home's activity feed shows
    // that too, not just whatever became a proposal.
    const classifications = Array.isArray(run.opportunityClassifications) ? run.opportunityClassifications : [];
    if (classifications.length > 0) {
      const counts = { IMPORTANT: 0, WATCH: 0, LOW_SUPPRESS: 0, PROTECT: 0 };
      for (const c of classifications) {
        if (c && counts[c.classification] !== undefined) counts[c.classification] += 1;
      }
      lines.push({
        icon: "research",
        text: `Opportunities researched: ${classifications.length} (${counts.IMPORTANT} important, ${counts.WATCH} watch, ${counts.LOW_SUPPRESS} suppressed, ${counts.PROTECT} protect)`,
      });
    }
    if (findings.length === 0) {
      lines.push({ icon: "check", text: "No worthwhile change today." });
    } else {
      lines.push(...findings.map(activityLine));
    }
    return {
      runId: run.runId,
      timestamp: run.timestamp,
      mode: run.mode,
      lines,
    };
  });
}

module.exports = {
  appendRun,
  readAllRuns,
  latestByRunId,
  latestClassificationByKey,
  buildDashboardSummary,
  describeFinding,
  iconForFinding,
  activityLine,
};
