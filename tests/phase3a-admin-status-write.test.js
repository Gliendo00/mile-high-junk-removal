// Local, offline test harness for the Phase 3A booking-status write
// endpoint (api/admin/booking-status.js) and the read-only status filter
// added to api/admin/bookings.js.
//
// Same approach as tests/phase1-api.test.js and tests/phase2-admin-api.test.js:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never the production
// Supabase project. This file's FakeQueryBuilder is phase2's plus support
// for .update(), since phase2 never needed a write path.
//
// Run with:  node tests/phase3a-admin-status-write.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder (adds .update() on top of the phase2 fake)
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
      // Mutate the underlying row objects in place (not a copy), so the
      // write is visible to any later query against the same fake db —
      // exactly like a real UPDATE persisting to the table.
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
    storage: {
      from(bucket) {
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

const statusHandler = require("../api/admin/booking-status.js");
const bookingsHandler = require("../api/admin/bookings.js");
const bookingHandler = require("../api/admin/booking.js");

// ---------------------------------------------------------------------
// req/res mocks (identical shape to phase2's)
// ---------------------------------------------------------------------
function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(json)),
        cookie: opts.cookie || "",
        "x-forwarded-proto": "https",
      },
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
    getHeader: function (name) {
      return headers[name.toLowerCase()];
    },
    setHeader: function (name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeaders: function () {
      return headers;
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
const REAL_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

function freshDb() {
  return {
    bookings: [
      {
        id: REAL_ID,
        customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        service_type: "junk_removal",
        appointment_date: "2026-01-15",
        time_window: "w_0800_1000",
        status: null,
        description: "Old couch and mattress",
        estimated_price: 250,
        final_price: null,
        internal_notes: null,
        created_at: "2026-01-01T12:00:00Z",
      },
      {
        id: OTHER_ID,
        customer_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        service_type: "dumpster_rental",
        appointment_date: "2026-01-10",
        time_window: "morning",
        status: "lost",
        description: "15-yard dumpster",
        estimated_price: 450,
        final_price: 450,
        internal_notes: "Gate code 1234",
        created_at: "2026-01-02T09:30:00Z",
      },
    ],
    customers: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", address: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", first_name: "Alex", last_name: "Doe", phone: "303-555-0101", email: null, address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    ],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}

function patchStatus(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(statusHandler, makeReq({ method: "PATCH", cookie: cookie, body: body }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// 1. Authentication / authorization — requireAdmin() must gate this route
// exactly like every other admin route, before anything else runs.
test("PATCH booking-status: no cookies at all -> 401, no data touched", async () => {
  // A valid-but-unused anon client, so this exercises admin-auth.js's
  // actual "no cookies present" branch rather than its separate
  // "SUPABASE_ANON_KEY not configured" branch (getUser() is never called
  // either way, since that check happens before any cookie is inspected).
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  const res = await patchStatus(db, "", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings[0].status, null, "an unauthenticated request must never write anything");
});

test("PATCH booking-status: garbage/forged access token -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=not-a-real-token", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings[0].status, null);
});

test("PATCH booking-status: real Supabase session but non-allowlisted email -> 401, no write", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-nonadmin", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.bookings[0].status, null);
});

test("PATCH booking-status: response is always Cache-Control: no-store", async () => {
  const db = freshDb();
  const res = await patchStatus(db, "", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("PATCH booking-status: GET is rejected with 405 (method-scoped)", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(statusHandler, makeReq({ method: "GET", cookie: "mhjr_admin_at=at-good", query: { id: REAL_ID } }));
  assert.strictEqual(res.statusCode, 405);
});

// 2. Input validation
test("PATCH booking-status: missing booking id -> 400, no write", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { status: "booked" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].status, null);
});

test("PATCH booking-status: malformed id -> safe 404, never reaches the database", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: "'; drop table bookings; --", status: "booked" });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.bookings[0].status, null);
});

test("PATCH booking-status: well-formed but nonexistent id -> safe 404, no row created or modified", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: NONEXISTENT_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, "Booking not found.");
  assert.strictEqual(db.bookings.length, 2, "no row should be inserted");
});

test("PATCH booking-status: missing status -> 400, no write", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].status, null);
});

test("PATCH booking-status: unknown status string -> 400, rejected, no write", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "archived" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, "Invalid status.");
  assert.strictEqual(db.bookings[0].status, null);
});

test('PATCH booking-status: case-manipulated status ("BOOKED") is rejected, not silently normalized', async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "BOOKED" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].status, null, "the row must be untouched — case variants are not accepted");
});

test("PATCH booking-status: extra unexpected fields in the body are ignored, only status is written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", {
    id: REAL_ID,
    status: "booked",
    internal_notes: "HACKED",
    estimated_price: 999999,
    final_price: 1,
    customer_id: "attacker-controlled-id",
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(db.bookings[0].internal_notes, null, "internal_notes must be untouched by extra body fields");
  assert.strictEqual(db.bookings[0].estimated_price, 250, "estimated_price must be untouched");
  assert.strictEqual(db.bookings[0].final_price, null, "final_price must be untouched");
  assert.strictEqual(db.bookings[0].customer_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "customer_id must be untouched");
});

test("PATCH booking-status: non-string id/status (e.g. numbers/objects) are rejected, not coerced", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: 12345, status: { toString: () => "booked" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].status, null);
});

// 3. Valid transitions along the documented happy path + the lost exit/re-entry
test("PATCH booking-status: New -> Contacted", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "contacted" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.status, "contacted");
  assert.strictEqual(db.bookings[0].status, "contacted");
});

test("PATCH booking-status: Contacted -> Quoted", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings[0].status = "contacted";
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "quoted" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "quoted");
});

test("PATCH booking-status: Quoted -> Booked", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings[0].status = "quoted";
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "booked");
});

test("PATCH booking-status: Booked -> Completed", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings[0].status = "booked";
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "completed" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "completed");
});

test("PATCH booking-status: any state -> Lost", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings[0].status = "quoted";
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "lost" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "lost");
});

test("PATCH booking-status: Lost -> New is allowed (no transition is enforced yet)", async () => {
  adminAuthed();
  const db = freshDb(); // OTHER_ID starts as "lost"
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: OTHER_ID, status: "new" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "new");
  assert.strictEqual(db.bookings[1].status, "new", 'the row now literally stores "new" — this is an explicit write via this endpoint, not the NULL-display convention');
});

// 4. Response shape: minimal, never the full record
test("PATCH booking-status: success response contains only { ok, id, status } — never the full booking/customer", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 200);
  const keys = Object.keys(res.body).sort();
  assert.deepStrictEqual(keys, ["id", "ok", "status"]);
  assert.strictEqual(res.body.id, REAL_ID);
});

test("PATCH booking-status: never leaks the service-role key or anon key", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  const asText = JSON.stringify(res.body);
  assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
  assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
});

// 5. Database write scope: only bookings.status changes, nothing else in
// the row and no other table is ever touched.
test("PATCH booking-status: the update touches ONLY bookings.status — every other column is byte-for-byte unchanged", async () => {
  adminAuthed();
  const db = freshDb();
  const before = JSON.parse(JSON.stringify(db.bookings[0]));
  await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "completed" });
  const after = db.bookings[0];
  Object.keys(before).forEach((key) => {
    if (key === "status") return;
    assert.strictEqual(after[key], before[key], "column '" + key + "' must be unchanged by a status update");
  });
  assert.strictEqual(after.status, "completed");
});

test("PATCH booking-status: does not touch customers, dumpster_rentals, or booking_photos", async () => {
  adminAuthed();
  const db = freshDb();
  const customersBefore = JSON.parse(JSON.stringify(db.customers));
  await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  assert.deepStrictEqual(db.customers, customersBefore);
});

// 6. Database failure -> safe error, no false success
test("PATCH booking-status: a Supabase update error returns 500 and never claims success", async () => {
  adminAuthed();
  const db = freshDb();
  db.__updateError = { message: "simulated connection reset" };
  const res = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, undefined, "an error response must never carry ok:true");
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes("simulated connection reset"), "the raw Supabase error must never reach the client");
  assert.strictEqual(db.bookings[0].status, null, "status must be unchanged when the underlying write failed");
});

// 7. Repeated / duplicate submissions at the API level are safe and
// idempotent (the actual double-tap GUARD is client-side — see
// admin/booking-detail.js's savingInFlight flag, verified by code review
// and manual browser testing since there is no DOM/click simulation in this
// offline harness — but the server-side behavior this guard relies on,
// that two PATCHes never corrupt the row, IS verified here).
test("PATCH booking-status: two PATCHes in a row for the same booking both succeed safely (no corruption)", async () => {
  adminAuthed();
  const db = freshDb();
  const res1 = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "contacted" });
  const res2 = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "quoted" });
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.bookings[0].status, "quoted", "the later write wins, and the row is left in a single consistent state");
});

// 8. Signed URLs / photo access are never touched by this endpoint (IDOR /
// photo-privacy regression guard specific to this new route).
test("PATCH booking-status: never calls storage.createSignedUrl", async () => {
  adminAuthed();
  const db = freshDb();
  let signCalled = false;
  currentFakeService = createFakeServiceClient(db);
  currentFakeService.storage.from = function () {
    return {
      async createSignedUrl() {
        signCalled = true;
        return { data: { signedUrl: "x" }, error: null };
      },
    };
  };
  await run(statusHandler, makeReq({ method: "PATCH", cookie: "mhjr_admin_at=at-good", body: { id: REAL_ID, status: "booked" } }));
  assert.strictEqual(signCalled, false);
});

// ---------------------------------------------------------------------
// Read-side: the optional status filter added to api/admin/bookings.js,
// and end-to-end confirmation that the list/detail GETs reflect a status
// written via PATCH — i.e. "the dashboard reflects the saved status after
// refresh/navigation" (a fresh GET is exactly what a real page-load does).
// ---------------------------------------------------------------------
test("GET bookings: unfiltered list and summary counts are unaffected by the new optional status param", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.summary.total, 2);
  assert.strictEqual(res.body.bookings.length, 2);
});

test("GET bookings: ?status=new returns only NULL-status rows, filtered correctly", async () => {
  adminAuthed();
  const db = freshDb(); // REAL_ID is NULL-status ("new"), OTHER_ID is "lost"
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { status: "new" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, REAL_ID);
  assert.strictEqual(res.body.hasMore, false);
});

test("GET bookings: ?status=lost returns only lost rows; summary counts stay global (unfiltered)", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { status: "lost" } }));
  assert.strictEqual(res.body.bookings.length, 1);
  assert.strictEqual(res.body.bookings[0].id, OTHER_ID);
  assert.strictEqual(res.body.summary.total, 2, "summary counts must always reflect the whole table, not the active filter");
});

test("GET bookings: an unrecognized ?status= value is ignored, falling back to the unfiltered list (not an error)", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { status: "not-a-real-status" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.bookings.length, 2);
});

test("End-to-end: status written via PATCH is what a subsequent GET (list + detail) returns", async () => {
  adminAuthed();
  const db = freshDb();

  const patchRes = await patchStatus(db, "mhjr_admin_at=at-good", { id: REAL_ID, status: "booked" });
  assert.strictEqual(patchRes.statusCode, 200);

  // Simulates navigating back to the dashboard (a fresh GET, no client cache).
  currentFakeService = createFakeServiceClient(db);
  const listRes = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  const updated = listRes.body.bookings.find((b) => b.id === REAL_ID);
  assert.strictEqual(updated.status, "booked");
  assert.strictEqual(listRes.body.summary.booked, 1);
  assert.strictEqual(listRes.body.summary.new, 0, "the booking must no longer be counted as New");

  // Simulates reopening the same booking's detail page.
  currentFakeService = createFakeServiceClient(db);
  const detailRes = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: REAL_ID } }));
  assert.strictEqual(detailRes.body.booking.status, "booked");
  assert.strictEqual(detailRes.body.booking.statusLabel, "Booked");
});

// ---------------------------------------------------------------------
// Static-analysis guard: the new client-side files never build HTML from
// strings (same property tests/phase2-admin-api.test.js already checks for
// dashboard.js/booking-detail.js/login.js — this covers the new
// status-ui.js and re-confirms the two files this phase modified).
// ---------------------------------------------------------------------
test("admin client JS (incl. new status-ui.js) never uses innerHTML/insertAdjacentHTML/document.write", async () => {
  const files = ["admin/dashboard.js", "admin/booking-detail.js", "admin/status-ui.js"];
  files.forEach((rel) => {
    const full = path.join(__dirname, "..", rel);
    const src = fs.readFileSync(full, "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// Write-audit guard: fails loudly (rather than requiring someone to remember
// to grep) if any admin backend file ever gains a write call beyond the
// ones this project's write surface is deliberately known to have.
//
// As of Phase 3C Stage 2.1 that surface is three calls: the original
// booking-status.js status write, plus the new booking.js "+ New Job" and
// client.js Create Client inserts — each one reviewed individually in
// docs/phase-3/stage2.1-new-job-proposal.md, not an incidental side effect.
//
// Scoped to api/admin/*.js plus exactly the three api/_lib files admin
// routes actually require (confirmed by grepping every require("../_lib/...")
// across api/admin/*.js: admin-auth.js, supabase-admin.js, booking-format.js)
// — NOT the whole api/_lib directory, which also holds
// spam-protection.js for the public /api/book and /api/contact endpoints.
// That file's `buckets.delete(k)` is a plain in-memory JS Map cleanup, not
// a Supabase call, and isn't reachable from any admin route at all; a
// directory-wide scan flags it as a false positive.
test("write-audit: exactly the known .update( / .insert( / .upsert( / .delete( calls across the admin API's actual code (api/admin/* + the _lib files it requires)", async () => {
  const adminLibFiles = ["admin-auth.js", "supabase-admin.js", "booking-format.js"];
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
      // money) and, as of the Stripe migration, eleven updates:
      // handleApprove's proposed-or-failed->approved, approved->processing,
      // the initial processing->paid attempt, markChargeFailed's ->failed
      // transition, markChargeErrorPendingReview's ->error_pending_review
      // transition, markChargeRequiresCustomerAction's
      // ->requires_customer_action transition (Stripe-specific — an
      // off-session confirmation needing Strong Customer Authentication),
      // the retryUpdate-wrapped retry of the paid-confirmation write plus
      // its minimal paid_reconciliation_required fallback write, and
      // handleCheckStatus's two conditional reconciliation writes
      // (->paid, ->failed — a safe, non-charging Stripe re-fetch, never a
      // new charge). See tests/phase3c-stage2.5v2-stripe-rental-payments.test.js
      // for full coverage.
      "api/admin/booking.js: .insert(",
      // Phase 3C "Existing Job Editing" added exactly one new write call —
      // PATCH's handleUpdate() — deliberately, not a side effect. See
      // api/admin/booking.js's handleUpdate() header comment for why this
      // stays a controlled, allowlisted update rather than a new "write
      // anything" endpoint.
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
      // Phase 3C Stage 2.4 addendum (Daily Quick Expense Tracking) added
      // exactly one new write call — handleCreateExpense()'s insert into
      // the (not-yet-migrated) expenses table — gated behind an explicit
      // resource:"expense" discriminator so it can never be reached by any
      // booking-shaped request. See tests/phase3c-stage2.4-expenses.test.js.
      "api/admin/bookings.js: .insert(",
      "api/admin/client.js: .insert(",
    ],
    "found: " + JSON.stringify(found)
  );
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
