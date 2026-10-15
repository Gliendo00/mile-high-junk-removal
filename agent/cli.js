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
//   node agent/cli.js --fetch-firstparty-strict=<path/to/request.json>
//     Phase 7D — identical to --fetch-firstparty= above (same request
//     shape, same fetchFirstPartyEvidence()/writeFirstPartyEvidence()
//     code path, same normalized/bounded evidence file — no second
//     Google client or auth path exists) with exactly one behavioral
//     difference: a {skipped:true} result (misconfiguration, auth
//     failure, API error) EXITS NONZERO instead of logging and
//     returning 0. Exists for the one-off "Golden Search Console
//     diagnostic" GitHub Actions dispatch (see
//     .github/workflows/website-agent.yml's diagnostic-golden-search-
//     console run_type) — an unattended job with no orchestrator
//     reading the log in real time must not look green when the
//     underlying fetch actually failed. A real zero-row result is
//     NEVER treated as a failure in either mode — only a genuine
//     skip is.
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
//   node agent/cli.js --refresh-finding-evidence
//     Closes the analogous gap for FINDINGS: category-C content-
//     opportunity findings (content-gap, structural-inconsistency) were
//     never eligible for either existing first-party-evidence path —
//     firstparty-candidates.js's CANDIDATE_TYPES excludes category-C by
//     design, and decision.js's RESEARCH_MORE path only ever gathers
//     EXTERNAL research, never first-party Search Console data — so
//     agent/lib/firstparty-signals.js's query-page-mismatch classifier
//     (built in a prior phase) has never had real qualifying evidence
//     to classify. See agent/lib/finding-evidence.js's header for the
//     full architecture (same pattern as --refresh-rotation-evidence
//     above: a narrow candidate rule, a mechanical, no-judgment-needed
//     request builder, and freshness-based — not permanent — exclusion
//     of findings that already have fresh evidence). Recomputes this
//     week's findings (same deterministic gatherFindings() a --weekly
//     run itself will call moments later), and for each eligible,
//     not-already-fresh candidate, fetches ONE targeted Search Console
//     Search Analytics query (dimensions ["query","page"], filtered by
//     QUERY only — never by page, which would make a mismatch
//     structurally undetectable — see finding-evidence.js's
//     buildQueryPageEvidenceRequest()) and writes it to
//     agent/research/firstparty/ — same file convention, same
//     fetchFirstPartyEvidence()/writeFirstPartyEvidence() functions
//     every other first-party path already uses; no new Google client,
//     no new auth code. Run BEFORE --weekly (same precedent as
//     --refresh-rotation-evidence and --refresh-completed-jobs) so the
//     evidence is already on disk by the time --weekly's own report is
//     built and firstparty-signals.js's attachFirstPartySignals() can
//     classify it. Never throws: every candidate's outcome (fetched /
//     fetched-zero-rows / skipped / failed — see classifyFindingEvidenceOutcome()
//     below) is logged and the loop continues, one candidate's problem
//     must never block another's fetch — same fail-safe posture as
//     every other optional-integration step in this codebase. A
//     skipped/failed candidate writes NO evidence file at all (the
//     underlying fetchSearchAnalyticsEvidence() never calls
//     makeFirstPartyEvidence() on a skip), so a failure can never be
//     silently mistaken for a genuine zero-row result — only a REAL
//     successful API call ever produces a file with
//     `observed.totalRowsReturned: 0`.
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
const { isQueryPageEvidenceCandidate, buildQueryPageEvidenceRequest, freshlyEvidencedFindingKeys } = require("./lib/finding-evidence");
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

// Classifies a fetchFirstPartyEvidence() result into exactly one of
// four honest outcomes, for --refresh-finding-evidence's own console
// log (see this file's top-of-file comment on why: "a transient
// individual candidate fetch failure... must not imply that research
// was successfully performed for that candidate", and must be
// distinguishable from a genuine zero-row result, never silently
// conflated with it):
//   - "fetched"            - a real, successful API call that found 1+ rows
//   - "fetched-zero-rows"  - a real, successful API call that found 0 rows
//                            (honest absence-of-SIGNAL, never absence-of-
//                            opportunity — same rule every other
//                            zero-row path in this codebase already
//                            states explicitly)
//   - "skipped"            - never attempted at all: the integration
//                            simply isn't configured in this environment,
//                            or the request itself was malformed before
//                            any network call — same reason text
//                            fetchSearchAnalyticsEvidence() already
//                            produces for these cases, just read back
//                            here for classification, not re-derived
//   - "failed"             - an attempt WAS made (auth resolution, or
//                            the Search Analytics API call itself) and
//                            did not succeed — a real problem worth a
//                            human's attention, distinct from "not
//                            configured"
// This is read-only classification of fetchFirstPartyEvidence()'s
// EXISTING {skipped, reason} shape — no change to that shape, no new
// Google networking code, nothing persisted differently: a
// skipped/failed candidate still writes zero evidence files either way
// (see this file's --refresh-finding-evidence doc comment on why that
// alone already prevents a failure from masquerading as real evidence).
// This function exists purely to make the CONSOLE LOG (the only place
// either outcome is currently surfaced, same precedent as
// --refresh-rotation-evidence) say which of the two happened, instead
// of collapsing both into one generic "skipped" word.
function classifyFindingEvidenceOutcome(result) {
  if (!result.skipped) {
    const rows = result.evidence && result.evidence.observed ? result.evidence.observed.totalRowsReturned : null;
    return rows > 0 ? "fetched" : "fetched-zero-rows";
  }
  const reason = String(result.reason || "");
  // Matches fetchSearchAnalyticsEvidence()'s own "not configured"/
  // input-validation reason text (firstparty-fetch.js) — anything else
  // (an auth-resolution problem from google-auth.js, or a genuine
  // "Search Analytics API error"/"request failed" from
  // search-console-client.js) means an attempt genuinely happened and
  // did not succeed, which this classifies as "failed", never "skipped".
  if (/not configured|requires (a |an )?scope|requires a non-empty/i.test(reason)) return "skipped";
  return "failed";
}

// See this file's top-of-file comment on --refresh-finding-evidence and
// agent/lib/finding-evidence.js's header for the full architecture.
// Never throws: every candidate's outcome is logged (via
// classifyFindingEvidenceOutcome() above) and the loop continues — one
// candidate's problem must never block another's fetch, same fail-safe
// posture as runRefreshRotationEvidence() above.
//
// A candidate with STALE existing evidence is still eligible — only
// evidence that's still FRESH-or-AGING (freshlyEvidencedFindingKeys(),
// same freshness windows report.js/rotation-evidence.js already use)
// counts as "already evidenced" and skips a re-fetch. See
// finding-evidence.js's header on why this is freshness-based, not the
// EXISTING firstparty-candidates.js mechanism's permanent-suppression
// rule (a deliberately separate, unchanged lifecycle).
//
// Returns the per-candidate outcomes array (not currently persisted
// anywhere beyond this console log and the evidence files' own natural
// presence/absence — see this file's doc comment) so tests can assert
// on it directly without parsing console output.
async function runRefreshFindingEvidence() {
  const { findings } = gatherFindings();
  const freshKeys = freshlyEvidencedFindingKeys(loadFirstPartyEvidence().entries);
  const candidates = findings.filter((f) => isQueryPageEvidenceCandidate(f) && !freshKeys.has(f.key));

  console.log(`Finding evidence refresh: ${candidates.length} candidate finding(s) needing first-party query/page evidence.`);
  const outcomes = [];
  if (candidates.length === 0) return outcomes;

  for (const finding of candidates) {
    const request = buildQueryPageEvidenceRequest(finding);
    const result = await fetchFirstPartyEvidence(request);
    const outcome = classifyFindingEvidenceOutcome(result);

    if (result.skipped) {
      console.log(`  "${finding.key}" (${finding.type}): ${outcome} — ${result.reason}`);
      outcomes.push({ findingKey: finding.key, type: finding.type, outcome, reason: result.reason });
      continue;
    }

    const written = writeFirstPartyEvidence(result.evidence);
    const rows = result.evidence.observed.totalRowsReturned;
    console.log(`  "${finding.key}" (${finding.type}): ${outcome} (${rows} row(s)), written to ${written}.`);
    outcomes.push({ findingKey: finding.key, type: finding.type, outcome, rows, writtenTo: written });
  }
  return outcomes;
}

function parseFetchFirstPartyArg(args) {
  const prefixed = args.find((a) => a.startsWith("--fetch-firstparty="));
  return prefixed ? prefixed.slice("--fetch-firstparty=".length) : null;
}

function parseFetchFirstPartyStrictArg(args) {
  const prefixed = args.find((a) => a.startsWith("--fetch-firstparty-strict="));
  return prefixed ? prefixed.slice("--fetch-firstparty-strict=".length) : null;
}

/**
 * @param {string} requestPath
 * @param {object} [options]
 * @param {boolean} [options.strict] - Phase 7D: when true (the
 *   --fetch-firstparty-strict= CLI flag — see this file's top-of-file
 *   comment), a `{skipped:true}` result (misconfiguration, auth
 *   failure, or an API error) is treated as a HARD FAILURE
 *   (process.exitCode = 1), not a graceful no-op. The default
 *   (non-strict, --fetch-firstparty=) behavior is UNCHANGED — it still
 *   logs and returns 0, because that path is driven by a research-
 *   capable orchestrator session that can read the reason and decide
 *   what to do next. Strict mode exists for the opposite case: an
 *   unattended, one-off diagnostic dispatch with no one reading the
 *   log in real time, where a swallowed failure would look identical
 *   to a successful green run. A ZERO-ROW result is NEVER a failure in
 *   either mode — `fetchFirstPartyEvidence()` only returns
 *   `{skipped:true}` for an actual auth/config/API problem; a real,
 *   successful API call that legitimately found zero matching rows
 *   returns `{skipped:false, evidence}` same as any other count, and
 *   is written and reported exactly the same way.
 */
async function runFetchFirstParty(requestPath, options = {}) {
  const strict = options.strict === true;
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
    if (strict) {
      console.error(`First-party evidence fetch FAILED: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`First-party evidence fetch skipped: ${result.reason}`);
    }
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

  if (args.includes("--refresh-finding-evidence")) {
    await runRefreshFindingEvidence();
    return;
  }

  const fetchFirstPartyStrictPath = parseFetchFirstPartyStrictArg(args);
  if (fetchFirstPartyStrictPath) {
    await runFetchFirstParty(fetchFirstPartyStrictPath, { strict: true });
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

module.exports = {
  runFetchFirstParty,
  parseFetchFirstPartyArg,
  parseFetchFirstPartyStrictArg,
  runRefreshFindingEvidence,
  classifyFindingEvidenceOutcome,
};

// Guards against auto-running the CLI when this file is require()'d
// for testing (tests/agent-cli-fetch-firstparty-strict.test.js) rather
// than executed directly as `node agent/cli.js`.
if (require.main === module) {
  main().catch((err) => {
    console.error("Site Improvement Agent run failed:", err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
