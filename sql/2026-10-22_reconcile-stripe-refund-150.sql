-- One-off reconciliation — NOT a repeatable migration, do not keep running
-- it. Records the $1.50 Stripe refund that was confirmed (via the Stripe
-- Dashboard) to have actually succeeded on 2026-10-21 around 23:48:40 UTC,
-- but whose job_payments ledger row was never written because
-- handleRefundJobPayment()'s doInsert() upsert failed with Postgres 42P10
-- (job_payments_stripe_refund_idx was a partial index — see
-- 2026-10-22_fix-job-payments-stripe-refund-idx.sql, already applied).
--
-- This does NOT call Stripe again. It only writes the ledger row Stripe's
-- own successful refund should have produced. booking_id/invoice_id/
-- reverses_payment_id are all resolved from the original payment's own
-- stripe_payment_intent_id (unique), not guessed from amount/date, so this
-- can only match the correct row or match nothing.
--
-- Values confirmed directly from the Stripe Dashboard (refund object JSON
-- + the payment's own Details panel):
--   refund id:          re_3UT9EDH6APIZIBd90qW04EFt  (amount: 150 = $1.50;
--                        charge: ch_3UT9EDH6APIZIBd90lfLKrrB — same
--                        "3UT9EDH6APIZIBd90..." cluster as the PaymentIntent
--                        below, cross-checked)
--   payment_intent id:  pi_3UT9EDH6APIZIBd90Z62I51O ($3.49 original charge)
--
-- The SELECT below the INSERT lets you verify the target row BEFORE running
-- the insert — run that first and confirm it returns exactly the one
-- expected $3.49 payment before running the INSERT.

-- Step 1 — verify the target row first (read-only, safe to run any time):
-- select id, booking_id, invoice_id, amount, payment_method, payment_type, stripe_payment_intent_id
-- from public.job_payments
-- where stripe_payment_intent_id = 'pi_3UT9EDH6APIZIBd90Z62I51O'
--   and payment_type = 'payment'
--   and voided_at is null;
-- Expect exactly one row: amount 3.49, payment_method 'card_stripe'.

BEGIN;

INSERT INTO public.job_payments (
  booking_id,
  invoice_id,
  invoice_id_classified,
  amount,
  payment_method,
  payment_type,
  payment_date,
  notes,
  reverses_payment_id,
  stripe_refund_id,
  recorded_by
)
SELECT
  orig.booking_id,
  orig.invoice_id,
  true,
  1.50,
  'card_stripe',
  'refund',
  '2026-10-21',
  'Test 1 (reconciled manually — Stripe refund re_3UT9EDH6APIZIBd90qW04EFt succeeded on 2026-10-21 but the CRM''s own ledger insert failed with Postgres 42P10 due to a partial-index bug, fixed same day; see 2026-10-22_fix-job-payments-stripe-refund-idx.sql).',
  orig.id,
  're_3UT9EDH6APIZIBd90qW04EFt',
  'contact@milehighjunkremoval.net'
FROM public.job_payments orig
WHERE orig.stripe_payment_intent_id = 'pi_3UT9EDH6APIZIBd90Z62I51O'
  AND orig.payment_type = 'payment'
  AND orig.payment_method = 'card_stripe'
  AND orig.voided_at IS NULL
ON CONFLICT (stripe_refund_id) DO NOTHING;

COMMIT;

-- Step 2 — verify afterward (should now return exactly one refund row with
-- the same booking_id/invoice_id as the original payment, amount 1.50):
-- select id, booking_id, invoice_id, amount, payment_type, reverses_payment_id, stripe_refund_id, recorded_by
-- from public.job_payments
-- where stripe_refund_id = 're_3UT9EDH6APIZIBd90qW04EFt';
