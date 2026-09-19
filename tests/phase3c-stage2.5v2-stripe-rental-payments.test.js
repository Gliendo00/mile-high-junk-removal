// Local, offline test harness for Phase 3C Stage 2.5-v2 — dumpster rental
// real booking + Stripe payments. See
// docs/phase-3/stage2.5-stripe-rental-payments-migration.md for the full
// design this exercises. This feature was originally built on Braintree
// (tests/phase3c-stage2.5v2-rental-payments.test.js, preserved on branch
// phase-3c/stage2.5-rental-payments-v2 as a fallback/reference) and
// switched to Stripe before any production rollout, staging deployment, or
// real transaction of any kind.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake — the
// fake's insert() also simulates the two real database constraints this
// stage's SQL migration adds (the partial unique index on
// bookings(appointment_date, time_window) for booked dumpster rentals, and
// rental_payments.idempotency_key's UNIQUE constraint) — never the real
// network, never the production Supabase project. "stripe" is intercepted
// the same way, with a swappable fake paymentIntents.create/retrieve/
// update/capture/cancel + webhooks.constructEvent implementation per test.
//
// Run with:  node tests/phase3c-stage2.5v2-stripe-rental-payments.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

// Simulates the two real DB constraints this stage's migration adds.
// Returns { error } to short-circuit the insert, or null to allow it.
function checkInsertConstraints(table, payload, existingRows) {
  if (table === "bookings" && payload.service_type === "dumpster_rental" && payload.status === "booked") {
    const collision = existingRows.some(
      (r) => r.service_type === "dumpster_rental" && r.status === "booked" && r.appointment_date === payload.appointment_date && r.time_window === payload.time_window
    );
    if (collision) {
      return { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_bookings_dumpster_delivery_slot"' } };
    }
  }
  if (table === "rental_payments" && payload.idempotency_key) {
    const collision = existingRows.some((r) => r.idempotency_key === payload.idempotency_key);
    if (collision) {
      return { error: { code: "23505", message: "duplicate key value violates unique constraint on rental_payments.idempotency_key" } };
    }
  }
  return null;
}

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.filters = [];
    this.notFilters = [];
    this.rangeFilters = [];
    this._order = null;
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._deleteMode = false;
    this._single = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.filters.push({ col: col, val: val });
    return this;
  }
  in(col, values) {
    const set = new Set(values);
    this.filters.push({ col: col, in: set });
    return this;
  }
  not(col, op, val) {
    this.notFilters.push({ col: col, op: op, val: val });
    return this;
  }
  gte(col, val) {
    this.rangeFilters.push({ col: col, val: val, op: "gte" });
    return this;
  }
  lte(col, val) {
    this.rangeFilters.push({ col: col, val: val, op: "lte" });
    return this;
  }
  order(col, opts) {
    this._order = { col: col, asc: !opts || opts.ascending !== false };
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
  delete() {
    this._deleteMode = true;
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
      const constraint = checkInsertConstraints(this.table, this._insertPayload, rows);
      if (constraint) return { data: null, error: constraint.error };
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter(
      (r) =>
        this.filters.every((f) => (f.in ? f.in.has(r[f.col]) : r[f.col] === f.val)) &&
        this.notFilters.every((f) => (f.op === "eq" ? r[f.col] !== f.val : true)) &&
        this.rangeFilters.every((f) => (f.op === "gte" ? r[f.col] >= f.val : r[f.col] <= f.val))
    );

    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
      return { data: matched, error: null };
    }

    if (this._deleteMode) {
      const toDelete = new Set(matched);
      this.db[this.table] = rows.filter((r) => !toDelete.has(r));
      return { data: null, error: null };
    }

    if (this._order) {
      const col = this._order.col;
      const asc = this._order.asc;
      matched = matched.slice().sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this._limit != null) {
      matched = matched.slice(0, this._limit);
    }

    if (this._single === "maybeSingle") {
      if (matched.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: matched[0] || null, error: null };
    }
    if (this._single === "single") {
      return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows returned for single" } };
    }
    return { data: matched, error: null };
  }
}

let currentDb = null;
function freshDb() {
  currentDb = { customers: [], bookings: [], dumpster_rentals: [], rental_payments: [], rental_additional_charges: [] };
  currentFakeService = createFakeServiceClient(currentDb);
  return currentDb;
}

function createFakeServiceClient(db) {
  return {
    from: function (table) {
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

// ---------------------------------------------------------------------
// Fake Stripe — one client object whose method bodies delegate to
// swappable module-level implementations/logs, reset per test via
// resetStripe(). This lets `new Stripe(secretKey)` (called fresh inside
// getStripeClient() on every request, matching real serverless-function
// statelessness) always return an object backed by whatever this test
// currently wants it to do. `intentStore`/`customerStore` persist real
// mutable state across calls WITHIN one test (mirroring how a real
// PaymentIntent's status genuinely changes across create -> capture), reset
// fresh by resetStripe() between tests.
// ---------------------------------------------------------------------
let intentStore = {};
let createIntentCallLog = [];
let confirmChargeCallLog = []; // admin off-session create+confirm calls (params.confirm === true)
let captureCallLog = [];
let cancelCallLog = [];
let updateCallLog = [];
let createIntentImpl = null; // (params, options) => intent | throws — override for the initial-checkout create() call
let captureImpl = null; // (id, params, options) => intent | throws
let confirmChargeImpl = null; // (params, options) => intent | throws — the admin off-session create+confirm call
let webhookConstructImpl = null; // (rawBody, sig, secret) => event | throws

// At least 5 characters after the prefix — api/book.js's validateBooking()
// requires a real-Stripe-shaped id (/^pi_[A-Za-z0-9_]{5,95}$/), and a plain
// counter like "pi_1" would fail that length check for the first several
// dozen ids generated in this file.
function makeStripeId(prefix) {
  return prefix + "_test" + String(nextId++).padStart(6, "0");
}

// A default successful card PaymentMethod shape, matching what Stripe's
// `expand: ["payment_method"]` returns on a captured PaymentIntent.
function defaultPaymentMethod(id) {
  return { id: id || makeStripeId("pm"), card: { brand: "visa", last4: "4242" } };
}

function stripeCardError(code, message) {
  const err = new Error(message || "Your card was declined.");
  err.type = "StripeCardError";
  err.code = code || "card_declined";
  return err;
}

function stripeAuthenticationRequiredError(paymentIntentId) {
  const err = stripeCardError("authentication_required", "This payment requires additional authentication.");
  err.raw = { payment_intent: { id: paymentIntentId || makeStripeId("pi") } };
  return err;
}

function stripeAmbiguousError() {
  const err = new Error("ECONNRESET");
  // Deliberately no `.type` — mirrors a raw network/timeout error, never a
  // StripeCardError, so the code under test must treat it as ambiguous.
  return err;
}

const fakeStripeClient = {
  customers: {
    create: async function (params) {
      const id = makeStripeId("cus");
      return { id: id, email: params && params.email, name: params && params.name, phone: params && params.phone };
    },
  },
  paymentIntents: {
    create: async function (params, options) {
      if (params && params.confirm === true) {
        confirmChargeCallLog.push({ params: params, options: options });
        if (confirmChargeImpl) return confirmChargeImpl(params, options);
        const id = makeStripeId("pi");
        const intent = { id: id, status: "succeeded", amount: params.amount, currency: params.currency, customer: params.customer, metadata: params.metadata || {}, payment_method: params.payment_method };
        intentStore[id] = intent;
        return intent;
      }
      createIntentCallLog.push({ params: params, options: options });
      if (createIntentImpl) return createIntentImpl(params, options);
      const id = makeStripeId("pi");
      const intent = { id: id, client_secret: id + "_secret", status: "requires_capture", amount: params.amount, currency: params.currency, customer: params.customer, metadata: Object.assign({}, params.metadata) };
      intentStore[id] = intent;
      return intent;
    },
    retrieve: async function (id) {
      const intent = intentStore[id];
      if (!intent) throw new Error("No such PaymentIntent: " + id);
      return intent;
    },
    update: async function (id, params) {
      updateCallLog.push({ id: id, params: params });
      const intent = intentStore[id];
      if (!intent) throw new Error("No such PaymentIntent: " + id);
      if (params && params.metadata) Object.assign(intent.metadata, params.metadata);
      return intent;
    },
    capture: async function (id, params, options) {
      captureCallLog.push({ id: id, params: params, options: options });
      if (captureImpl) return captureImpl(id, params, options);
      const intent = intentStore[id];
      if (!intent) throw new Error("No such PaymentIntent: " + id);
      intent.status = "succeeded";
      intent.payment_method = defaultPaymentMethod();
      return intent;
    },
    cancel: async function (id) {
      cancelCallLog.push(id);
      const intent = intentStore[id];
      if (intent) intent.status = "canceled";
      return intent || { id: id, status: "canceled" };
    },
  },
  webhooks: {
    constructEvent: function (rawBody, sig, secret) {
      if (webhookConstructImpl) return webhookConstructImpl(rawBody, sig, secret);
      throw new Error("webhooks.constructEvent not configured in this test");
    },
  },
};

function resetStripe() {
  intentStore = {};
  createIntentCallLog = [];
  confirmChargeCallLog = [];
  captureCallLog = [];
  cancelCallLog = [];
  updateCallLog = [];
  createIntentImpl = null;
  captureImpl = null;
  confirmChargeImpl = null;
  webhookConstructImpl = null;
}

// Seeds an already-authorized (capture_method: manual, status:
// requires_capture) PaymentIntent directly into the fake's store — a
// stand-in for "the browser already called POST ?resource=payment-intent
// and confirmed it via Stripe.js", the same way the Braintree-era file used
// a fixed nonce string as a stand-in for "Drop-in already tokenized a
// card." Dedicated tests further down exercise
// handleCreatePaymentIntent() itself directly.
function seedAuthorizedIntent(idempotencyKey, overrides) {
  const id = makeStripeId("pi");
  const intent = Object.assign(
    {
      id: id,
      client_secret: id + "_secret",
      status: "requires_capture",
      amount: 34900,
      currency: "usd",
      customer: makeStripeId("cus"),
      metadata: { idempotencyKey: idempotencyKey, serviceType: "dumpster_rental" },
    },
    overrides || {}
  );
  intentStore[id] = intent;
  return intent;
}

function interceptModules() {
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
    if (request === "stripe") {
      return function FakeStripe() {
        return fakeStripeClient;
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptModules();

// --- fake fetch (Resend notification email) ------------------------------
let fetchCalls = [];
global.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ id: "mock-resend-id" }); }, text: function () { return Promise.resolve("{}"); } });
};

// --- env ------------------------------------------------------------------
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.UPLOAD_TOKEN_SECRET = "mock-upload-token-secret";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock";

const bookHandler = require("../api/book.js");
const webhookHandler = require("../api/stripe-webhook.js");
const bookingHandler = require("../api/admin/booking.js");
const rentalPricing = require("../api/_lib/rental-pricing");
const { retryUpdate } = require("../api/_lib/db-retry");

// ---------------------------------------------------------------------
// req/res mocks
// ---------------------------------------------------------------------
// Each call gets its own IP by default (a fresh octet per call) — this
// project's rate limiter (api/_lib/spam-protection.js) keeps its bucket
// state in a module-level Map for the lifetime of this one test process,
// so many POSTs sharing one fixed fake IP would trip RATE_LIMIT_MAX partway
// through this file, same as it would for real distinct visitors sharing a
// NAT'd IP — nothing to do with the code under test.
let nextIpOctet = 1;
function makeReq(opts) {
  opts = opts || {};
  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(bodyStr)),
        cookie: opts.cookie || "",
        "x-forwarded-proto": "https",
        "x-forwarded-for": opts.ip || "198.51." + Math.floor(nextIpOctet / 254) + "." + ((nextIpOctet++ % 254) + 1),
      },
      opts.headers || {}
    ),
    body: opts.body,
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

// A minimal readable-stream-like mock for api/stripe-webhook.js, which
// disables Vercel's default body parsing (module.exports.config) and reads
// the raw request body itself via req.on("data"/"end"/"error") — required
// for Stripe's signature verification, which needs the exact raw bytes,
// not a re-serialized JSON object. `constructEvent` is faked anyway (see
// webhookConstructImpl above), so the raw bytes' actual content never
// matters beyond round-tripping through this mock.
function makeWebhookReq(opts) {
  opts = opts || {};
  const bodyBuf = Buffer.from(opts.rawBody || "", "utf8");
  return {
    method: opts.method || "POST",
    headers: Object.assign({ "stripe-signature": opts.signature || "t=1,v1=mock" }, opts.headers || {}),
    on: function (event, cb) {
      if (event === "data") cb(bodyBuf);
      else if (event === "end") cb();
      return this;
    },
  };
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (n) => headers[n.toLowerCase()],
    setHeader: (n, v) => { headers[n.toLowerCase()] = v; },
    status: function (c) { res.statusCode = c; return res; },
    json: function (o) { res.body = o; return res; },
    send: function (o) { res.body = o; return res; },
    end: function () { if (res.statusCode === null) res.statusCode = 200; return res; },
    headersSent: false,
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const FAR_FUTURE_DATE = (function () {
  const d = new Date();
  d.setDate(d.getDate() + 20);
  return d.toISOString().slice(0, 10);
})();
const PICKUP_DATE = (function () {
  const d = new Date(FAR_FUTURE_DATE);
  d.setDate(d.getDate() + 5);
  return d.toISOString().slice(0, 10);
})();

// UUID-shaped fixture ids — api/admin/booking.js's UUID_RE rejects anything
// else (matching real behavior: a malformed id can never match a real row).
const BOOKING_ID = "11111111-1111-1111-1111-111111111111";
const CHARGE_ID = "22222222-2222-2222-2222-222222222222";

let idemCounter = 0;
function freshIdempotencyKey() {
  idemCounter += 1;
  return "test-idem-key-" + idemCounter + "-" + Date.now();
}

// `seedIntent: false` skips seeding a matching authorized PaymentIntent —
// used by validation tests that must never reach the Stripe retrieve() call
// at all. `intentOverrides` lets a test seed an intent with a deliberately
// wrong status/amount/metadata to exercise the verification checks in
// handleDumpsterRentalBooking()'s step 2.
function validDumpsterPayload(overrides, opts) {
  opts = opts || {};
  const idempotencyKey = (overrides && overrides.payment && overrides.payment.idempotencyKey) || freshIdempotencyKey();
  let paymentIntentId;
  if (opts.seedIntent !== false) {
    paymentIntentId = (overrides && overrides.payment && overrides.payment.paymentIntentId) || seedAuthorizedIntent(idempotencyKey, opts.intentOverrides).id;
  }
  const base = {
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
    customer: {
      firstName: "Jamie",
      lastName: "Rivera",
      phone: "303-555-0100",
      email: "jamie@example.com",
      streetAddress: "123 Main St",
      city: "Denver",
      state: "CO",
      zip: "80202",
    },
    payment: { paymentIntentId: paymentIntentId, idempotencyKey: idempotencyKey, agreementAccepted: true, signatureName: "Jamie Rivera" },
  };
  return deepMerge(base, overrides || {});
}
function deepMerge(base, overrides) {
  const out = Object.assign({}, base);
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] && typeof overrides[k] === "object" && !Array.isArray(overrides[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], overrides[k]);
    } else {
      out[k] = overrides[k];
    }
  });
  return out;
}

// Admin auth fixture — same pattern as tests/phase2-admin-api.test.js.
const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function configureAdminAuth() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-admin" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "invalid token" } }),
  });
}
function adminCookie() {
  return "mhjr_admin_at=at-admin; mhjr_admin_rt=rt-admin";
}

// ---------------------------------------------------------------------
// Test registry
// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name: name, fn: fn });
}

// =======================================================================
// 1. api/_lib/rental-pricing.js — pure calculation correctness
// =======================================================================
test("rental-pricing: base rental amount is the flat $349 rate", () => {
  assert.strictEqual(rentalPricing.baseRentalAmount(), 349.0);
});
test("rental-pricing: overageRate returns the correct per-unit rate for each charge type", () => {
  assert.strictEqual(rentalPricing.overageRate("overweight_tonnage"), 90.0);
  assert.strictEqual(rentalPricing.overageRate("additional_days"), 15.0);
  assert.strictEqual(rentalPricing.overageRate("other"), null);
  assert.strictEqual(rentalPricing.overageRate("bogus"), null);
});
test("rental-pricing: round2 rounds to the nearest cent", () => {
  // 1.005 is deliberately avoided here — it isn't exactly representable in
  // binary floating point (it's actually stored fractionally below 1.005),
  // so *any* correct round-half-up implementation legitimately rounds it
  // to 1.00, not 1.01. That's a float-representation fact, not something
  // this function's rounding strategy could fix.
  assert.strictEqual(rentalPricing.round2(10.126), 10.13);
  assert.strictEqual(rentalPricing.round2(90 * 2.5), 225);
});

// =======================================================================
// 1b. api/_lib/db-retry.js — the shared retry helper for the one class of
// write worth retrying (recording a Stripe charge that already succeeded).
// =======================================================================
test("db-retry: retryUpdate succeeds immediately when the first attempt has no error", async () => {
  let calls = 0;
  const ok = await retryUpdate(async () => {
    calls++;
    return { error: null };
  }, [1000, 1000]); // would take 2s if it actually retried — proves it didn't
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 1);
});
test("db-retry: retryUpdate retries after a failed attempt and succeeds on a later one", async () => {
  let calls = 0;
  const ok = await retryUpdate(async () => {
    calls++;
    if (calls < 3) return { error: { message: "transient" } };
    return { error: null };
  }, [1, 1, 1]);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 3, "must actually retry, not give up after the first failure");
});
test("db-retry: retryUpdate gives up after exhausting every attempt", async () => {
  let calls = 0;
  const ok = await retryUpdate(async () => {
    calls++;
    return { error: { message: "permanent" } };
  }, [1, 1]);
  assert.strictEqual(ok, false);
  assert.strictEqual(calls, 3, "1 initial attempt + 2 retries = 3 total calls for a 2-element delay array");
});
test("db-retry: retryUpdate treats a thrown attempt the same as a returned error — never crashes the caller", async () => {
  let calls = 0;
  const ok = await retryUpdate(async () => {
    calls++;
    if (calls === 1) throw new Error("network blip");
    return { error: null };
  }, [1]);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 2);
});

// =======================================================================
// 2. GET /api/book — public rental config
// =======================================================================
test("GET /api/book: returns publishable key, pricing, agreement version", async () => {
  freshDb();
  const res = await run(bookHandler, makeReq({ method: "GET" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.stripe.publishableKey, "pk_test_mock");
  assert.strictEqual(res.body.pricing.baseRate, 349.0);
  assert.strictEqual(res.body.pricing.overageTonRate, 90.0);
  assert.strictEqual(res.body.pricing.overageDayRate, 15.0);
  assert.strictEqual(res.body.agreementVersion, rentalPricing.RENTAL_AGREEMENT_VERSION);
  assert.ok(Array.isArray(res.body.takenDeliverySlots));
});
test("GET /api/book: taken delivery slots reflect existing booked dumpster rentals only", async () => {
  const db = freshDb();
  db.bookings.push({ id: "b1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1000_1200" });
  db.bookings.push({ id: "b2", service_type: "junk_removal", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1200_1400" });
  const res = await run(bookHandler, makeReq({ method: "GET" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.takenDeliverySlots, [{ date: FAR_FUTURE_DATE, timeWindow: "w_1000_1200" }]);
});

// =======================================================================
// 3. POST /api/book?resource=payment-intent — PaymentIntent creation
// =======================================================================
test("POST payment-intent: creates a manual-capture PaymentIntent with the authoritative $349 amount, setup_future_usage off_session, returns a client secret", async () => {
  freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.clientSecret);
  assert.ok(res.body.paymentIntentId);
  assert.strictEqual(createIntentCallLog.length, 1);
  assert.strictEqual(createIntentCallLog[0].params.amount, 34900, "amount must be in cents, computed server-side, never trusted from the client");
  assert.strictEqual(createIntentCallLog[0].params.currency, "usd");
  assert.strictEqual(createIntentCallLog[0].params.capture_method, "manual");
  assert.strictEqual(createIntentCallLog[0].params.setup_future_usage, "off_session");
  assert.strictEqual(createIntentCallLog[0].options.idempotencyKey, "intent:" + payload.payment.idempotencyKey);
  assert.strictEqual(createIntentCallLog[0].params.metadata.idempotencyKey, payload.payment.idempotencyKey);
});
test("POST payment-intent: a spoofed price field is completely ignored — the server always requests its own authoritative rate", async () => {
  freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  payload.amount = 1;
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(createIntentCallLog[0].params.amount, 34900);
});
test("POST payment-intent: never requires the agreement checkbox or a payment method yet — only the booking fields, agreement is enforced later at finalize", async () => {
  freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  payload.payment.agreementAccepted = false; // not yet checked — must not block intent creation
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 200);
});
test("POST payment-intent: invalid booking fields (e.g. missing material type) are rejected with 400, no Stripe call", async () => {
  freshDb();
  resetStripe();
  const payload = validDumpsterPayload({ jobDetails: { materialType: "" } }, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(createIntentCallLog.length, 0);
});
test("POST payment-intent: repeat customer (matched phone+email) with a prior Stripe Customer on file reuses it instead of creating a new one", async () => {
  const db = freshDb();
  resetStripe();
  db.customers.push({ id: "existing-cust", phone_normalized: "3035550100", email_normalized: "jamie@example.com" });
  db.bookings.push({ id: "past-booking", customer_id: "existing-cust" });
  db.rental_payments.push({ id: "past-payment", booking_id: "past-booking", stripe_customer_id: "cus_existing_1", created_at: "2026-01-01T00:00:00Z" });

  const payload = validDumpsterPayload({}, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(createIntentCallLog[0].params.customer, "cus_existing_1", "must reuse the customer's own prior Stripe Customer id");
});
test("POST payment-intent: a new customer gets a freshly-created Stripe Customer", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { seedIntent: false });
  delete payload.payment.paymentIntentId;
  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "payment-intent" }, body: payload }));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(createIntentCallLog[0].params.customer, "a Stripe Customer id must be attached even for a first-time customer");
});

// =======================================================================
// 4. POST /api/book (dumpster_rental finalize) — validation
// =======================================================================
test("POST dumpster_rental: missing payment.paymentIntentId is rejected with 400, no DB or Stripe calls", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload({ payment: { paymentIntentId: "", idempotencyKey: freshIdempotencyKey(), agreementAccepted: true } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
});
test("POST dumpster_rental: agreementAccepted !== true is rejected with 400", async () => {
  freshDb();
  resetStripe();
  const idempotencyKey = freshIdempotencyKey();
  const intent = seedAuthorizedIntent(idempotencyKey);
  const payload = validDumpsterPayload({ payment: { paymentIntentId: intent.id, idempotencyKey: idempotencyKey, agreementAccepted: false } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/agreement/i.test(res.body.error));
});
test("POST dumpster_rental: missing signatureName is rejected with 400, no DB or Stripe calls", async () => {
  const db = freshDb();
  resetStripe();
  const idempotencyKey = freshIdempotencyKey();
  const intent = seedAuthorizedIntent(idempotencyKey);
  const payload = validDumpsterPayload({ payment: { paymentIntentId: intent.id, idempotencyKey: idempotencyKey, agreementAccepted: true, signatureName: "" } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/signature/i.test(res.body.error));
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
});
test("POST dumpster_rental: whitespace-only signatureName is rejected with 400", async () => {
  freshDb();
  resetStripe();
  const idempotencyKey = freshIdempotencyKey();
  const intent = seedAuthorizedIntent(idempotencyKey);
  const payload = validDumpsterPayload({ payment: { paymentIntentId: intent.id, idempotencyKey: idempotencyKey, agreementAccepted: true, signatureName: "   " } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/signature/i.test(res.body.error));
});
test("POST dumpster_rental: agreementAccepted true but missing signatureName is still rejected (both are required independently)", async () => {
  freshDb();
  resetStripe();
  const idempotencyKey = freshIdempotencyKey();
  const intent = seedAuthorizedIntent(idempotencyKey);
  const payload = validDumpsterPayload({ payment: { paymentIntentId: intent.id, idempotencyKey: idempotencyKey, agreementAccepted: true, signatureName: null } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
});
test("POST dumpster_rental: malformed idempotencyKey is rejected with 400", async () => {
  freshDb();
  resetStripe();
  const payload = validDumpsterPayload({ payment: { paymentIntentId: "pi_test1", idempotencyKey: "!!!", agreementAccepted: true } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
});
test("POST dumpster_rental: a paymentIntentId whose metadata.idempotencyKey doesn't match this request is rejected with 400, no capture attempted", async () => {
  const db = freshDb();
  resetStripe();
  const otherIntent = seedAuthorizedIntent("some-other-checkout-attempt");
  const payload = validDumpsterPayload({ payment: { paymentIntentId: otherIntent.id, idempotencyKey: freshIdempotencyKey(), agreementAccepted: true } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
});
test("POST dumpster_rental: a PaymentIntent NOT in requires_capture (e.g. never actually confirmed) is rejected with 402, no booking created", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { intentOverrides: { status: "requires_payment_method" } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
  assert.ok(!res.body.retryWithNewPaymentIntent, "requires_payment_method is not a confirmed-dead outcome (never captured, never cancelled here) — must never tell the client it's safe to mint a fresh PaymentIntent");
});
test("POST dumpster_rental: a PaymentIntent already 'canceled' (confirmed dead by Stripe itself) is rejected with 402 AND explicitly tells the client it's safe to retry with a fresh PaymentIntent", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { intentOverrides: { status: "canceled" } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
  assert.strictEqual(res.body.retryWithNewPaymentIntent, true, "a 'canceled' status is Stripe's own positive confirmation this PaymentIntent is dead — the one case that must be flagged safe for a fresh retry");
});
test("POST dumpster_rental: an amount mismatch between the PaymentIntent and the authoritative rate is rejected with 400", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload({}, { intentOverrides: { amount: 1 } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
});

// =======================================================================
// 5. POST /api/book (dumpster_rental finalize) — successful payment
// =======================================================================
test("POST dumpster_rental: successful payment books the rental, captures the authoritative base rate, saves the payment method", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.booked, true);
  assert.ok(res.body.uploadToken);

  assert.strictEqual(db.customers.length, 1);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(db.bookings[0].service_type, "dumpster_rental");
  assert.strictEqual(db.dumpster_rentals.length, 1);
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
  assert.strictEqual(db.rental_payments[0].amount_charged, 349.0);
  assert.ok(db.rental_payments[0].stripe_payment_method_id);
  assert.strictEqual(db.rental_payments[0].payment_method_summary, "Visa ending in 4242");
  assert.strictEqual(db.rental_payments[0].agreement_version, rentalPricing.RENTAL_AGREEMENT_VERSION);
  assert.ok(db.rental_payments[0].agreement_accepted_at);
  assert.strictEqual(db.rental_payments[0].signature_name, "Jamie Rivera");

  assert.strictEqual(captureCallLog.length, 1);
  assert.strictEqual(captureCallLog[0].id, payload.payment.paymentIntentId);
});
test("POST dumpster_rental: notification email includes a Payment section with amount/method/PaymentIntent id", async () => {
  freshDb();
  resetStripe();
  fetchCalls = [];
  process.env.RESEND_API_KEY = "mock-resend-key";
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  const emailCall = fetchCalls.find((c) => c.url === "https://api.resend.com/emails");
  assert.ok(emailCall, "expected a Resend API call");
  const body = JSON.parse(emailCall.opts.body);
  assert.ok(/PAID & CONFIRMED/.test(body.html));
  assert.ok(/Amount Charged/.test(body.html));
  assert.ok(/\$349\.00/.test(body.html));
  assert.ok(/Stripe PaymentIntent ID/.test(body.html));
  delete process.env.RESEND_API_KEY;
});
test("POST dumpster_rental: metadata.bookingId is attached to the PaymentIntent once the booking exists — a durable, Dashboard-searchable correlation path", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload();
  await run(bookHandler, makeReq({ method: "POST", body: payload }));
  const intent = intentStore[payload.payment.paymentIntentId];
  assert.strictEqual(intent.metadata.bookingId, db.bookings[0].id);
});

// =======================================================================
// 6. POST /api/book (dumpster_rental finalize) — decline / ambiguous error
// =======================================================================
test("POST dumpster_rental: a definitive decline at capture time rolls back every row and cancels the authorization — no booking is left behind", async () => {
  const db = freshDb();
  resetStripe();
  captureImpl = async () => {
    throw stripeCardError("card_declined", "Your card was declined.");
  };
  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));

  assert.strictEqual(res.statusCode, 402);
  assert.ok(/declined/i.test(res.body.error));
  assert.strictEqual(db.bookings.length, 0, "no booking should remain after a decline");
  assert.strictEqual(db.dumpster_rentals.length, 0);
  assert.strictEqual(db.rental_payments.length, 0);
  assert.strictEqual(db.customers.length, 0, "the customer created for this failed attempt must also be rolled back");
  assert.deepStrictEqual(cancelCallLog, [payload.payment.paymentIntentId], "the authorization must be released on a definitive decline");
  assert.strictEqual(res.body.retryWithNewPaymentIntent, true, "a StripeCardError decline is a definitive 'no money moved' answer and this PaymentIntent was just cancelled above — safe to flag for a fresh retry");
});
// A THROWN, non-StripeCardError capture failure (network error/timeout) is
// an AMBIGUOUS outcome — Stripe may have actually captured the charge, and
// there's no definitive answer to check. Rolling back here would be
// dangerous: it would delete the only record of a possibly-successful
// charge AND free the slot for someone else.
test("POST dumpster_rental: an ambiguous Stripe failure (thrown error) preserves every row instead of rolling back, and never leaks a raw stack trace to the customer", async () => {
  const db = freshDb();
  resetStripe();
  captureImpl = async () => {
    throw stripeAmbiguousError();
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 502);
  assert.ok(!/ECONNRESET/.test(res.body.error));
  assert.ok(/call or text/i.test(res.body.error), "must direct the customer to call rather than silently retry");
  assert.strictEqual(db.bookings.length, 1, "the booking must NOT be rolled back — it may have actually been paid for");
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(db.customers.length, 1, "the customer record must also be preserved");
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(db.rental_payments[0].failure_reason));
  assert.strictEqual(cancelCallLog.length, 0, "an ambiguous outcome must never cancel the authorization either — its fate is unknown");
  assert.ok(!res.body.retryWithNewPaymentIntent, "an ambiguous capture outcome (Stripe may have actually charged the card) must NEVER be flagged safe for a fresh PaymentIntent — that could risk a second charge attempt against an unresolved one");
  assert.strictEqual(res.body.paymentStatusPending, true, "the true ambiguous-capture case must set paymentStatusPending so the client locks the payment UI instead of re-enabling Pay");
});
test("POST dumpster_rental: resubmitting the same idempotency key after an ambiguous failure is blocked (never silently retried, never a second capture)", async () => {
  const db = freshDb();
  resetStripe();
  captureImpl = async () => {
    throw stripeAmbiguousError();
  };
  const payload = validDumpsterPayload();
  const first = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(first.statusCode, 502);
  assert.strictEqual(captureCallLog.length, 1);

  const second = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(second.statusCode, 409);
  assert.ok(/call or text/i.test(second.body.error));
  assert.strictEqual(captureCallLog.length, 1, "must never capture again for a key stuck in error_pending_review");
  assert.strictEqual(db.bookings.length, 1, "must not create a second booking either");
  assert.ok(!second.body.retryWithNewPaymentIntent, "error_pending_review is an unresolved/ambiguous outcome — must never be flagged safe for a fresh PaymentIntent");
  assert.strictEqual(second.body.paymentStatusPending, true, "a resubmit against a row stuck in error_pending_review must set paymentStatusPending so the client locks rather than offers any further action");
});
test("POST dumpster_rental: rate-schedule snapshot (base rate, included days/tons, overage rates) is durably stored on rental_payments at booking time", async () => {
  const db = freshDb();
  resetStripe();
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  const rp = db.rental_payments[0];
  assert.strictEqual(rp.base_rate, rentalPricing.BASE_RATE);
  assert.strictEqual(rp.included_days, rentalPricing.INCLUDED_DAYS);
  assert.strictEqual(rp.included_tons, rentalPricing.INCLUDED_TONS);
  assert.strictEqual(rp.overage_ton_rate, rentalPricing.OVERAGE_TON_RATE);
  assert.strictEqual(rp.overage_day_rate, rentalPricing.OVERAGE_DAY_RATE);
});
test("POST dumpster_rental: if every attempt at the full 'mark paid' write fails, a minimal fallback write still records paid_reconciliation_required + the PaymentIntent id — the customer still gets a booked response either way", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_payments") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && this._updatePayload.payment_status === "paid") {
            return { data: null, error: { message: "mock update failure" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booked, true, "the booking is genuinely valid regardless of the local persistence gap — never told anything but the truth");
  assert.strictEqual(captureCallLog.length, 1, "must not attempt to charge a second time trying to recover from a local DB write failure");
  assert.strictEqual(db.rental_payments[0].payment_status, "paid_reconciliation_required", "the minimal fallback write must still land, distinctly from both 'paid' and 'processing'");
  assert.ok(db.rental_payments[0].stripe_payment_intent_id, "the PaymentIntent id must be recoverable from our own database even when the full record failed to save");
});
test("POST dumpster_rental: if EVERY write fails — even the minimal fallback — the customer still gets a booked response (truthful either way), and the row is left exactly as it was rather than a fabricated status", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_payments") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && (this._updatePayload.payment_status === "paid" || this._updatePayload.payment_status === "paid_reconciliation_required")) {
            return { data: null, error: { message: "mock total outage" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booked, true);
  assert.strictEqual(captureCallLog.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "processing", "the row is genuinely stuck — proves the response's honesty isn't hiding a successful write that didn't happen");
});
test("POST dumpster_rental: resubmitting the same idempotency key against a booking stuck at paid_reconciliation_required returns the same booked response, never a 409 — the charge genuinely succeeded", async () => {
  const db = freshDb();
  resetStripe();
  db.bookings.push({ id: "existing-booking", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.rental_payments.push({ id: "rp1", booking_id: "existing-booking", idempotency_key: "stuck-key-1", payment_status: "paid_reconciliation_required" });
  const res = await run(
    bookHandler,
    makeReq({ method: "POST", body: validDumpsterPayload({ payment: { paymentIntentId: "pi_stuck1", idempotencyKey: "stuck-key-1", agreementAccepted: true } }, { seedIntent: false }) })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booked, true);
  assert.strictEqual(captureCallLog.length, 0, "must never capture again for a key already known to have succeeded");
});
test("POST dumpster_rental: after a decline, the SAME delivery slot can be booked again by a new attempt", async () => {
  const db = freshDb();
  resetStripe();
  captureImpl = async () => {
    throw stripeCardError();
  };
  const declined = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(declined.statusCode, 402);

  captureImpl = null;
  const succeeded = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(succeeded.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);
});

// =======================================================================
// 7. POST /api/book (dumpster_rental finalize) — idempotency / duplicate
// =======================================================================
test("POST dumpster_rental: resubmitting the same idempotency key after success returns the same booked response without capturing again", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload();
  const first = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(captureCallLog.length, 1);

  const second = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.booked, true);
  assert.strictEqual(captureCallLog.length, 1, "must not capture a second time for a repeated idempotency key");
  assert.strictEqual(db.bookings.length, 1, "must not create a second booking");
});
test("POST dumpster_rental: a concurrent duplicate (same idempotency key, still processing) gets a clean 409, never a second charge", async () => {
  const db = freshDb();
  resetStripe();
  // Simulate the state right after the reservation rows are inserted but
  // before the (first, in-flight) request's capture call has resolved.
  db.rental_payments.push({ id: "rp1", booking_id: "b1", idempotency_key: "shared-key-123", payment_status: "processing" });
  const intent = seedAuthorizedIntent("shared-key-123");
  const payload = validDumpsterPayload({ payment: { paymentIntentId: intent.id, idempotencyKey: "shared-key-123", agreementAccepted: true } }, { seedIntent: false });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(captureCallLog.length, 0, "a concurrent duplicate must never itself capture");
  assert.ok(!res.body.retryWithNewPaymentIntent, "a still-processing concurrent duplicate shares the SAME live PaymentIntent as its sibling request — must never be flagged safe for a fresh one, which could abandon an authorization the sibling is about to capture");
  assert.strictEqual(res.body.paymentStatusPending, true, "a still-in-flight concurrent duplicate must set paymentStatusPending so this request's own client locks its payment UI rather than offering a retry that could hit the sibling's live PaymentIntent");
});

// =======================================================================
// 8. POST /api/book (dumpster_rental finalize) — availability / slot
// =======================================================================
test("POST dumpster_rental: booking the exact same date+time window as an existing booked rental is rejected with 409, the authorization is cancelled, capture is never attempted", async () => {
  const db = freshDb();
  resetStripe();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });

  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 409);
  assert.ok(/just booked/i.test(res.body.error));
  assert.strictEqual(captureCallLog.length, 0, "a losing race for a slot must never reach capture");
  assert.deepStrictEqual(cancelCallLog, [payload.payment.paymentIntentId], "the loser's authorization must be released, not left as a lingering hold");
  assert.strictEqual(db.bookings.length, 1, "only the pre-existing booking should remain — the loser's row and its customer are rolled back");
  assert.strictEqual(db.customers.length, 0);
  assert.strictEqual(res.body.retryWithNewPaymentIntent, true, "the loser's PaymentIntent was just cancelled above — safe to flag for a fresh retry against a different slot");
});
test("POST dumpster_rental: a different time window on the same date is NOT blocked", async () => {
  const db = freshDb();
  resetStripe();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1200_1400" });

  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload({ schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" } }) }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings.length, 2);
});
test("POST dumpster_rental: server-side availability enforcement is independent of anything the client claims — a spoofed 'available' flag changes nothing", async () => {
  const db = freshDb();
  resetStripe();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  const payload = validDumpsterPayload();
  payload.availabilityConfirmed = true; // not a real field — this endpoint never reads it
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 409);
});

// =======================================================================
// 8b. TRUE CONCURRENCY, not sequential duplicate POSTs. Both requests in
// each test below are fired together via Promise.all so their internal
// awaits genuinely interleave (Node's single-threaded microtask queue
// processes each call's pending step in turn, exactly the way two separate
// serverless invocations hitting the same real Postgres database would
// race at the DB level) — this is not simulating "request A fully
// finishes, then request B starts."
// =======================================================================
test("CONCURRENCY: two simultaneous requests with the SAME idempotency key never both capture — exactly one capture(), no double charge, and the shared authorization is never cancelled out from under the winner", async () => {
  const db = freshDb();
  resetStripe();
  const payload = validDumpsterPayload(); // same idempotency key AND same slot for both

  const [resA, resB] = await Promise.all([run(bookHandler, makeReq({ method: "POST", body: payload })), run(bookHandler, makeReq({ method: "POST", body: payload }))]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409], "exactly one of the two concurrent identical requests must succeed");
  assert.strictEqual(captureCallLog.length, 1, "capture() must be invoked exactly once — this is the actual proof, not just the HTTP status codes");
  assert.strictEqual(cancelCallLog.length, 0, "the shared PaymentIntent must never be cancelled here — a same-key sibling might still need it to capture");
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("CONCURRENCY: two simultaneous requests for the SAME delivery slot (different idempotency keys, different PaymentIntents) — exactly one booking confirmed, the loser retains no charge at all and its authorization is released", async () => {
  const db = freshDb();
  resetStripe();
  const payloadA = validDumpsterPayload();
  const payloadB = validDumpsterPayload(); // fresh idempotency key + fresh PaymentIntent, same default slot as A

  const [resA, resB] = await Promise.all([run(bookHandler, makeReq({ method: "POST", body: payloadA })), run(bookHandler, makeReq({ method: "POST", body: payloadB }))]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409]);
  assert.strictEqual(captureCallLog.length, 1, "the losing request must be blocked at the DB slot-claim step and never reach capture at all — proves Client A and Client B can never BOTH be charged for the last remaining slot");
  assert.strictEqual(cancelCallLog.length, 1, "the loser's own distinct PaymentIntent must be cancelled — never left as a charge of any kind");
  assert.strictEqual(db.bookings.length, 1, "exactly one booking exists — no duplicate active slot");
  assert.strictEqual(db.rental_payments.length, 1, "exactly one payment record — the loser has no retained charge of any kind, not even a stray row");
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("CONCURRENCY: two simultaneous admin Approve requests for the SAME charge never both confirm a Stripe charge", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const [resA, resB] = await Promise.all([
    run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } })),
    run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } })),
  ]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409]);
  assert.strictEqual(confirmChargeCallLog.length, 1, "the off-session create+confirm call must be invoked exactly once for two concurrent Approve clicks on the same charge");
  assert.strictEqual(db.rental_additional_charges[0].status, "paid");
});

// =======================================================================
// 9. POST /api/book (dumpster_rental finalize) — insert-step failures
// =======================================================================
test("POST dumpster_rental: dumpster_rentals insert failure rolls back the booking and customer, cancels the authorization, never captures", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "dumpster_rentals") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._insertPayload) return { data: null, error: { message: "mock insert failure for dumpster_rentals" } };
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(db.customers.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
  assert.deepStrictEqual(cancelCallLog, [payload.payment.paymentIntentId]);
  assert.strictEqual(res.body.retryWithNewPaymentIntent, true, "the rollback above cancelled this PaymentIntent — safe to flag for a fresh retry");
});
test("POST dumpster_rental: customer insert failure cancels the authorization and tells the client it's safe to retry with a fresh PaymentIntent", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "customers") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._insertPayload) return { data: null, error: { message: "mock insert failure for customers" } };
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(captureCallLog.length, 0);
  assert.deepStrictEqual(cancelCallLog, [payload.payment.paymentIntentId]);
  assert.strictEqual(res.body.retryWithNewPaymentIntent, true, "a failed customer insert cancels this PaymentIntent directly — safe to flag for a fresh retry");
});

// =======================================================================
// 10. Stripe webhook (api/stripe-webhook.js)
// =======================================================================
test("webhook: an invalid signature is rejected with 400 and nothing is written", async () => {
  const db = freshDb();
  resetStripe();
  webhookConstructImpl = () => {
    throw new Error("signature does not match");
  };
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_1", payment_status: "paid" });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid", "must be untouched");
});
test("webhook: payment_intent.succeeded self-heals a row stuck at paid_reconciliation_required back to paid — a real reconciliation backstop, unlike Braintree's dead settlement webhooks", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_stuck", payment_status: "paid_reconciliation_required" });
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: { id: "pi_stuck", customer: "cus_1", payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242" } } } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
  assert.strictEqual(db.rental_payments[0].payment_method_summary, "Visa ending in 4242");
});
test("webhook: payment_intent.succeeded is a no-op for an already-paid row (idempotent, never re-writes)", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_1", payment_status: "paid", payment_method_summary: "Visa ending in 4242", updated_at: "2026-01-01T00:00:00Z" });
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: { id: "pi_1", customer: "cus_1", payment_method: "pm_1" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].updated_at, "2026-01-01T00:00:00Z", "an already-paid row must never be re-written by a late/duplicate event");
});
test("webhook: payment_intent.payment_failed marks a processing row failed, but never downgrades an already-paid row", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_2", payment_status: "processing" });
  webhookConstructImpl = () => ({ type: "payment_intent.payment_failed", data: { object: { id: "pi_2", last_payment_error: { message: "Card declined." } } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "failed");

  db.rental_payments[0].payment_status = "paid";
  const res2 = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid", "a late/out-of-order failed event must never downgrade an already-paid row");
});
test("webhook: processing the same payment_intent.succeeded notification twice is idempotent (Stripe's at-least-once delivery)", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_3", payment_status: "processing" });
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: { id: "pi_3", customer: "cus_1", payment_method: "pm_1" } } });

  const first = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");

  const second = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid", "re-processing the same delivery must land on the same end state, not error or duplicate anything");
});
test("webhook: charge.dispute.created records dispute_status without changing payment_status", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_4", payment_status: "paid" });
  webhookConstructImpl = () => ({ type: "charge.dispute.created", data: { object: { payment_intent: "pi_4", status: "needs_response" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].dispute_status, "needs_response");
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("webhook: charge.dispute.closed records the final dispute outcome (won/lost)", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_5", payment_status: "paid", dispute_status: "needs_response" });
  webhookConstructImpl = () => ({ type: "charge.dispute.closed", data: { object: { payment_intent: "pi_5", status: "lost" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].dispute_status, "lost");
});
test("webhook: payment_intent.succeeded also updates a matching rental_additional_charges row when no rental_payments row matches", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_additional_charges.push({ id: "rac1", booking_id: "b1", stripe_payment_intent_id: "pi_6", status: "paid_reconciliation_required" });
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: { id: "pi_6", customer: "cus_1", payment_method: "pm_1" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_additional_charges[0].status, "paid");
});
test("webhook: payment_intent.canceled marks a stuck processing row voided", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_7", payment_status: "processing" });
  webhookConstructImpl = () => ({ type: "payment_intent.canceled", data: { object: { id: "pi_7" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "voided");
});
test("webhook: an unrecognized event type is acknowledged with 200 and changes nothing", async () => {
  const db = freshDb();
  resetStripe();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", stripe_payment_intent_id: "pi_8", payment_status: "paid" });
  webhookConstructImpl = () => ({ type: "customer.created", data: { object: { id: "cus_1" } } });
  const res = await run(webhookHandler, makeWebhookReq({ rawBody: "{}" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("webhook: a GET request is rejected with 405 — Stripe never uses a GET-challenge verification step the way Braintree did", async () => {
  resetStripe();
  const res = await run(webhookHandler, makeWebhookReq({ method: "GET" }));
  assert.strictEqual(res.statusCode, 405);
});

// =======================================================================
// 11. Admin additional-charge propose/approve/check-status workflow
// =======================================================================
test("admin charges: no admin session -> 401, no DB or Stripe calls", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  currentFakeAnon = createFakeAnonClient();
  const res = await run(bookingHandler, makeReq({ method: "POST", query: { resource: "charges" }, body: { bookingId: "x" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(confirmChargeCallLog.length, 0);
});
test("admin charges: proposing an overweight_tonnage charge computes amount from the current rate and never calls Stripe", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });

  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 1.5 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "proposed");
  assert.strictEqual(res.body.charge.quantity, 1.5);
  assert.strictEqual(res.body.charge.rate, 90.0);
  assert.strictEqual(res.body.charge.amount, 135.0);
  assert.strictEqual(confirmChargeCallLog.length, 0, "a proposal must never move money");
});
test("admin charges: proposing an additional_days charge computes amount from the day rate", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "additional_days", quantity: 3 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.amount, 45.0);
});
test("admin charges: proposing on a non-dumpster-rental booking is rejected", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "junk_removal" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "additional_days", quantity: 1 } })
  );
  assert.strictEqual(res.statusCode, 400);
});
test("admin charges: approving a proposed charge confirms an off-session PaymentIntent against the saved Customer/PaymentMethod and marks it paid", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_vaulted_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid");
  assert.strictEqual(confirmChargeCallLog.length, 1);
  assert.strictEqual(confirmChargeCallLog[0].params.amount, 9000, "amount must be in cents");
  assert.strictEqual(confirmChargeCallLog[0].params.customer, "cus_vaulted_1");
  assert.strictEqual(confirmChargeCallLog[0].params.payment_method, "pm_vaulted_1");
  assert.strictEqual(confirmChargeCallLog[0].params.off_session, true);
  assert.strictEqual(confirmChargeCallLog[0].params.confirm, true);
  assert.strictEqual(db.rental_additional_charges[0].approved_by, ADMIN_EMAIL);
  assert.ok(db.rental_additional_charges[0].approved_at);
});
test("admin charges: approving ignores any client-submitted amount — only the row's own snapshotted amount is ever charged", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(
    bookingHandler,
    makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve", amount: 1 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(confirmChargeCallLog[0].params.amount, 9000);
});
test("admin charges: a second concurrent Approve on the same charge is rejected with 409, never a second charge", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(confirmChargeCallLog.length, 1);

  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(confirmChargeCallLog.length, 1, "approving an already-processed charge must never call Stripe again");
});
test("admin charges: a declined approved charge is recorded as failed with a reason, admin can see it and retry later", async () => {
  const db = freshDb();
  resetStripe();
  confirmChargeImpl = async () => {
    throw stripeCardError("insufficient_funds", "Insufficient funds.");
  };
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "failed");
  assert.ok(/insufficient funds/i.test(res.body.charge.failureReason));
});
test("admin charges: a 'failed' (cleanly declined) charge IS safely retryable — a second Approve after the decline succeeds and charges exactly once more", async () => {
  const db = freshDb();
  resetStripe();
  confirmChargeImpl = async () => {
    throw stripeCardError("insufficient_funds", "Insufficient funds.");
  };
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.body.charge.status, "failed");
  assert.strictEqual(confirmChargeCallLog.length, 1);

  // Customer presumably fixed their card — admin clicks Approve again.
  confirmChargeImpl = null;
  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.charge.status, "paid");
  assert.strictEqual(confirmChargeCallLog.length, 2, "exactly one more call for the retry — not a duplicate of the first, not blocked");
  assert.strictEqual(db.rental_additional_charges[0].failure_reason, null, "the stale decline reason must be cleared once the retry succeeds");
});
test("admin charges: an ambiguous Stripe failure (thrown error) during approval is marked error_pending_review and is NOT retryable via Approve again", async () => {
  const db = freshDb();
  resetStripe();
  confirmChargeImpl = async () => {
    throw stripeAmbiguousError();
  };
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.charge.status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(first.body.charge.failureReason));
  assert.strictEqual(confirmChargeCallLog.length, 1);

  // Admin (or a naive double-click) tries Approve again — must be refused,
  // never silently retried, since the first attempt's outcome is unknown.
  confirmChargeImpl = null;
  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(confirmChargeCallLog.length, 1, "must never call Stripe again for a charge stuck in error_pending_review");
});
// Stripe-specific — no Braintree equivalent existed. An off-session
// confirmation that needs Strong Customer Authentication the customer
// isn't present to complete must never be falsely marked paid, and must
// never be blindly retried (retrying the same off-session confirmation
// would most likely fail identically, or worse, create ambiguity about
// which attempt the customer actually authenticated).
test("admin charges: an off-session confirmation requiring customer authentication is marked requires_customer_action — never falsely paid, never retryable via Approve", async () => {
  const db = freshDb();
  resetStripe();
  confirmChargeImpl = async () => {
    throw stripeAuthenticationRequiredError("pi_needs_auth_1");
  };
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "requires_customer_action");
  assert.strictEqual(db.rental_additional_charges[0].stripe_payment_intent_id, "pi_needs_auth_1");

  // A naive re-Approve must be refused — this state is deliberately
  // excluded from the retryable set.
  confirmChargeImpl = null;
  const retry = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(retry.statusCode, 409);
  assert.strictEqual(confirmChargeCallLog.length, 1, "must never attempt a second off-session confirmation for a charge stuck needing customer authentication");
});
test("admin charges: check-status on a requires_customer_action charge advances it to paid once Stripe confirms the customer completed authentication — a safe, non-charging read", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  intentStore["pi_needs_auth_2"] = { id: "pi_needs_auth_2", status: "succeeded", payment_method: "pm_1" };
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "requires_customer_action", stripe_payment_intent_id: "pi_needs_auth_2" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "check-status" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid");
  assert.strictEqual(confirmChargeCallLog.length, 0, "check-status must never itself create or confirm a charge");
});
test("admin charges: check-status on a requires_customer_action charge marks it failed (safely retryable) once Stripe confirms the customer never completed authentication", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  intentStore["pi_needs_auth_3"] = { id: "pi_needs_auth_3", status: "canceled" };
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "requires_customer_action", stripe_payment_intent_id: "pi_needs_auth_3" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "check-status" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "failed");
});
test("admin charges: check-status leaves a still-pending requires_customer_action charge unchanged", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  intentStore["pi_needs_auth_4"] = { id: "pi_needs_auth_4", status: "requires_action" };
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "requires_customer_action", stripe_payment_intent_id: "pi_needs_auth_4" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "check-status" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "requires_customer_action");
});
test("admin charges: if every attempt at the full 'mark paid' write fails, a minimal fallback write still records paid_reconciliation_required + the PaymentIntent id", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_additional_charges") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && this._updatePayload.status === "paid") {
            return { data: null, error: { message: "mock update failure" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid_reconciliation_required", "must never report a plain 'paid' the database doesn't actually reflect");
  assert.ok(res.body.charge.stripePaymentIntentId, "the PaymentIntent id must still reach the response even though the full record failed to save");
  assert.ok(res.body.warning);
  assert.strictEqual(confirmChargeCallLog.length, 1, "must not attempt to charge a second time trying to recover from a local DB write failure");
  // The minimal fallback write DID land in the (fake) database, even
  // though the full one never did.
  assert.strictEqual(db.rental_additional_charges[0].status, "paid_reconciliation_required");
  assert.strictEqual(db.rental_additional_charges[0].stripe_payment_intent_id, res.body.charge.stripePaymentIntentId);
});
test("admin charges: if EVERY write fails — even the minimal fallback — the response still reports paid_reconciliation_required rather than a false 'paid'", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_additional_charges") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && (this._updatePayload.status === "paid" || this._updatePayload.status === "paid_reconciliation_required")) {
            return { data: null, error: { message: "mock total outage" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid_reconciliation_required");
  assert.ok(res.body.charge.stripePaymentIntentId, "the PaymentIntent id is still surfaced to the admin even though nothing could be persisted");
  assert.ok(res.body.warning);
  // Confirms the database genuinely could not be updated at all — the row
  // is stuck at "processing" (the last write that DID succeed, the
  // interim approved->processing transition before the Stripe call),
  // proving the response's honesty rather than a fabricated success.
  assert.strictEqual(db.rental_additional_charges[0].status, "processing");
});
test("admin charges: metadata links the PaymentIntent back to the booking and charge, set independent of any local DB write outcome", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_vaulted_1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.deepStrictEqual(confirmChargeCallLog[0].params.metadata, { bookingId: BOOKING_ID, chargeId: CHARGE_ID });
});
test("admin charges: proposing overweight_tonnage uses THIS booking's own locked-in rate, not the current global rate, when they differ", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  // Simulates a booking paid under an OLD rate schedule, before a global
  // pricing change to $120/ton (rentalPricing.OVERAGE_TON_RATE is still
  // $90 in the current global config — this row's own $75 must win).
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, overage_ton_rate: 75, overage_day_rate: 10 });

  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 2 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.rate, 75, "must use this booking's own locked-in rate, not the current global $90 rate");
  assert.strictEqual(res.body.charge.amount, 150);
});
test("admin charges: proposing on a booking with no rental_payments row of its own falls back to the current global rate", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 1 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.rate, rentalPricing.OVERAGE_TON_RATE);
});
test("admin charges: approving a booking with no payment method on file fails cleanly without calling Stripe", async () => {
  const db = freshDb();
  resetStripe();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });
  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "failed");
  assert.strictEqual(confirmChargeCallLog.length, 0);
});
test("admin charges: GET lists charges for a booking, newest first", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, status: "proposed", created_at: "2026-01-01T00:00:00Z" });
  db.rental_additional_charges.push({ id: "rac2", booking_id: BOOKING_ID, status: "paid", created_at: "2026-02-01T00:00:00Z" });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { resource: "charges", bookingId: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charges.length, 2);
  assert.strictEqual(res.body.charges[0].id, "rac2");
});
test("admin booking detail (GET, no resource param): includes payment info for a booking that was paid online", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  db.rental_payments.push({
    id: "rp1",
    booking_id: BOOKING_ID,
    payment_status: "paid",
    amount_charged: 349,
    payment_method_summary: "Visa ending in 4242",
    stripe_payment_intent_id: "pi_9",
    agreement_version: "2026-09-18",
    agreement_accepted_at: "2026-09-18T12:00:00Z",
    dispute_status: null,
  });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment.status, "paid");
  assert.strictEqual(res.body.payment.amountCharged, 349);
  assert.strictEqual(res.body.payment.methodSummary, "Visa ending in 4242");
  assert.strictEqual(res.body.payment.transactionId, "pi_9");
});
test("admin booking detail (GET): payment is null for a booking with no rental_payments row (e.g. an admin-created dumpster rental)", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment, null);
});
test("admin booking detail (GET): exposes failureReason for a payment stuck in error_pending_review, so the admin sees why without opening Stripe first", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  db.rental_payments.push({
    id: "rp1",
    booking_id: BOOKING_ID,
    payment_status: "error_pending_review",
    amount_charged: 349,
    failure_reason: "Stripe capture request failed/timed out before a definitive response was received. Outcome unknown — check the Stripe Dashboard for PaymentIntent pi_10 before taking any action.",
  });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment.status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(res.body.payment.failureReason));
});

// =======================================================================
// 12. Existing junk_removal/light_demo behavior is unaffected
// =======================================================================
test("POST /api/book: junk_removal booking still succeeds exactly as before, no payment fields required, status left unset", async () => {
  const db = freshDb();
  resetStripe();
  const res = await run(
    bookHandler,
    makeReq({
      method: "POST",
      body: {
        serviceType: "junk_removal",
        hp: "",
        elapsedMs: 10000,
        jobDetails: { itemsDescription: "Old couch", location: "Garage", stairs: "none", additionalDetails: "" },
        schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
        customer: { firstName: "Jamie", lastName: "Rivera", phone: "303-555-0100", email: "jamie@example.com", streetAddress: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
      },
    })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].status, undefined, "junk_removal must still never set status explicitly");
  assert.strictEqual(captureCallLog.length, 0);
});

// ---------------------------------------------------------------------
// =======================================================================
// 10. book/book.js retry/lock design — static source-pattern verification
//
// book/book.js is browser-only client code (Stripe Elements, DOM event
// listeners) — this project has no DOM/click-simulation or JS-execution
// test harness for any frontend file (the same disclosed limitation noted
// in tests/phase3c-schedule.test.js and used by
// tests/phase3c-stage2.4-address-and-prefill.test.js for the Google
// Places autocomplete component). Building one from scratch for this fix
// alone was judged disproportionate. These tests instead use this
// project's own established fallback for frontend behavior: read the real
// deployed source and assert directly on it, isolating each of the three
// mutually-exclusive catch-handler branches by their exact, unique
// boundary text so an assertion can never accidentally match the wrong
// branch. Confirmed behaviorally in a live browser session for the
// error-message/lock-visibility side of this (see the chat transcript);
// these tests instead guarantee the underlying control flow — which
// branch touches which state — never silently regresses.
// =======================================================================
function readBookJs() {
  return fs.readFileSync(path.join(__dirname, "..", "book", "book.js"), "utf8");
}
// Slices book.js's payAndBookBtn catch handler into its three mutually-
// exclusive branches using their exact, unique source boundaries.
function catchBranches() {
  // book/book.js uses CRLF line endings — every anchor below is a single
  // line (no embedded \n/\r\n) specifically so this extraction is
  // line-ending-agnostic.
  const src = readBookJs();
  const startA = src.indexOf("if (err && err.retryWithNewPaymentIntent) {");
  const startLock = src.indexOf("} else if (err && err.isServerMessage) {");
  const startD = src.indexOf("// Purely client-side rejection");
  const endD = src.indexOf("});", startD);
  assert.ok(startA > 0 && startLock > startA && startD > startLock && endD > startD, "expected book.js's payAndBookBtn catch handler to contain exactly the three branches this test suite depends on — if this fails, the source structure changed and these tests need updating, not silently passing");
  return {
    freshRetry: src.slice(startA, startLock),
    locked: src.slice(startLock, startD),
    clientSideRetryable: src.slice(startD, endD),
  };
}

test("book.js source: state.paymentLocked exists and guards both showPaymentPanel() and the payAndBookBtn click handler from re-entering a locked checkout", () => {
  const src = readBookJs();
  assert.ok(/paymentLocked:\s*false/.test(src), "state must declare paymentLocked, initially false");
  assert.ok(/function showPaymentPanel\(\)\s*\{[\s\S]{0,400}if \(state\.paymentLocked\) return;/.test(src), "showPaymentPanel() must refuse to re-enter (and thus re-mint against the same idempotencyKey) once locked");
  assert.ok(/payAndBookBtn\.addEventListener\('click', function \(\) \{[\s\S]{0,300}if \(state\.paymentLocked\) return;/.test(src), "the click handler must refuse to proceed once locked, independent of the button's disabled attribute");
});

test("book.js source, branch A (retryWithNewPaymentIntent): mints a fresh PaymentIntent — clears the old one, unmounts the Payment Element, generates a new idempotency key, and calls initPaymentElement() again", () => {
  const b = catchBranches().freshRetry;
  assert.ok(/state\.paymentIntentId = null/.test(b), "must clear the dead PaymentIntent id");
  assert.ok(/state\.stripeElements = null/.test(b), "must clear the dead Elements instance");
  assert.ok(/state\.idempotencyKey = newIdempotencyKey\(\)/.test(b), "must mint a genuinely NEW idempotency key, never reuse the one tied to the dead PaymentIntent");
  assert.ok(/paymentElement\.unmount\(\)/.test(b), "must unmount the old Payment Element before mounting a fresh one");
  assert.ok(/initPaymentElement\(\)/.test(b), "must call initPaymentElement() to create the fresh PaymentIntent and mount a fresh Payment Element");
  assert.ok(!/state\.paymentLocked = true/.test(b), "a confirmed-dead outcome must never lock the UI — it's the one case where continuing is safe");
});

test("book.js source, branch B/C (locked/ambiguous — isServerMessage without retryWithNewPaymentIntent): locks the UI and never re-runs confirmPayment or mints a new PaymentIntent", () => {
  const b = catchBranches().locked;
  assert.ok(/state\.paymentLocked = true/.test(b), "must set the permanent lock flag");
  assert.ok(/payAndBookBtn\.disabled = true/.test(b), "must disable Pay & Book Now so confirmPayment() can never be re-invoked against this already-confirmed PaymentIntent");
  assert.ok(/paymentBackBtn\.disabled = true/.test(b), "must also disable Back to Review — otherwise navigating back and forward again would re-enter showPaymentPanel()/initPaymentElement() and reuse the same tainted idempotencyKey");
  assert.ok(/paymentElement\.unmount\(\)/.test(b), "must unmount the Payment Element so it cannot be interacted with even if some other path tried");
  assert.ok(!/initPaymentElement\(\)/.test(b), "must NOT create a fresh PaymentIntent for an unresolved/ambiguous outcome");
  assert.ok(!/newIdempotencyKey\(\)/.test(b), "must NOT mint a new idempotency key for an unresolved/ambiguous outcome");
  // Matches only a genuine invocation (`.confirmPayment({` — the real call
  // signature used once, higher up, to actually confirm the payment) —
  // deliberately not `.confirmPayment(` alone, since this branch's own
  // explanatory comments legitimately discuss "confirmPayment()" in prose.
  assert.ok(!/\.confirmPayment\(\{/.test(b), "must NOT call stripe.confirmPayment() again from within the catch handler itself");
});

test("book.js source, branch D (purely client-side rejection — isServerMessage unset): remains retryable, same PaymentIntent/Elements preserved, no lock", () => {
  const b = catchBranches().clientSideRetryable;
  assert.ok(/payAndBookBtn\.disabled = false/.test(b), "must re-enable Pay & Book Now — confirmPayment() never succeeded for this attempt, so the SAME PaymentIntent remains safely confirmable");
  assert.ok(/paymentBackBtn\.disabled = false/.test(b), "must re-enable Back to Review");
  assert.ok(!/state\.paymentLocked = true/.test(b), "must never lock the UI for an ordinary client-side validation/decline — that would block a customer from simply fixing a card typo");
  assert.ok(!/paymentElement\.unmount\(\)/.test(b), "must NOT unmount the Payment Element — the customer's in-progress card entry must be preserved");
  assert.ok(!/state\.paymentIntentId = null/.test(b), "must NOT clear the still-live PaymentIntent id");
  assert.ok(!/state\.idempotencyKey = newIdempotencyKey\(\)/.test(b), "must NOT mint a new idempotency key — this is the same attempt, not a new one");
});

test("book.js source: the crafted pending-review message is shown only when paymentStatusPending is set, and matches api/book.js's contract wording", () => {
  const src = readBookJs();
  assert.ok(/Your payment status is being verified\. Please do not submit another payment\./.test(src), "the customer-safe pending-review message must be present");
  assert.ok(/err && err\.paymentStatusPending \? pendingMessage/.test(src), "the message must be selected specifically by the paymentStatusPending flag, not inferred from isServerMessage or any generic non-2xx");
});

test("api/book.js source: paymentStatusPending is set on exactly the three true payment-ambiguous branches, and never alongside retryWithNewPaymentIntent on the same response", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "book.js"), "utf8");
  const pendingCount = (src.match(/paymentStatusPending: true/g) || []).length;
  assert.strictEqual(pendingCount, 3, "expected exactly 3 response sites to set paymentStatusPending: true (existing-row error_pending_review, concurrent-duplicate processing, and the ambiguous capture-throw) — if this changes, update this count deliberately, not by accident");
  const retryCount = (src.match(/retryWithNewPaymentIntent: true/g) || []).length;
  assert.strictEqual(retryCount, 10, "expected exactly the 10 confirmed-dead response sites audited in this session (customer-insert error/catch, rental_payments-insert catch, bookings-insert unique-violation/catch, rental_payments link-back failure, dumpster_rentals-insert failure, capture decline, captured.status!=='succeeded', and intent.status==='canceled') to set retryWithNewPaymentIntent: true — if this changes, update this count deliberately, not by accident");
});

async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.error("FAIL - " + t.name);
      console.error("      " + (err && err.message ? err.message : err));
      if (err && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
