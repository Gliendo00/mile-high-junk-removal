// Site Improvement Agent, Phase 5 — completed-job evidence intake
// (agent/lib/completed-job-intake.js). Proves the privacy boundary holds
// even for files sitting in the intake directory: an entry with ANY field
// outside business-context.js's PUBLICATION_SAFE_FIELDS allowlist (price,
// payment, tip, address, customer name, phone, email, a raw "notes"
// field, etc.) is rejected, never silently included — defense in depth
// on top of fromCompletedBooking()'s own redaction, for a file that could
// in principle be hand-edited or stale. Also proves the directory being
// empty (the real, expected state on a fresh checkout) degrades cleanly.
//
// Run with:  node tests/agent-completed-job-intake.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCompletedJobEvidence, summarizeByCity, DEFAULT_DIR } = require("../agent/lib/completed-job-intake");
const { fromCompletedBooking } = require("../agent/lib/business-context");

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

const TMP_DIR = path.join(os.tmpdir(), `agent-completed-jobs-test-${process.pid}`);

function reset() {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

test("a missing directory degrades to zero evidence, never throws (the real agent/research/completed-jobs/ is empty on a fresh checkout)", () => {
  const { evidence, warnings } = loadCompletedJobEvidence(path.join(os.tmpdir(), "does-not-exist-" + Date.now()));
  assert.deepStrictEqual(evidence, []);
  assert.deepStrictEqual(warnings, []);
});

test("agent/research/completed-jobs/ in THIS repo is real and readable (empty on a fresh checkout — no evidence manufactured just to fill it)", () => {
  const { evidence } = loadCompletedJobEvidence(DEFAULT_DIR);
  assert.deepStrictEqual(evidence, []);
});

test("a file containing only publication-safe fields (the real output shape of fromCompletedBooking()) loads successfully", () => {
  reset();
  const safeEntry = fromCompletedBooking({
    status: "completed",
    service_type: "hot tub removal",
    service_city: "Wheat Ridge",
    operational_note: "backyard access was easy",
  });
  fs.writeFileSync(path.join(TMP_DIR, "batch-1.json"), JSON.stringify(safeEntry));
  const { evidence, warnings } = loadCompletedJobEvidence(TMP_DIR);
  assert.strictEqual(evidence.length, 1);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(evidence[0].city, "Wheat Ridge");
});

test("an entry with a private field (e.g. hand-edited to include a price/address/customer name) is REJECTED, not silently included — defense in depth beyond fromCompletedBooking()'s own redaction", () => {
  reset();
  const tampered = { serviceType: "hot tub removal", city: "Denver", finalPrice: 450 };
  fs.writeFileSync(path.join(TMP_DIR, "tampered.json"), JSON.stringify(tampered));
  const { evidence, warnings } = loadCompletedJobEvidence(TMP_DIR);
  assert.deepStrictEqual(evidence, []);
  assert.ok(warnings.length === 1 && /publication-safe allowlist/.test(warnings[0]));
});

test("every private-field pattern (price, payment, tip, address, customer name, phone, email, a raw notes field) is independently rejected", () => {
  reset();
  const privateFields = [
    { price: 1 }, { payment: "x" }, { tip: 1 }, { customerName: "x" },
    { phone: "x" }, { email: "x" }, { address: "x" }, { privateNotes: "x" },
  ];
  privateFields.forEach((entry, i) => {
    fs.writeFileSync(path.join(TMP_DIR, `tampered-${i}.json`), JSON.stringify(entry));
  });
  const { evidence, warnings } = loadCompletedJobEvidence(TMP_DIR);
  assert.deepStrictEqual(evidence, []);
  assert.strictEqual(warnings.length, privateFields.length);
});

test("a malformed JSON file is skipped with a warning, never thrown, and never crashes the loader for the other files in the same directory", () => {
  reset();
  fs.writeFileSync(path.join(TMP_DIR, "broken.json"), "{ not valid json");
  fs.writeFileSync(path.join(TMP_DIR, "good.json"), JSON.stringify({ city: "Aurora", serviceType: "furniture removal" }));
  const { evidence, warnings } = loadCompletedJobEvidence(TMP_DIR);
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(warnings.length, 1);
});

test("a file may contain an array of entries, each checked independently", () => {
  reset();
  fs.writeFileSync(
    path.join(TMP_DIR, "batch.json"),
    JSON.stringify([{ city: "Denver", serviceType: "a" }, { city: "Denver", serviceType: "b" }])
  );
  const { evidence } = loadCompletedJobEvidence(TMP_DIR);
  assert.strictEqual(evidence.length, 2);
});

test("summarizeByCity() aggregates into simple per-city counts, nothing more granular (no dates, no per-job detail)", () => {
  const summary = summarizeByCity([{ city: "Denver" }, { city: "Denver" }, { city: "Aurora" }, {}]);
  assert.deepStrictEqual(summary, { Denver: 2, Aurora: 1 });
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
