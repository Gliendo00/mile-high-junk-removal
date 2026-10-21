// Vercel serverless function — Stripe webhook receiver for the
// dumpster-rental payment feature (Phase 3C Stage 2.5-v2). Replaces
// api/braintree-webhook.js (removed — this feature switched from Braintree
// to Stripe before any production rollout; see
// docs/phase-3/stage2.5-stripe-rental-payments-migration.md). Same file
// count (12/12) — this endpoint takes the slot the Braintree webhook used
// to occupy, it isn't an additional function.
//
// Unlike Braintree's card/Venmo settlement webhooks (documented dead code
// for this app — see the removed file's history), Stripe's
// payment_intent.succeeded / payment_intent.payment_failed genuinely fire
// for every card/wallet capture this app creates, so this endpoint is a
// REAL reconciliation backstop, not just a dispute notifier:
//
//   - payment_intent.succeeded: if a matching rental_payments or
//     rental_additional_charges row (by stripe_payment_intent_id) isn't
//     already "paid", this self-heals it to "paid" — the one path that can
//     recover a row stuck at "paid_reconciliation_required" (a definite
//     Stripe success whose local confirmation write failed even after
//     retries) or "error_pending_review" (an ambiguous capture call whose
//     outcome is now known) without any human action. Never downgrades an
//     already-"paid" row — event delivery order isn't guaranteed per
//     Stripe's own documentation, so a late/duplicate delivery must be a
//     no-op, not a re-write.
//   - payment_intent.payment_failed: mirrors a definitive decline, but only
//     applied to a row still "processing" or "error_pending_review" — never
//     overwrites an already-"paid" row (an out-of-order/duplicate event
//     must never downgrade a real success).
//   - payment_intent.canceled: informational reconciliation for a hold that
//     was released without ever being captured (this app's own rollback
//     paths already handle the common case synchronously; this is the
//     backstop for anything that cancelled the intent by another path,
//     e.g. Stripe's own authorization-window expiry).
//   - charge.dispute.created / .closed / .funds_withdrawn / .funds_reinstated:
//     the one thing this app has NO other way to learn about — recorded as
//     Stripe's own dispute.status verbatim (informational only; no
//     automated action is ever taken from it).
//   - charge.refunded (Phase 5): backstop for the admin CRM's own
//     synchronous refund flow (handleRefundJobPayment() in
//     api/admin/booking.js) and the only way a refund issued directly in
//     the Stripe Dashboard/API (outside this CRM entirely) ever reaches
//     job_payments. Idempotent the same way payment capture already is —
//     see reconcileRefunded() below. Requires this event type to be
//     enabled on the Stripe webhook endpoint's own configuration in the
//     Stripe Dashboard (not something this codebase controls).
//
// Every write below is an absolute SET-by-stripe_payment_intent_id update
// (never an increment, never "add a new row per event"), so processing the
// same event twice — Stripe explicitly does not guarantee exactly-once
// delivery — lands on the same end state both times and is safe to run
// unconditionally, with no separate dedup/event-log table needed.
//
// Required environment variables: STRIPE_SECRET_KEY (see
// api/_lib/stripe-client.js), STRIPE_WEBHOOK_SECRET (used directly here,
// not through that module — it's for stripe.webhooks.constructEvent(), not
// for constructing a client instance), plus SUPABASE_URL/
// SUPABASE_SECRET_KEY to update payment rows.
//
// Signature verification requires the RAW request body — re-serializing a
// JSON-parsed body can produce different bytes and fail verification (see
// Stripe's own webhook documentation). `module.exports.config` below
// disables Vercel's default JSON body parsing for this one function so the
// raw bytes are read directly from the request stream.
const { getStripeClient } = require("./_lib/stripe-client");
const { getServiceClient } = require("./_lib/supabase-admin");
const { mirrorStripePaymentToLedger, denverTodayIso } = require("./_lib/job-payments-ledger");
const { reconcileInvoicePaymentIntent } = require("./_lib/invoice-helpers");

module.exports.config = { api: { bodyParser: false } };

// Dispute-related webhook kinds this endpoint records (informational
// only — see rental_payments.dispute_status's comment in the migration
// SQL). Every other unrecognized kind is acknowledged with 200 and
// otherwise ignored: this endpoint only needs to react to the events that
// affect a status this CRM displays, not the full Stripe event catalog.
const DISPUTE_EVENT_TYPES = ["charge.dispute.created", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "charge.dispute.updated"];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    console.error("Stripe webhook failed: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not configured");
    res.status(500).end();
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error("Stripe webhook: failed reading raw request body:", err && err.message ? err.message : err);
    res.status(400).json({ error: "Could not read request body." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Includes an invalid/forged signature — the spoofing defense. Nothing
    // below this point ever runs for an event that didn't verify.
    console.error("Stripe webhook: signature verification failed:", err && err.message ? err.message : err);
    res.status(400).json({ error: "Invalid webhook signature." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Stripe webhook failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    // Still 500: Stripe will retry a non-2xx response, and re-processing
    // this same (already-verified) event later is safe per the idempotency
    // note above.
    res.status(500).json({ error: "Storage unavailable." });
    return;
  }

  try {
    await applyEvent(supabase, stripe, event);
  } catch (err) {
    console.error("Stripe webhook: failed applying event (type=" + event.type + "):", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not process webhook." });
    return;
  }

  res.status(200).json({ ok: true });
};

// Reads the exact raw bytes Stripe signed, required because bodyParser is
// disabled above (see this file's header for why).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function applyEvent(supabase, stripe, event) {
  const type = event.type;
  const obj = event.data && event.data.object;

  if (type === "payment_intent.succeeded") {
    const intent = obj;
    if (!intent || !intent.id) return;
    await reconcileSucceeded(supabase, stripe, intent);
    return;
  }

  if (type === "payment_intent.payment_failed") {
    const intent = obj;
    if (!intent || !intent.id) return;
    const reason = (intent.last_payment_error && intent.last_payment_error.message) || "Payment failed.";
    await reconcileFailed(supabase, intent.id, reason);
    return;
  }

  if (type === "payment_intent.canceled") {
    const intent = obj;
    if (!intent || !intent.id) return;
    await reconcileCanceled(supabase, intent.id);
    return;
  }

  if (DISPUTE_EVENT_TYPES.indexOf(type) !== -1) {
    const dispute = obj;
    const paymentIntentId = dispute && dispute.payment_intent;
    if (!paymentIntentId) return;
    await setDisputeStatusByPaymentIntentId(supabase, paymentIntentId, dispute.status || type);
    return;
  }

  // Phase 5 — refund backstop. The admin CRM's own synchronous refund flow
  // (api/admin/booking.js's handleRefundJobPayment()) already writes its
  // ledger row immediately after a confirmed stripe.refunds.create() call,
  // so for a refund issued THROUGH this CRM, the upsert below (same
  // onConflict:"stripe_refund_id", ignoreDuplicates:true shape
  // mirrorStripePaymentToLedger() already uses) is a harmless no-op — the
  // row already exists. This exists for the two cases that path can't
  // cover: (1) a crash between that Stripe call succeeding and its own
  // insert, and (2) a refund issued directly in the Stripe Dashboard/API,
  // completely outside this CRM — this is the ONLY way such a refund ever
  // reaches job_payments at all. A charge can carry more than one refund
  // (multiple partials); every one of them is walked, not just the newest.
  if (type === "charge.refunded") {
    const charge = obj;
    if (!charge || !charge.payment_intent) return;
    await reconcileRefunded(supabase, charge);
    return;
  }

  // Every other webhook kind (charge.succeeded, customer.created, etc. this
  // project doesn't act on) is intentionally a no-op — acknowledged with
  // 200 by the caller, nothing to update.
}

// See the "charge.refunded" branch above for why this exists. Attribution
// (booking_id/invoice_id) is resolved from the ORIGINAL "payment"-typed
// job_payments row for this same PaymentIntent — if none is found (e.g. a
// PaymentIntent this app never captured through its own code at all), the
// refund is logged and skipped rather than guessed at.
async function reconcileRefunded(supabase, charge) {
  const refunds = (charge.refunds && Array.isArray(charge.refunds.data) ? charge.refunds.data : []).filter((r) => r.status === "succeeded");
  if (!refunds.length) return;

  const originalRes = await supabase
    .from("job_payments")
    .select("booking_id, invoice_id")
    .eq("stripe_payment_intent_id", charge.payment_intent)
    .eq("payment_type", "payment")
    .is("voided_at", null)
    .maybeSingle();
  if (originalRes.error) throw originalRes.error;
  if (!originalRes.data) {
    console.error("Stripe webhook: charge.refunded for payment_intent " + charge.payment_intent + " has no matching job_payments row to attribute the refund to — skipped.");
    return;
  }
  const { booking_id: bookingId, invoice_id: invoiceId } = originalRes.data;

  for (const refund of refunds) {
    const { error } = await supabase.from("job_payments").upsert(
      {
        booking_id: bookingId,
        invoice_id: invoiceId,
        invoice_id_classified: true,
        amount: refund.amount / 100,
        payment_method: "card_stripe",
        payment_type: "refund",
        payment_date: denverTodayIso(),
        notes: "Stripe refund" + (refund.reason ? " (" + refund.reason + ")" : "") + ", confirmed via webhook backstop (auto-recorded from Stripe).",
        stripe_refund_id: refund.id,
      },
      { onConflict: "stripe_refund_id", ignoreDuplicates: true }
    );
    if (error) throw error;
  }
}

// Tries rental_payments first (the initial charge), then
// rental_additional_charges (an approved overage/extra-day charge) — a
// given PaymentIntent id can only ever exist in one of the two tables, so
// at most one of these two updates actually matches a row. Never downgrades
// an already-"paid" row (see this file's header for why event ordering
// can't be relied on) — the update is scoped with `.not("payment_status",
// "eq", "paid")` (and the charges-table equivalent) so a late/duplicate
// delivery of an event this app already reconciled synchronously is a
// harmless no-op.
async function reconcileSucceeded(supabase, stripe, intent) {
  // Phase 3 — invoice-originated PaymentIntents are a completely separate
  // source from rental_payments/rental_additional_charges below (their own
  // metadata.source discriminates unambiguously), with their own
  // validation + mirroring + active-PI clearing — see
  // reconcileInvoicePaymentIntent() in api/_lib/invoice-helpers.js. Checked
  // and returned first so the two unrelated tables below are never queried
  // for a PaymentIntent that could never match them anyway.
  if (intent.metadata && intent.metadata.source === "invoice_pay_now") {
    await reconcileInvoicePaymentIntent(supabase, stripe, intent);
    return;
  }

  const methodInfo = extractPaymentMethodSummary(intent.payment_method);

  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({
      payment_status: "paid",
      stripe_payment_intent_id: intent.id,
      stripe_customer_id: intent.customer || null,
      stripe_payment_method_id: methodInfo.id,
      payment_method_summary: methodInfo.summary,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_payment_intent_id", intent.id)
    .not("payment_status", "eq", "paid")
    // Phase 3C Stage 3: booking_id/amount_charged added to this select
    // purely so the ledger-mirror call below (a real backstop for the case
    // where this row's synchronous success path in api/book.js ran but its
    // own mirror call somehow didn't complete) has what it needs, without a
    // second round-trip. Doesn't change what this update itself does.
    .select("id, booking_id, amount_charged");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) {
    const row = paymentUpdate.data[0];
    // paymentDate omitted deliberately — mirrorStripePaymentToLedger()
    // defaults it to today in America/Denver, the same convention every
    // other call site uses explicitly.
    await mirrorStripePaymentToLedger(supabase, {
      bookingId: row.booking_id,
      stripePaymentIntentId: intent.id,
      amount: row.amount_charged,
      notes: "Initial dumpster rental payment, confirmed via webhook backstop (auto-recorded from Stripe).",
    });
    return;
  }

  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ status: "paid", stripe_payment_intent_id: intent.id, failure_reason: null, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", intent.id)
    .not("status", "eq", "paid")
    .select("id, booking_id, amount");
  if (chargeUpdate.error) throw chargeUpdate.error;
  if (Array.isArray(chargeUpdate.data) && chargeUpdate.data.length > 0) {
    const row = chargeUpdate.data[0];
    await mirrorStripePaymentToLedger(supabase, {
      bookingId: row.booking_id,
      stripePaymentIntentId: intent.id,
      amount: row.amount,
      notes: "Approved additional charge, confirmed via webhook backstop (auto-recorded from Stripe).",
    });
  }
}

async function reconcileFailed(supabase, paymentIntentId, reason) {
  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({ payment_status: "failed", failure_reason: reason, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .in("payment_status", ["processing", "error_pending_review"])
    .select("id");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) return;

  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ status: "failed", failure_reason: reason, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .in("status", ["processing", "error_pending_review"]);
  if (chargeUpdate.error) throw chargeUpdate.error;
}

async function reconcileCanceled(supabase, paymentIntentId) {
  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({ payment_status: "voided", updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .in("payment_status", ["processing", "error_pending_review"])
    .select("id");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) return;

  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ status: "voided", updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .in("status", ["processing", "error_pending_review"]);
  if (chargeUpdate.error) throw chargeUpdate.error;
}

async function setDisputeStatusByPaymentIntentId(supabase, paymentIntentId, disputeStatus) {
  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({ dispute_status: disputeStatus, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .select("id");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) return;

  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ dispute_status: disputeStatus, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId);
  if (chargeUpdate.error) throw chargeUpdate.error;
}

// Mirrors api/book.js's own extractPaymentMethodInfo() — kept as a small,
// deliberately duplicated helper rather than a shared module, matching
// this project's existing pattern of self-contained /api functions (see
// signUploadToken's duplication note in api/book.js).
function extractPaymentMethodSummary(pm) {
  if (!pm || typeof pm !== "object") return { id: typeof pm === "string" ? pm : null, summary: "Payment method on file" };
  if (pm.card) {
    const last4 = pm.card.last4 || "????";
    const brand = pm.card.brand ? pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1) : "Card";
    return { id: pm.id, summary: brand + " ending in " + last4 };
  }
  if (pm.cashapp) {
    const cashtag = pm.cashapp.cashtag;
    return { id: pm.id, summary: cashtag ? "Cash App Pay ($" + cashtag + ")" : "Cash App Pay" };
  }
  if (pm.us_bank_account) {
    const last4 = pm.us_bank_account.last4 || "????";
    return { id: pm.id, summary: "Bank account ending in " + last4 };
  }
  return { id: pm.id || null, summary: "Payment method on file" };
}
