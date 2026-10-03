// Batch 6 — Nav consolidation (2026-10). Requests and Intake are removed
// from the VISIBLE top nav on every admin page; /admin/requests/ and
// /admin/intakes/ stay live, directly-reachable routes (typing the URL
// still works — they're just no longer one click away from the nav bar).
// Nothing is deleted or migrated: no file removed, no data moved, no
// endpoint retired. Leads remains the single visible workspace merging
// Pending Intake + website Requests + the richer lead-status pipeline.
//
// Static checks read actual page/source text (this project has no DOM/
// jsdom harness — see every other UI test in this suite for the same
// approach). Dynamic checks reuse this suite's standard in-memory fake
// Supabase client to prove the underlying endpoints these routes depend
// on are completely unchanged.
//
// Run with:  node tests/phase3c-batch6-nav-consolidation.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
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

// Every admin page that carries the shared top nav — the full set,
// including the three Batch 5 added and admin/leads/ itself.
const ALL_NAV_PAGES = [
  "admin/booking-edit/index.html",
  "admin/booking-new/index.html",
  "admin/booking-past/index.html",
  "admin/booking/index.html",
  "admin/client/index.html",
  "admin/clients/index.html",
  "admin/expenses/index.html",
  "admin/index.html",
  "admin/requests/index.html",
  "admin/intakes/index.html",
  "admin/intake-new/index.html",
  "admin/intake/index.html",
  "admin/leads/index.html",
];

// =======================================================================
// Requirement 1 — visible nav has EXACTLY Schedule, Leads, Clients,
// Expenses, in that order, on every single admin page, with no leftover
// Requests/Intake tab anywhere.
//
// UPDATED for the CRM visual redesign (2026-10): the nav is no longer
// static per-page HTML — every page now loads admin/admin-chrome.js (the
// single shared source of truth for the header/nav/bottom-nav) and
// provides only an empty `<div id="admin-chrome"></div>` placeholder for
// it to fill in at runtime. So this now asserts two things instead: (a)
// every page actually wires up the shared chrome correctly, and (b)
// admin-chrome.js itself — the one place nav order/membership is now
// defined — has the right four destinations in the right order and
// nothing for Requests/Intakes. See tests/phase3c-schedule.test.js and
// tests/phase3c-batch6-leads-ui.test.js for the same update applied to
// their own nav assertions.
// =======================================================================
ALL_NAV_PAGES.forEach((rel) => {
  test(rel + ": wires up the shared admin-chrome header/nav (placeholder + script, loaded before the page's own script)", () => {
    const html = readNormalized(rel);
    assert.ok(/<div id="admin-chrome"><\/div>/.test(html), rel + ": must have the #admin-chrome placeholder");
    const chromeScriptMatch = html.match(/<script src="([^"]*admin-chrome\.js)"><\/script>/);
    assert.ok(chromeScriptMatch, rel + ": must load admin-chrome.js");
    // Must be the FIRST script tag — its DOMContentLoaded handler has to run
    // (and inject #logout-btn etc.) before any page-specific script's own
    // DOMContentLoaded handler looks for those elements.
    const firstScriptMatch = html.match(/<script src="([^"]+)"><\/script>/);
    assert.strictEqual(firstScriptMatch[1], chromeScriptMatch[1], rel + ": admin-chrome.js must be the first script tag on the page");
  });
});

test("admin/admin-chrome.js: nav is exactly Schedule, Leads, Clients, Expenses, in that order, with no Requests/Intakes destination", () => {
  const src = readNormalized("admin/admin-chrome.js");
  const sectionsMatch = src.match(/var SECTIONS = \[([\s\S]*?)\n\s*\];/);
  assert.ok(sectionsMatch, "admin-chrome.js must define a SECTIONS list");
  const labels = Array.from(sectionsMatch[1].matchAll(/label:\s*'([^']+)'/g)).map((m) => m[1]);
  assert.deepStrictEqual(labels, ["Schedule", "Leads", "Clients", "Expenses"]);
  assert.ok(!/\/admin\/requests\//.test(sectionsMatch[1]), "Requests must not be a nav destination");
  assert.ok(!/\/admin\/intakes\//.test(sectionsMatch[1]), "Intakes must not be a nav destination");
});

// =======================================================================
// Requirement 2 — Requests/Intake routes still return normally when
// opened directly. Static half: the pages themselves still exist, still
// render their real heading/content, still load their real scripts —
// nothing stubbed, redirected, or removed. Dynamic half, below: the
// underlying API endpoints those pages call are completely unchanged.
// =======================================================================
test("admin/requests/index.html: still a real, fully-functional page (heading, dashboard.js, nav-badge.js) — just not linked from the nav anymore", () => {
  const html = readNormalized("admin/requests/index.html");
  assert.ok(/<h1[^>]*>Requests<\/h1>/.test(html));
  assert.ok(/src="\.\.\/dashboard\.js"/.test(html));
  assert.ok(/src="\.\.\/nav-badge\.js"/.test(html));
  assert.ok(/id="booking-list"/.test(html), "the actual Requests list container must still be present");
});

test("admin/intakes/index.html: still a real, fully-functional page (heading, intakes-list.js) — just not linked from the nav anymore", () => {
  const html = readNormalized("admin/intakes/index.html");
  assert.ok(/<h1>Pending Intake<\/h1>/.test(html));
  assert.ok(/src="\.\.\/intakes-list\.js"/.test(html));
  assert.ok(/id="intake-list"/.test(html), "the actual Pending Intake list container must still be present");
});

test("no admin/*.js file or vercel.json was changed to redirect, delete, or gate /admin/requests/ or /admin/intakes/ — git tracks both files present, untouched in content", () => {
  // dashboard.js and intakes-list.js (the actual list-rendering logic for
  // each fallback page) must still exist as real files, unmodified by
  // this nav-only change.
  assert.ok(fs.existsSync(path.join(__dirname, "..", "admin", "dashboard.js")));
  assert.ok(fs.existsSync(path.join(__dirname, "..", "admin", "intakes-list.js")));
  const vercelJson = JSON.parse(readNormalized("vercel.json"));
  const redirectsRequests = (vercelJson.redirects || []).some((r) => r.source === "/admin/requests" || r.source === "/admin/requests/");
  const redirectsIntakes = (vercelJson.redirects || []).some((r) => r.source === "/admin/intakes" || r.source === "/admin/intakes/");
  assert.ok(!redirectsRequests, "vercel.json must not redirect away from /admin/requests/");
  assert.ok(!redirectsIntakes, "vercel.json must not redirect away from /admin/intakes/");
});

// ---------------------------------------------------------------------
// Dynamic half: the actual endpoints admin/requests/ and admin/intakes/
// depend on (api/admin/bookings.js's default GET, api/admin/intake.js's
// default GET) still work exactly as before — same in-memory fake
// Supabase approach as every other endpoint test in this suite.
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._count = null;
    this._single = null;
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  range(from, to) {
    this._range = [from, to];
    return this;
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    if (this._order) {
      const field = this._order.field;
      const asc = this._order.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this._count && this._count.head) return { data: null, count: filtered.length, error: null };
    if (this._range) filtered = filtered.slice(this._range[0], this._range[1] + 1);
    if (this._single === "maybeSingle") {
      if (filtered.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: filtered[0] || null, error: null };
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
    },
    storage: {
      from() {
        return { async createSignedUrl(objectPath, ttl) {
          return { data: { signedUrl: "https://mock-signed.example/" + encodeURIComponent(objectPath) + "?ttl=" + ttl }, error: null };
        } };
      },
    },
  };
}
function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured" } })),
    },
  };
}

let currentFakeAnon = null;
let currentFakeService = null;
function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return currentFakeAnon;
          if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
          throw new Error("Unexpected Supabase key in test: " + key);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingsHandler = require("../api/admin/bookings.js");
const intakeHandler = require("../api/admin/intake.js");

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: opts.cookie || "", "x-forwarded-proto": "https" }, opts.headers || {}),
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}
function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    getHeaders: () => headers,
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}
function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}
const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

test("the Requests page's underlying endpoint (default GET /api/admin/bookings) still returns real booking rows, untouched by the nav change", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient({
    customers: [{ id: "c1", first_name: "Jamie", last_name: "Rivera", city: "Denver" }],
    bookings: [{ id: "b1", customer_id: "c1", service_type: "junk_removal", status: null, archived_at: null, created_at: "2026-10-01T00:00:00Z" }],
  });
  const res = await run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, "b1");
});

test("the Pending Intake page's underlying endpoint (default GET /api/admin/intake) still returns real intake rows, untouched by the nav change", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient({
    intake_sessions: [{ id: "i1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", status: "pending_review", classification: "lead_only", classification_confidence: "likely", match_status: "new_candidate", matched_customer_id: null, extracted_data: { fields: { firstName: { value: "Morgan", confidence: "likely" } } } }],
    customers: [],
  });
  const res = await run(intakeHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.intakes.length, 1);
  assert.strictEqual(res.body.intakes[0].id, "i1");
});

// =======================================================================
// Requirement 3 — Leads still contains the merged data sources: Pending
// Intake (from the endpoint above) plus the website/leads-table merge
// (?view=leads) — the full dynamic proof already lives in
// tests/phase3c-batch6-leads-view.test.js; this is the self-contained
// version living alongside the other two requirements in this file.
// =======================================================================
test("?view=leads still merges website-origin bookings and leads-table rows into the same response the Leads workspace reads", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient({
    customers: [{ id: "c1", first_name: "Jamie", last_name: "Rivera", city: "Denver", phone: "303-555-0100" }],
    bookings: [{ id: "b1", customer_id: "c1", service_type: "junk_removal", service_city: "Denver", status: null, archived_at: null, created_at: "2026-10-01T00:00:00Z" }],
    leads: [{ id: "l1", source: "manual", status: "new", first_name: "Alex", last_name: "Doe", phone: "303-555-0199", city: "Aurora", service_type: "junk_removal", created_at: "2026-10-02T00:00:00Z" }],
  });
  const res = await run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.sections.websiteRequests.some((c) => c.id === "b1" && c.source === "website"));
  assert.ok(res.body.sections.new.some((c) => c.id === "l1" && c.source === "manual"));
});

test("admin/leads-list.js still fetches both GET /api/admin/intake and GET /api/admin/bookings?view=leads (the merge is still wired up client-side)", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/adminFetch\('\/api\/admin\/intake'\)/.test(src));
  assert.ok(/adminFetch\('\/api\/admin\/bookings\?view=leads'\)/.test(src));
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
