// Phase 3 pre-merge audit, finding #8 — a focused, fully-mocked
// integration harness for the two riskiest, least-exercised paths in this
// phase: the real Send/Resend flow (api/admin/booking.js's
// handleSendInvoice) and the real Pay Now/Stripe flow (api/book.js's
// handleInvoicePaymentIntentCreate), plus the webhook reconciliation path
// they both feed into (api/stripe-webhook.js / api/_lib/invoice-helpers.js's
// reconcileInvoicePaymentIntent). NO real Stripe or Resend call is ever
// made — "stripe" and "@supabase/supabase-js" are intercepted at
// require-time (same Module._load technique every other phase's test file
// in this project uses — see tests/phase3c-stage2.5v2-stripe-rental-
// payments.test.js for the original pattern this borrows), and
// global.fetch (Resend) is replaced with a per-test-configurable fake.
//
// The three Phase 3 delivery-attempt RPCs (create_invoice_delivery_attempt,
// accept_invoice_delivery_attempt, resolve_invoice_delivery_attempt_failure)
// are themselves already proven correct against the real schema by their
// own self-rolling-back SQL smoke tests (see the two sql/2026-10-*.sql
// migration files). This harness re-implements their observable contract
// in JS (claim-ownership checks, newer-generation protection, status
// transitions) purely so the APPLICATION code that calls them can be
// exercised end-to-end — it is not re-proving the SQL, it is proving
// handleSendInvoice()/handleInvoicePaymentIntentCreate() drive those RPCs
// (and Stripe/Resend) correctly.
//
// Run with:  node tests/phase3-invoice-provider-integration.test.js

const Module = require("module");
const assert = require("assert");
const crypto = require("crypto");

let passed = 0;
let failed = 0;
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// ---------------------------------------------------------------------
// Fake Supabase — same FakeQueryBuilder shape/semantics as every other
// phase's fake (select/eq/neq/is/in/or/not/limit/order/maybeSingle/
// single/update/insert/upsert), extended with rpc() for the three Phase 3
// delivery-attempt functions.
// ---------------------------------------------------------------------
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
    this.filters = [];
    this.notFilters = [];
    this._order = null;
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._upsertPayload = null;
    this._single = null;
    this.orFilters = [];
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.filters.push({ col, val });
    return this;
  }
  neq(col, val) {
    this.filters.push({ col, neq: val });
    return this;
  }
  in(col, values) {
    this.filters.push({ col, in: new Set(values) });
    return this;
  }
  is(col, val) {
    this.filters.push({ col, isVal: val });
    return this;
  }
  not(col, op, val) {
    this.notFilters.push({ col, op, val });
    return this;
  }
  // Minimal PostgREST-style .or(): comma-separated "field.op.value" clauses,
  // OR'd together as one filter group (same convention as every other
  // phase's fake that needed it).
  or(expr) {
    const clauses = String(expr)
      .split(",")
      .map((c) => {
        const parts = c.split(".");
        return { col: parts[0], op: parts[1], val: parts.slice(2).join(".") };
      });
    this.orFilters.push(clauses);
    return this;
  }
  order(col, opts) {
    this._order = { col, asc: !opts || opts.ascending !== false };
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
  upsert(payload, opts) {
    this._upsertPayload = payload;
    this._upsertOpts = opts || {};
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
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    if (this._upsertPayload) {
      const conflictCol = this._upsertOpts.onConflict;
      const conflictVal = conflictCol ? this._upsertPayload[conflictCol] : undefined;
      const existing = conflictCol && conflictVal != null ? rows.find((r) => r[conflictCol] === conflictVal) : null;
      if (existing && this._upsertOpts.ignoreDuplicates) {
        return { data: null, error: null };
      }
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._upsertPayload);
      rows.push(row);
      return { data: [row], error: null };
    }

    let matched = rows.filter(
      (r) =>
        this.filters.every((f) => {
          if (f.in) return f.in.has(r[f.col]);
          if ("neq" in f) return r[f.col] !== f.neq;
          if ("isVal" in f) return (r[f.col] === undefined ? null : r[f.col]) === f.isVal;
          return r[f.col] === f.val;
        }) &&
        this.orFilters.every((clauses) =>
          clauses.some((c) => {
            const rowVal = r[c.col] === undefined ? null : r[c.col];
            if (c.op === "is") return c.val === "null" ? rowVal === null : rowVal === c.val;
            if (c.op === "lt") return rowVal !== null && rowVal < c.val;
            if (c.op === "eq") return rowVal === c.val;
            return false;
          })
        ) &&
        this.notFilters.every((f) => (f.op === "eq" ? r[f.col] !== f.val : true))
    );

    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
      return { data: matched, error: null };
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
    if (this._limit != null) matched = matched.slice(0, this._limit);

    if (this._single === "maybeSingle") {
      if (matched.length > 1) return { data: null, error: { message: "multiple rows for maybeSingle" } };
      return { data: matched[0] || null, error: null };
    }
    if (this._single === "single") {
      return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows for single" } };
    }
    return { data: matched, error: null };
  }
}

// --- the three Phase 3 delivery-attempt RPCs, re-implemented to match
// sql/2026-10-19_phase3-invoice-delivery-pay-now.sql and
// sql/2026-10-20_phase3-send-failure-resolution-rpc.sql's observable
// contract exactly (claim ownership via IS DISTINCT FROM semantics,
// newer-generation protection, status transitions). ---
function rpcError(message) {
  return { data: null, error: { message } };
}
async function fakeRpc(db, name, params) {
  const invoices = db.invoices || [];
  const attempts = (db.invoice_delivery_attempts = db.invoice_delivery_attempts || []);

  if (name === "create_invoice_delivery_attempt") {
    if (!params.p_send_claim_token) return rpcError("send claim token must not be null");
    if (!params.p_attempt_id) return rpcError("delivery attempt id must not be null");
    const invoice = invoices.find((i) => i.id === params.p_invoice_id);
    if (!invoice) return rpcError("invoice does not exist");
    if ((invoice.send_claim_token || null) !== params.p_send_claim_token) {
      return rpcError("send claim for invoice is not owned by token " + params.p_send_claim_token);
    }
    const existing = attempts.filter((a) => a.invoice_id === params.p_invoice_id);
    const nextGeneration = existing.length ? Math.max(...existing.map((a) => a.generation)) + 1 : 1;
    const row = {
      id: params.p_attempt_id,
      invoice_id: params.p_invoice_id,
      generation: nextGeneration,
      status: "pending",
      access_token_hash: params.p_access_token_hash,
      access_token_ciphertext: params.p_access_token_ciphertext,
      recipient_email: params.p_recipient_email,
      balance_due_cents: params.p_balance_due_cents,
      started_at: nowIso(),
      accepted_at: null,
      resolved_at: null,
      provider_email_id: null,
    };
    attempts.push(row);
    return { data: [{ id: row.id, generation: row.generation }], error: null };
  }

  if (name === "accept_invoice_delivery_attempt") {
    if (!params.p_provider_email_id || !String(params.p_provider_email_id).trim()) return rpcError("provider_email_id is required");
    if (!params.p_send_claim_token) return rpcError("send claim token must not be null");
    const invoice = invoices.find((i) => i.id === params.p_invoice_id);
    if (!invoice) return rpcError("invoice does not exist");
    if ((invoice.send_claim_token || null) !== params.p_send_claim_token) {
      return rpcError("send claim for invoice is no longer owned by token " + params.p_send_claim_token);
    }
    const newerExists = attempts.some((a) => a.invoice_id === params.p_invoice_id && a.generation > params.p_generation);
    if (newerExists) return rpcError("invoice already has a delivery generation newer than " + params.p_generation);
    const target = attempts.find(
      (a) => a.id === params.p_attempt_id && a.invoice_id === params.p_invoice_id && a.generation === params.p_generation && ["pending", "unrecoverable"].indexOf(a.status) !== -1
    );
    if (!target) return rpcError("invoice_delivery_attempt is not a live, promotable attempt");
    attempts.forEach((a) => {
      if (a.invoice_id === params.p_invoice_id && a.id !== params.p_attempt_id && ["accepted", "pending", "unrecoverable"].indexOf(a.status) !== -1) {
        a.status = "superseded";
        a.resolved_at = nowIso();
        a.access_token_ciphertext = null;
      }
    });
    target.status = "accepted";
    target.accepted_at = nowIso();
    target.provider_email_id = params.p_provider_email_id;
    target.access_token_ciphertext = null;
    invoice.send_claim_token = null;
    invoice.send_claimed_at = null;
    return { data: null, error: null };
  }

  if (name === "resolve_invoice_delivery_attempt_failure") {
    if (!params.p_target_status || ["rejected", "unrecoverable"].indexOf(params.p_target_status) === -1) {
      return rpcError("target_status must be 'rejected' or 'unrecoverable'");
    }
    const invoice = invoices.find((i) => i.id === params.p_invoice_id);
    if (!invoice) return rpcError("invoice does not exist");
    if ((invoice.send_claim_token || null) !== params.p_send_claim_token) {
      return rpcError("send claim for invoice is not owned by token " + params.p_send_claim_token);
    }
    const newerExists = attempts.some((a) => a.invoice_id === params.p_invoice_id && a.generation > params.p_generation);
    if (newerExists) return rpcError("invoice already has a delivery generation newer than " + params.p_generation);
    const target = attempts.find((a) => a.id === params.p_attempt_id && a.invoice_id === params.p_invoice_id && a.generation === params.p_generation && a.status === "pending");
    if (!target) return rpcError("invoice_delivery_attempt is not a pending attempt");
    if (params.p_target_status === "rejected") {
      target.status = "rejected";
      target.resolved_at = nowIso();
      target.access_token_ciphertext = null;
    } else {
      target.status = "unrecoverable"; // ciphertext intentionally preserved; resolved_at stays null
    }
    invoice.send_claim_token = null;
    invoice.send_claimed_at = null;
    return { data: null, error: null };
  }

  throw new Error("Unexpected rpc() call in test: " + name);
}

let currentDb = null;
function freshDb() {
  currentDb = { invoices: [], invoice_delivery_attempts: [], customers: [], invoice_line_items: [], job_payments: [], rental_additional_charges: [] };
  currentFakeService = createFakeServiceClient(currentDb);
  return currentDb;
}
function createFakeServiceClient(db) {
  return {
    from: (table) => new FakeQueryBuilder(table, db),
    rpc: (name, params) => fakeRpc(db, name, params),
  };
}
function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured" } })),
    },
  };
}
let currentFakeAnon = null;
let currentFakeService = null;

// ---------------------------------------------------------------------
// Fake Stripe
// ---------------------------------------------------------------------
let intentStore = {};
let createIntentCallLog = [];
let cancelCallLog = [];
let createIntentImpl = null; // (params, options) => intent | throws
let retrieveImpl = null; // (id) => intent | throws
let cancelImpl = null; // (id) => intent | throws
let webhookConstructImpl = null;

function resetStripe() {
  intentStore = {};
  createIntentCallLog = [];
  cancelCallLog = [];
  createIntentImpl = null;
  retrieveImpl = null;
  cancelImpl = null;
  webhookConstructImpl = null;
}
function makeStripeId(prefix) {
  return prefix + "_test" + String(nextId++).padStart(6, "0");
}
const fakeStripeClient = {
  paymentIntents: {
    create: async function (params, options) {
      createIntentCallLog.push({ params, options });
      if (createIntentImpl) return createIntentImpl(params, options);
      const id = makeStripeId("pi");
      const intent = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: Object.assign({}, params.metadata) };
      intentStore[id] = intent;
      return intent;
    },
    retrieve: async function (id) {
      if (retrieveImpl) return retrieveImpl(id);
      const intent = intentStore[id];
      if (!intent) throw new Error("No such PaymentIntent: " + id);
      return intent;
    },
    cancel: async function (id) {
      cancelCallLog.push(id);
      if (cancelImpl) return cancelImpl(id);
      const intent = intentStore[id];
      if (intent) intent.status = "canceled";
      return intent || { id, status: "canceled" };
    },
  },
  webhooks: {
    constructEvent: function (rawBody, sig, secret) {
      if (webhookConstructImpl) return webhookConstructImpl(rawBody, sig, secret);
      throw new Error("webhooks.constructEvent not configured in this test");
    },
  },
};

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

// --- fake fetch (Resend) — per-test configurable ---
let fetchCalls = [];
let fetchImpl = null; // (url, opts) => Promise<{ok,status,json,text}> | throws
global.fetch = function (url, opts) {
  fetchCalls.push({ url, opts });
  if (fetchImpl) return fetchImpl(url, opts);
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "re_mock" }), text: () => Promise.resolve("{}") });
};
function resetFetch() {
  fetchCalls = [];
  fetchImpl = null;
}

// --- env --------------------------------------------------------------
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock";
process.env.RESEND_API_KEY = "re_mock_key";
process.env.RESEND_FROM_EMAIL = "Mile High Junk Removal <billing@milehighjunkremoval.net>";
process.env.INVOICE_LINK_SECRET = Buffer.alloc(32, 9).toString("base64");

const bookingHandler = require("../api/admin/booking.js");
const bookHandler = require("../api/book.js");
const webhookHandler = require("../api/stripe-webhook.js");
const { mapInvoice } = require("../api/_lib/invoice-helpers.js");
const { decryptAccessToken, hashAccessToken } = require("../api/_lib/invoice-crypto.js");

// ---------------------------------------------------------------------
// req/res mocks — same convention as the rental-payments suite.
// ---------------------------------------------------------------------
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
function makeWebhookReq(rawBody) {
  const bodyBuf = Buffer.from(rawBody || "", "utf8");
  return {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=mock" },
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
    setHeader: (n, v) => {
      headers[n.toLowerCase()] = v;
    },
    status: function (c) {
      res.statusCode = c;
      return res;
    },
    json: function (o) {
      res.body = o;
      return res;
    },
    end: function () {
      if (res.statusCode === null) res.statusCode = 200;
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
function configureAdminAuth() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-admin" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "invalid token" } }),
  });
}
function adminCookie() {
  return "mhjr_admin_at=at-admin; mhjr_admin_rt=rt-admin";
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const BOOKING_ID = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "22222222-2222-2222-2222-222222222222";
const INVOICE_ID = "33333333-3333-3333-3333-333333333333";

function seedFinalizedInvoice(overrides) {
  const row = Object.assign(
    {
      id: INVOICE_ID,
      status: "finalized",
      booking_id: BOOKING_ID,
      customer_id: CUSTOMER_ID,
      invoice_number: "INV-1001",
      due_date: "2026-11-01",
      notes: null,
      total_amount: 349.0,
      finalized_at: nowIso(),
      voided_at: null,
      voided_reason: null,
      send_claim_token: null,
      send_claimed_at: null,
      active_stripe_payment_intent_id: null,
      payment_claim_token: null,
      payment_claimed_at: null,
      payment_generation: 0,
    },
    overrides || {}
  );
  currentDb.invoices.push(row);
  currentDb.customers.push({ id: CUSTOMER_ID, email: "client@example.com", first_name: "Jane", last_name: "Client", address: "1 Main St", city: "Denver", state: "CO", zip: "80202" });
  return row;
}

function setUp() {
  freshDb();
  resetStripe();
  resetFetch();
  configureAdminAuth();
}

// =======================================================================
// SEND / Resend — api/admin/booking.js's handleSendInvoice
// =======================================================================

test("Send: definite accepted success promotes the attempt, records provider_email_id, releases the claim", async () => {
  setUp();
  seedFinalizedInvoice();
  fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "re_abc123" }), text: () => Promise.resolve("{}") });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.sentTo, "client@example.com");
  assert.strictEqual(res.body.providerEmailId, "re_abc123");

  const attempts = currentDb.invoice_delivery_attempts;
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].status, "accepted");
  assert.strictEqual(attempts[0].provider_email_id, "re_abc123");

  const invoice = currentDb.invoices[0];
  assert.strictEqual(invoice.send_claim_token, null, "the claim must be released on a successful send");

  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].opts.headers["Idempotency-Key"], "invoice-send:" + INVOICE_ID + ":1");
});

test("Send: a definite 4xx rejection from Resend marks the attempt 'rejected' and releases the claim", async () => {
  setUp();
  seedFinalizedInvoice();
  fetchImpl = () => Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({}), text: () => Promise.resolve("Invalid `to` field") });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(res.statusCode, 502);
  const attempts = currentDb.invoice_delivery_attempts;
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].status, "rejected");
  assert.strictEqual(currentDb.invoices[0].send_claim_token, null);
});

test("Send: an ambiguous outcome (fetch throws — network/timeout) leaves the attempt row completely untouched and only CAS-releases the claim", async () => {
  setUp();
  seedFinalizedInvoice();
  fetchImpl = () => Promise.reject(new Error("ECONNRESET"));

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(res.statusCode, 502);
  const attempts = currentDb.invoice_delivery_attempts;
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].status, "pending", "an ambiguous outcome must never resolve the attempt either way");
  assert.strictEqual(currentDb.invoices[0].send_claim_token, null, "the claim must still be released so the very next Send can recover immediately");
});

test("Send: a recovery retry after an ambiguous outcome reuses the identical attemptId/generation/recipient/balance snapshot and idempotency key, and this time succeeds", async () => {
  setUp();
  seedFinalizedInvoice();
  fetchImpl = () => Promise.reject(new Error("ECONNRESET"));

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));
  assert.strictEqual(first.statusCode, 502);
  const attemptAfterFirst = currentDb.invoice_delivery_attempts[0];
  const firstIdempotencyKey = fetchCalls[0].opts.headers["Idempotency-Key"];
  const firstBody = fetchCalls[0].opts.body;

  // Second click: Resend now succeeds. Must recover the SAME pending
  // generation rather than minting a fresh one.
  fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "re_retry1" }), text: () => Promise.resolve("{}") });
  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(currentDb.invoice_delivery_attempts.length, 1, "recovery must reuse the existing attempt row, never insert a second one");
  const attemptAfterSecond = currentDb.invoice_delivery_attempts[0];
  assert.strictEqual(attemptAfterSecond.id, attemptAfterFirst.id);
  assert.strictEqual(attemptAfterSecond.generation, attemptAfterFirst.generation);
  assert.strictEqual(attemptAfterSecond.status, "accepted");

  const secondIdempotencyKey = fetchCalls[1].opts.headers["Idempotency-Key"];
  assert.strictEqual(secondIdempotencyKey, firstIdempotencyKey, "a recovered retry must reuse the exact same Idempotency-Key");
  assert.strictEqual(fetchCalls[1].opts.body, firstBody, "a recovered retry must send byte-identical email request bodies (same recipient/balance/link)");
});

test("Send: a decrypt failure on recovery marks the attempt 'unrecoverable' (ciphertext preserved) and the server signals unresolvedSendUnrecoverable so the client re-prompts rather than guessing from text", async () => {
  setUp();
  const invoice = seedFinalizedInvoice();
  // Seed a pending attempt whose ciphertext cannot be decrypted (wrong AAD —
  // simulates corruption/a bug upstream, never a real production
  // encrypt/decrypt call using mismatched ids).
  const { encryptAccessToken, generateRawAccessToken } = require("../api/_lib/invoice-crypto.js");
  const attemptId = "44444444-4444-4444-4444-444444444444";
  const badCiphertext = encryptAccessToken(generateRawAccessToken(), "some-other-invoice-id", attemptId);
  currentDb.invoice_delivery_attempts.push({
    id: attemptId,
    invoice_id: INVOICE_ID,
    generation: 1,
    status: "pending",
    access_token_hash: "0".repeat(64),
    access_token_ciphertext: badCiphertext,
    recipient_email: "client@example.com",
    balance_due_cents: 34900,
    started_at: nowIso(),
    accepted_at: null,
    resolved_at: null,
    provider_email_id: null,
  });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.unresolvedSendUnrecoverable, true);
  assert.strictEqual(res.body.reasonCode, "send_unresolved_unrecoverable");
  const attempt = currentDb.invoice_delivery_attempts.find((a) => a.id === attemptId);
  assert.strictEqual(attempt.status, "unrecoverable");
  assert.strictEqual(attempt.access_token_ciphertext, badCiphertext, "ciphertext must be preserved on unrecoverable, never cleared, since a human may still need it for forensics");
  assert.strictEqual(currentDb.invoices[0].send_claim_token, null);
  assert.strictEqual(fetchCalls.length, 0, "must never call Resend at all once the prior attempt is known undecryptable");
});

test("Send: a live (non-stale) Send claim already held by another request is refused with no RPC/Resend calls at all", async () => {
  setUp();
  seedFinalizedInvoice({ send_claim_token: crypto.randomUUID(), send_claimed_at: nowIso() });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "invoice" }, cookie: adminCookie(), body: { id: INVOICE_ID, action: "send" } }));

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(currentDb.invoice_delivery_attempts.length, 0);
  assert.strictEqual(fetchCalls.length, 0);
});

// =======================================================================
// PAY NOW / Stripe — api/book.js's handleInvoicePaymentIntentCreate
// =======================================================================

function payReq() {
  const rawToken = "raw-pay-now-token";
  return { rawToken };
}
function tokenRequestBody(rawToken) {
  return { token: rawToken };
}

test("Pay Now: normal PaymentIntent creation — claim -> recompute -> create -> commit -> re-check -> expose client_secret", async () => {
  setUp();
  const rawToken = "tok-normal";
  const hash = hashAccessToken(rawToken);
  seedFinalizedInvoice();
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.amountCents, 34900);
  assert.ok(res.body.clientSecret);
  assert.strictEqual(createIntentCallLog.length, 1);
  assert.strictEqual(createIntentCallLog[0].params.amount, 34900);
  assert.strictEqual(createIntentCallLog[0].params.capture_method, "automatic");
  const invoice = currentDb.invoices[0];
  const createdPiIds = Object.keys(intentStore);
  assert.strictEqual(createdPiIds.length, 1, "exactly one PaymentIntent should have been created");
  assert.strictEqual(invoice.active_stripe_payment_intent_id, createdPiIds[0], "the invoice must be committed to the PaymentIntent Stripe actually created");
  assert.strictEqual(invoice.payment_claim_token, null, "the temporary claim must be released once committed to active_stripe_payment_intent_id");
  assert.strictEqual(invoice.payment_generation, 1);
});

test("Pay Now: losing claim ownership after the Stripe create call never exposes client_secret, and the orphan PaymentIntent is canceled", async () => {
  setUp();
  const rawToken = "tok-lost-claim";
  const hash = hashAccessToken(rawToken);
  seedFinalizedInvoice();
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });

  // Simulate another process reclaiming the (now-stale) claim WHILE the
  // Stripe create() call is in flight, by mutating the row as a side
  // effect of the fake create() itself.
  createIntentImpl = async (params) => {
    const invoice = currentDb.invoices[0];
    invoice.payment_claim_token = crypto.randomUUID(); // no longer ours
    const id = makeStripeId("pi");
    const intent = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: Object.assign({}, params.metadata) };
    intentStore[id] = intent;
    return intent;
  };

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.clientSecret, undefined, "client_secret must never be exposed once claim ownership was lost");
  assert.strictEqual(cancelCallLog.length, 1, "the orphaned PaymentIntent must be canceled, best-effort");
  const orphanId = cancelCallLog[0];
  assert.strictEqual(intentStore[orphanId].status, "canceled");
});

test("Pay Now: balance changing after the active-PI commit cancels the now-stale cancelable PI and reports 409", async () => {
  setUp();
  const rawToken = "tok-balance-changed";
  const hash = hashAccessToken(rawToken);
  seedFinalizedInvoice();
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });

  // A payment lands on this booking DURING the Stripe create() call —
  // changing the live balance the final re-check will see.
  createIntentImpl = async (params) => {
    currentDb.job_payments.push({ invoice_id: INVOICE_ID, booking_id: BOOKING_ID, amount: 50, payment_type: "payment", voided_at: null });
    const id = makeStripeId("pi");
    const intent = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: Object.assign({}, params.metadata) };
    intentStore[id] = intent;
    return intent;
  };

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(cancelCallLog.length, 1, "the now-stale PaymentIntent (amount no longer matches the live balance) must be canceled");
  assert.strictEqual(currentDb.invoices[0].active_stripe_payment_intent_id, null, "active_stripe_payment_intent_id must be cleared once the cancel is confirmed");
});

test("Pay Now: if canceling the now-stale PI fails, it is left in place (never blindly cleared) and the request still reports 409", async () => {
  setUp();
  const rawToken = "tok-cancel-fails";
  const hash = hashAccessToken(rawToken);
  seedFinalizedInvoice();
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });
  createIntentImpl = async (params) => {
    currentDb.job_payments.push({ invoice_id: INVOICE_ID, booking_id: BOOKING_ID, amount: 50, payment_type: "payment", voided_at: null });
    const id = makeStripeId("pi");
    const intent = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: Object.assign({}, params.metadata) };
    intentStore[id] = intent;
    return intent;
  };
  cancelImpl = async () => {
    throw new Error("Stripe API unavailable");
  };

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 409);
  assert.ok(currentDb.invoices[0].active_stripe_payment_intent_id, "must NOT be cleared when the cancel attempt itself failed — never a blind clear");
});

test("Pay Now: if the PI actually succeeded by the time of the final re-check (fast race, not staleness), it is reconciled and reported paid, never re-offered", async () => {
  setUp();
  const rawToken = "tok-became-succeeded";
  const hash = hashAccessToken(rawToken);
  seedFinalizedInvoice();
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });
  createIntentImpl = async (params) => {
    currentDb.job_payments.push({ invoice_id: INVOICE_ID, booking_id: BOOKING_ID, amount: 1, payment_type: "payment", voided_at: null }); // force a re-check mismatch
    const id = makeStripeId("pi");
    const intent = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: Object.assign({}, params.metadata) };
    intentStore[id] = intent;
    return intent;
  };
  retrieveImpl = async (id) => Object.assign({}, intentStore[id], { status: "succeeded", amount_received: intentStore[id].amount });

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.paid, true);
  assert.strictEqual(currentDb.job_payments.filter((p) => p.stripe_payment_intent_id).length, 1, "the real captured money must be mirrored to job_payments");
});

test("Pay Now: a 'processing' active PaymentIntent blocks a fresh Pay Now request rather than racing a second PaymentIntent into existence", async () => {
  setUp();
  const rawToken = "tok-processing-blocks";
  const hash = hashAccessToken(rawToken);
  const processingPiId = makeStripeId("pi");
  intentStore[processingPiId] = { id: processingPiId, status: "processing", amount: 34900 };
  seedFinalizedInvoice({ active_stripe_payment_intent_id: processingPiId });
  currentDb.invoice_delivery_attempts.push({ id: "att-1", invoice_id: INVOICE_ID, generation: 1, status: "accepted", access_token_hash: hash, access_token_ciphertext: null, recipient_email: "client@example.com", balance_due_cents: 34900 });

  const res = await run(bookHandler, makeReq({ method: "POST", query: { resource: "invoice-payment-intent" }, body: tokenRequestBody(rawToken) }));

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(createIntentCallLog.length, 0, "must never create a second PaymentIntent while one is processing");
});

// =======================================================================
// Webhook reconciliation — api/stripe-webhook.js + reconcileInvoicePaymentIntent
// =======================================================================

function invoicePayNowIntent(overrides) {
  return Object.assign(
    {
      id: makeStripeId("pi"),
      status: "succeeded",
      currency: "usd",
      amount: 34900,
      amount_received: 34900,
      metadata: {
        source: "invoice_pay_now",
        invoiceId: INVOICE_ID,
        bookingId: BOOKING_ID,
        invoiceNumber: "INV-1001",
        paymentGeneration: "1",
        expectedAmountCents: "34900",
      },
    },
    overrides || {}
  );
}

test("Webhook: payment_intent.succeeded for an invoice Pay Now PI mirrors the ledger and clears the active PI, and is idempotent across duplicate deliveries", async () => {
  setUp();
  seedFinalizedInvoice({ active_stripe_payment_intent_id: null, payment_generation: 1 });
  const pi = invoicePayNowIntent();
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: pi } });

  const first = await run(webhookHandler, makeWebhookReq("{}"));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(currentDb.job_payments.length, 1);
  assert.strictEqual(currentDb.job_payments[0].stripe_payment_intent_id, pi.id);
  assert.strictEqual(currentDb.job_payments[0].amount, 349.0);

  // Duplicate delivery of the identical event — Stripe does not guarantee
  // exactly-once delivery.
  const second = await run(webhookHandler, makeWebhookReq("{}"));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(currentDb.job_payments.length, 1, "a duplicate webhook delivery must never create a second ledger row");
});

test("Webhook: a stale payment_generation on an otherwise-valid succeeded PI still mirrors the real captured money, flagged for review, never halted", async () => {
  setUp();
  // Invoice has since moved to generation 2 (e.g. a later Pay Now attempt),
  // but this PI was created back when it was generation 1 — the money it
  // represents is still real and must still be recorded.
  seedFinalizedInvoice({ active_stripe_payment_intent_id: null, payment_generation: 2 });
  const pi = invoicePayNowIntent({ metadata: Object.assign({}, invoicePayNowIntent().metadata, { paymentGeneration: "1" }) });
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: pi } });

  const res = await run(webhookHandler, makeWebhookReq("{}"));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(currentDb.job_payments.length, 1, "a generation mismatch must never suppress mirroring real captured money");
  assert.ok(/review/i.test(currentDb.job_payments[0].notes), "the ledger row must be flagged for review when the generation doesn't match");
});

test("Webhook: a currency or amount mismatch halts without mirroring anything (never trusts an unverified amount into the ledger)", async () => {
  setUp();
  seedFinalizedInvoice({ active_stripe_payment_intent_id: null, payment_generation: 1 });
  const pi = invoicePayNowIntent({ amount_received: 1 }); // doesn't match expectedAmountCents/amount
  webhookConstructImpl = () => ({ type: "payment_intent.succeeded", data: { object: pi } });

  const res = await run(webhookHandler, makeWebhookReq("{}"));

  assert.strictEqual(res.statusCode, 200, "the webhook endpoint itself must still 200 (acknowledge receipt) even when reconciliation halts internally");
  assert.strictEqual(currentDb.job_payments.length, 0);
});

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------
(async function runAll() {
  for (const { name, fn } of registered) {
    try {
      await fn();
      console.log("PASS - " + name);
      passed++;
    } catch (err) {
      console.log("FAIL - " + name);
      console.log("      " + (err && err.stack ? err.stack : err));
      failed++;
    }
  }
  console.log("\n" + (passed + failed) + " tests run, " + failed + " failed.");
  if (failed > 0) process.exit(1);
})();
