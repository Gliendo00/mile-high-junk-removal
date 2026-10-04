// Local, offline test harness for Phase 3C Stage 5D's api/admin/lead.js —
// the Confirm as Lead action (the ONE file in this codebase with a write
// grant on `leads`; see that file's own header).
//
// Scope: proves (a) a reviewed intake converts into a `leads` row with the
// expected field mapping, (b) a `leads`-insert unique_violation (a raced
// double-click/retry against leads_source_intake_id_uniq) returns the
// existing row rather than erroring or duplicating, (c) an ambiguous
// client match is refused rather than guessed, (d) this never creates a
// customer, and (e) the source intake leaves Pending Intake afterward.
//
// Same interception approach as every other admin test in this project —
// "@supabase/supabase-js" replaced at require-time with an in-memory fake.
//
// Run with:  node tests/phase3c-stage5d-lead-confirm.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(100000000000 + nextId++).padStart(12, "0");
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
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        const err = this._db.__insertError[this._table];
        delete this._db.__insertError[this._table]; // one-shot, like the Batch 5 harness's "Once" error
        return { data: null, error: err };
      }
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

const leadHandler = require("../api/admin/lead.js");

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
  return Promise.resolve(leadHandler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
const AUTH_COOKIE = "mhjr_admin_at=at-good";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}

const INTAKE_ID = "99999999-9999-9999-9999-999999999999";
const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function fieldsFixture(overrides) {
  const base = {
    firstName: { value: "Jamie", confidence: "confirmed", sourceIndex: 0 },
    lastName: { value: "Rivera", confidence: "confirmed", sourceIndex: 0 },
    phone: { value: "303-555-0100", confidence: "confirmed", sourceIndex: 0 },
    email: { value: null, confidence: "missing", sourceIndex: null },
    address: { value: null, confidence: "missing", sourceIndex: null },
    city: { value: "Denver", confidence: "likely", sourceIndex: 0 },
    state: { value: null, confidence: "missing", sourceIndex: null },
    zip: { value: null, confidence: "missing", sourceIndex: null },
    serviceType: { value: "Junk Removal", confidence: "confirmed", sourceIndex: 0 },
    serviceDetails: { value: "Garage cleanout", confidence: "likely", sourceIndex: 0 },
    itemDescription: { value: "Old furniture", confidence: "likely", sourceIndex: 0 },
    estimatedLoadSize: { value: "Half truck", confidence: "uncertain", sourceIndex: 0 },
    quotedAmount: { value: "$350", confidence: "likely", sourceIndex: 0 },
    date: { value: null, confidence: "missing", sourceIndex: null },
    appointmentTime: { value: null, confidence: "missing", sourceIndex: null },
    schedulingStatus: { value: null, confidence: "missing", sourceIndex: null },
    internalNotes: { value: "Gate code 1234", confidence: "confirmed", sourceIndex: 0 },
    photosReferenced: { value: "yes", confidence: "confirmed", sourceIndex: 0 },
    clientConstraints: { value: "Prefers afternoons", confidence: "likely", sourceIndex: 0 },
  };
  return Object.assign(base, overrides || {});
}

function freshDb(overrides) {
  const intake = Object.assign(
    {
      id: INTAKE_ID,
      status: "pending_review",
      match_status: "new_candidate",
      matched_customer_id: null,
      resulting_customer_id: null,
      extracted_data: { fields: fieldsFixture() },
    },
    overrides || {}
  );
  return { intake_sessions: [intake], leads: [], customers: [{ id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera" }] };
}

function post(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "POST", cookie: AUTH_COOKIE, body: body }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

test("401 without a valid admin session", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "POST", cookie: "", body: { intakeSessionId: INTAKE_ID } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.leads.length, 0);
});

// UPDATED — lead-detail navigation fix (UI batch, 2026-10): GET is no
// longer unsupported on this file — it now backs the canonical Lead
// detail page (admin/lead/, see api/admin/lead.js's handleGet()). DELETE
// is still genuinely unsupported and exercises the same 405 path this
// test originally meant to cover.
test("GET without an id -> 404 (same 'malformed/missing id reads as not found' posture as the other admin detail endpoints), never 405", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "GET", cookie: AUTH_COOKIE }));
  assert.strictEqual(res.statusCode, 404);
});

test("unsupported method (DELETE) -> 405", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "DELETE", cookie: AUTH_COOKIE }));
  assert.strictEqual(res.statusCode, 405);
});

test("missing/invalid intakeSessionId -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await post(db, { intakeSessionId: "not-a-uuid" });
  assert.strictEqual(res.statusCode, 404);
});

test("unknown intake id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await post(db, { intakeSessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
  assert.strictEqual(res.statusCode, 404);
});

test("refused when the intake is not pending_review", async () => {
  adminAuthed();
  const db = freshDb({ status: "discarded" });
  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.leads.length, 0);
});

test("refused when the client match is ambiguous (needs_confirmation) — never guessed", async () => {
  adminAuthed();
  const db = freshDb({ match_status: "needs_confirmation" });
  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.leads.length, 0);
});

test("refused when the intake has no name, phone, or email to confirm", async () => {
  adminAuthed();
  const db = freshDb();
  db.intake_sessions[0].extracted_data.fields = fieldsFixture({
    firstName: { value: null, confidence: "missing", sourceIndex: null },
    phone: { value: null, confidence: "missing", sourceIndex: null },
    email: { value: null, confidence: "missing", sourceIndex: null },
  });
  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.leads.length, 0);
});

test("happy path: creates a lead with the expected field mapping, never creates a customer", async () => {
  adminAuthed();
  const db = freshDb({ matched_customer_id: CUSTOMER_ID, match_status: "existing_exact" });
  const customersBefore = db.customers.length;

  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.lead.status, "new");

  assert.strictEqual(db.leads.length, 1);
  const lead = db.leads[0];
  assert.strictEqual(lead.source, "screenshot_intake");
  assert.strictEqual(lead.source_intake_id, INTAKE_ID);
  assert.strictEqual(lead.status, "new");
  assert.strictEqual(lead.created_by, ADMIN_EMAIL);
  assert.strictEqual(lead.first_name, "Jamie");
  assert.strictEqual(lead.last_name, "Rivera");
  assert.strictEqual(lead.phone, "303-555-0100");
  assert.strictEqual(lead.phone_normalized, "3035550100");
  assert.strictEqual(lead.city, "Denver");
  assert.strictEqual(lead.service_type, "Junk Removal");
  assert.strictEqual(lead.service_details, "Garage cleanout — Items: Old furniture");
  assert.strictEqual(lead.estimated_load_size, "Half truck");
  assert.strictEqual(lead.quoted_amount, 350);
  assert.ok(lead.notes.includes("Gate code 1234"));
  assert.ok(lead.notes.includes("Prefers afternoons"));
  assert.ok(lead.notes.includes("Photos referenced"));
  assert.strictEqual(lead.matched_customer_id, CUSTOMER_ID);

  assert.strictEqual(db.customers.length, customersBefore, "confirming a lead must never create a customer row");

  const intakeRow = db.intake_sessions[0];
  assert.strictEqual(intakeRow.status, "confirmed");
  assert.strictEqual(intakeRow.resulting_customer_id, CUSTOMER_ID);
  assert.ok(intakeRow.confirmed_at);
  assert.strictEqual(intakeRow.confirmed_by, ADMIN_EMAIL);
});

test("happy path with no matched customer: matched_customer_id/resulting_customer_id stay null", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.leads[0].matched_customer_id, null);
  assert.strictEqual(db.intake_sessions[0].resulting_customer_id, null);
});

test("a quoted amount with no digits at all (e.g. 'TBD') becomes quoted_amount null rather than erroring or blocking", async () => {
  adminAuthed();
  const db = freshDb();
  db.intake_sessions[0].extracted_data.fields.quotedAmount = { value: "TBD", confidence: "missing", sourceIndex: null };
  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.leads[0].quoted_amount, null);
});

test("idempotent: retrying the SAME intakeSessionId on an already-confirmed-as-lead intake returns the existing lead, never a duplicate", async () => {
  adminAuthed();
  const db = freshDb();
  const res1 = await post(db, { intakeSessionId: INTAKE_ID });
  const firstLeadId = res1.body.lead.id;
  assert.strictEqual(db.leads.length, 1);

  const res2 = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body.lead.id, firstLeadId);
  assert.strictEqual(db.leads.length, 1, "a second confirm must never create a second lead row");
});

test("raced double-submit: a leads-insert unique_violation (23505) returns the row the race produced, never a duplicate or an error", async () => {
  adminAuthed();
  const db = freshDb();
  // Simulates another in-flight request (a double-click) winning the race
  // and inserting the lead a moment before this one's own insert runs.
  db.leads.push({ id: "raced-lead-id", source_intake_id: INTAKE_ID, status: "new", created_at: "2026-10-06T11:59:59.000Z" });
  db.__insertError = { leads: { code: "23505", message: "duplicate key value violates unique constraint \"leads_source_intake_id_uniq\"" } };

  const res = await post(db, { intakeSessionId: INTAKE_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.lead.id, "raced-lead-id");
  assert.strictEqual(db.leads.length, 1, "must never end up with two leads for one intake");
  assert.strictEqual(db.intake_sessions[0].status, "confirmed", "the intake must still end up marked confirmed even though its own insert lost the race");
});

test("a confirmed-as-lead intake no longer appears in the default (pending_review) Pending Intake list", async () => {
  adminAuthed();
  const db = freshDb();
  await post(db, { intakeSessionId: INTAKE_ID });

  // Cross-checks against the OTHER file's own list endpoint — both read
  // the same intake_sessions table, so a status="confirmed" row written
  // by api/admin/lead.js must be invisible to api/admin/intake.js's
  // default (?status=pending_review) list exactly as it would be for any
  // other confirm path.
  currentFakeService = createFakeServiceClient(db);
  const intakeHandler = require("../api/admin/intake.js");
  const res = makeRes();
  await intakeHandler(makeReq({ method: "GET", cookie: AUTH_COOKIE, query: {} }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!res.body.intakes.some((i) => i.id === INTAKE_ID));
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
