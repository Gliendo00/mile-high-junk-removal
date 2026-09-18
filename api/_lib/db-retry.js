// Shared helper for the one class of database write in this codebase
// worth retrying: recording the outcome of a Braintree charge that has
// ALREADY definitively succeeded (transaction.sale() returned success —
// money has moved). Both api/book.js (the initial rental charge) and
// api/admin/booking.js's handleApproveCharge (an admin-approved additional
// charge) use this for exactly one write each — never for anything before
// the Braintree call, where a failure just means "nothing happened yet,"
// not "a real charge exists with no durable local trace of it."
//
// 2026-09-18 post-hardening-audit readiness pass — see
// docs/phase-3/stage2.5-rental-payments-v2-hardening-audit.md and
// docs/phase-3/stage2.5-rental-payments-v2-readiness-pass.md for the full
// reasoning: this does not pretend Braintree + Supabase can be one ACID
// transaction. It's a practical, bounded saga step — retry the write a
// few times with short backoff (transient network blips are the most
// likely real-world cause of this write failing), and if every attempt
// still fails, the caller falls back to a smaller, most-likely-to-succeed
// write, then finally to logging plus the Braintree transaction's own
// orderId (set BEFORE the charge, independent of any of this) as the
// last-resort correlation path.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `fn` is called once per attempt and must return the Supabase query's
// awaited result ({ error } at minimum). Returns true the first time an
// attempt resolves with no error; false if every attempt errors or throws.
// Never throws itself — a broken `fn` just counts as a failed attempt.
async function retryUpdate(fn, delaysMs) {
  const totalAttempts = delaysMs.length + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const result = await fn();
      if (result && !result.error) return true;
    } catch (err) {
      // counts as a failed attempt; falls through to retry/backoff below
    }
    if (attempt < delaysMs.length) await sleep(delaysMs[attempt]);
  }
  return false;
}

module.exports = { retryUpdate };
