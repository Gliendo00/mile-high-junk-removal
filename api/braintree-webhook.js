// Vercel serverless function — Braintree webhook receiver for the
// dumpster-rental payment feature (Phase 3C Stage 2.5-v2). See
// docs/phase-3/stage2.5-rental-payments-v2-proposal.md §3/§6 for the full
// design.
//
// This endpoint is deliberately its own file rather than folded into
// api/book.js: it has a completely different security model (Braintree's
// own HMAC webhook signature, not admin-session auth or the public form's
// spam-protection heuristics) and must never be subject to the IP rate
// limiting api/book.js applies to human submitters — that could reject
// Braintree's own legitimate retries. Configuring this URL in the
// Braintree Control Panel is a manual step — see the proposal doc §11.
//
// Required environment variables: BRAINTREE_ENVIRONMENT,
// BRAINTREE_MERCHANT_ID, BRAINTREE_PUBLIC_KEY, BRAINTREE_PRIVATE_KEY (see
// api/_lib/braintree-client.js), plus SUPABASE_URL/SUPABASE_SECRET_KEY to
// update payment rows.
//
// Two request shapes, both from Braintree, never from a browser:
//   GET  ?bt_challenge=... — the one-time URL-verification challenge
//        Braintree issues when the webhook URL is first configured/checked
//        in the Control Panel. Answered with webhookNotification.verify().
//   POST { bt_signature, bt_payload } (application/x-www-form-urlencoded,
//        parsed into req.body the same way Vercel already parses JSON
//        bodies elsewhere in this project) — the actual event delivery.
//        gateway.webhookNotification.parse() performs full cryptographic
//        signature verification itself; an invalid/tampered signature
//        throws, which this handler treats as a hard 400 and processes
//        nothing — the defense against webhook spoofing.
//
// Idempotency / duplicate delivery: every write below is an absolute
// SET-status-by-braintree_transaction_id update (never an increment, never
// "add a new row per event"), so processing the same notification twice —
// Braintree explicitly does not guarantee exactly-once delivery — lands on
// the same end state both times and is safe to run unconditionally, with
// no separate dedup/event-log table needed.
const { getBraintreeGateway } = require("./_lib/braintree-client");
const { getServiceClient } = require("./_lib/supabase-admin");

// Dispute-related webhook kinds this endpoint records (informational only —
// see the dispute_status column comment in the migration SQL). Every other
// unrecognized kind is acknowledged with 200 and otherwise ignored: this
// endpoint only needs to react to the events that affect a payment_status
// this CRM displays, not the full Braintree webhook catalog.
const DISPUTE_KINDS = {
  dispute_opened: "opened",
  dispute_lost: "lost",
  dispute_won: "won",
  dispute_accepted: "accepted",
};

module.exports = async (req, res) => {
  const gateway = getBraintreeGateway();
  if (!gateway) {
    console.error("Braintree webhook failed: BRAINTREE_* environment variables not configured");
    res.status(500).end();
    return;
  }

  if (req.method === "GET") {
    const challenge = typeof req.query.bt_challenge === "string" ? req.query.bt_challenge : "";
    if (!challenge) {
      res.status(400).end();
      return;
    }
    try {
      const verification = await gateway.webhookNotification.verify(challenge);
      res.status(200).send(verification);
    } catch (err) {
      console.error("Braintree webhook URL verification failed:", err && err.message ? err.message : err);
      res.status(400).end();
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const signature = typeof body.bt_signature === "string" ? body.bt_signature : "";
  const payload = typeof body.bt_payload === "string" ? body.bt_payload : "";
  if (!signature || !payload) {
    res.status(400).json({ error: "Missing webhook payload." });
    return;
  }

  let notification;
  try {
    notification = await gateway.webhookNotification.parse(signature, payload);
  } catch (err) {
    // Includes an invalid/forged signature — the spoofing defense. Nothing
    // below this point ever runs for a notification that didn't verify.
    console.error("Braintree webhook: signature verification failed:", err && err.message ? err.message : err);
    res.status(400).json({ error: "Invalid webhook signature." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Braintree webhook failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    // Still 200: Braintree will retry a non-2xx response, and re-processing
    // this same (already-verified) notification later is safe per the
    // idempotency note above. A 500 here just schedules a retry rather than
    // losing the event.
    res.status(500).json({ error: "Storage unavailable." });
    return;
  }

  try {
    await applyNotification(supabase, notification);
  } catch (err) {
    console.error("Braintree webhook: failed applying notification (kind=" + notification.kind + "):", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not process webhook." });
    return;
  }

  res.status(200).json({ ok: true });
};

async function applyNotification(supabase, notification) {
  const kind = notification.kind;

  if (kind === "transaction_settled" || kind === "transaction_settlement_declined") {
    const txn = notification.transaction;
    const transactionId = txn && txn.id;
    if (!transactionId) return;
    const newStatus = kind === "transaction_settled" ? "paid" : "failed";
    await setPaymentStatusByTransactionId(supabase, transactionId, newStatus);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(DISPUTE_KINDS, kind)) {
    const dispute = notification.dispute;
    const transactionId = dispute && dispute.transaction && dispute.transaction.id;
    if (!transactionId) return;
    await setDisputeStatusByTransactionId(supabase, transactionId, DISPUTE_KINDS[kind]);
    return;
  }

  // Every other webhook kind (subscription/merchant-account/etc. events
  // this project doesn't use) is intentionally a no-op — acknowledged with
  // 200 by the caller, nothing to update.
}

// Tries rental_payments first (the initial charge), then
// rental_additional_charges (an approved overage/extra-day charge) — a
// given transaction id can only ever exist in one of the two tables, so at
// most one of these two updates actually matches a row.
async function setPaymentStatusByTransactionId(supabase, transactionId, status) {
  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({ payment_status: status, updated_at: new Date().toISOString() })
    .eq("braintree_transaction_id", transactionId)
    .select("id");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) return;

  const chargeStatus = status === "paid" ? "paid" : "failed";
  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ status: chargeStatus, updated_at: new Date().toISOString() })
    .eq("braintree_transaction_id", transactionId);
  if (chargeUpdate.error) throw chargeUpdate.error;
}

async function setDisputeStatusByTransactionId(supabase, transactionId, disputeStatus) {
  const paymentUpdate = await supabase
    .from("rental_payments")
    .update({ dispute_status: disputeStatus, updated_at: new Date().toISOString() })
    .eq("braintree_transaction_id", transactionId)
    .select("id");
  if (paymentUpdate.error) throw paymentUpdate.error;
  if (Array.isArray(paymentUpdate.data) && paymentUpdate.data.length > 0) return;

  const chargeUpdate = await supabase
    .from("rental_additional_charges")
    .update({ dispute_status: disputeStatus, updated_at: new Date().toISOString() })
    .eq("braintree_transaction_id", transactionId);
  if (chargeUpdate.error) throw chargeUpdate.error;
}
