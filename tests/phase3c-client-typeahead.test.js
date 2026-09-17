// Local, offline test harness for the Phase 3C "Client Typeahead UX" work:
// replacing the "No client selected [Select Client]" bottom-sheet trigger
// on /admin/booking-new/ and /admin/booking-past/ with an inline, searchable
// typeahead in admin/client-picker.js. Same static-analysis approach as the
// existing XSS/write-audit guards in tests/phase3c-stage2-new-job.test.js
// and tests/phase3c-stage2.2-past-job.test.js — this project's test setup
// has no DOM/jsdom harness (see docs/phase-3/test-matrix.md), so client-side
// interaction/behavior is verified here by inspecting the actual source
// text, and the pre-existing offline harness already covers every backend
// contract (POST /api/admin/booking, POST /api/admin/client) this change
// deliberately leaves untouched.
//
// Run with:  node tests/phase3c-client-typeahead.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. The old "Select Client" button-first flow is gone from both pages.
// =======================================================================
test("admin/booking-new/index.html: no more 'No client selected [Select Client]' button flow", () => {
  const html = read("admin/booking-new/index.html");
  assert.ok(!/select-client-btn/.test(html), "select-client-btn must be removed");
  assert.ok(!/client-summary-empty/.test(html), "client-summary-empty must be removed");
  assert.ok(!/No client selected/.test(html), "the old placeholder copy must be removed");
  assert.ok(/id="client-picker-mount"/.test(html), "must provide a mount point for the shared client picker");
});

test("admin/booking-past/index.html: no more 'No client selected [Select Client]' button flow", () => {
  const html = read("admin/booking-past/index.html");
  assert.ok(!/select-client-btn/.test(html), "select-client-btn must be removed");
  assert.ok(!/client-summary-empty/.test(html), "client-summary-empty must be removed");
  assert.ok(!/No client selected/.test(html), "the old placeholder copy must be removed");
  assert.ok(/id="client-picker-mount"/.test(html), "must provide a mount point for the shared client picker");
});

// =======================================================================
// 2. Shared implementation — one picker, mounted the same way from both
//    pages, not two divergent implementations.
// =======================================================================
test("admin/booking-new.js and admin/booking-past.js both mount the shared AdminClientPicker into #client-picker-mount", () => {
  ["admin/booking-new.js", "admin/booking-past.js"].forEach((rel) => {
    const src = read(rel);
    assert.ok(/getElementById\(['"]client-picker-mount['"]\)/.test(src), rel + " must reference #client-picker-mount");
    assert.ok(/window\.AdminClientPicker\.mount\(/.test(src), rel + " must call AdminClientPicker.mount(...)");
    assert.ok(!/window\.AdminClientPicker\.open\(/.test(src), rel + " must not use the old modal-opening open() API");
  });
});

test("admin/client-picker.js exposes mount() (the old open()/close() modal-first API is gone)", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/return\s*\{\s*mount:\s*mount\s*\}/.test(src), "module must export { mount }");
  assert.ok(!/return\s*\{\s*open:\s*open/.test(src), "module must not still export the old open()-first API");
});

// =======================================================================
// 3. The typeahead itself: placeholder copy, debounce, no search on empty
//    input, results rendered under the input, never auto-selecting.
// =======================================================================
test("admin/client-picker.js: empty state invites typing directly, not a button click", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/Start typing a client name/.test(src), "must show the 'Start typing a client name...' placeholder");
});

test("admin/client-picker.js: search input is debounced before querying the client API", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/SEARCH_DEBOUNCE_MS/.test(src), "must define a debounce constant");
  const inputHandler = src.slice(src.indexOf('input.addEventListener("input"'));
  assert.ok(/setTimeout\(\s*function\s*\(\)\s*\{\s*runSearch\(value\);\s*\},\s*SEARCH_DEBOUNCE_MS\)/.test(inputHandler), "the search call itself must be wrapped in a SEARCH_DEBOUNCE_MS setTimeout, not fired synchronously per keystroke");
});

// =======================================================================
// Responsiveness polish: ~150ms debounce (down from 300ms), immediate
// loading feedback, and AbortController-based stale-response protection.
// =======================================================================
test("admin/client-picker.js: debounce is ~150ms, not the original 300ms", () => {
  const src = read("admin/client-picker.js");
  const match = src.match(/var SEARCH_DEBOUNCE_MS\s*=\s*(\d+)\s*;/);
  assert.ok(match, "must define SEARCH_DEBOUNCE_MS as a numeric literal");
  const ms = Number(match[1]);
  assert.ok(ms >= 100 && ms <= 200, "debounce should be roughly 150ms (found " + ms + "ms) — the owner found 300ms felt slow");
  assert.notStrictEqual(ms, 300, "must actually be reduced from the original 300ms");
});

test("admin/client-picker.js: typing shows immediate 'Searching...' feedback, independent of the debounce delay", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/function renderLoading\s*\(\)/.test(src), "must define a loading-state renderer");
  assert.ok(/Searching/.test(src), "must show a 'Searching...' style loading message");
  const inputHandler = src.slice(src.indexOf('input.addEventListener("input"'), src.indexOf('input.addEventListener("keydown"'));
  // renderLoading() must be called synchronously in the input handler,
  // BEFORE the debounced setTimeout — not inside it — so feedback appears
  // the instant the owner types rather than after SEARCH_DEBOUNCE_MS.
  const loadingCallIdx = inputHandler.indexOf("renderLoading();");
  const timeoutIdx = inputHandler.indexOf("setTimeout(");
  assert.ok(loadingCallIdx !== -1, "must call renderLoading() from the input handler");
  assert.ok(timeoutIdx !== -1, "must still schedule the debounced search");
  assert.ok(loadingCallIdx < timeoutIdx, "renderLoading() must run before the debounced setTimeout is scheduled, not inside its callback");
});

test("admin/client-picker.js: an obsolete in-flight search is cancelled via AbortController, not left to race a newer one", () => {
  const src = read("admin/client-picker.js");
  const runSearchBody = src.slice(src.indexOf("function runSearch"), src.indexOf("function runSearch") + src.slice(src.indexOf("function runSearch")).indexOf("\n    }\n") + 8);
  assert.ok(/new AbortController\(\)/.test(runSearchBody), "must create an AbortController per search");
  assert.ok(/abortInFlightSearch\(\)/.test(runSearchBody), "must cancel any previous in-flight search before starting a new one");
  assert.ok(/signal:\s*controller\.signal/.test(runSearchBody), "must actually wire the controller's signal into the fetch call");
});

test("admin/client-picker.js: a cancelled (AbortError) search is silently ignored, never shown as a failure", () => {
  const src = read("admin/client-picker.js");
  const runSearchBody = src.slice(src.indexOf("function runSearch"));
  const catchBlock = runSearchBody.slice(runSearchBody.indexOf(".catch(function (err)"));
  assert.ok(/err\s*&&\s*err\.name\s*===\s*["']AbortError["']/.test(catchBlock), "must detect an AbortError specifically");
  const abortCheckIdx = catchBlock.search(/err\.name\s*===\s*["']AbortError["']/);
  const errorMessageIdx = catchBlock.indexOf("Could not load clients right now.");
  assert.ok(abortCheckIdx !== -1 && errorMessageIdx !== -1 && abortCheckIdx < errorMessageIdx, "the AbortError check must come before (and bail out ahead of) rendering the 'could not load' error state");
});

test("admin/client-picker.js: clearing the input to empty also cancels any in-flight search, not just future ones", () => {
  const src = read("admin/client-picker.js");
  const inputHandler = src.slice(src.indexOf('input.addEventListener("input"'), src.indexOf('input.addEventListener("keydown"'));
  const emptyGuard = inputHandler.slice(inputHandler.indexOf("if (!value) {"), inputHandler.indexOf("return;", inputHandler.indexOf("if (!value) {")) + "return;".length);
  assert.ok(/abortInFlightSearch\(\)/.test(emptyGuard), "the empty-input guard must abort any pending request, not just skip scheduling a new one");
});

test("admin/client-picker.js: never queries the search API for empty/whitespace-only input", () => {
  const src = read("admin/client-picker.js");
  const inputHandler = src.slice(src.indexOf('input.addEventListener("input"'), src.indexOf('input.addEventListener("keydown"'));
  assert.ok(/if\s*\(!value\)\s*\{/.test(inputHandler), "must short-circuit before scheduling a search when the trimmed value is empty");
  // The guard branch must return without ever reaching runSearch/debounceTimer scheduling.
  const guardBlock = inputHandler.slice(inputHandler.indexOf("if (!value) {"), inputHandler.indexOf("return;", inputHandler.indexOf("if (!value) {")) + "return;".length);
  assert.ok(!/runSearch/.test(guardBlock), "the empty-input guard branch must not call runSearch");
});

test("admin/client-picker.js: reuses the existing GET /api/admin/clients search endpoint — no new endpoint", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/fetch\(\s*['"]\/api\/admin\/clients\?/.test(src.replace(/\s*\+\s*/g, "")) || /\/api\/admin\/clients\?limit=/.test(src), "must call the existing clients search endpoint");
  assert.ok(!/\/api\/admin\/client-search/.test(src), "must not introduce a new search-specific endpoint");
});

test("admin/client-picker.js: a result is only ever chosen via an explicit click handler, never auto-selected after search", () => {
  const src = read("admin/client-picker.js");
  const renderResultsBody = src.slice(src.indexOf("function renderResults"), src.indexOf("function runSearch"));
  assert.ok(/btn\.addEventListener\("click", function \(\) \{/.test(renderResultsBody), "each result button must only select on click");
  assert.ok(!/selectExisting\(/.test(renderResultsBody.replace(/btn\.addEventListener\("click", function \(\) \{[\s\S]*?\}\);/, "")), "selectExisting must not be invoked outside the click handler (e.g. automatically once results arrive)");
});

test("admin/client-picker.js: 'No matching clients' + a '+ Create Client' escape hatch are both present", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/No matching clients/.test(src), "must show 'No matching clients' when a search has no results");
  assert.ok(/\+ Create Client/.test(src), "must offer a '+ Create Client' action");
});

test("admin/client-picker.js: typed search text prefills Create Client's first name, never fabricating phone/email/address", () => {
  const src = read("admin/client-picker.js");
  const createToggleHandler = src.slice(src.indexOf('createToggle.addEventListener("click"'));
  assert.ok(/var typedName = input\.value\.trim\(\)/.test(createToggleHandler), "must capture the typed search text");
  assert.ok(/openCreateSheet\(typedName/.test(createToggleHandler), "must hand the typed text to the create sheet as the name prefill");
  const openCreateSheetSig = src.slice(src.indexOf("function openCreateSheet"), src.indexOf("function openCreateSheet") + 400);
  assert.ok(/firstName:\s*prefillFirstName/.test(openCreateSheetSig), "the prefill must only ever populate firstName — never phone/email/address");
});

// =======================================================================
// 4. Selecting/creating/clearing a client, and keyboard behavior.
// =======================================================================
test("admin/client-picker.js: selecting a client shows a compact summary with a way to change/remove the selection", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/changeBtn\.textContent = ['"]Change['"]/.test(src), "must offer a 'Change' control once a client is selected");
  const changeHandler = src.slice(src.indexOf('changeBtn.addEventListener("click"'));
  assert.ok(/onSelect\(null, \[\]\)/.test(changeHandler), "'Change' must clear the current selection (onSelect(null, ...)) rather than leaving a stale client selected behind a search box that visually reads as empty");
  assert.ok(/showEmpty\(true\)/.test(changeHandler), "'Change' must return to the typeahead's empty state and focus the input");
});

test("admin/client-picker.js: keyboard behavior — Enter never submits the surrounding job form, arrow keys navigate results, Escape closes the dropdown", () => {
  const src = read("admin/client-picker.js");
  const keydownHandler = src.slice(src.indexOf('input.addEventListener("keydown"'));
  assert.ok(/e\.key === ['"]Enter['"][\s\S]{0,200}e\.preventDefault\(\)/.test(keydownHandler), "Enter must always preventDefault to avoid submitting the job form the Client field lives in");
  assert.ok(/e\.key === ['"]ArrowDown['"]/.test(keydownHandler), "must handle ArrowDown");
  assert.ok(/e\.key === ['"]ArrowUp['"]/.test(keydownHandler), "must handle ArrowUp");
  assert.ok(/e\.key === ['"]Escape['"]/.test(keydownHandler), "must handle Escape");
});

test("admin/booking-new.js: onSelect(null, ...) (a cleared selection) disables 'same as client address', matching a client with no known address", () => {
  const src = read("admin/booking-new.js");
  const mountCall = src.slice(src.indexOf("window.AdminClientPicker.mount("));
  assert.ok(/if \(client && client\.address\)/.test(mountCall), "must guard the address-based enable check against a null client");
  assert.ok(/sameAsClientRow\.disabled = true/.test(mountCall), "must disable 'same as client address' when there is no selected client or no known address");
});

// =======================================================================
// 5. Regressions: XSS discipline, no new endpoint/serverless function, and
//    New Job / Past Job's write contracts are untouched by this UX change.
// =======================================================================
test("admin/client-picker.js, admin/booking-new.js, admin/booking-past.js never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/client-picker.js", "admin/booking-new.js", "admin/booking-past.js"].forEach((rel) => {
    const src = read(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

test("no new file was added under api/ (still reusing the existing authenticated client search API, no new Vercel function)", () => {
  const apiDir = path.join(__dirname, "..", "api");
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(apiDir, full) !== "_lib") walk(full);
      } else if (entry.name.endsWith(".js")) {
        files.push(path.relative(apiDir, full).replace(/\\/g, "/"));
      }
    });
  })(apiDir);
  assert.strictEqual(files.length, 12, "must stay at exactly 12 Vercel functions (Hobby-plan ceiling) — a client-picker UX task must not add a new api/ file");
  assert.ok(!files.some((f) => /client-picker|typeahead|client-search/i.test(f)), "must not introduce a dedicated search endpoint — the existing GET /api/admin/clients is reused as-is");
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
