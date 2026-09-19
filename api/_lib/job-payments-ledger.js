// Phase 3C Stage 3 — shared helpers for job_payments, the cross-service-
// type financial ledger. Used by three call sites that already confirm a
// Stripe collection succeeded (api/book.js's initial rental capture,
// api/admin/booking.js's handleApprove()/handleCheckStatus() for admin-
// approved additional charges) plus the asynchronous webhook backstop
// (api/stripe-webhook.js's reconcileSucceeded()) — see
// docs/phase-3/stage3-payments-expenses-proposal.md for the full design.
//
// Manual (cash/Zelle/Venmo/check/card-recorded-by-admin) ledger rows are
// created directly by api/admin/booking.js's own resource=job-payments
// handlers, not through this file — mirrorStripePaymentToLedger() below is
// exclusively the auto-mirror path for Stripe collections.

const VALID_PAYMENT_METHODS = ["card_stripe", "cash", "zelle", "venmo", "check"];
const VALID_PAYMENT_TYPES = ["payment", "refund"];

// Mirrors one successfully collected Stripe transaction into job_payments.
// MUST NEVER throw and must never be allowed to affect the caller's own
// response — by the time any of the four call sites above reach this
// function, Stripe has ALREADY moved the money; a ledger-mirroring failure
// is a (loggable, recoverable-by-rerun) bookkeeping gap, never a reason to
// tell the customer or admin the payment itself failed. Every call site
// wraps this in the same "best-effort, log and continue" posture the rest
// of this project's Stripe code already uses for post-charge persistence
// (see api/book.js's own retry-then-fallback comment block).
//
// Idempotent via job_payments' own plain (NOT partial — see the migration
// SQL's comment on job_payments_stripe_pi_idx for why a partial index here
// was a real bug, caught and fixed in a pre-push audit) UNIQUE index on
// stripe_payment_intent_id — `upsert(...,
// {ignoreDuplicates:true})` means calling this twice for the same
// PaymentIntent (e.g. the synchronous success path AND the webhook backstop
// both firing for one transaction) safely produces exactly one row, not
// two, with no read-before-write race.
async function mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId, amount, paymentDate, notes }) {
  if (!supabase || !bookingId || !stripePaymentIntentId) return;
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) return;

  try {
    const { error } = await supabase.from("job_payments").upsert(
      {
        booking_id: bookingId,
        amount: Math.round(amountNum * 100) / 100,
        payment_method: "card_stripe",
        payment_type: "payment",
        stripe_payment_intent_id: stripePaymentIntentId,
        payment_date: paymentDate || denverTodayIso(),
        notes: notes || null,
      },
      { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true }
    );
    if (error) throw error;
  } catch (err) {
    console.error(
      "job_payments ledger mirror failed (non-fatal — the underlying Stripe collection already succeeded; this only affects the unified ledger view). stripePaymentIntentId=" +
        stripePaymentIntentId +
        " bookingId=" +
        bookingId +
        ":",
      err && err.stack ? err.stack : err
    );
  }
}

// Net collected revenue for one booking from a set of already-fetched
// job_payments rows (never voided): SUM(payment) - SUM(refund). Pass every
// non-voided row for the booking; a voided row should simply be filtered
// out (or excluded from the query) before calling this, not passed in and
// special-cased here, since "voided rows don't count" is the same rule for
// both payment and refund rows.
function netCollectedFromLedgerRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    const amt = Number(row.amount) || 0;
    if (row.paymentType === "refund" || row.payment_type === "refund") {
      total -= amt;
    } else {
      total += amt;
    }
  }
  return Math.round(total * 100) / 100;
}

// The Stage 3 bookings.final_price compatibility rule (see the proposal
// doc's "Existing bookings.final_price compatibility" section):
//   - if this booking has any non-voided job_payments rows, the ledger
//     total is authoritative ("actual collected payments should ultimately
//     be the preferred revenue source" — the owner's own words);
//   - if it has NONE (every job created before this stage, or a job that
//     simply has no ledger entries yet), fall back to bookings.final_price
//     unchanged, so no historical job's revenue silently becomes $0.
// tip_amount is deliberately untouched by this function and by the ledger
// entirely — it has never been summed with final_price anywhere in this
// codebase (confirmed by inspection before this stage was built), so there
// is no double-counting or dropped-tip risk to guard against here.
function effectiveRevenue(nonVoidedLedgerRows, finalPrice) {
  if (Array.isArray(nonVoidedLedgerRows) && nonVoidedLedgerRows.length > 0) {
    return { amount: netCollectedFromLedgerRows(nonVoidedLedgerRows), source: "ledger" };
  }
  if (finalPrice === null || finalPrice === undefined) return { amount: null, source: "none" };
  const fp = Number(finalPrice);
  if (Number.isFinite(fp)) return { amount: fp, source: "final_price" };
  return { amount: null, source: "none" };
}

// Current date in America/Denver as YYYY-MM-DD — same small, deliberate
// local copy every other file in this project keeps (see
// api/admin/bookings.js's own denverTodayIso() for the established
// rationale: not a shared import, per this project's convention).
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) {
    parts[p.type] = p.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day;
}

module.exports = {
  VALID_PAYMENT_METHODS,
  VALID_PAYMENT_TYPES,
  mirrorStripePaymentToLedger,
  netCollectedFromLedgerRows,
  effectiveRevenue,
  denverTodayIso,
};
