// Local, offline test harness for Batch 6 (Leads consolidation) —
// api/admin/bookings.js's new GET ?view=leads.
//
// Same interception approach as every prior admin test in this project:
// "@supabase/supabase-js" is replaced at require-time with an in-memory
// fake — never the real network, never production Supabase (which does
// not have a `leads` table yet — sql/2026-10-05_phase3c-batch6-leads.sql
// is drafted, not run; this suite never depends on it actually existing,
// same posture tests/phase3c-stage2.4-expenses.test.js already established
// for `expenses` before ITS migration ran).
//
// Primary purpose — the parity guarantee Rocky asked for: every booking
// row Requests' own existing, UNCHANGED default list (GET /api/admin/
// bookings with no view/status filter — the "All" tab) shows today must
// still be reachable from ?view=leads. Nothing may silently disappear.
//
// Run with:  node tests/phase3c-batch6-leads-view.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase: a query builder covering exactly what the default GET
// (bookingsHandler, unchanged) and the new handleLeadsView() use: select/
// eq/in/is/order, plus count-only head requests for the default list's own
// six status-count queries. Table-name-generic (db[table] || []), so a
// fixture that never defines db.leads still "exists" as an empty table —
// exactly how this suite exercises ?view=leads before its migration has
// ever been run anywhere.
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._count = null;
    this._statusValue = undefined; // tracked only so __forceError can target one specific status query, see eq()/is() below
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    if (field === "status") this._statusValue = val;
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    if (field === "status") this._statusValue = val; // null here means the "websiteRequests" (IS NULL) query
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
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    // Error injection for the resilience tests below — db.__forceError is
    // either `{ table: true }` (every query against that table fails) or
    // `{ table: { statuses: [...] } }` (only queries filtered to one of
    // those status values fail — e.g. simulate ONLY the "quoted" query
    // hitting a real 42703, leaving the other 6 bookings-status queries
    // and the leads query completely unaffected, exactly like a single
    // missing-column error would in production).
    const forceSpec = this._db.__forceError && this._db.__forceError[this._table];
    if (forceSpec === true || (forceSpec && forceSpec.statuses && forceSpec.statuses.indexOf(this._statusValue) !== -1)) {
      return { data: null, error: { code: "42703", message: 'column "simulated" does not exist' } };
    }

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
    if (this._count && this._count.head) {
      return { data: null, count: filtered.length, error: null };
    }
    if (this._range) {
      filtered = filtered.slice(this._range[0], this._range[1] + 1);
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
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
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeaders: () => headers,
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
function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingsHandler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

// ---------------------------------------------------------------------
// Fixture: one real customer + one booking per bookings.status value
// (null/contacted/quoted/booked/rental_out/completed/lost), plus one
// archived booking (status null) that must stay excluded everywhere —
// exactly as it's already excluded from Requests today. Also a small
// `leads` table with one row per leads.status value and every `source`.
// ---------------------------------------------------------------------
const CUST_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STATUSES = [null, "contacted", "quoted", "booked", "rental_out", "completed", "lost"];

function makeBookingId(status) {
  return "bbbbbbbb-bbbb-bbbb-bbbb-" + Buffer.from(String(status)).toString("hex").padEnd(12, "0").slice(0, 12);
}

function freshDb() {
  const bookings = STATUSES.map((status, i) => ({
    id: makeBookingId(status || "new"),
    customer_id: CUST_ID,
    service_type: "junk_removal",
    service_city: "Denver",
    status: status,
    archived_at: null,
    created_at: "2026-10-0" + (i + 1) + "T10:00:00Z",
    updated_at: "2026-10-0" + (i + 1) + "T10:00:00Z",
  }));
  bookings.push({
    id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    customer_id: CUST_ID,
    service_type: "junk_removal",
    service_city: "Denver",
    status: null,
    archived_at: "2026-09-01T00:00:00Z",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
  });

  const LEAD_STATUSES = ["new", "contacted", "waiting_on_photos", "estimate_sent", "follow_up", "booked", "lost"];
  const leads = LEAD_STATUSES.map((status, i) => ({
    id: "dddddddd-dddd-dddd-dddd-" + String(100000000000 + i).padStart(12, "0"),
    source: i % 3 === 0 ? "screenshot_intake" : i % 3 === 1 ? "phone" : "manual",
    status: status,
    first_name: "Lead" + i,
    last_name: "Status" + status,
    phone: "303-555-02" + String(i).padStart(2, "0"),
    city: "Aurora",
    service_type: "junk_removal",
    created_at: "2026-10-1" + i + "T10:00:00Z",
    updated_at: "2026-10-1" + i + "T10:00:00Z",
    next_follow_up_date: status === "follow_up" ? "2026-10-20" : null,
  }));

  return {
    customers: [{ id: CUST_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", city: "Denver" }],
    bookings: bookings,
    // Deliberately present, so this suite exercises the real union logic
    // against real rows — a separate test below also proves the endpoint
    // degrades to an empty section (never an error) when `leads` is
    // entirely absent, i.e. before the migration has ever run.
    leads: leads,
  };
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

function sectionIds(sections) {
  const ids = [];
  Object.keys(sections).forEach((k) => sections[k].forEach((item) => ids.push(item.id)));
  return ids;
}

// ---------------------------------------------------------------------
// 1. THE parity guarantee
// ---------------------------------------------------------------------
test("parity: every booking id visible in Requests' own unchanged default ('All') list is still reachable from ?view=leads", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);

  const requestsRes = await run(makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(requestsRes.statusCode, 200);
  const requestsVisibleIds = requestsRes.body.bookings.map((b) => b.id);
  // Sanity: the fixture's 7 non-archived bookings, and only those.
  assert.strictEqual(requestsVisibleIds.length, 7);

  const leadsRes = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(leadsRes.statusCode, 200);
  const leadsVisibleIds = sectionIds(leadsRes.body.sections);

  requestsVisibleIds.forEach((id) => {
    assert.ok(leadsVisibleIds.indexOf(id) !== -1, "booking " + id + " is visible in Requests today but missing from ?view=leads");
  });
});

test("parity: the archived booking — already excluded from Requests today — stays excluded from ?view=leads too (never silently resurrected)", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);

  const leadsRes = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  const leadsVisibleIds = sectionIds(leadsRes.body.sections);
  assert.ok(leadsVisibleIds.indexOf("cccccccc-cccc-cccc-cccc-cccccccccccc") === -1);
});

// ---------------------------------------------------------------------
// 2. Bucket placement — website-origin bookings land in the bucket the
//    proposal's status-mapping table specified.
// ---------------------------------------------------------------------
test("?view=leads: a website booking with status NULL lands in 'websiteRequests', tagged source=website", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  const card = res.body.sections.websiteRequests.find((c) => c.id === makeBookingId("new"));
  assert.ok(card, "the NULL-status booking must appear in websiteRequests");
  assert.strictEqual(card.kind, "booking");
  assert.strictEqual(card.source, "website");
  assert.strictEqual(card.name, "Jamie Rivera");
});

test("?view=leads: website status mapping — contacted->contacted, quoted->estimateSent, lost->lost, {booked,rental_out,completed}->bookedWon", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  const s = res.body.sections;

  assert.ok(s.contacted.some((c) => c.id === makeBookingId("contacted")));
  assert.ok(s.estimateSent.some((c) => c.id === makeBookingId("quoted")));
  assert.ok(s.lost.some((c) => c.id === makeBookingId("lost")));
  ["booked", "rental_out", "completed"].forEach((status) => {
    assert.ok(s.bookedWon.some((c) => c.id === makeBookingId(status)), status + " booking must appear in bookedWon");
  });
});

// ---------------------------------------------------------------------
// 3. leads-table rows — bucket placement, source tags, next-follow-up
// ---------------------------------------------------------------------
test("?view=leads: leads-table rows are bucketed by their own status and keep their real source tag", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  const s = res.body.sections;

  const newLead = s.new.find((c) => c.kind === "lead");
  assert.ok(newLead);
  assert.strictEqual(newLead.source, "screenshot_intake");

  assert.ok(s.waitingOnPhotos.some((c) => c.kind === "lead"));
  assert.ok(s.followUp.some((c) => c.kind === "lead" && c.nextFollowUpDate === "2026-10-20"));
  assert.ok(s.estimateSent.some((c) => c.kind === "lead"), "a leads-table estimate_sent row must share the estimateSent bucket with website quoted bookings");
  assert.ok(s.bookedWon.some((c) => c.kind === "lead"), "a leads-table booked row must share the bookedWon bucket with website booked/rental_out/completed bookings");
});

test("?view=leads: still returns every section (all empty, never an error) when the `leads` table doesn't exist in this environment yet", async () => {
  adminAuthed();
  const db = freshDb();
  delete db.leads; // simulates every environment today — the migration hasn't run anywhere
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.sections.new, []);
  assert.deepStrictEqual(res.body.sections.waitingOnPhotos, []);
  // Website-origin sections are completely unaffected by `leads` being absent.
  assert.strictEqual(res.body.sections.websiteRequests.length, 1);
});

// ---------------------------------------------------------------------
// 4. Never writes anything — a pure read, same guarantee this project
//    gives every other read-only view= mode.
// ---------------------------------------------------------------------
test("?view=leads: never mutates bookings, customers, or leads — a pure read", async () => {
  adminAuthed();
  const db = freshDb();
  const before = JSON.stringify(db);
  currentFakeService = createFakeServiceClient(db);
  await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(JSON.stringify(db), before, "the database must be byte-for-byte unchanged after a ?view=leads request");
});

test("?view=leads: requireAdmin() gates this view exactly like every other — no cookie -> 401, no data leaked", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ query: { view: "leads" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.sections, undefined);
});

// =======================================================================
// Resilience — the Preview QA finding (2026-10): one query among the 8
// erroring (a column missing on a given environment — see
// tests/phase3c-batch6-leads-schema-contract.test.js for why) must not
// blank the entire page. Simulates exactly that: ONE status query fails
// with a real 42703-shaped error, every other query is completely
// unaffected and still has real fixture data behind it.
// =======================================================================
test("?view=leads: one query erroring (simulated 42703) degrades that query's own section to empty, but every OTHER section still renders its real data, status 200", async () => {
  adminAuthed();
  const db = freshDb();
  db.__forceError = { bookings: { statuses: ["quoted"] } };
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));

  assert.strictEqual(res.statusCode, 200, "a single query failure must never turn into a 500 for the whole view");
  assert.strictEqual(res.body.sections.estimateSent.filter((c) => c.kind === "booking").length, 0, "the failed (quoted) query's own website-origin contribution to estimateSent must be empty");
  assert.ok(Array.isArray(res.body.sectionErrors) && res.body.sectionErrors.indexOf("estimateSent") !== -1, "the failure must be named in sectionErrors");

  // Every other bookings-status section (unaffected by the simulated
  // failure) must still show its real fixture data — the whole point of
  // this fix is that ONE bad query doesn't take the other 7 down with it.
  assert.ok(res.body.sections.websiteRequests.some((c) => c.id === makeBookingId("new")));
  assert.ok(res.body.sections.contacted.some((c) => c.id === makeBookingId("contacted")));
  assert.ok(res.body.sections.lost.some((c) => c.id === makeBookingId("lost")));
  assert.ok(res.body.sections.bookedWon.some((c) => c.id === makeBookingId("booked")));
});

test("?view=leads: the leads table erroring degrades only the leads-table-sourced rows — website-origin sections are completely unaffected", async () => {
  adminAuthed();
  const db = freshDb();
  db.__forceError = { leads: true };
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.sectionErrors.indexOf("leads table") !== -1);
  assert.deepStrictEqual(res.body.sections.new, [], "leads-table-only sections are empty when that table errors");
  // Website-origin sections (independent queries) are untouched.
  assert.ok(res.body.sections.websiteRequests.some((c) => c.id === makeBookingId("new")));
  assert.ok(res.body.sections.estimateSent.some((c) => c.id === makeBookingId("quoted")));
});

test("?view=leads: no sectionErrors field at all when every query succeeds (unchanged response shape for the common case)", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.sectionErrors, undefined);
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
