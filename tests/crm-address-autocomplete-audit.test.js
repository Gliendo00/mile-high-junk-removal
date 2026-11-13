// CRM address-autocomplete audit (2026-11) — regression tests for every CRM
// screen that collects a physical address, plus behavioral tests for the
// shared admin/address-autocomplete.js component.
//
// Unlike the older source-pattern suites, the behavioral half here runs
// the REAL admin/address-autocomplete.js inside a Node `vm` context against
// a minimal fake DOM, a stubbed google.maps.places (Places API (New) data
// classes) and a stubbed fetch() — so typing, keyboard navigation,
// mouse/touch selection, field population, idempotent re-attach, retry
// after a failed load, and the permission-denied fallback are exercised
// end to end without a browser or a real Google key.
//
// Run with:  node tests/crm-address-autocomplete-audit.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Minimal fake DOM — only what address-autocomplete.js actually touches.
// =======================================================================
class FakeEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = Boolean(init && init.bubbles);
    this.key = init && init.key;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.target = null;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class Listeners {
  constructor() { this.map = {}; }
  add(type, fn, opts) {
    (this.map[type] = this.map[type] || []).push({ fn, once: Boolean(opts && opts.once) });
  }
  remove(type, fn) {
    this.map[type] = (this.map[type] || []).filter((l) => l.fn !== fn);
  }
  fire(type, self, event) {
    (this.map[type] || []).slice().forEach((l) => {
      if (l.once) this.remove(type, l.fn);
      l.fn.call(self, event);
    });
  }
  count(type) { return (this.map[type] || []).length; }
}

function makeDocument() {
  const doc = { listeners: new Listeners() };
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attrs = {};
      this.style = {};
      this.listeners = new Listeners();
      this.value = "";
      this.textContent = "";
      this.className = "";
      this.id = "";
      const self = this;
      this.classList = {
        toggle(c, on) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c);
          self.className = Array.from(set).join(" ");
        },
        contains(c) { return self.className.split(/\s+/).includes(c); },
      };
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === doc.body; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn, o) { this.listeners.add(t, fn, o); }
    removeEventListener(t, fn) { this.listeners.remove(t, fn); }
    scrollIntoView() {}
    dispatchEvent(e) {
      e.target = e.target || this;
      for (let n = this; n; n = e.bubbles ? n.parentNode : null) {
        n.listeners.fire(e.type, n, e);
        if (e.propagationStopped) return !e.defaultPrevented;
      }
      if (e.bubbles) doc.listeners.fire(e.type, doc, e);
      return !e.defaultPrevented;
    }
    click() { this.dispatchEvent(new FakeEvent("click", { bubbles: true })); }
  }
  doc.createElement = (tag) => new FakeElement(tag);
  doc.body = new FakeElement("body");
  doc.head = new FakeElement("head");
  doc.addEventListener = (t, fn, o) => doc.listeners.add(t, fn, o);
  doc.removeEventListener = (t, fn) => doc.listeners.remove(t, fn);
  return doc;
}

// Stubbed Places API (New) — AutocompleteSuggestion / AutocompleteSessionToken
// / placePrediction.toPlace().fetchFields(), the only surface the component uses.
function makePlaces(opts) {
  const calls = { searches: [] };
  const places = {
    AutocompleteSessionToken: function () {},
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions(req) {
        calls.searches.push(req.input);
        if (opts && opts.searchError) return Promise.reject(opts.searchError);
        return Promise.resolve({
          suggestions: [
            prediction("1600 Glenarm Place", "Denver, CO, USA", [
              { types: ["street_number"], longText: "1600" },
              { types: ["route"], longText: "Glenarm Place" },
              { types: ["locality", "political"], longText: "Denver" },
              { types: ["administrative_area_level_1"], longText: "Colorado", shortText: "CO" },
              { types: ["postal_code"], longText: "80202" },
            ]),
            prediction("1600 Pennsylvania St", "Denver, CO, USA", [
              { types: ["street_number"], longText: "1600" },
              { types: ["route"], longText: "Pennsylvania Street" },
              { types: ["locality"], longText: "Denver" },
              { types: ["administrative_area_level_1"], longText: "Colorado", shortText: "CO" },
              { types: ["postal_code"], longText: "80203" },
            ]),
          ],
        });
      },
    },
  };
  function prediction(main, secondary, components) {
    return {
      placePrediction: {
        mainText: { text: main },
        secondaryText: { text: secondary },
        toPlace() {
          const place = {
            fetchFields() { place.addressComponents = components; return Promise.resolve({ place }); },
          };
          return place;
        },
      },
    };
  }
  return { places, calls };
}

// Builds a sandbox, runs the real component file in it, and returns
// handles to the fake form, timers, console output and fetch counter.
function setup(options) {
  const opts = options || {};
  const document = makeDocument();
  const timers = [];
  const errors = [];
  let fetchCount = 0;
  const { places, calls } = makePlaces(opts);
  const sandbox = {
    document,
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {}, warn() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    Event: FakeEvent,
    Promise,
    encodeURIComponent,
    fetch: () => {
      fetchCount++;
      const fail = opts.failFirstFetches && fetchCount <= opts.failFirstFetches;
      return Promise.resolve({
        ok: !fail,
        status: fail ? 401 : 200,
        json: () => Promise.resolve({ googleMapsApiKey: "test-key" }),
      });
    },
  };
  sandbox.window = sandbox;
  // Google already present (as after a first successful load) unless the
  // test wants to observe script injection.
  sandbox.google = { maps: { places, importLibrary: () => Promise.resolve(places) } };
  vm.createContext(sandbox);
  vm.runInContext(read("admin/address-autocomplete.js"), sandbox);

  function field(id, value) {
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.id = id;
    input.value = value || "";
    row.appendChild(input);
    document.body.appendChild(row);
    return input;
  }
  const fields = {
    address: field("service-address"),
    city: field("service-city"),
    state: field("service-state", "CO"),
    zip: field("service-zip"),
  };
  return {
    sandbox, document, fields, calls, errors,
    get fetchCount() { return fetchCount; },
    attach(f) { sandbox.AdminAddressAutocomplete.attach(f || fields); },
    panel() { return fields.address.parentNode.children.find((c) => /admin-address-autocomplete-panel/.test(c.className)); },
    panels() { return fields.address.parentNode.children.filter((c) => /admin-address-autocomplete-panel/.test(c.className)); },
    async type(text) {
      fields.address.value = text;
      fields.address.dispatchEvent(new FakeEvent("input", { bubbles: true }));
      await flush();
    },
    key(k) {
      const e = new FakeEvent("keydown", { bubbles: true, key: k });
      fields.address.dispatchEvent(e);
      return e;
    },
    async flush() { await flush(); },
  };
  async function flush() {
    for (let round = 0; round < 6; round++) {
      const pending = timers.splice(0).filter(Boolean);
      pending.forEach((fn) => fn());
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    }
  }
}

// =======================================================================
// Behavior — the shared component
// =======================================================================
test("typing 4+ characters shows real suggestion rows as an open ARIA listbox", async () => {
  const t = setup();
  t.attach();
  await t.type("1600 Gle");
  const panel = t.panel();
  assert.ok(!panel.hasAttribute("hidden"), "panel must be visible after a successful search");
  assert.strictEqual(panel.children.length, 2);
  assert.strictEqual(panel.getAttribute("role"), "listbox");
  assert.strictEqual(panel.children[0].getAttribute("role"), "option");
  assert.strictEqual(panel.children[0].children[0].textContent, "1600 Glenarm Place");
  assert.strictEqual(t.fields.address.getAttribute("aria-expanded"), "true");
  assert.strictEqual(t.fields.address.getAttribute("role"), "combobox");
  assert.deepStrictEqual(t.calls.searches, ["1600 Gle"]);
});

test("fewer than 4 characters never searches and keeps the panel closed", async () => {
  const t = setup();
  t.attach();
  await t.type("160");
  assert.strictEqual(t.calls.searches.length, 0);
  assert.ok(t.panel().hasAttribute("hidden"));
});

test("keyboard: ArrowDown/ArrowUp move the highlight (wrapping) and Enter selects it, populating street/city/state/ZIP", async () => {
  const t = setup();
  t.attach();
  await t.type("1600 Gle");
  const rows = t.panel().children;
  assert.ok(t.key("ArrowDown").defaultPrevented);
  assert.ok(rows[0].classList.contains("is-active"));
  assert.strictEqual(t.fields.address.getAttribute("aria-activedescendant"), rows[0].id);
  t.key("ArrowDown");
  assert.ok(rows[1].classList.contains("is-active") && !rows[0].classList.contains("is-active"));
  t.key("ArrowDown"); // wraps to first
  assert.ok(rows[0].classList.contains("is-active"));
  t.key("ArrowUp"); // wraps to last
  assert.ok(rows[1].classList.contains("is-active"));
  const enter = t.key("Enter");
  assert.ok(enter.defaultPrevented, "Enter on a highlighted suggestion must not submit the form");
  await t.flush();
  assert.strictEqual(t.fields.address.value, "1600 Pennsylvania Street");
  assert.strictEqual(t.fields.city.value, "Denver");
  assert.strictEqual(t.fields.state.value, "CO");
  assert.strictEqual(t.fields.zip.value, "80203");
  assert.ok(t.panel().hasAttribute("hidden"), "panel closes after selection");
  assert.strictEqual(t.fields.address.getAttribute("aria-expanded"), "false");
  assert.strictEqual(t.calls.searches.length, 1, "the synthetic input echo after selection must not start a new search");
});

test("keyboard: Enter with nothing highlighted keeps normal form behavior (not prevented)", async () => {
  const t = setup();
  t.attach();
  await t.type("1600 Gle");
  assert.ok(!t.key("Enter").defaultPrevented);
});

test("keyboard: arrows do nothing when the panel is closed (no hijacking of manual entry)", () => {
  const t = setup();
  t.attach();
  assert.ok(!t.key("ArrowDown").defaultPrevented);
});

test("keyboard: Escape closes only the dropdown — stops propagation so a modal's document-level Escape handler doesn't close the modal too", async () => {
  const t = setup();
  t.attach();
  let modalClosed = false;
  t.document.addEventListener("keydown", (e) => { if (e.key === "Escape") modalClosed = true; });
  await t.type("1600 Gle");
  const e = t.key("Escape");
  assert.ok(e.propagationStopped && t.panel().hasAttribute("hidden"));
  assert.strictEqual(modalClosed, false);
  // A second Escape (dropdown already closed) reaches the modal as before.
  t.key("Escape");
  assert.strictEqual(modalClosed, true);
});

test("mouse/touch: clicking a suggestion populates all fields and fires input events for external change tracking", async () => {
  const t = setup();
  t.attach();
  const seen = [];
  ["address", "city", "state", "zip"].forEach((k) => t.fields[k].addEventListener("input", () => seen.push(k)));
  await t.type("1600 Gle");
  seen.length = 0;
  t.panel().children[0].click();
  await t.flush();
  assert.strictEqual(t.fields.address.value, "1600 Glenarm Place");
  assert.strictEqual(t.fields.city.value, "Denver");
  assert.strictEqual(t.fields.state.value, "CO");
  assert.strictEqual(t.fields.zip.value, "80202");
  assert.deepStrictEqual(seen.sort(), ["address", "city", "state", "zip"]);
});

test("clicking outside the field closes the dropdown; the document listener removes itself once the input leaves the DOM (closed modal)", async () => {
  const t = setup();
  t.attach();
  await t.type("1600 Gle");
  const outside = t.document.createElement("div");
  t.document.body.appendChild(outside);
  outside.click();
  assert.ok(t.panel().hasAttribute("hidden"));
  const before = t.document.listeners.count("click");
  t.document.body.removeChild(t.fields.address.parentNode);
  outside.click();
  assert.strictEqual(t.document.listeners.count("click"), before - 1);
});

test("attach() is idempotent — re-attaching the same input (re-rendered form / reopened modal) never stacks a second dropdown or search", async () => {
  const t = setup();
  t.attach();
  t.attach();
  assert.strictEqual(t.panels().length, 1);
  await t.type("1600 Gle");
  assert.strictEqual(t.calls.searches.length, 1);
});

test("attach() on a fresh input (modal rebuilt with new elements) gets its own working dropdown with a unique id", async () => {
  const t = setup();
  t.attach();
  const firstId = t.panel().id;
  const row = t.document.createElement("div");
  const fresh = t.document.createElement("input");
  row.appendChild(fresh);
  t.document.body.appendChild(row);
  t.attach({ address: fresh, city: t.fields.city, state: t.fields.state, zip: t.fields.zip });
  const panel2 = row.children[1];
  assert.ok(panel2 && panel2.id && panel2.id !== firstId);
  assert.strictEqual(fresh.getAttribute("aria-controls"), panel2.id);
});

test("a failed key fetch (e.g. transient 401) is not cached forever — the next keystroke retries and suggestions appear", async () => {
  const t = setup({ failFirstFetches: 1 });
  t.attach();
  await t.type("1600 Gle");
  assert.strictEqual(t.calls.searches.length, 0, "first attempt fails quietly");
  assert.ok(t.panel().hasAttribute("hidden"));
  assert.strictEqual(t.fields.address.value, "1600 Gle", "manual text is never touched by a failure");
  await t.type("1600 Glen");
  assert.strictEqual(t.fetchCount, 2, "key fetch must be retried");
  assert.deepStrictEqual(t.calls.searches, ["1600 Glen"]);
  assert.ok(!t.panel().hasAttribute("hidden"));
});

test("Google permission denied (the live 403) degrades to manual entry and logs one actionable configuration hint — never the key", async () => {
  const err = new Error("The caller does not have permission");
  const t = setup({ searchError: err });
  t.attach();
  await t.type("1600 Gle");
  await t.type("1600 Glen");
  assert.ok(t.panel().hasAttribute("hidden"));
  assert.strictEqual(t.fields.address.value, "1600 Glen");
  const hints = t.errors.filter((m) => /Places API \(New\)/.test(m));
  assert.strictEqual(hints.length, 1, "hint logged exactly once per page");
  assert.ok(!t.errors.some((m) => /test-key/.test(m)), "the API key must never be logged");
});

test("a selection missing optional components never blanks what the owner already typed", async () => {
  const t = setup();
  t.attach();
  t.fields.zip.value = "80000";
  await t.type("1600 Gle");
  // Swap the first prediction for one with no postal_code.
  t.panel().children[0].click = function () {};
  const places = t.sandbox.google.maps.places;
  const orig = places.AutocompleteSuggestion.fetchAutocompleteSuggestions;
  places.AutocompleteSuggestion.fetchAutocompleteSuggestions = () =>
    Promise.resolve({ suggestions: [{ placePrediction: { mainText: { text: "x" }, toPlace: () => { const p = { fetchFields() { p.addressComponents = [{ types: ["route"], longText: "Main St" }]; return Promise.resolve(); } }; return p; } } }] });
  await t.type("Main Stre");
  places.AutocompleteSuggestion.fetchAutocompleteSuggestions = orig;
  t.key("ArrowDown");
  t.key("Enter");
  await t.flush();
  assert.strictEqual(t.fields.address.value, "Main St");
  assert.strictEqual(t.fields.zip.value, "80000");
  assert.strictEqual(t.fields.state.value, "CO");
});

test("never disables or requires the manual address input", () => {
  const t = setup();
  t.attach();
  assert.ok(!t.fields.address.disabled);
  assert.ok(!t.fields.address.hasAttribute("required"));
});

test("still never writes innerHTML and never hardcodes a Google key", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(src));
});

// =======================================================================
// Wiring — every CRM screen that collects a physical address
// =======================================================================
const SCREENS = [
  { name: "New Job", page: "admin/booking-new/index.html", js: "admin/booking-new.js", attach: /address: serviceAddressInput/ },
  { name: "Past Job", page: "admin/booking-past/index.html", js: "admin/booking-past.js", attach: /address: serviceAddressInput/ },
  { name: "Edit Job", page: "admin/booking-edit/index.html", js: "admin/booking-edit.js", attach: /address: serviceAddressInput/ },
  { name: "New Estimate", page: "admin/estimate-new/index.html", js: "admin/estimate-new.js", attach: /address: serviceAddressInput/ },
  { name: "Edit Client sheet", page: "admin/client/index.html", js: "admin/client-detail.js", attach: /address: addressInput,\s*city: cityInput,\s*state: stateInput,\s*zip: zipInput/ },
  { name: "Intake review (Job fields)", page: "admin/intake/index.html", js: "admin/intake-detail.js", attach: /address: fieldInputs\.address\.el/ },
];

SCREENS.forEach(({ name, page, js, attach }) => {
  test(name + ": " + page + " loads address-autocomplete.js before " + js, () => {
    const src = read(page);
    const helperIdx = src.indexOf('src="../address-autocomplete.js"');
    const pageIdx = src.indexOf('src="../' + js.split("/").pop() + '"');
    assert.ok(helperIdx !== -1, "must load the shared helper");
    assert.ok(pageIdx !== -1 && helperIdx < pageIdx, "helper must load before the page script");
  });
  test(name + ": " + js + " attaches the shared helper (feature-guarded) to its address fields", () => {
    const src = read(js);
    assert.ok(/if \(window\.AdminAddressAutocomplete/.test(src), "must guard the call");
    assert.ok(/window\.AdminAddressAutocomplete\.attach\(\{/.test(src));
    assert.ok(attach.test(src), "must pass that screen's own address inputs");
  });
});

test("Edit Client: attach() runs inside openEditSheet() after the inputs are in the sheet (dynamic modal) and the save payload is unchanged", () => {
  const src = read("admin/client-detail.js");
  const body = src.slice(src.indexOf("function openEditSheet()"), src.indexOf("saveBtnEl.addEventListener"));
  assert.ok(body.indexOf("fieldRow('ZIP', zipInput)") < body.indexOf("AdminAddressAutocomplete.attach"));
  assert.ok(/address: addressInput\.value\.trim\(\),\s*city: cityInput\.value\.trim\(\),\s*state: stateInput\.value\.trim\(\),\s*zip: zipInput\.value\.trim\(\)/.test(src));
});

test("Intake review: attach() runs right after the Job field group is (re-)rendered", () => {
  const src = read("admin/intake-detail.js");
  const jobRender = src.indexOf("renderFieldGroup(jobFieldsEl, JOB_FIELDS, intake.fields);");
  const attachIdx = src.indexOf("AdminAddressAutocomplete.attach", jobRender);
  const nextRender = src.indexOf("renderFieldGroup(schedulingFieldsEl", jobRender);
  assert.ok(jobRender !== -1 && attachIdx > jobRender && attachIdx < nextRender);
});

test("public /book form is NOT wired to the admin helper (it calls an admin-only endpoint) — out of CRM scope", () => {
  const src = read("book/index.html");
  assert.ok(!/address-autocomplete\.js/.test(src));
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
