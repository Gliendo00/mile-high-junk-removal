// Local, offline test harness for Phase 3C Stage 2.1: "+ New Job" (POST
// api/admin/booking.js) and inline/standalone Create Client (POST
// api/admin/client.js). Same approach as every prior phase's test file:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never the production
// Supabase project. No Preview deployment or real Supabase call is
// exercised by anything in this file.
//
// Run with:  node tests/phase3c-stage2-new-job.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder with insert()/select()/eq()/single()/
// maybeSingle()/order() support — the union of what booking.js's and
// client.js's GET *and* new POST code paths actually use.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  // Valid hex only (0-9a-f) — a real booking/client id must pass the
  // endpoints' own UUID_RE check on any later lookup, exactly like a real
  // Supabase-generated uuid would.
  return "eeeeeeee-eeee-eeee-eeee-" + String(100000000000 + nextId++).padStart(12, "0");
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
const clientHandler = require("../api/admin/client.js");

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

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
const VALID_APPOINTMENT_DATE = futureDate(3);

function validJobBody(overrides) {
  return Object.assign(
    {
      customerId: EXISTING_CUSTOMER_ID,
      serviceType: "junk_removal",
      appointmentDate: VALID_APPOINTMENT_DATE,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "555 Job Site Rd", city: "Aurora", state: "CO", zip: "80010" },
      description: "Old couch and a mattress",
      estimatedPrice: 250,
      internalNotes: "Gate code 4321",
    },
    overrides || {}
  );
}

function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}
function postClient(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(clientHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// PART A — POST /api/admin/booking ("+ New Job")
// =======================================================================

// 1. Authentication
test("POST booking: no cookies at all -> 401, no store, no row created", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  const res = await postBooking(db, "", validJobBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: garbage/forged access token -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  const db = freshDb();
  const res = await postBooking(db, "mhjr_admin_at=not-real", validJobBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: real session but non-allowlisted email -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb();
  const res = await postBooking(db, "mhjr_admin_at=at-nonadmin", validJobBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings.length, 0);
});

test("GET /api/admin/booking (no id) still behaves exactly as before -> 400, unaffected by the new POST branch", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 400);
});

test("POST booking: unsupported method (DELETE) -> 405", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingHandler, makeReq({ method: "DELETE", cookie: AUTH_COOKIE, query: { id: EXISTING_CUSTOMER_ID } }));
  assert.strictEqual(res.statusCode, 405);
});

// 2. Validation
test("POST booking: missing customerId -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ customerId: undefined }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: malformed customerId -> safe 404, never reaches the database", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ customerId: "'; drop table customers; --" }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: well-formed but nonexistent customerId -> 404, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ customerId: NONEXISTENT_ID }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, "Client not found.");
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: invalid serviceType -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ serviceType: "lawn_care" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: missing/invalid timeWindow -> 400, no row created (New Job always requires a real time)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ timeWindow: "sometime_soon" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: empty-string timeWindow -> 400, no row created (the New Job form's unselected 'Select time' placeholder value)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ timeWindow: "" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: malformed appointmentDate -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ appointmentDate: "not-a-date" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: appointmentDate in the past -> 400 pointing at Past Job, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ appointmentDate: "2026-01-01" }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/past job/i.test(res.body.error), "error should point the admin at Past Job for historical dates");
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: appointmentDate of exactly today is accepted (not treated as 'past')", async () => {
  adminAuthed();
  const db = freshDb();
  const todayIso = new Date().toISOString().slice(0, 10);
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ appointmentDate: todayIso }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test("POST booking: missing service address fields -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ serviceAddress: { address: "", city: "", state: "", zip: "" } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: invalid state in service address -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ serviceAddress: { address: "1 Main St", city: "Denver", state: "Colorado", zip: "80202" } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: invalid zip in service address -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "abc" } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: negative estimatedPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ estimatedPrice: -50 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: absurdly large estimatedPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ estimatedPrice: 50000000 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: non-numeric estimatedPrice -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ estimatedPrice: "a lot" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST booking: estimatedPrice is optional — omitting it still creates the job, with estimated_price null", async () => {
  adminAuthed();
  const db = freshDb();
  const body = validJobBody();
  delete body.estimatedPrice;
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.estimatedPrice, null);
  assert.strictEqual(db.bookings[0].estimated_price, null);
});

// 3. Security / integrity — status can never be overridden by the request
test('POST booking: a request body containing "status":"completed" still creates a "booked" row', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody({ status: "completed" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.status, "booked");
  assert.strictEqual(db.bookings[0].status, "booked");
});

test("POST booking: extra unexpected fields in the body are ignored — only the intended columns are written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(
    db,
    AUTH_COOKIE,
    validJobBody({
      final_price: 999999,
      customer_id: "attacker-controlled-id",
      id: "attacker-chosen-id",
      phone_normalized: "0000000000",
    })
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const row = db.bookings[0];
  assert.strictEqual(row.customer_id, EXISTING_CUSTOMER_ID, "customer_id must come only from the validated customerId field");
  // As of Phase 3C Stage 2.2, final_price is a real column on every insert
  // from this endpoint (null for New Job, the validated actual amount for
  // Past Job) rather than simply absent — but the attacker-supplied
  // snake_case "final_price": 999999 above must still never reach it: New
  // Job never reads body.finalPrice at all, so it's hardcoded null here.
  assert.strictEqual(row.final_price, null, "final_price must never be settable from this endpoint");
  assert.notStrictEqual(row.id, "attacker-chosen-id", "the row id must never be caller-supplied");
});

// 4. Success path + service-address snapshot
test("POST booking: valid request creates exactly one bookings row with the submitted service-address snapshot", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody());
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.customers.length, 1, "creating a job must never touch the customers table");
  const row = db.bookings[0];
  assert.strictEqual(row.service_address, "555 Job Site Rd");
  assert.strictEqual(row.service_city, "Aurora");
  assert.strictEqual(row.service_state, "CO");
  assert.strictEqual(row.service_zip, "80010");
  assert.strictEqual(row.status, "booked");
  assert.strictEqual(res.body.booking.customerId, EXISTING_CUSTOMER_ID);
  assert.strictEqual(res.body.serviceAddress.city, "Aurora");
});

test("POST booking: response never leaks the service-role or anon key", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody());
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

test("POST booking: response always carries Cache-Control: no-store", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validJobBody());
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

// 5. End-to-end: created job is immediately visible via the existing GET
test("End-to-end: a job created via POST is what a subsequent GET (booking detail) returns", async () => {
  adminAuthed();
  const db = freshDb();
  const createRes = await postBooking(db, AUTH_COOKIE, validJobBody());
  assert.strictEqual(createRes.statusCode, 200, JSON.stringify(createRes.body));
  const newId = createRes.body.booking.id;

  currentFakeService = createFakeServiceClient(db);
  const getRes = await run(bookingHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { id: newId } }));
  assert.strictEqual(getRes.statusCode, 200, JSON.stringify(getRes.body));
  assert.strictEqual(getRes.body.booking.status, "booked");
  assert.strictEqual(getRes.body.booking.customerId, EXISTING_CUSTOMER_ID);
  assert.strictEqual(getRes.body.serviceAddress.city, "Aurora");
});

// =======================================================================
// PART B — POST /api/admin/client ("Create Client")
// =======================================================================

function validClientBody(overrides) {
  return Object.assign({ firstName: "Riley" }, overrides || {});
}

// 1. Authentication
test("POST client: no cookies at all -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  const res = await postClient(db, "", validClientBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: garbage token -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  const db = freshDb();
  const res = await postClient(db, "mhjr_admin_at=not-real", validClientBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: non-allowlisted email -> 401, no row created", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb();
  const res = await postClient(db, "mhjr_admin_at=at-nonadmin", validClientBody());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.customers.length, 1);
});

test("GET /api/admin/client (no id) still behaves exactly as before -> 400, unaffected by the new POST branch", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 400);
});

// PATCH is now a legitimate method here (Batch 2D — Edit Client and
// Archive/Restore Client, see tests/phase3c-client-edit-archive.test.js
// for full coverage). This guard now checks a genuinely unsupported method
// instead, preserving the original spirit: client.js must never become a
// generic "any method does anything" endpoint.
test("POST client: an unsupported method (DELETE) is rejected with 405", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientHandler, makeReq({ method: "DELETE", cookie: AUTH_COOKIE, query: { id: EXISTING_CUSTOMER_ID } }));
  assert.strictEqual(res.statusCode, 405);
});

// 2. Validation — only firstName is required (locked 2026-09-17)
test("POST client: missing firstName -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, { phone: "303-555-9999" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: firstName only (no phone, no email, no address) succeeds — phone is NOT required", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody());
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.client.phone, null);
  assert.strictEqual(res.body.client.email, null);
  const row = db.customers.find((c) => c.id === res.body.client.id);
  assert.strictEqual(row.phone, null);
  assert.strictEqual(row.phone_normalized, null, "an omitted phone must normalize to NULL, never an empty string");
  assert.strictEqual(row.email_normalized, null);
});

test("POST client: invalid phone format (when provided) -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody({ phone: "123" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: invalid email format (when provided) -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody({ email: "not-an-email" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: invalid state (when provided) -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody({ state: "Colorado" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: invalid zip (when provided) -> 400, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody({ zip: "abc" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.customers.length, 1);
});

test("POST client: full valid request creates a client with normalized phone/email written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, {
    firstName: "Pat",
    lastName: "Nguyen",
    phone: "(303) 555-0199",
    email: "Pat.Nguyen@Example.com",
    address: "77 Elm St",
    city: "Golden",
    state: "co",
    zip: "80401",
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const row = db.customers.find((c) => c.id === res.body.client.id);
  assert.strictEqual(row.phone_normalized, "3035550199");
  assert.strictEqual(row.email_normalized, "pat.nguyen@example.com");
  assert.strictEqual(row.state, "CO", "state must be uppercased");
});

// 3. Duplicate-match policy (locked in docs/phase-3/stage2-decisions.md #3)
test("POST client: exact phone+email match -> 409, blocked, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, { firstName: "Jamie", phone: "303-555-0100", email: "jamie@example.com" });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "duplicate_client");
  assert.strictEqual(res.body.existingClient.id, EXISTING_CUSTOMER_ID);
  assert.strictEqual(db.customers.length, 1, "an exact match must never be silently created");
});

test('POST client: exact match + confirmCreateAnyway:true creates the duplicate deliberately', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, {
    firstName: "Jamie",
    phone: "303-555-0100",
    email: "jamie@example.com",
    confirmCreateAnyway: true,
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.customers.length, 2, "Create Anyway must actually create the second row");
});

test("POST client: phone-only match -> warns but allows creation (never blocks)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, { firstName: "SecondJamie", phone: "303-555-0100", email: "different@example.com" });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.customers.length, 2);
  assert.ok(res.body.warnings.some((w) => w.type === "phone_match"), "must warn about the shared phone number");
  assert.ok(!res.body.warnings.some((w) => w.type === "email_match"));
});

test("POST client: email-only match -> warns but allows creation (never blocks)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, { firstName: "SameEmailDifferentPhone", phone: "303-555-8888", email: "jamie@example.com" });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.customers.length, 2);
  assert.ok(res.body.warnings.some((w) => w.type === "email_match"));
  assert.ok(!res.body.warnings.some((w) => w.type === "phone_match"));
});

test("POST client: ambiguous matches (two existing clients share the submitted phone) are never auto-merged, only warned about", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers.push({
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    first_name: "Other",
    last_name: "Person",
    phone: "303-555-0100",
    email: null,
    phone_normalized: "3035550100",
    email_normalized: null,
    created_at: "2026-01-02T00:00:00Z",
  });
  const res = await postClient(db, AUTH_COOKIE, { firstName: "ThirdPerson", phone: "303-555-0100" });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.customers.length, 3, "must create the new client rather than merging into either existing match");
  const phoneWarning = res.body.warnings.find((w) => w.type === "phone_match");
  assert.strictEqual(phoneWarning.clients.length, 2, "both existing phone matches must be surfaced");
});

test("POST client: neither phone nor email provided -> created outright, no warnings", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, { firstName: "NoContactInfoYet" });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.warnings, []);
});

test("POST client: response never leaks the service-role or anon key", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody());
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

test("POST client: response always carries Cache-Control: no-store", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postClient(db, AUTH_COOKIE, validClientBody());
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("POST client: creating a client never touches the bookings table", async () => {
  adminAuthed();
  const db = freshDb();
  await postClient(db, AUTH_COOKIE, validClientBody());
  assert.deepStrictEqual(db.bookings, []);
});

// =======================================================================
// Cross-cutting: static-analysis guard for the new admin client-side files
// =======================================================================
test("admin client JS (New Job + client picker) never uses innerHTML/insertAdjacentHTML/document.write", async () => {
  const files = ["admin/booking-new.js", "admin/client-picker.js"];
  files.forEach((rel) => {
    const full = path.join(__dirname, "..", rel);
    assert.ok(fs.existsSync(full), rel + " must exist");
    const src = fs.readFileSync(full, "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
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
