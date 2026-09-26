// Local, offline test harness for Batch 2 — archived-job exclusion and the
// two new Requests-page pseudo-filters ("archived",
// "completed_review_not_sent") across api/admin/bookings.js's list,
// countsOnly summary, and Schedule (day/year) views.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Run with:  node tests/phase3c-bookings-archive-filters.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
    this._order = null;
    this._range = null;
    this._count = null;
    this._single = false;
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((r) => r[field] === val);
    return this;
  }
  is(field, val) {
    this._filters.push((r) => (r[field] === undefined ? null : r[field]) === val);
    return this;
  }
  // Only the shape this codebase actually uses: .not(col, "is", null).
  not(field, op, val) {
    if (op === "is" && val === null) this._filters.push((r) => r[field] !== undefined && r[field] !== null);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((r) => set.has(r[field]));
    return this;
  }
  gte(field, val) {
    this._filters.push((r) => r[field] !== null && r[field] !== undefined && r[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((r) => r[field] !== null && r[field] !== undefined && r[field] <= val);
    return this;
  }
  order(field, opts) {
    this._order = { field, asc: !opts || opts.ascending !== false };
    return this;
  }
  range(from, to) {
    this._range = [from, to];
    return this;
  }
  maybeSingle() {
    this._single = true;
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    let filtered = this._rows.filter((r) => this._filters.every((f) => f(r)));
    if (this._order) {
      const { field, asc } = this._order;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
    const countTotal = filtered.length;
    if (this._range) filtered = filtered.slice(this._range[0], this._range[1] + 1);
    if (this._count && this._count.head) return { data: null, count: countTotal, error: null };
    if (this._single) return { data: filtered[0] || null, error: null };
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder((db[table] || []).slice()) };
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

(function interceptSupabaseModule() {
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
})();

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
    setHeader: (name, value) => {
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
  return Promise.resolve(handler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

let nextId = 1;
function makeId() {
  return "bbbbbbbb-bbbb-bbbb-bbbb-" + String(100000000000 + nextId++).padStart(12, "0");
}
function makeBooking(overrides) {
  return Object.assign(
    {
      id: makeId(),
      service_type: "junk_removal",
      appointment_date: "2026-09-10",
      time_window: null,
      exact_time: null,
      status: "booked",
      estimated_price: 200,
      estimated_price_max: null,
      final_price: null,
      customer_id: null,
      service_city: "Denver",
      service_address: null,
      service_state: null,
      service_zip: null,
      created_at: new Date().toISOString(),
      archived_at: null,
      archived_reason: null,
      review_request_sent_at: null,
    },
    overrides || {}
  );
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// countsOnly — every summary count excludes archived jobs
// =======================================================================
test("countsOnly: an archived 'booked' job is excluded from the total and from the booked count", async () => {
  adminAuthed();
  const active = makeBooking({ status: "booked" });
  const archived = makeBooking({ status: "booked", archived_at: new Date().toISOString(), archived_reason: "duplicate_booking" });
  const db = { bookings: [active, archived], customers: [] };
  const res = await req(db, { query: { countsOnly: "1" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.summary.total, 1);
  assert.strictEqual(res.body.summary.booked, 1);
});

// =======================================================================
// Plain list — archived excluded from "All" and from every real status filter
// =======================================================================
test("list: 'All' (no status filter) excludes archived jobs", async () => {
  adminAuthed();
  const active = makeBooking();
  const archived = makeBooking({ archived_at: new Date().toISOString() });
  const db = { bookings: [active, archived], customers: [] };
  const res = await req(db, { query: {} });
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, active.id);
  assert.strictEqual(res.body.summary.total, 1);
});

test("list: status=booked excludes an archived job that is itself status='booked'", async () => {
  adminAuthed();
  const active = makeBooking({ status: "booked" });
  const archived = makeBooking({ status: "booked", archived_at: new Date().toISOString() });
  const db = { bookings: [active, archived], customers: [] };
  const res = await req(db, { query: { status: "booked" } });
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, active.id);
});

// =======================================================================
// status=archived — the new "Archived Jobs" pseudo-filter
// =======================================================================
test("list: status=archived returns ONLY archived jobs, regardless of their real status", async () => {
  adminAuthed();
  const active = makeBooking({ status: "booked" });
  const archivedCompleted = makeBooking({ status: "completed", archived_at: new Date().toISOString(), archived_reason: "no_show" });
  const archivedNew = makeBooking({ status: null, archived_at: new Date().toISOString(), archived_reason: "entered_by_mistake" });
  const db = { bookings: [active, archivedCompleted, archivedNew], customers: [] };
  const res = await req(db, { query: { status: "archived" } });
  assert.strictEqual(res.body.bookings.length, 2);
  const ids = res.body.bookings.map((b) => b.id).sort();
  assert.deepStrictEqual(ids, [archivedCompleted.id, archivedNew.id].sort());
});

test("list: status=archived's pagination total reflects the archived-only count, not the global total", async () => {
  adminAuthed();
  const actives = [makeBooking(), makeBooking(), makeBooking()];
  const archived = makeBooking({ archived_at: new Date().toISOString() });
  const db = { bookings: [...actives, archived], customers: [] };
  const res = await req(db, { query: { status: "archived", limit: "50" } });
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.hasMore, false);
  // The always-visible pill summary is still the ACTIVE-job summary, not
  // the archived-view's own count — dashboard.js reads body.summary.total
  // unconditionally on every response to keep the top pills correct while
  // the list content below switches to the archived view.
  assert.strictEqual(res.body.summary.total, 3);
});

test("list: status=archived surfaces archivedReason on each card", async () => {
  adminAuthed();
  const archived = makeBooking({ archived_at: new Date().toISOString(), archived_reason: "test_spam" });
  const db = { bookings: [archived], customers: [] };
  const res = await req(db, { query: { status: "archived" } });
  assert.strictEqual(res.body.bookings[0].archivedReason, "test_spam");
});

// =======================================================================
// status=completed_review_not_sent
// =======================================================================
test("list: status=completed_review_not_sent returns only completed jobs with no review request sent, excludes archived", async () => {
  adminAuthed();
  const notSent = makeBooking({ status: "completed", review_request_sent_at: null });
  const sent = makeBooking({ status: "completed", review_request_sent_at: new Date().toISOString() });
  const notCompleted = makeBooking({ status: "booked", review_request_sent_at: null });
  const archivedNotSent = makeBooking({ status: "completed", review_request_sent_at: null, archived_at: new Date().toISOString() });
  const db = { bookings: [notSent, sent, notCompleted, archivedNotSent], customers: [] };
  const res = await req(db, { query: { status: "completed_review_not_sent" } });
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, notSent.id);
});

// =======================================================================
// Schedule (day) + Year — archived exclusion
// =======================================================================
test("schedule (day): an archived job on that date does not appear", async () => {
  adminAuthed();
  const active = makeBooking({ status: "booked", appointment_date: "2026-09-10" });
  const archived = makeBooking({ status: "booked", appointment_date: "2026-09-10", archived_at: new Date().toISOString() });
  const db = { bookings: [active, archived], customers: [] };
  const res = await req(db, { query: { view: "schedule", range: "day", date: "2026-09-10" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs.length, 1);
  assert.strictEqual(res.body.jobs[0].id, active.id);
});

test("year: an archived job's month is not counted", async () => {
  adminAuthed();
  const active = makeBooking({ status: "booked", appointment_date: "2026-09-10" });
  const archived = makeBooking({ status: "booked", appointment_date: "2026-09-15", archived_at: new Date().toISOString() });
  const db = { bookings: [active, archived], customers: [] };
  const res = await req(db, { query: { view: "schedule", range: "year", year: "2026" } });
  assert.strictEqual(res.statusCode, 200);
  const sept = res.body.monthCounts.find((m) => m.month === 9);
  assert.strictEqual(sept.count, 1, "only the non-archived September job should be counted");
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
