// Local, offline test harness for Batch 2 — Job Archive/Restore
// (api/admin/booking.js's ?resource=archive) and Review-Request Tracking
// (?resource=review-request). See
// sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql for the
// full schema design this exercises.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Not testable offline: the ON DELETE SET NULL behavior of
// booking_audit_log.booking_id is real PostgreSQL foreign-key behavior —
// this fake in-memory DB has no FK-cascade engine of its own (same
// "not testable offline" honesty this project already applies to
// expense_audit_log's real trigger). What IS tested here: that the
// application writes booking_id, booking_id_snapshot, and
// booking_summary_snapshot correctly at write time — the columns that
// make an eventually-orphaned row still readable, regardless of what
// Postgres itself later does to booking_id.
//
// Run with:  node tests/phase3c-job-archive-review.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this.isFilters = [];
    this.notIsFilters = [];
    this._orders = [];
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._single = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  is(col, val) {
    this.isFilters.push({ col, val });
    return this;
  }
  // Only the shape this codebase actually uses: .not(col, "is", null) —
  // "col is not null". Mirrors api/book.js's own existing .not() usage.
  not(col, op, val) {
    if (op === "is" && val === null) this.notIsFilters.push({ col });
    return this;
  }
  order(col, opts) {
    this._orders.push({ col, asc: !opts || opts.ascending !== false });
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  insert(payload) {
    this._insertPayload = payload;
    return this;
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  single() {
    this._single = "single";
    return this._resolve();
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const rows = (this.db[this.table] = this.db[this.table] || []);

    if (this._insertPayload) {
      const row = Object.assign({ id: makeId(), created_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter(
      (r) =>
        this.eqFilters.every((f) => r[f.col] === f.val) &&
        this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val) &&
        this.notIsFilters.every((f) => r[f.col] !== undefined && r[f.col] !== null)
    );

    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }

    this._orders.forEach((ord) => {
      matched = matched.slice().sort((a, b) => {
        if (a[ord.col] < b[ord.col]) return ord.asc ? -1 : 1;
        if (a[ord.col] > b[ord.col]) return ord.asc ? 1 : -1;
        return 0;
      });
    });
    if (this._limit != null) matched = matched.slice(0, this._limit);

    if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
    return { data: matched, error: null };
  }
}

function createFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://mock/signed" }, error: null }) }) } };
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

function freshDb(overrides) {
  return Object.assign({ bookings: [], customers: [], booking_audit_log: [] }, overrides || {});
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function makeBooking(overrides) {
  return Object.assign(
    {
      id: makeId(),
      service_type: "junk_removal",
      appointment_date: "2026-09-10",
      status: "completed",
      customer_id: null,
      archived_at: null,
      archived_reason: null,
      archived_note: null,
      archived_by: null,
      review_request_sent_at: null,
      review_request_sent_by: null,
      updated_at: nowIso(),
    },
    overrides || {}
  );
}
function makeCustomer(overrides) {
  return Object.assign({ id: makeId(), first_name: "Jamie", last_name: "Rivera" }, overrides || {});
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Archive
// =======================================================================
test("archive: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "archive" }, body: { id: makeId(), action: "archive", reason: "test_spam" } }));
  assert.strictEqual(res.statusCode, 401);
});

test("archive: missing/invalid action -> 400", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "bogus" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: missing reason -> 400, no row changed", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(b.archived_at, null);
});

test("archive: invalid reason not in the allowlist -> 400", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "made_up_reason" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: reason 'other' with no note -> 400", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "other" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: reason 'other' WITH a note -> 200, note saved", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "other", note: "Owner asked to remove this test entry" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(b.archived_note, "Owner asked to remove this test entry");
});

test("archive: a valid non-'other' reason succeeds and stamps archived_at/reason/by, note stays null", async () => {
  adminAuthed();
  const b = makeBooking();
  const cust = makeCustomer({ id: (b.customer_id = makeId()) });
  const db = freshDb({ bookings: [b], customers: [cust] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "duplicate_booking" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.archivedReason, "duplicate_booking");
  assert.ok(res.body.archivedAt);
  assert.strictEqual(res.body.archivedBy, ADMIN_EMAIL);
  assert.strictEqual(b.archived_note, null);
});

test("archive: writes exactly one booking_audit_log row with the correct event/reason/snapshot fields", async () => {
  adminAuthed();
  const b = makeBooking({ service_type: "dumpster_rental" });
  const cust = makeCustomer({ id: (b.customer_id = makeId()), first_name: "Jamie", last_name: "Rivera" });
  const db = freshDb({ bookings: [b], customers: [cust] });
  await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "no_show" } });

  assert.strictEqual(db.booking_audit_log.length, 1);
  const logRow = db.booking_audit_log[0];
  assert.strictEqual(logRow.booking_id, b.id);
  assert.strictEqual(logRow.booking_id_snapshot, b.id, "snapshot must be captured even while the live booking_id column still matches it");
  assert.strictEqual(logRow.event_type, "archive");
  assert.strictEqual(logRow.reason, "no_show");
  assert.strictEqual(logRow.changed_by, ADMIN_EMAIL);
  assert.ok(logRow.booking_summary_snapshot.indexOf("Jamie Rivera") !== -1, "summary snapshot should include the customer's name");
  assert.ok(logRow.booking_summary_snapshot.indexOf("2026-09-10") !== -1, "summary snapshot should include the appointment date");
});

test("archive: already-archived job -> 409, second archive does not overwrite the first reason", async () => {
  adminAuthed();
  const b = makeBooking({ archived_at: nowIso(), archived_reason: "no_show" });
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "test_spam" } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(b.archived_reason, "no_show");
});

test("archive: unknown booking id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: makeId(), action: "archive", reason: "test_spam" } });
  assert.strictEqual(res.statusCode, 404);
});

// =======================================================================
// Restore
// =======================================================================
test("restore: a not-archived job -> 409", async () => {
  adminAuthed();
  const b = makeBooking();
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "restore" } });
  assert.strictEqual(res.statusCode, 409);
});

test("restore: an archived job -> 200, clears all four archive columns, writes a 'restore' audit row", async () => {
  adminAuthed();
  const b = makeBooking({ archived_at: nowIso(), archived_reason: "test_spam", archived_note: null, archived_by: "someone@else.com" });
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "restore" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(b.archived_at, null);
  assert.strictEqual(b.archived_reason, null);
  assert.strictEqual(b.archived_by, null);
  assert.strictEqual(db.booking_audit_log.length, 1);
  assert.strictEqual(db.booking_audit_log[0].event_type, "restore");
  assert.strictEqual(db.booking_audit_log[0].changed_by, ADMIN_EMAIL);
});

test("archive then restore: no other table is touched — job_payments/expenses/dumpster_rentals/customers untouched by construction (this handler never queries them)", async () => {
  adminAuthed();
  const b = makeBooking();
  const cust = makeCustomer({ id: (b.customer_id = makeId()) });
  const db = freshDb({ bookings: [b], customers: [cust], job_payments: [{ id: "p1", booking_id: b.id, amount: 100 }], expenses: [{ id: "e1", booking_id: b.id, amount: 50 }] });
  await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "archive", reason: "duplicate_booking" } });
  await req(db, { method: "PATCH", query: { resource: "archive" }, body: { id: b.id, action: "restore" } });
  assert.deepStrictEqual(db.job_payments, [{ id: "p1", booking_id: b.id, amount: 100 }]);
  assert.deepStrictEqual(db.expenses, [{ id: "e1", booking_id: b.id, amount: 50 }]);
  assert.strictEqual(cust.first_name, "Jamie", "the customer row itself is never written by archive/restore");
});

// =======================================================================
// Review-request tracking
// =======================================================================
test("review-request: can only be tracked for a completed job -> 400 for any other status", async () => {
  adminAuthed();
  const b = makeBooking({ status: "booked" });
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "send" } });
  assert.strictEqual(res.statusCode, 400);
});

test("review-request: send on a completed job -> 200, stamps sent_at/sent_by, writes an audit row", async () => {
  adminAuthed();
  const b = makeBooking({ status: "completed" });
  const cust = makeCustomer({ id: (b.customer_id = makeId()) });
  const db = freshDb({ bookings: [b], customers: [cust] });
  const res = await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "send" } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.reviewRequestSentAt);
  assert.strictEqual(res.body.reviewRequestSentBy, ADMIN_EMAIL);
  assert.strictEqual(db.booking_audit_log.length, 1);
  assert.strictEqual(db.booking_audit_log[0].event_type, "review_request_sent");
});

test("review-request: sending twice -> second call 409, does not overwrite the original sent_at", async () => {
  adminAuthed();
  const b = makeBooking({ status: "completed" });
  const db = freshDb({ bookings: [b] });
  await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "send" } });
  const firstSentAt = b.review_request_sent_at;
  const res2 = await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "send" } });
  assert.strictEqual(res2.statusCode, 409);
  assert.strictEqual(b.review_request_sent_at, firstSentAt);
});

test("review-request: clear without a prior send -> 409", async () => {
  adminAuthed();
  const b = makeBooking({ status: "completed" });
  const db = freshDb({ bookings: [b] });
  const res = await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "clear" } });
  assert.strictEqual(res.statusCode, 409);
});

test("review-request: correcting an accidental send — clear preserves the original 'sent' audit row and adds a 'cleared' one (auditability survives the correction)", async () => {
  adminAuthed();
  const b = makeBooking({ status: "completed" });
  const db = freshDb({ bookings: [b] });
  await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "send" } });
  const res = await req(db, { method: "PATCH", query: { resource: "review-request" }, body: { id: b.id, action: "clear" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.reviewRequestSentAt, null);
  assert.strictEqual(b.review_request_sent_at, null);
  assert.strictEqual(b.review_request_sent_by, null);

  assert.strictEqual(db.booking_audit_log.length, 2, "the original 'sent' event must still be in the log after clearing");
  assert.strictEqual(db.booking_audit_log[0].event_type, "review_request_sent");
  assert.strictEqual(db.booking_audit_log[1].event_type, "review_request_cleared");
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
