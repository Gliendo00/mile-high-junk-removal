// Site Improvement Agent, Phase 10 — tests for
// agent/lib/local-source-registry.js: the loader/validator for the
// human-curated, human-VERIFIED agent/context/local-source-
// registry.json. Uses synthetic fixture data (never the real registry
// file in these validation-focused tests — the real file is proven
// separately in tests/agent-local-source-fetch.test.js and
// tests/agent-local-source-intake.test.js) so a future edit to the real
// Denver entry can never accidentally break these.
//
// Run with:  node tests/agent-local-source-registry.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRegistry, getEntries, getEntryById, validateEntry, REGISTRY_PATH } = require("../agent/lib/local-source-registry");

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

function validEntry(overrides) {
  return {
    id: "example-entry",
    locality: "Example, CO",
    citySlug: "example",
    domain: "example.gov",
    url: "https://www.example.gov/program-page",
    topic: "example-program",
    authorityClass: "official-government",
    expectedTemporality: "temporary",
    humanVerifiedAt: "2026-10-15",
    ...overrides,
  };
}

function tmpRegistryFile(obj) {
  const filePath = path.join(os.tmpdir(), `local-source-registry-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
  return filePath;
}

test("validateEntry() accepts a well-formed entry", () => {
  assert.doesNotThrow(() => validateEntry(validEntry()));
});

test("validateEntry() rejects a missing/empty required string field", () => {
  for (const field of ["id", "locality", "domain", "url", "topic", "humanVerifiedAt"]) {
    assert.throws(() => validateEntry(validEntry({ [field]: undefined })), new RegExp(field));
    assert.throws(() => validateEntry(validEntry({ [field]: "" })), new RegExp(field));
  }
});

test("validateEntry() rejects an authorityClass outside research.js's SOURCE_TYPES — no second, conflicting taxonomy", () => {
  assert.throws(() => validateEntry(validEntry({ authorityClass: "totally-made-up" })), /authorityClass/);
});

test("validateEntry() accepts every real research.js SOURCE_TYPES value (reused vocabulary, not a narrower copy)", () => {
  const { SOURCE_TYPES } = require("../agent/lib/research");
  for (const authorityClass of SOURCE_TYPES) {
    assert.doesNotThrow(() => validateEntry(validEntry({ authorityClass })));
  }
});

test("validateEntry() rejects an expectedTemporality outside research.js's TEMPORALITY_VALUES", () => {
  assert.throws(() => validateEntry(validEntry({ expectedTemporality: "whenever" })), /expectedTemporality/);
});

test("validateEntry() rejects a non-https url", () => {
  assert.throws(() => validateEntry(validEntry({ url: "http://example.gov/program-page" })), /https/);
});

test("validateEntry() rejects an unparsable url", () => {
  assert.throws(() => validateEntry(validEntry({ url: "not a url at all" })), /unparsable/);
});

// --- THE core structural guarantee: domain/authority consistency -------

test("validateEntry() REJECTS a url whose host does not match the entry's own declared domain — an entry can never claim authority over a host it doesn't actually point to", () => {
  assert.throws(
    () => validateEntry(validEntry({ domain: "example.gov", url: "https://totally-different-host.com/page" })),
    /does not match its own declared domain/
  );
});

test("validateEntry() accepts a url host that is the declared domain with a 'www.' prefix (and vice versa isn't required)", () => {
  assert.doesNotThrow(() => validateEntry(validEntry({ domain: "example.gov", url: "https://www.example.gov/page" })));
  assert.doesNotThrow(() => validateEntry(validEntry({ domain: "example.gov", url: "https://example.gov/page" })));
});

test("validateEntry() REJECTS a url on a DIFFERENT subdomain of the declared domain — exact apex/www match only, no subdomain wildcarding", () => {
  assert.throws(
    () => validateEntry(validEntry({ domain: "example.gov", url: "https://evil.example.gov/page" })),
    /does not match its own declared domain/
  );
});

// --- loadRegistry() / getEntries() / getEntryById() ---------------------

test("loadRegistry() rejects a file with no 'entries' array", () => {
  const filePath = tmpRegistryFile({ notEntries: [] });
  try {
    assert.throws(() => loadRegistry(filePath), /entries/);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("loadRegistry() rejects duplicate entry ids", () => {
  const filePath = tmpRegistryFile({ entries: [validEntry({ id: "dup" }), validEntry({ id: "dup", url: "https://www.example.gov/other" })] });
  try {
    assert.throws(() => loadRegistry(filePath), /duplicate entry id/);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("loadRegistry() rejects a malformed individual entry (fails loudly, never silently drops it) — this is a small, human-curated list where a bad entry must be fixed, not quietly skipped", () => {
  const filePath = tmpRegistryFile({ entries: [validEntry(), { id: "broken" }] });
  try {
    assert.throws(() => loadRegistry(filePath));
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("getEntries()/getEntryById() work against a loaded registry object, and getEntryById() returns null (never throws, never falls back to a literal URL) for an unknown id", () => {
  const registry = { entries: [validEntry({ id: "a" }), validEntry({ id: "b", url: "https://www.example.gov/b" })] };
  assert.strictEqual(getEntries(registry).length, 2);
  assert.strictEqual(getEntryById("a", registry).id, "a");
  assert.strictEqual(getEntryById("nonexistent-id", registry), null);
  assert.strictEqual(getEntryById("https://evil.example.com/whatever-i-want", registry), null, "a URL-shaped string is never treated specially — it just isn't a known id, same as any other unknown id");
});

// --- the REAL registry file, read-only sanity check ----------------------

test("the REAL agent/context/local-source-registry.json loads and validates cleanly, and has exactly the Phase 1 Denver entry", () => {
  const registry = loadRegistry(REGISTRY_PATH);
  const entries = getEntries(registry);
  assert.strictEqual(entries.length, 1, "Phase 1 holds exactly one curated entry — see agent/README.md's Phase 10 section");
  assert.strictEqual(entries[0].id, "denver-leafdrop");
  assert.strictEqual(entries[0].domain, "denvergov.org");
  assert.strictEqual(entries[0].authorityClass, "official-government");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
