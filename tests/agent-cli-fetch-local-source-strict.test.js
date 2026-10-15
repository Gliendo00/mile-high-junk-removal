// Site Improvement Agent, Phase 10 — tests for agent/cli.js's
// --fetch-local-source-strict= handling: the Denver LeafDrop diagnostic
// (.github/workflows/website-agent.yml's diagnostic-denver-leafdrop
// run_type). Mirrors tests/agent-cli-fetch-firstparty-strict.test.js as
// closely as possible: SAME strict-mode contract (a {skipped:true}
// result sets process.exitCode=1; a real success never does).
//
// ALL network access here is MOCKED via global.fetch — never the real
// Denver site (that was verified separately, by hand, during design).
//
// agent/cli.js guards its own main()-invocation behind
// `require.main === module` specifically so this file can require() it
// and call runFetchLocalSource() directly without triggering a real
// --daily/--weekly run.
//
// Run with:  node tests/agent-cli-fetch-local-source-strict.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { runFetchLocalSource, parseFetchLocalSourceStrictArg } = require("../agent/cli");
const { EVIDENCE_DIR } = require("../agent/lib/local-source-fetch");

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

function filesBeforeIn(dir) {
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}
function newFilesSince(dir, before) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !before.has(f)) : [];
}
function cleanupNewFiles(dir, before) {
  for (const f of newFilesSince(dir, before)) fs.unlinkSync(path.join(dir, f));
}

const SAMPLE_PAGE = "<html><head><title>LeafDrop</title></head><body><h1>LeafDrop and Pumpkin Recycling</h1><p>Denver's LeafDrop program allows residents to dispose of their fall leaves.</p></body></html>";

function mockFetch({ robotsBody = "User-agent: *\n", robotsStatus = 200, pageStatus = 200, pageBody = SAMPLE_PAGE } = {}) {
  return async (url) => {
    if (String(url).endsWith("/robots.txt")) {
      return { ok: robotsStatus >= 200 && robotsStatus < 300, status: robotsStatus, text: async () => robotsBody };
    }
    return { ok: pageStatus >= 200 && pageStatus < 300, status: pageStatus, text: async () => pageBody };
  };
}

async function main() {
  await test("parseFetchLocalSourceStrictArg() extracts the registry entry id, and never matches an unrelated flag", () => {
    assert.strictEqual(parseFetchLocalSourceStrictArg(["--fetch-local-source-strict=denver-leafdrop"]), "denver-leafdrop");
    assert.strictEqual(parseFetchLocalSourceStrictArg(["--fetch-firstparty-strict=a/b.json"]), null);
    assert.strictEqual(parseFetchLocalSourceStrictArg([]), null);
  });

  await test("an UNKNOWN registry entry id refuses outright (never falls back to treating the id as a literal URL), and in STRICT mode sets process.exitCode=1", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await runFetchLocalSource("not-a-real-entry-id", { strict: true });
      assert.strictEqual(process.exitCode, 1);
    } finally {
      process.exitCode = before;
    }
  });

  await test("STRICT mode: ROBOTS DISALLOW sets process.exitCode=1 and writes NO evidence file", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const originalFetch = global.fetch;
    global.fetch = mockFetch({ robotsBody: "User-agent: *\nDisallow: /My-Property/Recycle-Compost-Trash/Seasonal-Programs/LeafDrop-and-Pumpkin-Recycling\n" });
    const filesBefore = filesBeforeIn(EVIDENCE_DIR);
    try {
      await runFetchLocalSource("denver-leafdrop", { strict: true });
      assert.strictEqual(process.exitCode, 1);
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, filesBefore), [], "a robots-disallowed fetch must never write an evidence file");
    } finally {
      global.fetch = originalFetch;
      process.exitCode = before;
      cleanupNewFiles(EVIDENCE_DIR, filesBefore);
    }
  });

  await test("STRICT mode: a network/HTTP failure sets process.exitCode=1 and writes NO evidence file", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const originalFetch = global.fetch;
    global.fetch = mockFetch({ pageStatus: 500 });
    const filesBefore = filesBeforeIn(EVIDENCE_DIR);
    try {
      await runFetchLocalSource("denver-leafdrop", { strict: true });
      assert.strictEqual(process.exitCode, 1);
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, filesBefore), []);
    } finally {
      global.fetch = originalFetch;
      process.exitCode = before;
      cleanupNewFiles(EVIDENCE_DIR, filesBefore);
    }
  });

  await test("STRICT mode: a REAL success writes exactly one evidence file and does NOT set a failing exitCode", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const originalFetch = global.fetch;
    global.fetch = mockFetch();
    const filesBefore = filesBeforeIn(EVIDENCE_DIR);
    try {
      await runFetchLocalSource("denver-leafdrop", { strict: true });
      assert.strictEqual(process.exitCode, before === undefined ? undefined : before, "a real success must NOT set a failing exitCode");
      const newFiles = newFilesSince(EVIDENCE_DIR, filesBefore);
      assert.strictEqual(newFiles.length, 1);
      const written = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, newFiles[0]), "utf8"));
      assert.strictEqual(written.sourceDomain, "denvergov.org");
      assert.strictEqual(written.discoveryMethod, "known-url");
      assert.strictEqual(/<html|<head|<body/i.test(JSON.stringify(written)), false, "raw HTML must never be persisted");
    } finally {
      global.fetch = originalFetch;
      process.exitCode = before;
      cleanupNewFiles(EVIDENCE_DIR, filesBefore);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
