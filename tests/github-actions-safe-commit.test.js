// Website Agent — GitHub Actions unattended runner, Phase 7.
//
// Tests for .github/scripts/safe-commit.js: the gate that decides
// whether an unattended --daily/--weekly run's working-tree changes are
// safe to commit back to `main`. Covers the brief's explicit
// invariants: only the two known Agent-artifact paths are ever
// committed, any other changed path fails the run instead of being
// silently committed, and a credential-shaped string anywhere in an
// otherwise-allowed file also fails the run (without ever printing the
// matched secret text).
//
// The first block tests the pure parsing/classification/scanning
// functions directly (no git, no subprocess). The second block is a
// real end-to-end check against a throwaway temp git repo, exercising
// the actual CLI entry point exactly as the GitHub Actions workflow
// invokes it.
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

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-commit-test-"));
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Safe Commit Test"], dir);
  fs.mkdirSync(path.join(dir, "agent", "history"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent", "history", "log.ndjson"), "", "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  runGit(["add", "-A"], dir);
  runGit(["commit", "-m", "initial"], dir);
  return dir;
}

function headSha(dir) {
  return runGit(["rev-parse", "HEAD"], dir).trim();
}

function runSafeCommit(dir, message) {
  try {
    execFileSync("node", [SCRIPT_PATH, message], { cwd: dir, encoding: "utf8" });
    return { status: 0 };
  } catch (e) {
    return { status: e.status, stderr: e.stderr ? e.stderr.toString() : "" };
  }
}

async function main() {
  // --- pure function tests ---------------------------------------

  await test("isPathAllowed() allows exactly the two known Agent-artifact paths", () => {
    assert.strictEqual(isPathAllowed("agent/history/log.ndjson"), true);
    assert.strictEqual(isPathAllowed("agent/history/research-rotation-state.json"), true);
  });

  await test("isPathAllowed() refuses any other Agent path, website source, or credential-like file", () => {
    assert.strictEqual(isPathAllowed("agent/research/results/some-question.json"), false);
    assert.strictEqual(isPathAllowed("agent/history/.run.lock"), false);
    assert.strictEqual(isPathAllowed("index.html"), false);
    assert.strictEqual(isPathAllowed("vercel.json"), false);
    assert.strictEqual(isPathAllowed("gha-creds-abc123.json"), false);
    assert.strictEqual(isPathAllowed(".env"), false);
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
      fs.mkdirSync(path.join(dir, "agent", "research", "results"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "research", "results", "q1.json"), "{}", "utf8");
      const result = runSafeCommit(dir, "chore(agent): daily run r3");
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(headSha(dir), before);
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

  if (process.exitCode) process.exit(process.exitCode);
}

main();
