#!/usr/bin/env node
// Website Agent — GitHub Actions unattended runner, Phase 7.
//
// Safe-persistence gate for committing the Agent's OWN git-tracked
// output back to `main` after an unattended `--daily`/`--weekly` run.
// This is deliberately a NARROW allowlist, not a general "commit
// whatever changed" helper — the brief's explicit requirement is that
// an unexpected website/application/source-file change (a bug in this
// workflow, a dependency touching the working tree, anything) must FAIL
// the run rather than silently get committed.
//
// With mutation disabled (this runner never passes --apply-safe — see
// the workflow's own comments), these are the ONLY files
// `node agent/cli.js --daily`/`--weekly`/`--refresh-rotation-evidence`
// ever writes:
//   - agent/history/log.ndjson                      (every run, appended)
//   - agent/history/research-rotation-state.json    (weekly runs only)
//   - agent/research/firstparty/*.json               (weekly runs only —
//     Phase 7B's --refresh-rotation-evidence step, run BEFORE --weekly;
//     see agent/lib/rotation-evidence.js's header. Each file is a
//     normalized, bounded Search Console evidence entry — never a raw
//     API response, never a credential — written by
//     firstparty-fetch.js's existing writeFirstPartyEvidence(), same as
//     an orchestrator's --fetch-firstparty already produced before this
//     phase; only WHEN it runs changed, not what it writes.)
//   - agent/research/local-sources/*.json            (Phase 10's manual
//     diagnostic dispatch only — node agent/cli.js
//     --fetch-local-source-strict=<id>; see agent/lib/local-source-
//     fetch.js's header. Each file is a normalized, bounded text
//     snippet from ONE human-curated/verified official page — never raw
//     HTML, never a credential, never a verdict.)
// All four are already git-tracked, append-only/small-diff JSON —
// exactly the "legitimate Agent artifacts" the brief describes. Nothing
// else is in the allowlist: not agent/research/results/ or
// agent/research/completed-jobs/ (written only by --refresh-completed-
// jobs/--resume, neither of which this runner invokes), not
// agent/context/local-source-registry.json or
// agent/context/business-profile.json (human-curated — the runner only
// ever READS either, never writes to them), and never any top-level
// *.html/sitemap.xml/robots.txt/vercel.json (the actual public site).
//
// Usage:
//   node .github/scripts/safe-commit.js "commit message"
// Exits non-zero (and commits nothing) if:
//   - any changed/untracked path is outside the allowlist, or
//   - any allowed file's new content matches a credential-leakage
//     pattern (private keys, refresh/client secrets, live API-key
//     shapes, etc.) — never printing the matched text itself.
// Exits 0 and does nothing (no commit) if nothing in the allowlist
// actually changed — a "no worthwhile change today" run is a normal,
// successful outcome, not an error.
// Before actually committing, UNCONDITIONALLY sets a repository-local
// Git author identity (ensureGitIdentity() below), then re-reads it
// back and refuses to proceed to `git commit` at all if it isn't
// actually valid (assertGitIdentityIsValid() below) — see
// AUTOMATION_IDENTITY's own comment for why this is unconditional, not
// an "only if missing" check.

const { execSync } = require("child_process");

// A fresh GitHub-hosted runner's checkout has NO Git author identity
// configured anywhere (no ~/.gitconfig — unlike a developer's own
// machine, which almost always has one; that's exactly why this gap
// went unnoticed until the first real Actions run: `git commit` fails
// outright with "Author identity unknown"/"empty ident name ... not
// allowed").
//
// An EARLIER version of this fix only set this identity conditionally
// ("only if nothing is already configured at any scope"). That logic
// was never actually proven wrong — investigation of the real failing
// run showed it was never even executed: GitHub Actions' "re-run jobs"
// re-executes a run against the SAME commit SHA it originally
// resolved, not the branch's current tip, so the run that appeared to
// "still fail after the fix" had in fact checked out the commit from
// BEFORE the fix existed. To remove any remaining doubt or scope-
// resolution subtlety, this is now UNCONDITIONAL: every commit this
// script makes is explicitly, locally stamped with this identity,
// immediately before `git commit` — never `--global`, never
// conditional on what might already be configured.
const AUTOMATION_IDENTITY = {
  name: "Mile High Website Agent",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

const ALLOWED_PATH_PATTERNS = [
  /^agent\/history\/log\.ndjson$/,
  /^agent\/history\/research-rotation-state\.json$/,
  // Phase 7B — narrowly scoped to exactly that one directory, one level
  // deep, .json only — never agent/research/** broadly (results/ and
  // completed-jobs/ stay OUT of this allowlist; see this file's header).
  /^agent\/research\/firstparty\/[^/]+\.json$/,
  // Phase 10 — same narrow treatment, one directory deep, .json only.
  // Deliberately does NOT include agent/context/local-source-
  // registry.json: the registry is human-curated and must never be
  // autonomously editable (see agent/lib/local-source-registry.js's
  // header) — only the EVIDENCE this diagnostic writes is allowlisted,
  // never the list of what it's allowed to fetch.
  /^agent\/research\/local-sources\/[^/]+\.json$/,
  // Phase 11B — the small, OVERWRITTEN-each-run log of which
  // geographically-relevant candidates --refresh-local-source-evidence
  // could not fetch this run (see agent/lib/local-source-candidate-
  // log.js's header). Same single-file treatment as
  // agent/history/research-rotation-state.json above — never a
  // directory pattern, never agent/context/** (the registry itself
  // stays excluded, unchanged).
  /^agent\/history\/local-source-candidate-log\.json$/,
];

// Deliberately pattern-based, not a secrets-scanning dependency — this
// repo adds no new dependencies for this (matches the agent's own
// existing no-SDK, plain-fetch philosophy). Each pattern targets a
// specific real credential SHAPE (a PEM header, a Google OAuth token
// prefix, a live Stripe key prefix, ...), not a generic high-entropy
// heuristic that would false-positive on the run log's own runIds.
const CREDENTIAL_LEAK_PATTERNS = [
  { name: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '"private_key" JSON field', pattern: /"private_key"\s*:/ },
  { name: '"refresh_token" field', pattern: /"refresh_token"\s*[:=]/i },
  { name: '"client_secret" field', pattern: /"client_secret"\s*[:=]/i },
  { name: "SUPABASE_SECRET_KEY value", pattern: /SUPABASE_SECRET_KEY\s*[:=]\s*\S/ },
  { name: "Google OAuth access-token shape", pattern: /\bya29\.[A-Za-z0-9_-]{20,}/ },
  { name: "Google API-key shape", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Stripe live-key shape", pattern: /\bsk_live_[0-9A-Za-z]{10,}/ },
  { name: "GitHub Actions OIDC/external_account credential shape", pattern: /"type"\s*:\s*"external_account"/ },
];

function isPathAllowed(p) {
  return ALLOWED_PATH_PATTERNS.some((re) => re.test(p));
}

// Parses `git status --porcelain=v1 -z`-free (plain, newline-delimited)
// output into [{status, path}]. Handles the one rename/copy shape
// (`R  old -> new`, `C  old -> new`) by keeping only the destination
// path — this script never needs the old name, only "what exists now."
function parsePorcelainStatus(output) {
  return output
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      let rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      const path = arrow !== -1 ? rest.slice(arrow + 4) : rest;
      return { status, path: path.replace(/^"(.*)"$/, "$1") };
    });
}

function classifyChangedPaths(entries) {
  const allowed = [];
  const disallowed = [];
  for (const e of entries) {
    if (isPathAllowed(e.path)) allowed.push(e);
    else disallowed.push(e);
  }
  return { allowed, disallowed };
}

function scanForCredentialLeak(text) {
  for (const { name, pattern } of CREDENTIAL_LEAK_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

// Reads a single git config key, at whatever scope git itself would
// resolve it from (local overrides global overrides system) — returns
// "" if unset at every scope, never throws.
function getGitConfigValue(key) {
  try {
    return execSync(`git config ${key}`, { encoding: "utf8" }).trim();
  } catch (e) {
    return "";
  }
}

// Unconditionally sets BOTH user.name and user.email as repository-
// local config (`git config --local`, never `--global`) — see this
// file's header comment on AUTOMATION_IDENTITY for why this is no
// longer a conditional "only if missing" check.
function ensureGitIdentity() {
  execSync(`git config --local user.name ${JSON.stringify(AUTOMATION_IDENTITY.name)}`);
  execSync(`git config --local user.email ${JSON.stringify(AUTOMATION_IDENTITY.email)}`);
}

// Re-reads the identity back, immediately before `git commit`, and
// throws (never a bare opaque `git commit` crash) if it is somehow
// still not valid — defense in depth: even if ensureGitIdentity() above
// were ever bypassed or ineffective for some reason this file's author
// didn't anticipate, THIS is the last checkpoint before a commit is
// attempted, so the failure mode is always this script's own clear
// error, never git's cryptic "empty ident name ... not allowed".
function assertGitIdentityIsValid() {
  const name = getGitConfigValue("user.name");
  const email = getGitConfigValue("user.email");
  if (!name || !email) {
    throw new Error(
      `safe-commit: Git identity is still invalid immediately before commit (user.name="${name}", user.email="${email}") — refusing to attempt "git commit".`
    );
  }
  return { name, email };
}

function main() {
  const fs = require("fs");
  const message = process.argv[2];
  if (!message) {
    console.error("Usage: node .github/scripts/safe-commit.js \"commit message\"");
    process.exitCode = 1;
    return;
  }

  const statusOutput = execSync("git status --porcelain=v1", { encoding: "utf8" });
  const entries = parsePorcelainStatus(statusOutput);

  if (entries.length === 0) {
    console.log("safe-commit: working tree is clean — nothing to commit.");
    return;
  }

  const { allowed, disallowed } = classifyChangedPaths(entries);

  if (disallowed.length > 0) {
    console.error("safe-commit: REFUSING to commit — unexpected path(s) changed outside the Agent-artifact allowlist:");
    for (const e of disallowed) console.error(`  ${e.status} ${e.path}`);
    console.error("Only agent/history/log.ndjson, agent/history/research-rotation-state.json, agent/research/firstparty/*.json, and agent/research/local-sources/*.json are ever expected to change from an unattended --daily/--weekly/diagnostic run. Investigate before re-running.");
    process.exitCode = 1;
    return;
  }

  if (allowed.length === 0) {
    console.log("safe-commit: nothing in the Agent-artifact allowlist changed — nothing to commit.");
    return;
  }

  for (const e of allowed) {
    let content;
    try {
      content = fs.readFileSync(e.path, "utf8");
    } catch (err) {
      console.error(`safe-commit: REFUSING to commit — could not read allowed path "${e.path}" to scan it: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
    const leak = scanForCredentialLeak(content);
    if (leak) {
      console.error(`safe-commit: REFUSING to commit — "${e.path}" matches a credential-leakage pattern (${leak}). Not printing the matched content. Investigate before re-running.`);
      process.exitCode = 1;
      return;
    }
  }

  ensureGitIdentity();
  try {
    assertGitIdentityIsValid();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const paths = allowed.map((e) => e.path);
  execSync(`git add -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`, { stdio: "inherit" });
  execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: "inherit" });
  console.log(`safe-commit: committed ${paths.length} Agent-artifact file(s): ${paths.join(", ")}`);
}

module.exports = {
  ALLOWED_PATH_PATTERNS,
  CREDENTIAL_LEAK_PATTERNS,
  AUTOMATION_IDENTITY,
  isPathAllowed,
  parsePorcelainStatus,
  classifyChangedPaths,
  scanForCredentialLeak,
  getGitConfigValue,
  ensureGitIdentity,
  assertGitIdentityIsValid,
};

if (require.main === module) {
  main();
}
