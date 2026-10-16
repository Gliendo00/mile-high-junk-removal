// Site Improvement Agent, Phase 11B — tests for
// agent/lib/local-source-candidate-log.js: the small, OVERWRITTEN-each-
// run log bridging --refresh-local-source-evidence's own process to a
// later report build in a SEPARATE process. See that module's header
// for why this file exists at all.
//
// Run with:  node tests/agent-local-source-candidate-log.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeLocalSourceCandidateLog, loadLocalSourceCandidateLog } = require("../agent/lib/local-source-candidate-log");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function tmpPath() {
  return path.join(os.tmpdir(), `local-source-candidate-log-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test("loadLocalSourceCandidateLog() returns an honest empty shape when the file does not exist — never throws", () => {
  const p = tmpPath();
  const log = loadLocalSourceCandidateLog(p);
  assert.deepStrictEqual(log, { at: null, workflowStartedAt: null, blockedOrFailed: [] });
});

test("writeLocalSourceCandidateLog() then loadLocalSourceCandidateLog() round-trips exactly", () => {
  const p = tmpPath();
  try {
    const log = {
      at: "2026-10-15T20:00:00.000Z",
      workflowStartedAt: "2026-10-15T19:55:00.000Z",
      blockedOrFailed: [{ entryId: "jeffco-slash", matchedPickSlugs: ["lakewood", "golden"], reason: "robots.txt disallows this path" }],
    };
    writeLocalSourceCandidateLog(log, p);
    assert.deepStrictEqual(loadLocalSourceCandidateLog(p), log);
  } finally {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

test("writeLocalSourceCandidateLog() OVERWRITES the previous content rather than appending — only the latest run's outcome matters", () => {
  const p = tmpPath();
  try {
    writeLocalSourceCandidateLog({ at: "a", workflowStartedAt: null, blockedOrFailed: [{ entryId: "x", matchedPickSlugs: [], reason: "r1" }] }, p);
    writeLocalSourceCandidateLog({ at: "b", workflowStartedAt: null, blockedOrFailed: [] }, p);
    const log = loadLocalSourceCandidateLog(p);
    assert.strictEqual(log.at, "b");
    assert.deepStrictEqual(log.blockedOrFailed, []);
  } finally {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

test("loadLocalSourceCandidateLog() fails safe (empty shape, never throws) on a malformed/corrupt file", () => {
  const p = tmpPath();
  try {
    fs.writeFileSync(p, "not valid json {{{", "utf8");
    assert.deepStrictEqual(loadLocalSourceCandidateLog(p), { at: null, workflowStartedAt: null, blockedOrFailed: [] });
  } finally {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

test("loadLocalSourceCandidateLog() fails safe on a file missing the blockedOrFailed array", () => {
  const p = tmpPath();
  try {
    fs.writeFileSync(p, JSON.stringify({ at: "x" }), "utf8");
    assert.deepStrictEqual(loadLocalSourceCandidateLog(p), { at: null, workflowStartedAt: null, blockedOrFailed: [] });
  } finally {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

test("writeLocalSourceCandidateLog() creates the parent directory if it does not exist yet", () => {
  const dir = path.join(os.tmpdir(), `local-source-candidate-log-test-dir-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const p = path.join(dir, "nested", "log.json");
  try {
    writeLocalSourceCandidateLog({ at: "x", workflowStartedAt: null, blockedOrFailed: [] }, p);
    assert.ok(fs.existsSync(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
