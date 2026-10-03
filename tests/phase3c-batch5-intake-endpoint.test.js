// Local, offline test harness for Batch 5 (5B/5C) — api/admin/intake.js.
// See docs/phase-3/batch5-screenshot-intake-proposal.md.
//
// Same interception approach as every prior admin test in this project:
// "@supabase/supabase-js" is replaced at require-time with an in-memory
// fake (never the real network, never production Supabase). The vision
// adapter is NOT mocked at the module level — instead, per Rocky's
// instruction, this file exercises the REAL api/_lib/intake-vision-provider.js
// adapter end-to-end, with global.fetch stubbed to return a deterministic
// OpenAI-shaped response (same technique
// tests/phase3c-batch5-intake-vision-provider.test.js already uses). A
// throwaway OPENAI_API_KEY is set purely so the adapter's "not configured"
// guard doesn't short-circuit before ever reaching the mocked fetch — no
// real credential, no real network call is ever made or possible here.
//
// Scope: proves (a) the full session lifecycle (create -> upload ->
// extract -> review/edit -> discard), (b) phone-based client matching
// against the SAME normalization customer-identity.js defines everywhere
// else, (c) existing-job candidate detection, (d) classification/
// confidence persistence and admin overrides, and (e) THE CRITICAL
// GUARANTEE: this file never writes to customers or bookings — only reads
// them. Confirming into a real customer/booking record is Stage 5D, not
// built yet.
//
// Run with:  node tests/phase3c-batch5-intake-endpoint.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: a query builder covering every shape api/admin/intake.js
// actually uses (eq/in/gte/order, insert->select->single, plain update/
// delete with no further chaining, count+head selects, maybeSingle), plus
// an in-memory Storage fake (upload/download/remove/createSignedUrl).
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "aaaaaaaa-aaaa-aaaa-aaaa-" + String(100000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._count = null;
    this._single = null;
    this._insertData = undefined;
    this._updateData = undefined;
    this._deleteFlag = false;
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
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
  gte(field, val) {
    this._filters.push((row) => row[field] >= val);
    return this;
  }
  lt(field, val) {
    this._filters.push((row) => row[field] < val);
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
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
  delete() {
    this._deleteFlag = true;
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
      // One-shot error: fires on the FIRST insert attempt to this table
      // only, then clears itself — models a transient error (e.g. the real
      // UNIQUE(intake_session_id, sort_order) constraint firing on a racing
      // concurrent upload) that a retry with recomputed values would
      // succeed past. db.__insertError (below) is the permanent/always-fails
      // version, for testing exhaustion of the retry budget.
      if (this._db.__insertErrorOnce && this._db.__insertErrorOnce[this._table]) {
        const onceErr = this._db.__insertErrorOnce[this._table];
        delete this._db.__insertErrorOnce[this._table];
        return { data: null, error: onceErr };
      }
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        return { data: null, error: this._db.__insertError[this._table] };
      }
      const row = Object.assign({ id: makeId(), created_at: "2026-10-04T12:00:00.000Z" }, this._insertData);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      if (this._single === "single") return { data: row, error: null };
      return { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._deleteFlag) {
      if (this._db.__deleteError && this._db.__deleteError[this._table]) {
        return { data: null, error: this._db.__deleteError[this._table] };
      }
      const toDeleteIds = new Set(filtered.map((r) => r.id));
      this._db[this._table] = (this._db[this._table] || []).filter((r) => !toDeleteIds.has(r.id));
      return { data: null, error: null };
    }

    if (this._updateData !== undefined) {
      if (this._db.__updateError && this._db.__updateError[this._table]) {
        return { data: null, error: this._db.__updateError[this._table] };
      }
      filtered.forEach((row) => Object.assign(row, this._updateData));
      return { data: null, error: null };
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
  db.__storage = db.__storage || {};
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
    },
    storage: {
      from(bucket) {
        db.__storage[bucket] = db.__storage[bucket] || {};
        return {
          async upload(objectPath, buffer) {
            if (db.__storageUploadError) return { data: null, error: db.__storageUploadError };
            db.__storage[bucket][objectPath] = buffer;
            return { data: { path: objectPath }, error: null };
          },
          async download(objectPath) {
            if (db.__storageDownloadError) return { data: null, error: db.__storageDownloadError };
            const buf = db.__storage[bucket][objectPath];
            if (!buf) return { data: null, error: { message: "object not found: " + objectPath } };
            return {
              data: {
                arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
              },
              error: null,
            };
          },
          async remove(paths) {
            paths.forEach((p) => {
              delete db.__storage[bucket][p];
            });
            return { data: null, error: null };
          },
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
// Throwaway test-only value — never a real credential. Only exists so the
// REAL adapter's "is OPENAI_API_KEY configured" guard passes and reaches
// the mocked global.fetch below; no network call is ever possible here.
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

// --- fake fetch: deterministic OpenAI-shaped vision response -----------
// Same shape tests/phase3c-batch5-intake-vision-provider.test.js uses —
// this IS "a deterministic mocked vision-provider response," applied at
// the actual external boundary (fetch) rather than re-mocking the adapter
// module, so this file exercises the real, already-unit-tested adapter.
let fetchImpl = null;
global.fetch = function (url, opts) {
  return fetchImpl(url, opts);
};

function okFetch(bodyObj) {
  return function () {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(bodyObj) });
  };
}
function openAiEnvelope(contentObj) {
  return { choices: [{ message: { content: JSON.stringify(contentObj) } }] };
}
function emptyFields() {
  const fields = {};
  const { FIELD_KEYS } = require("../api/_lib/intake-vision-provider.js");
  FIELD_KEYS.forEach((k) => {
    fields[k] = { value: null, confidence: "missing", sourceIndex: null };
  });
  return fields;
}
function extractionFixture(overrides) {
  const fields = emptyFields();
  fields.firstName = { value: "Jamie", confidence: "confirmed", sourceIndex: 0 };
  fields.phone = { value: "303-555-0100", confidence: "confirmed", sourceIndex: 0 };
  return Object.assign(
    { fields: fields, classification: "lead_only", classificationConfidence: "likely", conflicts: [] },
    overrides || {}
  );
}

const intakeHandler = require("../api/admin/intake.js");

// ---------------------------------------------------------------------
function makeReq(opts) {
  opts = opts || {};
  const isBuffer = Buffer.isBuffer(opts.body);
  const json = !isBuffer && opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const length = isBuffer ? opts.body.length : Buffer.byteLength(json);
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        "content-type": isBuffer ? "application/octet-stream" : "application/json",
        "content-length": String(length),
        cookie: opts.cookie || "",
        "x-forwarded-proto": "https",
      },
      opts.headers || {}
    ),
    body: isBuffer ? opts.body : opts.body,
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
    setHeader: (n, v) => {
      headers[n.toLowerCase()] = v;
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

function freshDb() {
  return {
    intake_sessions: [],
    intake_screenshots: [],
    customers: [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", phone_normalized: "3035550100", email_normalized: "jamie@example.com" },
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", first_name: "Alex", last_name: "Doe", phone: "303-555-0101", email: null, phone_normalized: "3035550101", email_normalized: null },
    ],
    bookings: [],
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function createSession(db) {
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "POST", cookie: AUTH_COOKIE, query: {} }));
  return res.body.id;
}

async function uploadScreenshot(db, sessionId, overrides) {
  currentFakeService = createFakeServiceClient(db);
  const opts = Object.assign(
    {
      method: "POST",
      cookie: AUTH_COOKIE,
      query: { action: "upload-screenshot" },
      body: PNG_BYTES,
      headers: { "x-intake-session-id": sessionId, "x-screenshot-type": "image/png" },
    },
    overrides || {}
  );
  return run(makeReq(opts));
}

async function extract(db, sessionId) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "POST", cookie: AUTH_COOKIE, query: { action: "extract" }, body: { id: sessionId } }));
}

async function patch(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "PATCH", cookie: AUTH_COOKIE, body: body }));
}

async function detail(db, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { id: id } }));
}

async function list(db, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(makeReq({ method: "GET", cookie: AUTH_COOKIE, query: query || {} }));
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// 1. Auth gating ---------------------------------------------------------
test("every method is rejected (401) without a valid admin session, before any query runs", async () => {
  currentFakeAnon = createFakeAnonClient();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "POST", cookie: "", query: {} }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(db.intake_sessions.length, 0, "no session should ever be created without auth");
});

test("unsupported method -> 405", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "DELETE", cookie: AUTH_COOKIE }));
  assert.strictEqual(res.statusCode, 405);
});

// 2. create-session -------------------------------------------------------
test("POST (no action) creates a new intake session, status processing", async () => {
  adminAuthed();
  const db = freshDb();
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  const id = await createSession(db);
  assert.ok(id);
  assert.strictEqual(db.intake_sessions[0].status, "processing");
  assert.strictEqual(db.intake_sessions[0].created_by, ADMIN_EMAIL);
});

// 3. upload-screenshot ------------------------------------------------------
test("upload-screenshot: missing session id header -> 400, nothing stored", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await uploadScreenshot(db, "", {});
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_screenshots.length, 0);
});

test("upload-screenshot: unknown session id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await uploadScreenshot(db, "ffffffff-ffff-ffff-ffff-ffffffffffff");
  assert.strictEqual(res.statusCode, 404);
});

test("upload-screenshot: wrong declared type (not one of the 3 allowed) -> 400", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res = await uploadScreenshot(db, id, { headers: { "x-intake-session-id": id, "x-screenshot-type": "image/gif" } });
  assert.strictEqual(res.statusCode, 400);
});

test("upload-screenshot: bytes don't match declared type's magic bytes -> 400, no row/storage written", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res = await uploadScreenshot(db, id, { body: Buffer.from("not a real png") });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_screenshots.length, 0);
});

test("upload-screenshot: success stores the row with the correct sort_order and the bytes in Storage", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res1 = await uploadScreenshot(db, id);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(db.intake_screenshots.length, 1);
  assert.strictEqual(db.intake_screenshots[0].sort_order, 0);
  assert.strictEqual(db.intake_screenshots[0].content_type, "image/png");

  const res2 = await uploadScreenshot(db, id);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.intake_screenshots[1].sort_order, 1, "second screenshot gets the next sort_order");
});

test("upload-screenshot: refused once the session has moved past 'processing'", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);
  assert.strictEqual(db.intake_sessions[0].status, "pending_review");

  const res = await uploadScreenshot(db, id);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_screenshots.length, 1, "no screenshot added once extraction has already run");
});

test("upload-screenshot: refuses once the per-session cap is reached", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  for (let i = 0; i < 10; i++) {
    const r = await uploadScreenshot(db, id);
    assert.strictEqual(r.statusCode, 200);
  }
  const over = await uploadScreenshot(db, id);
  assert.strictEqual(over.statusCode, 400);
  assert.strictEqual(db.intake_screenshots.length, 10);
});

// 4. extract --------------------------------------------------------------
test("extract: no screenshots uploaded yet -> 400", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res = await extract(db, id);
  assert.strictEqual(res.statusCode, 400);
});

test("extract: unknown session id -> 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await extract(db, "ffffffff-ffff-ffff-ffff-ffffffffffff");
  assert.strictEqual(res.statusCode, 404);
});

test("extract: success persists extracted_data, classification, and confidence; status -> pending_review", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ classification: "quote_discussion", classificationConfidence: "confirmed" })));
  const res = await extract(db, id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "pending_review");

  const row = db.intake_sessions[0];
  assert.strictEqual(row.status, "pending_review");
  assert.strictEqual(row.classification, "quote_discussion");
  assert.strictEqual(row.classification_confidence, "confirmed");
  assert.strictEqual(row.extracted_data.fields.firstName.value, "Jamie");
  assert.deepStrictEqual(row.ai_raw_extraction, row.extracted_data, "ai_raw_extraction is an untouched copy immediately after extraction");
});

test("extract: cannot run twice once already pending_review", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);
  const res2 = await extract(db, id);
  assert.strictEqual(res2.statusCode, 400);
});

test("extract: an adapter failure marks the session extraction_failed (never a 500, never loses the screenshots)", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = function () {
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) });
  };
  const res = await extract(db, id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, "extraction_failed");
  assert.strictEqual(db.intake_sessions[0].status, "extraction_failed");
  assert.ok(db.intake_sessions[0].extraction_error);
  assert.strictEqual(db.intake_screenshots.length, 1, "the uploaded screenshot must still be there after a failed extraction");
});

test("extract: can be retried after extraction_failed, using the same already-uploaded screenshots", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = function () {
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) });
  };
  await extract(db, id);
  assert.strictEqual(db.intake_sessions[0].status, "extraction_failed");

  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  const res2 = await extract(db, id);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body.status, "pending_review");
});

// 5. Client matching --------------------------------------------------------
test("extract: a phone matching exactly one customer -> match_status existing_exact, matched_customer_id set", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture())); // fields.phone = "303-555-0100" -> normalizes to 3035550100, matches db.customers[0]
  await extract(db, id);
  const row = db.intake_sessions[0];
  assert.strictEqual(row.match_status, "existing_exact");
  assert.strictEqual(row.matched_customer_id, "cccccccc-cccc-cccc-cccc-cccccccccccc");
  assert.strictEqual(row.extracted_phone_normalized, "3035550100");
});

test("extract: a phone matching zero customers -> new_candidate, no matched_customer_id", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const noMatchExtraction = extractionFixture();
  noMatchExtraction.fields.phone = { value: "303-555-9999", confidence: "confirmed", sourceIndex: 0 };
  fetchImpl = okFetch(openAiEnvelope(noMatchExtraction));
  await extract(db, id);
  const row = db.intake_sessions[0];
  assert.strictEqual(row.match_status, "new_candidate");
  assert.strictEqual(row.matched_customer_id, null);
});

test("extract: no phone extracted at all -> new_candidate (nothing to match against)", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const noPhoneExtraction = extractionFixture();
  noPhoneExtraction.fields.phone = { value: null, confidence: "missing", sourceIndex: null };
  fetchImpl = okFetch(openAiEnvelope(noPhoneExtraction));
  await extract(db, id);
  assert.strictEqual(db.intake_sessions[0].match_status, "new_candidate");
});

test("extract: a phone matching MULTIPLE customers -> needs_confirmation, never guessed", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers.push({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", first_name: "Other", last_name: "Jamie", phone: "303-555-0100", email: null, phone_normalized: "3035550100", email_normalized: null });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);
  const row = db.intake_sessions[0];
  assert.strictEqual(row.match_status, "needs_confirmation");
  assert.strictEqual(row.matched_customer_id, null);
});

// 6. list / detail -----------------------------------------------------------
test("list: defaults to pending_review only, newest first, with the matched client's display name joined in", async () => {
  adminAuthed();
  const db = freshDb();
  const id1 = await createSession(db);
  await uploadScreenshot(db, id1);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id1);

  const id2 = await createSession(db);
  // id2 stays in 'processing' (no extraction run) — must not appear in the default list.

  const res = await list(db);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.intakes.length, 1);
  assert.strictEqual(res.body.intakes[0].id, id1);
  assert.strictEqual(res.body.intakes[0].matchedClientName, "Jamie Rivera");
});

test("list: no customer match falls back to the extracted name (never 'Unidentified client' when one exists)", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const fields = emptyFields();
  fields.firstName = { value: "Morgan", confidence: "likely", sourceIndex: 0 };
  fields.lastName = { value: "Lee", confidence: "likely", sourceIndex: 0 };
  // Deliberately NOT one of freshDb()'s seeded phone numbers, so this
  // resolves to match_status new_candidate (no customers row to join).
  fields.phone = { value: "303-555-0199", confidence: "confirmed", sourceIndex: 0 };
  fields.serviceType = { value: "Junk Removal", confidence: "likely", sourceIndex: 0 };
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ fields: fields })));
  await extract(db, id);

  const res = await list(db);
  assert.strictEqual(res.body.intakes[0].matchStatus, "new_candidate");
  assert.strictEqual(res.body.intakes[0].matchedClientName, null);
  assert.strictEqual(res.body.intakes[0].extractedClientName, "Morgan Lee");
  assert.strictEqual(res.body.intakes[0].extractedServiceType, "Junk Removal");
});

test("list: with no name, phone, or email extracted, matchedClientName and extractedClientName are both null (card falls back to 'Unidentified client')", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ fields: emptyFields() })));
  await extract(db, id);

  const res = await list(db);
  assert.strictEqual(res.body.intakes[0].matchedClientName, null);
  assert.strictEqual(res.body.intakes[0].extractedClientName, null);
  assert.strictEqual(res.body.intakes[0].extractedPhone, null);
  assert.strictEqual(res.body.intakes[0].extractedEmail, null);
});

test("list: ?countsOnly=1 returns just the pending count", async () => {
  adminAuthed();
  const db = freshDb();
  const id1 = await createSession(db);
  await uploadScreenshot(db, id1);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id1);

  const res = await list(db, { countsOnly: "1" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.pendingCount, 1);
  assert.strictEqual(res.body.intakes, undefined, "countsOnly must never also return the full row list");
});

test("detail: returns fields, classification, matched client with job count, and signed screenshot URLs", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings.push({ id: "11111111-1111-1111-1111-111111111111", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", service_type: "junk_removal", appointment_date: "2025-01-01", status: "completed" });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);

  const res = await detail(db, id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.intake.fields.firstName.value, "Jamie");
  assert.strictEqual(res.body.intake.classification, "lead_only");
  assert.strictEqual(res.body.intake.matchedClient.firstName, "Jamie");
  assert.strictEqual(res.body.intake.matchedClient.jobCount, 1);
  assert.strictEqual(res.body.intake.screenshots.length, 1);
  assert.ok(res.body.intake.screenshots[0].url.startsWith("https://mock-signed.example/"));
});

test("detail: existingJobCandidates is only populated for existing_job_update + a resolved client, and only shows upcoming booked/rental_out jobs", async () => {
  adminAuthed();
  const db = freshDb();
  const future = "2099-01-01";
  db.bookings.push(
    { id: "11111111-1111-1111-1111-111111111111", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", service_type: "junk_removal", appointment_date: future, time_window: "w_0800_1000", status: "booked" },
    { id: "22222222-2222-2222-2222-222222222222", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", service_type: "junk_removal", appointment_date: future, status: "completed" } // not a candidate: already completed
  );
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ classification: "existing_job_update" })));
  await extract(db, id);

  const res = await detail(db, id);
  assert.strictEqual(res.body.intake.existingJobCandidates.length, 1);
  assert.strictEqual(res.body.intake.existingJobCandidates[0].id, "11111111-1111-1111-1111-111111111111");
});

test("detail: no existingJobCandidates computed when classification isn't existing_job_update, even with a matched client and open bookings", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings.push({ id: "11111111-1111-1111-1111-111111111111", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", service_type: "junk_removal", appointment_date: "2099-01-01", status: "booked" });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ classification: "lead_only" })));
  await extract(db, id);

  const res = await detail(db, id);
  assert.deepStrictEqual(res.body.intake.existingJobCandidates, []);
});

// 7. PATCH ?action=update ------------------------------------------------
test("PATCH update: corrected fields become confidence='confirmed' and lose their sourceIndex", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);

  const res = await patch(db, { id: id, action: "update", fields: { lastName: "Rivera-Smith", quotedAmount: "350" } });
  assert.strictEqual(res.statusCode, 200);
  const row = db.intake_sessions[0];
  assert.deepStrictEqual(row.extracted_data.fields.lastName, { value: "Rivera-Smith", confidence: "confirmed", sourceIndex: null });
  assert.deepStrictEqual(row.extracted_data.fields.quotedAmount, { value: "350", confidence: "confirmed", sourceIndex: null });
  assert.strictEqual(row.extracted_data.fields.firstName.value, "Jamie", "an untouched field must be unaffected");
});

test("PATCH update: an unrecognized field key is silently ignored, never written", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);

  await patch(db, { id: id, action: "update", fields: { notARealField: "hacked", __proto__: "x" } });
  const row = db.intake_sessions[0];
  assert.ok(!("notARealField" in row.extracted_data.fields));
});

test("PATCH update: refused once the intake is no longer pending_review", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res = await patch(db, { id: id, action: "update", fields: { firstName: "x" } });
  assert.strictEqual(res.statusCode, 400, "still 'processing' — nothing to review/edit yet");
});

// 8. PATCH ?action=reclassify ----------------------------------------------
test("PATCH reclassify: invalid classification string -> 400, nothing changed", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);
  const res = await patch(db, { id: id, action: "reclassify", classification: "definitely_booked" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.intake_sessions[0].classification, "lead_only");
});

test("PATCH reclassify: a valid override updates both the column and extracted_data, confidence becomes confirmed", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ classification: "unclear", classificationConfidence: "uncertain" })));
  await extract(db, id);

  const res = await patch(db, { id: id, action: "reclassify", classification: "quote_discussion" });
  assert.strictEqual(res.statusCode, 200);
  const row = db.intake_sessions[0];
  assert.strictEqual(row.classification, "quote_discussion");
  assert.strictEqual(row.classification_confidence, "confirmed");
  assert.strictEqual(row.extracted_data.classification, "quote_discussion");
});

// 9. PATCH ?action=set-client-match -----------------------------------------
test("PATCH set-client-match: assigning a real client sets existing_exact and clears any prior linked booking", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const noMatch = extractionFixture();
  noMatch.fields.phone = { value: null, confidence: "missing", sourceIndex: null };
  fetchImpl = okFetch(openAiEnvelope(noMatch));
  await extract(db, id);
  assert.strictEqual(db.intake_sessions[0].match_status, "new_candidate");

  const res = await patch(db, { id: id, action: "set-client-match", matchedCustomerId: "dddddddd-dddd-dddd-dddd-dddddddddddd" });
  assert.strictEqual(res.statusCode, 200);
  const row = db.intake_sessions[0];
  assert.strictEqual(row.matched_customer_id, "dddddddd-dddd-dddd-dddd-dddddddddddd");
  assert.strictEqual(row.match_status, "existing_exact");
  assert.strictEqual(row.linked_existing_booking_id, null);
});

test("PATCH set-client-match: an unknown client id -> 404, nothing changed", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);
  const res = await patch(db, { id: id, action: "set-client-match", matchedCustomerId: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
  assert.strictEqual(res.statusCode, 404);
});

test("PATCH set-client-match: passing null clears the match to new_candidate", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture())); // matches cccc... exactly
  await extract(db, id);
  assert.strictEqual(db.intake_sessions[0].match_status, "existing_exact");

  const res = await patch(db, { id: id, action: "set-client-match", matchedCustomerId: null });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].matched_customer_id, null);
  assert.strictEqual(db.intake_sessions[0].match_status, "new_candidate");
});

// 10. PATCH ?action=link-existing-booking ------------------------------------
test("PATCH link-existing-booking: requires a resolved client match first", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings.push({ id: "11111111-1111-1111-1111-111111111111", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "booked", appointment_date: "2099-01-01", service_type: "junk_removal" });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const noMatch = extractionFixture();
  noMatch.fields.phone = { value: null, confidence: "missing", sourceIndex: null };
  fetchImpl = okFetch(openAiEnvelope(noMatch));
  await extract(db, id);

  const res = await patch(db, { id: id, action: "link-existing-booking", bookingId: "11111111-1111-1111-1111-111111111111" });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH link-existing-booking: rejects a booking that belongs to a different client", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings.push({ id: "11111111-1111-1111-1111-111111111111", customer_id: "dddddddd-dddd-dddd-dddd-dddddddddddd", status: "booked", appointment_date: "2099-01-01", service_type: "junk_removal" });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture())); // matches cccc...
  await extract(db, id);

  const res = await patch(db, { id: id, action: "link-existing-booking", bookingId: "11111111-1111-1111-1111-111111111111" });
  assert.strictEqual(res.statusCode, 400);
  // The fake insert() only stores the columns handleCreateSession actually
  // sets — a real Postgres row would read back NULL for an unset nullable
  // column, so this checks "unset or null" rather than asserting strict
  // null, which is a fake-row fidelity detail, not production behavior.
  assert.ok(db.intake_sessions[0].linked_existing_booking_id == null, "a rejected link must never actually write anything");
});

test("PATCH link-existing-booking: success links the booking; null clears it", async () => {
  adminAuthed();
  const db = freshDb();
  db.bookings.push({ id: "11111111-1111-1111-1111-111111111111", customer_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "booked", appointment_date: "2099-01-01", service_type: "junk_removal" });
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture()));
  await extract(db, id);

  const res = await patch(db, { id: id, action: "link-existing-booking", bookingId: "11111111-1111-1111-1111-111111111111" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].linked_existing_booking_id, "11111111-1111-1111-1111-111111111111");

  const res2 = await patch(db, { id: id, action: "link-existing-booking", bookingId: null });
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].linked_existing_booking_id, null);
});

// 11. PATCH ?action=remove-screenshot -----------------------------------------
test("PATCH remove-screenshot: deletes the row and its Storage object", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const screenshotId = db.intake_screenshots[0].id;
  const storagePath = db.intake_screenshots[0].storage_path;
  assert.ok(db.__storage["intake-screenshots"][storagePath]);

  const res = await patch(db, { id: id, action: "remove-screenshot", screenshotId: screenshotId });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.intake_screenshots.length, 0);
  assert.ok(!db.__storage["intake-screenshots"][storagePath], "the Storage object must be removed too");
});

test("PATCH remove-screenshot: refused once confirmed/discarded (simulated via discard)", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  const screenshotId = db.intake_screenshots[0].id;
  await patch(db, { id: id, action: "discard" });

  const res = await patch(db, { id: id, action: "remove-screenshot", screenshotId: screenshotId });
  assert.strictEqual(res.statusCode, 400);
});

// 12. PATCH ?action=discard -----------------------------------------------
test("PATCH discard: cleans up every screenshot (rows + Storage) and marks the session discarded", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  await uploadScreenshot(db, id);
  const res = await patch(db, { id: id, action: "discard" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.intake_sessions[0].status, "discarded");
  assert.strictEqual(db.intake_screenshots.length, 0);
  assert.strictEqual(Object.keys(db.__storage["intake-screenshots"]).length, 0);
});

test("PATCH discard: idempotent — discarding an already-discarded intake is a no-op success", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  await patch(db, { id: id, action: "discard" });
  const res = await patch(db, { id: id, action: "discard" });
  assert.strictEqual(res.statusCode, 200);
});

test("PATCH discard: a confirmed intake can never be discarded", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  db.intake_sessions[0].status = "confirmed"; // simulates a future Stage 5D outcome
  const res = await patch(db, { id: id, action: "discard" });
  assert.strictEqual(res.statusCode, 400);
});

// 13. Unknown action --------------------------------------------------------
test("PATCH with an unknown action -> 400", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  const res = await patch(db, { id: id, action: "confirm" }); // Stage 5D — not implemented here
  assert.strictEqual(res.statusCode, 400);
});

// 14. upload-screenshot: retry on UNIQUE(intake_session_id, sort_order)
//     violation (hardening pass) ---------------------------------------
test("upload-screenshot: a transient unique_violation (23505) on the sort_order insert is retried once and succeeds", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  db.__insertErrorOnce = { intake_screenshots: { code: "23505", message: "duplicate key value violates unique constraint" } };

  const res = await uploadScreenshot(db, id);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.intake_screenshots.length, 1, "exactly one row must exist after the retry succeeds — never zero, never two");
  assert.strictEqual(db.intake_screenshots[0].sort_order, 0);
});

test("upload-screenshot: a PERMANENT unique_violation (every attempt fails) still surfaces as a 500 and cleans up the orphaned Storage object", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  db.__insertError = { intake_screenshots: { code: "23505", message: "duplicate key value violates unique constraint" } };

  const res = await uploadScreenshot(db, id);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.intake_screenshots.length, 0);
  assert.strictEqual(Object.keys(db.__storage["intake-screenshots"] || {}).length, 0, "the uploaded Storage object must be rolled back when every insert attempt fails");
});

test("upload-screenshot: a non-unique-violation insert error is never retried — fails immediately", async () => {
  adminAuthed();
  const db = freshDb();
  const id = await createSession(db);
  db.__insertErrorOnce = { intake_screenshots: { code: "23503", message: "foreign key violation" } };

  const res = await uploadScreenshot(db, id);
  // A one-shot error that ISN'T a unique_violation must propagate as a
  // failure, not be silently retried past — the retry path narrowly checks
  // error.code === "23505" only.
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.intake_screenshots.length, 0);
});

// 15. ?action=cleanup-expired (Vercel Cron target, hardening pass) -----------
function cleanupRequest(db, overrides) {
  currentFakeService = createFakeServiceClient(db);
  const opts = Object.assign({ method: "GET", query: { action: "cleanup-expired" } }, overrides || {});
  return run(makeReq(opts));
}

const DAY_MS = 24 * 60 * 60 * 1000;

test("cleanup-expired: no CRON_SECRET configured -> 401, nothing touched, no admin session needed or used", async () => {
  delete process.env.CRON_SECRET;
  const db = freshDb();
  const res = await cleanupRequest(db);
  assert.strictEqual(res.statusCode, 401);
});

test("cleanup-expired: wrong bearer token -> 401, nothing touched", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const res = await cleanupRequest(db, { headers: { authorization: "Bearer wrong-value" } });
  assert.strictEqual(res.statusCode, 401);
  delete process.env.CRON_SECRET;
});

test("cleanup-expired: GET and POST are both accepted; any other method -> 405", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const authHeaders = { headers: { authorization: "Bearer test-cron-secret" } };
  const getRes = await cleanupRequest(db, Object.assign({ method: "GET" }, authHeaders));
  const postRes = await cleanupRequest(db, Object.assign({ method: "POST" }, authHeaders));
  const deleteRes = await cleanupRequest(db, Object.assign({ method: "DELETE" }, authHeaders));
  assert.strictEqual(getRes.statusCode, 200);
  assert.strictEqual(postRes.statusCode, 200);
  assert.strictEqual(deleteRes.statusCode, 405);
  delete process.env.CRON_SECRET;
});

test("cleanup-expired: removes screenshots for pending_review older than 7 days, leaves recent ones alone", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const oldId = await createSession(db);
  await uploadScreenshot(db, oldId);
  const oldStoragePath = db.intake_screenshots[0].storage_path;
  db.intake_sessions.find((s) => s.id === oldId).status = "pending_review";
  db.intake_sessions.find((s) => s.id === oldId).created_at = new Date(Date.now() - 8 * DAY_MS).toISOString();

  const recentId = await createSession(db);
  await uploadScreenshot(db, recentId);
  db.intake_sessions.find((s) => s.id === recentId).status = "pending_review";
  db.intake_sessions.find((s) => s.id === recentId).created_at = new Date(Date.now() - 1 * DAY_MS).toISOString();

  const res = await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.cleaned, 1);

  const remaining = db.intake_screenshots.map((s) => s.intake_session_id);
  assert.ok(!remaining.includes(oldId), "the 8-day-old session's screenshot must be gone");
  assert.ok(remaining.includes(recentId), "the 1-day-old session's screenshot must remain untouched");
  assert.ok(!db.__storage["intake-screenshots"][oldStoragePath], "the old session's Storage object must be removed too");

  const oldRow = db.intake_sessions.find((s) => s.id === oldId);
  assert.ok(oldRow.screenshots_expired_at, "must be marked with screenshots_expired_at");
  assert.strictEqual(oldRow.status, "pending_review", "status itself is untouched by expiry — only screenshots and the marker change");

  const recentRow = db.intake_sessions.find((s) => s.id === recentId);
  assert.ok(recentRow.screenshots_expired_at == null, "a recent session must not be marked expired");
});

test("cleanup-expired: retains extracted_data/classification/match state on an expired session — only screenshots are removed", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  fetchImpl = okFetch(openAiEnvelope(extractionFixture({ classification: "quote_discussion" })));
  await extract(db, id);
  const row = db.intake_sessions.find((r) => r.id === id);
  row.created_at = new Date(Date.now() - 10 * DAY_MS).toISOString();
  const extractedDataBefore = JSON.parse(JSON.stringify(row.extracted_data));

  await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });

  const after = db.intake_sessions.find((r) => r.id === id);
  assert.deepStrictEqual(after.extracted_data, extractedDataBefore, "extracted_data must survive screenshot expiry untouched");
  assert.strictEqual(after.classification, "quote_discussion");
  assert.strictEqual(after.status, "pending_review");
  assert.strictEqual(db.intake_screenshots.filter((s) => s.intake_session_id === id).length, 0);
});

test("cleanup-expired: never touches a discarded intake (already cleaned up immediately, for a different reason)", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const id = await createSession(db);
  db.intake_sessions.find((s) => s.id === id).created_at = new Date(Date.now() - 100 * DAY_MS).toISOString();
  await patch(db, { id: id, action: "discard" });

  const res = await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });
  assert.strictEqual(res.body.cleaned, 0);
  assert.strictEqual(db.intake_sessions.find((s) => s.id === id).screenshots_expired_at, undefined, "discard's own marker-less cleanup must not be re-marked by the sweep");
});

test("cleanup-expired: never re-processes an already-expired session (idempotent sweep)", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const id = await createSession(db);
  await uploadScreenshot(db, id);
  db.intake_sessions.find((s) => s.id === id).status = "pending_review";
  db.intake_sessions.find((s) => s.id === id).created_at = new Date(Date.now() - 30 * DAY_MS).toISOString();

  const res1 = await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });
  assert.strictEqual(res1.body.cleaned, 1);
  const res2 = await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });
  assert.strictEqual(res2.body.cleaned, 0, "a session already marked screenshots_expired_at must not be swept again");
});

test("cleanup-expired: a confirmed session older than 30 days is swept; one older than 7 but under 30 days is not (different window than pending)", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  const db = freshDb();
  const youngConfirmedId = await createSession(db);
  await uploadScreenshot(db, youngConfirmedId);
  db.intake_sessions.find((s) => s.id === youngConfirmedId).status = "confirmed"; // simulates a future Stage 5D outcome
  db.intake_sessions.find((s) => s.id === youngConfirmedId).created_at = new Date(Date.now() - 15 * DAY_MS).toISOString();

  const oldConfirmedId = await createSession(db);
  await uploadScreenshot(db, oldConfirmedId);
  db.intake_sessions.find((s) => s.id === oldConfirmedId).status = "confirmed";
  db.intake_sessions.find((s) => s.id === oldConfirmedId).created_at = new Date(Date.now() - 31 * DAY_MS).toISOString();

  const res = await cleanupRequest(db, { headers: { authorization: "Bearer test-cron-secret" } });
  assert.strictEqual(res.body.cleaned, 1);
  assert.ok(db.intake_screenshots.some((s) => s.intake_session_id === youngConfirmedId), "15-day-old confirmed session must be untouched (30-day window, not 7)");
  assert.ok(!db.intake_screenshots.some((s) => s.intake_session_id === oldConfirmedId), "31-day-old confirmed session must be swept");
});

test("cleanup-expired: requireAdmin's session machinery is never invoked — an admin cookie alone (no CRON_SECRET header) is not sufficient", async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { action: "cleanup-expired" } }));
  assert.strictEqual(res.statusCode, 401, "an admin cookie must not substitute for the CRON_SECRET bearer token");
  delete process.env.CRON_SECRET;
});

// 16. THE critical guarantee: no customer/booking table write ----------------
test("api/admin/intake.js never writes to customers or bookings — read-only access to both tables", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/admin/intake.js"), "utf8");
  const writeVerbs = /\.(insert|update|upsert|delete)\s*\(/;
  const fromCallRe = /\.from\((["'])(customers|bookings)\1\)/g;
  let m;
  let checked = 0;
  while ((m = fromCallRe.exec(src))) {
    checked += 1;
    const afterIdx = m.index + m[0].length;
    const nextSemicolon = src.indexOf(";", afterIdx);
    const chain = src.slice(afterIdx, nextSemicolon === -1 ? src.length : nextSemicolon);
    assert.ok(!writeVerbs.test(chain), "a .from(\"" + m[2] + "\") chain contains a write call: " + chain.slice(0, 120));
  }
  assert.ok(checked >= 4, "expected several .from(\"customers\"/\"bookings\") read sites to actually be checked, found " + checked);
});

test("write-audit: intake.js's write calls are only ever against intake_sessions/intake_screenshots", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api/admin/intake.js"), "utf8");
  const writeCallRe = /\.(insert|update|upsert|delete)\s*\(/g;
  const count = (src.match(writeCallRe) || []).length;
  // Hardening pass added exactly one more .update( — handleCleanupExpired()'s
  // screenshots_expired_at/updated_at write. insert/delete counts are
  // unchanged (insertScreenshotWithRetry()/cleanupSessionScreenshots() each
  // still have exactly one literal .insert(/.delete( call apiece, just
  // extracted into shared helpers — handleDiscard() lost its own inline
  // .delete( when it started calling cleanupSessionScreenshots() instead).
  assert.strictEqual(count, 12, "expected exactly 12 write calls (2 insert, 8 update, 2 delete) — see docs/phase-3/batch5-screenshot-intake-proposal.md; a new one needs deliberate review");
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
