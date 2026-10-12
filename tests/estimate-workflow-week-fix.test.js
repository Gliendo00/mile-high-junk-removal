// Local, offline test harness for the Week-view Estimate fix: Week's own
// ?range=week API response has always included a sibling `estimates` array
// (api/admin/bookings.js's handleSchedule(), same fetchScheduleEstimates()
// as Day/Month) — this client (admin/calendar-views.js) simply never
// stored or rendered it. This file covers that fix specifically; the base
// Estimate workflow and the Month-view/hardening-pass work are already
// covered by tests/estimate-workflow.test.js and
// tests/estimate-workflow-hardening.test.js and re-run unchanged alongside
// this file, not duplicated here.
//
// Run with:  node tests/estimate-workflow-week-fix.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase query builder — same union as the other Estimate workflow
// test files (insert/update/select/eq/is/in/gte/lte/order/limit/
// maybeSingle/single). This file only exercises GET paths, but the shared
// shape is kept for consistency with the rest of the project's test
// harnesses.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(800000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._single = null;
    this._insertRow = null;
    this._updateData = null;
    this._limit = null;
  }
  select() { return this; }
  eq(field, val) { this._filters.push((row) => row[field] === val); return this; }
  is(field, val) { this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val); return this; }
  in(field, arr) { const set = new Set(arr); this._filters.push((row) => set.has(row[field])); return this; }
  gte(field, val) { this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val); return this; }
  lte(field, val) { this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val); return this; }
  order(field, opts) { this._order = { field: field, ascending: !opts || opts.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }
  insert(data) { this._insertRow = data; return this; }
  update(data) { this._updateData = data; return this; }
  maybeSingle() { this._single = "maybeSingle"; return this._resolve(); }
  single() { this._single = "single"; return this._resolve(); }
  then(resolve, reject) { return this._resolve().then(resolve, reject); }
  async _resolve() {
    if (this._insertRow) {
      const row = Object.assign({ id: makeId(), created_at: "2026-10-12T12:00:00Z", updated_at: null, updated_by: null }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }
    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    if (this._updateData) {
      filtered.forEach((row) => Object.assign(row, this._updateData));
    }
    if (this._order) {
      const field = this._order.field;
      const asc = this._order.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this._limit !== null) filtered = filtered.slice(0, this._limit);
    if (this._single === "maybeSingle") {
      if (filtered.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: filtered[0] || null, error: null };
    }
    if (this._single === "single") {
      return filtered.length ? { data: filtered[0], error: null } : { data: null, error: { message: "no rows returned for single" } };
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return { from(table) { return new FakeQueryBuilder(table, db); } };
}
function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured in this test" } })),
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
          throw new Error("Unexpected Supabase key passed to createClient() in test: " + key);
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

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: opts.cookie || "" }, opts.headers || {}),
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
const CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function freshDb() {
  return {
    customers: [{ id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", city: "Denver" }],
    estimates: [],
    bookings: [],
  };
}

function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function addDaysIso(iso, days) {
  const p = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}
function dayOfWeekIso(iso) {
  const p = iso.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0)).getUTCDay();
}
function startOfWeekSundayIso(iso) {
  return addDaysIso(iso, -dayOfWeekIso(iso));
}

function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "GET", cookie: cookie, query: Object.assign({ view: "schedule" }, query) }));
}

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// PART A — Server: ?range=week already returns estimates (this was never
// broken — the gap was entirely client-side). Re-confirmed here as the
// baseline the fix builds on.
// =======================================================================

test("?view=schedule&range=week returns a sibling estimates array", async () => {
  adminAuthed();
  const db = freshDb();
  const today = denverTodayIso();
  const weekStart = startOfWeekSundayIso(today);
  db.estimates.push({
    id: "e1", created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: today, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: 450,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "week", weekStart: weekStart });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.estimates), "Week response must carry an `estimates` array");
  assert.strictEqual(res.body.estimates.length, 1);
  assert.strictEqual(res.body.jobs.length, 0, "no job exists — jobs must stay empty");
});

// =======================================================================
// PART B — Client: admin/calendar-views.js now stores and renders Week's
// estimates, matching Month's own treatment.
// =======================================================================

test("admin/calendar-views.js: loadWeek() stores body.estimates into state.weekEstimatesByDate", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function loadWeek("), src.indexOf("function renderWeekOverview("));
  assert.ok(/state\.weekEstimatesByDate = groupJobsByDate\(body\.estimates\);/.test(fn), "loadWeek() must store the week's estimates, same as loadMonth() already does for Month");
});

test("admin/calendar-views.js: renderWeekOverview() reads state.weekEstimatesByDate and renders a distinct estimate count + mini-cards", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function renderWeekOverview("), src.indexOf("function selectWeekDate("));
  assert.ok(/var estimates = \(state\.weekEstimatesByDate\[iso\] \|\| \[\]\)\.slice\(\);/.test(fn));
  assert.ok(/admin-week-day-row-estimate-count/.test(fn), "must show a separate estimate count, never merged into the job count");
  assert.ok(/admin-week-day-row-estimate/.test(fn), "estimate mini-cards must carry their own distinguishing class");
});

test("admin/calendar-views.js: selectWeekDate() passes Week's real per-date estimates into the shared day panel, no longer a literal []", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function selectWeekDate("), src.indexOf("function navigateWeekDayBy("));
  assert.ok(
    /renderDayPanel\(weekDayPanel, iso, state\.weekJobsByDate\[iso\] \|\| \[\], state\.weekEstimatesByDate\[iso\] \|\| \[\], function \(delta\) \{ navigateWeekDayBy\(iso, delta\); \}\);/.test(fn),
    "selectWeekDate() must pass state.weekEstimatesByDate[iso], matching selectMonthDate()'s own treatment"
  );
  assert.ok(!/renderDayPanel\(weekDayPanel, iso, state\.weekJobsByDate\[iso\] \|\| \[\], \[\],/.test(fn), "must no longer pass a hardcoded empty array");
});

test("Week's estimate mini-card reuses the exact .admin-week-day-row-job shape (time + name), never a second layout", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function renderWeekOverview("), src.indexOf("function selectWeekDate("));
  assert.ok(/admin-week-day-row-job admin-week-day-row-estimate/.test(fn), "must be the job row class PLUS a modifier, not a from-scratch element");
  assert.ok(/shortTimeLabel\(estimate\.timeLabel\)/.test(fn));
});

test("Week's estimate list caps at WEEK_ROW_MAX_JOB_LINES with a '+N more', same as jobs", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function renderWeekOverview("), src.indexOf("function selectWeekDate("));
  assert.ok(/estimates\.slice\(0, WEEK_ROW_MAX_JOB_LINES\)/.test(fn));
  assert.ok(/estimates\.length > WEEK_ROW_MAX_JOB_LINES/.test(fn));
});

test("admin.css: Week's estimate count/mini-card classes exist and are visually distinct (teal) from the job equivalents", () => {
  const css = read("admin/admin.css");
  assert.ok(/\.admin-week-day-row-estimate-count\s*\{/.test(css));
  assert.ok(/\.admin-week-day-row-job\.admin-week-day-row-estimate\s*\{/.test(css));
});

// =======================================================================
// PART C — Financial isolation: Week's estimates still never reach
// admin/schedule-financials.js.
// =======================================================================

test("FINANCIAL ISOLATION: loadWeek() still hands financials only body.jobs, unchanged by the Week fix", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/showFinancialsFor\(body\.weekStart, body\.weekEnd, body\.jobs\);/.test(src), "Week's Revenue/Booked/Net must stay fed by body.jobs alone");
});

test("Week overview never renders a dollar amount for an estimate — count/time/name only, same restraint as the job mini-card", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function renderWeekOverview("), src.indexOf("function selectWeekDate("));
  assert.ok(!/quotedAmount|estimatedPrice|finalPrice/.test(fn), "the Week overview strip must never render a financial value for an estimate");
});

// =======================================================================
// PART D — Coverage requested by this pass: Day/Week/Month all YES, Year
// stays jobs-only (unchanged, confirmed here as a guard against drift).
// =======================================================================

test("Day: ?range=today/tomorrow/yesterday/day all return estimates (already-shipped behavior, reconfirmed)", async () => {
  adminAuthed();
  const db = freshDb();
  const today = denverTodayIso();
  db.estimates.push({
    id: "e2", created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: today, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: 450,
  });
  const todayRes = await getSchedule(db, AUTH_COOKIE, { range: "today" });
  assert.ok(Array.isArray(todayRes.body.estimates));
  assert.strictEqual(todayRes.body.estimates.length, 1);
  const dayRes = await getSchedule(db, AUTH_COOKIE, { range: "day", date: today });
  assert.strictEqual(dayRes.body.estimates.length, 1);
});

test("Month: ?range=month still returns estimates (already-shipped behavior, reconfirmed)", async () => {
  adminAuthed();
  const db = freshDb();
  const today = denverTodayIso();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  db.estimates.push({
    id: "e3", created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: today, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: null,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "month", year: String(year), month: String(month) });
  assert.strictEqual(res.body.estimates.length, 1);
});

test("Year: ?range=year intentionally stays jobs-only (job counts per month) — no estimates field, by design", async () => {
  adminAuthed();
  const db = freshDb();
  const today = denverTodayIso();
  const year = Number(today.slice(0, 4));
  const res = await getSchedule(db, AUTH_COOKIE, { range: "year", year: String(year) });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.monthCounts));
  assert.strictEqual(res.body.estimates, undefined, "Year deliberately carries no estimates field this round");

  const src = read("api/admin/bookings.js");
  const fn = src.slice(src.indexOf("async function handleYear("), src.indexOf("async function handleYear(") + 1600);
  assert.ok(!/fetchScheduleEstimates/.test(fn), "handleYear() must not call fetchScheduleEstimates — Year stays job-counts-only by design");
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
