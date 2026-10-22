-- Hotfix — job_payments_stripe_refund_idx was created as a PARTIAL unique
-- index (`WHERE stripe_refund_id IS NOT NULL`) in
-- 2026-10-21_phase5-dumpster-charges-refunds.sql. PostgreSQL requires an
-- `ON CONFLICT (col)` target to exactly match an index's predicate,
-- including partial ones — a plain `ON CONFLICT (stripe_refund_id)` (which
-- is exactly what handleRefundJobPayment()'s and reconcileRefunded()'s
-- `.upsert(payload, {onConflict: "stripe_refund_id", ignoreDuplicates: true})`
-- calls produce) never matches a partial index, so Postgres rejects it
-- outright with "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" (42P10) — on every call, not just an actual
-- duplicate. This is the identical bug class already caught and fixed once
-- before in this codebase for job_payments_stripe_pi_idx — see that
-- migration's own comment (2026-09-19_phase3c-stage3-job-payments-and-
-- expenses.sql) for the full root-cause writeup. Re-applying the same fix
-- here: drop the partial predicate. A plain UNIQUE index already permits
-- unlimited NULL rows on its own (NULL is never equal to NULL for
-- uniqueness purposes in Postgres), so nothing about manual (non-Stripe)
-- refund rows changes.
--
-- Confirmed live in production (2026-10-21T23:48:40.702Z) via a real
-- partial-Stripe-refund attempt that failed with exactly this 42P10 error
-- AFTER stripe.refunds.create() had already succeeded — see the incident
-- notes for that payment before reconciling it; this migration alone does
-- not create the missing ledger row for that specific refund.
--
-- Run this once against production Supabase before relying on either
-- Stripe-refund write path (handleRefundJobPayment() or the charge.refunded
-- webhook backstop) again. Not executed by this agent.

BEGIN;

DROP INDEX IF EXISTS public.job_payments_stripe_refund_idx;

CREATE UNIQUE INDEX IF NOT EXISTS job_payments_stripe_refund_idx
  ON public.job_payments (stripe_refund_id);

COMMIT;

-- Verification (re-run any time to confirm current state — indexdef should
-- show NO "WHERE" clause):
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'job_payments' and indexname = 'job_payments_stripe_refund_idx';
