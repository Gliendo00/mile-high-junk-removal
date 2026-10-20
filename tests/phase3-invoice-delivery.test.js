// Local, offline test harness for Phase 3 (Invoice Delivery + Pay Now) —
// the pure, dependency-free pieces: api/_lib/invoice-crypto.js (AES-256-GCM
// envelope, AAD binding, SHA-256 hashing) and api/_lib/money.js (decimal
// dollars <-> integer cents, no floating-point multiplication). Neither
// needs Supabase/Stripe/Resend mocking, so this file is self-contained.
//
// The full Send/Pay-Now request flow (api/admin/booking.js's
// handleSendInvoice, api/book.js's invoice-public/invoice-payment-intent,
// the three delivery-attempt RPCs, and the Category A/B payment-claim
// guards) is covered by the existing offline-mocked suites it integrates
// with (tests/phase2-invoice-workflow.test.js, tests/phase3c-stage3-
// job-payments.test.js, tests/phase3c-stage2.5v2-stripe-rental-payments.test.js
// — all three extended with .neq()/.in()/.or()/.limit() support on their
// fake Supabase query builders as part of this phase) plus the RPC
// functions' own production-verified SQL smoke tests
// (sql/2026-10-19_phase3-invoice-delivery-pay-now.sql,
// sql/2026-10-20_phase3-send-failure-resolution-rpc.sql). A full offline
// mock of the Resend/Stripe HTTP calls inside handleSendInvoice/
// handleInvoicePaymentIntentCreate themselves is flagged as a remaining
// gap, not attempted here.
//
// Run with:  node tests/phase3-invoice-delivery.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const crypto = require("../api/_lib/invoice-crypto");
const money = require("../api/_lib/money");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS - " + name);
    passed++;
  } catch (err) {
    console.log("FAIL - " + name);
    console.log("      " + (err && err.message ? err.message : err));
    failed++;
  }
}

// Deterministic 32-byte test key (base64) — never a real secret.
process.env.INVOICE_LINK_SECRET = Buffer.alloc(32, 7).toString("base64");

// ---------------------------------------------------------------------
// invoice-crypto.js
// ---------------------------------------------------------------------

test("hashAccessToken: deterministic, 64 lowercase hex chars", () => {
  const token = "raw-token-example";
  const h1 = crypto.hashAccessToken(token);
  const h2 = crypto.hashAccessToken(token);
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("hashAccessToken: different tokens hash differently", () => {
  assert.notStrictEqual(crypto.hashAccessToken("a"), crypto.hashAccessToken("b"));
});

test("generateRawAccessToken: produces distinct, non-empty tokens", () => {
  const a = crypto.generateRawAccessToken();
  const b = crypto.generateRawAccessToken();
  assert.ok(a && typeof a === "string" && a.length > 0);
  assert.notStrictEqual(a, b);
});

test("encrypt/decrypt roundtrip: recovers the exact original raw token", () => {
  const raw = crypto.generateRawAccessToken();
  const invoiceId = "11111111-1111-1111-1111-111111111111";
  const attemptId = "22222222-2222-2222-2222-222222222222";
  const envelope = crypto.encryptAccessToken(raw, invoiceId, attemptId);
  const decrypted = crypto.decryptAccessToken(envelope, invoiceId, attemptId);
  assert.strictEqual(decrypted, raw);
});

test("envelope format: versioned, four dot-separated base64url parts", () => {
  const envelope = crypto.encryptAccessToken("x", "inv", "att");
  const parts = envelope.split(".");
  assert.strictEqual(parts.length, 4);
  assert.strictEqual(parts[0], "v1");
});

test("AAD binding: decrypting with the WRONG invoiceId fails (returns null, never throws)", () => {
  const envelope = crypto.encryptAccessToken("secret-token", "invoice-A", "attempt-1");
  const result = crypto.decryptAccessToken(envelope, "invoice-B", "attempt-1");
  assert.strictEqual(result, null);
});

test("AAD binding: decrypting with the WRONG attemptId fails (returns null, never throws)", () => {
  const envelope = crypto.encryptAccessToken("secret-token", "invoice-A", "attempt-1");
  const result = crypto.decryptAccessToken(envelope, "invoice-A", "attempt-2");
  assert.strictEqual(result, null);
});

test("tamper detection: flipping a byte in the ciphertext fails authentication (returns null)", () => {
  const envelope = crypto.encryptAccessToken("secret-token", "invoice-A", "attempt-1");
  const parts = envelope.split(".");
  const tamperedCiphertext = parts[2].slice(0, -2) + (parts[2].slice(-2) === "AA" ? "BB" : "AA");
  const tampered = [parts[0], parts[1], tamperedCiphertext, parts[3]].join(".");
  const result = crypto.decryptAccessToken(tampered, "invoice-A", "attempt-1");
  assert.strictEqual(result, null);
});

test("malformed envelope: wrong version, wrong part count, or garbage all return null, never throw", () => {
  assert.strictEqual(crypto.decryptAccessToken("not-an-envelope", "a", "b"), null);
  assert.strictEqual(crypto.decryptAccessToken("v2.x.y.z", "a", "b"), null);
  assert.strictEqual(crypto.decryptAccessToken("v1.x.y", "a", "b"), null);
  assert.strictEqual(crypto.decryptAccessToken("", "a", "b"), null);
  assert.strictEqual(crypto.decryptAccessToken(null, "a", "b"), null);
});

test("getLinkSecretKey: fails closed (null) when INVOICE_LINK_SECRET is missing or the wrong length", () => {
  const saved = process.env.INVOICE_LINK_SECRET;
  try {
    delete process.env.INVOICE_LINK_SECRET;
    assert.strictEqual(crypto.getLinkSecretKey(), null);
    process.env.INVOICE_LINK_SECRET = Buffer.alloc(16, 1).toString("base64"); // wrong length
    assert.strictEqual(crypto.getLinkSecretKey(), null);
  } finally {
    process.env.INVOICE_LINK_SECRET = saved;
  }
});

test("encryptAccessToken throws (fails closed) when INVOICE_LINK_SECRET is misconfigured", () => {
  const saved = process.env.INVOICE_LINK_SECRET;
  try {
    delete process.env.INVOICE_LINK_SECRET;
    assert.throws(() => crypto.encryptAccessToken("x", "a", "b"));
  } finally {
    process.env.INVOICE_LINK_SECRET = saved;
  }
});

// ---------------------------------------------------------------------
// money.js
// ---------------------------------------------------------------------

test("decimalDollarsToCents: whole dollars", () => {
  assert.strictEqual(money.decimalDollarsToCents("10"), 1000);
  assert.strictEqual(money.decimalDollarsToCents(10), 1000);
});

test("decimalDollarsToCents: two decimal places, exact (no float drift)", () => {
  assert.strictEqual(money.decimalDollarsToCents("349.00"), 34900);
  assert.strictEqual(money.decimalDollarsToCents("0.01"), 1);
  assert.strictEqual(money.decimalDollarsToCents("0.1"), 10);
  // The classic float trap: 0.1 + 0.2 !== 0.3 in IEEE-754. This helper
  // never multiplies by 100 as a float, so values like these must still
  // convert exactly.
  assert.strictEqual(money.decimalDollarsToCents("19.99"), 1999);
  assert.strictEqual(money.decimalDollarsToCents("1000000.07"), 100000007);
});

test("decimalDollarsToCents: negative values (balance computation needs these; Stripe calls never do)", () => {
  assert.strictEqual(money.decimalDollarsToCents("-5.00"), -500);
});

test("decimalDollarsToCents: rejects 3+ decimal places, scientific notation, commas, and non-numeric input", () => {
  assert.strictEqual(money.decimalDollarsToCents("10.005"), null);
  assert.strictEqual(money.decimalDollarsToCents("1e5"), null);
  assert.strictEqual(money.decimalDollarsToCents("1,000.00"), null);
  assert.strictEqual(money.decimalDollarsToCents("abc"), null);
  assert.strictEqual(money.decimalDollarsToCents(""), null);
  assert.strictEqual(money.decimalDollarsToCents(null), null);
  assert.strictEqual(money.decimalDollarsToCents(undefined), null);
  assert.strictEqual(money.decimalDollarsToCents("NaN"), null);
  assert.strictEqual(money.decimalDollarsToCents("Infinity"), null);
});

test("decimalDollarsToPositiveCents: rejects zero and negative, accepts positive", () => {
  assert.strictEqual(money.decimalDollarsToPositiveCents("0"), null);
  assert.strictEqual(money.decimalDollarsToPositiveCents("-1.00"), null);
  assert.strictEqual(money.decimalDollarsToPositiveCents("0.01"), 1);
});

test("centsToDecimalString: exact inverse of decimalDollarsToCents for representative values", () => {
  [1, 100, 1999, 34900, 100000007].forEach((cents) => {
    const str = money.centsToDecimalString(cents);
    assert.strictEqual(money.decimalDollarsToCents(str), cents);
  });
});

test("centsToDecimalString: negative cents format with a single leading minus", () => {
  assert.strictEqual(money.centsToDecimalString(-500), "-5.00");
});

test("centsToDecimalString: pads single-digit cents", () => {
  assert.strictEqual(money.centsToDecimalString(1005), "10.05");
  assert.strictEqual(money.centsToDecimalString(1001), "10.01");
});

console.log("\n" + (passed + failed) + " tests run, " + failed + " failed.");
if (failed > 0) process.exit(1);
