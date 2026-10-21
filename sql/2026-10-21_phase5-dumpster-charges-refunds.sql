-- Phase 5 — Dumpster Rental Extra Charges + Refunds.
--
-- Two independent pieces, both additive (no column dropped/renamed, no
-- existing CHECK narrowed):
--
-- 1. rental_additional_charges gains:
--    - 3 new charge_type values (relocation / blocked_pickup /
--      rule_violation) alongside the existing overweight_tonnage /
--      additional_days / other — see api/_lib/rental-pricing.js and
--      api/admin/booking.js's handleProposeCharge() for why none of these
--      three has a fixed rate anywhere in the current agreement: they
--      behave exactly like "other" (a flat, admin-entered amount), just
--      with their own reportable type instead of being lumped into
--      "other."
--    - 1 new status value, 'invoiced' — reached by the new
--      ?resource=charges PATCH {action:"invoice"} action (handleInvoiceCharges()
--      in api/admin/booking.js), which is a DIFFERENT terminal state from
--      'paid' (the existing direct-off-session-Stripe-charge pipeline,
--      left completely intact for ad-hoc immediate billing). 'invoiced'
--      means "this charge became an invoice_line_items row," never "this
--      charge was itself charged to a card."
--    - invoice_line_item_id: set only for a charge that reached 'invoiced',
--      pointing at the exact line item it became. ON DELETE SET NULL
--      (never CASCADE) — if a line item is ever deleted directly (today
--      only possible on a still-draft invoice), the charge row survives as
--      its own audit record rather than disappearing.
--    - calculated_amount / override_reason / overridden_by / overridden_at:
--      audit trail for Part 2/3's "allow an admin to override the final
--      amount, preserve the original calculated information." Only ever
--      populated for the two rate-based types (overweight_tonnage,
--      additional_days) — "other"/relocation/blocked_pickup/rule_violation
--      have no calculated baseline to override in the first place (the
--      admin-entered amount already IS the amount).
--
-- 2. job_payments gains exactly one column, stripe_refund_id, plus a
--    partial unique index on it — the refund-side mirror of the existing
--    job_payments_stripe_pi_idx (unique on stripe_payment_intent_id),
--    giving api/admin/booking.js's new handleRefundJobPayment() the same
--    idempotent-upsert safety mirrorStripePaymentToLedger() already relies
--    on for inbound Stripe captures: retrying the same confirmed Stripe
--    refund (e.g. after a crash between the Stripe call succeeding and the
--    local insert) can never create a second ledger row.
--    No new column is needed to link a refund back to the payment it
--    refunds — the existing reverses_payment_id (added in Stage 3) already
--    does this; see api/admin/booking.js's validateManualPaymentFields()/
--    handleRefundJobPayment() for how it's now also used, in addition to
--    its original "manual correction" role, to compute a payment's
--    remaining refundable balance.
--
-- Nothing here touches invoices, invoice_line_items, or bookings. No
-- existing row's data changes. Both tables already have full
-- SELECT/INSERT/UPDATE/DELETE service_role grants (see
-- 2026-09-18_phase3c-stage2.5-service-role-grants.sql and
-- 2026-09-19_phase3c-stage3-service-role-grants.sql) that already cover
-- any new column — no grant changes needed.
--
-- Run this once against production Supabase before deploying the code
-- that depends on it. Not executed by this agent.

BEGIN;

ALTER TABLE public.rental_additional_charges
  DROP CONSTRAINT IF EXISTS rental_additional_charges_charge_type_check;
ALTER TABLE public.rental_additional_charges
  ADD CONSTRAINT rental_additional_charges_charge_type_check
  CHECK (charge_type IN ('overweight_tonnage', 'additional_days', 'relocation', 'blocked_pickup', 'rule_violation', 'other'));

ALTER TABLE public.rental_additional_charges
  DROP CONSTRAINT IF EXISTS rental_additional_charges_status_check;
ALTER TABLE public.rental_additional_charges
  ADD CONSTRAINT rental_additional_charges_status_check
  CHECK (status IN ('proposed', 'approved', 'processing', 'paid', 'failed', 'voided', 'error_pending_review', 'paid_reconciliation_required', 'requires_customer_action', 'invoiced'));

ALTER TABLE public.rental_additional_charges
  ADD COLUMN IF NOT EXISTS invoice_line_item_id uuid NULL REFERENCES public.invoice_line_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS calculated_amount numeric(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS override_reason text NULL,
  ADD COLUMN IF NOT EXISTS overridden_by text NULL,
  ADD COLUMN IF NOT EXISTS overridden_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_rental_additional_charges_invoice_line_item_id
  ON public.rental_additional_charges (invoice_line_item_id)
  WHERE invoice_line_item_id IS NOT NULL;

ALTER TABLE public.job_payments
  ADD COLUMN IF NOT EXISTS stripe_refund_id text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_payments_stripe_refund_idx
  ON public.job_payments (stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

COMMIT;

-- Verification (re-run any time to confirm current state):
--
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.rental_additional_charges'::regclass
--   and conname in ('rental_additional_charges_charge_type_check', 'rental_additional_charges_status_check');
--
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'rental_additional_charges'
--   and column_name in ('invoice_line_item_id', 'calculated_amount', 'override_reason', 'overridden_by', 'overridden_at');
--
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'job_payments' and column_name = 'stripe_refund_id';
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'job_payments' and indexname = 'job_payments_stripe_refund_idx';

-- Rollback (destructive — do not run against production without a fresh
-- backup/confirmation; nothing in this migration touches existing rows, so
-- rolling back only matters if you also need to drop the new columns):
--
-- ALTER TABLE public.job_payments DROP COLUMN IF EXISTS stripe_refund_id;
-- ALTER TABLE public.rental_additional_charges
--   DROP COLUMN IF EXISTS overridden_at,
--   DROP COLUMN IF EXISTS overridden_by,
--   DROP COLUMN IF EXISTS override_reason,
--   DROP COLUMN IF EXISTS calculated_amount,
--   DROP COLUMN IF EXISTS invoice_line_item_id;
-- ALTER TABLE public.rental_additional_charges DROP CONSTRAINT IF EXISTS rental_additional_charges_status_check;
-- ALTER TABLE public.rental_additional_charges ADD CONSTRAINT rental_additional_charges_status_check
--   CHECK (status IN ('proposed','approved','processing','paid','failed','voided','error_pending_review','paid_reconciliation_required','requires_customer_action'));
-- ALTER TABLE public.rental_additional_charges DROP CONSTRAINT IF EXISTS rental_additional_charges_charge_type_check;
-- ALTER TABLE public.rental_additional_charges ADD CONSTRAINT rental_additional_charges_charge_type_check
--   CHECK (charge_type IN ('overweight_tonnage','additional_days','other'));
