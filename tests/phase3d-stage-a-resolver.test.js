// Phase 3D Stage A — targeted audit for resolveJobPaymentAttribution()
// and the idempotency of mirrorStripePaymentToLedger()'s upsert, given
// that Stage A's migration (sql/2026-10-21_phase3d-stage-a-invoice-
// attribution-compat.sql) deliberately leaves service_role with NO
// UPDATE grant on job_payments.invoice_id or job_payments.
// invoice_id_classified. This file proves the duplicate-PaymentIntent
// path never needs that privilege, and exercises the five documented
// resolver cases directly, each against a minimal, purpose-built fake
// (not the shared harness in tests/phase3c-stage3-job-payments.test.js,
// since these are plain dependency-injected functions that take
// `supabase` as an argument — no module interception needed).
//
// Run with:  node tests/phase3d-stage-a-resolver.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const { resolveJobPaymentAttribution, mirrorStripePaymentToLedger } = require("../api/_lib/job-payments-ledger.js");

let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(100000000000 + nextId++).padStart(12, "0");
}

// Minimal fake for the "invoices" table — only the methods
// resolveJobPaymentAttribution() actually calls: select/eq/neq/maybeSingle.
class FakeInvoicesTable {
  constructor(rows) {
    this.rows = rows;
    this._eq = [];
    this._neq = [];
  }
  select() {
    return this;
  }
  eq(col, val) {
    this._eq.push([col, val]);
    return this;
  }
  neq(col, val) {
    this._neq.push([col, val]);
    return this;
  }
  async maybeSingle() {
    const matched = this.rows.filter((r) => this._eq.every(([c, v]) => r[c] === v) && this._neq.every(([c, v]) => r[c] !== v));
    return { data: matched[0] || null, error: null };
  }
}

// Fake for the "job_payments" table, modeling the TWO real-world facts
// this audit depends on:
//   - upsert({onConflict, ignoreDuplicates:true}) on an existing
//     conflicting row is a genuine ON CONFLICT DO NOTHING — the existing
//     row is returned untouched, never merged with the new payload. This
//     mirrors the installed @supabase/supabase-js source directly (see
//     the PR/review notes: ignoreDuplicates:true sets
//     `Prefer: resolution=ignore-duplicates`, which PostgREST turns into
//     DO NOTHING, never DO UPDATE).
//   - update() touching invoice_id/invoice_id_classified simulates the
//     real column-privilege denial Stage A's grants enforce (service_role
//     has no UPDATE on either column). mirrorStripePaymentToLedger()
//     never calls update() at all (confirmed below, behaviorally, not
//     just by reading the source) — this exists purely so a future
//     regression that swapped the upsert for a real UPDATE would fail
//     loudly here instead of silently passing.
class FakeJobPaymentsTable {
  constructor(rows) {
    this.rows = rows;
  }
  update(payload) {
    const deniedCols = ["invoice_id", "invoice_id_classified"];
    const touched = Object.keys(payload).filter((k) => deniedCols.indexOf(k) !== -1);
    const self = this;
    return {
      eq() {
        if (touched.length) {
          return Promise.resolve({ data: null, error: { code: "42501", message: "permission denied for column(s) " + touched.join(", ") } });
        }
        return Promise.resolve({ data: [], error: null });
      },
    };
  }
  upsert(payload, opts) {
    opts = opts || {};
    const conflictCol = opts.onConflict;
    const existing = conflictCol && payload[conflictCol] != null ? this.rows.find((r) => r[conflictCol] === payload[conflictCol]) : null;
    if (existing) {
      if (opts.ignoreDuplicates) {
        // True DO NOTHING — existing row is returned exactly as it already
        // was; the newly-computed payload (which may differ, e.g. a
        // changed invoice_id resolution) is discarded, never merged in.
        return Promise.resolve({ data: null, error: null });
      }
      Object.assign(existing, payload);
      return Promise.resolve({ data: [existing], error: null });
    }
    const row = Object.assign({ id: makeId(), created_at: new Date().toISOString() }, payload);
    this.rows.push(row);
    return Promise.resolve({ data: [row], error: null });
  }
}

function makeFakeSupabase({ invoices, jobPayments }) {
  invoices = invoices || [];
  jobPayments = jobPayments || [];
  return {
    from(table) {
      if (table === "invoices") return new FakeInvoicesTable(invoices);
      if (table === "job_payments") return new FakeJobPaymentsTable(jobPayments);
      throw new Error("unexpected table in test fake: " + table);
    },
  };
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// resolveJobPaymentAttribution() — the five documented cases
// =======================================================================

test("resolveJobPaymentAttribution: booking with a live original invoice resolves to that invoice", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: invoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId });
  assert.deepStrictEqual(result, { invoiceId, bookingId });
});

test("resolveJobPaymentAttribution: booking with no invoice at all resolves to invoiceId null", async () => {
  const bookingId = makeId();
  const supabase = makeFakeSupabase({ invoices: [] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId });
  assert.deepStrictEqual(result, { invoiceId: null, bookingId });
});

test("resolveJobPaymentAttribution: an explicit invoiceId short-circuits — never consults the booking lookup, even when the booking has its own different live original invoice", async () => {
  const bookingId = makeId();
  const bookingsOwnInvoiceId = makeId();
  const explicitInvoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: bookingsOwnInvoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId, explicitInvoiceId });
  assert.deepStrictEqual(result, { invoiceId: explicitInvoiceId, bookingId });
  assert.notStrictEqual(result.invoiceId, bookingsOwnInvoiceId, "must not have fallen back to the booking's own invoice");
});

test("resolveJobPaymentAttribution: a void invoice is never selected by the booking lookup", async () => {
  const bookingId = makeId();
  const voidInvoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: voidInvoiceId, booking_id: bookingId, status: "void", invoice_kind: "original" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId });
  assert.deepStrictEqual(result, { invoiceId: null, bookingId });
});

test("resolveJobPaymentAttribution: a supplemental invoice is never selected by the booking lookup (original-only, by design)", async () => {
  const bookingId = makeId();
  const supplementalInvoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: supplementalInvoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "supplemental" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId });
  assert.deepStrictEqual(result, { invoiceId: null, bookingId });
});

// =======================================================================
// mirrorStripePaymentToLedger() — upsert idempotency / privilege audit
// =======================================================================

test("mirrorStripePaymentToLedger: upsert is called with exactly {onConflict:'stripe_payment_intent_id', ignoreDuplicates:true} — the options that map to a real ON CONFLICT DO NOTHING, never DO UPDATE", async () => {
  const bookingId = makeId();
  const jobPayments = [];
  const supabase = makeFakeSupabase({ invoices: [], jobPayments });
  let capturedOpts = null;
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const builder = realFrom(table);
    if (table === "job_payments") {
      const realUpsert = builder.upsert.bind(builder);
      builder.upsert = (payload, opts) => {
        capturedOpts = opts;
        return realUpsert(payload, opts);
      };
    }
    return builder;
  };
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_opts_check", amount: 10 });
  assert.deepStrictEqual(capturedOpts, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true });
});

test("mirrorStripePaymentToLedger: first mirror inserts successfully; duplicate PI idempotently no-ops; exactly one row remains; original invoice_id/invoice_id_classified stay correct even if attribution context changes between calls", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const jobPayments = [];
  const invoices = [{ id: invoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }];
  const supabase = makeFakeSupabase({ invoices, jobPayments });

  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_1", amount: 200 });
  assert.strictEqual(jobPayments.length, 1, "first mirror must insert exactly one row");
  const firstRow = jobPayments[0];
  assert.strictEqual(firstRow.invoice_id, invoiceId, "first row must carry the live original invoice's id");
  assert.strictEqual(firstRow.invoice_id_classified, true, "first row must be classified");

  // Simulate the invoice context changing between calls (e.g. the
  // invoice is voided, or this is the "payment written moments before
  // its invoice" race) — if the upsert were anything other than a true
  // DO NOTHING, the second call's own (now different) attribution
  // result could leak into the already-written row. It must not.
  invoices.length = 0;

  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_1", amount: 200 });
  assert.strictEqual(jobPayments.length, 1, "exactly one ledger row must remain after the duplicate mirror");
  assert.strictEqual(jobPayments[0], firstRow, "the duplicate call must not have replaced the row object at all");
  assert.strictEqual(jobPayments[0].invoice_id, invoiceId, "invoice_id must remain exactly what the FIRST call wrote");
  assert.strictEqual(jobPayments[0].invoice_id_classified, true, "invoice_id_classified must remain true");
});

test("mirrorStripePaymentToLedger: a duplicate PI never attempts a job_payments .update() at all — the two columns service_role has no UPDATE grant on in Stage A (invoice_id, invoice_id_classified) are never exercised by the idempotent path", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const jobPayments = [];
  const invoices = [{ id: invoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }];

  let updateAttempted = false;
  const supabase = makeFakeSupabase({ invoices, jobPayments });
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const builder = realFrom(table);
    if (table === "job_payments") {
      const realUpdate = builder.update.bind(builder);
      builder.update = (payload) => {
        updateAttempted = true;
        return realUpdate(payload);
      };
    }
    return builder;
  };

  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_2", amount: 50 });
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_2", amount: 50 });

  assert.strictEqual(updateAttempted, false, "mirrorStripePaymentToLedger must never call .update() on job_payments — it relies exclusively on upsert's ON CONFLICT DO NOTHING");
  assert.strictEqual(jobPayments.length, 1);
});

test("mirrorStripePaymentToLedger: an explicit invoiceId (Stripe Pay Now path) is idempotent the same way — duplicate PI leaves exactly one row, invoice_id unchanged from the first write", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const jobPayments = [];
  const supabase = makeFakeSupabase({ invoices: [], jobPayments });

  await mirrorStripePaymentToLedger(supabase, { bookingId, invoiceId, stripePaymentIntentId: "pi_pay_now_1", amount: 75 });
  assert.strictEqual(jobPayments.length, 1);
  assert.strictEqual(jobPayments[0].invoice_id, invoiceId);
  assert.strictEqual(jobPayments[0].invoice_id_classified, true);

  await mirrorStripePaymentToLedger(supabase, { bookingId, invoiceId, stripePaymentIntentId: "pi_pay_now_1", amount: 75 });
  assert.strictEqual(jobPayments.length, 1, "duplicate Pay Now reconciliation must not create a second row");
  assert.strictEqual(jobPayments[0].invoice_id, invoiceId);
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  if (failed) process.exitCode = 1;
}
main();
