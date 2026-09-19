-- Phase 3C — add two manual payment-method keys to job_payments.
--
-- Why: the owner asked for two more manual payment methods admins can pick
-- when recording a job_payments row: "Card (Venmo)" (internal key
-- card_venmo) and "Other" (internal key other, and the one method that
-- requires a short note/description — enforced in
-- api/admin/booking.js's handleCreateJobPayment(), not by this migration).
-- The existing five methods (card_stripe/cash/zelle/venmo/check) are
-- unchanged and keep working exactly as before.
--
-- job_payments.payment_method is constrained by an inline CHECK added in
-- the original CREATE TABLE statement
-- (sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql):
--   payment_method text NOT NULL CHECK (payment_method IN
--     ('card_stripe', 'cash', 'zelle', 'venmo', 'check'))
-- A CHECK constraint can't be widened in place — it has to be dropped and
-- recreated with the new value list. Postgres auto-named the original,
-- unnamed inline CHECK job_payments_payment_method_check (the standard
-- <table>_<column>_check pattern for an unnamed constraint on one column).
-- Confirm this with the preflight query below before running anything, in
-- case that assumption is ever wrong for this table in this environment.
--
-- Additive only. No existing row's payment_method is touched (every
-- existing value is still valid under the widened list), no other column,
-- table, index, or trigger is affected.

-- =======================================================================
-- PREFLIGHT — run this FIRST, by itself. Read-only. Confirms the
-- constraint's current name and definition before the ALTER below assumes
-- it.
-- =======================================================================
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.job_payments'::regclass
--   and contype = 'c'
--   and pg_get_constraintdef(oid) ilike '%payment_method%';

-- =======================================================================
-- MIGRATION
-- =======================================================================
ALTER TABLE public.job_payments
  DROP CONSTRAINT IF EXISTS job_payments_payment_method_check;

ALTER TABLE public.job_payments
  ADD CONSTRAINT job_payments_payment_method_check
  CHECK (payment_method IN ('card_stripe', 'cash', 'zelle', 'venmo', 'check', 'card_venmo', 'other'));

-- =======================================================================
-- Verification (re-run any time to re-confirm current state)
-- =======================================================================
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.job_payments'::regclass
--   and conname = 'job_payments_payment_method_check';
-- Expect: CHECK ((payment_method = ANY (ARRAY['card_stripe'::text,
--   'cash'::text, 'zelle'::text, 'venmo'::text, 'check'::text,
--   'card_venmo'::text, 'other'::text])))

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.job_payments DROP CONSTRAINT IF EXISTS job_payments_payment_method_check;
-- ALTER TABLE public.job_payments ADD CONSTRAINT job_payments_payment_method_check
--   CHECK (payment_method IN ('card_stripe', 'cash', 'zelle', 'venmo', 'check'));
-- Note: rolling back after any 'card_venmo'/'other' rows have already been
-- written would leave those rows violating the narrowed constraint — the
-- rollback ALTER would then fail until those rows are voided/corrected, by
-- Postgres's own design (a CHECK constraint is validated against existing
-- rows when added).
