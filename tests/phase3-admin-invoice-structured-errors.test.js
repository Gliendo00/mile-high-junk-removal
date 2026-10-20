// Phase 3 pre-merge audit, finding #7 — admin/invoice.js used to decide
// whether to re-prompt ("start a new send attempt?" / "void anyway?") by
// regex-matching the server's human-readable error TEXT
// (/unresolved/i, /could not be automatically recovered/i,
// /just paid by card/i). That's brittle: any wording change in
// api/admin/booking.js's error messages would silently break the
// re-prompt UX with no test failure.
//
// Fixed by: api/admin/booking.js and api/_lib/invoice-helpers.js now return
// stable structured fields (unresolvedSendExpired, unresolvedSendUnrecoverable,
// requiresConfirmation, reasonCode) alongside the free-text `error`/`message`;
// admin/invoice.js's patchInvoice() attaches the full response body onto the
// thrown Error (as `err.body`) instead of discarding everything but
// `.message`, and doSend()/doVoid() branch on those structured fields.
//
// This project has no DOM available in its test suite (see
// tests/agent-proposals-ui.test.js's header) — admin/invoice.js's actual
// handlers run inside a DOMContentLoaded listener this harness can't
// execute. Following that same established convention, this is a static
// source-text audit: it proves the brittle regexes are gone, the
// structured-field checks are present, and (server side) that every
// response path which admin/invoice.js re-prompts on actually sets the
// field it now checks — a real regression this audit caught: the
// decrypt-failure-discovered-just-now branch returned the same wording the
// regex matched, but WITHOUT unresolvedSendUnrecoverable set, which would
// have silently broken the re-prompt the moment the regex was removed.
//
// Run with:  node tests/phase3-admin-invoice-structured-errors.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

const invoiceJs = fs.readFileSync(path.join(__dirname, "..", "admin", "invoice.js"), "utf8");
const bookingJs = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "booking.js"), "utf8");
const invoiceHelpersJs = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "invoice-helpers.js"), "utf8");

// ---------------------------------------------------------------------
// Client: the brittle regexes must be gone for good.
// ---------------------------------------------------------------------

test("admin/invoice.js no longer regex-matches English error text to decide whether to re-prompt", () => {
  assert.ok(!/\/unresolved\/i/.test(invoiceJs), "the old /unresolved/i test should be removed");
  assert.ok(!/could not be automatically recovered\/i/.test(invoiceJs), "the old /could not be automatically recovered/i test should be removed");
  assert.ok(!/just paid by card\/i/.test(invoiceJs), "the old /just paid by card/i test should be removed");
});

test("admin/invoice.js's patchInvoice() attaches the full response body onto the thrown Error", () => {
  const fnMatch = invoiceJs.match(/function patchInvoice\(payload\) \{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, "expected to find patchInvoice()");
  const body = fnMatch[1];
  assert.ok(/err\.body\s*=\s*body/.test(body), "expected the thrown Error to carry the parsed response body as err.body");
  assert.ok(/throw err/.test(body));
});

test("admin/invoice.js's doSend() branches on unresolvedSendExpired/unresolvedSendUnrecoverable, not message text", () => {
  const fnMatch = invoiceJs.match(/function doSend\(confirmNewAttempt\) \{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, "expected to find doSend()");
  const body = fnMatch[1];
  assert.ok(/body\.unresolvedSendExpired/.test(body));
  assert.ok(/body\.unresolvedSendUnrecoverable/.test(body));
  assert.ok(!/\/unresolved\//i.test(body) && !/test\(msg\)/.test(body), "doSend() should not test(msg) with a regex anymore");
});

test("admin/invoice.js's doVoid() branches on requiresConfirmation, not message text", () => {
  const fnMatch = invoiceJs.match(/function doVoid\(reason, confirmVoidPaidInvoice\) \{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, "expected to find doVoid()");
  const body = fnMatch[1];
  assert.ok(/body\.requiresConfirmation/.test(body));
  assert.ok(!/test\(msg\)/.test(body), "doVoid() should not test(msg) with a regex anymore");
});

// ---------------------------------------------------------------------
// Server: every response path the client re-prompts on must actually set
// the structured field it now checks.
// ---------------------------------------------------------------------

test("api/admin/booking.js: the Send 23h-expiry 409 sets unresolvedSendExpired:true", () => {
  const block = bookingJs.match(/if \(ageMs >= SEND_RECOVERY_WINDOW_MS[\s\S]*?res\.status\(409\)\.json\(\{([\s\S]*?)\}\);/);
  assert.ok(block, "expected the 23h-expiry 409 response block");
  assert.ok(/unresolvedSendExpired:\s*true/.test(block[1]));
});

test("api/admin/booking.js: BOTH unrecoverable-send 409 paths set unresolvedSendUnrecoverable:true (decrypt-failure-just-now, and already-unrecoverable-on-a-later-click)", () => {
  const matches = bookingJs.match(/res\.status\(409\)\.json\(\{\s*unresolvedSendUnrecoverable:\s*true,/g) || [];
  assert.strictEqual(matches.length, 2, "expected exactly two 409 responses setting unresolvedSendUnrecoverable:true — one for a decrypt failure discovered in this same request, one for an already-recorded unrecoverable attempt on a later click");
});

test("api/_lib/invoice-helpers.js: the void-paid-invoice confirmation response sets requiresConfirmation:true and a stable reasonCode", () => {
  const block = invoiceHelpersJs.match(/resolution\.reconciled && purpose === "invoice_void"[\s\S]*?return (\{[\s\S]*?\});/);
  assert.ok(block, "expected the invoice_void requiresConfirmation return statement");
  assert.ok(/requiresConfirmation:\s*true/.test(block[1]));
  assert.ok(/reasonCode:\s*"invoice_void_requires_confirmation"/.test(block[1]));
});

test("api/admin/booking.js's void action forwards the full lockResult (so requiresConfirmation/reasonCode reach the client) rather than just an error string", () => {
  assert.ok(/if \(lockResult\.requiresConfirmation\) \{\s*res\.status\(409\)\.json\(Object\.assign\(\{ error: lockResult\.message \}, lockResult\)\);/.test(bookingJs));
});

console.log("\n" + (passed + failed) + " tests run, " + failed + " failed.");
if (failed > 0) process.exit(1);
