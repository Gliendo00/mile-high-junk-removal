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
// the workflow's own comments), the two files below are the ONLY ones
// `node agent/cli.js --daily`/`--weekly` ever writes:
//   - agent/history/log.ndjson              (every run, appended)
//   - agent/history/research-rotation-state.json   (weekly runs only)
// Both are already git-tracked, append-only/small-diff JSON — exactly
// the "legitimate Agent artifacts" the brief describes. Nothing else is
// in the allowlist: not agent/research/** (only written by
// --refresh-completed-jobs/--fetch-firstparty/--resume, none of which
// this runner invokes yet), and never any top-level *.html/sitemap.xml/
// robots.txt/vercel.json (the actual public site).
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
// Before actually committing, fills in a repository-local Git author
// identity (ensureGitIdentity() below) IF AND ONLY IF none is already
// configured at any scope — see AUTOMATION_IDENTITY above.

const { execSync } = require("child_process");

// A fresh GitHub-hosted runner's checkout has NO Git author identity
// configured anywhere (no ~/.gitconfig — unlike a developer's own
// machine, which almost always has one; that's exactly why this gap
// went unnoticed until the first real Actions run: `git commit` fails
// outright with "Author identity unknown"/"empty ident name ... not
// allowed"). ensureGitIdentity() below fills in ONLY the missing
// piece, as REPOSITORY-LOCAL config (`git config --local`, never
// `--global`) — a human or environment that already has user.name/
// user.email configured at any level is never overridden.
const AUTOMATION_IDENTITY = {
  name: "Mile High Website Agent",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

const ALLOWED_PATH_PATTERNS = [/^agent\/history\/log\.ndjson$/, /^agent\/history\/research-rotation-state\.json$/];

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

// Sets ONLY whichever of user.name/user.email isn't already configured
// at any scope, and ONLY as repository-local config — see this file's
// header comment on AUTOMATION_IDENTITY for why.
function ensureGitIdentity() {
  if (!getGitConfigValue("user.name")) {
    execSync(`git config --local user.name ${JSON.stringify(AUTOMATION_IDENTITY.name)}`);
  }
  if (!getGitConfigValue("user.email")) {
    execSync(`git config --local user.email ${JSON.stringify(AUTOMATION_IDENTITY.email)}`);
  }
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
    console.error("Only agent/history/log.ndjson and agent/history/research-rotation-state.json are ever expected to change from an unattended --daily/--weekly run. Investigate before re-running.");
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
};

if (require.main === module) {
  main();
}
