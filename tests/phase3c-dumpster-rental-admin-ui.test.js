// Static-analysis tests for Batch 2C's admin dumpster-rental UI: New Job's
// (previously entirely missing) rental fields, Edit Job's rental-date
// editing with the sticky manual-override contract, and booking-detail.js's
// manually-set indicator. Same approach as every other UI test in this
// suite (see tests/phase3c-job-editing.test.js's own header/tests) — this
// project has no DOM/jsdom harness, so client-side behavior is verified by
// reading the actual source text rather than executing it. The server-side
// handlers these call are exercised for real in
// tests/phase3c-dumpster-rental-admin.test.js.
//
// Run with:  node tests/phase3c-dumpster-rental-admin-ui.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function readNormalized(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

function sliceFunction(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "could not find " + JSON.stringify(startMarker));
  const braceStart = src.indexOf("{", startIdx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  throw new Error("unbalanced braces looking for the end of " + JSON.stringify(startMarker));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// New Job
// =======================================================================
test("admin/booking-new/index.html: the dumpster rental fields section exists, starts hidden, and has no separate Delivery Date field", () => {
  const html = readNormalized("admin/booking-new/index.html");
  assert.ok(/id="dumpster-fields-section"[^>]*style="display:none"/.test(html));
  ["pickup-date", "material-type", "placement-notes"].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"').test(html), "missing #" + id);
  });
  assert.ok(!/id="delivery-date"/.test(html), "delivery date must never be its own field — Appointment Date already is it");
});

test("admin/booking-new.js: the dumpster section is shown/hidden by the Service Type select, and starts correctly hidden for the default (junk_removal) selection", () => {
  const src = readNormalized("admin/booking-new.js");
  assert.ok(/serviceTypeSelect\.addEventListener\('change', updateDumpsterVisibility\)/.test(src));
  assert.ok(/function updateDumpsterVisibility\(\) \{\s*dumpsterSection\.style\.display = serviceTypeSelect\.value === 'dumpster_rental' \? 'block' : 'none';/.test(src));
  assert.ok(/updateDumpsterVisibility\(\);\s*\n\s*\/\//.test(src) || /updateDumpsterVisibility\(\);/.test(src), "must call it once on load, not only on change");
});

test("admin/booking-new.js: pickup date is only sent when the admin actually filled it in — never a client-invented default", () => {
  const src = readNormalized("admin/booking-new.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  assert.ok(/var pickupDateRaw = pickupDateInput\.value\.trim\(\);\s*if \(pickupDateRaw\) body\.pickupDate = pickupDateRaw;/.test(submitHandler));
});

test("admin/booking-new.js: dumpster fields are only added to the submit body when Service Type is dumpster_rental", () => {
  const src = readNormalized("admin/booking-new.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  const dumpsterBlock = submitHandler.slice(submitHandler.indexOf("Batch 2C"));
  assert.ok(/if \(body\.serviceType === 'dumpster_rental'\) \{/.test(dumpsterBlock));
});

// =======================================================================
// Edit Job
// =======================================================================
test("admin/booking-edit/index.html: the dumpster rental fields section exists with a pickup-date hint element", () => {
  const html = readNormalized("admin/booking-edit/index.html");
  assert.ok(/id="dumpster-fields-section"[^>]*style="display:none"/.test(html));
  ["pickup-date", "pickup-date-hint", "material-type", "placement-notes"].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"').test(html), "missing #" + id);
  });
});

test("admin/booking-edit.js: render() prefills pickup date/material/placement from data.dumpster and resets the touched flag on every load", () => {
  const src = readNormalized("admin/booking-edit.js");
  const fn = sliceFunction(src, "function render(data)");
  assert.ok(/loadedPickupDateIsManual = !!\(dumpster && dumpster\.pickupDateIsManual\)/.test(fn));
  assert.ok(/pickupTouchedThisSession = false;/.test(fn), "a fresh load must never carry over a stale 'touched' flag from a previous booking");
  assert.ok(/pickupDateInput\.value = dumpster \? dumpster\.pickupDate \|\| '' : '';/.test(fn));
});

test("admin/booking-edit.js: editing the pickup date field marks it touched for this session", () => {
  const src = readNormalized("admin/booking-edit.js");
  const fn = sliceFunction(src, "pickupDateInput.addEventListener('input', function () {");
  assert.ok(/pickupTouchedThisSession = true;/.test(fn));
});

test("admin/booking-edit.js: pickupDateManual sent on save is sticky — loaded-manual OR touched-this-session, never just one or the other alone", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  assert.ok(/var pickupDateIsManual = loadedPickupDateIsManual \|\| pickupTouchedThisSession;/.test(submitHandler));
  assert.ok(/body\.pickupDateManual = pickupDateIsManual;/.test(submitHandler));
});

test("admin/booking-edit.js: when NOT manual, pickupDate is never sent at all — the server is trusted to recompute it from the (possibly just-changed) delivery date", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  const dumpsterBlock = submitHandler.slice(submitHandler.indexOf("Batch 2C"));
  assert.ok(/if \(pickupDateIsManual\) body\.pickupDate = pickupDateInput\.value;/.test(dumpsterBlock), "pickupDate must only be included inside the manual branch");
});

test("admin/booking-edit.js: a manual pickup date left blank is rejected client-side before ever calling the API", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  const dumpsterBlock = submitHandler.slice(submitHandler.indexOf("Batch 2C"));
  assert.ok(/if \(pickupDateIsManual && !pickupDateInput\.value\) \{/.test(dumpsterBlock));
});

test("admin/booking-edit.js: pickup date's min stays in sync with the Appointment Date field, both on load and on every change", () => {
  const src = readNormalized("admin/booking-edit.js");
  assert.ok(/pickupDateInput\.min = appointmentDateInput\.value;/.test(src));
  assert.ok(/appointmentDateInput\.addEventListener\('change', function \(\) \{\s*pickupDateInput\.min = appointmentDateInput\.value;/.test(src));
});

// =======================================================================
// Booking detail — manually-set indicator
// =======================================================================
test("admin/booking-detail.js: pickup date shows a '(manually set)' suffix only when pickupDateIsManual is true", () => {
  const src = readNormalized("admin/booking-detail.js");
  assert.ok(/set\('d-pickup-date', formatDate\(data\.dumpster\.pickupDate\) \+ \(data\.dumpster\.pickupDateIsManual \? ' \(manually set\)' : ''\)\);/.test(src));
});

// =======================================================================
// innerHTML guard — re-asserted for the three files this batch touched
// =======================================================================
test("admin/booking-new.js, admin/booking-edit.js, admin/booking-detail.js still never use innerHTML/insertAdjacentHTML/document.write after Batch 2C's additions", () => {
  ["admin/booking-new.js", "admin/booking-edit.js", "admin/booking-detail.js"].forEach((rel) => {
    const src = readNormalized(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
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
