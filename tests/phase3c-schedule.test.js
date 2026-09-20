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
const vm = require("vm");

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
test("GET schedule: only 'booked', 'rental_out', and 'completed' bookings ever appear — new/contacted/quoted/lost never do, even with a matching date", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "1", status: null, appointment_date: TODAY }), // NULL = "new"
    booking({ id: "2", status: "contacted", appointment_date: TODAY }),
    booking({ id: "3", status: "quoted", appointment_date: TODAY }),
    booking({ id: "4", status: "lost", appointment_date: TODAY }),
    booking({ id: "5", status: "booked", appointment_date: TODAY }),
    booking({ id: "6", status: "completed", appointment_date: TODAY }),
    // Phase 3C Stage 4: rental_out is a dumpster rental delivered and
    // currently at the client's property — still an active job on the
    // schedule, same as booked.
    booking({ id: "7", status: "rental_out", appointment_date: TODAY, service_type: "dumpster_rental" }),
  ]);
  const res = await getSchedule(db, "mhjr_admin_at=at-good", { range: "today" });
  assert.strictEqual(res.statusCode, 200);
  const ids = res.body.jobs.map((j) => j.id).sort();
  assert.deepStrictEqual(ids, ["5", "6", "7"]);
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

// Phase 3C Stage 4 regression guard: "new" was originally derived as
// total minus exactly five known non-new statuses (contacted/quoted/
// booked/completed/lost). Adding "rental_out" without also subtracting it
// here would have silently counted every Rental Out booking as a "new"
// lead, inflating the Requests-page badge (admin/nav-badge.js) — a real bug
// found while implementing this stage, fixed in api/admin/bookings.js's
// COUNT_QUERIES/knownNonNew, and asserted directly here so it can never
// silently reappear.
test("GET bookings?countsOnly=1: a 'rental_out' booking is NOT counted as 'new' — it has its own summary.rentalOut count instead", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "1", status: null }), // the only real "new" booking
    booking({ id: "2", status: "rental_out", service_type: "dumpster_rental" }),
    booking({ id: "3", status: "booked" }),
    booking({ id: "4", status: "completed" }),
  ]);
  const res = await getCountsOnly(db, "mhjr_admin_at=at-good");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.summary.new, 1, "the rental_out booking must not fall into the derived 'new' count");
  assert.strictEqual(res.body.summary.rentalOut, 1);
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

test("navigation: Phase 3C Stage 3 — every admin page's nav bar (all 8 pages that have one) gained an Expenses tab", () => {
  const pages = [
    "admin/index.html",
    "admin/requests/index.html",
    "admin/booking/index.html",
    "admin/booking-edit/index.html",
    "admin/booking-new/index.html",
    "admin/booking-past/index.html",
    "admin/clients/index.html",
    "admin/client/index.html",
  ];
  pages.forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(html.includes('href="/admin/expenses/"') && html.includes(">Expenses<"), rel + " must link to Expenses");
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
      // Phase 3C Stage 2.5-v2's ?resource=charges workflow (originally
      // built on Braintree, switched to Stripe before any production
      // rollout — see docs/phase-3/stage2.5-stripe-rental-payments-migration.md)
      // added exactly one new insert (handleProposeCharge — moves no
      // money) and, as of the Stripe migration, eleven updates, all inside
      // handleApprove/handleCheckStatus/markChargeFailed/
      // markChargeErrorPendingReview/markChargeRequiresCustomerAction: the
      // proposed-or-failed->approved transition, the approved->processing
      // transition, the initial processing->paid attempt,
      // markChargeFailed's ->failed transition,
      // markChargeErrorPendingReview's ->error_pending_review transition
      // (an ambiguous Stripe outcome, never retryable),
      // markChargeRequiresCustomerAction's ->requires_customer_action
      // transition (Stripe-specific — an off-session confirmation needing
      // Strong Customer Authentication, also never retryable via Approve),
      // the retryUpdate-wrapped retry of the paid-confirmation write plus
      // its minimal paid_reconciliation_required fallback write (a Stripe
      // charge that DEFINITELY succeeded but couldn't be fully persisted
      // even after retries — never silently lost to Vercel logs alone),
      // and handleCheckStatus's two conditional reconciliation writes
      // (->paid, ->failed — a safe, non-charging Stripe re-fetch that
      // never creates a new charge). See
      // tests/phase3c-stage2.5v2-stripe-rental-payments.test.js for full
      // coverage of this write surface, including that a proposal alone
      // never reaches Stripe. (Sorted alphabetically below along with
      // every other entry here — see the sort() call above this array —
      // so every ".insert(" for a given file groups before that file's
      // ".update(".)
      "api/admin/booking.js: .insert(",
      // Phase 3C Stage 3 (job_payments ledger) added exactly one new insert
      // — handleCreateJobPayment(), a manual cash/Zelle/Venmo/check/card
      // entry. A Stripe-collected row is NEVER inserted here — those only
      // come from mirrorStripePaymentToLedger()'s own upsert (a function
      // call into api/_lib/job-payments-ledger.js, not a literal
      // ".insert("/".update(" in this file). See
      // tests/phase3c-stage3-job-payments.test.js.
      "api/admin/booking.js: .insert(",
      // Phase 3C "Existing Job Editing" added exactly one new write call —
      // PATCH's handleUpdate() — deliberately, not a side effect.
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      "api/admin/booking.js: .update(",
      // 2026-09-18-v2 pricing update added exactly one new write call —
      // handleProposeCharge()'s unconditional persist of
      // dumpster_rentals.actual_weight_lbs, independent of whether the
      // computed overage ends up being charged (a $0 overage is recorded
      // but never inserted as a rental_additional_charges row — that
      // table's own amount > 0 CHECK constraint wouldn't allow it). See
      // docs/phase-3/stage2.5-stripe-rental-payments-migration.md §14.
      "api/admin/booking.js: .update(",
      // Phase 3C Stage 3 (job_payments ledger) added exactly one new update
      // — handleVoidJobPayment(), the ONLY write this ledger's PATCH
      // allows (amount/method/type/booking are never editable once
      // written). See tests/phase3c-stage3-job-payments.test.js.
      "api/admin/booking.js: .update(",
      // Tip restore/manual-payment-methods follow-up added exactly one new
      // update — handleUpdateTip()'s PATCH ?resource=tip, which writes only
      // bookings.tip_amount (+ updated_at), never a job_payments row. See
      // tests/phase3c-stage3-job-payments.test.js's Tip test.
      "api/admin/booking.js: .update(",
      // Phase 3C Stage 2.4 addendum (Daily Quick Expense Tracking) added
      // exactly one new write call — handleCreateExpense()'s insert into
      // the (not-yet-migrated) expenses table — deliberately, gated behind
      // an explicit resource:"expense" discriminator so it can never be
      // reached by any booking-shaped request. See
      // tests/phase3c-stage2.4-expenses.test.js for its full coverage.
      "api/admin/bookings.js: .insert(",
      // Phase 3C Stage 3 (full Expense Management) added exactly two new
      // write calls, both inside handlePatchExpense(), both reachable only
      // via the same resource:"expense" PATCH discriminator — see
      // tests/phase3a-admin-status-write.test.js's matching comment for the
      // full explanation, and tests/phase3c-stage3-expenses-management.test.js
      // for this stage's own coverage.
      "api/admin/bookings.js: .update(",
      "api/admin/bookings.js: .update(",
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

// =======================================================================
// 8. Schedule financial counters (Phase 3C Stage 4) — same static-analysis
// approach as tests/phase3c-client-typeahead.test.js: this project's test
// setup has no DOM/jsdom harness (see that file's own header), so the
// client-side amount rules and wiring are verified by inspecting the actual
// source text rather than executing it.
// =======================================================================
function readSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8").replace(/\r\n/g, "\n");
}

test("admin/schedule-financials.js: Revenue counts 'completed' jobs only, checking for a missing finalPrice on the raw value before ever calling Number() on it", () => {
  const src = readSrc("admin/schedule-financials.js");
  assert.ok(/job\.status === 'completed'/.test(src));
  // The exact bug this guards against: Number(null) === 0, and 0 is
  // finite, so checking Number.isFinite() on the ALREADY-COERCED value
  // can never distinguish "a real $0 final price" from "no final price
  // was ever set" — this shipped once already (found live on Staging,
  // 2026-09-19) and silently dropped a completed job's estimatedPrice
  // fallback entirely. The fix must check the raw value first.
  assert.ok(
    /job\.finalPrice !== null[\s\S]{0,40}job\.finalPrice !== undefined[\s\S]{0,40}job\.finalPrice !== ''/.test(src),
    "must check the RAW job.finalPrice for null/undefined/'' before ever coercing it with Number()"
  );
  assert.ok(!/Number\.isFinite\(final\)/.test(src), "the old coerced-value isFinite check that caused the bug must be gone, not just supplemented");
});

// ---------------------------------------------------------------------
// Real behavioral regression tests for the Completed-Revenue fallback bug
// (found live on Staging, 2026-09-19, fixed same day) — a plain source-text
// check can prove the code's SHAPE but not its BEHAVIOR for the exact edge
// case that broke (finalPrice: null coercing to a "finite" 0). This project
// has no jsdom/DOM harness (see tests/phase3c-client-typeahead.test.js's
// header), so this loads the real, unmodified admin/schedule-financials.js
// source into a vm context with a minimal stub document/fetch — enough for
// show() to run its synchronous computeFromJobs()+render() path — and reads
// back the actual rendered text, the same way a browser would show it.
// ---------------------------------------------------------------------
function makeFakeFinancialsDom() {
  const els = {};
  function makeEl() {
    const classes = new Set();
    return {
      textContent: "",
      hidden: false,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
    };
  }
  ["schedule-financials", "financial-revenue-value", "financial-booked-value", "financial-expenses-value", "financial-net-value", "financial-net-card"].forEach((id) => {
    els[id] = makeEl();
  });
  return { els, document: { getElementById: (id) => els[id] || null } };
}

// Renders one job through the real admin/schedule-financials.js and returns
// the Revenue/Booked text it actually produced. The expenses fetch is
// stubbed to resolve to $0 — irrelevant here since Revenue/Booked render
// synchronously, before that fetch ever resolves (see show()'s own
// comment), so this never needs to await it.
function renderJobsWithRealFinancialsScript(jobs) {
  const src = readSrc("admin/schedule-financials.js");
  const fakeDom = makeFakeFinancialsDom();
  const sandbox = {
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ totalAmount: 0 }) }),
    document: fakeDom.document,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "admin/schedule-financials.js" });
  sandbox.AdminScheduleFinancials.show("2026-01-01", "2026-01-01", jobs);
  return { revenue: fakeDom.els["financial-revenue-value"].textContent, booked: fakeDom.els["financial-booked-value"].textContent };
}

test("Completed-Revenue regression: finalPrice=null, estimatedPrice=300 -> Revenue = $300.00 (the exact bug found live on Staging)", () => {
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: null, estimatedPrice: 300, estimatedPriceMax: 999999 }]);
  assert.strictEqual(result.revenue, "$300.00");
});

test("Completed-Revenue regression: finalPrice=undefined, estimatedPrice=300 -> Revenue = $300.00", () => {
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: undefined, estimatedPrice: 300, estimatedPriceMax: 999999 }]);
  assert.strictEqual(result.revenue, "$300.00");
});

test("Completed-Revenue regression: finalPrice='' (empty string), estimatedPrice=300 -> Revenue = $300.00", () => {
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: "", estimatedPrice: 300, estimatedPriceMax: 999999 }]);
  assert.strictEqual(result.revenue, "$300.00");
});

test("Completed-Revenue regression: finalPrice=0 (a REAL zero-dollar final price), estimatedPrice=300 -> Revenue = $0.00, never falls back", () => {
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: 0, estimatedPrice: 300, estimatedPriceMax: 999999 }]);
  assert.strictEqual(result.revenue, "$0.00");
});

test("Completed-Revenue regression: finalPrice=425, estimatedPrice=300 -> Revenue = $425.00 (finalPrice wins whenever it's actually set)", () => {
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: 425, estimatedPrice: 300, estimatedPriceMax: 999999 }]);
  assert.strictEqual(result.revenue, "$425.00");
});

test("Completed-Revenue regression: estimatedPriceMax never affects Revenue in any of the above cases (already asserted per-case via a deliberately wild 999999 value)", () => {
  // Belt-and-suspenders: same null-finalPrice case as the first regression
  // test above, but with estimatedPriceMax completely absent instead of a
  // wild number, to rule out any code path keying off its mere presence.
  const result = renderJobsWithRealFinancialsScript([{ status: "completed", finalPrice: null, estimatedPrice: 300 }]);
  assert.strictEqual(result.revenue, "$300.00");
});

test("Booked/Rental Out regression sanity check: unaffected by the Completed-Revenue fix — still summed by estimatedPrice, ignoring estimatedPriceMax", () => {
  const result = renderJobsWithRealFinancialsScript([
    { status: "booked", finalPrice: null, estimatedPrice: 200, estimatedPriceMax: 999999 },
    { status: "rental_out", finalPrice: null, estimatedPrice: 150, estimatedPriceMax: 999999 },
  ]);
  assert.strictEqual(result.booked, "$350.00");
  assert.strictEqual(result.revenue, "$0.00");
});

test("admin/schedule-financials.js: Booked counts 'booked' + 'rental_out' jobs using estimatedPrice, never estimatedPriceMax", () => {
  const src = readSrc("admin/schedule-financials.js");
  assert.ok(/job\.status === 'booked' \|\| job\.status === 'rental_out'/.test(src));
  // The header comment mentions estimatedPriceMax by name (explaining why
  // it's excluded) — this checks the actual code never reads job.
  // estimatedPriceMax, not that the string never appears anywhere at all.
  assert.ok(!/job\.estimatedPriceMax/.test(src), "estimatedPriceMax must never be read in these counters, per the locked amount rules");
});

test("admin/schedule-financials.js: Net is Revenue minus Expenses — Booked is never part of the subtraction", () => {
  const src = readSrc("admin/schedule-financials.js");
  assert.ok(/var net = revenue - expenses;/.test(src));
});

test("admin/schedule-financials.js: Expenses is fetched from the existing ?view=expenses endpoint for the exact visible range, not a new endpoint", () => {
  const src = readSrc("admin/schedule-financials.js");
  assert.ok(/\/api\/admin\/bookings\?view=expenses&startDate=/.test(src));
});

test("admin/index.html: the financial-counters container exists, is hidden by default, and schedule-financials.js loads before schedule.js", () => {
  const html = readSrc("admin/index.html");
  assert.ok(html.includes('id="schedule-financials"'));
  assert.ok(/id="schedule-financials"[^>]*hidden/.test(html), "must start hidden — Today/Tomorrow/etc. show it once real data loads, never before");
  const financialsScriptIdx = html.indexOf('src="schedule-financials.js"');
  const scheduleScriptIdx = html.indexOf('src="schedule.js"');
  assert.ok(financialsScriptIdx !== -1 && scheduleScriptIdx !== -1 && financialsScriptIdx < scheduleScriptIdx);
});

test("admin/schedule.js: shows the financial counters for Today/Tomorrow/Yesterday/day-nav with the same single-day range, and hides them while a new day is loading or before the historical floor", () => {
  const src = readSrc("admin/schedule.js");
  assert.ok(/window\.AdminScheduleFinancials\.show\(activeDateIso, activeDateIso, body\.jobs \|\| \[\]\)/.test(src));
  assert.ok(/window\.AdminScheduleFinancials\.hide\(\)/.test(src));
});

test("admin/calendar-views.js: shows the financial counters for Week/Month using the exact loaded range, and Year only ever hides them, never shows", () => {
  const src = readSrc("admin/calendar-views.js");
  assert.ok(/showFinancialsFor\(body\.weekStart, body\.weekEnd, body\.jobs\)/.test(src), "Week must pass its own loaded weekStart/weekEnd/jobs");
  assert.ok(/showFinancialsFor\(body\.startDate, body\.endDate, body\.jobs\)/.test(src), "Month must pass its own loaded startDate/endDate/jobs");

  // Year: hideFinancials() is fine anywhere; showFinancialsFor(...) must
  // never appear inside the Year section (from the "Year —" section header
  // down to the end of the file, where loadYear()/renderYearGrid() live).
  const yearSectionIdx = src.indexOf("// Year — navigation only");
  assert.ok(yearSectionIdx !== -1, "expected the existing Year section header comment to still be present");
  const yearSection = src.slice(yearSectionIdx);
  assert.ok(!/showFinancialsFor\(/.test(yearSection), "Year must never call showFinancialsFor — it carries no revenue/expense data (see api/admin/bookings.js's handleYear())");
});

// =======================================================================
// 9. Stage 4 drill-down: Revenue/Booked/Expenses click-to-open breakdown
// sheets (admin/schedule-financials.js). The same vm technique as section
// 8's Completed-Revenue regression tests, extended with a fuller fake DOM
// (createElement/appendChild/classList/addEventListener/click) so a real
// click on the real button can be simulated and the sheet's actual
// rendered rows read back — proving behavior, not just source shape.
// =======================================================================
function makeFakeElement(tag) {
  const listeners = {};
  // classSet backs BOTH .className (a plain string assignment, the pattern
  // this project's el() helper always uses) and .classList (used directly
  // for a couple of toggle() calls) — a real DOM element keeps those two
  // in sync automatically; this stub must too, or a class set via
  // `node.className = '...'` (the common case) would be invisible to a
  // later `classList.contains(...)` check, exactly the kind of silent stub
  // bug this project's own lesson (verify real behavior, not shape) warns
  // against reintroducing.
  const classSet = new Set();
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    textContent: "",
    type: "",
    disabled: false,
    hidden: false,
    children: [],
    parentNode: null,
    attrs: {},
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      toggle(c, on) {
        if (on === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (on) classSet.add(c);
        else classSet.delete(c);
      },
      contains: (c) => classSet.has(c),
    },
    setAttribute(name, val) {
      this.attrs[name] = val;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    get firstChild() {
      return node.children[0] || null;
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    dispatchEvent(evt) {
      (listeners[evt.type] || []).forEach((fn) => fn(evt));
      return true;
    },
    click() {
      this.dispatchEvent({ type: "click", target: this });
    },
    // Only what admin/schedule-financials.js itself actually needs — a
    // plain depth-first walk matching a bare ".classname" selector. Not a
    // general CSS engine; this file's own queries are all this simple.
    querySelector(selector) {
      const cls = selector.replace(/^\./, "");
      function walk(n) {
        for (const child of n.children) {
          if (child.classList && child.classList.contains(cls)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      }
      return walk(this);
    },
  };
  Object.defineProperty(node, "className", {
    get: () => Array.from(classSet).join(" "),
    set(val) {
      classSet.clear();
      String(val || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classSet.add(c));
    },
    enumerable: true,
  });
  return node;
}

// Builds a full fake `document` (schedule-financials.js's real, unmodified
// source runs against this unchanged) with real getElementById wiring for
// every id the strip's markup declares, plus a working createElement/body
// pair so the sheet overlay this file builds at runtime is a real (fake)
// DOM subtree, not a stub.
function makeFullFakeFinancialsDom() {
  const els = {};
  ["schedule-financials", "financial-revenue-value", "financial-booked-value", "financial-expenses-value", "financial-net-value", "financial-net-card"].forEach((id) => {
    els[id] = makeFakeElement("div");
  });
  ["financial-revenue-card", "financial-booked-card", "financial-expenses-card"].forEach((id) => {
    els[id] = makeFakeElement("button");
  });
  const documentListeners = {};
  const body = makeFakeElement("body");
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeFakeElement(tag),
    body,
    addEventListener(type, fn) {
      documentListeners[type] = documentListeners[type] || [];
      documentListeners[type].push(fn);
    },
    dispatchKeydown(key) {
      (documentListeners.keydown || []).forEach((fn) => fn({ key }));
    },
  };
  return { els, body, document };
}

// Loads the real, unmodified admin/schedule-financials.js into a vm context
// against the fuller fake DOM above and calls show() with the given
// jobs/expenses. expensesBody defaults to an empty, successfully-loaded
// list (never null) so Expenses-breakdown tests exercise the real loaded
// path, not the "could not load" fallback — pass expensesBody: null to
// test that fallback specifically.
function mountRealFinancialsScript(jobs, expensesBody) {
  const src = readSrc("admin/schedule-financials.js");
  const fakeDom = makeFullFakeFinancialsDom();
  const body = expensesBody === undefined ? { totalAmount: 0, expenses: [] } : expensesBody;
  const sandbox = {
    fetch: () => (body === null ? Promise.resolve({ ok: false }) : Promise.resolve({ ok: true, json: () => Promise.resolve(body) })),
    document: fakeDom.document,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "admin/schedule-financials.js" });
  sandbox.AdminScheduleFinancials.show("2026-09-13", "2026-09-19", jobs);
  return { api: sandbox.AdminScheduleFinancials, els: fakeDom.els, body: fakeDom.body, document: fakeDom.document };
}

// Walks the sheet a click just opened and pulls out every
// .admin-financial-breakdown-row-name/-amount pair plus the total line, in
// document order — the same information a real screen would show.
function readOpenSheet(fakeBody) {
  const overlay = fakeBody.querySelector("admin-sheet-overlay");
  if (!overlay) return null;
  if (overlay.hasAttribute("hidden")) return { open: false };
  const sheet = overlay.children[0];
  function collectByClass(node, cls, out) {
    for (const child of node.children) {
      if (child.classList.contains(cls)) out.push(child);
      collectByClass(child, cls, out);
    }
    return out;
  }
  const title = collectByClass(sheet, "admin-sheet-title", [])[0];
  const rangeEl = collectByClass(sheet, "admin-financial-breakdown-range", [])[0];
  const rows = collectByClass(sheet, "admin-financial-breakdown-row", []).map((row) => {
    const name = collectByClass(row, "admin-financial-breakdown-row-name", [])[0];
    const amount = collectByClass(row, "admin-financial-breakdown-row-amount", [])[0];
    const meta = collectByClass(row, "admin-financial-breakdown-row-meta", [])[0];
    const note = collectByClass(row, "admin-financial-breakdown-row-note", [])[0];
    return { name: name && name.textContent, amount: amount && amount.textContent, meta: meta && meta.textContent, note: note && note.textContent };
  });
  const emptyEl = collectByClass(sheet, "admin-empty", [])[0];
  const totalEl = collectByClass(sheet, "admin-financial-breakdown-total", [])[0];
  return {
    open: true,
    title: title && title.textContent,
    range: rangeEl && rangeEl.textContent,
    rows,
    emptyText: emptyEl && emptyEl.textContent,
    totalText: totalEl ? totalEl.children.map((c) => c.textContent).join(" ") : null,
  };
}

const REVENUE_TEST_JOBS = [
  { id: "r1", status: "completed", finalPrice: 100, estimatedPrice: 90, estimatedPriceMax: 500, appointmentDate: "2026-09-19", serviceLabel: "Junk Removal", customer: { firstName: "Alice", lastName: "Smith" } },
  { id: "r2", status: "completed", finalPrice: null, estimatedPrice: 300, appointmentDate: "2026-09-18", serviceLabel: "15-Yard Dumpster Rental", customer: { firstName: "Bob", lastName: "Jones" } },
  { id: "r3", status: "booked", finalPrice: null, estimatedPrice: 200, appointmentDate: "2026-09-19", serviceLabel: "Junk Removal", statusLabel: "Booked", customer: { firstName: "Carla", lastName: "Diaz" } },
  { id: "r4", status: "rental_out", finalPrice: null, estimatedPrice: 150, appointmentDate: "2026-09-20", serviceLabel: "15-Yard Dumpster Rental", statusLabel: "Rental Out", customer: null },
];

test("Drill-down: clicking Revenue opens a sheet listing only completed jobs, using the same amount as the counter, reconciling to it exactly", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-revenue-card"].click();
  const sheetState = readOpenSheet(mounted.body);
  assert.ok(sheetState.open, "clicking Revenue must open the sheet");
  assert.strictEqual(sheetState.title, "Revenue");
  assert.strictEqual(sheetState.rows.length, 2, "only the two completed jobs (r1, r2) belong in the Revenue breakdown");
  assert.strictEqual(sheetState.rows[0].name, "Alice Smith");
  assert.strictEqual(sheetState.rows[0].amount, "$100.00");
  assert.strictEqual(sheetState.rows[1].name, "Bob Jones");
  assert.strictEqual(sheetState.rows[1].amount, "$300.00", "Bob's row must show the estimatedPrice fallback, matching the counter");
  assert.strictEqual(sheetState.totalText, "Total Revenue $400.00", "the sum of the two rows must exactly equal what the Revenue counter itself shows");
});

test("Drill-down: clicking Booked opens a sheet listing booked + rental_out jobs (never completed), reconciling to the counter", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-booked-card"].click();
  const sheetState = readOpenSheet(mounted.body);
  assert.strictEqual(sheetState.title, "Booked");
  assert.strictEqual(sheetState.rows.length, 2, "r3 (booked) and r4 (rental_out) only");
  assert.strictEqual(sheetState.rows[0].name, "Carla Diaz");
  assert.strictEqual(sheetState.rows[0].amount, "$200.00");
  assert.ok(sheetState.rows[0].meta.indexOf("Booked") !== -1, "status must be shown in the row");
  assert.strictEqual(sheetState.rows[1].name, "Unknown client", "a job with no customer must fall back exactly like the schedule cards do");
  assert.strictEqual(sheetState.rows[1].amount, "$150.00");
  assert.ok(sheetState.rows[1].meta.indexOf("Rental Out") !== -1);
  assert.strictEqual(sheetState.totalText, "Total Booked $350.00");
});

test("Drill-down: Revenue/Booked breakdown rows never reference estimatedPriceMax even though one test job carries a wild value for it", () => {
  // REVENUE_TEST_JOBS's r1 deliberately carries estimatedPriceMax: 500 — if
  // any row/amount ever picked it up, r1's Revenue row would not read
  // exactly $100.00 (its real finalPrice).
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-revenue-card"].click();
  const sheetState = readOpenSheet(mounted.body);
  assert.strictEqual(sheetState.rows[0].amount, "$100.00");
});

test("Drill-down: clicking Expenses lists the real expense rows and shows the endpoint's own totalAmount as the total — not a client-side re-sum of the rows", () => {
  const mounted = mountRealFinancialsScript([], {
    totalAmount: 117.5,
    expenses: [
      { id: "e1", category: "fuel", categoryLabel: "Fuel", amount: 42.5, expenseDate: "2026-09-19", note: null, vendor: "Shell" },
      { id: "e2", category: "dump_fees", categoryLabel: "Dump Fee", amount: 75, expenseDate: "2026-09-17", note: "Weekend surcharge", vendor: null },
    ],
  });
  return new Promise((resolve) => {
    setImmediate(() => {
      mounted.els["financial-expenses-card"].click();
      const sheetState = readOpenSheet(mounted.body);
      assert.strictEqual(sheetState.title, "Expenses");
      assert.strictEqual(sheetState.rows.length, 2);
      assert.strictEqual(sheetState.rows[0].name, "Fuel");
      assert.strictEqual(sheetState.rows[0].amount, "$42.50");
      assert.ok(sheetState.rows[0].meta.indexOf("Shell") !== -1, "vendor must show when present");
      assert.strictEqual(sheetState.rows[1].name, "Dump Fee");
      assert.strictEqual(sheetState.rows[1].note, "Weekend surcharge", "note must show when present");
      assert.strictEqual(sheetState.totalText, "Total Expenses $117.50");
      resolve();
    });
  });
});

test("Drill-down: clicking Expenses before the expenses fetch resolves shows a calm 'not loaded yet' state, never a wrong $0 total presented as real", () => {
  const mounted = mountRealFinancialsScript([], null); // fetch never resolves ok
  mounted.els["financial-expenses-card"].click();
  const sheetState = readOpenSheet(mounted.body);
  assert.strictEqual(sheetState.title, "Expenses");
  assert.strictEqual(sheetState.rows.length, 0);
  assert.ok(sheetState.emptyText && sheetState.emptyText.indexOf("Could not load") !== -1);
});

test("Drill-down: closing the sheet (Close button) leaves it hidden and clears its content — the exact same Schedule state underneath is untouched", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-revenue-card"].click();
  assert.ok(readOpenSheet(mounted.body).open);
  const overlay = mounted.body.querySelector("admin-sheet-overlay");
  const sheet = overlay.children[0];
  const closeBtn = sheet.children[sheet.children.length - 1];
  assert.strictEqual(closeBtn.textContent, "Close");
  closeBtn.click();
  assert.strictEqual(overlay.hasAttribute("hidden"), true);
  assert.strictEqual(sheet.children.length, 0, "the sheet's content is cleared on close, never left stale for the next open");
  // The counters themselves were never touched by opening/closing the sheet.
  assert.strictEqual(mounted.els["financial-revenue-value"].textContent, "$400.00");
});

test("Drill-down: pressing Escape closes the sheet", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-booked-card"].click();
  assert.ok(readOpenSheet(mounted.body).open);
  mounted.document.dispatchKeydown("Escape");
  const overlay = mounted.body.querySelector("admin-sheet-overlay");
  assert.strictEqual(overlay.hasAttribute("hidden"), true);
});

test("Drill-down: switching to a new range (a new show() call) closes any open breakdown sheet rather than leaving stale data visible", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-revenue-card"].click();
  assert.ok(readOpenSheet(mounted.body).open);
  mounted.api.show("2026-09-20", "2026-09-20", []);
  const overlay = mounted.body.querySelector("admin-sheet-overlay");
  assert.strictEqual(overlay.hasAttribute("hidden"), true, "a new show() must close any breakdown left open from the previous range");
});

test("Drill-down: hide() (Year view) also closes any open breakdown sheet", () => {
  const mounted = mountRealFinancialsScript(REVENUE_TEST_JOBS);
  mounted.els["financial-booked-card"].click();
  assert.ok(readOpenSheet(mounted.body).open);
  mounted.api.hide();
  const overlay = mounted.body.querySelector("admin-sheet-overlay");
  assert.strictEqual(overlay.hasAttribute("hidden"), true);
});

test("Drill-down: Net has no click wiring at all — admin/index.html keeps it a plain <div>, and admin/schedule-financials.js never attaches a click handler to financial-net-card", () => {
  const html = readSrc("admin/index.html");
  assert.ok(/<div class="admin-financial-card admin-financial-net" id="financial-net-card">/.test(html), "Net must stay a plain, non-interactive <div>");
  assert.ok(!/<button[^>]*id="financial-net-card"/.test(html), "Net must never become a <button>");
  const jsSrc = readSrc("admin/schedule-financials.js");
  assert.ok(!/financial-net-card['"]\)\.addEventListener/.test(jsSrc), "no click handler may ever be attached to the Net card");
});

test("Drill-down: Revenue/Booked/Expenses are real <button> elements in admin/index.html (native keyboard activation, no custom key handling needed)", () => {
  const html = readSrc("admin/index.html");
  ["financial-revenue-card", "financial-booked-card", "financial-expenses-card"].forEach((id) => {
    const re = new RegExp('<button type="button" class="admin-financial-card [a-z-]+" id="' + id + '"');
    assert.ok(re.test(html), id + " must be a real <button type=\"button\">");
  });
});

test("admin/admin.css: the three clickable cards get pointer/hover/active/focus-visible styling, scoped so Net (a plain <div>) is never affected", () => {
  const css = readSrc("admin/admin.css");
  assert.ok(/button\.admin-financial-card\s*\{[^}]*cursor:\s*pointer/.test(css), "must be tag-qualified (button.admin-financial-card), never a bare .admin-financial-card cursor rule that would also apply to the Net div");
  assert.ok(/button\.admin-financial-card:hover/.test(css));
  assert.ok(/button\.admin-financial-card:active/.test(css));
  assert.ok(/button\.admin-financial-card:focus-visible/.test(css));
});

test("admin/schedule-financials.js: completedRevenueAmount() and bookedJobAmount() are each defined exactly once and used by both the counter and the breakdown builder — the counter and its drill-down can never disagree", () => {
  const src = readSrc("admin/schedule-financials.js");
  const completedDefs = (src.match(/function completedRevenueAmount\(/g) || []).length;
  const bookedDefs = (src.match(/function bookedJobAmount\(/g) || []).length;
  assert.strictEqual(completedDefs, 1);
  assert.strictEqual(bookedDefs, 1);
  // Called from computeFromJobs() (the counter) AND buildRevenueRows()/
  // buildBookedRows() (the breakdown) — at least 3 call sites total (1
  // definition + >=2 callers) for each, proving genuine reuse rather than
  // two separate copies of the same formula.
  const completedCalls = (src.match(/completedRevenueAmount\(job\)/g) || []).length;
  const bookedCalls = (src.match(/bookedJobAmount\(job\)/g) || []).length;
  assert.ok(completedCalls >= 2, "completedRevenueAmount(job) must be called from both computeFromJobs() and buildRevenueRows()");
  assert.ok(bookedCalls >= 2, "bookedJobAmount(job) must be called from both computeFromJobs() and buildBookedRows()");
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
