// Local, offline test harness for Phase 3C Stage 1: the read-only Schedule
// view and the Requests badge count — both served by api/admin/bookings.js
// as ?view=schedule and ?countsOnly=1 modes rather than their own separate
// endpoint files (see the scheduleView/countsOnly comments in that file for
// why: the Vercel Hobby plan's 12-Serverless-Function-per-deployment limit,
// hit for real during this stage's Preview verification — see
// docs/phase-3/vercel-function-limit.md) — plus the accompanying
// static-file/navigation restructuring (Requests moved to /admin/requests/,
// Schedule at /admin/).
//
// Same approach as tests/phase1-api.test.js, tests/phase2-admin-api.test.js,
// and tests/phase3a-admin-status-write.test.js: "@supabase/supabase-js" is
// intercepted at require-time and replaced with an in-memory fake — never
// the real network, never the production Supabase project. This file's
// FakeQueryBuilder is phase3a's plus .gte()/.lte() support, needed for the
// Schedule endpoint's appointment_date range filter.
//
// Run with:  node tests/phase3c-schedule.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder (phase3a's, plus .gte()/.lte())
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows, opts) {
    this._rows = rows || [];
    this._filters = [];
    this._order = null;
    this._range = null;
    this._count = null;
    this._single = null;
    this._update = null;
    this._opts = opts || {};
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  is(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  gte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val);
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
  update(data) {
    this._update = data;
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

    if (this._update) {
      if (this._opts.__updateError) {
        return { data: null, error: this._opts.__updateError };
      }
      filtered.forEach((row) => Object.assign(row, this._update));
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
    const countTotal = filtered.length;
    if (this._range) {
      filtered = filtered.slice(this._range[0], this._range[1] + 1);
    }
    if (this._count && this._count.head) {
      return { data: null, count: countTotal, error: null };
    }
    if (this._single === "maybeSingle") {
      if (filtered.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: filtered[0] || null, error: null };
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder((db[table] || []).slice(), { __updateError: db.__updateError });
    },
  };
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

// ---------------------------------------------------------------------
// req/res mocks (identical shape to phase2/phase3a's)
// ---------------------------------------------------------------------
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
    getHeader: function (name) {
      return headers[name.toLowerCase()];
    },
    setHeader: function (name, value) {
      headers[name.toLowerCase()] = value;
    },
    status: function (code) {
      res.statusCode = code;
      return res;
    },
    json: function (obj) {
      res.body = obj;
      return res;
    },
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(function () {
    return res;
  });
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
const NON_ADMIN_EMAIL = "someone-else@example.com";

function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}

// Independent copy of api/admin/schedule.js's own Denver-date helpers, used
// only to compute expected date boundaries for test fixtures — this is
// deliberately NOT imported from the handler under test, so the test can't
// pass merely because it shares a bug with the implementation. Dates are
// computed relative to whenever the test actually runs (never a hardcoded
// literal date), so this suite never goes stale.
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}

const TODAY = denverTodayIso();
const TOMORROW = addDaysIso(TODAY, 1);
const IN_3_DAYS = addDaysIso(TODAY, 3);
const IN_6_DAYS = addDaysIso(TODAY, 6);
const IN_7_DAYS = addDaysIso(TODAY, 7); // outside the 7-day (today..+6) week window
const YESTERDAY = addDaysIso(TODAY, -1);

// Phase 3C Stage 2.4: "week" became a navigable Sunday-aligned calendar
// week instead of a rolling today..+6 window — independent copy of the
// implementation's own day-of-week math, same "never imported from the
// handler under test" reasoning as denverTodayIso()/addDaysIso() above.
function dayOfWeekIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}
function startOfWeekSundayIso(iso) {
  return addDaysIso(iso, -dayOfWeekIso(iso));
}
const WEEK_START = startOfWeekSundayIso(TODAY);
const WEEK_END = addDaysIso(WEEK_START, 6);

function booking(overrides) {
  return Object.assign(
    {
      id: "00000000-0000-0000-0000-000000000000",
      customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      service_type: "junk_removal",
      appointment_date: TODAY,
      time_window: "w_0800_1000",
      status: "booked",
      estimated_price: 250,
      service_address: "123 Main St",
      service_city: "Denver",
      service_state: "CO",
      service_zip: "80202",
    },
    overrides
  );
}

function freshDb(bookings) {
  return {
    bookings: bookings,
    customers: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", first_name: "Alex", last_name: "Doe", phone: "303-555-0101", email: null, city: "Aurora" },
    ],
  };
}

// Served by api/admin/bookings.js's ?view=schedule mode (folded in during
// Preview verification after a separate api/admin/schedule.js function
// pushed this deployment over the Vercel Hobby plan's 12-Serverless-Function
// limit — see docs/phase-3/vercel-function-limit.md), not its own endpoint.
function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: cookie, query: Object.assign({ view: "schedule" }, query || {}) }));
}

// The Requests badge count is served by api/admin/bookings.js's
// ?countsOnly=1 mode (folded in during Preview verification, after a
// separate api/admin/new-count.js function pushed this deployment over the
// Vercel Hobby plan's 12-Serverless-Function limit — see
// docs/phase-3/vercel-function-limit.md), not a standalone endpoint.
function getCountsOnly(db, cookie) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: cookie, query: { countsOnly: "1" } }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Authentication / authorization — GET /api/admin/schedule
// =======================================================================
test("GET schedule: no cookies at all -> 401, no jobs returned", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb([booking({ id: "1" })]);
  const res = await getSchedule(db, "");
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.jobs, undefined);
});

test("GET schedule: garbage/forged access token -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  const db = freshDb([booking({ id: "1" })]);
  const res = await getSchedule(db, "mhjr_admin_at=not-a-real-token");
  assert.strictEqual(res.statusCode, 401);
});

test("GET schedule: real Supabase session but non-allowlisted email -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb([booking({ id: "1" })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-nonadmin");
  assert.strictEqual(res.statusCode, 401);
});

test("GET schedule: response is always Cache-Control: no-store", async () => {
  const db = freshDb([]);
  const res = await getSchedule(db, "");
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

// Phase 3C Stage 2.4 addendum (Daily Quick Expense Tracking) gave POST a
// real meaning on this file for the first time (expense creation — see
// tests/phase3c-stage2.4-expenses.test.js for its full coverage), so a bare
// POST no longer 405s outright; it's read far enough to see there's no
// valid `resource` in the body and rejected with 400, never silently
// treated as a booking write. DELETE/PUT remain genuinely unsupported.
test("bookings.js: POST with no/invalid resource is rejected (400), never silently accepted", async () => {
  adminAuthed();
  const db = freshDb([]);
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingsHandler, makeReq({ method: "POST", cookie: "mhjr_admin_at=at-good", query: { view: "schedule" } }));
  assert.strictEqual(res.statusCode, 400);
});

test("GET schedule: DELETE/PUT are rejected with 405 (method-scoped)", async () => {
  adminAuthed();
  const db = freshDb([]);
  currentFakeService = createFakeServiceClient(db);
  const resDelete = await run(bookingsHandler, makeReq({ method: "DELETE", cookie: "mhjr_admin_at=at-good", query: { view: "schedule" } }));
  assert.strictEqual(resDelete.statusCode, 405);
  const resPut = await run(bookingsHandler, makeReq({ method: "PUT", cookie: "mhjr_admin_at=at-good", query: { view: "schedule" } }));
  assert.strictEqual(resPut.statusCode, 405);
});

test("GET schedule: never leaks the service-role key or anon key", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1" })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good");
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

// =======================================================================
// 2. Which bookings appear: status/date architecture (no second status field)
// =======================================================================
test("GET schedule: only 'booked' and 'completed' bookings ever appear — new/contacted/quoted/lost never do, even with a matching date", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "1", status: null, appointment_date: TODAY }), // NULL = "new"
    booking({ id: "2", status: "contacted", appointment_date: TODAY }),
    booking({ id: "3", status: "quoted", appointment_date: TODAY }),
    booking({ id: "4", status: "lost", appointment_date: TODAY }),
    booking({ id: "5", status: "booked", appointment_date: TODAY }),
    booking({ id: "6", status: "completed", appointment_date: TODAY }),
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  assert.strictEqual(res.statusCode, 200);
  const ids = res.body.jobs.map((j) => j.id).sort();
  assert.deepStrictEqual(ids, ["5", "6"]);
});

// =======================================================================
// 3. Range handling: today / tomorrow / week, and the default
// =======================================================================
test("GET schedule: no range param defaults to 'today'", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", appointment_date: TODAY }), booking({ id: "2", appointment_date: TOMORROW })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", {});
  assert.strictEqual(res.body.range, "today");
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["1"]);
});

test("GET schedule: an unrecognized range value falls back to 'today' rather than erroring", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", appointment_date: TODAY })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "next-month" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.range, "today");
});

test("GET schedule: range=tomorrow returns only tomorrow's job", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", appointment_date: TODAY }), booking({ id: "2", appointment_date: TOMORROW }), booking({ id: "3", appointment_date: IN_3_DAYS })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "tomorrow" });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["2"]);
});

test("GET schedule: range=week (no weekStart) defaults to the Sunday-aligned week containing today, excluding the days just outside it", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "before-week", appointment_date: addDaysIso(WEEK_START, -1) }),
    booking({ id: "week-start", appointment_date: WEEK_START }),
    booking({ id: "today", appointment_date: TODAY }),
    booking({ id: "week-end", appointment_date: WEEK_END }),
    booking({ id: "after-week", appointment_date: addDaysIso(WEEK_END, 1) }),
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "week" });
  const ids = res.body.jobs.map((j) => j.id);
  assert.deepStrictEqual(ids.sort(), ["today", "week-end", "week-start"].sort());
  assert.strictEqual(res.body.weekStart, WEEK_START);
  assert.strictEqual(res.body.weekEnd, WEEK_END);
});

// =======================================================================
// 4. Chronological ordering (the shared time-windows start-hour metadata)
// =======================================================================
test("GET schedule: same-day jobs sort by time-window start hour, not insertion order", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "afternoon", appointment_date: TODAY, time_window: "afternoon" }), // legacy window, startHour 14
    booking({ id: "early", appointment_date: TODAY, time_window: "w_0600_0800" }), // startHour 6
    booking({ id: "midday", appointment_date: TODAY, time_window: "w_1000_1200" }), // startHour 10
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["early", "midday", "afternoon"]);
});

test("GET schedule: an unrecognized time_window sorts after every recognized window on the same date, never dropped", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "unknown", appointment_date: TODAY, time_window: "some_future_window" }),
    booking({ id: "known", appointment_date: TODAY, time_window: "w_0400_0600" }),
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["known", "unknown"]);
});

test("GET schedule: earlier dates sort before later dates regardless of time window", async () => {
  adminAuthed();
  // Pinned to an explicit weekStart (rather than relying on TODAY/IN_3_DAYS
  // falling in the default current week) so this assertion can't go flaky
  // depending on which day of the Sunday-aligned week the suite happens to
  // run on.
  const db = freshDb([
    booking({ id: "later-day-early-window", appointment_date: addDaysIso(WEEK_START, 3), time_window: "w_0400_0600" }),
    booking({ id: "earlier-day-late-window", appointment_date: WEEK_START, time_window: "w_2000_2200" }),
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "week", weekStart: WEEK_START });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["earlier-day-late-window", "later-day-early-window"]);
});

// =======================================================================
// 5. Response shape / fields the Schedule card needs
// =======================================================================
test("GET schedule: each job carries the fields the Schedule card requires (time, client, service, address, price, status, phone for Call/Text)", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", appointment_date: TODAY, estimated_price: 375 })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  const job = res.body.jobs[0];
  assert.strictEqual(job.timeWindowLabel, "8:00 AM – 10:00 AM");
  assert.strictEqual(job.customer.firstName, "Jamie");
  assert.strictEqual(job.customer.phone, "303-555-0100");
  assert.strictEqual(job.serviceLabel, "Junk Removal");
  assert.strictEqual(job.serviceAddress.city, "Denver");
  assert.strictEqual(job.estimatedPrice, 375);
  assert.strictEqual(job.statusLabel, "Booked");
});

test("GET schedule: a legacy booking with no service_city snapshot falls back to the customer's current city", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", appointment_date: TODAY, service_city: null, customer_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  assert.strictEqual(res.body.jobs[0].serviceAddress.city, "Aurora");
});

// =======================================================================
// 6. Requests badge count — GET /api/admin/bookings?countsOnly=1
// =======================================================================
test("GET bookings?countsOnly=1: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb([booking({ id: "1", status: null })]);
  const res = await getCountsOnly(db, "");
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.summary, undefined);
});

test("GET bookings?countsOnly=1: counts only NULL-status ('new') bookings, matching the normal summary's own definition", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "1", status: null }),
    booking({ id: "2", status: null }),
    booking({ id: "3", status: "booked" }),
    booking({ id: "4", status: "completed" }),
    booking({ id: "5", status: "lost" }),
  ]);
  const res = await getCountsOnly(db, "mhjr_admin_at=at-good");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.summary.new, 2);
});

test("GET bookings?countsOnly=1: zero new bookings returns summary.new === 0 — the client hides the badge on this exact value (verified by code review of admin/nav-badge.js; no DOM simulation in this offline harness, same limitation noted in tests/phase3a-admin-status-write.test.js for its double-tap guard)", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", status: "booked" }), booking({ id: "2", status: "completed" })]);
  const res = await getCountsOnly(db, "mhjr_admin_at=at-good");
  assert.strictEqual(res.body.summary.new, 0);
});

test("GET bookings?countsOnly=1: response contains only { ok, summary } — never any booking/customer row (no `bookings` array, unlike the normal list response)", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "1", status: null })]);
  const res = await getCountsOnly(db, "mhjr_admin_at=at-good");
  const keys = Object.keys(res.body).sort();
  assert.deepStrictEqual(keys, ["ok", "summary"]);
});

test("GET bookings?countsOnly=1: matches the summary the normal (non-countsOnly) call computes for the same data", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "1", status: null }),
    booking({ id: "2", status: "contacted" }),
    booking({ id: "3", status: "booked" }),
    booking({ id: "4", status: "completed" }),
  ]);
  const countsRes = await getCountsOnly(db, "mhjr_admin_at=at-good");
  currentFakeService = createFakeServiceClient(db);
  const fullRes = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  assert.deepStrictEqual(countsRes.body.summary, fullRes.body.summary);
});

// =======================================================================
// 7. Moved Requests page / new Schedule homepage (static files)
// =======================================================================
test("static files: admin/requests/index.html exists and still loads dashboard.js (the moved Requests dashboard)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin/requests/index.html"), "utf8");
  assert.ok(html.includes('src="../dashboard.js"'), "moved Requests page must still load the unchanged dashboard.js");
  assert.ok(html.includes("Loading requests"), "moved page must still be the Requests dashboard content");
});

test("static files: admin/index.html is now the Schedule page, not the old Requests dashboard", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin/index.html"), "utf8");
  assert.ok(html.includes('src="schedule.js"'), "admin/ root must load the new schedule.js");
  assert.ok(!html.includes('src="dashboard.js"'), "admin/ root must no longer load dashboard.js directly");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "admin/dashboard.js")), "dashboard.js itself must still exist on disk (only moved which page loads it)");
});

test("static files: the booking-detail back-link now points at /admin/requests/, not the old /admin/", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin/booking/index.html"), "utf8");
  assert.ok(html.includes('href="/admin/requests/" class="admin-back-link"'), "back-link must follow Requests to its new URL");
});

// =======================================================================
// 8. Navigation: three tabs present on every admin page except login
// =======================================================================
test("navigation: every admin page except login has all three nav tabs (Schedule, Requests, Clients)", () => {
  const pages = ["admin/index.html", "admin/requests/index.html", "admin/booking/index.html", "admin/clients/index.html", "admin/client/index.html"];
  pages.forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(html.includes('href="/admin/"') && html.includes(">Schedule<"), rel + " must link to Schedule");
    assert.ok(html.includes('href="/admin/requests/"'), rel + " must link to Requests");
    assert.ok(html.includes('href="/admin/clients/"') && html.includes(">Clients<"), rel + " must link to Clients");
  });
});

test("navigation: login page has no nav tabs (unchanged convention)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin/login/index.html"), "utf8");
  assert.ok(!html.includes("admin-nav-tabs"), "login must not gain a nav bar");
});

test("navigation: the Requests nav badge markup is present on every non-login admin page, hidden by default", () => {
  const pages = ["admin/index.html", "admin/requests/index.html", "admin/booking/index.html", "admin/clients/index.html", "admin/client/index.html"];
  pages.forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(html.includes('id="nav-badge-requests"'), rel + " must include the badge element");
    assert.ok(/id="nav-badge-requests"[^>]*\shidden(?=[\s>])/.test(html), rel + " badge must start hidden");
    assert.ok(html.includes('src="' + (rel === "admin/index.html" ? "" : "../") + 'nav-badge.js"'), rel + " must load nav-badge.js");
  });
});

// =======================================================================
// 9. XSS / rendering discipline — extend the existing grep guard
// =======================================================================
test("new admin client JS (schedule.js, nav-badge.js) never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const files = ["admin/schedule.js", "admin/nav-badge.js"];
  files.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// =======================================================================
// 10. Write-scope regression guard — Stage 1 added ZERO new write paths.
// Updated in Phase 3C Stage 2.1, which deliberately DOES add two new
// .insert( calls (booking.js "+ New Job", client.js Create Client) — see
// docs/phase-3/stage2.1-new-job-proposal.md. This guard now asserts the
// write surface is exactly those three known calls, not that it never grew.
// =======================================================================
test("write-audit: exactly the known .update(/.insert(/.upsert(/.delete( calls — the pre-existing booking-status.js write plus Stage 2.1's two new inserts", () => {
  const adminLibFiles = ["admin-auth.js", "supabase-admin.js", "booking-format.js", "time-windows.js"];
  const files = fs
    .readdirSync(path.join(__dirname, "..", "api/admin"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => "api/admin/" + f)
    .concat(adminLibFiles.map((f) => "api/_lib/" + f));

  const writeCallRe = /\.(insert|update|upsert|delete)\s*\(/g;
  const found = [];
  files.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    let m;
    while ((m = writeCallRe.exec(src))) {
      found.push(rel + ": " + m[0]);
    }
  });
  found.sort(); // directory-listing order isn't a contract; sort before comparing
  assert.deepStrictEqual(
    found,
    [
      "api/admin/booking-status.js: .update(",
      "api/admin/booking.js: .insert(",
      // Phase 3C "Existing Job Editing" added exactly one new write call —
      // PATCH's handleUpdate() — deliberately, not a side effect.
      "api/admin/booking.js: .update(",
      // Phase 3C Stage 2.4 addendum (Daily Quick Expense Tracking) added
      // exactly one new write call — handleCreateExpense()'s insert into
      // the (not-yet-migrated) expenses table — deliberately, gated behind
      // an explicit resource:"expense" discriminator so it can never be
      // reached by any booking-shaped request. See
      // tests/phase3c-stage2.4-expenses.test.js for its full coverage.
      "api/admin/bookings.js: .insert(",
      "api/admin/client.js: .insert(",
    ],
    "found: " + JSON.stringify(found)
  );
});

// =======================================================================
// 11. Vercel Hobby-plan Serverless Function count — regression guard
// =======================================================================
test("deployment: total function-producing files under api/ stay within the Vercel Hobby plan's 12-function-per-deployment limit", () => {
  // Every .js file directly under api/ or any of its subdirectories, EXCEPT
  // api/_lib/ (confirmed empirically via `vercel build`'s .vercel/output
  // manifest: files under _lib do not produce their own .func output,
  // since they never export a (req, res) handler — only real endpoint
  // files do), becomes its own Serverless Function. This project hit the
  // real Hobby-plan ceiling once already during Phase 3C Stage 1 Preview
  // verification (confirmed via `vercel deploy`: "No more than 12
  // Serverless Functions can be added to a Deployment on the Hobby plan"),
  // which is why the Requests badge count lives in api/admin/bookings.js's
  // ?countsOnly=1 mode instead of its own file. This test exists so the
  // NEXT new admin endpoint added in a future Phase 3C stage fails loudly
  // here instead of failing silently at deploy time again.
  function countApiFunctionFiles(dir) {
    let count = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(path.join(__dirname, "..", "api"), full) === "_lib") return;
        count += countApiFunctionFiles(full);
      } else if (entry.name.endsWith(".js")) {
        count += 1;
      }
    });
    return count;
  }
  const total = countApiFunctionFiles(path.join(__dirname, "..", "api"));
  assert.ok(total <= 12, "api/ has " + total + " function-producing .js files, exceeding the Vercel Hobby plan's 12-function limit — consolidate a new endpoint into an existing file (see api/admin/bookings.js's countsOnly mode for the pattern) or upgrade the Vercel plan before deploying");
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
