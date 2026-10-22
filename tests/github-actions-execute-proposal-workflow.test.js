// Site Improvement Agent, Phase 14 — static/regression tests for
// .github/workflows/execute-proposal.yml's invariants. Same
// text/regex-based convention as tests/github-actions-workflow.test.js
// (no new YAML-parsing dependency) — each test targets one specific
// safety requirement so a future edit that quietly drops a guard fails
// a named test, not just "the YAML changed".
//
// Run with:  node tests/github-actions-execute-proposal-workflow.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "execute-proposal.yml");

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

function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

async function main() {
  assert.ok(fs.existsSync(WORKFLOW_PATH), `expected a workflow file at ${WORKFLOW_PATH}`);
  const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const code = stripComments(raw);

  await test("defines workflow_dispatch with a required proposal_id string input, never a schedule trigger", () => {
    assert.ok(/\bworkflow_dispatch:/.test(code));
    assert.ok(/proposal_id:/.test(code));
    assert.ok(/required:\s*true/.test(code));
    assert.ok(!/^\s*schedule:/m.test(code), "this workflow must only ever run on an explicit dispatch, never a cron schedule");
  });

  await test("permissions are exactly contents: write (no id-token or other scope)", () => {
    const m = code.match(/permissions:\s*\n((?:\s{2,}.*\n?)*)/);
    assert.ok(m, "expected a permissions: block");
    const body = m[1].trim();
    assert.strictEqual(body, "contents: write");
  });

  await test("has a concurrency group shared with website-agent.yml's own group (so an execution can never race a daily/weekly push, or another execution)", () => {
    assert.ok(/concurrency:/.test(code));
    assert.ok(/group:\s*website-agent-runner/.test(code));
    assert.ok(/cancel-in-progress:\s*false/.test(code));
  });

  await test("verifies it is running on refs/heads/main before doing anything, and fails closed if not", () => {
    assert.ok(/if:\s*github\.ref\s*!=\s*'refs\/heads\/main'/.test(code));
    assert.ok(/exit 1/.test(code));
  });

  await test("fails fast if Supabase secrets are missing, before Node/npm ci runs", () => {
    const checkIdx = code.indexOf("SUPABASE_URL");
    const npmCiIdx = code.indexOf("npm ci");
    assert.ok(checkIdx >= 0 && npmCiIdx >= 0 && checkIdx < npmCiIdx, "the Supabase config check must run before npm ci");
  });

  await test("runs the real execution engine via `node agent/cli.js --execute-proposal=`, passing the dispatch input through", () => {
    assert.ok(/node agent\/cli\.js "--execute-proposal=\$\{\{\s*inputs\.proposal_id\s*\}\}"/.test(code));
  });

  await test("never runs --daily, --weekly, or --apply-safe — this workflow only ever executes ONE already-approved proposal, never the general audit/auto-apply pipeline", () => {
    assert.ok(!/--daily\b/.test(code));
    assert.ok(!/--weekly\b/.test(code));
    assert.ok(!/--apply-safe\b/.test(code));
  });

  await test("never contains a separate `git push` step — pushing happens INSIDE agent/lib/execute-proposal.js, gated on validation+tests passing, not as an unconditional workflow step", () => {
    assert.ok(!/\bgit push\b/.test(code), "git push must not appear as a literal workflow step — it only happens inside execute-proposal.js's own gated logic");
  });

  await test("configures a git author identity before the execute step runs (a fresh runner checkout has none)", () => {
    const identityIdx = code.indexOf("git config user.email");
    const executeIdx = code.indexOf("--execute-proposal=");
    assert.ok(identityIdx >= 0 && executeIdx >= 0 && identityIdx < executeIdx);
  });

  await test("sets a 20-minute job timeout", () => {
    assert.ok(/timeout-minutes:\s*20/.test(code));
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();
