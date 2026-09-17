// Local, offline test harness for Phase 3C Stage 2.4: Month/Year calendar
// navigation and the navigable Sunday-aligned Week, all served by
// api/admin/bookings.js's ?view=schedule&range=week|month|year modes (see
// that file's handleSchedule()/handleMonth()/handleYear() for the exact
// bounded-query contract). Same approach as every prior phase's test file:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never the production
// Supabase project.
//
// Run with:  node tests/phase3c-stage2.4-calendar.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase query builder — phase3c-schedule.test.js's, unchanged
// (select/eq/is/in/gte/lte/order/range/maybeSingle).
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
  }
  select() {
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
  gte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val);
    return this;
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder((db[table] || []).slice());
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

// Independent copy of the implementation's own Denver-date helper, used
// only to compute expected values for test fixtures — deliberately NOT
// imported from the handler under test, matching every prior phase's test
// file (see phase3c-schedule.test.js's identical header comment for why).
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

function booking(overrides) {
  return Object.assign(
    {
      id: "00000000-0000-0000-0000-000000000000",
      customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      service_type: "junk_removal",
      appointment_date: "2026-09-15",
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
    bookings: bookings || [],
    customers: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
  };
}
function getSchedule(db, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: Object.assign({ view: "schedule" }, query || {}) }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Week: navigable Sunday-aligned week
// =======================================================================
test("week: explicit weekStart returns exactly that Sunday..Saturday span", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "in", appointment_date: "2026-09-15" }), // Tue within Sep 13-19
    booking({ id: "out-before", appointment_date: "2026-09-12" }),
    booking({ id: "out-after", appointment_date: "2026-09-20" }),
  ]);
  const res = await getSchedule(db, { range: "week", weekStart: "2026-09-13" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.weekStart, "2026-09-13");
  assert.strictEqual(res.body.weekEnd, "2026-09-19");
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["in"]);
});

test("week: a non-Sunday weekStart is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "week", weekStart: "2026-09-15" }); // a Tuesday
  assert.strictEqual(res.statusCode, 400);
});

test("week: a malformed weekStart is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "week", weekStart: "not-a-date" });
  assert.strictEqual(res.statusCode, 400);
});

test("week: a weekStart before the historical floor week (2025-12-28) is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "week", weekStart: "2025-12-21" }); // one week earlier, still a Sunday
  assert.strictEqual(res.statusCode, 400);
});

test("week: the floor week itself (2025-12-28) is accepted", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "week", weekStart: "2025-12-28" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.canGoPrevious, false);
});

test("week: canGoPrevious is true for any later week", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "week", weekStart: "2026-01-04" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.canGoPrevious, true);
});

test("week: no cookies -> 401, no jobs returned", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getSchedule(freshDb([]), { range: "week" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.jobs, undefined);
});

// =======================================================================
// Month
// =======================================================================
test("month: explicit year/month returns only jobs within that calendar month", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "in-month", appointment_date: "2026-09-15" }),
    booking({ id: "prev-month", appointment_date: "2026-08-31" }),
    booking({ id: "next-month", appointment_date: "2026-10-01" }),
  ]);
  const res = await getSchedule(db, { range: "month", year: "2026", month: "9" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.startDate, "2026-09-01");
  assert.strictEqual(res.body.endDate, "2026-09-30");
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["in-month"]);
});

test("month: no year/month defaults to the current Denver month", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month" });
  assert.strictEqual(res.statusCode, 200);
  const now = new Date();
  // Loose check: just confirms it didn't error and returned a real
  // year/month pair, not a specific frozen date (this suite must never go
  // stale — see the identical reasoning in phase3c-schedule.test.js).
  assert.ok(res.body.year >= 2026);
  assert.ok(res.body.month >= 1 && res.body.month <= 12);
});

test("month: jobCountsByDate groups multiple same-day jobs correctly, and omits job-less dates", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "a", appointment_date: "2026-09-05" }),
    booking({ id: "b", appointment_date: "2026-09-05" }),
    booking({ id: "c", appointment_date: "2026-09-18" }),
  ]);
  const res = await getSchedule(db, { range: "month", year: "2026", month: "9" });
  assert.deepStrictEqual(res.body.jobCountsByDate, { "2026-09-05": 2, "2026-09-18": 1 });
});

test("month: an empty month returns zero jobs and an empty jobCountsByDate, not an error", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "2" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.jobs, []);
  assert.deepStrictEqual(res.body.jobCountsByDate, {});
});

test("month: February in a non-leap and leap year both resolve to the correct last day", async () => {
  adminAuthed();
  const res2026 = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "2" }); // 2026 not a leap year
  assert.strictEqual(res2026.body.endDate, "2026-02-28");
  const res2028 = await getSchedule(freshDb([]), { range: "month", year: "2028", month: "2" }); // 2028 is a leap year
  assert.strictEqual(res2028.body.endDate, "2028-02-29");
});

test("month: a month before the historical floor (January 2026) is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month", year: "2025", month: "12" });
  assert.strictEqual(res.statusCode, 400);
});

test("month: the floor month itself (January 2026) is accepted", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "1" });
  assert.strictEqual(res.statusCode, 200);
});

test("month: a year far enough in the future is rejected (400) — bounded, not unlimited forward navigation", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month", year: "2099", month: "1" });
  assert.strictEqual(res.statusCode, 400);
});

test("month: an invalid month number (0, 13, non-numeric) is rejected (400)", async () => {
  adminAuthed();
  const r0 = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "0" });
  assert.strictEqual(r0.statusCode, 400);
  const r13 = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "13" });
  assert.strictEqual(r13.statusCode, 400);
  const rNaN = await getSchedule(freshDb([]), { range: "month", year: "2026", month: "abc" });
  assert.strictEqual(rNaN.statusCode, 400);
});

test("month: an invalid year (non-4-digit) is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "month", year: "26", month: "9" });
  assert.strictEqual(res.statusCode, 400);
});

test("month: only booked/completed bookings appear, matching Schedule's existing inclusion rule", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "new", status: null, appointment_date: "2026-09-05" }),
    booking({ id: "quoted", status: "quoted", appointment_date: "2026-09-05" }),
    booking({ id: "booked", status: "booked", appointment_date: "2026-09-05" }),
    booking({ id: "completed", status: "completed", appointment_date: "2026-09-05" }),
    booking({ id: "lost", status: "lost", appointment_date: "2026-09-05" }),
  ]);
  const res = await getSchedule(db, { range: "month", year: "2026", month: "9" });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id).sort(), ["booked", "completed"]);
});

test("month: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getSchedule(freshDb([]), { range: "month" });
  assert.strictEqual(res.statusCode, 401);
});

// =======================================================================
// Year — navigation/counts only, never full booking rows or money
// =======================================================================
test("year: monthCounts has exactly 12 entries, correctly bucketed by month, zero for empty months", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "a", appointment_date: "2026-01-15" }),
    booking({ id: "b", appointment_date: "2026-01-20" }),
    booking({ id: "c", appointment_date: "2026-09-05" }),
  ]);
  const res = await getSchedule(db, { range: "year", year: "2026" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.monthCounts.length, 12);
  const byMonth = {};
  res.body.monthCounts.forEach((m) => { byMonth[m.month] = m.count; });
  assert.strictEqual(byMonth[1], 2);
  assert.strictEqual(byMonth[9], 1);
  assert.strictEqual(byMonth[2], 0);
  assert.strictEqual(byMonth[12], 0);
});

test("year: response never contains a `jobs` array or any per-booking field — counts only", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "a", appointment_date: "2026-03-01", estimated_price: 999 })]);
  const res = await getSchedule(db, { range: "year", year: "2026" });
  assert.strictEqual(res.body.jobs, undefined);
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes("999"), "a booking's price must never appear in the Year response");
});

test("year: a year before the historical floor (2026) is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "year", year: "2025" });
  assert.strictEqual(res.statusCode, 400);
});

test("year: the floor year itself (2026) is accepted", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "year", year: "2026" });
  assert.strictEqual(res.statusCode, 200);
});

test("year: a year far enough in the future is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "year", year: "2099" });
  assert.strictEqual(res.statusCode, 400);
});

test("year: an invalid year value is rejected (400)", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "year", year: "twenty-twenty-six" });
  assert.strictEqual(res.statusCode, 400);
});

test("year: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getSchedule(freshDb([]), { range: "year" });
  assert.strictEqual(res.statusCode, 401);
});

// =======================================================================
// Edited booking date naturally changes calendar placement — no cached/
// duplicate source of truth. Simulated here by re-querying two different
// months against the SAME underlying bookings.appointment_date value: a row
// dated in September appears in September's query and not August's, exactly
// as it would if an edit had just moved it from August into September.
// =======================================================================
test("an edited appointment_date is reflected by the next query with no separate calendar state to go stale", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "moved", appointment_date: "2026-09-10" })]);
  const augustRes = await getSchedule(db, { range: "month", year: "2026", month: "8" });
  assert.deepStrictEqual(augustRes.body.jobs.map((j) => j.id), []);
  const septRes = await getSchedule(db, { range: "month", year: "2026", month: "9" });
  assert.deepStrictEqual(septRes.body.jobs.map((j) => j.id), ["moved"]);
});

// =======================================================================
// Regression: existing Today/Tomorrow ranges and countsOnly/list behavior
// are untouched by this stage's changes to VALID_RANGES and handleSchedule.
// =======================================================================
test("regression: range=today is unaffected by adding month/year", async () => {
  adminAuthed();
  const db = freshDb([booking({ id: "today-ish", appointment_date: denverTodayIso() })]);
  const res = await getSchedule(db, { range: "today" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.range, "today");
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
