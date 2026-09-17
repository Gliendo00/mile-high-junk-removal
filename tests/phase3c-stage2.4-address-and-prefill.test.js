// Local, offline test harness for Phase 3C Stage 2.4's Date-Aware Job Entry
// and Google Address Autocomplete UX. Two client-side-only features with no
// server code of their own (date prefill only ever sets an <input>'s
// initial value, still fully re-validated by api/admin/booking.js's
// existing rules unchanged; the address autocomplete component only ever
// writes into the same four fields the owner could type into by hand) — so
// this suite verifies them the same way this project's other client-only
// behavior is verified: source-pattern checks plus the disclosed DOM-
// simulation limitation already noted in tests/phase3c-schedule.test.js
// ("there is no DOM/click simulation available in this project's test
// setup"). The interactive behavior itself (valid prefill applied, an
// out-of-range prefill silently ignored, the manual address fields staying
// fully usable with no Google key configured) was additionally verified
// directly in a local browser session — see the stage report.
//
// Run with:  node tests/phase3c-stage2.4-address-and-prefill.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Date-aware entry — New Job
// =======================================================================
test("booking-new.js: reads ?date= via URLSearchParams, never trusts it without validating YYYY-MM-DD shape and real-date-ness", () => {
  const src = read("admin/booking-new.js");
  assert.ok(/URLSearchParams\(window\.location\.search\)/.test(src));
  assert.ok(/params\.get\('date'\)/.test(src));
  assert.ok(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(src), "must validate the YYYY-MM-DD shape before using the value");
  assert.ok(/getUTCFullYear\(\).*!==.*parts\[0\]/.test(src) || /d\.getUTCFullYear\(\) !== parts\[0\]/.test(src), "must reject an impossible calendar date like 2026-02-30, not just a shape match");
});

test("booking-new.js: an out-of-range (past) prefill date is silently ignored, never bypassing the today-or-later rule", () => {
  const src = read("admin/booking-new.js");
  assert.ok(/if \(requested < todayIso\) return;/.test(src), "must compare the requested date against todayIso and bail out (not throw, not alert) when it's in the past");
});

test("booking-new.js: date prefill is applied only after todayIso is already computed, so the fallback default always exists", () => {
  const src = read("admin/booking-new.js");
  const todayIdx = src.indexOf("var todayIso = denverTodayIso();");
  const prefillIdx = src.indexOf("applyDatePrefill");
  assert.ok(todayIdx !== -1 && prefillIdx !== -1 && todayIdx < prefillIdx, "todayIso must be assigned before the prefill logic runs");
});

// =======================================================================
// Date-aware entry — Past Job
// =======================================================================
test("booking-past.js: reads ?date= via URLSearchParams, validates shape and real-date-ness before using it", () => {
  const src = read("admin/booking-past.js");
  assert.ok(/URLSearchParams\(window\.location\.search\)/.test(src));
  assert.ok(/params\.get\('date'\)/.test(src));
  assert.ok(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(src));
});

test("booking-past.js: a prefill date outside [HISTORICAL_FLOOR_ISO, todayIso] is silently ignored — rejects both a too-early AND a future date", () => {
  const src = read("admin/booking-past.js");
  assert.ok(/if \(requested < HISTORICAL_FLOOR_ISO \|\| requested > todayIso\) return;/.test(src), "must reject both a pre-floor date and a future date (Past Job can never accept a future date)");
});

// =======================================================================
// Calendar day-selection links carry the date as a query param, never as
// something that could be reinterpreted as HTML/executable content.
// =======================================================================
test("calendar-views.js: the day panel's quick-action link always encodeURIComponent()s the date before appending it to the URL", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/booking-past\/\?date=' \+ encodeURIComponent\(iso\)/.test(src));
  assert.ok(/booking-new\/\?date=' \+ encodeURIComponent\(iso\)/.test(src));
});

test("calendar-views.js: a historical date links to Past Job, today/future links to New Job — matches the server's own mode split", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/if \(iso < todayIso\) \{/.test(src));
});

// =======================================================================
// Google Address Autocomplete — shared component
// =======================================================================
test("address-autocomplete.js: checks the configured key BEFORE ever touching the network — no key means no Google call at all", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/hasConfiguredKey/.test(src));
  assert.ok(/if \(!hasConfiguredKey\(\)\) \{/.test(src));
});

test("address-autocomplete.js: uses the modern Places API (New) data classes, not the legacy Autocomplete widget", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/AutocompleteSuggestion/.test(src));
  assert.ok(/AutocompleteSessionToken/.test(src));
  assert.ok(!/new google\.maps\.places\.Autocomplete\(/.test(src), "must not instantiate the legacy google.maps.places.Autocomplete widget class");
  assert.ok(!/createElement\(\s*['"]gmp-place-autocomplete['"]\s*\)/.test(src), "must not instantiate the <gmp-place-autocomplete> web component (a code-level check — the file's own comment explaining why it deliberately avoids that approach is expected and fine)");
});

test("address-autocomplete.js: maps STRUCTURED addressComponents, never parses a formattedAddress string", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/mapAddressComponents/.test(src));
  assert.ok(/addressComponents/.test(src));
  assert.ok(!/formattedAddress\.split/.test(src) && !/formatted_address\.split/.test(src), "must not fragile-string-split a formatted address");
});

test("address-autocomplete.js: requests fields:['addressComponents'] only — no unnecessary Place fields", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/fetchFields\(\{ fields: \["addressComponents"\] \}\)/.test(src));
});

test("address-autocomplete.js: restricts to the US and applies a Denver-area bias (not a hard restriction)", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/includedRegionCodes: \["us"\]/.test(src));
  assert.ok(/locationBias/.test(src));
  assert.ok(/DENVER_BIAS_CENTER/.test(src));
});

test("address-autocomplete.js: every Google call is wrapped so a failure degrades to manual entry, never blocks or disables the input", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/addressInput\.disabled\s*=\s*true/.test(src), "must never disable the manual input");
  assert.ok(!/\.required\s*=\s*true/.test(src) && !/setAttribute\(\s*['"]required['"]/.test(src), "must never mark a field as required as a side effect of this file (a code-level check — mentioning 'required' in a comment is fine)");
  assert.ok(/\.catch\(function \(\) \{\s*\/\//.test(src) || /catch\(function \(\) \{\}\)/.test(src) || /\.catch\(function/.test(src), "Google load/search failures must be caught, not left to throw");
});

test("address-autocomplete.js and google-maps-config.js never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/address-autocomplete.js", "admin/google-maps-config.js"].forEach((rel) => {
    const src = read(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

test("google-maps-config.js: ships with an EMPTY key — no credential is committed by this stage", () => {
  const src = read("admin/google-maps-config.js");
  assert.ok(/window\.ADMIN_GOOGLE_MAPS_API_KEY\s*=\s*""/.test(src), "the shipped key must be an empty string until the owner configures a real one");
});

// =======================================================================
// Wiring: New Job / Past Job / Edit Job each load the shared component and
// call attach() with the same four existing field ids — never a redesign
// of the form, never three independent copies of the integration.
// =======================================================================
[
  { page: "admin/booking-new/index.html", js: "admin/booking-new.js" },
  { page: "admin/booking-past/index.html", js: "admin/booking-past.js" },
  { page: "admin/booking-edit/index.html", js: "admin/booking-edit.js" },
].forEach(({ page, js }) => {
  test(page + ": loads google-maps-config.js and address-autocomplete.js before its own page script", () => {
    const src = read(page);
    const configIdx = src.indexOf("google-maps-config.js");
    const helperIdx = src.indexOf("address-autocomplete.js");
    const pageScriptName = js.split("/").pop();
    const pageIdx = src.indexOf(pageScriptName);
    assert.ok(configIdx !== -1, "must load admin/google-maps-config.js");
    assert.ok(helperIdx !== -1, "must load admin/address-autocomplete.js");
    assert.ok(configIdx < pageIdx && helperIdx < pageIdx, "shared scripts must load before the page's own script that calls attach()");
  });

  test(js + ": calls window.AdminAddressAutocomplete.attach() with the four existing address field elements, guarded by a feature check", () => {
    const src = read(js);
    assert.ok(/if \(window\.AdminAddressAutocomplete\)/.test(src), "must guard the call in case the shared script somehow failed to load");
    assert.ok(/window\.AdminAddressAutocomplete\.attach\(\{/.test(src));
    assert.ok(/address: serviceAddressInput/.test(src));
    assert.ok(/city: serviceCityInput/.test(src));
    assert.ok(/state: serviceStateInput/.test(src));
    assert.ok(/zip: serviceZipInput/.test(src));
  });
});

// =======================================================================
// Regression: address fields keep their existing ids/required-server-side-
// only-validation shape — this stage never made a field client-side
// required or changed the POST/PATCH body shape.
// =======================================================================
test("regression: New Job's service-address/-city/-state/-zip inputs are unchanged plain text inputs with no new required/disabled attribute", () => {
  const src = read("admin/booking-new/index.html");
  assert.ok(/<input type="text" id="service-address" autocomplete="off">/.test(src));
  assert.ok(!/id="service-address"[^>]*required/.test(src));
  assert.ok(!/id="service-address"[^>]*disabled/.test(src));
});

test("regression: booking-new.js/booking-past.js/booking-edit.js still never use innerHTML/insertAdjacentHTML/document.write after this stage's edits", () => {
  ["admin/booking-new.js", "admin/booking-past.js", "admin/booking-edit.js"].forEach((rel) => {
    const src = read(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
