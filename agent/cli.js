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
//   node agent/cli.js --fetch-firstparty=<path/to/request.json>
//     Phase 6 — a research-capable orchestrator's targeted Search
//     Console / GA4 / URL Inspection fetch, performed ONLY when a
//     specific finding or RESEARCH_MORE question warrants it (see
//     agent/README.md's Phase 6 section) — never a full-dataset dump,
//     never run automatically by --daily/--weekly. The request file
//     shape is {type: "search-analytics"|"url-inspection"|"ga4", ...} —
//     see agent/lib/firstparty-fetch.js's fetch*Evidence() jsdoc for the
//     exact fields each type takes. Writes one normalized, bounded
//     evidence file to agent/research/firstparty/ (never the raw API
//     response) for the next --daily/--weekly/--resume run to pick up via
//     agent/lib/firstparty-intake.js. Never prints raw evidence values —
//     only a count and the file path (these aren't private, unlike
//     completed-job evidence, but the convention stays consistent).
//
//   node agent/cli.js --refresh-rotation-evidence
//     Phase 7B — closes the "rotation picks a deep-review target but
//     nothing performs the review" gap (see agent/lib/rotation-evidence.js's
//     header for the full root-cause writeup). Recomputes this week's
//     rotation picks (same inputs/algorithm a --weekly run itself will
//     use moments later — nothing in this repo changes between the two,
//     so the picks are identical), and for each claimed-but-pageless
//     pick that doesn't already have FRESH (non-stale) evidence —
//     stale evidence is treated as absent, so a city is re-checked
//     again once enough time passes, never silently abandoned forever
//     because of one old result — fetches ONE targeted
//     Search Console Search Analytics query ("does any real query
//     mention this city?") and writes it to agent/research/firstparty/
//     — same file convention as --fetch-firstparty, just mechanically
//     triggered rather than orchestrator-composed, because the request
//     shape here needs no judgment call (see that file's header). Run
//     BEFORE --weekly (mirrors --refresh-completed-jobs's existing
//     precedent exactly) so the evidence is already on disk by the time
//     --weekly's own report is built. Never fetches for a city that
//     already has a page (that goes through the ordinary daily/
//     firstparty-candidates.js path instead) and never performs, or
//     pretends to perform, the EXTERNAL (municipal/competitor) research
//     half of a deep review — that still requires a research-capable
//     orchestrator session this unattended runner does not have.
//
// Nothing here activates a schedule — see agent/README.md's "Scheduling
// architecture" section for the recommended cadence and why it is
// deliberately NOT turned on by this phase.

const fs = require("fs");
const { run, gatherFindings } = require("./runner");
const { fetchRecentCompletedJobEvidence, writeCompletedJobEvidence } = require("./lib/completed-job-fetch");
const { fetchFirstPartyEvidence, writeFirstPartyEvidence } = require("./lib/firstparty-fetch");
const { loadCompletedJobEvidence, summarizeByCity } = require("./lib/completed-job-intake");
const { loadRotationState, computePriorities } = require("./lib/research-rotation");
const { isRotationEvidenceCandidate, buildRotationEvidenceRequest, freshlyEvidencedRotationSlugs } = require("./lib/rotation-evidence");
const { loadFirstPartyEvidence } = require("./lib/firstparty-intake");

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

// Phase 7B — see this file's own top-of-file comment on
// --refresh-rotation-evidence, and agent/lib/rotation-evidence.js's
// header for the full root-cause writeup this closes. Never throws:
// every per-pick outcome (fetched / skipped+reason) is logged and the
// loop continues — one pick's skip must never block another's fetch,
// same fail-safe posture as every other optional-integration step in
// this codebase.
//
// A pick with STALE existing evidence is still a candidate — only
// evidence that's still FRESH-or-AGING (computeFirstPartyFreshness(),
// the same freshness windows report.js already uses) counts as
// "already evidenced" and skips a re-fetch. Without this, a city that
// got a zero-row result once would never be re-checked again, EVER,
// regardless of how much time passed — exactly the "zero city-query
// evidence independently justifies abandoning future research for
// that city" outcome agent/lib/rotation-evidence.js's header explicitly
// rules out. A zero-row result is honest evidence of "no signal
// THEN" — it must not calcify into "no signal forever."
async function runRefreshRotationEvidence() {
  const { findings } = gatherFindings();
  const { evidence } = loadCompletedJobEvidence();
  const citySummary = summarizeByCity(evidence);
  const rotationState = loadRotationState();
  const picks = computePriorities({ state: rotationState, currentFindings: findings, completedJobCitySummary: citySummary });

  const freshlyEvidencedSlugs = freshlyEvidencedRotationSlugs(loadFirstPartyEvidence().entries);
  const candidates = picks.filter((p) => isRotationEvidenceCandidate(p) && !freshlyEvidencedSlugs.has(p.slug));

  console.log(`Rotation evidence refresh: ${picks.length} pick(s) selected this week, ${candidates.length} pageless candidate(s) needing first-party evidence.`);
  if (candidates.length === 0) return;

  for (const pick of candidates) {
    const request = buildRotationEvidenceRequest(pick);
    const result = await fetchFirstPartyEvidence(request);
    if (result.skipped) {
      console.log(`  "${pick.name}" (${pick.slug}): skipped — ${result.reason}`);
      continue;
    }
    const written = writeFirstPartyEvidence(result.evidence);
    console.log(`  "${pick.name}" (${pick.slug}): fetched, written to ${written}.`);
  }
}

function parseFetchFirstPartyArg(args) {
  const prefixed = args.find((a) => a.startsWith("--fetch-firstparty="));
  return prefixed ? prefixed.slice("--fetch-firstparty=".length) : null;
}

async function runFetchFirstParty(requestPath) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  } catch (e) {
    console.error(`Could not read/parse first-party evidence request file "${requestPath}": ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  const result = await fetchFirstPartyEvidence(request);
  if (result.skipped) {
    console.log(`First-party evidence fetch skipped: ${result.reason}`);
    return;
  }
  const filePath = writeFirstPartyEvidence(result.evidence);
  const count = Array.isArray(result.evidence) ? result.evidence.length : 1;
  console.log(`First-party evidence fetch: ${count} evidence entr(ies) written to ${filePath}.`);
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
    if (record.report.firstPartyEvidence) {
      const fpe = record.report.firstPartyEvidence;
      console.log(`First-party evidence — Search Console: ${fpe.integrations.searchConsole ? "configured" : "not configured"}, GA4: ${fpe.integrations.ga4 ? "configured" : "not configured"}, this run: ${fpe.gatheredDuringThisRunCount} gathered during this run, ${fpe.reusedFromBeforeCount} reused from before (${fpe.gatheredThisRunCount} total).`);
      if (fpe.sourcesNotConsulted.length) {
        console.log(`  Not consulted this run: ${fpe.sourcesNotConsulted.join(", ")}.`);
      }
    }
    if (record.report.status === "research_pending") {
      console.log("");
      console.log(`EVIDENCE REQUIRED — this run is NOT finalized.`);
      if (record.report.research.questionsPending.length) {
        console.log(`${record.report.research.questionsPending.length} external research question(s) need answers:`);
        for (const q of record.report.research.questionsPending) {
          console.log(`  [${q.findingKey}] ${q.question}`);
          console.log(`    suggested sources: ${(q.suggestedSourceTypes || []).join(", ")}`);
        }
      }
      if (record.report.firstPartyEvidence && record.report.firstPartyEvidence.questionsPending.length) {
        console.log(`${record.report.firstPartyEvidence.questionsPending.length} first-party-evidence check(s) would genuinely help:`);
        for (const q of record.report.firstPartyEvidence.questionsPending) {
          console.log(`  [${q.findingKey}] ${q.question}`);
          console.log(`    suggested request types: ${(q.suggestedRequestTypes || []).join(", ")} — e.g. node agent/cli.js --fetch-firstparty=<request.json>`);
        }
      }
      console.log("");
      console.log(`After writing the research/evidence file(s), resume with:  node agent/cli.js --resume=${record.runId}`);
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

  if (args.includes("--refresh-rotation-evidence")) {
    await runRefreshRotationEvidence();
    return;
  }

  const fetchFirstPartyPath = parseFetchFirstPartyArg(args);
  if (fetchFirstPartyPath) {
    await runFetchFirstParty(fetchFirstPartyPath);
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
