// Local, offline test harness for Batch 4 (A) — the shared US phone
// display formatter (admin/phone-format.js's window.formatPhone()) and its
// application across the admin CRM. Presentation only: customers.phone is
// stored exactly as typed (see api/admin/client.js/api/book.js — never
// reformatted on write), so this formatter normalizes whatever shape is on
// file ("3035551234", "(303) 555-1234", "303.555.0100", "+13035551234",
// etc.) to one consistent "(303) 555-1234" display string, without ever
// touching the underlying stored value or the digits-only value every
// buildTelHref()/buildSmsHref() (admin-side) and normalizePhone()
// (server-side, api/_lib/customer-identity.js) already derive independently
// for matching/search/texting/calling.
//
// Two-part approach, same as every prior admin-client-JS test file in this
// project (see tests/phase3c-client-typeahead.test.js's own header for why
// there's no jsdom/DOM harness here): (1) a real vm execution of the pure
// formatPhone() function itself — trivial, since it has zero DOM
// dependency; (2) static-analysis source checks proving every genuine
// DISPLAY call site was updated to call it, and — just as important — that
// every EDITABLE input field and raw passthrough value was deliberately
// left alone.
//
// Run with:  node tests/phase3c-batch4-phone-format.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. formatPhone() itself — loaded as the real, unmodified source into a
// vm sandbox (it only ever touches `window`, no document/fetch needed).
// =======================================================================
function loadFormatPhone() {
  const src = read("admin/phone-format.js");
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "admin/phone-format.js" });
  return sandbox.formatPhone;
}
const formatPhone = loadFormatPhone();

test("formatPhone: a plain 10-digit US number", () => {
  assert.strictEqual(formatPhone("3035551234"), "(303) 555-1234");
});
test("formatPhone: dash-separated US number", () => {
  assert.strictEqual(formatPhone("303-555-1234"), "(303) 555-1234");
});
test("formatPhone: dot-separated US number", () => {
  assert.strictEqual(formatPhone("303.555.1234"), "(303) 555-1234");
});
test("formatPhone: already-formatted '(303) 555-1234' is idempotent (reformats to the exact same string)", () => {
  assert.strictEqual(formatPhone("(303) 555-1234"), "(303) 555-1234");
});
test("formatPhone: +1 country code prefix", () => {
  assert.strictEqual(formatPhone("+13035551234"), "(303) 555-1234");
});
test("formatPhone: +1 with spaces/parens/dashes together", () => {
  assert.strictEqual(formatPhone("+1 (303) 555-0100"), "(303) 555-0100");
});
test("formatPhone: leading '1' without a '+' (11 digits, same as a dialed long-distance number)", () => {
  assert.strictEqual(formatPhone("13035551234"), "(303) 555-1234");
});
test("formatPhone: null -> empty string, never a crash or 'null' text", () => {
  assert.strictEqual(formatPhone(null), "");
});
test("formatPhone: undefined -> empty string", () => {
  assert.strictEqual(formatPhone(undefined), "");
});
test("formatPhone: empty string -> empty string", () => {
  assert.strictEqual(formatPhone(""), "");
});
test("formatPhone: whitespace-only -> empty string", () => {
  assert.strictEqual(formatPhone("   "), "");
});
test("formatPhone: an international number is left byte-for-byte untouched, never mangled into a fake US grouping", () => {
  assert.strictEqual(formatPhone("+44 20 7946 0958"), "+44 20 7946 0958");
});
test("formatPhone: a short/garbled legacy value (not 10 digits) is left untouched rather than guessed at", () => {
  assert.strictEqual(formatPhone("303-555"), "303-555");
});
test("formatPhone: a value with an extension is left untouched (never silently truncates the extension digit)", () => {
  assert.strictEqual(formatPhone("303-555-1234 ext 2"), "303-555-1234 ext 2");
});
test("formatPhone: a number value (not a string) is handled the same as its string form", () => {
  assert.strictEqual(formatPhone(3035551234), "(303) 555-1234");
});

// =======================================================================
// 2. Display call sites — every file that shows a stored phone number as
// visible text must call formatPhone() there. Static-analysis (source
// regex), same approach every other admin-client-JS test file in this
// project already uses.
// =======================================================================
const DISPLAY_CALL_SITES = [
  { file: "admin/booking-detail.js", pattern: /phoneLink\.textContent = formatPhone\(customer\.phone\)/g, expectedCount: 2 },
  { file: "admin/client-detail.js", pattern: /phoneLink\.textContent = formatPhone\(client\.phone\)/g, expectedCount: 4 },
  { file: "admin/client-picker.js", pattern: /formatPhone\(existingClient\.phone\)/g, expectedCount: 1 },
  { file: "admin/client-picker.js", pattern: /formatPhone\(client\.phone\)/g, expectedCount: 1 },
  { file: "admin/client-picker.js", pattern: /formatPhone\(c\.phone\)/g, expectedCount: 1 },
  { file: "admin/clients-list.js", pattern: /formatPhone\(c\.phone\)/g, expectedCount: 1 },
  { file: "admin/booking-edit.js", pattern: /formatPhone\(customer\.phone\)/g, expectedCount: 1 },
];

DISPLAY_CALL_SITES.forEach(function (site) {
  test(site.file + ": " + site.pattern + " appears exactly " + site.expectedCount + " time(s) (every phone DISPLAY call site formatted)", () => {
    const src = read(site.file);
    const matches = src.match(site.pattern) || [];
    assert.strictEqual(matches.length, site.expectedCount, "found " + matches.length + " in " + site.file);
  });
});

// =======================================================================
// 3. Editable inputs and raw passthrough values must NEVER be wrapped in
// formatPhone() — reformatting an <input>'s value would corrupt what gets
// resubmitted on save, and wrapping a passthrough object would just move
// the formatting decision to the wrong layer (the eventual display site
// already formats it itself).
// =======================================================================
test("admin/client-detail.js: the Edit Client phone <input> is prefilled with the RAW stored value, never formatPhone()'d", () => {
  const src = read("admin/client-detail.js");
  assert.ok(/textInput\(currentClient\.phone\)/.test(src), "expected the raw prefill to still be present");
  assert.ok(!/textInput\(formatPhone\(currentClient\.phone\)\)/.test(src), "the Edit Client phone input must never be pre-formatted — it would corrupt what gets saved back");
});

test("admin/client-picker.js: the inline Create Client phone <input> is prefilled with the RAW value, never formatPhone()'d", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/field\("Phone \(optional\)", "tel", prefill\.phone\)/.test(src));
  assert.ok(!/field\("Phone \(optional\)", "tel", formatPhone\(prefill\.phone\)\)/.test(src));
});

test("admin/client-picker.js: selectExisting()'s raw passthrough object keeps the RAW phone value (the eventual display call formats it, not this pass-through)", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/selectExisting\(\{ id: c\.id, firstName: c\.firstName, lastName: c\.lastName, phone: c\.phone, email: c\.email \}\)/.test(src));
});

// =======================================================================
// 4. tel:/sms: href builders must keep deriving digits from the RAW phone,
// never from formatPhone()'s display string — they already strip
// non-digits themselves, so formatting the input would be redundant at
// best and is never required for them to work correctly either way, but
// this guards against a future edit accidentally routing the formatted
// string through them instead of the raw one.
// =======================================================================
["admin/booking-detail.js", "admin/client-detail.js", "admin/schedule.js"].forEach(function (file) {
  test(file + ": buildTelHref()/buildSmsHref() still take the raw phone, not a formatPhone() call", () => {
    const src = read(file);
    assert.ok(!/buildTelHref\(formatPhone\(/.test(src), file + ": buildTelHref must never be called with a pre-formatted string");
    assert.ok(!/buildSmsHref\(formatPhone\(/.test(src), file + ": buildSmsHref must never be called with a pre-formatted string");
  });
});

// =======================================================================
// 5. Every admin page whose script actually displays a phone number loads
// admin/phone-format.js BEFORE that script — same load-order convention
// this project already uses for admin-fetch.js before every script that
// calls adminFetch().
// =======================================================================
const PAGES_NEEDING_PHONE_FORMAT = [
  { html: "admin/booking/index.html", consumer: "../booking-detail.js" },
  { html: "admin/client/index.html", consumer: "../client-detail.js" },
  { html: "admin/booking-new/index.html", consumer: "../client-picker.js" },
  { html: "admin/booking-past/index.html", consumer: "../client-picker.js" },
  { html: "admin/clients/index.html", consumer: "../clients-list.js" },
  { html: "admin/booking-edit/index.html", consumer: "../booking-edit.js" },
];

PAGES_NEEDING_PHONE_FORMAT.forEach(function (page) {
  test(page.html + ": loads phone-format.js before " + page.consumer, () => {
    const html = read(page.html);
    const phoneFormatIdx = html.indexOf('src="../phone-format.js"');
    const consumerIdx = html.indexOf('src="' + page.consumer + '"');
    assert.ok(phoneFormatIdx !== -1, "phone-format.js script tag not found");
    assert.ok(consumerIdx !== -1, page.consumer + " script tag not found");
    assert.ok(phoneFormatIdx < consumerIdx, "phone-format.js must load before " + page.consumer);
  });
});

// Pages that deliberately do NOT need it — confirmed by inspection that
// neither ever displays a raw phone number as text: the Schedule page
// (admin/schedule.js) only ever builds tel:/sms: hrefs for fixed-label
// Call/Text buttons, never prints the number itself; the Requests page
// (admin/dashboard.js) shows a job card's client name only, with phone/
// Call/Text left entirely to the booking detail page; Expenses
// (admin/expenses.js) never shows a client phone at all (its job picker
// shows name + date + service only).
test("admin/index.html, admin/requests/index.html, admin/expenses/index.html: do NOT load phone-format.js — none of their scripts display a raw phone number", () => {
  ["admin/index.html", "admin/requests/index.html", "admin/expenses/index.html"].forEach(function (rel) {
    const html = read(rel);
    assert.ok(html.indexOf("phone-format.js") === -1, rel + " should not load phone-format.js");
  });
  assert.ok(!/\.textContent = .*\.phone\b/.test(read("admin/schedule.js")), "admin/schedule.js must still never print a raw phone number as text");
  assert.ok(!/\.phone\b/.test(read("admin/dashboard.js")), "admin/dashboard.js must still never reference a customer's phone at all");
});

// =======================================================================
// 6. innerHTML/insertAdjacentHTML/document.write discipline — the new
// shared file, same guard every other admin script in this project has.
// =======================================================================
test("admin/phone-format.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const src = read("admin/phone-format.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ name: t.name, ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();
