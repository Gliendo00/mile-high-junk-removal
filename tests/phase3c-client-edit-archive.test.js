// Local, offline test harness for Batch 2D — Edit Client
// (api/admin/client.js's PATCH ?action=edit, the default) and Archive/
// Restore Client (?action=archive|restore). See
// sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql for the
// full schema design this exercises.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Not testable offline: customer_audit_log.customer_id's real ON DELETE
// SET NULL behavior (real PostgreSQL FK semantics — same honesty this
// project already applies to booking_audit_log, see
// tests/phase3c-job-archive-review.test.js's header). What IS tested here
// is that the application writes customer_id/customer_id_snapshot/
// customer_summary_snapshot correctly at write time.
//
// Run with:  node tests/phase3c-client-edit-archive.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "cccccccc-cccc-cccc-cccc-" + String(100000000000 + nextId++).padStart(12, "0");
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
  not(col, op, val) {
    if (op === "is" && val === null) this.notIsFilters.push({ col });
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

    if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
    if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
    return { data: matched, error: null };
  }
}

function createFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
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

const clientHandler = require("../api/admin/client.js");

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
  return Object.assign({ customers: [], bookings: [], job_payments: [], expenses: [], dumpster_rentals: [], customer_audit_log: [] }, overrides || {});
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(clientHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function makeCustomer(overrides) {
  return Object.assign(
    {
      id: makeId(),
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
      created_at: nowIso(),
      updated_at: nowIso(),
      archived_at: null,
      archived_reason: null,
      archived_note: null,
      archived_by: null,
    },
    overrides || {}
  );
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Edit Client
// =======================================================================
test("edit: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await run(clientHandler, makeReq({ method: "PATCH", body: { id: makeId(), firstName: "Test" } }));
  assert.strictEqual(res.statusCode, 401);
});

test("edit: unknown client id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "PATCH", body: { id: makeId(), firstName: "Test" } });
  assert.strictEqual(res.statusCode, 404);
});

test("edit: missing first name -> 400", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, firstName: "" } });
  assert.strictEqual(res.statusCode, 400);
});

test("edit: an invalid phone is rejected, nothing written", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, firstName: "Jamie", phone: "123" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(cust.phone, "303-555-0100");
});

test("edit: an invalid email is rejected", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, firstName: "Jamie", email: "not-an-email" } });
  assert.strictEqual(res.statusCode, 400);
});

test("edit: a valid full edit updates every field, recomputes phone/email normalization, and sets updated_at/updated_by", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, {
    method: "PATCH",
    body: { id: cust.id, firstName: "Jamie", lastName: "R.", phone: "303-555-9999", email: "jamie.new@example.com", address: "456 Oak Ave", city: "Aurora", state: "co", zip: "80010" },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(cust.last_name, "R.");
  assert.strictEqual(cust.phone, "303-555-9999");
  assert.strictEqual(cust.email, "jamie.new@example.com");
  assert.strictEqual(cust.phone_normalized, "3035559999");
  assert.strictEqual(cust.email_normalized, "jamie.new@example.com");
  assert.strictEqual(cust.city, "Aurora");
  assert.strictEqual(cust.state, "CO");
  assert.strictEqual(cust.updated_by, ADMIN_EMAIL);
  assert.ok(cust.updated_at);
});

test("edit: never touches the bookings table — an existing job stays linked to the exact same customer_id", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const booking = { id: makeId(), customer_id: cust.id, service_type: "junk_removal", status: "completed" };
  const db = freshDb({ customers: [cust], bookings: [booking] });
  await req(db, { method: "PATCH", body: { id: cust.id, firstName: "Jamie", lastName: "Rivera-Edited" } });
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].customer_id, cust.id);
  assert.strictEqual(db.bookings[0].id, booking.id);
});

// =======================================================================
// Archive
// =======================================================================
test("archive: missing reason -> 400", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: invalid reason -> 400", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "made_up" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: reason 'other' with no note -> 400", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "other" } });
  assert.strictEqual(res.statusCode, 400);
});

test("archive: a valid reason succeeds, stamps archived_at/reason/by, and writes one customer_audit_log row with a name+phone snapshot", async () => {
  adminAuthed();
  const cust = makeCustomer({ first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100" });
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "duplicate_client" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.archivedReason, "duplicate_client");
  assert.ok(res.body.archivedAt);
  assert.strictEqual(res.body.archivedBy, ADMIN_EMAIL);

  assert.strictEqual(db.customer_audit_log.length, 1);
  const logRow = db.customer_audit_log[0];
  assert.strictEqual(logRow.customer_id, cust.id);
  assert.strictEqual(logRow.customer_id_snapshot, cust.id);
  assert.strictEqual(logRow.event_type, "archive");
  assert.strictEqual(logRow.reason, "duplicate_client");
  assert.ok(logRow.customer_summary_snapshot.indexOf("Jamie Rivera") !== -1);
  assert.ok(logRow.customer_summary_snapshot.indexOf("303-555-0100") !== -1);
});

test("archive: reason 'other' WITH a note succeeds, note saved", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "other", note: "Requested by phone call" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(cust.archived_note, "Requested by phone call");
});

test("archive: already-archived -> 409, does not overwrite the original reason", async () => {
  adminAuthed();
  const cust = makeCustomer({ archived_at: nowIso(), archived_reason: "test_spam" });
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "duplicate_client" } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(cust.archived_reason, "test_spam");
});

// =======================================================================
// Restore
// =======================================================================
test("restore: not archived -> 409", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "restore" } });
  assert.strictEqual(res.statusCode, 409);
});

test("restore: an archived client -> 200, clears all four archive columns, writes a 'restore' audit row", async () => {
  adminAuthed();
  const cust = makeCustomer({ archived_at: nowIso(), archived_reason: "test_spam", archived_by: "someone@else.com" });
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "PATCH", body: { id: cust.id, action: "restore" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(cust.archived_at, null);
  assert.strictEqual(cust.archived_reason, null);
  assert.strictEqual(cust.archived_by, null);
  assert.strictEqual(db.customer_audit_log.length, 1);
  assert.strictEqual(db.customer_audit_log[0].event_type, "restore");
});

// =======================================================================
// Blast radius — archive/restore must never touch anything else
// =======================================================================
test("archive then restore: job_payments/expenses/dumpster_rentals/bookings are all completely untouched", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const booking = { id: makeId(), customer_id: cust.id, service_type: "dumpster_rental", status: "completed" };
  const db = freshDb({
    customers: [cust],
    bookings: [booking],
    job_payments: [{ id: "p1", booking_id: booking.id, amount: 100 }],
    expenses: [{ id: "e1", booking_id: booking.id, amount: 50 }],
    dumpster_rentals: [{ id: "d1", booking_id: booking.id, delivery_date: "2026-09-25", pickup_date: "2026-09-30" }],
  });
  const bookingsBefore = JSON.stringify(db.bookings);
  const paymentsBefore = JSON.stringify(db.job_payments);
  const expensesBefore = JSON.stringify(db.expenses);
  const rentalsBefore = JSON.stringify(db.dumpster_rentals);

  await req(db, { method: "PATCH", body: { id: cust.id, action: "archive", reason: "requested_removal" } });
  await req(db, { method: "PATCH", body: { id: cust.id, action: "restore" } });

  assert.strictEqual(JSON.stringify(db.bookings), bookingsBefore);
  assert.strictEqual(JSON.stringify(db.job_payments), paymentsBefore);
  assert.strictEqual(JSON.stringify(db.expenses), expensesBefore);
  assert.strictEqual(JSON.stringify(db.dumpster_rentals), rentalsBefore);
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
