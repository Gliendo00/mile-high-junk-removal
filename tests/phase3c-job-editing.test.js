// Local, offline test harness for Phase 3C "Existing Job Editing":
// PATCH api/admin/booking.js (Edit Job). Same approach as every prior
// phase's test file: "@supabase/supabase-js" is intercepted at require-time
// and replaced with an in-memory fake — never the real network, never the
// production Supabase project. No Preview deployment or real Supabase call
// is exercised by anything in this file.
//
// This file focuses on what's new for Edit Job (the PATCH branch). New Job
// (mode:"new"/omitted) and Past Job (mode:"past") POST coverage already
// lives in tests/phase3c-stage2-new-job.test.js and
// tests/phase3c-stage2.2-past-job.test.js and is re-run unchanged alongside
// this file, not duplicated here — same for the Client Typeahead UX in
// tests/phase3c-client-typeahead.test.js, which this stage does not touch.
//
// Run with:  node tests/phase3c-job-editing.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder supporting insert()/update()/select()/eq()/
// is()/in()/order()/maybeSingle()/single() — the union of what booking.js's
// GET, POST, and new PATCH code paths all use.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(300000000000 + nextId++).padStart(12, "0");
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
  }
  select() {
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  insert(data) {
    this._insertRow = data;
    return this;
  }
  update(data) {
    this._updateData = data;
    return this;
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  single() {
    this._single = "single";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    if (this._insertRow) {
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        return { data: null, error: this._db.__insertError[this._table] };
      }
      const row = Object.assign({ id: makeId(), created_at: "2026-09-17T12:00:00Z", updated_at: null }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._updateData) {
      if (this._db.__updateError && this._db.__updateError[this._table]) {
        return { data: null, error: this._db.__updateError[this._table] };
      }
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
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
    },
    storage: {
      from() {
        return {
          async createSignedUrl(objectPath, ttl) {
            return { data: { signedUrl: "https://mock-signed.example/" + encodeURIComponent(objectPath) + "?ttl=" + ttl }, error: null };
          },
        };
      },
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

const bookingHandler = require("../api/admin/booking.js");
const { HISTORICAL_FLOOR_ISO } = require("../api/_lib/historical-floor.js");

// ---------------------------------------------------------------------
// req/res mocks (identical shape to every prior phase's)
// ---------------------------------------------------------------------
function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), cookie: opts.cookie || "", "x-forwarded-proto": "https" },
      opts.headers || {}
    ),
    body: opts.body,
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
const NON_ADMIN_EMAIL = "someone-else@example.com";

function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const EXISTING_CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_CUSTOMER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function addDaysIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY_ISO = denverTodayIso();
const TOMORROW_ISO = addDaysIso(TODAY_ISO, 1);
const YESTERDAY_ISO = addDaysIso(TODAY_ISO, -1);
const DAY_BEFORE_FLOOR_ISO = "2025-12-31";

function freshDb() {
  return {
    customers: [
      { id: EXISTING_CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", created_at: "2026-01-01T10:00:00Z" },
      { id: OTHER_CUSTOMER_ID, first_name: "Other", last_name: "Person", phone: "303-555-0200", email: null, created_at: "2026-01-02T10:00:00Z" },
    ],
    bookings: [],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

// A "completed" (historical) job already in the database, exactly as Past
// Job would have created it.
function seedCompletedBooking(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(),
      customer_id: EXISTING_CUSTOMER_ID,
      service_type: "junk_removal",
      appointment_date: HISTORICAL_FLOOR_ISO,
      time_window: null,
      status: "completed",
      description: "Old couch",
      estimated_price: null,
      final_price: 250,
      tip_amount: 20,
      internal_notes: "Gate code 4321",
      service_address: "555 Job Site Rd",
      service_city: "Aurora",
      service_state: "CO",
      service_zip: "80010",
      created_at: "2026-01-02T10:00:00Z",
      updated_at: "2026-01-02T10:00:00Z",
    },
    overrides || {}
  );
  db.bookings.push(row);
  return row;
}

// A "booked" (upcoming) job already in the database, exactly as New Job
// would have created it.
function seedBookedBooking(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(),
      customer_id: EXISTING_CUSTOMER_ID,
      service_type: "junk_removal",
      appointment_date: TOMORROW_ISO,
      time_window: "w_0800_1000",
      status: "booked",
      description: "Garage cleanout",
      estimated_price: 300,
      final_price: null,
      tip_amount: null,
      internal_notes: null,
      service_address: "123 Main St",
      service_city: "Denver",
      service_state: "CO",
      service_zip: "80202",
      created_at: "2026-09-01T10:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
    },
    overrides || {}
  );
  db.bookings.push(row);
  return row;
}

function validPatchBody(booking, overrides) {
  return Object.assign(
    {
      id: booking.id,
      updatedAt: booking.updated_at,
      serviceType: booking.service_type,
      appointmentDate: booking.appointment_date,
      timeWindow: booking.time_window || "",
      serviceAddress: { address: booking.service_address, city: booking.service_city, state: booking.service_state, zip: booking.service_zip },
      description: booking.description,
      internalNotes: booking.internal_notes,
      finalPrice: booking.final_price,
      tipAmount: booking.tip_amount,
      estimatedPrice: booking.estimated_price,
    },
    overrides || {}
  );
}

function patchBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: cookie, body: body }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Authentication — before any booking lookup or body processing.
// =======================================================================
test("PATCH booking: no cookies at all -> 401, no row changed", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const before = Object.assign({}, booking);
  const res = await patchBooking(db, "", validPatchBody(booking, { description: "Changed" }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.deepStrictEqual(db.bookings[0], before);
});

test("PATCH booking: non-allowlisted email -> 401, no row changed", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const before = Object.assign({}, booking);
  const res = await patchBooking(db, "mhjr_admin_at=at-nonadmin", validPatchBody(booking, { description: "Changed" }));
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(db.bookings[0], before);
});

// =======================================================================
// 2. UUID validation / not-found handling
// =======================================================================
test("PATCH booking: malformed id -> 404, no row changed", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { id: "not-a-uuid" }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.bookings[0].description, "Old couch");
});

test("PATCH booking: missing id -> 400, no row changed", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const body = validPatchBody(booking);
  delete body.id;
  const res = await patchBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking: well-formed but nonexistent id -> 404, no row created or changed", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { id: NONEXISTENT_ID, updatedAt: null }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].description, "Old couch");
});

// =======================================================================
// 3. Valid PATCH — happy path for both pricing modes
// =======================================================================
test("PATCH booking: valid edit of a completed job succeeds and returns the updated booking", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Old couch and a mattress" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.description, "Old couch and a mattress");
  assert.strictEqual(res.body.ok, true);
});

test("PATCH booking: valid edit of a booked job succeeds and returns the updated booking", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Garage + shed cleanout" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.description, "Garage + shed cleanout");
});

test("PATCH booking: response never leaks the service-role or anon key", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking));
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

test("PATCH booking: response always carries Cache-Control: no-store", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking));
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

// =======================================================================
// 4. Protected fields: customer_id, id, created_at, status, and arbitrary
//    fields can never be changed via this endpoint.
// =======================================================================
test("PATCH booking: customer_id cannot be changed even if customerId is sent in the body", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { customerId: OTHER_CUSTOMER_ID }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].customer_id, EXISTING_CUSTOMER_ID);
  assert.strictEqual(res.body.booking.customerId, EXISTING_CUSTOMER_ID);
});

test("PATCH booking: the booking's own id cannot be changed by sending a different one anywhere else in the body", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { bookingId: NONEXISTENT_ID, newId: NONEXISTENT_ID }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].id, booking.id);
  assert.strictEqual(res.body.booking.id, booking.id);
});

test("PATCH booking: created_at cannot be changed", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const originalCreatedAt = booking.created_at;
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { createdAt: "2020-01-01T00:00:00Z" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].created_at, originalCreatedAt);
  assert.strictEqual(res.body.booking.createdAt, originalCreatedAt);
});

test("PATCH booking: status cannot be changed — stays the exclusive job of booking-status.js", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { status: "completed" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(res.body.booking.status, "booked");
});

test("PATCH booking: changing a booked job's date never changes its status", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const laterDate = addDaysIso(TOMORROW_ISO, 5);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: laterDate }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].status, "booked");
});

test("PATCH booking: arbitrary/unrecognized fields never become writable", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { is_admin: true, foo: "bar", role: "superuser" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(!("is_admin" in db.bookings[0]));
  assert.ok(!("foo" in db.bookings[0]));
  assert.ok(!("role" in db.bookings[0]));
});

// =======================================================================
// 5. Date-editing contract — see api/admin/booking.js's handleUpdate()
//    header comment for the full reasoning.
// =======================================================================
test("PATCH booking: submitting the SAME date a legacy/out-of-range row already has is always accepted (unrelated-field edit)", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: DAY_BEFORE_FLOOR_ISO });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Just fixing the description" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, DAY_BEFORE_FLOOR_ISO);
});

test("PATCH booking: a CHANGED date before the historical floor is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: DAY_BEFORE_FLOOR_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].appointment_date, HISTORICAL_FLOOR_ISO);
});

test("PATCH booking: the exact historical floor date is accepted as a changed date on a completed job", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: addDaysIso(HISTORICAL_FLOOR_ISO, 5) });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: HISTORICAL_FLOOR_ISO }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, HISTORICAL_FLOOR_ISO);
});

test("PATCH booking: a completed job's date can be corrected to today", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: TODAY_ISO }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, TODAY_ISO);
});

test("PATCH booking: a completed job's date cannot be moved into the future", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: TOMORROW_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/future/i.test(res.body.error));
  assert.strictEqual(db.bookings[0].appointment_date, HISTORICAL_FLOOR_ISO);
});

test("PATCH booking: a booked job's date can be corrected to another future date", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const newDate = addDaysIso(TOMORROW_ISO, 10);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: newDate }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, newDate);
});

test("PATCH booking: a booked job's date can be corrected to today", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: TODAY_ISO }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, TODAY_ISO);
});

test("PATCH booking: a booked job's date cannot be moved into the past", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: YESTERDAY_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].appointment_date, TOMORROW_ISO);
});

test("PATCH booking: a booked job whose stored date has already slipped into the past is still editable as long as the date itself is left unchanged", async () => {
  adminAuthed();
  const db = freshDb();
  // Simulates a real scenario the contract must not break: a booked job
  // nobody has marked completed yet, whose original date is now in the
  // past relative to "today."
  const booking = seedBookedBooking(db, { appointment_date: YESTERDAY_ISO });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { internalNotes: "Called to confirm" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, YESTERDAY_ISO);
  assert.strictEqual(db.bookings[0].internal_notes, "Called to confirm");
});

test("PATCH booking: a booked job whose date has already slipped into the past still CANNOT be moved to a DIFFERENT past date (not marked completed)", async () => {
  adminAuthed();
  const db = freshDb();
  // This is the intentional, by-design counterpart to the completed-job
  // tests below — see Stage 2.4.1's investigation notes in
  // docs/phase-3/stage2.4.1-schedule-ux-proposal.md: a job that LOOKS done
  // to the owner but hasn't actually been marked "completed" yet still
  // follows the non-completed rule (new date must be >= today). This is
  // almost certainly the real failure the owner hit — not a bug in the
  // completed-job path (proven not to exist by the tests below), but this
  // job simply wasn't marked completed yet when they tried.
  const booking = seedBookedBooking(db, { appointment_date: YESTERDAY_ISO });
  const differentPastDate = addDaysIso(YESTERDAY_ISO, -5);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: differentPastDate }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].appointment_date, YESTERDAY_ISO);
});

// =======================================================================
// 5b. Stage 2.4.1 — explicit regression coverage for the owner's reported
// "completed job can't be moved to another past date" issue. Investigation
// (see docs/phase-3/stage2.4.1-schedule-ux-proposal.md) found no bug in
// this exact path — these tests pin the already-correct behavior down so
// it can never silently regress, and directly reproduce the owner's own
// example dates.
// =======================================================================
test("PATCH booking (Stage 2.4.1): a completed job can move from one past date to a different, non-floor past date — owner's exact example (Sep 15 -> Aug 20)", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: "2026-09-15" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: "2026-08-20" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, "2026-08-20");
});

test("PATCH booking (Stage 2.4.1): a completed job can move from one past date to another arbitrary past date (Mar 12)", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: "2026-09-15" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: "2026-03-12" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, "2026-03-12");
});

test("PATCH booking (Stage 2.4.1): a completed job dated today can be moved to a valid past date", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: TODAY_ISO });
  const pastDate = addDaysIso(HISTORICAL_FLOOR_ISO, 3);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: pastDate }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].appointment_date, pastDate);
});

test("PATCH booking (Stage 2.4.1): a completed job still cannot move before the historical floor", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: "2026-09-15" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: DAY_BEFORE_FLOOR_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].appointment_date, "2026-09-15");
});

test("PATCH booking (Stage 2.4.1): a completed job still cannot move into the future", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { appointment_date: "2026-09-15" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { appointmentDate: addDaysIso(TODAY_ISO, 1) }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].appointment_date, "2026-09-15");
});

// =======================================================================
// 6. Time-window contract
// =======================================================================
test("PATCH booking: a completed job can have its time_window cleared to NULL", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { time_window: "w_0800_1000" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].time_window, null);
  assert.strictEqual(res.body.booking.timeWindow, null);
});

test("PATCH booking: a completed job can have a valid time_window set", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { time_window: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "w_1200_1400" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].time_window, "w_1200_1400");
});

test("PATCH booking: a completed job rejects an invalid (unrecognized) non-empty time_window", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "not-a-real-window" }));
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking: a booked job requires a valid time_window — empty is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].time_window, "w_0800_1000");
});

test("PATCH booking: a booked job requires a valid time_window — unrecognized value is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "not-a-real-window" }));
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking: a booked job accepts a valid new time_window", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "w_1400_1600" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].time_window, "w_1400_1600");
});

test("PATCH booking: a legacy public-flow time_window id (e.g. 'morning') remains valid on a booked job", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { time_window: "morning" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Unrelated edit" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].time_window, "morning");
});

// =======================================================================
// 7. Pricing semantics
// =======================================================================
test("PATCH booking: completed job's Actual Job Amount updates final_price", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 250 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 300 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].final_price, 300);
});

test("PATCH booking: completed job's Tip updates tip_amount", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { tip_amount: 20 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { tipAmount: 40 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].tip_amount, 40);
});

test("PATCH booking: tip stays independent of final_price in both directions", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 250, tip_amount: 20 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 500, tipAmount: undefined }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].final_price, 500);
  assert.strictEqual(db.bookings[0].tip_amount, null, "omitting tipAmount clears it to null rather than leaking finalPrice's new value into it");
});

test("PATCH booking: booked job's Estimated Price updates estimated_price", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { estimated_price: 300 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 450 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].estimated_price, 450);
});

test("PATCH booking: editing a completed job's pricing never touches estimated_price", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { estimated_price: 199.99 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 300, tipAmount: 30, estimatedPrice: 999 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].estimated_price, 199.99, "estimated_price must be left exactly as it was — never overwritten by a completed-mode edit, even if estimatedPrice is sent in the body");
});

test("PATCH booking: editing a booked job's pricing never touches final_price or tip_amount", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { final_price: null, tip_amount: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 500, finalPrice: 999, tipAmount: 999 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].final_price, null);
  assert.strictEqual(db.bookings[0].tip_amount, null);
});

test("PATCH booking: zero is a valid completed-job Actual Job Amount and Tip, stored as real 0 not null", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 0, tipAmount: 0 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].final_price, 0);
  assert.strictEqual(db.bookings[0].tip_amount, 0);
});

test("PATCH booking: zero is a valid booked-job Estimated Price", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 0 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].estimated_price, 0);
});

test("PATCH booking: clearing Actual Job Amount to blank stores a real NULL, not $0", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 250 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: "" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].final_price, null);
});

["finalPrice", "tipAmount"].forEach((field) => {
  test("PATCH booking (completed): negative " + field + " is rejected, nothing written", async () => {
    adminAuthed();
    const db = freshDb();
    const booking = seedCompletedBooking(db);
    const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { [field]: -5 }));
    assert.strictEqual(res.statusCode, 400);
  });

  test("PATCH booking (completed): malformed (non-numeric string) " + field + " is rejected", async () => {
    adminAuthed();
    const db = freshDb();
    const booking = seedCompletedBooking(db);
    const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { [field]: "abc" }));
    assert.strictEqual(res.statusCode, 400);
  });

  test("PATCH booking (completed): NaN/Infinity " + field + " is rejected", async () => {
    adminAuthed();
    const db = freshDb();
    const booking = seedCompletedBooking(db);
    const res1 = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { [field]: NaN }));
    assert.strictEqual(res1.statusCode, 400);
    const res2 = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { [field]: Infinity }));
    assert.strictEqual(res2.statusCode, 400);
  });

  test("PATCH booking (completed): out-of-range (too large) " + field + " is rejected", async () => {
    adminAuthed();
    const db = freshDb();
    const booking = seedCompletedBooking(db);
    const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { [field]: 99999999 }));
    assert.strictEqual(res.statusCode, 400);
  });
});

test("PATCH booking (booked): negative estimatedPrice is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: -1 }));
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking (booked): malformed estimatedPrice is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: "not-a-number" }));
  assert.strictEqual(res.statusCode, 400);
});

// =======================================================================
// 8. Address / description / notes updates
// =======================================================================
test("PATCH booking: service address snapshot fields update correctly", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(
    db,
    AUTH_COOKIE,
    validPatchBody(booking, { serviceAddress: { address: "999 New St", city: "Boulder", state: "CO", zip: "80301" } })
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].service_address, "999 New St");
  assert.strictEqual(db.bookings[0].service_city, "Boulder");
  assert.strictEqual(db.bookings[0].service_state, "CO");
  assert.strictEqual(db.bookings[0].service_zip, "80301");
});

test("PATCH booking: incomplete service address is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { serviceAddress: { address: "", city: "", state: "CO", zip: "80301" } }));
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking: description updates correctly", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Updated description text" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].description, "Updated description text");
});

test("PATCH booking: internal notes update correctly", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { internalNotes: "New private note" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].internal_notes, "New private note");
});

test("PATCH booking: description/notes can be cleared to NULL", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "", internalNotes: "" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].description, null);
  assert.strictEqual(db.bookings[0].internal_notes, null);
});

// =======================================================================
// 9. Optimistic concurrency
// =======================================================================
test("PATCH booking: a stale updatedAt token is rejected with 409, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { updated_at: "2026-05-01T00:00:00.000Z" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { updatedAt: "2026-01-01T00:00:00.000Z", description: "Attempted overwrite" }));
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "stale_update");
  assert.strictEqual(db.bookings[0].description, "Old couch");
  assert.strictEqual(db.bookings[0].updated_at, "2026-05-01T00:00:00.000Z");
});

test("PATCH booking: matching updatedAt token succeeds and advances updated_at for the next edit", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { updated_at: "2026-05-01T00:00:00.000Z" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { updatedAt: "2026-05-01T00:00:00.000Z", description: "Corrected" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].description, "Corrected");
  assert.notStrictEqual(db.bookings[0].updated_at, "2026-05-01T00:00:00.000Z");
});

test("PATCH booking: a row that has never had updated_at set (NULL) is editable, matched via updatedAt:null", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { updated_at: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { updatedAt: null, description: "First edit ever" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].description, "First edit ever");
  assert.ok(db.bookings[0].updated_at, "must set a real updated_at once edited, rather than leaving it NULL forever");
});

test("PATCH booking: two saves from a stale screen — the second (stale) save is rejected even though the booking still exists", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { updated_at: "2026-05-01T00:00:00.000Z" });
  const staleSnapshotUpdatedAt = booking.updated_at;

  const first = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { updatedAt: staleSnapshotUpdatedAt, description: "First save wins" }));
  assert.strictEqual(first.statusCode, 200, JSON.stringify(first.body));

  // Simulate a second Edit Job screen that loaded before the first save and
  // is only now submitting, with the pre-first-save updatedAt.
  const second = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { updatedAt: staleSnapshotUpdatedAt, description: "Second save should not win" }));
  assert.strictEqual(second.statusCode, 409, JSON.stringify(second.body));
  assert.strictEqual(db.bookings[0].description, "First save wins");
});

test("PATCH booking: missing updatedAt field entirely is rejected — the check is never silently skippable", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const body = validPatchBody(booking);
  delete body.updatedAt;
  const res = await patchBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].description, "Old couch");
});

// =======================================================================
// 10. Regressions: no new write path beyond what's expected, and the
//     existing GET/POST branches on this same file are unaffected.
// =======================================================================
test("PATCH booking: never touches the customers or dumpster_rentals tables", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const customersBefore = JSON.stringify(db.customers);
  await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Edited" }));
  assert.strictEqual(JSON.stringify(db.customers), customersBefore);
  assert.deepStrictEqual(db.dumpster_rentals, []);
});

test("GET booking detail: still works unaffected and now also returns updatedAt", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { updated_at: "2026-05-01T00:00:00.000Z" });
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { id: booking.id } }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.updatedAt, "2026-05-01T00:00:00.000Z");
});

test("api/book.js source is untouched by Edit Job (no PATCH/handleUpdate references leaked into the public endpoint)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/book.js"), "utf8");
  assert.ok(!/handleUpdate|stale_update/.test(src));
});

test("admin/booking.js write-audit stays exact: this stage adds exactly one new .update( call", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/admin/booking.js"), "utf8");
  const updateCalls = (src.match(/\.update\s*\(/g) || []).length;
  assert.strictEqual(updateCalls, 1, "booking.js must have exactly one .update( call (Edit Job's PATCH) — anything else needs deliberate review");
});

test("api/admin/booking-status.js (the dedicated status endpoint) is untouched by this stage", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/admin/booking-status.js"), "utf8");
  assert.ok(/the ONE intentional write capability/.test(src), "must still be the same file — not consolidated or retired");
  assert.ok(/const ALLOWED_STATUSES = \["new", "contacted", "quoted", "booked", "completed", "lost"\];/.test(src));
});

// =======================================================================
// 11. Edit Job UI: read from the real static files (no DOM harness in this
//     project — see docs/phase-3/test-matrix.md — so client-side behavior
//     is verified the same static-analysis way every prior UI test in this
//     suite already does).
// =======================================================================
function readNormalized(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

test("admin/booking-edit.js, admin/booking-detail.js never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/booking-edit.js", "admin/booking-detail.js"].forEach((rel) => {
    const src = readNormalized(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

test("admin/booking-edit.js: Cancel makes zero requests — it only ever navigates back to booking detail", () => {
  const src = readNormalized("admin/booking-edit.js");
  const startIdx = src.indexOf("cancelBtn.addEventListener");
  const cancelHandler = src.slice(startIdx, src.indexOf("});", startIdx) + 3);
  assert.ok(!/fetch\(/.test(cancelHandler), "the Cancel click handler must never call fetch(...)");
  assert.ok(/window\.location\.href = bookingId \? '\/admin\/booking\/\?id=/.test(cancelHandler), "Cancel must navigate back to the booking's detail page");
});

test("admin/booking-edit.js: Save is guarded against duplicate submission", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  assert.ok(/if \(savingInFlight\) return;/.test(submitHandler), "must bail out early if a save is already in flight");
  assert.ok(/savingInFlight = true;/.test(submitHandler), "must set the in-flight flag before the fetch call");
  assert.ok(/saveBtn\.disabled = true;/.test(submitHandler), "must visibly disable Save while saving");
});

test("admin/booking-edit.js: Save shows a visible saving state and resets it in .finally()", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  assert.ok(/saveBtn\.textContent = 'Saving…';/.test(submitHandler));
  assert.ok(/\.finally\(function \(\) \{[\s\S]*?savingInFlight = false;/.test(submitHandler), "must reset the in-flight flag in a .finally(), so a failed save doesn't lock the button forever");
});

test("admin/booking-edit.js: only the submit handler ever calls fetch(...) with method PATCH — no autosave from input/change events", () => {
  const src = readNormalized("admin/booking-edit.js");
  // Collect every addEventListener("input"/"change"/'input'/'change' block
  // for every field-like element and confirm none of them ever call fetch.
  const listenerRe = /(?:addEventListener\(\s*['"](?:input|change)['"]\s*,\s*function[\s\S]*?\{[\s\S]*?\n\s*\}\)\s*;)/g;
  const matches = src.match(listenerRe) || [];
  matches.forEach((block) => {
    assert.ok(!/fetch\(/.test(block), "an input/change listener must never call fetch(...) — no autosave: " + block.slice(0, 80));
  });
  // And confirm the PATCH call itself only appears inside the submit handler.
  const patchCallCount = (src.match(/method: 'PATCH'/g) || []).length;
  assert.strictEqual(patchCallCount, 1, "exactly one PATCH call site, inside the submit handler");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"));
  assert.ok(/method: 'PATCH'/.test(submitHandler), "the one PATCH call must live inside the submit handler");
});

test("admin/booking-edit.js: save only happens after the form's submit event (an explicit owner action), never before", () => {
  const src = readNormalized("admin/booking-edit.js");
  const beforeSubmitHandler = src.slice(0, src.indexOf("form.addEventListener('submit'"));
  assert.ok(!/method: 'PATCH'/.test(beforeSubmitHandler), "no PATCH call may exist before the submit handler is even wired");
});

test("admin/booking-edit.js: the client on a job is never sent as an editable field — no customerId in the PATCH body", () => {
  const src = readNormalized("admin/booking-edit.js");
  const submitHandler = src.slice(src.indexOf("form.addEventListener('submit'"), src.indexOf("fetch('/api/admin/booking'"));
  assert.ok(!/customerId/.test(submitHandler), "the edit form must never construct a customerId field to send");
});

test("admin/booking-edit/index.html: no client picker is mounted — the attached client cannot be changed from this page", () => {
  const html = readNormalized("admin/booking-edit/index.html");
  assert.ok(!/client-picker-mount|client-picker\.js/.test(html), "Edit Job must not load or mount the client picker");
  assert.ok(/can't be changed here/.test(html), "must tell the owner plainly that the client is fixed");
});

test("admin/booking/index.html: Edit Job link is present in the hero", () => {
  const html = readNormalized("admin/booking/index.html");
  assert.ok(/id="d-edit-job-link"/.test(html));
  assert.ok(/Edit Job/.test(html));
});

test("admin/booking-detail.js: wires the Edit Job link to /admin/booking-edit/?id=<this booking's id>", () => {
  const src = readNormalized("admin/booking-detail.js");
  assert.ok(/d-edit-job-link['"]\)\.href = '\/admin\/booking-edit\/\?id=' \+ encodeURIComponent\(booking\.id\)/.test(src));
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
