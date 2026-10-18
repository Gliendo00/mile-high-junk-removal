// Website Agent — GitHub Actions unattended runner, Phase 7.
//
// Tests for .github/scripts/safe-commit.js: the gate that decides
// whether an unattended --daily/--weekly run's working-tree changes are
// safe to commit back to `main`. Covers the brief's explicit
// invariants: only the two known Agent-artifact paths are ever
// committed, any other changed path fails the run instead of being
// silently committed, a credential-shaped string anywhere in an
// otherwise-allowed file also fails the run (without ever printing the
// matched secret text), and — the fix this file also covers — a
// completely fresh GitHub-hosted checkout with NO Git author identity
// configured anywhere can still reach a successful commit (the real
// first-production-run failure: "Author identity unknown"/"empty ident
// name ... not allowed").
//
// The first block tests the pure parsing/classification/scanning
// functions directly (no git, no subprocess). The second block is a
// real end-to-end check against a throwaway temp git repo, exercising
// the actual CLI entry point exactly as the GitHub Actions workflow
// invokes it — including, in the THIRD block, with the ambient Git
// identity fully isolated away (not just unset in the temp repo, but
// unreachable at the global/system scope too — see isolatedGitEnv()),
// so these tests fail honestly on a machine that happens to have its
// own global `user.name`/`user.email` configured, exactly as the
// ORIGINAL bug was masked by every developer machine (and this repo's
// own earlier test run) already having one.
//
// Run with:  node tests/github-actions-safe-commit.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  isPathAllowed,
  parsePorcelainStatus,
  classifyChangedPaths,
  scanForCredentialLeak,
  AUTOMATION_IDENTITY,
} = require("../.github/scripts/safe-commit");

const SCRIPT_PATH = path.join(__dirname, "..", ".github", "scripts", "safe-commit.js");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

function runGit(args, cwd, env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

function initTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-commit-test-"));
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Safe Commit Test"], dir);
  fs.mkdirSync(path.join(dir, "agent", "history"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "history", "log.ndjson"), "", "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  // Mirrors the REAL repo's state: agent/research/firstparty/ already
  // exists and is already git-tracked (it holds real Phase 6 evidence
  // today) — without a pre-existing tracked file here, git collapses a
  // brand-new file under an entirely-untracked directory into one
  // directory-level `?? agent/research/` porcelain line instead of the
  // individual file path, which would make a safe-commit test against
  // this fixture pass or fail for a reason that has nothing to do with
  // the real repo's actual behavior.
  fs.mkdirSync(path.join(dir, "agent", "research", "firstparty"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "research", "firstparty", "README.md"), "placeholder\n", "utf8");
  // Same reasoning as agent/research/firstparty/ immediately above,
  // applied to Phase 10's directory.
  fs.mkdirSync(path.join(dir, "agent", "research", "local-sources"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "research", "local-sources", "README.md"), "placeholder\n", "utf8");
  // Pre-acceptance hardening (audit finding #1) — same reasoning,
  // applied to the two directories --refresh-completed-jobs/
  // --run-synthesis now actually write to in this workflow. Both
  // already exist with a README.md in the real repo.
  fs.mkdirSync(path.join(dir, "agent", "research", "completed-jobs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "research", "completed-jobs", "README.md"), "placeholder\n", "utf8");
  fs.mkdirSync(path.join(dir, "agent", "research", "results"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "research", "results", "README.md"), "placeholder\n", "utf8");
  // Mirrors the REAL repo's state: agent/context/business-profile.json
  // already exists and is already tracked — so a test adding a NEW
  // file under agent/context/ (e.g. local-source-registry.json) reports
  // that individual path, same collapsing concern as above.
  fs.mkdirSync(path.join(dir, "agent", "context"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "context", "business-profile.json"), "{}\n", "utf8");
  runGit(["add", "-A"], dir);
  runGit(["commit", "-m", "initial"], dir);
  return dir;
}

function headSha(dir, env) {
  return runGit(["rev-parse", "HEAD"], dir, env).trim();
}

function runSafeCommit(dir, message, env) {
  try {
    execFileSync("node", [SCRIPT_PATH, message], { cwd: dir, env, encoding: "utf8" });
    return { status: 0 };
  } catch (e) {
    return { status: e.status, stderr: e.stderr ? e.stderr.toString() : "" };
  }
}

// Builds an env where Git has NO identity reachable at ANY scope —
// not local (a fresh `git init` has none), not global, not system.
// GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM (Git >= 2.32) are pointed at a
// genuinely empty file rather than merely unset, so this is immune to
// whatever the HOST machine's own ~/.gitconfig happens to contain —
// without this override, these tests would silently pass on any
// machine that already has a global identity (which is exactly how the
// real bug went unnoticed: every developer machine, and this repo's
// own test runs, already had one). HOME/USERPROFILE are also pointed
// at the throwaway dir so Git can't fall back to the real user profile
// on either platform.
function isolatedGitEnv(dir, extraGlobalConfig) {
  const globalConfigPath = path.join(dir, "isolated-global.gitconfig");
  const systemConfigPath = path.join(dir, "isolated-system.gitconfig");
  fs.writeFileSync(globalConfigPath, extraGlobalConfig || "", "utf8");
  fs.writeFileSync(systemConfigPath, "", "utf8");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath, GIT_CONFIG_SYSTEM: systemConfigPath, HOME: dir, USERPROFILE: dir };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  return env;
}

// Like initTempRepo(), but with NO identity visible at any scope (see
// isolatedGitEnv()) — simulating a fresh GitHub-hosted runner's
// checkout exactly. The repo's own pre-existing history obviously had
// SOME author at some point (as any real `actions/checkout` clone
// does) — a one-off `-c` override supplies that for this ONE fixture
// commit only, never persisted to any config file, so it proves
// nothing about whether safe-commit.js itself can supply an identity.
function initTempRepoNoIdentity(extraGlobalConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-commit-noid-test-"));
  const env = isolatedGitEnv(dir, extraGlobalConfig);
  runGit(["init", "--initial-branch=main"], dir, env);
  fs.mkdirSync(path.join(dir, "agent", "history"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "history", "log.ndjson"), "", "utf8");
  runGit(["-c", "user.name=Fixture Setup", "-c", "user.email=fixture@example.com", "add", "-A"], dir, env);
  runGit(["-c", "user.name=Fixture Setup", "-c", "user.email=fixture@example.com", "commit", "-m", "initial"], dir, env);
  return { dir, env };
}

async function main() {
  // --- pure function tests ---------------------------------------

  await test("isPathAllowed() allows the known Agent-artifact paths, including Phase 7B's agent/research/firstparty/*.json and Phase 10's agent/research/local-sources/*.json", () => {
    assert.strictEqual(isPathAllowed("agent/history/log.ndjson"), true);
    assert.strictEqual(isPathAllowed("agent/history/research-rotation-state.json"), true);
    assert.strictEqual(isPathAllowed("agent/research/firstparty/search-console-search-analytics__golden-1234567890.json"), true);
    assert.strictEqual(isPathAllowed("agent/research/local-sources/denvergov-org__leafdrop-pumpkin-composting-program-1234567890.json"), true);
  });

  await test("Pre-acceptance hardening (audit finding #1): isPathAllowed() allows agent/research/completed-jobs/*.json and agent/research/results/*.json now that this workflow actually invokes --refresh-completed-jobs/--run-synthesis, one level deep, .json only — same narrowing as every other pattern", () => {
    assert.strictEqual(isPathAllowed("agent/research/completed-jobs/latest-refresh.json"), true);
    assert.strictEqual(isPathAllowed("agent/research/results/content-gap__some-page-html__cross-source-synthesis-1234567890-ab12cd.json"), true);
    assert.strictEqual(isPathAllowed("agent/research/completed-jobs/nested/evidence.json"), false);
    assert.strictEqual(isPathAllowed("agent/research/completed-jobs/not-json.txt"), false);
    assert.strictEqual(isPathAllowed("agent/research/results/nested/evidence.json"), false);
    assert.strictEqual(isPathAllowed("agent/research/results/not-json.txt"), false);
  });

  await test("isPathAllowed() refuses any other Agent path, website source, or credential-like file — including sibling agent/research/ directories NOT in scope", () => {
    assert.strictEqual(isPathAllowed("agent/research/other-stuff/some-question.json"), false);
    assert.strictEqual(isPathAllowed("agent/history/.run.lock"), false);
    assert.strictEqual(isPathAllowed("index.html"), false);
    assert.strictEqual(isPathAllowed("vercel.json"), false);
    assert.strictEqual(isPathAllowed("gha-creds-abc123.json"), false);
    assert.strictEqual(isPathAllowed(".env"), false);
    // the allowlist is one level deep only — never a nested subdirectory
    assert.strictEqual(isPathAllowed("agent/research/firstparty/nested/evidence.json"), false);
    assert.strictEqual(isPathAllowed("agent/research/firstparty/not-json.txt"), false);
    assert.strictEqual(isPathAllowed("agent/research/local-sources/nested/evidence.json"), false);
    assert.strictEqual(isPathAllowed("agent/research/local-sources/not-json.txt"), false);
  });

  await test("isPathAllowed() REFUSES the human-curated local-source registry (and business-profile.json) — the runner may read either, but can never autonomously commit a change to what it's allowed to fetch", () => {
    assert.strictEqual(isPathAllowed("agent/context/local-source-registry.json"), false);
    assert.strictEqual(isPathAllowed("agent/context/business-profile.json"), false);
  });

  await test("Phase 11B: isPathAllowed() allows the single, overwritten agent/history/local-source-candidate-log.json file, but not a nested/renamed variant", () => {
    assert.strictEqual(isPathAllowed("agent/history/local-source-candidate-log.json"), true);
    assert.strictEqual(isPathAllowed("agent/history/local-source-candidate-log/extra.json"), false);
    assert.strictEqual(isPathAllowed("agent/history/local-source-candidate-log.json.bak"), false);
  });

  await test("parsePorcelainStatus() parses modified/untracked/renamed and quoted-path lines", () => {
    const output = [
      "M  agent/history/log.ndjson",
      "?? agent/research/new-file.json",
      'M  "path with space.json"',
      "R  old-name.txt -> new-name.txt",
    ].join("\n");
    const entries = parsePorcelainStatus(output);
    assert.deepStrictEqual(entries.map((e) => e.path), [
      "agent/history/log.ndjson",
      "agent/research/new-file.json",
      "path with space.json",
      "new-name.txt",
    ]);
  });

  await test("classifyChangedPaths() splits allowed vs disallowed correctly", () => {
    const entries = parsePorcelainStatus(["M  agent/history/log.ndjson", "M  index.html"].join("\n"));
    const { allowed, disallowed } = classifyChangedPaths(entries);
    assert.strictEqual(allowed.length, 1);
    assert.strictEqual(allowed[0].path, "agent/history/log.ndjson");
    assert.strictEqual(disallowed.length, 1);
    assert.strictEqual(disallowed[0].path, "index.html");
  });

  await test("scanForCredentialLeak() flags a PEM private key block", () => {
    assert.ok(scanForCredentialLeak("-----BEGIN PRIVATE KEY-----\nMIIB...\n-----END PRIVATE KEY-----"));
  });

  await test("scanForCredentialLeak() flags a refresh_token/client_secret JSON field", () => {
    assert.ok(scanForCredentialLeak('{"refresh_token": "abc"}'));
    assert.ok(scanForCredentialLeak('{"client_secret": "abc"}'));
  });

  await test("scanForCredentialLeak() flags a live SUPABASE_SECRET_KEY, Google OAuth token, Google API key, and Stripe live key", () => {
    assert.ok(scanForCredentialLeak("SUPABASE_SECRET_KEY=sb_secret_abcdef"));
    assert.ok(scanForCredentialLeak("token is ya29.a0ARrdaMabcdefghijklmnopqrstuvwxyz"));
    assert.ok(scanForCredentialLeak("key: AIzaSyA1234567890abcdefghijklmnopqrstuv"));
    assert.ok(scanForCredentialLeak("sk_live_51ABCDEFGHIJKLMNOP"));
  });

  await test("scanForCredentialLeak() flags a persisted external_account (WIF) credential file shape", () => {
    assert.ok(scanForCredentialLeak('{"type": "external_account", "audience": "..."}'));
  });

  await test("scanForCredentialLeak() returns null for ordinary Agent history/report content", () => {
    const sampleRecord = JSON.stringify({
      runId: "2026-10-14T04-00-00-000Z-ab12cd",
      sequence: 1,
      mode: "dry-run",
      runType: "daily",
      summary: { pagesScanned: 40, findingsTotal: 2 },
      report: { status: "completed", healthSummary: { text: "all clear" } },
    });
    assert.strictEqual(scanForCredentialLeak(sampleRecord), null);
  });

  // --- end-to-end CLI tests against a real temp git repo ---------

  await test("safe-commit CLI: commits ONLY an allowed Agent-artifact change", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r1" }) + "\n", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run r1");
      assert.strictEqual(result.status, 0);
      const after = headSha(dir);
      assert.notStrictEqual(after, before, "a new commit should have been created");
      assert.strictEqual(runGit(["status", "--porcelain"], dir).trim(), "", "working tree should be clean after commit");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: a clean working tree is a no-op (no commit created)", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      const result = runSafeCommit(dir, "should not be used");
      assert.strictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: REFUSES and commits nothing when a disallowed (website source) path also changed", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r2" }) + "\n", "utf8");
      fs.writeFileSync(path.join(dir, "index.html"), "<html>unexpected edit</html>", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run r2");
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before, "no commit should have been created");
      assert.ok(/index\.html/.test(result.stderr));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: REFUSES and commits nothing when an untracked (non-allowlisted) path appears", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r3" }) + "\n", "utf8");
      // agent/research/other-stuff/ is NOT one of the allowlisted
      // agent/research/** directories (see this file's header for the
      // exact, current list) — a genuinely unexpected path, unlike
      // agent/research/results/ and agent/research/completed-jobs/,
      // which the pre-acceptance hardening pass (audit finding #1) made
      // legitimately allowed once this workflow started invoking
      // --run-synthesis/--refresh-completed-jobs.
      fs.mkdirSync(path.join(dir, "agent", "research", "other-stuff"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "other-stuff", "q1.json"), "{}", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run r3");
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("Pre-acceptance hardening (audit finding #1): safe-commit CLI commits a new agent/research/completed-jobs/*.json snapshot (--refresh-completed-jobs output) alongside history", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r4" }) + "\n", "utf8");
      fs.mkdirSync(path.join(dir, "agent", "research", "completed-jobs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "completed-jobs", "latest-refresh.json"), "[]", "utf8");
      const result = runSafeCommit(dir, "chore(agent): weekly run r4");
      assert.strictEqual(result.status, 0);
      assert.notStrictEqual(headSha(dir), before);
      assert.strictEqual(runGit(["status", "--porcelain"], dir).trim(), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("Pre-acceptance hardening (audit finding #1): safe-commit CLI commits a new agent/research/results/*.json synthesis result (--run-synthesis output) alongside history", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r5" }) + "\n", "utf8");
      fs.mkdirSync(path.join(dir, "agent", "research", "results"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "results", "content-gap__page-html__cross-source-synthesis-1234567890-ab12cd.json"), "{}", "utf8");
      const result = runSafeCommit(dir, "chore(agent): weekly run r5");
      assert.strictEqual(result.status, 0);
      assert.notStrictEqual(headSha(dir), before);
      assert.strictEqual(runGit(["status", "--porcelain"], dir).trim(), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: REFUSES and commits nothing when an allowed file's new content matches a credential-leak pattern", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(
        path.join(dir, "agent", "history", "log.ndjson"),
        JSON.stringify({ runId: "r4", oops: "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----" }) + "\n",
        "utf8"
      );
      const result = runSafeCommit(dir, "chore(agent): daily run r4");
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before);
      assert.strictEqual(result.stderr.includes("BEGIN PRIVATE KEY"), false, "the matched secret text itself must never be printed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: commits BOTH allowed files when a weekly run touches history + rotation state together", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r5" }) + "\n", "utf8");
      fs.writeFileSync(path.join(dir, "agent", "history", "research-rotation-state.json"), JSON.stringify({ reviewed: {} }), "utf8");
      const result = runSafeCommit(dir, "chore(agent): weekly run r5");
      assert.strictEqual(result.status, 0);
      const after = headSha(dir);
      assert.notStrictEqual(after, before);
      const committedFiles = runGit(["show", "--name-only", "--pretty=format:", after], dir).trim().split("\n").filter(Boolean);
      assert.deepStrictEqual(committedFiles.sort(), ["agent/history/log.ndjson", "agent/history/research-rotation-state.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: commits a new agent/research/firstparty/*.json evidence file (Phase 7B's --refresh-rotation-evidence output) alongside history", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r6" }) + "\n", "utf8");
      fs.mkdirSync(path.join(dir, "agent", "research", "firstparty"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "agent", "research", "firstparty", "search-console-search-analytics__golden-123.json"),
        JSON.stringify([{ rotationSlug: "golden", source: "search-console-search-analytics", observed: { totalRowsReturned: 0 } }]),
        "utf8"
      );
      const result = runSafeCommit(dir, "chore(agent): weekly run r6");
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const after = headSha(dir);
      assert.notStrictEqual(after, before);
      const committedFiles = runGit(["show", "--name-only", "--pretty=format:", after], dir).trim().split("\n").filter(Boolean);
      assert.deepStrictEqual(committedFiles.sort(), ["agent/history/log.ndjson", "agent/research/firstparty/search-console-search-analytics__golden-123.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: commits a new agent/research/local-sources/*.json evidence file (Phase 10's --fetch-local-source-strict= output) alongside history", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r6b" }) + "\n", "utf8");
      fs.mkdirSync(path.join(dir, "agent", "research", "local-sources"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "agent", "research", "local-sources", "denvergov-org__leafdrop-pumpkin-composting-program-123.json"),
        JSON.stringify({ sourceUrl: "https://www.denvergov.org/x", sourceDomain: "denvergov.org", authorityClass: "official-government", extractedSnippet: "LeafDrop" }),
        "utf8"
      );
      const result = runSafeCommit(dir, "chore(agent): diagnostic-denver-leafdrop run r6b");
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const after = headSha(dir);
      assert.notStrictEqual(after, before);
      const committedFiles = runGit(["show", "--name-only", "--pretty=format:", after], dir).trim().split("\n").filter(Boolean);
      assert.deepStrictEqual(committedFiles.sort(), ["agent/history/log.ndjson", "agent/research/local-sources/denvergov-org__leafdrop-pumpkin-composting-program-123.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("Phase 11B: safe-commit CLI: commits a new/updated agent/history/local-source-candidate-log.json alongside history and evidence", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r11b" }) + "\n", "utf8");
      fs.writeFileSync(
        path.join(dir, "agent", "history", "local-source-candidate-log.json"),
        JSON.stringify({ at: "2026-10-16T00:00:00.000Z", workflowStartedAt: null, blockedOrFailed: [] }),
        "utf8"
      );
      const result = runSafeCommit(dir, "chore(agent): weekly run r11b");
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const after = headSha(dir);
      assert.notStrictEqual(after, before);
      const committedFiles = runGit(["show", "--name-only", "--pretty=format:", after], dir).trim().split("\n").filter(Boolean);
      assert.deepStrictEqual(committedFiles.sort(), ["agent/history/local-source-candidate-log.json", "agent/history/log.ndjson"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: REFUSES to commit when the local-source REGISTRY itself changed alongside valid evidence — the registry is human-curated and must never be autonomously committed, even bundled with an otherwise-legitimate evidence file", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.mkdirSync(path.join(dir, "agent", "research", "local-sources"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "local-sources", "denvergov-org__leafdrop-pumpkin-composting-program-999.json"), JSON.stringify({ ok: true }), "utf8");
      fs.mkdirSync(path.join(dir, "agent", "context"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "context", "local-source-registry.json"), JSON.stringify({ entries: [{ id: "sneaky", url: "https://evil.example.com" }] }), "utf8");
      const result = runSafeCommit(dir, "chore(agent): should be refused");
      assert.notStrictEqual(result.status, 0, "must refuse (nonzero exit) rather than silently commit a registry change");
      const after = headSha(dir);
      assert.strictEqual(after, before, "nothing must be committed when a disallowed path changed, even alongside allowed ones");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI: still REFUSES a firstparty evidence file outside the one-level-deep allowlist (e.g. a stray nested path)", () => {
    const dir = initTempRepo();
    try {
      const before = headSha(dir);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "r7" }) + "\n", "utf8");
      fs.mkdirSync(path.join(dir, "agent", "research", "firstparty", "nested"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "firstparty", "nested", "evidence.json"), "{}", "utf8");
      const result = runSafeCommit(dir, "chore(agent): weekly run r7");
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Git author identity regression (the real first-run failure) ---

  await test("safe-commit CLI succeeds on a clean GitHub-style checkout with NO Git identity configured anywhere (local, global, or system), and sets ONLY a repository-local one", () => {
    const { dir, env } = initTempRepoNoIdentity();
    try {
      // Sanity-check the fixture itself: confirm no identity is visible
      // BEFORE running safe-commit — otherwise this test would prove
      // nothing.
      assert.throws(() => runGit(["config", "user.name"], dir, env), /./, "fixture setup is broken: a Git identity is already visible");

      const before = headSha(dir, env);
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "ci-fresh-1" }) + "\n", "utf8");

      const result = runSafeCommit(dir, "chore(agent): daily run ci-fresh-1", env);
      assert.strictEqual(result.status, 0, `expected safe-commit to succeed on a no-identity checkout; stderr: ${result.stderr}`);

      const after = headSha(dir, env);
      assert.notStrictEqual(after, before, "a new commit should have been created");

      const localName = runGit(["config", "--local", "user.name"], dir, env).trim();
      const localEmail = runGit(["config", "--local", "user.email"], dir, env).trim();
      assert.strictEqual(localName, AUTOMATION_IDENTITY.name);
      assert.strictEqual(localEmail, AUTOMATION_IDENTITY.email);

      const authorLine = runGit(["show", "-s", "--format=%an <%ae>", after], dir, env).trim();
      assert.strictEqual(authorLine, `${AUTOMATION_IDENTITY.name} <${AUTOMATION_IDENTITY.email}>`);

      // The identity was set LOCALLY, never globally/system-wide — the
      // override "global"/"system" config fixture files must still be
      // untouched (empty).
      assert.strictEqual(fs.readFileSync(env.GIT_CONFIG_GLOBAL, "utf8"), "");
      assert.strictEqual(fs.readFileSync(env.GIT_CONFIG_SYSTEM, "utf8"), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI ALWAYS stamps the commit with the automation identity, even when a different identity is already configured locally", () => {
    // Earlier behavior only filled in whichever of user.name/user.email
    // wasn't already configured. That conditional logic was never
    // actually disproven by the real failure (see this file's header
    // and .github/scripts/safe-commit.js's AUTOMATION_IDENTITY comment
    // for why) — it's unconditional now purely to remove any remaining
    // doubt, per explicit instruction. This test locks in the NEW
    // contract: the Agent's commits are always attributed to the
    // automation identity, never whatever identity happened to be
    // lying around in that ephemeral checkout.
    const dir = initTempRepo(); // initTempRepo() sets a different, custom local identity
    try {
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "ci-existing-local" }) + "\n", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run ci-existing-local");
      assert.strictEqual(result.status, 0);
      const after = headSha(dir);
      const authorLine = runGit(["show", "-s", "--format=%an <%ae>", after], dir).trim();
      assert.strictEqual(authorLine, `${AUTOMATION_IDENTITY.name} <${AUTOMATION_IDENTITY.email}>`, "the automation identity must always be used, overriding whatever was configured before");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("safe-commit CLI ALWAYS stamps the commit with the automation identity, even when a different identity is configured only at the GLOBAL scope", () => {
    const { dir, env } = initTempRepoNoIdentity('[user]\n\tname = Some Org-Wide Runner\n\temail = runner@example.org\n');
    try {
      fs.appendFileSync(path.join(dir, "agent", "history", "log.ndjson"), JSON.stringify({ runId: "ci-existing-global" }) + "\n", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run ci-existing-global", env);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

      const after = headSha(dir, env);
      const authorLine = runGit(["show", "-s", "--format=%an <%ae>", after], dir, env).trim();
      assert.strictEqual(authorLine, `${AUTOMATION_IDENTITY.name} <${AUTOMATION_IDENTITY.email}>`, "a local override must always be added, even when a different identity already resolves from the global scope");

      // Still local-only — the global fixture file itself was never
      // rewritten with the automation identity.
      assert.strictEqual(fs.readFileSync(env.GIT_CONFIG_GLOBAL, "utf8"), "[user]\n\tname = Some Org-Wide Runner\n\temail = runner@example.org\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Exercises the ACTUAL functions safe-commit.js calls immediately
  // before `git commit` (not a reimplementation) — directly proving the
  // "verify the effective identity before commit" invariant the brief
  // asked for, independent of the full CLI's allowlist/scan steps.

  function callEnsureIdentityDirectly(dir, env) {
    const driverPath = path.join(dir, "__call-ensure-identity.js");
    fs.writeFileSync(
      driverPath,
      [
        `const { ensureGitIdentity, assertGitIdentityIsValid } = require(${JSON.stringify(SCRIPT_PATH)});`,
        "ensureGitIdentity();",
        "console.log(JSON.stringify(assertGitIdentityIsValid()));",
      ].join("\n"),
      "utf8"
    );
    try {
      const out = execFileSync("node", [driverPath], { cwd: dir, env, encoding: "utf8" });
      return JSON.parse(out.trim().split("\n").pop());
    } finally {
      fs.unlinkSync(driverPath);
    }
  }

  await test("ensureGitIdentity() + assertGitIdentityIsValid() — the real production functions, called directly — resolve to a valid automation identity on a no-identity checkout", () => {
    const { dir, env } = initTempRepoNoIdentity();
    try {
      const identity = callEnsureIdentityDirectly(dir, env);
      assert.strictEqual(identity.name, AUTOMATION_IDENTITY.name);
      assert.strictEqual(identity.email, AUTOMATION_IDENTITY.email);

      // What assertGitIdentityIsValid() returned is exactly what git
      // itself would resolve right before a real `git commit`.
      const localName = runGit(["config", "--local", "user.name"], dir, env).trim();
      const localEmail = runGit(["config", "--local", "user.email"], dir, env).trim();
      assert.strictEqual(localName, AUTOMATION_IDENTITY.name);
      assert.strictEqual(localEmail, AUTOMATION_IDENTITY.email);
      assert.strictEqual(fs.readFileSync(env.GIT_CONFIG_GLOBAL, "utf8"), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("assertGitIdentityIsValid() throws a clear, specific error (never a bare git crash) if the identity is somehow still invalid", () => {
    const { dir, env } = initTempRepoNoIdentity();
    try {
      const driverPath = path.join(dir, "__call-assert-only.js");
      fs.writeFileSync(
        driverPath,
        `const { assertGitIdentityIsValid } = require(${JSON.stringify(SCRIPT_PATH)}); assertGitIdentityIsValid();`,
        "utf8"
      );
      // Deliberately do NOT call ensureGitIdentity() first — this repo
      // genuinely has no identity at any scope (see initTempRepoNoIdentity).
      assert.throws(
        () => execFileSync("node", [driverPath], { cwd: dir, env, encoding: "utf8" }),
        /Git identity is still invalid/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
