// Site Improvement Agent, Phase 3 — "How'd it go?" tests.
//
// Covers: api/admin/booking.js's handleStatusAction() optional
// `operationalNote` body field (only ever written when the requested
// status is "completed", response contract unchanged), and the new
// PATCH ?resource=operational-note (handleUpdateOperationalNote()),
// completed-jobs-only, same shape/discipline as the existing Tip control.
//
// Same offline approach as every other admin API test in this suite:
// "@supabase/supabase-js" is intercepted at require-time and replaced
// with a small in-memory fake — never the real network, never the
// production Supabase project.
//
// Run with:  node tests/agent-howd-it-go.test.js

const Module = require("module");
const assert = require("assert");

function nowIso() {
  return new Date().toISOString();
}

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this._updatePayload = null;
    this._single = false;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  order() {
    return this; // ordering doesn't matter for this test's small fixtures
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  maybeSingle() {
    this._single = true;
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const rows = this.db[this.table] || [];
    const match = (row) => this.eqFilters.every((f) => row[f.col] === f.val);
    const matched = rows.filter(match);

    if (this._updatePayload) {
      const row = matched[0];
      if (!row) return { data: null, error: null };
      Object.assign(row, this._updatePayload);
      return { data: { ...row }, error: null };
    }

    if (this._single) {
      return { data: matched[0] ? { ...matched[0] } : null, error: null };
    }
    return { data: matched.map((r) => ({ ...r })), error: null };
  }
}

function makeFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
}

// Same two-client convention as every other admin API test in this suite
// (e.g. tests/phase2-admin-api.test.js): a fake anon client answers
// requireAdmin()'s own auth check (so the real admin-auth.js code path
// runs, unmodified), and a separate fake service-role client answers
// every actual data query. Never the real network, never the real
// admin-auth module bypassed.
function createFakeAnonClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null }),
      refreshSession: async () => ({ data: null, error: { message: "not used in this test" } }),
    },
  };
}

let currentFakeService = null;
const fakeAnon = createFakeAnonClient();

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return fakeAnon;
          if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
          throw new Error("Unexpected Supabase key passed to createClient() in agent-howd-it-go test: " + key);
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

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: "mhjr_admin_at=good", "x-forwarded-proto": "https" }, opts.headers || {}),
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
function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingHandler(req, res)).then(() => res);
}

const BOOKING_ID = "11111111-1111-1111-1111-111111111111";

function freshDb(overrides) {
  return {
    bookings: [
      { id: BOOKING_ID, status: "booked", service_type: "junk_removal", operational_note: null, updated_at: nowIso(), ...overrides },
    ],
  };
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

async function main() {
  await test("PATCH ?resource=status to 'completed' WITH an operationalNote writes bookings.operational_note", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "status" },
      body: { id: BOOKING_ID, status: "completed", operationalNote: "Hot tub removal, easy backyard access." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.bookings[0].operational_note, "Hot tub removal, easy backyard access.");
  });

  await test("PATCH ?resource=status success response is EXACTLY { ok, id, status } — operationalNote is never echoed back", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "status" },
      body: { id: BOOKING_ID, status: "completed", operationalNote: "A note." },
    }));
    assert.deepStrictEqual(Object.keys(res.body).sort(), ["id", "ok", "status"]);
  });

  await test("PATCH ?resource=status to any OTHER status with an operationalNote present never writes it (completed-only)", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "status" },
      body: { id: BOOKING_ID, status: "lost", operationalNote: "This should never be stored." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.bookings[0].operational_note, null);
    assert.strictEqual(db.bookings[0].status, "lost");
  });

  await test("PATCH ?resource=status to 'completed' with NO operationalNote leaves the column untouched (never forced)", async () => {
    const db = freshDb({ operational_note: "pre-existing note" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "status" },
      body: { id: BOOKING_ID, status: "completed" },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.bookings[0].operational_note, "pre-existing note", "omitting the field must never clear an existing note");
  });

  await test("PATCH ?resource=operational-note is refused (400) on a non-completed job", async () => {
    const db = freshDb({ status: "booked" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "operational-note" },
      body: { id: BOOKING_ID, operationalNote: "Trying to sneak one in early." },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.bookings[0].operational_note, null);
  });

  await test("PATCH ?resource=operational-note succeeds on a completed job and updates only operational_note/updated_at", async () => {
    const db = freshDb({ status: "completed" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "operational-note" },
      body: { id: BOOKING_ID, operationalNote: "Garage cleanout in Parker. Mostly furniture and cardboard." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.operationalNote, "Garage cleanout in Parker. Mostly furniture and cardboard.");
    assert.strictEqual(db.bookings[0].operational_note, "Garage cleanout in Parker. Mostly furniture and cardboard.");
    assert.strictEqual(db.bookings[0].status, "completed", "status itself must never change from this endpoint");
  });

  await test("PATCH ?resource=operational-note with blank text clears it back to null", async () => {
    const db = freshDb({ status: "completed", operational_note: "old note" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "operational-note" },
      body: { id: BOOKING_ID, operationalNote: "   " },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.bookings[0].operational_note, null);
  });

  await test("PATCH ?resource=operational-note strips control characters and HTML-shaped text, and caps length at 1000", async () => {
    const db = freshDb({ status: "completed" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      query: { resource: "operational-note" },
      body: { id: BOOKING_ID, operationalNote: "<script>alert(1)</script>Fine job" + "x".repeat(2000) },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!db.bookings[0].operational_note.includes("<script>"));
    assert.ok(db.bookings[0].operational_note.length <= 1000);
  });

  await test("admin/booking-detail.js only prompts for the note when transitioning TO 'completed' FROM a non-completed status", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "admin", "booking-detail.js"), "utf8");
    assert.ok(/newStatus === 'completed' && currentStatus !== 'completed'/.test(src), "expected the completed-transition guard before the prompt()");
    // The prompt must never be unconditional/forced — cancelling (prompt
    // returning null) must still be a valid path that completes the job.
    assert.ok(/if \(raw !== null\) operationalNote = raw\.trim\(\);/.test(src));
  });

  await test("admin/booking-detail.js's operational-note UI never uses innerHTML/insertAdjacentHTML/document.write", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "admin", "booking-detail.js"), "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src));
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
    assert.ok(!/document\.write\s*\(/.test(src));
  });

  await test("GET booking detail includes operationalNote in the response", async () => {
    const db = freshDb({ status: "completed", operational_note: "Third-floor apartment cleanout. Elevator available." });
    db.customers = [];
    db.dumpster_rentals = [];
    db.booking_photos = [];
    db.rental_payments = [];
    db.job_payments = [];
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ method: "GET", query: { id: BOOKING_ID } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.booking.operationalNote, "Third-floor apartment cleanout. Elevator available.");
  });
}

main();
