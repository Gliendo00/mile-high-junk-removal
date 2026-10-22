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
// it again). The `approved` -> `applying` transition is a CONDITIONAL
// update (`.eq("status", "approved")`) — the atomic "claim" that makes a
// second concurrent/duplicate Execute click a no-op (requirement: never
// apply the same approved change twice) and that makes a rejected
// proposal structurally unexecutable (its status is never "approved").
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
//   4. the full test suite (`npm test`) must pass -> failed (and
//      reverted) if not.
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
// at the moment of the write (a real `WHERE status = fromStatus` on the
// UPDATE, not a read-then-write race). Returns null (never throws) when
// nothing matched, which the caller treats as "already claimed/moved by
// something else" — this is what makes double-execution structurally
// impossible rather than merely discouraged.
async function claim(client, id, fromStatus, toStatus, extra = {}) {
  const { data, error } = await client
    .from("agent_proposals")
    .update({ status: toStatus, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id)
    .eq("status", fromStatus)
    .select("*")
    .maybeSingle();
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
 * @param {string} [options.requestedBy] - the admin email that clicked Execute
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

  const execution = {
    requestedAt: new Date().toISOString(),
    requestedBy: options.requestedBy || null,
    startedAt: new Date().toISOString(),
  };

  // The atomic claim — also the single place double-execution is
  // prevented: a proposal already "applying"/"validating"/"deploying"/
  // "deployed"/"failed"/"needs_review" (or still merely "proposed") is
  // NOT "approved" right now, so this matches zero rows and the whole
  // run stops here, unchanged.
  const claimed = await claim(client, id, "approved", "applying", { execution });
  if (!claimed) {
    return {
      ok: false,
      reason: `Proposal is not currently "approved" (status: "${proposal.status}") — refusing to execute. This also prevents the same change from being applied twice.`,
    };
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

    // --- Apply (single-occurrence-safe — rewrite-href.apply() refuses otherwise) ---
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

    // --- Run the test suite — never push a change the suite doesn't pass. ---
    const runTests = options.runTests || defaultRunTests;
    const testResult = runTests();
    if (!testResult.passed) {
      revertFile(git, fix.file);
      const reason = "Automated tests failed after applying the change — reverted, nothing committed or pushed.";
      await markFailed(client, id, execution, reason, {
        validation: { status: "confirmed-resolved" },
        testResult: { passed: false, summary: truncate(testResult.summary) },
      });
      return { ok: false, status: "failed", reason };
    }

    await updateProposal(client, id, {
      status: "deploying",
      execution: {
        ...execution,
        appliedAt: new Date().toISOString(),
        validation: { status: "confirmed-resolved" },
        testResult: { passed: true, summary: truncate(testResult.summary) },
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
      testResult: { passed: true, summary: truncate(testResult.summary) },
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

function defaultRunTests() {
  try {
    const output = execFileSync("npm", ["test"], { cwd: config.SITE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 });
    return { passed: true, summary: output };
  } catch (e) {
    return { passed: false, summary: `${e && e.stdout ? e.stdout : ""}\n${e && e.stderr ? e.stderr : ""}` };
  }
}

module.exports = { executeProposal, proposalAsFindingShape, SUPPORTED_FIX_KINDS };
