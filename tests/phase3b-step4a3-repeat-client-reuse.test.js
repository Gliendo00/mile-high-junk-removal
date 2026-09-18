// Local, offline test harness for Phase 3B Step 4a.3 — conservative
// repeat-client reuse in api/book.js.
//
// This never touches the real network or the production Supabase
// project. Same interception approach as tests/phase1-api.test.js and
// tests/phase3b-step4a2-customer-identity.test.js: "@supabase/supabase-js"
// is replaced at require-time with an in-memory fake, and global.fetch is
// stubbed so the Resend notification path never makes a real request.
//
// Scope, matching Step 4a.3 exactly: this file proves the exact-combined-
// phone+email reuse rule, that every other case still creates a new
// customer, that a reused customer's id can never reach a rollback
// delete, and that the public response never reveals which branch ran.
// It does not touch matching/reuse for anything beyond what Step 4a.3
// implements (no phone-only/email-only/fuzzy/name/address matching
// exists to test, because none of it exists in the code).
//
// Run with:  node tests/phase3b-step4a3-repeat-client-reuse.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// --- fake Supabase --------------------------------------------------------
let currentFakeSupabase = null;

// opts:
//   seedCustomers: [{ id, phone_normalized, email_normalized }] — rows the
//     repeat-client lookup can match against.
//   lookupError: a Supabase-style { message } object — the lookup resolves
//     with { data: null, error: lookupError }.
//   lookupThrows: true — the lookup rejects/throws instead.
//   failOn: "customers" | "bookings" | "dumpster_rentals" — that table's
//     insert fails.
function createFakeSupabase(opts) {
  opts = opts || {};
  const calls = [];
  const seedCustomers = opts.seedCustomers || [];
  const NEW_CUSTOMER_ID = "mock-new-customer-id";
  const idByTable = { customers: NEW_CUSTOMER_ID, bookings: "mock-booking-id" };

  function insertBuilder(table, payload) {
    calls.push({ table: table, op: "insert", payload: payload });
    const shouldFail = opts.failOn === table;
    return {
      select: function () {
        return {
          single: function () {
            if (shouldFail) return Promise.resolve({ data: null, error: { message: "mock insert failure for " + table } });
            return Promise.resolve({ data: { id: idByTable[table] || "mock-id" }, error: null });
          },
        };
      },
      then: function (resolve, reject) {
        const result = shouldFail ? { error: { message: "mock insert failure for " + table } } : { error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  function deleteBuilder(table) {
    return {
      eq: function (col, val) {
        calls.push({ table: table, op: "delete", id: val });
        return Promise.resolve({ error: null });
      },
    };
  }

  // from("customers").select("id").eq("phone_normalized", x).eq("email_normalized", y)
  function customersSelectBuilder() {
    const filters = {};
    const builder = {
      eq: function (col, val) {
        filters[col] = val;
        return builder;
      },
      then: function (resolve, reject) {
        calls.push({ table: "customers", op: "select", filters: Object.assign({}, filters) });
        if (opts.lookupThrows) {
          return Promise.reject(new Error("mock lookup network failure")).then(resolve, reject);
        }
        if (opts.lookupError) {
          return Promise.resolve({ data: null, error: opts.lookupError }).then(resolve, reject);
        }
        const matches = seedCustomers.filter(function (c) {
          return c.phone_normalized === filters.phone_normalized && c.email_normalized === filters.email_normalized;
        });
        return Promise.resolve({ data: matches.map(function (c) { return { id: c.id }; }), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    calls: calls,
    NEW_CUSTOMER_ID: NEW_CUSTOMER_ID,
    from: function (table) {
      return {
        insert: function (payload) {
          return insertBuilder(table, payload);
        },
        select: function () {
          if (table === "customers") return customersSelectBuilder();
          return { eq: function () { return Promise.resolve({ data: [], error: null }); } };
        },
        delete: function () {
          return deleteBuilder(table);
        },
      };
    },
  };
}

// --- fake Stripe -----------------------------------------------------------
// This file's dumpster-rental tests are specifically about the
// customer-reuse/rollback rules (they predate the payment feature and were
// originally written against the pre-payment flow) — every scenario they
// test fails at or after the dumpster_rentals insert, never at capture, so
// this fake only needs to make paymentIntents.retrieve() return a
// plausible authorized-but-uncaptured intent (matching whatever
// idempotencyKey the test's own payload used) and paymentIntents.cancel()
// a harmless no-op for the rollback path. capture() is never expected to
// be called by anything in this file.
const fakeStripeClient = {
  paymentIntents: {
    retrieve: function (id) {
      // Test fixtures always pair paymentIntentId "pi_testN" with
      // idempotencyKey "test-idem-key-N" (same counter N) — see
      // validDumpsterPayload() below — so the matching idempotencyKey can
      // be reconstructed directly from the id, no separate lookup table
      // needed for this file's narrow scope.
      const match = /^pi_test(\d+)$/.exec(String(id));
      const idempotencyKey = match ? "test-idem-key-" + match[1] : "unknown";
      return Promise.resolve({ id: id, status: "requires_capture", amount: 34900, currency: "usd", customer: "cus_test_" + idempotencyKey, metadata: { idempotencyKey: idempotencyKey, serviceType: "dumpster_rental" } });
    },
    update: function () {
      return Promise.resolve({});
    },
    cancel: function () {
      return Promise.resolve({});
    },
    capture: function () {
      return Promise.reject(new Error("capture() should never be called in this test file's scenarios"));
    },
  },
};

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return { createClient: function () { return currentFakeSupabase; } };
    }
    if (request === "stripe") {
      return function FakeStripe() {
        return fakeStripeClient;
      };
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
process.env.STRIPE_SECRET_KEY = "sk_test_mock";

const bookHandler = require("../api/book.js");
const { normalizePhone, normalizeEmail } = require("../api/_lib/customer-identity");

// --- tiny req/res mocks (same shape as the other test files) ------------
function makeReq(body, ipOverride) {
  const json = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-forwarded-for": ipOverride || "203.0.113.60",
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

const PICKUP_DATE = (function () {
  const d = new Date(FAR_FUTURE_DATE);
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
})();

function baseCustomer(overrides) {
  return Object.assign(
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
    overrides || {}
  );
}

function validPayload(customerOverrides) {
  return {
    serviceType: "junk_removal",
    hp: "",
    elapsedMs: 10000,
    jobDetails: { itemsDescription: "Old couch", location: "Garage", stairs: "none", additionalDetails: "" },
    schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
    customer: baseCustomer(customerOverrides),
  };
}

// Phase 3C Stage 2.5-v2: dumpster_rental now requires a `payment` object
// (see api/book.js's validateBooking()). This file's own dumpster-rental
// tests below are specifically about the customer-reuse/rollback rules
// (they predate the payment feature and were originally written against
// the pre-payment flow) — they never reach the Braintree call in either
// failing case they test (both fail earlier, at the dumpster_rentals
// insert), so no fake Braintree gateway is needed here. Each call gets its
// own idempotencyKey purely for realism; the fake Supabase's per-test-case
// fresh instance already isolates them regardless.
let dumpsterIdempotencyCounter = 0;
function validDumpsterPayload(customerOverrides) {
  dumpsterIdempotencyCounter += 1;
  return {
    serviceType: "dumpster_rental",
    hp: "",
    elapsedMs: 10000,
    jobDetails: {
      materialType: "Household junk",
      deliveryDate: FAR_FUTURE_DATE,
      pickupDate: PICKUP_DATE,
      placementLocation: "Driveway",
      additionalDetails: "",
    },
    schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
    customer: baseCustomer(customerOverrides),
    payment: { paymentIntentId: "pi_test" + dumpsterIdempotencyCounter, idempotencyKey: "test-idem-key-" + dumpsterIdempotencyCounter, agreementAccepted: true },
  };
}

function seedFor(customerOverrides, id) {
  const c = baseCustomer(customerOverrides);
  return { id: id || "existing-customer-1", phone_normalized: normalizePhone(c.phone), email_normalized: normalizeEmail(c.email) };
}

// --- test registry --------------------------------------------------------
const registered = [];
function test(name, fn) { registered.push({ name: name, fn: fn }); }

async function main() {
  test("book: exact unique phone+email match reuses the existing customer", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")] });
    const res = await run(makeReq(validPayload(), "203.0.113.61"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.strictEqual(inserts.length, 1, "expected exactly 1 insert (bookings only) — no new customer created");
    assert.strictEqual(inserts[0].table, "bookings");
    assert.strictEqual(inserts[0].payload.customer_id, "existing-customer-1");
    const lookups = currentFakeSupabase.calls.filter(function (c) { return c.op === "select" && c.table === "customers"; });
    assert.strictEqual(lookups.length, 1, "expected exactly one combined-match lookup");
  });

  test("book: no email submitted skips the lookup entirely and creates a new customer", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")] });
    const res = await run(makeReq(validPayload({ email: "" }), "203.0.113.62"));
    assert.strictEqual(res.statusCode, 200);
    const lookups = currentFakeSupabase.calls.filter(function (c) { return c.op === "select" && c.table === "customers"; });
    assert.strictEqual(lookups.length, 0, "no email submitted -> the lookup must never run");
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
  });

  test("book: zero matches creates a new customer", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({ phone: "303-555-9999", email: "nobody@example.com" }, "existing-customer-9")] });
    const res = await run(makeReq(validPayload(), "203.0.113.63"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
    assert.strictEqual(inserts[1].payload.customer_id, currentFakeSupabase.NEW_CUSTOMER_ID);
  });

  test("book: multiple exact matches creates a new customer, never guesses", async function () {
    currentFakeSupabase = createFakeSupabase({
      seedCustomers: [seedFor({}, "existing-customer-1"), seedFor({}, "existing-customer-2")],
    });
    const res = await run(makeReq(validPayload(), "203.0.113.64"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
    assert.strictEqual(inserts[1].payload.customer_id, currentFakeSupabase.NEW_CUSTOMER_ID);
  });

  test("book: phone matches but email differs -> new customer (no partial match)", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({ email: "someoneelse@example.com" }, "existing-customer-1")] });
    const res = await run(makeReq(validPayload(), "203.0.113.65"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
  });

  test("book: email matches but phone differs -> new customer (no partial match)", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({ phone: "303-555-2222" }, "existing-customer-1")] });
    const res = await run(makeReq(validPayload(), "203.0.113.66"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
  });

  test("book: lookup returns a Supabase error -> falls open to a new customer, booking still succeeds", async function () {
    currentFakeSupabase = createFakeSupabase({ lookupError: { message: "mock lookup error" } });
    const res = await run(makeReq(validPayload(), "203.0.113.67"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
  });

  test("book: lookup throws -> falls open to a new customer, booking still succeeds", async function () {
    currentFakeSupabase = createFakeSupabase({ lookupThrows: true });
    const res = await run(makeReq(validPayload(), "203.0.113.68"));
    assert.strictEqual(res.statusCode, 200);
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.deepStrictEqual(inserts.map(function (i) { return i.table; }), ["customers", "bookings"]);
  });

  test("book: reused customer is NEVER deleted when the booking insert fails", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")], failOn: "bookings" });
    const res = await run(makeReq(validPayload(), "203.0.113.69"));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, "Could not submit your booking. Please try again or call us.", "the existing generic failure message must be unchanged");
    const deletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete"; });
    assert.deepStrictEqual(deletes, [], "no delete of any kind should occur — the customer was reused, not created, and nothing else was created before the failure");
  });

  test("book: reused customer is NEVER deleted when the dumpster_rentals insert fails", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")], failOn: "dumpster_rentals" });
    const res = await run(makeReq(validDumpsterPayload(), "203.0.113.70"));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, "Could not submit your booking. Please try again or call us.", "the existing generic failure message must be unchanged");
    const customerDeletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete" && c.table === "customers"; });
    assert.deepStrictEqual(customerDeletes, [], "the reused customer must never be deleted");
    const bookingDeletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete" && c.table === "bookings"; });
    assert.strictEqual(bookingDeletes.length, 1, "the booking created by THIS request should still be rolled back");
  });

  test("book: newly-created customer still gets rollback cleanup when the booking insert fails", async function () {
    currentFakeSupabase = createFakeSupabase({ failOn: "bookings" });
    const res = await run(makeReq(validPayload(), "203.0.113.71"));
    assert.strictEqual(res.statusCode, 500);
    const customerDeletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete" && c.table === "customers"; });
    assert.strictEqual(customerDeletes.length, 1);
    assert.strictEqual(customerDeletes[0].id, currentFakeSupabase.NEW_CUSTOMER_ID);
  });

  test("book: newly-created customer still gets rollback cleanup when the dumpster_rentals insert fails", async function () {
    currentFakeSupabase = createFakeSupabase({ failOn: "dumpster_rentals" });
    const res = await run(makeReq(validDumpsterPayload(), "203.0.113.72"));
    assert.strictEqual(res.statusCode, 500);
    const customerDeletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete" && c.table === "customers"; });
    assert.strictEqual(customerDeletes.length, 1);
    assert.strictEqual(customerDeletes[0].id, currentFakeSupabase.NEW_CUSTOMER_ID);
    const bookingDeletes = currentFakeSupabase.calls.filter(function (c) { return c.op === "delete" && c.table === "bookings"; });
    assert.strictEqual(bookingDeletes.length, 1);
  });

  test("book: service-address snapshot on reuse comes from the CURRENT submission, never the existing customer", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")] });
    const payload = validPayload({ streetAddress: "999 New Job Ave", city: "Aurora", state: "CO", zip: "80010" });
    const res = await run(makeReq(payload, "203.0.113.73"));
    assert.strictEqual(res.statusCode, 200);
    const bookingInsert = currentFakeSupabase.calls.find(function (c) { return c.table === "bookings"; });
    assert.strictEqual(bookingInsert.payload.customer_id, "existing-customer-1");
    assert.strictEqual(bookingInsert.payload.service_address, "999 New Job Ave");
    assert.strictEqual(bookingInsert.payload.service_city, "Aurora");
    assert.strictEqual(bookingInsert.payload.service_state, "CO");
    assert.strictEqual(bookingInsert.payload.service_zip, "80010");
  });

  test("book: public response shape is identical whether reuse occurred or a new customer was created", async function () {
    currentFakeSupabase = createFakeSupabase({ seedCustomers: [seedFor({}, "existing-customer-1")] });
    const reuseRes = await run(makeReq(validPayload(), "203.0.113.74"));

    currentFakeSupabase = createFakeSupabase(); // no seed data -> guaranteed new customer
    const newRes = await run(makeReq(validPayload({ phone: "303-555-8888", email: "different@example.com" }), "203.0.113.75"));

    assert.strictEqual(reuseRes.statusCode, 200);
    assert.strictEqual(newRes.statusCode, 200);
    assert.deepStrictEqual(Object.keys(reuseRes.body).sort(), Object.keys(newRes.body).sort(), "response keys must match regardless of reuse");
    assert.strictEqual(reuseRes.body.ok, true);
    assert.strictEqual(newRes.body.ok, true);
    assert.strictEqual(typeof reuseRes.body.uploadToken, "string");
    assert.strictEqual(typeof newRes.body.uploadToken, "string");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(reuseRes.body, "customerId"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(newRes.body, "customerId"), false);
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
