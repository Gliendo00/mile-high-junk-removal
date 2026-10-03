// Local, offline test harness for the Batch 3 addendum — complimentary/
// free job tracking. A completed job can be explicitly marked
// complimentary (bookings.is_complimentary); Job Revenue for that job is
// forced to exactly $0 (final_price is overwritten server-side,
// unconditionally, whenever isComplimentary is true), while
// complimentary_value/_reason/_note are purely informational — never
// summed into Revenue/Net anywhere. See
// sql/2026-10-03_phase3c-stage6b-complimentary-jobs.sql for the schema and
// api/admin/booking.js's parseComplimentary() for the shared validation
// used by both Past Job (POST mode:"past") and Edit Job (PATCH), the only
// two places a completed job can be marked complimentary.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project. Harness
// copied from tests/phase3c-job-editing.test.js (POST+PATCH support) and
// tests/phase3c-stage2.2-past-job.test.js (validPastBody shape).
//
// Run with:  node tests/phase3c-batch3-complimentary-jobs.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(400000000000 + nextId++).padStart(12, "0");
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
  gte(field, val) {
    this._filters.push((row) => row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] <= val);
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
      const row = Object.assign({ id: makeId(), created_at: "2026-09-17T12:00:00Z", updated_at: null }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._updateData) {
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

const bookingHandler = require("../api/admin/booking.js");
const bookingsHandler = require("../api/admin/bookings.js");
const { HISTORICAL_FLOOR_ISO } = require("../api/_lib/historical-floor.js");
const { ALL_COMPLIMENTARY_REASON_KEYS } = require("../api/_lib/complimentary-reasons.js");

function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign({ "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), cookie: opts.cookie || "" }, opts.headers || {}),
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

function freshDb() {
  return {
    customers: [{ id: EXISTING_CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", created_at: "2026-01-01T10:00:00Z" }],
    bookings: [],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

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
      estimated_price: 300,
      final_price: 250,
      tip_amount: 20,
      is_complimentary: false,
      complimentary_value: null,
      complimentary_reason: null,
      complimentary_note: null,
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
function seedBookedBooking(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(),
      customer_id: EXISTING_CUSTOMER_ID,
      service_type: "junk_removal",
      appointment_date: "2026-12-31",
      time_window: "w_0800_1000",
      status: "booked",
      description: "Garage cleanout",
      estimated_price: 300,
      final_price: null,
      tip_amount: null,
      is_complimentary: false,
      complimentary_value: null,
      complimentary_reason: null,
      complimentary_note: null,
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
function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}
function patchBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: cookie, body: body }));
}
function getBooking(db, cookie, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "GET", cookie: cookie, query: { id: id } }));
}
function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "GET", cookie: cookie, query: Object.assign({ view: "schedule" }, query) }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Allowlist
// =======================================================================
test("ALL_COMPLIMENTARY_REASON_KEYS: exactly the 5 required reasons, in order", () => {
  assert.deepStrictEqual(ALL_COMPLIMENTARY_REASON_KEYS, ["loyal_client", "community_charity", "service_recovery", "friends_family", "other"]);
});

// =======================================================================
// POST (Past Job) — marking complimentary at creation time
// =======================================================================
test("POST Past Job: isComplimentary=true with mode='new' (not past) is rejected — only a completed job can be complimentary", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, { mode: "new", customerId: EXISTING_CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: "2026-12-31", timeWindow: "w_0800_1000", serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" }, isComplimentary: true });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0, "nothing should be written");
});

test("POST Past Job: isComplimentary=true without a reason is rejected, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST Past Job: isComplimentary=true with an invalid reason is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "made_up_reason" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST Past Job: reason='other' with no note is rejected, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "other" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST Past Job: reason='other' WITH a note succeeds", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "other", complimentaryNote: "Billing dispute goodwill gesture" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.isComplimentary, true);
  assert.strictEqual(res.body.booking.complimentaryReason, "other");
  assert.strictEqual(res.body.booking.complimentaryNote, "Billing dispute goodwill gesture");
});

ALL_COMPLIMENTARY_REASON_KEYS.filter((r) => r !== "other").forEach((reason) => {
  test("POST Past Job: reason='" + reason + "' succeeds with no note required", async () => {
    adminAuthed();
    const db = freshDb();
    const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: reason }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.booking.complimentaryReason, reason);
  });
});

test("POST Past Job: marking complimentary FORCES final_price to 0, even though a nonzero finalPrice (250) was submitted — the critical revenue-safety guarantee", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 250, isComplimentary: true, complimentaryReason: "loyal_client", complimentaryValue: 250 }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, 0, "final_price must be forced to 0 regardless of the submitted 250");
  assert.strictEqual(res.body.booking.complimentaryValue, 250, "the informational value is stored separately and untouched");
  assert.strictEqual(db.bookings[0].final_price, 0);
  assert.strictEqual(db.bookings[0].is_complimentary, true);
});

test("POST Past Job: status is still 'completed' for a complimentary job — it remains a legitimate completed job", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "community_charity" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.status, "completed");
});

test("POST Past Job: complimentaryValue is optional — omitting it stores null, never 0 or an error", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "friends_family" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.complimentaryValue, null);
});

test("POST Past Job: a negative complimentaryValue is rejected", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ isComplimentary: true, complimentaryReason: "loyal_client", complimentaryValue: -10 }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("POST Past Job: isComplimentary omitted (ordinary job) — all four complimentary fields are false/null, finalPrice behaves completely normally", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 400 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.isComplimentary, false);
  assert.strictEqual(res.body.booking.complimentaryValue, null);
  assert.strictEqual(res.body.booking.complimentaryReason, null);
  assert.strictEqual(res.body.booking.complimentaryNote, null);
  assert.strictEqual(res.body.booking.finalPrice, 400, "an ordinary job's real finalPrice must be completely unaffected");
});

test("POST Past Job: an intentional finalPrice of exactly 0 (NOT complimentary) stays 0 — the exact non-complimentary regression the audit asked for", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, validPastBody({ finalPrice: 0 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.finalPrice, 0);
  assert.strictEqual(res.body.booking.isComplimentary, false, "a real $0 job must never be silently treated as complimentary");
});

// =======================================================================
// PATCH (Edit Job) — marking/un-marking complimentary on an existing job
// =======================================================================
test("PATCH Edit Job: isComplimentary=true on a NOT-completed (booked) job is rejected, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { isComplimentary: true, complimentaryReason: "loyal_client", timeWindow: booking.time_window }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].is_complimentary, false);
});

test("PATCH Edit Job: isComplimentary=true on an already-completed job succeeds and forces final_price to 0", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 250 });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 250, isComplimentary: true, complimentaryReason: "service_recovery", complimentaryValue: 300, complimentaryNote: "" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.finalPrice, 0);
  assert.strictEqual(res.body.booking.complimentaryValue, 300);
  assert.strictEqual(res.body.booking.complimentaryReason, "service_recovery");
  assert.strictEqual(db.bookings[0].final_price, 0);
});

test("PATCH Edit Job: un-marking complimentary (isComplimentary:false) clears reason/value/note back to null, and final_price reverts to whatever was submitted", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 0, is_complimentary: true, complimentary_reason: "loyal_client", complimentary_value: 250, complimentary_note: null });
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { finalPrice: 180, isComplimentary: false }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.isComplimentary, false);
  assert.strictEqual(res.body.booking.complimentaryValue, null);
  assert.strictEqual(res.body.booking.complimentaryReason, null);
  assert.strictEqual(res.body.booking.complimentaryNote, null);
  assert.strictEqual(res.body.booking.finalPrice, 180, "now that it's not complimentary, the normal submitted finalPrice must be used");
});

test("PATCH Edit Job: reason='other' with no note is rejected on an edit too", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { isComplimentary: true, complimentaryReason: "other" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings[0].is_complimentary, false);
});

test("PATCH Edit Job: editing an unrelated field (description) on a non-completed job leaves complimentary fields at their default, no error", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedBookedBooking(db);
  const res = await patchBooking(db, AUTH_COOKIE, validPatchBody(booking, { description: "Updated description" }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.isComplimentary, false);
});

// =======================================================================
// GET booking detail — complimentary fields surfaced for display
// =======================================================================
test("GET booking detail: a complimentary job's fields are all returned, including the human-readable reason label", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db, { final_price: 0, is_complimentary: true, complimentary_reason: "community_charity", complimentary_value: 400, complimentary_note: "Food bank fundraiser" });
  const res = await getBooking(db, AUTH_COOKIE, booking.id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.isComplimentary, true);
  assert.strictEqual(res.body.booking.complimentaryValue, 400);
  assert.strictEqual(res.body.booking.complimentaryReason, "community_charity");
  assert.strictEqual(res.body.booking.complimentaryReasonLabel, "Community / Charity");
  assert.strictEqual(res.body.booking.complimentaryNote, "Food bank fundraiser");
  assert.strictEqual(res.body.booking.finalPrice, 0);
});

test("GET booking detail: an ordinary (non-complimentary) job returns isComplimentary:false and null reason label", async () => {
  adminAuthed();
  const db = freshDb();
  const booking = seedCompletedBooking(db);
  const res = await getBooking(db, AUTH_COOKIE, booking.id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.isComplimentary, false);
  assert.strictEqual(res.body.booking.complimentaryReasonLabel, null);
});

// =======================================================================
// GET schedule (api/admin/bookings.js) — complimentary fields reach the
// job array admin/schedule-financials.js computes Job Revenue/the
// Complimentary Service breakdown from.
// =======================================================================
test("GET schedule: a complimentary job's fields are present on the returned job, and finalPrice is $0", async () => {
  adminAuthed();
  const db = freshDb();
  seedCompletedBooking(db, {
    appointment_date: "2026-09-19",
    final_price: 0,
    is_complimentary: true,
    complimentary_reason: "loyal_client",
    complimentary_value: 350,
    complimentary_note: null,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "day", date: "2026-09-19" });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.jobs.length, 1);
  const job = res.body.jobs[0];
  assert.strictEqual(job.isComplimentary, true);
  assert.strictEqual(job.complimentaryValue, 350);
  assert.strictEqual(job.complimentaryReason, "loyal_client");
  assert.strictEqual(job.complimentaryReasonLabel, "Loyal Client");
  assert.strictEqual(job.finalPrice, 0);
});

test("GET schedule: an ordinary completed job (never marked complimentary) returns isComplimentary:false", async () => {
  adminAuthed();
  const db = freshDb();
  seedCompletedBooking(db, { appointment_date: "2026-09-19", final_price: 300 });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "day", date: "2026-09-19" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs[0].isComplimentary, false);
  assert.strictEqual(res.body.jobs[0].finalPrice, 300);
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
