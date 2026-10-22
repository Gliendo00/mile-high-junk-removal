#!/usr/bin/env node
// Aggregate test runner — this repo has no test framework (jest/mocha);
// every file under tests/*.test.js is a self-contained Node script using
// `assert` + a local `test()` helper, historically run one at a time
// ("Run with: node tests/<file>.test.js" — see any test file's own
// header) and tallied up by hand for each phase's README writeup ("Full
// repository suite: 135 files, 134 passing").
//
// This script formalizes that into one command (`npm test`) so it can be
// automated: Site Improvement Agent Phase 14's execution engine
// (agent/lib/execute-proposal.js) runs this before allowing a commit to
// be pushed, per the "run the relevant validation/tests, never push a
// broken change" requirement. Runs every tests/*.test.js file in its own
// `node` process (exactly as each file's own header already documents),
// collects each one's exit code, prints a pass/fail summary, and exits
// non-zero if anything failed.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TESTS_DIR = path.join(__dirname, "..", "tests");

function listTestFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
}

function runOne(file) {
  const result = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const passed = result.status === 0;
  return { file, passed, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function main() {
  const files = listTestFiles();
  const results = files.map(runOne);
  const failed = results.filter((r) => !r.passed);

  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"} - ${r.file}`);
    if (!r.passed) {
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
    }
  }

  console.log("");
  console.log(`${results.length - failed.length}/${results.length} test files passed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.file).join(", ")}`);
    process.exitCode = 1;
  }
}

main();
