// Site Improvement Agent, Phase 5B — tests for agent/lib/completed-job-
// fetch.js, the automated (Supabase-backed) replacement for the Phase 5
// manual file handoff. This is the hard privacy boundary Rocky asked for
// regression proof on: a raw `bookings` row (with every private column a
// real row has — customer_id, final_price, estimated_price, tip_amount,
// payment data, internal/private notes, exact address, phone, email,
// customer name) must NEVER have any of those fields reach this module's
// return value, a written file, or (by construction, since this module
// never logs field values — see its own header) a log line.
//
// Uses an injected fake Supabase client (same pattern as
// tests/agent-proposals-sync.test.js) — never a real database connection.
//
// Run with:  node tests/agent-completed-job-fetch.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchRecentCompletedJobEvidence, writeCompletedJobEvidence, SELECT_COLUMNS } = require("../agent/lib/completed-job-fetch");
const { PRIVATE_FIELD_PATTERNS } = require("../agent/lib/business-context");

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

// A realistic raw `bookings` row — every private column a real row
// actually has, exactly the shape tests/agent-business-context.test.js
// already uses for the same reason (proving nothing leaks regardless of
// what's on the input).
function rawBookingRow(overrides) {
  return {
    id: "booking-1",
    status: "completed",
    customer_id: "cust-123",
    customer_name: "Jane Doe",
    customer_phone: "303-555-0100",
    customer_email: "jane@example.com",
    service_address: "123 Main St, Denver, CO 80202",
    service_type: "hot tub removal",
    service_city: "Denver",
    final_price: 450,
    estimated_price: 400,
    tip_amount: 50,
    payment_method: "card",
    internal_notes: "difficult customer, called twice",
    operational_note: "backyard access was easy, used the side gate",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeFakeClient(rows) {
  return {
    from(table) {
      assert.strictEqual(table, "bookings");
      return {
        select(cols) {
          this._cols = cols;
          return this;
        },
        eq() {
          return this;
        },
        gte() {
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  };
}

function assertNoPrivateFields(obj) {
  const json = JSON.stringify(obj);
  for (const pattern of PRIVATE_FIELD_PATTERNS) {
    // Check against the actual raw VALUES that would leak, not just key
    // names (the object itself should only ever have safe keys anyway —
    // this is the belt-and-suspenders check).
    assert.ok(!pattern.test(json) || !/cust-123|Jane Doe|303-555-0100|jane@example\.com|123 Main St|450|400|\b50\b|card|difficult customer/.test(json),
      `private-patterned content leaked into: ${json}`);
  }
}

async function main() {
  await test("SELECT_COLUMNS never requests a private column — price/payment/tip/address/customer-identity are never even fetched", () => {
    for (const pattern of PRIVATE_FIELD_PATTERNS) {
      assert.ok(!pattern.test(SELECT_COLUMNS), `SELECT_COLUMNS ("${SELECT_COLUMNS}") must not match private pattern ${pattern}`);
    }
    assert.ok(!/customer_id|final_price|estimated_price|tip_amount|payment_method|service_address|internal_notes/.test(SELECT_COLUMNS));
  });

  await test("fetchRecentCompletedJobEvidence() returns ONLY publication-safe fields, even when the (fake) client returns a row with every private column populated", async () => {
    const client = makeFakeClient([rawBookingRow()]);
    const result = await fetchRecentCompletedJobEvidence({ client });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.length, 1);
    const entry = result.evidence[0];
    assert.deepStrictEqual(Object.keys(entry).sort(), ["accessNotes", "city", "outcomeTag", "serviceType"]);
    assertNoPrivateFields(entry);
    assertNoPrivateFields(result);
  });

  await test("every individual forbidden field (customer name/id, phone, email, exact address, final/estimated price, tip, payment method, internal notes) is independently absent from the output", async () => {
    const client = makeFakeClient([rawBookingRow()]);
    const result = await fetchRecentCompletedJobEvidence({ client });
    const json = JSON.stringify(result.evidence);
    const forbidden = ["Jane Doe", "cust-123", "303-555-0100", "jane@example.com", "123 Main St", "450", "400", "card", "difficult customer"];
    for (const value of forbidden) {
      assert.ok(!json.includes(value), `forbidden value "${value}" leaked into fetchRecentCompletedJobEvidence() output`);
    }
  });

  await test("a row with no operational_note is skipped entirely (not pushed as a placeholder) — 'no evidence' is never mistaken for 'evidence of an empty job'", async () => {
    const client = makeFakeClient([rawBookingRow({ operational_note: null })]);
    const result = await fetchRecentCompletedJobEvidence({ client });
    assert.strictEqual(result.evidence.length, 0);
  });

  await test("multiple rows are each independently sanitized", async () => {
    const client = makeFakeClient([
      rawBookingRow({ service_city: "Aurora" }),
      rawBookingRow({ service_city: "Parker", customer_name: "John Smith" }),
    ]);
    const result = await fetchRecentCompletedJobEvidence({ client });
    assert.strictEqual(result.evidence.length, 2);
    assert.deepStrictEqual(result.evidence.map((e) => e.city).sort(), ["Aurora", "Parker"]);
    assertNoPrivateFields(result);
  });

  await test("gracefully skipped (never thrown) when Supabase isn't configured", async () => {
    const result = await fetchRecentCompletedJobEvidence({ client: null });
    assert.strictEqual(result.skipped, true);
    assert.deepStrictEqual(result.evidence, []);
  });

  await test("a Supabase query error degrades to skipped:true with the error message, never thrown", async () => {
    const client = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        gte: () => Promise.resolve({ data: null, error: { message: "simulated query failure" } }),
      }),
    };
    const result = await fetchRecentCompletedJobEvidence({ client });
    assert.strictEqual(result.skipped, true);
    assert.ok(/simulated query failure/.test(result.reason));
  });

  await test("writeCompletedJobEvidence() writes ONLY what it's given — the full fetch→write pipeline never persists a raw field to disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-completed-job-fetch-write-test-"));
    try {
      const client = makeFakeClient([rawBookingRow()]);
      const result = await fetchRecentCompletedJobEvidence({ client });
      const filePath = writeCompletedJobEvidence(result.evidence, tmpDir);
      const onDisk = fs.readFileSync(filePath, "utf8");
      const forbidden = ["Jane Doe", "cust-123", "303-555-0100", "jane@example.com", "123 Main St", "450", "400", "card", "difficult customer"];
      for (const value of forbidden) {
        assert.ok(!onDisk.includes(value), `forbidden value "${value}" was persisted to disk at ${filePath}`);
      }
      const parsed = JSON.parse(onDisk);
      assert.strictEqual(parsed.length, 1);
      assert.deepStrictEqual(Object.keys(parsed[0]).sort(), ["accessNotes", "city", "outcomeTag", "serviceType"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("writeCompletedJobEvidence() overwrites the SAME rolling file on each call — a snapshot, not an accumulating archive", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-completed-job-fetch-rolling-test-"));
    try {
      const path1 = writeCompletedJobEvidence([{ city: "Denver", serviceType: "a" }], tmpDir);
      const path2 = writeCompletedJobEvidence([{ city: "Aurora", serviceType: "b" }], tmpDir);
      assert.strictEqual(path1, path2);
      const files = fs.readdirSync(tmpDir);
      assert.strictEqual(files.length, 1);
      const parsed = JSON.parse(fs.readFileSync(path2, "utf8"));
      assert.strictEqual(parsed[0].city, "Aurora");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
