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
//   node agent/cli.js --refresh-local-source-evidence
//     Phase 11B — for this week's rotation picks, fetches curated
//     official-source evidence (agent/context/local-source-
//     registry.json) ONLY for sources geographically relevant to a pick
//     (never every registry entry every week), deduplicated across
//     picks sharing the same source, skipping anything already fresh.
//     See agent/lib/local-source-candidates.js's header for the full
//     architecture. Run BEFORE --weekly.
//
//   node agent/cli.js --refresh-lead-event-evidence
//     Phase 12 — for this week's content-gap/structural-inconsistency
//     candidate findings on real conversion-intent pages (never blog/
//     utility pages — see agent/lib/lead-event-candidates.js's header),
//     fetches TWO correlated GA4 requests per candidate: this landing
//     page's own session total, and raw eventName+eventCount for this
//     codebase's confirmed lead-event vocabulary (phone_click,
//     sms_click, the contact-form events, the booking funnel — never
//     the conversions/keyEvents metric, which depends on GA4
//     Admin-console configuration this agent cannot see). Both requests
//     ask for a comparison to the immediately-preceding period
//     (compareToPreviousPeriod — see agent/lib/firstparty-fetch.js),
//     feeding agent/lib/firstparty-signals.js's
//     deriveLeadEventLandingPageDeltaSignal(). Each candidate's two
//     fetches are attempted independently — one half failing never
//     blocks the other. Run BEFORE --weekly, same precedent as every
//     other weekly-only refresh step above.
//     Phase 10 — Curated Official Source Evidence: a narrow, manual
//     verification fetch against EXACTLY ONE entry already declared in
//     the human-curated, human-VERIFIED agent/context/local-source-
//     registry.json (never an arbitrary URL — the argument is a
//     registry entry's `id`, looked up via
//     agent/lib/local-source-registry.js's getEntryById(); an unknown id
//     refuses outright rather than falling back to treating it as a
//     literal URL). Checks robots.txt first (never proceeds without an
//     explicit allow), fetches ONLY that one known URL (no sitemap
//     discovery, no redirect-following, no retry/bypass of any kind),
//     and writes one normalized, bounded evidence file to
//     agent/research/local-sources/ (see agent/lib/local-source-
//     evidence.js — no verdict/confidence/recommendation field; this is
//     never a research.js result and never reaches decision.js). Same
//     strict-mode contract as --fetch-firstparty-strict= above: a
//     {skipped:true} result (robots disallow, network error, non-2xx,
//     an unexpected redirect, or an unknown registry id) EXITS NONZERO
//     instead of logging and returning 0 — exists for the one-off
//     "Denver LeafDrop local-source diagnostic" GitHub Actions dispatch
//     (see .github/workflows/website-agent.yml's
//     diagnostic-denver-leafdrop run_type). Never runs the ordinary
//     Agent pipeline, never touches rotation state, never creates a
//     proposal, never changes the site — see agent/README.md's Phase 10
//     section.
//
//   node agent/cli.js --run-synthesis
//     Phase 13a — deterministic cross-source evidence synthesis (see
//     agent/lib/run-synthesis.js's header for the full architecture).
//     Combines evidence already gathered by the steps above (first-party
//     evidence, completed-job evidence, curated local-source evidence)
//     for category-C findings that have no research yet, and writes an
//     ordinary agent/research/results/*.json file (sourceType
//     "cross-source-synthesis") when — and only when — that combination
//     is sufficient for this finding type's own threshold. Never
//     touches the network, never runs the audits, never changes a
//     finding's risk/tier/autoFix/autoApplyEligible, and never writes
//     anything when evidence is insufficient (decision.js's existing
//     RESEARCH_MORE path is the correct, unchanged outcome in that
//     case). Recommended AFTER --refresh-finding-evidence/
//     --refresh-lead-event-evidence/--refresh-local-source-evidence,
//     BEFORE --weekly, same precedent as those steps.
//
//   node agent/cli.js --execute-proposal=<id>
//     Phase 14 — the execution engine behind the dashboard's Approved /
//     Pending Execution queue (see agent/lib/execute-proposal.js's own
//     header for the full lifecycle/safeguards). Loads ONE
//     agent_proposals row by id, applies ONLY its recorded deterministic
//     fix (never prose, never a guess), re-validates and runs the full
//     test suite, and — only if every check passes — commits and pushes
//     to `main`. This is the ONLY place in this codebase that ever
//     pushes a real website content change automatically; it is never
//     run by --daily/--weekly, never by this unattended runner's own
//     website-agent.yml workflow, and is NOT safe to run against a dirty
//     working tree or outside the dedicated
//     .github/workflows/execute-proposal.yml dispatch (which is what the
//     admin dashboard's Execute button actually triggers — see
//     api/admin/bookings.js's resource:"agent-proposal" action:"execute"
//     — because a Vercel serverless function cannot itself commit to
//     git; see agent/README.md's Vercel-vs-GitHub-Actions table).
//
//   node agent/cli.js --check-integrations
//     CRM cleanup/verification audit (2026-10-21) — see agent/lib/
//     integration-health.js's own header for the full why. Runs one
//     minimal, REAL probe against Search Console and one against GA4
//     (not just an env-var presence check), and overwrites
//     agent/history/integration-health.json with the outcome — the
//     Website Agent dashboard (api/admin/bookings.js's
//     handleAgentDashboard()) reads that file instead of checking these
//     env vars itself, since they are never provisioned to Vercel by
//     design (see this file's own "Vercel / DB impact" cross-reference
//     in agent/README.md). ALWAYS exits 0 — this is a status check, not
//     a gate; a probe failure is recorded honestly in the file, not
//     treated as a reason to fail whatever run it's part of. Wired into
//     the EXISTING daily scheduled workflow run (not a new manual-only
//     diagnostic) in .github/workflows/website-agent.yml, so the
//     dashboard's status is at most one day stale in the normal case —
//     and visibly STALE, not silently wrong, if that schedule itself
//     stops running.
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
const { isQueryPageEvidenceCandidate, buildQueryPageEvidenceRequest, needsFindingEvidenceRefresh } = require("./lib/finding-evidence");
const { isLeadEventEvidenceCandidate, buildLeadEventEvidenceRequests, needsLeadEventEvidenceRefresh } = require("./lib/lead-event-candidates");
const { loadFirstPartyEvidence } = require("./lib/firstparty-intake");
const { getEntryById, loadRegistry, getEntries } = require("./lib/local-source-registry");
const { fetchLocalSourceEvidence, writeLocalSourceEvidence } = require("./lib/local-source-fetch");
const { loadLocalSourceEvidence } = require("./lib/local-source-intake");
const { selectWeeklyLocalSourceCandidates, picksWithNoRelevantSource, needsFetchThisRun } = require("./lib/local-source-candidates");
const { writeLocalSourceCandidateLog } = require("./lib/local-source-candidate-log");
const { runSynthesis } = require("./lib/run-synthesis");
const { checkIntegrationHealth, writeIntegrationHealth } = require("./lib/integration-health");
const { executeProposal } = require("./lib/execute-proposal");

// Phase 13a — see agent/lib/run-synthesis.js's header for the full
// architecture. Deterministic/network-free: never runs the audits,
// never touches Supabase/Google, just combines evidence already on disk
// (the most recent history run + completed-jobs/local-source evidence
// files) into, at most, one new agent/research/results/*.json file per
// eligible finding. Recommended as part of the weekly cadence, run
// AFTER --refresh-finding-evidence/--refresh-lead-event-evidence/
// --refresh-local-source-evidence so the evidence it reads is current.
function runRunSynthesis() {
  const result = runSynthesis();
  console.log(
    `Cross-source synthesis: ${result.candidates} candidate finding(s), ${result.written.length} new result(s) written, ${result.superseded.length} prior conclusion(s) superseded (evidence no longer supports them), ${result.unchanged.length} unchanged, ${result.belowThreshold.length} still below this finding type's threshold.`
  );
  for (const w of result.written) {
    console.log(`  "${w.findingKey}" (${w.type}): ${w.verdict} (sufficiency: ${w.sufficiency}) -> ${w.filePath}`);
  }
  for (const s of result.superseded) {
    console.log(`  "${s.findingKey}" (${s.type}): SUPERSEDES prior "${s.priorVerdict}" -> now ${s.verdict} (sufficiency: ${s.sufficiency}) -> ${s.filePath}`);
  }
  if (result.errors.length) {
    console.log(`  ${result.errors.length} error(s):`);
    for (const e of result.errors) console.log(`    "${e.findingKey}": ${e.message}`);
  }
  if (result.warnings.length) {
    for (const w of result.warnings) console.log(`  warning: ${w}`);
  }
}

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

// Phase 11B — closes the gap Phase 10 deliberately left open: a
// curated registry entry existing is not the same as it being USEFUL
// to Weekly's actual work this week. See agent/lib/local-source-
// candidates.js's header for the full architecture. Mirrors
// runRefreshRotationEvidence() above exactly: a separate, explicit,
// network-touching step, run BEFORE the main Agent pass, that never
// throws — one candidate's skip must never block another's fetch.
//
// Candidate selection asks, for EVERY one of this week's rotation
// picks (not just pageless ones — unlike isRotationEvidenceCandidate()
// above, a curated official source is just as useful for reviewing an
// EXISTING page's content as for a pageless city, so this deliberately
// does not narrow to `!pick.hasPage`), "is a curated authoritative
// source geographically relevant here?" (local-source-candidates.js's
// getRelevantSourcesForCity()) — and nothing more; see that module's
// header on why this is geographic relevance only, never program
// eligibility. The SAME registry entry relevant to several picks (a
// shared county source) is deduplicated to exactly one fetch — see
// selectWeeklyLocalSourceCandidates()'s own header.
//
// Writes agent/history/local-source-candidate-log.json (OVERWRITTEN
// each run, not appended) recording which relevant candidates were
// blocked/failed this run and why — see local-source-candidate-log.js's
// header for why this small side-file is necessary: a skip writes NO
// evidence file (same Phase 10 rule as every other skip in this
// codebase), so report.js, built later in a SEPARATE process, would
// otherwise have no way to distinguish "blocked/failed this run" from
// "relevant but never yet attempted."
async function runRefreshLocalSourceEvidence() {
  const { findings } = gatherFindings();
  const { evidence: completedJobs } = loadCompletedJobEvidence();
  const citySummary = summarizeByCity(completedJobs);
  const rotationState = loadRotationState();
  const picks = computePriorities({ state: rotationState, currentFindings: findings, completedJobCitySummary: citySummary });

  const registryEntries = getEntries(loadRegistry());
  const candidates = selectWeeklyLocalSourceCandidates(picks, registryEntries);
  const noSourcePickSlugs = picksWithNoRelevantSource(picks, registryEntries);

  console.log(
    `Local-source candidate selection: ${picks.length} rotation pick(s) this week, ${candidates.length} geographically-relevant curated source(s) (deduplicated), ${noSourcePickSlugs.length} pick(s) with no curated authoritative source.`
  );
  if (noSourcePickSlugs.length > 0) {
    console.log(`  No curated authoritative source for: ${noSourcePickSlugs.join(", ")}.`);
  }

  const { entries: existingEvidence } = loadLocalSourceEvidence();
  const toFetch = needsFetchThisRun(candidates, existingEvidence);
  const toFetchIds = new Set(toFetch.map((c) => c.entry.id));
  const alreadyFresh = candidates.filter((c) => !toFetchIds.has(c.entry.id));

  for (const { entry, matchedPickSlugs } of alreadyFresh) {
    console.log(`  "${entry.id}" (relevant to ${matchedPickSlugs.join(", ")}): skipped — fresh evidence already on disk.`);
  }

  const blockedOrFailed = [];
  for (const { entry, matchedPickSlugs } of toFetch) {
    const result = await fetchLocalSourceEvidence(entry);
    if (result.skipped) {
      console.log(`  "${entry.id}" (relevant to ${matchedPickSlugs.join(", ")}): skipped — ${result.reason}`);
      blockedOrFailed.push({ entryId: entry.id, matchedPickSlugs, reason: result.reason });
      continue;
    }
    const written = writeLocalSourceEvidence(result.evidence);
    console.log(`  "${entry.id}" (relevant to ${matchedPickSlugs.join(", ")}): fetched, written to ${written}.`);
  }

  writeLocalSourceCandidateLog({
    at: new Date().toISOString(),
    workflowStartedAt: process.env.WORKFLOW_STARTED_AT || null,
    blockedOrFailed,
  });
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
// evidence that's still FRESH-or-AGING AND recorded under the SAME
// query term deriveQueryFilterTerm() would produce today
// (needsFindingEvidenceRefresh(), same freshness windows report.js/
// rotation-evidence.js already use) counts as "already evidenced" and
// skips a re-fetch. See finding-evidence.js's header on why this is
// freshness-AND-fingerprint-based, not the EXISTING
// firstparty-candidates.js mechanism's permanent-suppression rule (a
// deliberately separate, unchanged lifecycle) — and on how the
// fingerprint half is what lets a corrected deriveQueryFilterTerm()
// self-heal its own obsolete evidence without a one-time manual
// deletion.
//
// Returns the per-candidate outcomes array (not currently persisted
// anywhere beyond this console log and the evidence files' own natural
// presence/absence — see this file's doc comment) so tests can assert
// on it directly without parsing console output.
async function runRefreshFindingEvidence() {
  const { findings } = gatherFindings();
  const entries = loadFirstPartyEvidence().entries;
  const candidates = findings.filter((f) => isQueryPageEvidenceCandidate(f) && needsFindingEvidenceRefresh(f, entries));

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

// Phase 12 — see this file's own top-of-file comment on
// --refresh-lead-event-evidence, and agent/lib/lead-event-candidates.js's
// header for the full architecture. Mirrors runRefreshFindingEvidence()
// above almost exactly, with ONE structural difference: each candidate
// needs TWO correlated GA4 fetches (session-context + event-detail —
// see firstparty-signals.js's deriveLeadEventLandingPageDeltaSignal()
// header on why), attempted INDEPENDENTLY of each other — a failure of
// one half must never block the other half's fetch, same "one
// candidate's problem must never block another's" posture this
// codebase already applies at the candidate level, generalized here to
// the two halves of one candidate. Never throws; every outcome is
// logged and returned for tests to assert on directly.
async function runRefreshLeadEventEvidence() {
  const { findings } = gatherFindings();
  const entries = loadFirstPartyEvidence().entries;
  const candidates = findings.filter((f) => isLeadEventEvidenceCandidate(f) && needsLeadEventEvidenceRefresh(f, entries));

  console.log(`Lead-event evidence refresh: ${candidates.length} candidate finding(s) needing GA4 lead-event landing-page evidence.`);
  const outcomes = [];
  if (candidates.length === 0) return outcomes;

  for (const finding of candidates) {
    const [sessionRequest, eventRequest] = buildLeadEventEvidenceRequests(finding);

    for (const { request, part } of [
      { request: sessionRequest, part: "session-context" },
      { request: eventRequest, part: "event-detail" },
    ]) {
      const result = await fetchFirstPartyEvidence(request);
      if (result.skipped) {
        console.log(`  "${finding.key}" (${part}): skipped — ${result.reason}`);
        outcomes.push({ findingKey: finding.key, part, outcome: "skipped", reason: result.reason });
        continue;
      }
      const written = writeFirstPartyEvidence(result.evidence);
      console.log(`  "${finding.key}" (${part}): fetched, written to ${written}.`);
      outcomes.push({ findingKey: finding.key, part, outcome: "fetched", writtenTo: written });
    }
  }
  return outcomes;
}

function parseExecuteProposalArg(args) {
  const prefixed = args.find((a) => a.startsWith("--execute-proposal="));
  return prefixed ? prefixed.slice("--execute-proposal=".length) : null;
}

/**
 * See this file's top-of-file comment on --execute-proposal= and
 * agent/lib/execute-proposal.js's own header for the full lifecycle.
 * Always exits non-zero when the result isn't a successful deploy —
 * this is the one CLI command whose whole point is "did this actually
 * ship," so a quiet success-looking exit on a `needs_review`/`failed`
 * outcome would be the exact kind of silently-green run this codebase's
 * other unattended paths deliberately refuse to produce.
 */
async function runExecuteProposal(id, options = {}) {
  const result = await executeProposal(id, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
  return result;
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

function parseFetchLocalSourceStrictArg(args) {
  const prefixed = args.find((a) => a.startsWith("--fetch-local-source-strict="));
  return prefixed ? prefixed.slice("--fetch-local-source-strict=".length) : null;
}

/**
 * See this file's top-of-file comment on --fetch-local-source-strict=.
 * Always strict in Phase 1 (no non-strict/orchestrator-facing variant
 * exists yet — this flag exists purely for the manual diagnostic
 * dispatch), kept as an explicit `options.strict` the same shape as
 * runFetchFirstParty() above for consistency, rather than hardcoding the
 * behavior, so a future non-strict caller could be added without
 * reshaping this function.
 * @param {string} entryId - a agent/context/local-source-registry.json entry's own `id`
 * @param {object} [options]
 * @param {boolean} [options.strict]
 */
async function runFetchLocalSource(entryId, options = {}) {
  const strict = options.strict === true;
  const entry = getEntryById(entryId);
  if (!entry) {
    const message = `No local-source-registry entry with id "${entryId}".`;
    if (strict) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(message);
    }
    return;
  }

  const result = await fetchLocalSourceEvidence(entry);
  if (result.skipped) {
    if (strict) {
      console.error(`Local-source evidence fetch FAILED: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`Local-source evidence fetch skipped: ${result.reason}`);
    }
    return;
  }
  const filePath = writeLocalSourceEvidence(result.evidence);
  console.log(`Local-source evidence fetch: 1 evidence entry written to ${filePath}.`);
}

// CRM cleanup/verification audit (2026-10-21) — see agent/lib/
// integration-health.js's own header for the full why. Always exits 0: a
// probe failure is recorded honestly in the written file, never treated
// as a reason to fail this step or the run it's part of — this is a
// status check, not a gate, same non-blocking posture
// --refresh-local-source-evidence already has for its own candidate log.
async function runCheckIntegrations() {
  const health = await checkIntegrationHealth();
  const filePath = writeIntegrationHealth(health);
  const describe = (name, result) => (result.configured ? (result.ok ? `${name} OK` : `${name} ERROR: ${result.reason}`) : `${name} not configured`);
  console.log(`Integration health check: ${describe("GSC", health.gsc)}; ${describe("GA4", health.ga4)}. Written to ${filePath}.`);
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

  if (args.includes("--refresh-lead-event-evidence")) {
    await runRefreshLeadEventEvidence();
    return;
  }

  if (args.includes("--refresh-local-source-evidence")) {
    await runRefreshLocalSourceEvidence();
    return;
  }

  if (args.includes("--check-integrations")) {
    await runCheckIntegrations();
    return;
  }

  const executeProposalId = parseExecuteProposalArg(args);
  if (executeProposalId) {
    await runExecuteProposal(executeProposalId, { requestedBy: process.env.EXECUTE_REQUESTED_BY || null });
    return;
  }

  if (args.includes("--run-synthesis")) {
    runRunSynthesis();
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

  const fetchLocalSourceStrictId = parseFetchLocalSourceStrictArg(args);
  if (fetchLocalSourceStrictId) {
    await runFetchLocalSource(fetchLocalSourceStrictId, { strict: true });
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
  runFetchLocalSource,
  parseFetchLocalSourceStrictArg,
  runRefreshLocalSourceEvidence,
  runRefreshLeadEventEvidence,
  runRunSynthesis,
  runCheckIntegrations,
  parseExecuteProposalArg,
  runExecuteProposal,
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
