// Phase 2 — shared helpers for public.invoices / public.invoice_line_items
// (see sql/2026-10-19_invoice-workflow.sql). Used by api/admin/booking.js's
// ?resource=invoice handlers (detail/create/finalize/void/line-items) and
// api/admin/bookings.js's ?view=invoices list — same reuse posture as
// api/_lib/job-payments-ledger.js, which this file deliberately does not
// duplicate anything from: job_payments stays the one payment ledger, and
// deriveInvoiceStatus() below only ever READS it (via the caller passing in
// an already-computed netCollected number), never writes to it.
//
// Phase 3 adds the shared Send-claim/Pay-Now-claim/active-PaymentIntent
// state machine (see sql/2026-10-19_phase3-invoice-delivery-pay-now.sql and
// sql/2026-10-20_phase3-send-failure-resolution-rpc.sql for the schema and
// RPCs this reads/writes) — still no second financial ledger anywhere in
// this file; mirrorStripePaymentToLedger() (job-payments-ledger.js) remains
// the one and only write path into job_payments.
//
// Phase 3D Stage B (sql/2026-10-21_phase3d-stage-b-invoice-attribution-
// canonical.sql) is the invoice-centric cutover: computeInvoiceBalanceCents()
// below reads job_payments by invoice_id alone (no booking_id fallback),
// withInvoicePaymentLock() takes the specific invoice a mutation affects
// instead of resolving "the" invoice for a booking, and
// reconcileInvoicePaymentIntent() treats a PaymentIntent's metadata.bookingId
// as an attribution snapshot rather than a second identity to enforce
// strictly — see each function's own header below.

const crypto = require("crypto");
const { mirrorStripePaymentToLedger, netCollectedFromLedgerRows } = require("./job-payments-ledger");
const { decimalDollarsToCents, centsToDecimalString } = require("./money");

const INVOICE_SELECT_COLS =
  "id, created_at, created_by, updated_at, updated_by, status, booking_id, customer_id, invoice_number, due_date, notes, total_amount, finalized_at, voided_at, voided_reason, " +
  "send_claim_token, send_claimed_at, active_stripe_payment_intent_id, payment_claim_token, payment_claimed_at, payment_generation";

const LINE_ITEM_SELECT_COLS = "id, invoice_id, sort_order, description, quantity, unit_price, amount, created_at, updated_at";

function mapInvoice(row) {
  return {
    id: row.id,
    status: row.status,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    invoiceNumber: row.invoice_number,
    dueDate: row.due_date,
    notes: row.notes,
    totalAmount: row.total_amount,
    finalizedAt: row.finalized_at,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    sendClaimToken: row.send_claim_token,
    sendClaimedAt: row.send_claimed_at,
    activeStripePaymentIntentId: row.active_stripe_payment_intent_id,
    paymentClaimToken: row.payment_claim_token,
    paymentClaimedAt: row.payment_claimed_at,
    paymentGeneration: row.payment_generation,
  };
}

function mapLineItem(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    sortOrder: row.sort_order,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// invoice.status's three STORED values (draft/finalized/void) map to five
// DISPLAY values (draft/finalized/partially_paid/paid/void) plus one
// orthogonal isOverdue flag — never a sixth "overdue" bucket of its own,
// since overdue modifies a balance state rather than replacing it (an
// unpaid, past-due, finalized invoice is both "finalized" and "overdue" at
// once, same as a partially-paid one can be). "finalized" (not "sent") is
// deliberately the display label too, for the same reason the action is
// called Finalize, not Send — this app has no client-delivery/email
// capability yet, and "Sent" would wrongly claim it does.
//
// invoice: a mapInvoice()-shaped object ({status, totalAmount, dueDate}
// at minimum). netCollected: that invoice's booking's non-voided
// job_payments, net of refunds (job-payments-ledger.js's
// netCollectedFromLedgerRows() — computed by the caller, never here).
// todayIso: the caller's own denverTodayIso() — not computed in this file,
// so every call site stays on exactly one "today" definition.
//
// grossCollected (Phase 5, optional): SUM(payment) only, ignoring refunds
// (job-payments-ledger.js's grossCollectedFromLedgerRows() — same rows,
// computed by the caller same as netCollected). Only purpose: tell apart
// "this invoice never collected anything" from "collected, then fully
// refunded back to net $0 or less" — both have netCollected <= 0, but
// Part 8 explicitly wants the second case labeled "Refunded," not
// "finalized" (which reads as "still awaiting its first payment"). Omitted
// entirely by a caller that hasn't computed it (every existing call site
// before Phase 5) simply never reaches the "refunded" branch below —
// backward compatible, no behavior change for those callers.
function deriveInvoiceStatus(invoice, netCollected, todayIso, grossCollected) {
  if (!invoice || invoice.status === "draft") {
    return { displayStatus: "draft", balanceDue: null, isOverdue: false };
  }
  if (invoice.status === "void") {
    return { displayStatus: "void", balanceDue: 0, isOverdue: false };
  }

  const total = Number(invoice.totalAmount) || 0;
  const collected = Number(netCollected) || 0;
  const balanceDue = Math.max(Math.round((total - collected) * 100) / 100, 0);
  const gross = Number(grossCollected) || 0;
  // Phase 5 bugfix: "refunded" (collected <= 0 after netting out a refund,
  // but gross > 0 — i.e. money WAS collected, then given back) must be
  // checked independently of balanceDue, not nested inside the
  // balanceDue <= 0 branch. For any invoice with a positive total,
  // collected <= 0 forces balanceDue back UP to (approximately) the full
  // total — balanceDue <= 0 and collected <= 0 can essentially never both
  // hold at once, which made the original nested check dead code: a fully
  // refunded invoice fell through to the balanceDue > 0 / collected <= 0
  // "finalized" branch instead, reading as "never billed" rather than
  // "refunded." See this function's own header and job-payments-ledger.js's
  // grossCollectedFromLedgerRows() header for the intended behavior.
  const displayStatus = collected <= 0 && gross > 0 ? "refunded" : balanceDue <= 0 ? "paid" : collected > 0 ? "partially_paid" : "finalized";
  const isOverdue = displayStatus !== "paid" && displayStatus !== "refunded" && !!invoice.dueDate && typeof todayIso === "string" && invoice.dueDate < todayIso;

  return { displayStatus, balanceDue, isOverdue };
}

// =======================================================================
// Phase 3 — payment claim / active-PaymentIntent state machine
// =======================================================================

const PAYMENT_CLAIM_TTL_MS = 30000; // >= 2x STRIPE_REQUEST_TIMEOUT_MS (15s)
const SEND_CLAIM_TTL_MS = 20000; // >= 2x RESEND_REQUEST_TIMEOUT_MS (10s)

// Statuses from which a PaymentIntent can be cancelled via the Stripe API.
// Deliberately excludes "processing" (Stripe itself refuses cancellation
// mid-processing for the standard card path, which is the only path this
// integration ever uses — see resolveInvoicePaymentIntentForMutation()'s
// own comment) and "requires_capture" (unexpected for this integration,
// which only ever creates automatic-capture PaymentIntents).
const CANCELABLE_PI_STATUSES = ["requires_payment_method", "requires_confirmation", "requires_action"];

function isClaimStale(claimedAtIso, ttlMs) {
  if (!claimedAtIso) return true;
  const claimedAt = new Date(claimedAtIso).getTime();
  if (!Number.isFinite(claimedAt)) return true;
  return Date.now() - claimedAt >= ttlMs;
}

// Live balance due, in integer cents, from job_payments directly, keyed
// by invoice_id — never booking_id, and never cached. Phase 3D Stage B:
// this is now the ONLY formula an invoice's balance is ever computed by,
// with no fallback to the booking's other payments — a generic booking
// payment (invoice_id NULL) never counts toward any invoice's balance,
// attached or standalone. May be negative (overpaid); callers decide how
// to treat that.
async function computeInvoiceBalanceCents(supabase, invoice) {
  const { data: rows, error } = await supabase.from("job_payments").select("amount, payment_type").eq("invoice_id", invoice.id).is("voided_at", null);
  if (error) throw error;
  const netCollected = netCollectedFromLedgerRows(rows || []);
  const totalCents = decimalDollarsToCents(invoice.totalAmount) || 0;
  const collectedCents = decimalDollarsToCents(netCollected) || 0;
  return totalCents - collectedCents;
}

// Conditional clear — never a blind unconditional SET. A newer PI that
// has since taken over active_stripe_payment_intent_id must never be
// wiped out by a late caller that was only ever tracking the OLD one.
async function clearActivePaymentIntent(supabase, invoiceId, piId) {
  try {
    await supabase.from("invoices").update({ active_stripe_payment_intent_id: null }).eq("id", invoiceId).eq("active_stripe_payment_intent_id", piId);
  } catch (err) {
    console.error("clearActivePaymentIntent failed for invoice " + invoiceId + " pi " + piId + ":", err && err.stack ? err.stack : err);
  }
}

// Validates and mirrors a succeeded invoice-originated PaymentIntent into
// job_payments — the ONE place this ever happens, called identically from
// the Stripe webhook, the public invoice-public lazy-reconcile path, and
// Category B's post-mirror cleanup. Never throws; a validation failure
// logs loudly and returns without mirroring (see the halt/proceed table
// below) rather than ever writing an unverified amount into the ledger.
async function reconcileInvoicePaymentIntent(supabase, stripe, pi) {
  try {
    if (!pi || !pi.metadata || pi.metadata.source !== "invoice_pay_now") return; // not ours
    const invoiceId = pi.metadata.invoiceId;
    const metaBookingId = pi.metadata.bookingId;
    if (!invoiceId) {
      console.error("reconcileInvoicePaymentIntent: PaymentIntent " + pi.id + " is missing metadata.invoiceId — HALTING, not mirroring. Manual review needed.");
      return;
    }

    const { data: invoiceRow, error: invErr } = await supabase
      .from("invoices")
      .select("id, booking_id, invoice_number, payment_generation")
      .eq("id", invoiceId)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!invoiceRow) {
      console.error("reconcileInvoicePaymentIntent: invoice " + invoiceId + " not found for PaymentIntent " + pi.id + " — HALTING, not mirroring. Manual review needed.");
      return;
    }
    // Phase 3D Stage B: invoiceId (above) is this PaymentIntent's one
    // canonical, exact identity — already matched by id, never fuzzy.
    // bookingId is only ever an ATTRIBUTION SNAPSHOT taken at PI-creation
    // time (handleInvoicePaymentIntentCreate sets it from the invoice's
    // booking_id as it read it then) — for a standalone invoice that's
    // null, and Attach-to-Job can legitimately set the invoice's real
    // booking_id afterward, while this same PaymentIntent is still in
    // flight. So: an empty snapshot is always allowed to catch up to a
    // since-attached invoice; a NON-empty snapshot must still match
    // exactly (attach is one-time/one-way, so a live mismatch here means
    // something is genuinely wrong, not just a timing gap).
    if (metaBookingId && metaBookingId !== invoiceRow.booking_id) {
      console.error(
        "reconcileInvoicePaymentIntent: booking mismatch for PaymentIntent " + pi.id + " — invoice.booking_id=" + invoiceRow.booking_id + " metadata.bookingId=" + metaBookingId + ". HALTING, not mirroring. Manual review needed."
      );
      return;
    }
    if (pi.currency !== "usd") {
      console.error("reconcileInvoicePaymentIntent: unexpected currency '" + pi.currency + "' on PaymentIntent " + pi.id + ". HALTING, not mirroring. Manual review needed.");
      return;
    }
    const expectedAmountCents = Number(pi.metadata.expectedAmountCents);
    if (!Number.isFinite(expectedAmountCents) || expectedAmountCents !== pi.amount || pi.amount !== pi.amount_received || !pi.amount_received || pi.amount_received <= 0) {
      console.error(
        "reconcileInvoicePaymentIntent: amount mismatch for PaymentIntent " +
          pi.id +
          " (invoice " +
          invoiceId +
          ") — expectedAmountCents=" +
          pi.metadata.expectedAmountCents +
          " pi.amount=" +
          pi.amount +
          " pi.amount_received=" +
          pi.amount_received +
          ". HALTING, not mirroring. Manual review needed."
      );
      return;
    }

    let notes = "Invoice " + (invoiceRow.invoice_number || invoiceId) + " — Pay Now, confirmed by email/webhook.";
    const metaGeneration = Number(pi.metadata.paymentGeneration);
    if (Number.isFinite(metaGeneration) && metaGeneration !== invoiceRow.payment_generation) {
      // Does NOT halt — the money is real regardless of which generation
      // created it. Flagged in the ledger row itself for manual review.
      notes += " (reconciled from non-current generation " + metaGeneration + " — invoice currently at " + invoiceRow.payment_generation + "; review recommended.)";
      console.error("reconcileInvoicePaymentIntent: PaymentIntent " + pi.id + " belongs to generation " + metaGeneration + " but invoice " + invoiceId + " is currently at generation " + invoiceRow.payment_generation + " — mirroring the real captured money anyway.");
    }

    // Phase 3D Stage A: invoiceId is passed explicitly — this is the one
    // invoice-originated mirror call, so it never goes through
    // resolveJobPaymentAttribution()'s booking-lookup branch inside
    // mirrorStripePaymentToLedger(). bookingId is still passed too
    // (invoiceRow.booking_id, already validated above) for the row's
    // job/revenue attribution — unchanged in substance from today.
    await mirrorStripePaymentToLedger(supabase, {
      bookingId: invoiceRow.booking_id,
      invoiceId: invoiceId,
      stripePaymentIntentId: pi.id,
      amount: centsToDecimalString(pi.amount_received),
      notes: notes,
    });

    await clearActivePaymentIntent(supabase, invoiceId, pi.id);
  } catch (err) {
    console.error("reconcileInvoicePaymentIntent failed unexpectedly for PaymentIntent " + (pi && pi.id) + ":", err && err.stack ? err.stack : err);
  }
}

// The shared status-machine resolver — called before Pay Now creates a
// new PaymentIntent, and (via withInvoicePaymentLock) before any
// discretionary balance mutation or invoice void. `purpose` is the one
// thing that changes behavior: 'pay_now' may reuse a cancelable PI whose
// amount still matches the live balance; 'balance_mutation' and
// 'invoice_void' always cancel any cancelable PI first — a discretionary
// mutation must never proceed while a collectible client Pay Now PI is
// still alive, even one that currently happens to match.
async function resolveInvoicePaymentIntentForMutation(supabase, stripe, invoice, purpose) {
  if (invoice.paymentClaimToken && !isClaimStale(invoice.paymentClaimedAt, PAYMENT_CLAIM_TTL_MS)) {
    return { blocked: true, reason: "A card payment is currently being set up for this invoice." };
  }

  if (!invoice.activeStripePaymentIntentId) {
    return { ok: true };
  }

  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(invoice.activeStripePaymentIntentId);
  } catch (err) {
    console.error("resolveInvoicePaymentIntentForMutation: failed to retrieve PaymentIntent " + invoice.activeStripePaymentIntentId + " (invoice " + invoice.id + "):", err && err.stack ? err.stack : err);
    return { blocked: true, reason: "Could not verify the current payment state. Try again shortly." };
  }

  if (pi.status === "succeeded") {
    await reconcileInvoicePaymentIntent(supabase, stripe, pi);
    const balanceCents = await computeInvoiceBalanceCents(supabase, invoice);
    return { reconciled: true, balanceCents: balanceCents };
  }

  if (pi.status === "processing") {
    return { blocked: true, reason: "A card payment is currently processing for this invoice." };
  }

  if (pi.status === "requires_capture") {
    console.error("resolveInvoicePaymentIntentForMutation: unexpected requires_capture status for PaymentIntent " + pi.id + " (invoice " + invoice.id + ") — this integration only ever creates automatic-capture PaymentIntents. Manual review needed.");
    return { blocked: true, reason: "Payment state is temporarily unclear. Manual review needed." };
  }

  if (CANCELABLE_PI_STATUSES.indexOf(pi.status) !== -1) {
    if (purpose === "pay_now") {
      const balanceCents = await computeInvoiceBalanceCents(supabase, invoice);
      if (pi.amount === balanceCents) {
        return { reuse: pi };
      }
      // stale amount for pay_now — fall through to the unconditional cancel below
    }
    let canceled;
    try {
      canceled = await stripe.paymentIntents.cancel(pi.id);
    } catch (err) {
      console.error("resolveInvoicePaymentIntentForMutation: failed to cancel PaymentIntent " + pi.id + " (invoice " + invoice.id + "):", err && err.stack ? err.stack : err);
      return { blocked: true, reason: "Could not safely clear an in-flight payment attempt. Try again shortly." };
    }
    if (canceled.status !== "canceled") {
      return { blocked: true, reason: "Could not confirm the in-flight payment attempt was canceled." };
    }
    await clearActivePaymentIntent(supabase, invoice.id, pi.id);
    return { ok: true };
  }

  if (pi.status === "canceled") {
    await clearActivePaymentIntent(supabase, invoice.id, pi.id);
    return { ok: true };
  }

  console.error("resolveInvoicePaymentIntentForMutation: unrecognized PaymentIntent status '" + pi.status + "' for " + pi.id + " (invoice " + invoice.id + "). Manual review needed.");
  return { blocked: true, reason: "Unrecognized payment state. Manual review needed." };
}

// Category A wrapper — Phase 3D Stage B: now fully invoice-centric. The
// caller already has the SPECIFIC invoice this mutation affects (loaded
// however it needed to — by id, or via the booking it's attached to) and
// hands it in directly; this function no longer resolves "the" invoice
// for a booking itself (Stage A's findActiveInvoiceForBooking() is gone
// — a generic, booking-only payment has no invoice to resolve in the
// first place, and never reaches this wrapper at all). Resolves PI/claim
// state exactly ONCE (never re-resolved inside mutationFn, which would
// see this wrapper's own freshly-acquired claim and self-block), then
// briefly holds the invoice's payment claim around the discretionary
// mutation itself, so a Pay Now request cannot start between "guard
// passed" and "mutation committed."
async function withInvoicePaymentLock(supabase, stripe, invoice, options, mutationFn) {
  if (!invoice || !invoice.id) {
    throw new Error("withInvoicePaymentLock requires a loaded invoice — it no longer resolves one from a bookingId.");
  }
  const purpose = (options && options.purpose) || "balance_mutation";

  const resolution = await resolveInvoicePaymentIntentForMutation(supabase, stripe, invoice, purpose);
  if (resolution.blocked) {
    return { ok: false, error: resolution.reason };
  }

  if (resolution.reconciled && purpose === "invoice_void" && !(options && options.confirmVoidPaidInvoice)) {
    // Nothing to mutate yet — no claim acquired, no lock held.
    // reasonCode is the stable field callers should branch on; message is
    // for display only and may change wording freely.
    return { ok: false, requiresConfirmation: true, reasonCode: "invoice_void_requires_confirmation", message: "This invoice was just paid by card — the ledger now reflects it. Void anyway?" };
  }

  const myToken = crypto.randomUUID();
  const staleBeforeIso = new Date(Date.now() - PAYMENT_CLAIM_TTL_MS).toISOString();
  const { data: claimedRows, error: claimErr } = await supabase
    .from("invoices")
    .update({ payment_claim_token: myToken, payment_claimed_at: new Date().toISOString() })
    .eq("id", invoice.id)
    .is("active_stripe_payment_intent_id", null)
    .or("payment_claim_token.is.null,payment_claimed_at.lt." + staleBeforeIso)
    .select("id");
  if (claimErr) throw claimErr;
  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    return { ok: false, error: "Payment setup is in progress for this invoice. Try again shortly." };
  }

  try {
    return await mutationFn({ resolution: resolution, invoice: invoice, lockToken: myToken });
  } finally {
    await supabase.from("invoices").update({ payment_claim_token: null, payment_claimed_at: null }).eq("id", invoice.id).eq("payment_claim_token", myToken);
  }
}

module.exports = {
  INVOICE_SELECT_COLS,
  LINE_ITEM_SELECT_COLS,
  mapInvoice,
  mapLineItem,
  deriveInvoiceStatus,
  PAYMENT_CLAIM_TTL_MS,
  SEND_CLAIM_TTL_MS,
  CANCELABLE_PI_STATUSES,
  isClaimStale,
  computeInvoiceBalanceCents,
  clearActivePaymentIntent,
  reconcileInvoicePaymentIntent,
  resolveInvoicePaymentIntentForMutation,
  withInvoicePaymentLock,
};
