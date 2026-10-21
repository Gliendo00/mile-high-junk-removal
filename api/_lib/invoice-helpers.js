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
function deriveInvoiceStatus(invoice, netCollected, todayIso) {
  if (!invoice || invoice.status === "draft") {
    return { displayStatus: "draft", balanceDue: null, isOverdue: false };
  }
  if (invoice.status === "void") {
    return { displayStatus: "void", balanceDue: 0, isOverdue: false };
  }

  const total = Number(invoice.totalAmount) || 0;
  const collected = Number(netCollected) || 0;
  const balanceDue = Math.max(Math.round((total - collected) * 100) / 100, 0);
  const displayStatus = balanceDue <= 0 ? "paid" : collected > 0 ? "partially_paid" : "finalized";
  const isOverdue = displayStatus !== "paid" && !!invoice.dueDate && typeof todayIso === "string" && invoice.dueDate < todayIso;

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

// The one, at-most-one-row, non-void invoice for a booking — Phase 2's own
// unique index already guarantees at most one. Returns null if the
// booking has none (e.g. a junk_removal job nobody has ever invoiced).
async function findActiveInvoiceForBooking(supabase, bookingId) {
  const { data, error } = await supabase.from("invoices").select(INVOICE_SELECT_COLS).eq("booking_id", bookingId).neq("status", "void").maybeSingle();
  if (error) throw error;
  return data ? mapInvoice(data) : null;
}

// Live balance due, in integer cents, from job_payments directly — never
// cached, never derived from anything else. May be negative (overpaid);
// callers decide how to treat that.
async function computeInvoiceBalanceCents(supabase, invoice) {
  const { data: rows, error } = await supabase.from("job_payments").select("amount, payment_type").eq("booking_id", invoice.bookingId).is("voided_at", null);
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
    if (invoiceRow.booking_id !== metaBookingId) {
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

// Category A wrapper — resolves PI/claim state exactly ONCE (never
// re-resolved inside mutationFn, which would see this wrapper's own
// freshly-acquired claim and self-block), then briefly holds the
// invoice's payment claim around the discretionary mutation itself, so a
// Pay Now request cannot start between "guard passed" and "mutation
// committed." Also blocks on an unresolved off-session additional charge
// for the same booking — reuses rental_additional_charges' own durable
// status column (processing / error_pending_review /
// requires_customer_action); no new table or column.
async function withInvoicePaymentLock(supabase, stripe, bookingId, options, mutationFn) {
  const purpose = (options && options.purpose) || "balance_mutation";
  const invoice = await findActiveInvoiceForBooking(supabase, bookingId);
  if (!invoice) {
    return mutationFn({ resolution: { ok: true }, invoice: null, lockToken: null });
  }

  const { data: unresolvedCharge, error: chargeErr } = await supabase
    .from("rental_additional_charges")
    .select("id, status")
    .eq("booking_id", bookingId)
    .in("status", ["processing", "error_pending_review", "requires_customer_action"])
    .limit(1)
    .maybeSingle();
  if (chargeErr) throw chargeErr;
  if (unresolvedCharge) {
    return { ok: false, error: "An off-session charge for this booking is unresolved (status: " + unresolvedCharge.status + ") — resolve it via Check Status before proceeding." };
  }

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

// Category B — called AFTER an unconditional, already-committed
// mirrorStripePaymentToLedger() write (rental deposit backstop,
// off-session charge mirror, webhook backstops). Best-effort only: every
// failure here is caught and logged, NEVER propagated — the real money
// mirror this runs after has already succeeded, and nothing in this
// function is allowed to undo or suppress that.
async function cleanupStalePaymentIntentAfterMirror(supabase, stripe, bookingId) {
  try {
    const invoice = await findActiveInvoiceForBooking(supabase, bookingId);
    if (!invoice || !invoice.activeStripePaymentIntentId) return;

    const pi = await stripe.paymentIntents.retrieve(invoice.activeStripePaymentIntentId);

    if (pi.status === "succeeded") {
      await reconcileInvoicePaymentIntent(supabase, stripe, pi);
      return;
    }
    if (CANCELABLE_PI_STATUSES.indexOf(pi.status) !== -1) {
      const balanceCents = await computeInvoiceBalanceCents(supabase, invoice);
      if (pi.amount !== balanceCents) {
        const canceled = await stripe.paymentIntents.cancel(pi.id);
        if (canceled.status === "canceled") {
          await clearActivePaymentIntent(supabase, invoice.id, pi.id);
        } else {
          console.error("cleanupStalePaymentIntentAfterMirror: could not confirm cancellation of PaymentIntent " + pi.id + " for invoice " + invoice.id + " — manual review needed.");
        }
      }
      return;
    }
    if (pi.status === "canceled") {
      await clearActivePaymentIntent(supabase, invoice.id, pi.id);
      return;
    }
    if (pi.status === "processing" || pi.status === "requires_capture") {
      console.error("cleanupStalePaymentIntentAfterMirror: PaymentIntent " + pi.id + " for invoice " + invoice.id + " is in status '" + pi.status + "' — left untouched; manual review if this persists.");
      return;
    }
    console.error("cleanupStalePaymentIntentAfterMirror: unrecognized PaymentIntent status '" + pi.status + "' for " + pi.id + " (invoice " + invoice.id + ") — manual review needed.");
  } catch (err) {
    console.error("cleanupStalePaymentIntentAfterMirror failed (non-fatal, logged only) for booking " + bookingId + ":", err && err.stack ? err.stack : err);
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
  findActiveInvoiceForBooking,
  computeInvoiceBalanceCents,
  clearActivePaymentIntent,
  reconcileInvoicePaymentIntent,
  resolveInvoicePaymentIntentForMutation,
  withInvoicePaymentLock,
  cleanupStalePaymentIntentAfterMirror,
};
