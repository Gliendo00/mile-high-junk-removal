// Static-analysis tests for Batch 2's job-detail UI: Archive/Restore Job
// and the review-request checkbox, both on admin/booking-detail.js +
// admin/booking/index.html. Same approach as every other UI test in this
// suite (see tests/phase3c-job-editing.test.js's own header/tests) — this
// project has no DOM/jsdom harness, so client-side behavior is verified by
// reading the actual source text rather than executing it. The
// server-side handlers these call are exercised for real (not just
// statically) in tests/phase3c-job-archive-review.test.js.
//
// Run with:  node tests/phase3c-job-archive-review-ui.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function readNormalized(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// HTML — the new elements exist with the ids the JS depends on
// =======================================================================
test("admin/booking/index.html: review-request row and archive section elements all exist", () => {
  const html = readNormalized("admin/booking/index.html");
  ["d-review-request-row", "d-review-request-checkbox", "d-review-request-text", "d-archive-section", "d-archived-info", "d-archive-btn", "d-restore-btn"].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"').test(html), "missing #" + id);
  });
});

test("admin/booking/index.html: the review-request checkbox is a real <input type=checkbox>, not a styled div", () => {
  const html = readNormalized("admin/booking/index.html");
  assert.ok(/<input type="checkbox" id="d-review-request-checkbox">/.test(html));
});

test("admin/booking/index.html: Archive and Restore buttons both start hidden — renderArchiveState() decides which one shows", () => {
  const html = readNormalized("admin/booking/index.html");
  assert.ok(/id="d-archive-btn"[^>]*style="display:none"/.test(html));
  assert.ok(/id="d-restore-btn"[^>]*style="display:none"/.test(html));
});

// =======================================================================
// JS — never uses innerHTML/insertAdjacentHTML/document.write (this file
// already has a suite-wide guard elsewhere, but re-asserted here since this
// batch added a large new block of DOM-building code to the same file).
// =======================================================================
test("admin/booking-detail.js still never uses innerHTML/insertAdjacentHTML/document.write after Batch 2's additions", () => {
  const src = readNormalized("admin/booking-detail.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// =======================================================================
// Archive sheet validation + request shape
// =======================================================================
function sliceFunction(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "could not find " + JSON.stringify(startMarker));
  // Balance braces from the function's opening '{' to find its real end —
  // a plain indexOf("\n  }") is too fragile against nested blocks this
  // function actually has (if/forEach/addEventListener callbacks).
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

test("openArchiveSheet(): requires a reason before submitting", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  assert.ok(/if \(!reason\)/.test(fn), "must reject an empty reason client-side before ever calling the API");
});

test("openArchiveSheet(): requires a note specifically when reason is 'other'", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  assert.ok(/reason === 'other' && !note/.test(fn), "must require a note only for the 'other' reason, matching the server-side rule");
});

test("openArchiveSheet(): PATCHes ?resource=archive with action 'archive' and the id/reason/note", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  assert.ok(/adminFetch\('\/api\/admin\/booking\?resource=archive'/.test(fn));
  assert.ok(/method: 'PATCH'/.test(fn));
  assert.ok(/action: 'archive'/.test(fn));
  assert.ok(/id: bookingId/.test(fn));
  assert.ok(/reason: reason/.test(fn));
  assert.ok(/note: note/.test(fn));
});

test("openArchiveSheet(): all six required reasons are offered as options, matching the server-side allowlist exactly", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  const listed = fn.match(/\['client_canceled', 'duplicate_booking', 'test_spam', 'no_show', 'entered_by_mistake', 'other'\]/);
  assert.ok(listed, "the six reason keys must appear together, in the same order the server-side ARCHIVE_REASONS allowlist uses");
});

test("openRestoreSheet(): PATCHes ?resource=archive with action 'restore' and the id, no reason required", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function openRestoreSheet()");
  assert.ok(/adminFetch\('\/api\/admin\/booking\?resource=archive'/.test(fn));
  assert.ok(/action: 'restore'/.test(fn));
  assert.ok(/id: bookingId/.test(fn));
  assert.ok(!/reason/.test(fn), "restore must never send a reason field");
});

test("Archive/Restore buttons are wired to their respective sheets", () => {
  const src = readNormalized("admin/booking-detail.js");
  assert.ok(/archiveBtn\.addEventListener\('click', openArchiveSheet\)/.test(src));
  assert.ok(/restoreBtn\.addEventListener\('click', openRestoreSheet\)/.test(src));
});

test("renderArchiveState(): shows Archive when not archived, Restore + the info banner when archived", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function renderArchiveState(state)");
  assert.ok(/archiveBtn\.style\.display = 'none'/.test(fn));
  assert.ok(/restoreBtn\.style\.display = ''/.test(fn));
  assert.ok(/archivedInfoEl\.classList\.add\('is-visible'\)/.test(fn));
  assert.ok(/archiveBtn\.style\.display = ''/.test(fn));
  assert.ok(/restoreBtn\.style\.display = 'none'/.test(fn));
  assert.ok(/archivedInfoEl\.classList\.remove\('is-visible'\)/.test(fn));
});

// =======================================================================
// Review-request checkbox
// =======================================================================
test("review-request checkbox: PATCHes ?resource=review-request with action 'send' or 'clear' based on checked state", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "reviewRequestCheckbox.addEventListener('change', function () {");
  assert.ok(/adminFetch\('\/api\/admin\/booking\?resource=review-request'/.test(fn));
  assert.ok(/action: checking \? 'send' : 'clear'/.test(fn));
});

test("review-request checkbox: reverts the optimistic toggle on failure — never leaves the UI showing a state the server rejected", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "reviewRequestCheckbox.addEventListener('change', function () {");
  assert.ok(/\.catch\(function \(err\) \{\s*reviewRequestCheckbox\.checked = !checking;/.test(fn), "on error, the checkbox must be flipped back to its pre-click state");
});

test("review-request checkbox: guarded against a second change firing while one request is already in flight", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "reviewRequestCheckbox.addEventListener('change', function () {");
  assert.ok(/if \(reviewRequestInFlight\) return;/.test(fn));
  assert.ok(/reviewRequestInFlight = true;/.test(fn));
});

test("Payments section: the review-request row is shown only for a completed job, same rule as Tip", () => {
  const src = readNormalized("admin/booking-detail.js");
  const fn = sliceFunction(src, "function renderJobPayments(data)");
  const reviewBlock = fn.slice(fn.indexOf("Batch 2 — review-request tracking"));
  assert.ok(/currentStatus === 'completed'/.test(reviewBlock));
  assert.ok(/reviewRequestRow\.style\.display = ''/.test(reviewBlock));
  assert.ok(/reviewRequestRow\.style\.display = 'none'/.test(reviewBlock));
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
