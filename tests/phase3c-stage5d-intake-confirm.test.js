// Local, offline test harness for Phase 3C Stage 5D's two
// api/admin/intake.js PATCH actions: ?action=confirm-booking and
// ?action=confirm-attach-existing. See that file's handleConfirmBooking()/
// handleConfirmAttachExisting() for the contract this exercises.
//
// Scope: proves (a) both actions only ever write intake_sessions (never
// customers/bookings — the booking/customer themselves are assumed
// already created by the admin's browser via the existing, separately
// tested POST /api/admin/client and POST /api/admin/booking endpoints,
// exactly as api/admin/intake.js's own header describes), (b)
// confirm-booking re-validates the given bookingId actually belongs to
// the given customerId rather than trusting the caller, (c)
// confirm-attach-existing never touches the booking it points at, (d)
// both are idempotent against a same-ids retry and refuse a
// different-ids retry, and (e) a confirmed intake disappears from the
// default Pending Intake list.
//
// Same interception approach as tests/phase3c-batch5-intake-endpoint.test.js
// (that file's own harness, trimmed here to just insert/update/select —
// no Storage, since neither action under test touches screenshots).
//
// Run with:  node tests/phase3c-stage5d-intake-confirm.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let nextId = 1;
function makeId() {
  return "bbbbbbbb-bbbb-bbbb-bbbb-" + String(100000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._single = null;
    this._insertData = undefined;
    this._updateData = undefined;
  }
  select() {
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  order() {
    return this;
  }
  insert(data) {
    this._insertData = data;
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
    if (this._insertData !== undefined) {
      const row = Object.assign({ id: makeId(), created_at: "2026-10-06T12:00:00.000Z" }, this._insertData);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      if (this._single === "single") return { data: row, error: null };
      return { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._updateData !== undefined) {
      filtered.forEach((row) => Object.assign(row, this._updateData));
      return { data: null, error: null };
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

const intakeHandler = require("../api/admin/intake.js");

// ---------------------------------------------------------------------
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
    getHeader: (n) => headers[n.toLowerCase()],
    setHeader: (n, v) => { headers[n.toLowerCase()] = v; },
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}
function run(req) {
  const res = makeRes();
  return Promise.resolve(intakeHandler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
const AUTH_COOKIE = "mhjr_admin_at=at-good";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_CUSTOMER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BOOKING_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_BOOKING_ID = "22222222-2222-2222-2222-222222222222";

function freshDb() {
  return {
    intake_sessions: [
      {
        id: "99999999-9999-9999-9999-999999999999",
        status: "pending_review",
        classification: "booking_confirmed",
        match_status: "new_candidate",
        matched_customer_id: null,
        linked_existing_booking_id: null,
        resulting_customer_id: null,
        resulting_booking_id: null,
        extracted_data: { fields: {} },
      },
    ],
    customers: [{ id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera" }],
    bookings: [
      { id: BOOKING_ID, customer_id: CUSTOMER_ID, status: "booked" },
      { id: OTHER_BOOKING_ID, customer_id: OTHER_CUSTOMER_ID, status: "booked" },
    ],
  };
}

function patch(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "PATCH", cookie: AUTH_COOKIE, body: body }));
}
function list(db, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "GET", cookie: AUTH_COOKIE, query: query || {} }));
}

const INTAKE_ID = "99999999-9999-9999-9999-999999999999";

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// --- confirm-booking --------------------------------------------------
test("confirm-booking: 401 without a valid admin session", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "PATCH", cookie: "", body: { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.intake_sessions[0].status, "pending_review");
});

test("confirm-booking: unknown intake id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patch(db, { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 404);
});

test("confirm-booking: missing/invalid bookingId or customerId -> 400, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const res1 = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: "", customerId: CUSTOMER_ID });
  assert.strictEqual(res1.statusCode, 400);
  const res2 = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: "not-a-uuid" });
  assert.strictEqual(res2.statusCode, 400);
  assert.strictEqual(db.intake_sessions[0].status, "pending_review");
});

test("confirm-booking: refused when the intake is not pending_review (e.g. extraction_failed)", async () => {
  adminAuthed();
  const db = freshDb();
  db.intake_sessions[0].status = "extraction_failed";
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 400);
});

// Failure-mode audit finding B (Rocky's review of the Preview smoke test):
// the browser is supposed to refuse this itself (admin/intake-detail.js's
// resolveCustomerId()) whenever match_status is still 'needs_confirmation'
// — this is the server-side defense-in-depth half of that same fix. A
// syntactically valid bookingId/customerId (even one that legitimately
// owns each other, per handleCreate's own BOOKING_ID/CUSTOMER_ID fixture
// below) must never be enough to confirm an intake whose client identity
// was never actually resolved.
test("confirm-booking: refused when match_status is still needs_confirmation, even with an otherwise-valid booking/client pair — nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  db.intake_sessions[0].match_status = "needs_confirmation";
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/ambiguous/i.test(res.body.error), "error must clearly explain the match is ambiguous, not a generic failure");
  assert.strictEqual(db.intake_sessions[0].status, "pending_review", "must not be confirmed while the match is still ambiguous");
  assert.strictEqual(db.intake_sessions[0].resulting_booking_id, null);
});

test("confirm-booking: succeeds once match_status has been resolved away from needs_confirmation (e.g. via set-client-match)", async () => {
  adminAuthed();
  const db = freshDb();
  db.intake_sessions[0].match_status = "needs_confirmation";
  const blocked = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(blocked.statusCode, 400);

  // Admin resolves the ambiguity the normal way.
  const resolved = await patch(db, { id: INTAKE_ID, action: "set-client-match", matchedCustomerId: CUSTOMER_ID });
  assert.strictEqual(resolved.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].match_status, "existing_exact");

  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].status, "confirmed");
});

test("confirm-booking: a booking id that does not exist -> 400, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: "33333333-3333-3333-3333-333333333333", customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_sessions[0].status, "pending_review");
});

test("confirm-booking: a real booking that belongs to a DIFFERENT customer than claimed -> 400, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  // OTHER_BOOKING_ID belongs to OTHER_CUSTOMER_ID, not CUSTOMER_ID — a
  // caller claiming otherwise must never be trusted.
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: OTHER_BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_sessions[0].status, "pending_review");
  assert.strictEqual(db.intake_sessions[0].resulting_booking_id, null);
});

test("confirm-booking: happy path — confirms, records both pointers, updates matched_customer_id/match_status, never touches customers/bookings", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "confirmed");
  const row = db.intake_sessions[0];
  assert.strictEqual(row.status, "confirmed");
  assert.strictEqual(row.resulting_booking_id, BOOKING_ID);
  assert.strictEqual(row.resulting_customer_id, CUSTOMER_ID);
  assert.strictEqual(row.matched_customer_id, CUSTOMER_ID);
  assert.strictEqual(row.match_status, "existing_exact");
  assert.ok(row.confirmed_at);
  assert.strictEqual(row.confirmed_by, ADMIN_EMAIL);
  // The customer/booking rows themselves are completely untouched — this
  // action only ever reads them once (to validate ownership above).
  assert.deepStrictEqual(db.customers[0], { id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera" });
  assert.deepStrictEqual(db.bookings.find((b) => b.id === BOOKING_ID), { id: BOOKING_ID, customer_id: CUSTOMER_ID, status: "booked" });
});

test("confirm-booking: idempotent — retrying with the SAME ids on an already-confirmed intake is a no-op success", async () => {
  adminAuthed();
  const db = freshDb();
  await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  const confirmedAtFirst = db.intake_sessions[0].confirmed_at;

  const res2 = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body.status, "confirmed");
  assert.strictEqual(db.intake_sessions[0].confirmed_at, confirmedAtFirst, "a retry must not re-stamp confirmed_at");
});

test("confirm-booking: refused — retrying with a DIFFERENT booking/customer on an already-confirmed intake", async () => {
  adminAuthed();
  const db = freshDb();
  await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });

  const res2 = await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: OTHER_BOOKING_ID, customerId: OTHER_CUSTOMER_ID });
  assert.strictEqual(res2.statusCode, 400);
  assert.strictEqual(db.intake_sessions[0].resulting_booking_id, BOOKING_ID, "must not silently switch which booking this intake resolved to");
});

test("confirm-booking: a confirmed intake no longer appears in the default (pending_review) Pending Intake list", async () => {
  adminAuthed();
  const db = freshDb();
  await patch(db, { id: INTAKE_ID, action: "confirm-booking", bookingId: BOOKING_ID, customerId: CUSTOMER_ID });

  const res = await list(db, {});
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!res.body.intakes.some((i) => i.id === INTAKE_ID), "a confirmed intake must not still show up as Pending Intake");
});

// --- confirm-attach-existing -------------------------------------------
function existingJobUpdateDb() {
  const db = freshDb();
  db.intake_sessions[0].classification = "existing_job_update";
  db.intake_sessions[0].matched_customer_id = CUSTOMER_ID;
  db.intake_sessions[0].match_status = "existing_exact";
  db.intake_sessions[0].linked_existing_booking_id = BOOKING_ID;
  return db;
}

test("confirm-attach-existing: 401 without a valid admin session", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = existingJobUpdateDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "PATCH", cookie: "", body: { id: INTAKE_ID, action: "confirm-attach-existing" } }));
  assert.strictEqual(res.statusCode, 401);
});

test("confirm-attach-existing: refused when no job has been linked yet", async () => {
  adminAuthed();
  const db = existingJobUpdateDb();
  db.intake_sessions[0].linked_existing_booking_id = null;
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  assert.strictEqual(res.statusCode, 400);
});

test("confirm-attach-existing: refused when no client is matched (defensive — shouldn't happen given linking requires a match)", async () => {
  adminAuthed();
  const db = existingJobUpdateDb();
  db.intake_sessions[0].matched_customer_id = null;
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  assert.strictEqual(res.statusCode, 400);
});

test("confirm-attach-existing: refused when the intake is not pending_review", async () => {
  adminAuthed();
  const db = existingJobUpdateDb();
  db.intake_sessions[0].status = "discarded";
  const res = await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  assert.strictEqual(res.statusCode, 400);
});

test("confirm-attach-existing: happy path — confirms, records both pointers, never modifies the linked booking", async () => {
  adminAuthed();
  const db = existingJobUpdateDb();
  const bookingBefore = Object.assign({}, db.bookings.find((b) => b.id === BOOKING_ID));

  const res = await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.resultingBookingId, BOOKING_ID);

  const row = db.intake_sessions[0];
  assert.strictEqual(row.status, "confirmed");
  assert.strictEqual(row.resulting_booking_id, BOOKING_ID);
  assert.strictEqual(row.resulting_customer_id, CUSTOMER_ID);
  assert.ok(row.confirmed_at);
  assert.strictEqual(row.confirmed_by, ADMIN_EMAIL);
  assert.deepStrictEqual(db.bookings.find((b) => b.id === BOOKING_ID), bookingBefore, "the linked booking must be byte-for-byte unchanged");
});

test("confirm-attach-existing: idempotent — retrying on an already-confirmed intake is a no-op success", async () => {
  adminAuthed();
  const db = existingJobUpdateDb();
  await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  const confirmedAtFirst = db.intake_sessions[0].confirmed_at;

  const res2 = await patch(db, { id: INTAKE_ID, action: "confirm-attach-existing" });
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].confirmed_at, confirmedAtFirst);
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
