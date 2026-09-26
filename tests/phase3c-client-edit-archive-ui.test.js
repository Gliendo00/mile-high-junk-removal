// Static-analysis tests for Batch 2D's client-page UI: Edit Client,
// Archive/Restore Client (admin/client-detail.js), and the Clients page's
// Show Archived toggle (admin/clients-list.js). Same approach as every
// other UI test in this suite (see tests/phase3c-job-archive-review-ui
// .test.js's own header/tests) — this project has no DOM/jsdom harness, so
// client-side behavior is verified by reading the actual source text
// rather than executing it. The server-side handlers these call are
// exercised for real in tests/phase3c-client-edit-archive.test.js.
//
// Run with:  node tests/phase3c-client-edit-archive-ui.test.js
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
// HTML
// =======================================================================
test("admin/client/index.html: Edit/Archive/Restore elements and the toast container all exist", () => {
  const html = readNormalized("admin/client/index.html");
  ["c-edit-btn", "c-archive-section", "c-archived-info", "c-archive-btn", "c-restore-btn", "admin-toast"].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"').test(html), "missing #" + id);
  });
});

test("admin/client/index.html: Archive and Restore buttons both start hidden", () => {
  const html = readNormalized("admin/client/index.html");
  assert.ok(/id="c-archive-btn"[^>]*style="display:none"/.test(html));
  assert.ok(/id="c-restore-btn"[^>]*style="display:none"/.test(html));
});

test("admin/clients/index.html: the Show Archived toggle button exists", () => {
  const html = readNormalized("admin/clients/index.html");
  assert.ok(/id="show-archived-btn"/.test(html));
});

// =======================================================================
// JS — never uses innerHTML/insertAdjacentHTML/document.write
// =======================================================================
test("admin/client-detail.js, admin/clients-list.js still never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/client-detail.js", "admin/clients-list.js"].forEach((rel) => {
    const src = readNormalized(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// =======================================================================
// Edit Client
// =======================================================================
test("openEditSheet(): requires a first name before submitting", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openEditSheet()");
  assert.ok(/if \(!firstNameInput\.value\.trim\(\)\)/.test(fn));
});

test("openEditSheet(): PATCHes /api/admin/client with the full field set, never a customerId or bookings field", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openEditSheet()");
  assert.ok(/adminFetch\('\/api\/admin\/client', \{/.test(fn));
  assert.ok(/method: 'PATCH'/.test(fn));
  ["firstName", "lastName", "phone", "email", "address", "city", "state", "zip"].forEach((field) => {
    assert.ok(new RegExp(field + ":").test(fn), "missing " + field + " in the PATCH body");
  });
  assert.ok(!/customerId/.test(fn), "must never send a customerId — the client on a job/its own id is never reassignable from this form");
  assert.ok(!/bookingId/.test(fn));
});

test("openEditSheet(): a successful save updates the page in place (applyClientIdentity), no full reload", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openEditSheet()");
  assert.ok(/applyClientIdentity\(currentClient\);/.test(fn));
  assert.ok(!/window\.location\.reload/.test(fn));
});

test("Edit button is wired to openEditSheet", () => {
  const src = readNormalized("admin/client-detail.js");
  assert.ok(/editBtn\.addEventListener\('click', openEditSheet\)/.test(src));
});

// =======================================================================
// Archive / Restore
// =======================================================================
test("openArchiveSheet(): requires a reason, and a note specifically for 'other'", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  assert.ok(/if \(!reason\)/.test(fn));
  assert.ok(/reason === 'other' && !note/.test(fn));
});

test("openArchiveSheet(): all five required reasons are offered, matching the server-side allowlist exactly", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  const listed = fn.match(/\['duplicate_client', 'test_spam', 'requested_removal', 'entered_by_mistake', 'other'\]/);
  assert.ok(listed, "the five reason keys must appear together, in the same order the server-side ARCHIVE_REASONS allowlist uses");
});

test("openArchiveSheet(): PATCHes /api/admin/client with action 'archive'", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openArchiveSheet()");
  assert.ok(/action: 'archive'/.test(fn));
  assert.ok(/id: currentClientId/.test(fn));
});

test("openRestoreSheet(): PATCHes /api/admin/client with action 'restore', no reason required", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function openRestoreSheet()");
  assert.ok(/action: 'restore'/.test(fn));
  assert.ok(!/reason/.test(fn), "restore must never send a reason field");
});

test("Archive/Restore buttons are wired to their respective sheets", () => {
  const src = readNormalized("admin/client-detail.js");
  assert.ok(/archiveBtn\.addEventListener\('click', openArchiveSheet\)/.test(src));
  assert.ok(/restoreBtn\.addEventListener\('click', openRestoreSheet\)/.test(src));
});

test("renderArchiveState(): shows Archive when not archived, Restore + the info banner when archived", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function renderArchiveState(client)");
  assert.ok(/archiveBtn\.style\.display = 'none'/.test(fn));
  assert.ok(/restoreBtn\.style\.display = ''/.test(fn));
  assert.ok(/archivedInfoEl\.classList\.add\('is-visible'\)/.test(fn));
  assert.ok(/archiveBtn\.style\.display = ''/.test(fn));
  assert.ok(/restoreBtn\.style\.display = 'none'/.test(fn));
  assert.ok(/archivedInfoEl\.classList\.remove\('is-visible'\)/.test(fn));
});

test("render() calls renderArchiveState() so the archive state is correct on every fresh load", () => {
  const src = readNormalized("admin/client-detail.js");
  const fn = sliceFunction(src, "function render(data)");
  assert.ok(/renderArchiveState\(client\);/.test(fn));
});

// =======================================================================
// Clients list — Show Archived toggle
// =======================================================================
test("clients-list.js: the toggle flips showArchived, updates its own label/pressed state, and reloads the list", () => {
  const src = readNormalized("admin/clients-list.js");
  const fn = sliceFunction(src, "showArchivedBtn.addEventListener('click', function () {");
  assert.ok(/showArchived = !showArchived;/.test(fn));
  assert.ok(/showArchivedBtn\.setAttribute\('aria-pressed'/.test(fn));
  assert.ok(/resetAndLoad\(\);/.test(fn));
});

test("clients-list.js: loadPage() sends archivedOnly=1 only when the toggle is on", () => {
  const src = readNormalized("admin/clients-list.js");
  const fn = sliceFunction(src, "function loadPage()");
  assert.ok(/if \(showArchived\) url \+= '&archivedOnly=1';/.test(fn));
});

test("clients-list.js: the empty state names the archived view specifically when it's the active one", () => {
  const src = readNormalized("admin/clients-list.js");
  const fn = sliceFunction(src, "function loadPage()");
  assert.ok(/No archived clients\./.test(fn));
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
