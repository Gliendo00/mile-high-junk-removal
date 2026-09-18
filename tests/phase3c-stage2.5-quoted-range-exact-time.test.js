// Local, offline test harness for Phase 3C Stage 2.5: Quoted Amount
// (exact/range via bookings.estimated_price + estimated_price_max) and
// Appointment Time (exact via bookings.exact_time, alongside the existing
// time_window). Same approach as every prior phase's test file:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never the production
// Supabase project. No Preview deployment or real Supabase call is
// exercised by anything in this file.
//
// This file covers what's new for Stage 2.5 only. New Job/Past Job/Edit Job
// coverage that predates this stage (client picker, address, dates,
// existing pricing/time-window rules, concurrency, etc.) already lives in
// tests/phase3c-stage2-new-job.test.js, tests/phase3c-stage2.2-past-job.test.js,
// and tests/phase3c-job-editing.test.js and is re-run unchanged alongside
// this file, not duplicated here. Schedule sort/response-shape coverage
// that predates this stage lives in tests/phase3c-schedule.test.js.
//
// Run with:  node tests/phase3c-stage2.5-quoted-range-exact-time.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: one query builder supporting everything both
// api/admin/booking.js (insert/update/select/eq/is/in/order/maybeSingle/
// single) and api/admin/bookings.js's Schedule mode (gte/lte/range/count)
// use — the union of tests/phase3c-job-editing.test.js's and
// tests/phase3c-schedule.test.js's own builders, since this file exercises
// both handlers.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(500000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._range = null;
    this._count = null;
    this._single = null;
    this._insertRow = null;
    this._updateData = null;
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
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
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
    const countTotal = filtered.length;
    if (this._range) filtered = filtered.slice(this._range[0], this._range[1] + 1);
    if (this._count && this._count.head) return { data: null, count: countTotal, error: null };
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
const bookingsHandler = require("../api/admin/bookings.js");
const { HISTORICAL_FLOOR_ISO } = require("../api/_lib/historical-floor.js");
const { formatExactTime, effectiveTimeSortMinutes } = require("../api/_lib/time-windows.js");
const { effectiveTimeLabel } = require("../api/_lib/booking-format.js");

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
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const EXISTING_CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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

function freshDb(bookings) {
  return {
    customers: [{ id: EXISTING_CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
    bookings: bookings || [],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

function seedBookedBooking(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(),
      customer_id: EXISTING_CUSTOMER_ID,
      service_type: "junk_removal",
      appointment_date: TOMORROW_ISO,
      time_window: "w_0800_1000",
      exact_time: null,
      status: "booked",
      description: "Garage cleanout",
      estimated_price: 300,
      estimated_price_max: null,
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

function seedCompletedBooking(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(),
      customer_id: EXISTING_CUSTOMER_ID,
      service_type: "junk_removal",
      appointment_date: HISTORICAL_FLOOR_ISO,
      time_window: null,
      exact_time: null,
      status: "completed",
      description: "Old couch",
      estimated_price: null,
      estimated_price_max: null,
      final_price: 250,
      tip_amount: 20,
      internal_notes: null,
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

function createJob(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}
function patchBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: cookie, body: body }));
}
function getBooking(db, cookie, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ cookie: cookie, query: { id: id } }));
}
function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: cookie, query: Object.assign({ view: "schedule" }, query || {}) }));
}

function baseNewJobBody(overrides) {
  return Object.assign(
    {
      customerId: EXISTING_CUSTOMER_ID,
      serviceType: "junk_removal",
      appointmentDate: TOMORROW_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
    overrides || {}
  );
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

function readSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. api/_lib/time-windows.js — formatExactTime / effectiveTimeSortMinutes
// =======================================================================
test("formatExactTime: '09:00:00' (Postgres round-trip) -> '9:00 AM'", () => {
  assert.strictEqual(formatExactTime("09:00:00"), "9:00 AM");
});
test("formatExactTime: '13:30' (bare <input type=time> value) -> '1:30 PM'", () => {
  assert.strictEqual(formatExactTime("13:30"), "1:30 PM");
});
test("formatExactTime: midnight and noon boundaries", () => {
  assert.strictEqual(formatExactTime("00:00:00"), "12:00 AM");
  assert.strictEqual(formatExactTime("12:00:00"), "12:00 PM");
});
test("formatExactTime: null/undefined/empty/garbage -> null, never a raw/garbled string", () => {
  assert.strictEqual(formatExactTime(null), null);
  assert.strictEqual(formatExactTime(undefined), null);
  assert.strictEqual(formatExactTime(""), null);
  assert.strictEqual(formatExactTime("not-a-time"), null);
  assert.strictEqual(formatExactTime("25:00"), null);
});
test("effectiveTimeSortMinutes: exact_time takes precedence over time_window when both are present (defensive — the DB constraint prevents this for new rows)", () => {
  assert.strictEqual(effectiveTimeSortMinutes("w_1600_1800", "09:30:00"), 9 * 60 + 30);
});
test("effectiveTimeSortMinutes: falls back to the window's start hour when exact_time is absent", () => {
  assert.strictEqual(effectiveTimeSortMinutes("w_0800_1000", null), 8 * 60);
});
test("effectiveTimeSortMinutes: null when neither is set/recognized — sorts last, never throws", () => {
  assert.strictEqual(effectiveTimeSortMinutes(null, null), null);
  assert.strictEqual(effectiveTimeSortMinutes("not-a-real-window", ""), null);
});

// =======================================================================
// 2. api/_lib/booking-format.js — effectiveTimeLabel
// =======================================================================
test("effectiveTimeLabel: exact_time wins and formats as clock time", () => {
  assert.strictEqual(effectiveTimeLabel("w_0800_1000", "09:30:00"), "9:30 AM");
});
test("effectiveTimeLabel: falls back to the window label", () => {
  assert.strictEqual(effectiveTimeLabel("w_0800_1000", null), "8:00 AM – 10:00 AM");
});
test("effectiveTimeLabel: legacy broad window label still renders (unaffected by this stage)", () => {
  assert.strictEqual(effectiveTimeLabel("morning", null), "Morning (8am–11am)");
});
test("effectiveTimeLabel: neither set -> '—'", () => {
  assert.strictEqual(effectiveTimeLabel(null, null), "—");
});

// =======================================================================
// 3. POST New Job — appointment time: exact XOR window, one required
// =======================================================================
test("POST New Job: exactTime alone creates the job with exact_time set, time_window null", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ timeWindow: "", exactTime: "09:30" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].exact_time, "09:30");
  assert.strictEqual(db.bookings[0].time_window, null);
  assert.strictEqual(res.body.booking.exactTime, "09:30");
  assert.strictEqual(res.body.booking.timeLabel, "9:30 AM");
});

test("POST New Job: timeWindow alone still works exactly as before this stage", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ timeWindow: "w_1000_1200", exactTime: "" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].time_window, "w_1000_1200");
  assert.strictEqual(db.bookings[0].exact_time, null);
});

test("POST New Job: both timeWindow and exactTime non-empty -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ timeWindow: "w_0800_1000", exactTime: "09:30" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST New Job: neither timeWindow nor exactTime -> 400 (one is required), no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ timeWindow: "" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST New Job: malformed exactTime ('9:30 AM', '25:00', '9:3') -> 400", async () => {
  adminAuthed();
  for (const bad of ["9:30 AM", "25:00", "9:3", "09:60"]) {
    const db = freshDb();
    const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ timeWindow: "", exactTime: bad }));
    assert.strictEqual(res.statusCode, 400, "expected 400 for exactTime=" + JSON.stringify(bad));
    assert.strictEqual(db.bookings.length, 0);
  }
});

// =======================================================================
// 4. POST Past Job — appointment time stays fully optional in either mode
// =======================================================================
test("POST Past Job: neither timeWindow nor exactTime -> succeeds, both null (unchanged from before this stage)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ mode: "past", appointmentDate: TODAY_ISO, timeWindow: "" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].time_window, null);
  assert.strictEqual(db.bookings[0].exact_time, null);
});

test("POST Past Job: exactTime alone succeeds", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ mode: "past", appointmentDate: TODAY_ISO, timeWindow: "", exactTime: "14:15" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].exact_time, "14:15");
});

test("POST Past Job: both timeWindow and exactTime non-empty -> 400, mirrors New Job", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ mode: "past", appointmentDate: TODAY_ISO, timeWindow: "w_0800_1000", exactTime: "14:15" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 5. POST New Job — Quoted Amount range (estimated_price_max)
// =======================================================================
test("POST New Job: estimatedPrice alone (no max) creates an exact quote — estimated_price_max stays null", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ estimatedPrice: 350 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price, 350);
  assert.strictEqual(db.bookings[0].estimated_price_max, null);
});

test("POST New Job: estimatedPrice + estimatedPriceMax creates a range", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ estimatedPrice: 350, estimatedPriceMax: 475 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price, 350);
  assert.strictEqual(db.bookings[0].estimated_price_max, 475);
  assert.strictEqual(res.body.booking.estimatedPriceMax, 475);
});

test("POST New Job: estimatedPriceMax without estimatedPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ estimatedPriceMax: 475 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST New Job: estimatedPriceMax equal to estimatedPrice -> 400 (must be strictly greater)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ estimatedPrice: 350, estimatedPriceMax: 350 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST New Job: estimatedPriceMax less than estimatedPrice -> 400", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ estimatedPrice: 350, estimatedPriceMax: 200 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST Past Job: estimatedPriceMax is never read in past mode, even if sent — mirrors estimatedPrice's existing invisibility to Past Job", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createJob(db, AUTH_COOKIE, baseNewJobBody({ mode: "past", appointmentDate: TODAY_ISO, timeWindow: "", estimatedPrice: 999999, estimatedPriceMax: 999999 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price, null);
  assert.strictEqual(db.bookings[0].estimated_price_max, null);
});

// =======================================================================
// 6. PATCH Edit Job — switching appointment-time mode nulls the inactive field
// =======================================================================
test("PATCH booking (booked): switching from Time Window to Exact Time nulls time_window and sets exact_time", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db); // time_window: "w_0800_1000", exact_time: null
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "", exactTime: "09:30" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].exact_time, "09:30");
  assert.strictEqual(db.bookings[0].time_window, null);
});

test("PATCH booking (booked): switching from Exact Time back to Time Window nulls exact_time and sets time_window", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { time_window: null, exact_time: "09:30" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "w_1200_1400", exactTime: "" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].time_window, "w_1200_1400");
  assert.strictEqual(db.bookings[0].exact_time, null);
});

test("PATCH booking (booked): both timeWindow and exactTime non-empty -> 400, row unchanged", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const before = Object.assign({}, booking);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "w_0800_1000", exactTime: "09:30" }));
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(db.bookings[0], before);
});

test("PATCH booking (booked): neither timeWindow nor exactTime -> 400 (one required for a non-completed job)", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "", exactTime: "" }));
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH booking (completed): neither timeWindow nor exactTime -> succeeds, both null (time stays optional for completed jobs)", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { time_window: "w_0800_1000" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "", exactTime: "" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].time_window, null);
  assert.strictEqual(db.bookings[0].exact_time, null);
});

test("PATCH booking (completed): exactTime alone still works and time_window is nulled", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { time_window: "w_0800_1000" });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { timeWindow: "", exactTime: "16:45" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].exact_time, "16:45");
  assert.strictEqual(db.bookings[0].time_window, null);
});

// =======================================================================
// 7. PATCH Edit Job — Quoted Amount range, scoped exactly like estimated_price
// =======================================================================
test("PATCH booking (booked): estimatedPriceMax is written alongside estimatedPrice", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { estimated_price: 300, estimated_price_max: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 300, estimatedPriceMax: 450 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price, 300);
  assert.strictEqual(db.bookings[0].estimated_price_max, 450);
});

test("PATCH booking (booked): omitting estimatedPriceMax clears a previously-set one back to an exact quote", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { estimated_price: 300, estimated_price_max: 450 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 300, estimatedPriceMax: "" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price_max, null);
});

test("PATCH booking (booked): estimatedPriceMax <= estimatedPrice -> 400, row unchanged", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { estimated_price: 300, estimated_price_max: null });
  const before = Object.assign({}, booking);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPrice: 300, estimatedPriceMax: 300 }));
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(db.bookings[0], before);
});

test("PATCH booking (completed): editing a completed job's Actual Collected/tip never touches estimated_price_max, even if sent", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { estimated_price_max: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { estimatedPriceMax: 999999, finalPrice: 300 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].estimated_price_max, null, "estimated_price_max must be left exactly as it was — never written by a completed-mode edit");
  assert.strictEqual(db.bookings[0].final_price, 300);
});

// =======================================================================
// 8. GET booking detail — response shape
// =======================================================================
test("GET booking: response includes estimatedPriceMax, exactTime, and a unified timeLabel", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { estimated_price: 350, estimated_price_max: 475, time_window: null, exact_time: "09:30" });
  const res = await getBooking(db, AUTH_COOKIE, booking.id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.estimatedPriceMax, 475);
  assert.strictEqual(res.body.booking.exactTime, "09:30");
  assert.strictEqual(res.body.booking.timeLabel, "9:30 AM");
});

test("GET booking: a window-only job's timeLabel is the existing window range label", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db, { time_window: "w_1200_1400", exact_time: null });
  const res = await getBooking(db, AUTH_COOKIE, booking.id);
  assert.strictEqual(res.body.booking.timeLabel, "12:00 PM – 2:00 PM");
});

// =======================================================================
// 9. GET schedule — sorting a mix of exact-time and window jobs
// =======================================================================
test("GET schedule: exact-time jobs sort by their precise minute among window jobs on the same day", async () => {
  adminAuthed();
  const db = freshDb();
  seedBookedBooking(db, { id: "c", appointment_date: TODAY_ISO, time_window: "w_0800_1000", exact_time: null }); // 8:00
  seedBookedBooking(db, { id: "d", appointment_date: TODAY_ISO, time_window: null, exact_time: "08:30" }); // 8:30
  seedBookedBooking(db, { id: "b", appointment_date: TODAY_ISO, time_window: null, exact_time: "09:15" }); // 9:15
  seedBookedBooking(db, { id: "a", appointment_date: TODAY_ISO, time_window: "w_1000_1200", exact_time: null }); // 10:00
  const res = await getSchedule(db, AUTH_COOKIE, { range: "today" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["c", "d", "b", "a"]);
});

test("GET schedule: a no-time (legacy/unrecognized) job sorts after every recognized time on the same day", async () => {
  adminAuthed();
  const legacyDb = freshDb();
  const withExact = seedBookedBooking(legacyDb, { id: "exact", appointment_date: TODAY_ISO, time_window: null, exact_time: "07:00" });
  const withWindow = seedBookedBooking(legacyDb, { id: "window", appointment_date: TODAY_ISO, time_window: "w_1800_2000", exact_time: null });
  const withNoTime = seedBookedBooking(legacyDb, { id: "no-time", appointment_date: TODAY_ISO, time_window: null, exact_time: null });
  const res = await getSchedule(legacyDb, AUTH_COOKIE, { range: "today" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["exact", "window", "no-time"]);
});

test("GET schedule: each job carries timeLabel, exactTime, and estimatedPriceMax (Stage 2.5 additions to the existing schedule card contract)", async () => {
  adminAuthed();
  const db = freshDb();
  seedBookedBooking(db, { id: "z", appointment_date: TODAY_ISO, time_window: null, exact_time: "09:30", estimated_price: 350, estimated_price_max: 475 });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "today" });
  const job = res.body.jobs[0];
  assert.strictEqual(job.timeLabel, "9:30 AM");
  assert.strictEqual(job.exactTime, "09:30");
  assert.strictEqual(job.estimatedPriceMax, 475);
  // Backward compatible: timeWindowLabel (the window-only label) is kept as
  // an additive field for any caller still reading it directly.
  assert.strictEqual(job.timeWindowLabel, "—");
});

// =======================================================================
// 10. Frontend — segmented toggles present, labels updated, public /book
//     untouched (source-level checks, same convention as every prior
//     phase's test file for verifying static HTML/JS without a browser).
// =======================================================================
test("admin/booking-new/index.html: has both the Appointment Time and Quoted Amount segmented toggles", () => {
  const html = readSrc("admin/booking-new/index.html");
  assert.ok(/id="time-mode-toggle"/.test(html));
  assert.ok(/data-mode="exact">Exact Time</.test(html));
  assert.ok(/data-mode="window">Time Window</.test(html));
  assert.ok(/id="quote-mode-toggle"/.test(html));
  assert.ok(/id="exact-time"/.test(html));
  assert.ok(/id="estimated-price-max"/.test(html));
});

test("admin/booking-past/index.html: has the Appointment Time toggle and the relabeled 'Actual Job Amount Collected' field", () => {
  const html = readSrc("admin/booking-past/index.html");
  assert.ok(/id="time-mode-toggle"/.test(html));
  assert.ok(/Actual Job Amount Collected/.test(html));
  assert.ok(!/id="quote-mode-toggle"/.test(html), "Past Job has never had a Quoted Amount field — this stage must not add one");
});

test("admin/booking-edit/index.html: has both toggles and the relabeled Quoted Amount / Actual Job Amount Collected fields", () => {
  const html = readSrc("admin/booking-edit/index.html");
  assert.ok(/id="time-mode-toggle"/.test(html));
  assert.ok(/id="quote-mode-toggle"/.test(html));
  assert.ok(/id="estimated-price-max"/.test(html));
  assert.ok(/Actual Job Amount Collected/.test(html));
});

test("admin/booking/index.html: Pricing section row labels are 'Quoted' and 'Actual Collected'", () => {
  const html = readSrc("admin/booking/index.html");
  assert.ok(/admin-row-label">Quoted</.test(html));
  assert.ok(/admin-row-label">Actual Collected</.test(html));
});

test("public /book wizard is completely untouched by this stage — no exact-time/quote-range concept added to it", () => {
  const bookSrc = readSrc("api/book.js");
  assert.ok(!/exact_time|exactTime|estimated_price_max|estimatedPriceMax/.test(bookSrc), "api/book.js must never read/write the new Stage 2.5 columns/fields");
  const wizardSrc = readSrc("book/book.js");
  assert.ok(!/exact_time|exactTime|estimated_price_max|estimatedPriceMax/.test(wizardSrc), "the public booking wizard must never reference the new Stage 2.5 fields");
});

test("deployment: total function-producing files under api/ are still within the Vercel Hobby plan's 12-function limit after Stage 2.5 (zero new files added)", () => {
  const dir = path.join(__dirname, "..", "api");
  let total = 0;
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) {
        if (entry.name === "_lib") return;
        walk(path.join(d, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        total += 1;
      }
    });
  })(dir);
  assert.ok(total <= 12, "api/ has " + total + " function-producing .js files, exceeding the Vercel Hobby plan's 12-function limit");
  assert.strictEqual(total, 12, "Stage 2.5 adds zero new endpoint files — every change lands inside existing api/admin/booking.js, api/admin/bookings.js, and api/admin/client.js");
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
