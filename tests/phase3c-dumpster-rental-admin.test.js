// Local, offline test harness for Batch 2C — the admin dumpster-rental
// workflow (api/admin/booking.js's handleCreate()/handleUpdate()): New Job
// now actually creates a dumpster_rentals row when Dumpster Rental is
// selected (it previously created none at all), Edit Job can edit
// delivery/pickup dates and material/placement fields, and pickup date
// defaults to delivery + 5 calendar days unless manually overridden.
//
// The public /book flow (api/book.js) is untouched by this batch and is
// not exercised here — see its own existing test files.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Run with:  node tests/phase3c-dumpster-rental-admin.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "aaaaaaaa-aaaa-aaaa-aaaa-" + String(100000000000 + nextId++).padStart(12, "0");
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
    this._insertPayload = null;
    this._updatePayload = null;
    this._upsertPayload = null;
    this._upsertOpts = null;
    this._delete = false;
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
  insert(payload) {
    this._insertPayload = payload;
    return this;
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  upsert(payload, opts) {
    this._upsertPayload = payload;
    this._upsertOpts = opts || {};
    return this;
  }
  delete() {
    this._delete = true;
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
      if (this.db.__fkTables && this.db.__fkTables[this.table]) {
        for (const [col, refTable] of Object.entries(this.db.__fkTables[this.table])) {
          const val = this._insertPayload[col];
          if (val != null && !(this.db[refTable] || []).some((r) => r.id === val)) {
            return { data: null, error: { code: "23503", message: "foreign key violation on " + col } };
          }
        }
      }
      if (this.db.__forceError && this.db.__forceError[this.table]) {
        return { data: null, error: this.db.__forceError[this.table] };
      }
      const row = Object.assign({ id: makeId(), created_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    if (this._upsertPayload) {
      const conflictCol = this._upsertOpts.onConflict;
      const conflictVal = conflictCol ? this._upsertPayload[conflictCol] : undefined;
      const existing = conflictCol && conflictVal != null ? rows.find((r) => r[conflictCol] === conflictVal) : null;
      let row;
      if (existing) {
        Object.assign(existing, this._upsertPayload);
        row = existing;
      } else {
        row = Object.assign({ id: makeId(), created_at: nowIso() }, this._upsertPayload);
        rows.push(row);
      }
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter((r) => this.eqFilters.every((f) => r[f.col] === f.val) && this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val));

    if (this._delete) {
      matched.forEach((r) => {
        const idx = rows.indexOf(r);
        if (idx !== -1) rows.splice(idx, 1);
      });
      return { data: matched, error: null };
    }

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
  return Object.assign({ bookings: [], customers: [], dumpster_rentals: [] }, overrides || {});
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function makeCustomer(overrides) {
  return Object.assign({ id: makeId(), first_name: "Jamie", last_name: "Rivera" }, overrides || {});
}
// New Job requires a future-or-today appointment date; this suite runs
// whatever "today" the host system has, so a fixed literal date would
// eventually start failing on its own date-in-the-past validation. The
// exact Sep 25 -> Sep 30 example from the spec is validated separately
// below via Past Job mode instead, which accepts a historical date.
function newJobBody(overrides) {
  return Object.assign(
    {
      serviceType: "dumpster_rental",
      appointmentDate: "2099-09-25",
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
    overrides || {}
  );
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// New Job — creating a dumpster_rentals row
// =======================================================================
test("New Job (dumpster_rental): the exact validated example — delivery Sep 25 defaults to pickup Sep 30 (delivery + 5 calendar days)", async () => {
  // Past Job mode (a historical date, on/before today) is used purely so
  // this test can pin the literal Sep 25/Sep 30 dates from the spec
  // regardless of which real date this suite happens to run on — New Job
  // itself requires a future-or-today date (see newJobBody()'s comment)
  // and would reject a fixed past literal once "today" moves past it. The
  // delivery+5 arithmetic under test is identical in both modes: it's
  // computed from whatever appointmentDate is submitted, never from
  // today's date.
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id, mode: "past", appointmentDate: "2026-09-25", timeWindow: undefined }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.deliveryDate, "2026-09-25");
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-09-30");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, false);
  assert.strictEqual(db.dumpster_rentals.length, 1);
  assert.strictEqual(db.dumpster_rentals[0].booking_id, res.body.booking.id);
});

test("New Job (dumpster_rental): an explicit pickupDate is stored as-is and marked manual", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id, appointmentDate: "2099-09-25", pickupDate: "2099-10-05" }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.pickupDate, "2099-10-05");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, true);
});

test("New Job (dumpster_rental): an explicit pickupDate before the delivery date is rejected, no rows written", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id, appointmentDate: "2099-09-25", pickupDate: "2099-09-20" }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(db.dumpster_rentals.length, 0);
});

test("New Job (dumpster_rental): material type and placement notes are saved when provided", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id, materialType: "Household junk", placementNotes: "Driveway, left side" }) });
  assert.strictEqual(res.body.dumpster.materialType, "Household junk");
  assert.strictEqual(res.body.dumpster.placementNotes, "Driveway, left side");
});

test("New Job (junk_removal): no dumpster_rentals row is created, dumpster is null in the response", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id, serviceType: "junk_removal" }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster, null);
  assert.strictEqual(db.dumpster_rentals.length, 0);
});

test("New Job (dumpster_rental): if the dumpster_rentals insert fails, the just-created booking is rolled back (deleted), not left orphaned", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust], __forceError: { dumpster_rentals: { message: "simulated insert failure" } } });
  const res = await req(db, { method: "POST", body: newJobBody({ customerId: cust.id }) });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.bookings.length, 0, "the booking must be rolled back, never left half-created");
});

// =======================================================================
// Edit Job — editing dumpster_rentals via upsert
// =======================================================================
function seedDumpsterBooking(db, overrides) {
  const booking = Object.assign(
    {
      id: makeId(),
      customer_id: db.customers[0] ? db.customers[0].id : makeId(),
      service_type: "dumpster_rental",
      appointment_date: "2026-09-25",
      time_window: "w_0800_1000",
      exact_time: null,
      status: "booked",
      description: null,
      estimated_price: null,
      estimated_price_max: null,
      final_price: null,
      tip_amount: null,
      internal_notes: null,
      service_address: "1 Main St",
      service_city: "Denver",
      service_state: "CO",
      service_zip: "80202",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    overrides || {}
  );
  db.bookings.push(booking);
  return booking;
}
function seedRental(db, bookingId, overrides) {
  const rental = Object.assign(
    {
      id: makeId(),
      booking_id: bookingId,
      delivery_date: "2026-09-25",
      pickup_date: "2026-09-30",
      pickup_date_is_manual: false,
      material_type: null,
      placement_notes: null,
    },
    overrides || {}
  );
  db.dumpster_rentals.push(rental);
  return rental;
}
function editBody(booking, overrides) {
  return Object.assign(
    {
      id: booking.id,
      updatedAt: booking.updated_at,
      serviceType: booking.service_type,
      appointmentDate: booking.appointment_date,
      timeWindow: booking.time_window,
      serviceAddress: { address: booking.service_address, city: booking.service_city, state: booking.service_state, zip: booking.service_zip },
    },
    overrides || {}
  );
}

test("Edit Job: changing delivery date while pickup is still system-derived shifts pickup to new delivery + 5", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id });
  seedRental(db, booking.id, { pickup_date_is_manual: false });

  const res = await req(db, { method: "PATCH", body: editBody(booking, { appointmentDate: "2026-10-01", pickupDateManual: false }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.deliveryDate, "2026-10-01");
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-10-06");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, false);
  assert.strictEqual(db.dumpster_rentals.length, 1, "must upsert onto the existing row, never create a second one");
});

test("Edit Job: once pickup is manually overridden, a later delivery-date change does not touch it (client sends pickupDateManual: true)", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id });
  seedRental(db, booking.id, { pickup_date: "2026-10-15", pickup_date_is_manual: true });

  // The delivery date is changing, but the client (per its own sticky
  // "was already manual" tracking) still sends pickupDateManual: true and
  // resubmits the SAME pickup date it loaded — proving the server never
  // recomputes it just because delivery moved.
  const res = await req(db, { method: "PATCH", body: editBody(booking, { appointmentDate: "2026-10-01", pickupDateManual: true, pickupDate: "2026-10-15" }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.deliveryDate, "2026-10-01");
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-10-15", "the manually-set pickup date must survive the delivery-date change untouched");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, true);
});

// Pre-rollout audit finding, fixed in the migration (DEFAULT true, not
// false — see sql/2026-09-26_phase3c-stage5-archive-review-rental-client
// .sql §3): a historical (pre-Batch-2C) or public-/book-originated rental
// always has pickup_date_is_manual = true. This proves WHY that default
// matters, independent of the SQL itself (which this offline harness
// can't execute): if a row were left at false, saving ANY edit to a
// dumpster-rental job — even one that never touches delivery or pickup at
// all — would silently overwrite a customer's real, chosen pickup date
// with a fabricated delivery+5 value, purely as a side effect of
// handleUpdate()'s "not manual -> always recompute" rule. A correctly
// true row must be immune to exactly that.
test("Edit Job: a manually-set pickup date survives a save that only touches an unrelated field, delivery unchanged (the exact corruption a wrong DB default would cause)", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id, description: "Old description" });
  // A real customer-chosen pickup date that is NOT delivery + 5 (delivery
  // is 2026-09-25; delivery + 5 would be 2026-09-30) — exactly the shape
  // of a genuine historical /book row this migration's default protects.
  seedRental(db, booking.id, { delivery_date: "2026-09-25", pickup_date: "2026-10-10", pickup_date_is_manual: true });

  // Same delivery date as already stored, pickupDateManual: true (this is
  // what a correctly-backfilled row's client-side load would compute —
  // see admin/booking-edit.js's loadedPickupDateIsManual) — but the admin
  // is only actually changing the description, nothing rental-related.
  const res = await req(db, {
    method: "PATCH",
    body: editBody(booking, { description: "Fixed a typo", appointmentDate: "2026-09-25", pickupDateManual: true, pickupDate: "2026-10-10" }),
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-10-10", "an unrelated-field edit must never recompute a manually-set pickup date");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, true);
});

test("Edit Job: a fresh manual pickup-date edit (delivery unchanged) is stored as-is", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id });
  seedRental(db, booking.id, { pickup_date_is_manual: false });

  const res = await req(db, { method: "PATCH", body: editBody(booking, { pickupDateManual: true, pickupDate: "2026-11-01" }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-11-01");
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, true);
});

test("Edit Job: a manual pickup date before the delivery date is rejected, nothing written", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id });
  seedRental(db, booking.id);

  const res = await req(db, { method: "PATCH", body: editBody(booking, { pickupDateManual: true, pickupDate: "2026-09-01" }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.dumpster_rentals[0].pickup_date, "2026-09-30", "unchanged");
});

test("Edit Job: service type changed TO dumpster_rental with no existing dumpster_rentals row creates one via upsert, defaulting pickup", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const booking = seedDumpsterBooking(db, { customer_id: cust.id, service_type: "junk_removal" });
  // No seedRental() call — this booking has never had a dumpster_rentals row.

  const res = await req(db, { method: "PATCH", body: editBody(booking, { serviceType: "dumpster_rental", appointmentDate: "2026-09-25", pickupDateManual: false }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-09-30");
  assert.strictEqual(db.dumpster_rentals.length, 1);
});

test("Edit Job: a non-dumpster-rental job never touches dumpster_rentals, even when an unrelated row exists for a different booking", async () => {
  adminAuthed();
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const other = seedDumpsterBooking(db, { customer_id: cust.id });
  seedRental(db, other.id);
  const plainBooking = seedDumpsterBooking(db, { customer_id: cust.id, service_type: "junk_removal", id: makeId() });

  const before = JSON.stringify(db.dumpster_rentals);
  const res = await req(db, { method: "PATCH", body: editBody(plainBooking, { description: "Edited" }) });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster, null);
  assert.strictEqual(JSON.stringify(db.dumpster_rentals), before);
});

// =======================================================================
// Migration content — static guard against the DEFAULT false bug
// recurring. This offline harness has no real Postgres engine to run the
// actual migration against (same "not testable offline" limit as every
// other real-DDL behavior in this suite) — this instead reads the
// migration file's own text and asserts the specific literal that fixes
// the bug is present, so a future edit to this file can't silently
// reintroduce it. See that file's §3 for the full reasoning.
// =======================================================================
test("sql migration: dumpster_rentals.pickup_date_is_manual defaults to TRUE, not false (a real historical/public-/book data-corruption risk, found and fixed in a pre-rollout audit)", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "sql", "2026-09-26_phase3c-stage5-archive-review-rental-client.sql"), "utf8");
  const stmtStart = src.indexOf("ADD COLUMN IF NOT EXISTS pickup_date_is_manual");
  assert.ok(stmtStart !== -1, "pickup_date_is_manual column must exist in the migration");
  const stmtEnd = src.indexOf(";", stmtStart);
  const stmt = src.slice(stmtStart, stmtEnd + 1);
  assert.ok(/DEFAULT\s+true/i.test(stmt), "pickup_date_is_manual must default to true — false would silently corrupt every existing and future /book-originated rental's pickup date the first time an admin edits that job for any reason: " + stmt);
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
