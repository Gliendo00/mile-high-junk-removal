// Site Improvement Agent, Phase 14 — the execution engine behind the
// Approved / Pending Execution queue.
//
// Approving a proposal (api/admin/bookings.js's existing
// resource:"agent-proposal" action:"approve") has never done anything
// beyond recording a decision — see agent-proposals.js's own UI copy and
// agent/README.md. This module is the thing that finally DOES the
// approved change, and it runs ONLY as `node agent/cli.js
// --execute-proposal=<id>` inside the GitHub Actions workflow
// `.github/workflows/execute-proposal.yml` (dispatched by
// api/admin/bookings.js's resource:"agent-proposal" action:"execute") —
// never inside the Vercel function that serves the admin dashboard,
// which has a read-only filesystem and cannot commit to git (see
// agent/README.md §13's own Vercel-vs-GitHub-Actions comparison table).
//
// What "execute" means here is deliberately narrow: this engine can only
// ever apply a finding's own `.autoFix` — the SAME deterministic
// {kind, file, from, to} description the Phase 1/2 auto-apply whitelist
// already uses (agent/lib/apply/rewrite-href.js is still the only
// implemented `kind`). It never writes prose, never generates content,
// never guesses what "the approved change" was — if a proposal has no
// `proposed_fix` (every real finding type today — see proposals-sync.js's
// own header on why no current PROPOSE_CHANGE finding carries one), this
// refuses with `needs_review` rather than inventing one.
//
// Lifecycle (status column on the agent_proposals row, read by the
// dashboard in near-real-time): approved -> applying -> validating ->
// deploying -> deployed, or any step may instead end at `failed` (ran,
// did not succeed — reverted, nothing pushed) or `needs_review` (refused
// to even attempt the change — reverted/untouched, a human must look at
// it again).
//
// The `approved` -> `applying` transition itself happens in
// api/admin/bookings.js's dashboard Execute action — a CONDITIONAL
// update (`.eq("status", "approved")`), synchronously, BEFORE that
// endpoint ever dispatches the GitHub Actions workflow that runs this
// module. By the time executeProposal() below runs, the row is always
// already "applying" — this module's own atomic step is therefore a
// SECOND claim, re-confirming (via the row's own execution metadata,
// never `status` alone) that it's looking at that SAME legitimate claim
// before recording that THIS run is the one that actually started
// (`execution.startedAt`). Together these two claims are what make a
// second concurrent/duplicate Execute click a no-op (requirement: never
// apply the same approved change twice) and make a rejected proposal
// structurally unexecutable (its status is never "approved", so the
// dashboard's own claim never succeeds for it in the first place).
//
// (First real Phase 14 execution, proposal 0945f338-...: the original
// version of this module re-attempted the dashboard's OWN
// approved -> applying claim here, which could never match — the row
// was already "applying" by the time this ran — so every real
// dispatched execution failed immediately with "not currently
// approved". Fixed by having this module instead verify and re-claim
// the EXISTING "applying" claim, as described above.)
//
// Every stage after the claim re-validates from scratch rather than
// trusting what was true when the proposal was approved:
//   1. the finding this proposal was about must still exist, still need
//      owner review, and have the IDENTICAL review fingerprint
//      (decision/summary/evidence/research/fix — see proposals-sync.js's
//      computeReviewContentFingerprint()) as what was approved. Any
//      drift -> needs_review, never a guess.
//   2. the exact literal text named by the fix must still appear exactly
//      once in the target file (rewrite-href.js's own existing
//      single-occurrence safety) -> needs_review if not.
//   3. after applying, a fresh re-scan must show the original finding
//      resolved and no same-type regression on the same page -> failed
//      (and reverted) if not.
//   4. the full test suite (`npm test`) must introduce NO NEW failing
//      test file relative to a baseline measured on this SAME checkout
//      immediately before applying the change (see diffNewFailures()
//      below) -> failed (and reverted) if it does. Deliberately NOT "the
//      full suite must be 100% green" — this repo can carry pre-
//      existing, unrelated failures (env/DB-dependent, nothing to do
//      with any one proposal) that would otherwise block EVERY
//      execution outright regardless of whether the proposal's own
//      change broke anything (exactly what happened to proposal
//      6ad71748-...). A previously-failing file that now passes is
//      fine; a file that starts failing ONLY after the apply still
//      blocks deployment exactly as strictly as before.
// Only after all four hold does this commit and push to `main`.

const { execFileSync } = require("child_process");
const config = require("../config");
const { getServiceClient } = require("../../api/_lib/supabase-admin");
const runner = require("../runner");
const { needsOwnerReview, computeReviewContentFingerprint } = require("./proposals-sync");
const rewriteHref = require("./apply/rewrite-href");

const SUPPORTED_FIX_KINDS = ["rewrite-href"];
const MAX_STORED_OUTPUT = 4000;

function truncate(text, max = MAX_STORED_OUTPUT) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
}

// Minimal execution logging (hotfix, proposal 6ad71748-...: the second
// real execution attempt was cancelled by GitHub Actions' own job-level
// timeout with no visibility at all into WHERE it was stuck — see
// RUN_TESTS_TIMEOUT_MS's own header). Plain console.log/console.error
// lines, visible directly in the GitHub Actions step log for
// `node agent/cli.js --execute-proposal=...` — deliberately just phase
// name + timing + pass/fail counts, NEVER the full npm test output
// (that's already captured separately, truncated, in the DB's
// execution.testResult.summary) and NEVER anything secret-shaped (no
// env vars, no credentials — there is nothing secret to log here in
// the first place).
function logPhase(message) {
  console.log(`[execute-proposal] ${message}`);
}

// Wraps one `runTests()` call with start/complete-or-timeout logging.
// `label` names the phase ("Baseline test suite" / "Post-apply test
// suite") so a timeout's log line says exactly WHICH of the two runs
// got stuck, rather than leaving that to be inferred from step timing
// alone.
function runTimedTestPhase(label, runTests) {
  logPhase(`${label}: starting…`);
  const start = Date.now();
  const result = runTests();
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
  if (result && result.timedOut) {
    logPhase(`${label}: TIMED OUT after ${elapsedS}s — treated as an untrustworthy/failed run (see RUN_TESTS_TIMEOUT_MS).`);
  } else {
    const failedCount = Array.isArray(result && result.failedFiles) ? result.failedFiles.length : "unknown";
    logPhase(`${label}: completed in ${elapsedS}s (passed: ${result && result.passed}, failedFiles: ${failedCount}).`);
  }
  return result;
}

// The real implementation — shells out to the actual `git` binary
// against the real repo checkout. Tests inject `options.git` (a plain
// function with this same signature) instead, so executeProposal()'s
// own control flow (claim -> validate -> apply -> re-validate -> test ->
// commit -> push -> mark deployed/failed/needs_review) can be exercised
// without a real git repo, matching validate.js's existing
// `rescanFn`-injection precedent (see validateAndRevertIfNeeded()).
function realGit(args) {
  return execFileSync("git", args, { cwd: config.SITE_ROOT, encoding: "utf8" });
}

async function loadProposal(client, id) {
  const { data, error } = await client.from("agent_proposals").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateProposal(client, id, fields) {
  const { data, error } = await client
    .from("agent_proposals")
    .update({ updated_at: new Date().toISOString(), ...fields })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

// The atomic "claim" — only succeeds if the row is STILL in `fromStatus`
// (and, when given, still matches every `extraEq` column/value pair) at
// the moment of the write (a real `WHERE status = fromStatus AND ...`
// on the UPDATE, not a read-then-write race). Returns null (never
// throws) when nothing matched, which the caller treats as "already
// claimed/moved by something else" — this is what makes double-
// execution structurally impossible rather than merely discouraged.
//
// `fromStatus` and `toStatus` may be the same value — see
// executeProposal()'s own "start" claim below, which re-claims a row
// that's already "applying" (optimistically locked via `extraEq`'s
// `updated_at` check instead of a status change) rather than moving it
// to a new status.
async function claim(client, id, fromStatus, toStatus, extra = {}, extraEq = {}) {
  let query = client
    .from("agent_proposals")
    .update({ status: toStatus, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id)
    .eq("status", fromStatus);
  for (const [col, val] of Object.entries(extraEq)) {
    query = query.eq(col, val);
  }
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error;
  return data;
}

// Builds the same shape computeReviewContentFingerprint() expects from a
// live finding, out of a DB row's snake_case columns — exactly how
// proposals-sync.js itself already does when comparing an existing row
// to a fresh finding (see that file's syncProposals()).
function proposalAsFindingShape(row) {
  return {
    decision: row.decision,
    summary: row.summary,
    evidence: row.evidence,
    research: row.research,
    autoFix: row.proposed_fix,
  };
}

function markNeedsReview(client, id, execution, reason) {
  return updateProposal(client, id, {
    status: "needs_review",
    execution: { ...execution, finishedAt: new Date().toISOString(), failureReason: reason },
  });
}

function markFailed(client, id, execution, reason, extra = {}) {
  return updateProposal(client, id, {
    status: "failed",
    execution: { ...execution, finishedAt: new Date().toISOString(), failureReason: reason, ...extra },
  });
}

// Reverts a tracked file back to HEAD's content — used only AFTER
// rewriteHref.apply() has written it and BEFORE anything is staged/
// committed, so this is always a precise, byte-exact undo (git restores
// from the index/HEAD, not a second guessed rewrite).
function revertFile(git, file) {
  git(["checkout", "--", file]);
}

/**
 * @param {string} id - agent_proposals row id
 * @param {object} [options]
 * @param {object} [options.client] - inject a fake Supabase client for tests
 * @param {string} [options.requestedBy] - UNUSED on the normal dispatched
 *   path as of the state-machine hotfix above: the admin email that
 *   clicked Execute is now read from the row's own, already-stored
 *   `execution.requestedBy` (set by api/admin/bookings.js's claim), not
 *   from this option, since that's the SAME claim this function
 *   re-confirms rather than re-creates. Still accepted (and still
 *   passed by agent/cli.js from EXECUTE_REQUESTED_BY) for backward
 *   compatibility, but has no effect once a row already carries a
 *   `requestedAt` — see the "stale or invalid row" check below for the
 *   one case (no prior claim at all) where it would matter, which the
 *   normal dispatched path never produces.
 * @param {Function} [options.runTests] - inject a fake test runner for tests;
 *   defaults to `npm test` via execFileSync
 * @param {Function} [options.gatherFindings] - inject a fake scan for tests;
 *   defaults to runner.js's real gatherFindings()
 * @param {Function} [options.isWorkingTreeClean] - inject a fake check for
 *   tests; defaults to runner.js's real isWorkingTreeClean()
 * @param {Function} [options.git] - inject a fake `(args:string[]) => string`
 *   for tests instead of shelling out to the real `git` binary
 */
async function executeProposal(id, options = {}) {
  const client = options.client || getServiceClient();
  const gatherFindings = options.gatherFindings || runner.gatherFindings;
  const isWorkingTreeClean = options.isWorkingTreeClean || runner.isWorkingTreeClean;
  const git = options.git || realGit;
  if (!client) {
    return { ok: false, reason: "Supabase not configured — cannot load or update the proposal." };
  }

  const proposal = await loadProposal(client, id);
  if (!proposal) {
    return { ok: false, reason: `No proposal with id "${id}".` };
  }
  if (proposal.status === "rejected") {
    return { ok: false, reason: "This proposal was rejected — rejected proposals can never be executed." };
  }

  // Hotfix (first real Phase 14 execution, proposal 0945f338-...) — by
  // the time this function runs, the row is ALREADY "applying":
  // api/admin/bookings.js's dashboard Execute action performs the
  // atomic approved -> applying claim itself, synchronously, before
  // ever dispatching the GitHub Actions workflow that calls this
  // function (see that endpoint's own header) — "approved" is never
  // the live status by the time a normally-dispatched run gets here.
  // The ORIGINAL code still tried to claim approved -> applying itself,
  // which could never match (the row was already "applying"), so every
  // real dispatched execution failed immediately with "not currently
  // approved" — exactly the bug this fixes.
  //
  // This function's job is therefore not to repeat the dashboard's
  // claim, but to verify the "applying" row in front of it really is
  // the SAME legitimate claim the dashboard made — via its own
  // execution metadata (requestedAt/startedAt), never by trusting
  // `status` alone — rather than an unrelated, stale, or
  // already-started one, then atomically record that THIS run is the
  // one that actually started (requirement: never apply the same
  // approved change twice, and never accept an arbitrary "applying"
  // row without validating it first).
  if (proposal.status !== "applying") {
    const reason = `Proposal is not currently in a freshly-claimed "applying" state (status: "${proposal.status}") — the dashboard's Execute action always claims a proposal atomically (approved -> applying) before dispatching this workflow, so a normally-dispatched run should always see "applying" here. Refusing to execute. This also prevents the same change from being applied twice.`;
    return { ok: false, reason };
  }
  const priorExecution = proposal.execution && typeof proposal.execution === "object" ? proposal.execution : {};
  if (!priorExecution.requestedAt) {
    const reason = `Proposal is "applying" but its execution record has no requestedAt — this does not look like a legitimate claim made by the dashboard's Execute action. Refusing to execute against what looks like a stale or invalid row.`;
    return { ok: false, reason };
  }
  if (priorExecution.startedAt) {
    const reason = `This proposal's execution already has a startedAt (${priorExecution.startedAt}) — a previous execution attempt already started against this exact claim. Refusing to execute again to prevent the same change being applied twice.`;
    return { ok: false, reason };
  }

  const execution = { ...priorExecution, startedAt: new Date().toISOString() };

  // The atomic "start" claim — a self-transition ("applying" ->
  // "applying"; the status itself never needs to change here, only
  // `execution.startedAt`) additionally guarded by `updated_at` still
  // matching the exact value just read in loadProposal() above
  // (optimistic concurrency control): if anything else wrote to this
  // row in between — most plausibly a second, genuinely concurrent
  // execution attempt against this exact claim, e.g. someone manually
  // re-running the same workflow dispatch — that write already moved
  // `updated_at` forward, so THIS update matches zero rows here and is
  // refused, the same way claim()'s `.eq("status", fromStatus)` guard
  // already prevents double-claiming everywhere else in this module.
  // In practice .github/workflows/execute-proposal.yml's own
  // concurrency group additionally serializes every dispatched run
  // repo-wide, so this is defense in depth, not the only thing
  // standing between here and a double-apply.
  const claimed = await claim(client, id, "applying", "applying", { execution }, { updated_at: proposal.updated_at });
  if (!claimed) {
    const reason = `Could not record that execution started — this proposal's row changed between being loaded and this run's own "start" claim (most likely a concurrent execution attempt against the same claim). Refusing to execute to prevent the same change being applied twice.`;
    return { ok: false, reason };
  }

  try {
    const fix = claimed.proposed_fix;
    if (!fix || !SUPPORTED_FIX_KINDS.includes(fix.kind)) {
      const reason = `No supported deterministic fix is recorded for this proposal (kind: ${fix && fix.kind ? fix.kind : "none"}) — this change requires manual implementation and cannot be auto-executed.`;
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }

    if (!isWorkingTreeClean()) {
      const reason = "The working tree is not clean before execution started — refusing to apply changes onto an unknown diff.";
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }

    // --- Freshness check: does the live site still match what was approved? ---
    const { findings: currentFindings } = gatherFindings();
    const fresh = currentFindings.find((f) => f.key === claimed.finding_key);
    if (!fresh || !needsOwnerReview(fresh)) {
      const reason = `The underlying finding ("${claimed.finding_key}") no longer needs owner review as of the latest scan (${fresh ? `now decided ${fresh.decision}` : "no longer appears at all"}) — the approved proposal may no longer be safe to apply as-is.`;
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }
    const freshFingerprint = computeReviewContentFingerprint(fresh);
    const approvedFingerprint = computeReviewContentFingerprint(proposalAsFindingShape(claimed));
    if (freshFingerprint !== approvedFingerprint) {
      const reason = "The site has changed since this proposal was approved (its evidence, summary, decision, or fix no longer match the latest scan) — refusing to guess; this needs re-review and re-approval.";
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }

    // --- Baseline test run (hotfix, proposal 6ad71748-...) — captured on
    // THIS clean, still-unapplied checkout, before rewriteHref.apply()
    // below touches anything. This repo currently carries pre-existing,
    // unrelated test failures (env/DB-dependent, nothing to do with any
    // one proposal); `npm test` returning non-zero for those alone used
    // to fail EVERY execution outright, regardless of whether the
    // proposal's own change broke anything. See the after-apply
    // comparison further down for how this baseline is actually used —
    // never as a static ignorelist (which would risk silently masking a
    // real regression if the baseline ever drifted stale), but measured
    // fresh, in this same run, every time.
    const runTests = options.runTests || defaultRunTests;
    const baselineTestResult = runTimedTestPhase("Baseline test suite", runTests);

    // --- Post-baseline cleanliness re-check (hotfix, proposal 6ad71748-...,
    // second diagnosis pass) — the earlier isWorkingTreeClean() check
    // above only proves the checkout was clean BEFORE the baseline test
    // run started. Some tests under tests/*.test.js temporarily rename
    // real, git-tracked files aside for the duration of one test and
    // restore them afterward (e.g. agent-runner-resume.test.js's
    // withResearchResultsCleared()) — a real, now-fixed CI-only bug
    // where a SIGTERM-killed slow test file left that restoration
    // incomplete, permanently stranding real repo files and corrupting
    // every later comparison against this checkout. The test suite's
    // own crash-safety is now hardened against exactly that, but this
    // check is the orchestrator's own backstop: if baseline testing
    // leaves ANY unexpected diff behind — from this or any future test,
    // known or not — the checkout this run is about to apply the fix
    // onto, and about to compare the post-apply suite against, is no
    // longer the trustworthy starting point the whole baseline-aware
    // gate assumes. Abort here, before ever touching the proposal's
    // file, rather than risk either a false regression (a test now
    // fails only because of leftover baseline pollution, not this
    // proposal's change) or a false pass. Nothing has been applied yet,
    // so there is nothing to revert — this fails exactly like the
    // earlier working-tree check, never weakening it.
    if (!isWorkingTreeClean()) {
      const reason = "The working tree is no longer clean after the baseline test run (something under tests/ mutated real, git-tracked files during testing and did not fully restore them) — refusing to apply the proposal onto an untrustworthy baseline. Nothing applied.";
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }

    // --- Apply (single-occurrence-safe — rewrite-href.apply() refuses otherwise) ---
    logPhase(`Applying proposed fix to ${fix.file}…`);
    const applyResult = rewriteHref.apply(fix);
    if (!applyResult.changed) {
      const reason = `Could not apply the approved fix: ${applyResult.reason}`;
      await markNeedsReview(client, id, execution, reason);
      return { ok: false, status: "needs_review", reason };
    }

    await updateProposal(client, id, { status: "validating", execution: { ...execution, appliedAt: new Date().toISOString() } });

    // --- Re-scan: confirm the original issue is actually resolved, and ---
    // --- no same-type regression appeared on the same page.            ---
    const { findings: rescanned } = gatherFindings();
    const stillPresent = rescanned.find((f) => f.key === claimed.finding_key);
    const resolved = !stillPresent || !needsOwnerReview(stillPresent);
    const regression = rescanned.some(
      (f) => f.type === fresh.type && f.pages.includes(fix.file) && JSON.stringify(f.evidence).includes(JSON.stringify(fix.to))
    );

    if (!resolved || regression) {
      revertFile(git, fix.file);
      const reason = !resolved
        ? `Re-scan after applying the fix still shows the original finding ("${claimed.finding_key}") needing review — the fix did not resolve it as expected. Reverted.`
        : `Re-scan after applying the fix shows a new "${fresh.type}" issue on ${fix.file} referencing the replacement value — likely regression. Reverted.`;
      await markFailed(client, id, execution, reason, { validation: { status: "regression-or-not-resolved" } });
      return { ok: false, status: "failed", reason };
    }

    // --- Run the test suite again, AFTER the change, and gate on NEW ---
    // --- failures only — never on the pre-existing baseline above.   ---
    // A file that was already failing before this proposal was applied
    // (the baseline) is never blamed on it; a file that starts failing
    // ONLY after the apply IS blamed on it, exactly as strictly as
    // before. A previously-failing file that now passes is fine — never
    // treated as a problem. Identity is preserved at the same file-level
    // granularity scripts/run-tests.js already reports at (this repo has
    // no finer-grained, per-assertion test identity to compare).
    const testResult = runTimedTestPhase("Post-apply test suite", runTests);
    const newFailures = diffNewFailures(baselineTestResult, testResult);
    const testsPassed = newFailures === null ? testResult.passed : newFailures.length === 0;
    if (!testsPassed) {
      revertFile(git, fix.file);
      const reason = newFailures && newFailures.length
        ? `New test failures introduced by this change (not present on the baseline measured before applying it): ${newFailures.join(", ")} — reverted, nothing committed or pushed.`
        : "Automated tests failed after applying the change — reverted, nothing committed or pushed.";
      await markFailed(client, id, execution, reason, {
        validation: { status: "confirmed-resolved" },
        testResult: {
          passed: false,
          summary: truncate(testResult.summary),
          baselineFailedFiles: baselineTestResult.failedFiles || null,
          newFailures: newFailures || null,
        },
      });
      return { ok: false, status: "failed", reason };
    }

    await updateProposal(client, id, {
      status: "deploying",
      execution: {
        ...execution,
        appliedAt: new Date().toISOString(),
        validation: { status: "confirmed-resolved" },
        testResult: {
          passed: true,
          summary: truncate(testResult.summary),
          baselineFailedFiles: baselineTestResult.failedFiles || null,
        },
      },
    });

    // --- Commit + push. Only now is anything persisted to git. ---
    const message = `Execute approved proposal: ${claimed.finding_type} (${claimed.finding_key})\n\n${claimed.summary}\n\nProposal: ${id}\nFinding key: ${claimed.finding_key}`;
    git(["add", "--", fix.file]);
    git(["commit", "-m", message]);
    const commitSha = git(["rev-parse", "HEAD"]).trim();

    try {
      git(["push", "origin", "HEAD:main"]);
    } catch (e) {
      const reason = `git push to main failed: ${e && e.message ? e.message : String(e)}. A local commit (${commitSha}) exists in this ephemeral checkout but nothing was deployed.`;
      await markFailed(client, id, execution, reason, { commitSha, filesChanged: [fix.file] });
      return { ok: false, status: "failed", reason, commitSha };
    }

    const finalExecution = {
      ...execution,
      appliedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      validation: { status: "confirmed-resolved" },
      testResult: { passed: true, summary: truncate(testResult.summary), baselineFailedFiles: baselineTestResult.failedFiles || null },
      commitSha,
      filesChanged: [fix.file],
      note: "Pushed to main — Vercel's existing GitHub integration deployment was triggered by this push.",
    };
    await updateProposal(client, id, { status: "deployed", execution: finalExecution });
    return { ok: true, status: "deployed", commitSha, filesChanged: [fix.file] };
  } catch (err) {
    // Any unexpected failure (a git/npm error we didn't anticipate, a
    // Supabase write failing mid-sequence, etc.) must still leave the
    // proposal in an honest, non-"applying"-forever state — never a
    // silent crash with the row stuck claimed.
    const reason = `Execution failed unexpectedly: ${err && err.message ? err.message : String(err)}`;
    try {
      await markFailed(client, id, execution, reason);
    } catch (e2) {
      // Even the failure-recording write failed — nothing more this
      // function can safely do; the caller's own non-zero exit code is
      // the last line of defense.
    }
    return { ok: false, status: "failed", reason };
  }
}

// scripts/run-tests.js's own main() ALWAYS prints "N/M test files
// passed." — success or failure — immediately before an optional
// "Failed: file1, file2, ..." line. The "N/M..." line is the one
// unambiguous signal that the test runner itself actually ran to
// completion, as opposed to npm/node crashing before run-tests.js ever
// got that far (npm itself failing to launch, a missing dependency, a
// syntax error, etc.). Hardening found during this hotfix's own
// verification: on at least one real machine, `execFileSync("npm", ...)`
// can fail to spawn npm at all and throw with EMPTY stdout/stderr —
// without this check, that would parse as `failedFiles: []` ("zero
// failures") on BOTH the baseline and after-apply calls, and
// diffNewFailures() below would see `[] vs []` and call it "no new
// failures" — silently treating "the test runner never actually ran,
// twice" as "safe to deploy," which is the opposite of what a test
// gate is for. Returns `null` whenever that marker line is missing, so
// defaultRunTests() can report "untrusted" (no failedFiles at all)
// rather than a misleadingly-empty list.
function testRunnerActuallyRan(summaryText) {
  return /\d+\/\d+ test files passed\./.test(summaryText || "");
}

// scripts/run-tests.js prints exactly one "Failed: file1, file2, ..."
// line (see that script's own main()) whenever anything failed, and
// nothing matching that shape otherwise — this is the one stable,
// already-existing, machine-parseable fact in its output, at exactly
// the file-level granularity that script's own per-file process
// isolation actually provides. Returns [] when every file genuinely
// passed (the runner ran to completion, no "Failed:" line), or `null`
// when the runner's own completion marker is missing entirely — see
// testRunnerActuallyRan() above for why that distinction has to exist.
function parseFailedFiles(summaryText) {
  if (!testRunnerActuallyRan(summaryText)) return null;
  const match = /^Failed: (.+)$/m.exec(summaryText || "");
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Process-lifecycle hardening (proposal 6ad71748-..., second real
// execution attempt: the GitHub Actions step itself was cancelled —
// "Error: The operation was canceled." — with the post-job cleanup
// reporting a large number of orphaned npm test/sh/Node processes).
// .github/workflows/execute-proposal.yml's job has `timeout-minutes:
// 20` and no step-level timeout of its own — that message is GitHub
// Actions' standard wording for a job-level timeout (concurrency's
// `cancel-in-progress: false` rules out a concurrency-triggered
// cancellation; see that workflow's own comment). Running the suite
// TWICE (the baseline-aware gate's own, deliberate behavior) measures
// at ~65s per full run locally — comfortably within budget even
// doubled — so a HANG somewhere inside one of the two `npm test`
// invocations (rather than the doubling itself) is the far more likely
// explanation for consuming the entire 20-minute ceiling and leaving
// an accumulated pile of still-running descendants for the runner to
// clean up. Without a bound, `execFileSync` here waits indefinitely —
// an external SIGKILL from the job timeout is the ONLY thing that was
// ever going to stop it, and that's a forced kill of the whole process
// GROUP, not a clean per-process exit, which is consistent with
// "orphaned" descendants needing cleanup rather than a graceful one.
//
// A bounded `timeout` turns an indefinite hang into a clean, fast,
// CORRECTLY-GATED failure instead: `execFileSync` sends `killSignal`
// to the child once this elapses, throws, and the catch branch below
// already handles that exactly like any other crash — a killed run
// almost certainly never printed run-tests.js's own "N/M test files
// passed." completion marker, so parseFailedFiles() already (as of the
// prior hotfix) returns `null` rather than `[]`, and the baseline-aware
// gate already treats that as untrustworthy and fails closed. This is
// defense in depth, not a new safety mechanism — it does not change
// what counts as a failure, only how long a single run is allowed to
// hang before being treated as one.
//
// 6 minutes is deliberately generous — this repo's real local full-
// suite runtime is ~65s, and a CI runner that's several times slower
// still has ample headroom under it — while still leaving comfortable
// room for the OTHER run (baseline or after-apply, whichever ran
// first) plus checkout/npm ci/git steps inside the job's own 20-minute
// ceiling, even in the worst case where both runs each take the full
// allowance.
const RUN_TESTS_TIMEOUT_MS = 6 * 60 * 1000;

// `timeoutMs` is a parameter (defaulting to the real constant above)
// purely so tests can prove the actual kill mechanism works end-to-end
// against the real `npm test` — without needing to wait out the real
// 6-minute allowance (see tests/agent-execute-proposal.test.js's own
// "process-lifecycle hardening" test).
function defaultRunTests(timeoutMs = RUN_TESTS_TIMEOUT_MS) {
  try {
    const output = execFileSync("npm", ["test"], {
      cwd: config.SITE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    return { passed: true, summary: output, failedFiles: [] };
  } catch (e) {
    const summary = `${e && e.stdout ? e.stdout : ""}\n${e && e.stderr ? e.stderr : ""}`;
    // parseFailedFiles() correctly returns `null` here (not []) when
    // npm/node errored — or was killed for running past `timeoutMs`
    // above — before run-tests.js could even print its own completion
    // marker. diffNewFailures() then falls back to the plain `.passed`
    // flag (false), so a test infrastructure failure OR a timeout on
    // EITHER run still blocks deployment, rather than ever being
    // silently excused as "probably baseline."
    // Node's execFileSync does NOT reliably set `error.killed` for a
    // timeout kill (confirmed empirically while building this fix:
    // `error.killed` is `undefined` even though the child genuinely
    // was killed) — `error.code === "ETIMEDOUT"` is the actual,
    // reliable signal, alongside `error.signal` naming which signal
    // was sent. Exposed as a dedicated `timedOut` boolean (not just
    // folded into the free-text `summary` string) so a caller like
    // runTimedTestPhase() below can log/branch on it reliably, without
    // needing to regex-match human-readable text that could drift.
    const timedOut = Boolean(e && e.code === "ETIMEDOUT");
    const reason = timedOut ? ` (killed: timed out after ${Math.round(timeoutMs / 1000)}s, signal ${e.signal || "?"})` : "";
    return { passed: false, summary: summary + reason, failedFiles: parseFailedFiles(summary), timedOut };
  }
}

// Baseline-aware test gate (hotfix, proposal 6ad71748-...) — compares
// the AFTER-apply run's failing files against the BEFORE-apply
// baseline's, so a pre-existing, unrelated failure already on `main`
// can never be blamed on this one proposal, while a file that starts
// failing ONLY after the apply still blocks deployment exactly as
// strictly as before. Returns `null` (not an array) when either side
// didn't carry a `failedFiles` list at all (e.g. a test's injected
// `options.runTests` double that only returns the simpler
// `{passed, summary}` shape pre-dating this hotfix) — the caller then
// falls back to the plain `.passed` flag, so every existing test that
// never opted into baseline-awareness keeps working unmodified.
function diffNewFailures(baselineResult, afterResult) {
  if (!Array.isArray(baselineResult.failedFiles) || !Array.isArray(afterResult.failedFiles)) {
    return null;
  }
  return afterResult.failedFiles.filter((f) => !baselineResult.failedFiles.includes(f));
}

module.exports = { executeProposal, proposalAsFindingShape, SUPPORTED_FIX_KINDS, parseFailedFiles, diffNewFailures, defaultRunTests, RUN_TESTS_TIMEOUT_MS };
