// Local, offline test harness for Phase 3C Stage 2.2: "+ Past Job" (the
// mode:"past" branch of POST api/admin/booking.js). Same approach as every
// prior phase's test file: "@supabase/supabase-js" is intercepted at
// require-time and replaced with an in-memory fake — never the real
// network, never the production Supabase project. No Preview deployment or
// real Supabase call is exercised by anything in this file.
//
// This file focuses on what's new/changed for Past Job. The full New Job +
// Create Client regression coverage already lives in
// tests/phase3c-stage2-new-job.test.js and is re-run unchanged alongside
// this file, not duplicated here.
//
// Run with:  node tests/phase3c-stage2.2-past-job.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: identical query builder to tests/phase3c-stage2-new-job.test.js
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(200000000000 + nextId++).padStart(12, "0");
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
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  insert(data) {
    this._insertRow = data;
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
      const row = Object.assign({ id: makeId(), created_at: "2026-09-17T12:00:00Z" }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
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
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

function freshDb() {
  return {
    customers: [
      {
        id: EXISTING_CUSTOMER_ID,
        first_name: "Jamie",
        last_name: "Rivera",
        phone: "303-555-0100",
        email: "jamie@example.com",
        address: "123 Main St",
        city: "Denver",
        state: "CO",
        zip: "80202",
        phone_normalized: "3035550100",
        email_normalized: "jamie@example.com",
        created_at: "2026-01-01T10:00:00Z",
      },
    ],
    bookings: [],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

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
const DAY_BEFORE_FLOOR_ISO = "2025-12-31";

function validPastBody(overrides) {
  return Object.assign(
    {
      mode: "past",
      customerId: EXISTING_CUSTOMER_ID,
      serviceType: "junk_removal",
      appointmentDate: HISTORICAL_FLOOR_ISO,
      serviceAddress: { address: "555 Job Site Rd", city: "Aurora", state: "CO", zip: "80010" },
      description: "Old couch and a mattress",
      finalPrice: 250,
      internalNotes: "Gate code 4321",
    },
    overrides || {}
  );
}

function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Authentication (mode:"past" still goes through the same requireAdmin
//    gate as mode:"new" — the mode switch happens only after auth passes).
// =======================================================================
test("POST past job: no cookies at all -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  const res = await postBooking(db, "", validPastBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: non-allowlisted email -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb();
  const res = await postBooking(db, "mhjr_admin_at=at-nonadmin", validPastBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 2. Mode validation
// =======================================================================
test("POST booking: garbage mode value -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ mode: "sometime" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: mode omitted entirely still defaults to New Job rules (future date required)", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validPastBody({ appointmentDate: TOMORROW_ISO });
  delete body.mode;
  delete body.finalPrice;
  const res = await postBooking(db, AUTH_COOKIE, Object.assign(body, { timeWindow: "w_0800_1000" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "booked");
});

// =======================================================================
// 3. Historical date floor/ceiling — enforced server-side
// =======================================================================
test("POST past job: January 1, 2026 (the exact floor) is accepted", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ appointmentDate: HISTORICAL_FLOOR_ISO }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.appointmentDate, HISTORICAL_FLOOR_ISO);
});

test("POST past job: December 31, 2025 (one day before the floor) is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ appointmentDate: DAY_BEFORE_FLOOR_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: today (America/Denver) is accepted", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ appointmentDate: TODAY_ISO }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test("POST past job: tomorrow is rejected (Past Job never accepts a future date)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ appointmentDate: TOMORROW_ISO }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/future/i.test(res.body.error));
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 4. Status enforcement — server-side only, never overridable
// =======================================================================
test('POST past job: creates status="completed"', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody());
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "completed");
  assert.strictEqual(db.bookings[0].status, "completed");
});

test('POST past job: a request body containing "status":"booked" still creates a "completed" row', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ status: "booked" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "completed");
  assert.strictEqual(db.bookings[0].status, "completed");
});

test("POST booking: New Job (mode omitted) remains unaffected — still booked, still requires a future/today date", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: EXISTING_CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: TODAY_ISO,
    timeWindow: "w_0800_1000",
    serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    estimatedPrice: 200,
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "booked");
});

test("POST booking: New Job still requires a valid time window (unaffected by Past Job's optional one)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: EXISTING_CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: TODAY_ISO,
    timeWindow: "",
    serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 5. Time window — optional for Past Job, a real NULL when omitted
// =======================================================================
test("POST past job: omitted timeWindow -> saved as a real NULL, not an invented placeholder", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validPastBody();
  delete body.timeWindow;
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.timeWindow, null);
  assert.strictEqual(db.bookings[0].time_window, null);
});

test("POST past job: empty-string timeWindow (the UI's 'Time unknown' option) -> saved as NULL", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ timeWindow: "" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].time_window, null);
});

test("POST past job: a valid supplied timeWindow is saved (the owner does remember the time)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ timeWindow: "w_1200_1400" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.timeWindow, "w_1200_1400");
  assert.strictEqual(db.bookings[0].time_window, "w_1200_1400");
});

test("POST past job: an invalid (unrecognized) timeWindow is rejected, not silently nulled", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ timeWindow: "sometime_soon" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 6. Actual amount -> final_price, never estimated_price
// =======================================================================
test("POST past job: finalPrice is written to final_price; estimated_price stays null", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 375.5 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, 375.5);
  assert.strictEqual(res.body.booking.estimatedPrice, null);
  assert.strictEqual(db.bookings[0].final_price, 375.5);
  assert.strictEqual(db.bookings[0].estimated_price, null);
});

test("POST past job: finalPrice is optional — omitting it still creates the job, with final_price null", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validPastBody();
  delete body.finalPrice;
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, null);
  assert.strictEqual(db.bookings[0].final_price, null);
});

test("POST past job: an estimatedPrice sent alongside mode:past is ignored — never written anywhere", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ estimatedPrice: 999 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].estimated_price, null, "estimatedPrice must never leak into estimated_price for a past-mode request");
});

test("POST past job: negative finalPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: -10 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: absurdly large finalPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 50000000 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 6b. Tip amount -> tip_amount, always its own column — Stage 2.2 addendum
// (owner-requested addition before ship, added after the Preview review).
// Not yet deployed anywhere: bookings.tip_amount does not exist in
// production Supabase yet (see docs/phase-3/stage2.2-tip-amount-migration.md),
// so this is exercised only against the offline fake Supabase below.
// =======================================================================
test("POST past job: omitted tipAmount -> saved as a real NULL", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validPastBody();
  delete body.tipAmount;
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.tipAmount, null);
  assert.strictEqual(db.bookings[0].tip_amount, null);
});

test("POST past job: a valid tipAmount is written to tip_amount", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: 40 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.tipAmount, 40);
  assert.strictEqual(db.bookings[0].tip_amount, 40);
});

test("POST past job: tipAmount of exactly 0 is accepted and stored as a real 0, not treated as absent", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: 0 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.tipAmount, 0);
  assert.strictEqual(db.bookings[0].tip_amount, 0);
});

test("POST past job: a decimal tipAmount is stored at cent precision", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: 12.5 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.tipAmount, 12.5);
  assert.strictEqual(db.bookings[0].tip_amount, 12.5);
});

test("POST past job: negative tipAmount -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: -5 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: malformed (non-numeric string) tipAmount -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: "a lot" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: NaN/Infinity tipAmount -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const nanRes = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: NaN }));
  assert.strictEqual(nanRes.statusCode, 400);
  const infRes = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: Infinity }));
  assert.strictEqual(infRes.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: absurdly large (out-of-range) tipAmount -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: 50000000 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: tipAmount and finalPrice are independent — a tip never leaks into final_price and vice versa", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 300, tipAmount: 60 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, 300);
  assert.strictEqual(res.body.booking.tipAmount, 60);
  assert.strictEqual(db.bookings[0].final_price, 300);
  assert.strictEqual(db.bookings[0].tip_amount, 60);
  assert.notStrictEqual(db.bookings[0].final_price, db.bookings[0].final_price + db.bookings[0].tip_amount, "sanity: the two values were never summed/combined into one column");
});

test("POST past job: a tip can be entered with no finalPrice at all (amount unknown, tip remembered)", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validPastBody({ tipAmount: 15 });
  delete body.finalPrice;
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, null);
  assert.strictEqual(res.body.booking.tipAmount, 15);
});

test("POST booking: a tipAmount sent alongside New Job (mode omitted) is never read — New Job has no tip support yet", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: EXISTING_CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: TODAY_ISO,
    timeWindow: "w_0800_1000",
    serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    tipAmount: 999,
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "booked");
  assert.strictEqual(db.bookings[0].tip_amount, null, "an attacker-supplied tipAmount must never reach tip_amount on a New Job request");
});

test('POST booking: mode:"new" explicitly with a tipAmount is still ignored (mode itself, not just its absence, gates tip support)', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, {
    mode: "new",
    customerId: EXISTING_CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: TODAY_ISO,
    timeWindow: "w_0800_1000",
    serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    tipAmount: 500,
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings[0].tip_amount, null);
});

// =======================================================================
// 7. Client / address validation — same rules as New Job, reused as-is
// =======================================================================
test("POST past job: missing customerId -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ customerId: undefined }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: nonexistent customerId -> 404, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ customerId: NONEXISTENT_ID }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: missing service address fields -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ serviceAddress: { address: "", city: "", state: "", zip: "" } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST past job: valid request creates exactly one bookings row with its own frozen service-address snapshot", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody());
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.customers.length, 1, "creating a past job must never touch the customers table");
  const row = db.bookings[0];
  assert.strictEqual(row.service_address, "555 Job Site Rd");
  assert.strictEqual(row.service_city, "Aurora");
  assert.strictEqual(row.service_state, "CO");
  assert.strictEqual(row.service_zip, "80010");
});

// =======================================================================
// 8. No arbitrary fields written
// =======================================================================
test("POST past job: extra unexpected fields in the body are ignored — only the intended columns are written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(
    db,
    AUTH_COOKIE,
    validPastBody({
      customer_id: "attacker-controlled-id",
      id: "attacker-chosen-id",
      phone_normalized: "0000000000",
      created_at: "2000-01-01T00:00:00Z",
      tip_amount: 999999,
    })
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const row = db.bookings[0];
  assert.strictEqual(row.customer_id, EXISTING_CUSTOMER_ID, "customer_id must come only from the validated customerId field");
  assert.notStrictEqual(row.id, "attacker-chosen-id", "the row id must never be caller-supplied");
  assert.notStrictEqual(row.created_at, "2000-01-01T00:00:00Z", "created_at must never be caller-supplied");
  assert.strictEqual(row.tip_amount, null, "a snake_case tip_amount in the body must never leak in — only the validated camelCase tipAmount is ever read");
});

// =======================================================================
// 9. Response hygiene
// =======================================================================
test("POST past job: response always carries Cache-Control: no-store", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody());
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("POST past job: response never leaks the service-role or anon key", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody());
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

// =======================================================================
// 10. End-to-end: created past job is what a subsequent GET returns
// =======================================================================
test("End-to-end: a past job created via POST is what a subsequent GET (booking detail) returns", async () => {
  adminAuthed();
  const db = freshDb();
  const createRes = await postBooking(db, AUTH_COOKIE, validPastBody({ tipAmount: 45 }));
  assert.strictEqual(createRes.statusCode, 200, JSON.stringify(createRes.body));
  const newId = createRes.body.booking.id;

  currentFakeService = createFakeServiceClient(db);
  const getRes = await run(bookingHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { id: newId } }));
  assert.strictEqual(getRes.statusCode, 200, JSON.stringify(getRes.body));
  assert.strictEqual(getRes.body.booking.status, "completed");
  assert.strictEqual(getRes.body.booking.finalPrice, 250);
  assert.strictEqual(getRes.body.booking.tipAmount, 45, "GET must round-trip the tip amount, same as every other stored field");
  assert.strictEqual(getRes.body.booking.customerId, EXISTING_CUSTOMER_ID);
});

// =======================================================================
// 11. Public booking flow untouched — api/book.js is not imported/modified
// by anything in this stage.
// =======================================================================
test("api/book.js source is untouched by Stage 2.2 (no mode/historical-floor references leaked into the public endpoint)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/book.js"), "utf8");
  assert.ok(!/historical-floor/.test(src), "api/book.js must not reference the new historical-floor module");
  assert.ok(!/mode\s*[:=]\s*["']past["']/.test(src), "api/book.js must not reference Past Job's mode value");
});

// =======================================================================
// 12. XSS/rendering discipline — extend the existing grep guard
// =======================================================================
test("admin/booking-past.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "admin/booking-past.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// =======================================================================
// 13. Write-scope / function-count regression — Stage 2.2 adds ZERO new
// .insert(/.update(/.upsert(/.delete( calls and ZERO new files under api/.
// The existing guards in tests/phase3c-schedule.test.js already assert
// this exactly; re-asserted narrowly here too so this file alone proves
// the historical-floor addition didn't change either count.
// =======================================================================
test("api/_lib/historical-floor.js is a pure constant module — no Supabase write calls, no new api/ function file", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/_lib/historical-floor.js"), "utf8");
  assert.ok(!/\.(insert|update|upsert|delete)\s*\(/.test(src));
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "api", "historical-floor.js")), "must live only under api/_lib/, never directly under api/");
});

// =======================================================================
// 14. Tip Amount UI wiring — Stage 2.2 addendum static checks. The actual
// "Add Another Past Job -> tip field cleared" behavior is a full-page
// navigation (see admin/booking-past.js), which this offline Node harness
// has no DOM/browser to exercise directly — asserted here at the source
// level instead: the reset path must stay a plain navigation (which clears
// every field, tip included, as a consequence of a fresh page load) rather
// than a partial in-place field reset that could selectively miss one.
// =======================================================================
test("admin/booking-past.js wires a tip-amount input and reads it into the save request", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "admin/booking-past.js"), "utf8");
  assert.ok(/tip-amount/.test(src), "must reference the tip-amount input");
  assert.ok(/body\.tipAmount/.test(src), "must send tipAmount in the POST body");
});

test("admin/booking-past.js's 'Add Another Past Job' resets via a full page navigation, not a partial field reset", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "admin/booking-past.js"), "utf8");
  const addAnotherBlock = src.slice(src.indexOf("addAnotherBtn.addEventListener"));
  assert.ok(/window\.location\.href\s*=\s*['"]\/admin\/booking-past\/['"]/.test(addAnotherBlock), "Add Another Past Job must navigate to a fresh copy of the page, which clears every job-specific field (tip amount included) — never a targeted reset of only some fields");
});

test("admin/booking-past/index.html places Tip Amount directly alongside Actual Job Amount, and the layout is otherwise unchanged", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "admin/booking-past/index.html"), "utf8");
  const actualIdx = src.indexOf('id="actual-price"');
  const tipIdx = src.indexOf('id="tip-amount"');
  const timeIdx = src.indexOf('id="time-window"');
  assert.ok(actualIdx !== -1 && tipIdx !== -1 && timeIdx !== -1, "all three fields must be present");
  assert.ok(actualIdx < tipIdx && tipIdx < timeIdx, "Tip Amount must sit between Actual Job Amount and Time, inside the same existing field row — no reordering of the rest of the form");
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
