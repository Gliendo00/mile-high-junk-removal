// Phase 3D Stage A/B — targeted audit for resolveJobPaymentAttribution()
// and the idempotency of mirrorStripePaymentToLedger()'s upsert.
// service_role has NO UPDATE grant on job_payments.invoice_id or
// job_payments.invoice_id_classified in either stage (Stage B only adds
// booking_id to that grant, for the Attach-to-Job RPC's own backfill —
// see sql/2026-10-21_phase3d-stage-b-invoice-attribution-canonical.sql).
// This file proves the duplicate-PaymentIntent path never needs that
// privilege, and exercises resolveJobPaymentAttribution()'s Stage B
// contract directly (explicitInvoiceId short-circuits; otherwise always
// null — Stage A's "fall back to the booking's live original invoice"
// branch is gone), each against a minimal, purpose-built fake (not the
// shared harness in tests/phase3c-stage3-job-payments.test.js, since
// these are plain dependency-injected functions that take `supabase` as
// an argument — no module interception needed).
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
// resolveJobPaymentAttribution() — Stage B's contract. Stage A's
// "booking with a live original invoice resolves to that invoice" /
// "void invoice never selected" / "supplemental invoice never selected"
// cases are gone along with the lookup branch itself — a generic
// booking payment is unconditionally invoiceId: null now, regardless of
// what invoice(s) exist on that booking. These cases don't even touch
// `supabase` anymore (no query to make), but still pass one in, matching
// every real call site.
// =======================================================================

test("resolveJobPaymentAttribution: no explicitInvoiceId -> invoiceId is always null, even when the booking has a live original invoice (Stage A's lookup branch is gone)", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: invoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId });
  assert.deepStrictEqual(result, { invoiceId: null, bookingId });
});

test("resolveJobPaymentAttribution: no explicitInvoiceId and no bookingId -> both null", async () => {
  const supabase = makeFakeSupabase({ invoices: [] });
  const result = await resolveJobPaymentAttribution(supabase, {});
  assert.deepStrictEqual(result, { invoiceId: null, bookingId: null });
});

test("resolveJobPaymentAttribution: an explicit invoiceId short-circuits — passed straight through, bookingId passed through unchanged alongside it", async () => {
  const bookingId = makeId();
  const bookingsOwnInvoiceId = makeId();
  const explicitInvoiceId = makeId();
  const supabase = makeFakeSupabase({ invoices: [{ id: bookingsOwnInvoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }] });
  const result = await resolveJobPaymentAttribution(supabase, { bookingId, explicitInvoiceId });
  assert.deepStrictEqual(result, { invoiceId: explicitInvoiceId, bookingId });
  assert.notStrictEqual(result.invoiceId, bookingsOwnInvoiceId, "must not have fallen back to the booking's own invoice");
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

test("mirrorStripePaymentToLedger: first mirror inserts successfully; duplicate PI idempotently no-ops; exactly one row remains; invoice_id stays null throughout — a generic mirror (no explicit invoiceId) never picks up a booking's invoice, Stage A's lookup branch or not", async () => {
  const bookingId = makeId();
  const invoiceId = makeId();
  const jobPayments = [];
  // This booking DOES have a live original invoice — under Stage A this
  // would have been auto-attributed; under Stage B it must be ignored
  // entirely by a generic (no explicitInvoiceId) mirror call.
  const invoices = [{ id: invoiceId, booking_id: bookingId, status: "finalized", invoice_kind: "original" }];
  const supabase = makeFakeSupabase({ invoices, jobPayments });

  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_1", amount: 200 });
  assert.strictEqual(jobPayments.length, 1, "first mirror must insert exactly one row");
  const firstRow = jobPayments[0];
  assert.strictEqual(firstRow.invoice_id, null, "a generic mirror must never attribute to the booking's invoice, even though one exists");
  assert.strictEqual(firstRow.invoice_id_classified, true, "first row must still be classified");

  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_idempotent_1", amount: 200 });
  assert.strictEqual(jobPayments.length, 1, "exactly one ledger row must remain after the duplicate mirror");
  assert.strictEqual(jobPayments[0], firstRow, "the duplicate call must not have replaced the row object at all");
  assert.strictEqual(jobPayments[0].invoice_id, null);
  assert.strictEqual(jobPayments[0].invoice_id_classified, true);
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
