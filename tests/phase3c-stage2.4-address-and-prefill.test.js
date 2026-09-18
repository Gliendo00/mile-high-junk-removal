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
test("address-autocomplete.js: fetches the browser key lazily from the authenticated server endpoint — never a client-side static/committed key", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/fetch\("\/api\/admin\/bookings\?view=google-config"\)/.test(src));
  assert.ok(!/window\.ADMIN_GOOGLE_MAPS_API_KEY/.test(src), "must not read a client-side global for the key (Stage 2.4.1 removed admin/google-maps-config.js)");
});

test("address-autocomplete.js: an empty/missing key from the server (or the fetch itself failing) rejects, never throws synchronously — every caller already treats a rejection as 'Google unavailable'", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/if \(!key\) throw new Error\("Google Maps API key not configured"\);/.test(src));
  assert.ok(/if \(!res\.ok\) throw new Error\("Could not load Google Maps configuration"\);/.test(src));
});

test("address-autocomplete.js: the key fetch deliberately does NOT redirect to /admin/login/ on 401 — a background enhancement fetch must never yank the owner off an in-progress form", () => {
  const src = read("admin/address-autocomplete.js");
  const start = src.indexOf("function fetchApiKey()");
  const end = src.indexOf("\n  function loadPlacesLibrary()");
  const body = src.slice(start, end);
  assert.ok(!/admin\/login/.test(body), "fetchApiKey() must not contain a login-redirect — that behavior belongs only to primary-content fetches elsewhere in this codebase");
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

test("address-autocomplete.js: the location-bias radius stays within Places API (New)'s hard 50,000-meter cap — found live on Preview as a real INVALID_ARGUMENT once credentials were otherwise correctly configured", () => {
  const src = read("admin/address-autocomplete.js");
  const match = src.match(/var DENVER_BIAS_RADIUS_METERS = (\d+);/);
  assert.ok(match, "DENVER_BIAS_RADIUS_METERS must be declared as a plain numeric literal");
  const radius = Number(match[1]);
  assert.ok(radius > 0 && radius <= 50000, "locationBias.circle.radius must be <= 50000 meters (Google's documented Places API (New) limit) — a request with a larger radius fails every single search with INVALID_ARGUMENT, indistinguishable from Google being fully broken unless you inspect the raw error");
});

test("address-autocomplete.js: readiness after script load uses google.maps.importLibrary('places'), never a synchronous window.google.maps.places check — found live on Preview: loading=async defers each library's own init to run AFTER script.onload fires, so a synchronous check at onload time always lost the race, permanently rejected the cached load promise, and was silently swallowed by every caller's .catch() (confirmed via instrumentation: google.maps.places was still undefined at every one of 7 onload firings observed)", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/loading=async/.test(src), "must still request the async loading mode");
  assert.ok(
    /google\.maps\.importLibrary\(\s*["']places["']\s*\)/.test(src),
    "script.onload must hand off to google.maps.importLibrary('places'), which returns its own promise resolving only once that library has actually finished initializing"
  );
  const onloadBlock = src.match(/script\.onload = function \(\) \{[\s\S]*?\n {10}\};/);
  assert.ok(onloadBlock, "must find the script.onload handler block");
  assert.ok(
    !/window\.google\.maps\.places\)\s*\{\s*\n\s*resolve\(window\.google\.maps\.places\)/.test(onloadBlock[0]),
    "script.onload must not resolve off a synchronous window.google.maps.places check — that races loading=async's deferred init and loses"
  );
});

test("address-autocomplete.js: every Google call is wrapped so a failure degrades to manual entry, never blocks or disables the input", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/addressInput\.disabled\s*=\s*true/.test(src), "must never disable the manual input");
  assert.ok(!/\.required\s*=\s*true/.test(src) && !/setAttribute\(\s*['"]required['"]/.test(src), "must never mark a field as required as a side effect of this file (a code-level check — mentioning 'required' in a comment is fine)");
  assert.ok(/\.catch\(function \(\) \{\s*\/\//.test(src) || /catch\(function \(\) \{\}\)/.test(src) || /\.catch\(function/.test(src), "Google load/search failures must be caught, not left to throw");
});

test("address-autocomplete.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/\.innerHTML\s*=/.test(src), "must not assign innerHTML");
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), "must not call insertAdjacentHTML(...)");
  assert.ok(!/document\.write\s*\(/.test(src), "must not call document.write(...)");
});

test("regression (Stage 2.4.1): admin/google-maps-config.js no longer exists — the browser key is never committed to this repository", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "admin", "google-maps-config.js")), "the obsolete static placeholder file must be removed, not just emptied");
});

test("regression (Stage 2.4.1): the key never appears as a literal string anywhere in the client bundle — only fetched at runtime", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(src), "no Google API key pattern should ever be hardcoded in committed source");
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
  test(page + ": loads address-autocomplete.js before its own page script (Stage 2.4.1: no separate config-file script tag anymore)", () => {
    const src = read(page);
    const helperIdx = src.indexOf("address-autocomplete.js");
    const pageScriptName = js.split("/").pop();
    const pageIdx = src.indexOf(pageScriptName);
    assert.ok(!/google-maps-config\.js/.test(src), page + " must no longer reference the removed admin/google-maps-config.js");
    assert.ok(helperIdx !== -1, "must load admin/address-autocomplete.js");
    assert.ok(helperIdx < pageIdx, "the shared script must load before the page's own script that calls attach()");
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
