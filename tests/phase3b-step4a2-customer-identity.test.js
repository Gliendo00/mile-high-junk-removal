// Local, offline test harness for Phase 3B Step 4a.2 — the shared
// normalization helper (api/_lib/customer-identity.js) and its use in
// api/book.js's customer INSERT.
//
// This never touches the real network or the production Supabase
// project. Same interception approach as tests/phase1-api.test.js:
// "@supabase/supabase-js" is replaced at require-time with an in-memory
// fake that records every call, and global.fetch is stubbed so the
// Resend notification path never makes a real request.
//
// Scope, matching Step 4a.2 exactly: this file proves (a) the
// normalization functions themselves are correct in isolation, and (b)
// api/book.js writes their output onto the customer INSERT it already
// performs today, with no new query and no behavior change beyond that.
// It does not test any matching/reuse logic — that doesn't exist yet.
//
// Run with:  node tests/phase3b-step4a2-customer-identity.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// --- pure-function tests: no Supabase/network involved at all ----------
const { normalizePhone, normalizeEmail } = require("../api/_lib/customer-identity");

// --- fake Supabase (book.js integration tests) --------------------------
let currentFakeSupabase = null;

function createFakeSupabase() {
  const calls = [];
  const idByTable = { customers: "mock-customer-id", bookings: "mock-booking-id" };

  function insertBuilder(table, payload) {
    calls.push({ table: table, op: "insert", payload: payload });
    const chain = {
      select: function () {
        return {
          single: function () {
            return Promise.resolve({ data: { id: idByTable[table] || "mock-id" }, error: null });
          },
        };
      },
      then: function (resolve, reject) {
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    calls: calls,
    from: function (table) {
      return {
        insert: function (payload) {
          return insertBuilder(table, payload);
        },
        delete: function () {
          return { eq: function () { return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
}

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return { createClient: function () { return currentFakeSupabase; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

// --- fake fetch (Resend) -------------------------------------------------
global.fetch = function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ id: "mock-resend-id" }); }, text: function () { return Promise.resolve("{}"); } });
};

// --- env required for book.js to consider itself "configured" ----------
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.UPLOAD_TOKEN_SECRET = "mock-upload-token-secret";

const bookHandler = require("../api/book.js");

// --- tiny req/res mocks (same shape as phase1-api.test.js) --------------
function makeReq(body, ipOverride) {
  const json = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-forwarded-for": ipOverride || "203.0.113.50",
    },
    body: body,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) { res.body = obj; return res; };
  return res;
}

function run(req) {
  const res = makeRes();
  return Promise.resolve(bookHandler(req, res)).then(function () { return res; });
}

const FAR_FUTURE_DATE = (function () {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
})();

function validPayload(customerOverrides) {
  return {
    serviceType: "junk_removal",
    hp: "",
    elapsedMs: 10000,
    jobDetails: { itemsDescription: "Old couch", location: "Garage", stairs: "none", additionalDetails: "" },
    schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
    customer: Object.assign(
      {
        firstName: "Jamie",
        lastName: "Rivera",
        phone: "303-555-0100",
        email: "jamie@example.com",
        streetAddress: "123 Main St",
        city: "Denver",
        state: "CO",
        zip: "80202",
      },
      customerOverrides || {}
    ),
  };
}

async function customerInsertFor(customerOverrides, ip) {
  currentFakeSupabase = createFakeSupabase();
  const res = await run(makeReq(validPayload(customerOverrides), ip));
  assert.strictEqual(res.statusCode, 200, "booking should succeed: " + JSON.stringify(res.body));
  const insert = currentFakeSupabase.calls.find(function (c) { return c.table === "customers"; });
  assert.ok(insert, "expected a customers insert");
  return insert.payload;
}

// --- test registry --------------------------------------------------------
const registered = [];
function test(name, fn) { registered.push({ name: name, fn: fn }); }

async function main() {
  // --- normalizePhone: pure-function cases -------------------------------
  test("normalizePhone: formatted 10-digit US phone", function () {
    assert.strictEqual(normalizePhone("(303) 555-0100"), "3035550100");
  });

  test("normalizePhone: plain 10-digit phone", function () {
    assert.strictEqual(normalizePhone("3035550100"), "3035550100");
  });

  test("normalizePhone: +1 / 11-digit US phone strips the leading 1", function () {
    assert.strictEqual(normalizePhone("+1 303-555-0100"), "3035550100");
    assert.strictEqual(normalizePhone("13035550100"), "3035550100");
  });

  test("normalizePhone: whitespace/punctuation variants all collapse to the same digits", function () {
    assert.strictEqual(normalizePhone("  303.555.0100  "), "3035550100");
    assert.strictEqual(normalizePhone("303 555 0100"), "3035550100");
  });

  test("normalizePhone: an 11-digit number NOT starting with 1 is left as-is (no assumption made)", function () {
    assert.strictEqual(normalizePhone("23035550100"), "23035550100");
  });

  test("normalizePhone: empty/missing input never throws", function () {
    assert.strictEqual(normalizePhone(""), "");
    assert.strictEqual(normalizePhone(null), "");
    assert.strictEqual(normalizePhone(undefined), "");
  });

  // --- normalizeEmail: pure-function cases --------------------------------
  test("normalizeEmail: mixed case is lowercased", function () {
    assert.strictEqual(normalizeEmail("Jamie@Example.COM"), "jamie@example.com");
  });

  test("normalizeEmail: surrounding whitespace is trimmed", function () {
    assert.strictEqual(normalizeEmail("  jamie@example.com  "), "jamie@example.com");
  });

  test("normalizeEmail: missing/empty email normalizes to null, not an empty string", function () {
    assert.strictEqual(normalizeEmail(""), null);
    assert.strictEqual(normalizeEmail(null), null);
    assert.strictEqual(normalizeEmail(undefined), null);
    assert.strictEqual(normalizeEmail("   "), null);
  });

  // --- api/book.js integration: values land on the actual customer insert ---
  test("book: customer insert includes phone_normalized/email_normalized for a normal submission", async function () {
    const payload = await customerInsertFor({ phone: "(303) 555-0100", email: "Jamie@Example.COM" }, "203.0.113.51");
    assert.strictEqual(payload.phone_normalized, "3035550100");
    assert.strictEqual(payload.email_normalized, "jamie@example.com");
    // Unchanged existing fields — this step must not touch anything else
    // on the insert.
    assert.strictEqual(payload.phone, "(303) 555-0100");
    assert.strictEqual(payload.email, "Jamie@Example.COM");
  });

  test("book: customer insert includes email_normalized = null when no email is submitted", async function () {
    const payload = await customerInsertFor({ email: "" }, "203.0.113.52");
    assert.strictEqual(payload.email, null, "sanity check: existing behavior already stores null for a missing email");
    assert.strictEqual(payload.email_normalized, null);
    assert.ok(payload.phone_normalized, "phone is required, so phone_normalized should still be populated");
  });

  test("book: customer insert normalizes an 11-digit +1 phone", async function () {
    const payload = await customerInsertFor({ phone: "+13035550100" }, "203.0.113.53");
    assert.strictEqual(payload.phone_normalized, "3035550100");
  });

  test("book: exactly one customers insert and one bookings insert still occur — no new query added", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(makeReq(validPayload(), "203.0.113.54"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.strictEqual(inserts.length, 2, "expected exactly 2 inserts (customers, bookings) — no lookup/select added in this step");
    assert.strictEqual(inserts[0].table, "customers");
    assert.strictEqual(inserts[1].table, "bookings");
  });

  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.message ? err.message : err));
      settled.push({ name: t.name, ok: false, error: err });
    }
  }

  const failed = settled.filter(function (r) { return !r.ok; });
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) {
    process.exitCode = 1;
  }
}

main();
