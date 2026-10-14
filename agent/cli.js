#!/usr/bin/env node
// Site Improvement Agent — CLI entry point.
//
//   node agent/cli.js                 dry-run (default, always safe)
//   node agent/cli.js --dry-run       same, explicit
//   node agent/cli.js --apply-safe    additionally applies the narrow
//                                     auto-fix whitelist (refuses if the
//                                     working tree is dirty)
//   node agent/cli.js --json          print the full run record as JSON
//                                     instead of the human summary
//
// Phase 5 (daily/weekly operating system) — run type, orthogonal to mode
// above (mode controls whether the narrow auto-fix whitelist is applied;
// run type is purely about REPORTING/rotation — see agent/README.md):
//
//   node agent/cli.js --daily         runType "daily" (lightweight — see
//                                     agent/README.md's daily-run section)
//   node agent/cli.js --weekly        runType "weekly" — additionally
//                                     computes this week's research-
//                                     rotation picks across the whole
//                                     service area and records them in
//                                     the report
//   (no flag)                         runType "manual" (default, e.g. an
//                                     ad hoc run from the terminal)
//
// Phase 5B — RESEARCH ORCHESTRATION (see agent/README.md's "Orchestrator
// architecture" section, and runner.js's own header):
//
//   node agent/cli.js --daily --json
//     If the run comes back with report.status === "research_pending",
//     a research-capable orchestrator (a Claude-driven session) reads
//     report.research.questionsPending[] — each one a fully-formed
//     question (text, internal evidence, suggested source types),
//     researches it per agent/README.md's evidence hierarchy, and writes
//     one agent/research/results/*.json file per answered question
//     (matching `findingKey` — see research.js's makeResearchResult()).
//
//   node agent/cli.js --resume=<runId>
//     Re-runs the SAME run (same runId, a new `sequence`) now that
//     research files exist, finalizing it to "completed" or "failed".
//     Mode/runType are inherited from the original run unless this
//     invocation also passes --apply-safe/--daily/--weekly explicitly.
//
//   node agent/cli.js --refresh-completed-jobs
//     Pulls recent COMPLETED bookings from Supabase, passes each through
//     the existing business-context.js privacy boundary, and writes only
//     the already-sanitized result to agent/research/completed-jobs/ —
//     see agent/lib/completed-job-fetch.js's own header. Never prints
//     any field it fetches; only a count. A separate, explicit step from
//     --daily/--weekly, so the deterministic pipeline itself still never
//     touches Supabase or the network.
//
// Nothing here activates a schedule — see agent/README.md's "Scheduling
// architecture" section for the recommended cadence and why it is
// deliberately NOT turned on by this phase.

const { run } = require("./runner");
const { fetchRecentCompletedJobEvidence, writeCompletedJobEvidence } = require("./lib/completed-job-fetch");

function parseResumeArg(args) {
  const prefixed = args.find((a) => a.startsWith("--resume="));
  if (prefixed) return prefixed.slice("--resume=".length);
  const idx = args.indexOf("--resume");
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return null;
}

async function runRefreshCompletedJobs() {
  const result = await fetchRecentCompletedJobEvidence();
  if (result.skipped) {
    console.log(`Completed-job refresh skipped: ${result.reason}`);
    return;
  }
  const written = writeCompletedJobEvidence(result.evidence);
  // Deliberately never logs field VALUES — only a count. See
  // completed-job-fetch.js's header for why (raw booking data must never
  // reach a log line, even indirectly).
  console.log(`Completed-job refresh: ${result.evidence.length} publication-safe entr(ies) written to ${written}.`);
}

function printRecord(record, asJson) {
  if (asJson) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  console.log(`Site Improvement Agent — run ${record.runId} (seq ${record.sequence || 1}, ${record.runType}/${record.mode})`);
  console.log(`Scanned ${record.summary.pagesScanned} pages, ${record.summary.findingsTotal} finding(s).`);
  if (record.applySkippedReason) {
    console.log(`NOTE: ${record.applySkippedReason}`);
  }
  console.log(`By category: ${JSON.stringify(record.summary.byCategory)}`);
  console.log(`By decision: ${JSON.stringify(record.summary.byDecision)}`);
  console.log(`Auto-applied: ${record.summary.autoApplied}, Proposed: ${record.summary.proposed}, Research questions raised: ${record.summary.researchQuestionsRaised}`);
  if (record.validation.performed) {
    console.log(`Post-apply validation: ${record.validation.confirmed} confirmed-resolved, ${record.validation.reverted} reverted automatically.`);
  }
  if (record.proposalsSync.skipped) {
    console.log(`CRM proposal sync: skipped (${record.proposalsSync.reason}).`);
  } else {
    console.log(`CRM proposal sync: ${record.proposalsSync.synced}/${record.proposalsSync.total} synced.`);
  }
  if (record.report) {
    console.log(`Run status: ${record.report.status.toUpperCase()}`);
    console.log(`Site health: ${record.report.healthSummary.text}`);
    console.log(`Change detection vs. previous run: ${record.report.changeDetection.counts.new} new, ${record.report.changeDetection.counts.stillOpen} still open, ${record.report.changeDetection.counts.resolved} resolved.`);
    if (record.report.rotation) {
      console.log(`This week's research-rotation picks: ${record.report.rotation.picks.map((p) => p.name).join(", ")}`);
    }
    if (record.report.status === "research_pending") {
      console.log("");
      console.log(`RESEARCH REQUIRED — this run is NOT finalized. ${record.report.research.questionsPending.length} question(s) need answers before it can be resumed:`);
      for (const q of record.report.research.questionsPending) {
        console.log(`  [${q.findingKey}] ${q.question}`);
        console.log(`    suggested sources: ${(q.suggestedSourceTypes || []).join(", ")}`);
      }
      console.log("");
      console.log(`After writing the research result file(s), resume with:  node agent/cli.js --resume=${record.runId}`);
    }
  }
  console.log("");

  if (record.findings.length === 0) {
    console.log("No worthwhile change today.");
    return;
  }

  for (const f of record.findings) {
    const tag = f.status === "applied" ? "[APPLIED]" : `[${f.category}/${f.riskLevel} -> ${f.decision}]`;
    console.log(`${tag} ${f.type}: ${f.summary}`);
    console.log(`    reason: ${f.decisionReason}`);
    if (f.decision === "RESEARCH_MORE" && f.researchQuestion) {
      console.log(`    research question: ${f.researchQuestion.question}`);
    }
    if (f.recommendation) console.log(`    -> ${f.recommendation}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--refresh-completed-jobs")) {
    await runRefreshCompletedJobs();
    return;
  }

  const asJson = args.includes("--json");
  const resumeRunId = parseResumeArg(args);

  // For a fresh run, mode/runType come from the flags as before. For a
  // resume, omit mode/runType entirely unless explicitly re-specified —
  // runner.js's run() inherits both from the original run in that case
  // (see its own header).
  const explicitMode = args.includes("--apply-safe") ? "apply-safe" : args.includes("--dry-run") ? "dry-run" : undefined;
  const explicitRunType = args.includes("--weekly") ? "weekly" : args.includes("--daily") ? "daily" : undefined;

  const runOptions = resumeRunId
    ? { resumeRunId, ...(explicitMode !== undefined ? { mode: explicitMode } : {}), ...(explicitRunType !== undefined ? { runType: explicitRunType } : {}) }
    : { mode: explicitMode || "dry-run", runType: explicitRunType || "manual" };

  let record;
  try {
    record = await run(runOptions);
  } catch (err) {
    // Failure safety: runner.js already persisted an honest "failed" run
    // record before re-throwing (see its own header) — this CLI's job is
    // just to surface that failure loudly and with a non-zero exit code,
    // never to swallow it or print a misleading "no worthwhile change"
    // message.
    console.error("Site Improvement Agent run failed:", err && err.stack ? err.stack : err);
    if (err && err.recordedFailure) {
      console.error(`A failed-run record was still saved to history (runId ${err.recordedFailure.runId}) so this failure is visible in the CRM report history.`);
    }
    process.exitCode = 1;
    return;
  }

  printRecord(record, asJson);
}

main().catch((err) => {
  console.error("Site Improvement Agent run failed:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
