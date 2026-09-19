-- Phase 3C Stage 3 — Job Payment Ledger + Expense Management
-- To be run manually in the Supabase SQL editor. This project has no
-- migration runner (see sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql
-- for the established convention this file follows).
--
-- Full design writeup: docs/phase-3/stage3-payments-expenses-proposal.md
--
-- Adds, and nothing else:
--   1. job_payments — a new, cross-service-type financial ledger. Every
--      booking (junk removal, light demo, AND dumpster rental) can have
--      zero or more payment rows here: manual entries (cash/Zelle/Venmo/
--      check/card recorded by an admin) and auto-mirrored Stripe
--      collections from the existing rental_payments/rental_additional_charges
--      flow (see the ledger-mirroring code in api/book.js, api/admin/booking.js,
--      api/stripe-webhook.js — none of which had their Stripe logic changed
--      for this). rental_payments/rental_additional_charges remain the
--      Stripe-operational tables (capture state, disputes, idempotency);
--      job_payments is the read-side ledger for "what has this job actually
--      collected," across every service type.
--   2. expenses — extended in place with nullable columns only (vendor,
--      payment_method, booking_id, receipt_reference, soft-void, who-changed-it).
--      No existing column is altered or renamed. Written with `IF NOT EXISTS`
--      guards throughout so this file is safe to run regardless of whether
--      Production already has the base table from the Stage 2.4 addendum
--      (docs/phase-3/stage2.4-expenses-migration.md) — CONFIRM CURRENT STATE
--      FIRST using the read-only query at the bottom of this file before
--      running anything.
--   3. expense_audit_log — a new, database-enforced audit trail for
--      `expenses`, written automatically by a trigger (see §3 below for why
--      a trigger was chosen over an application-level audit write).
--
-- Nothing in this file touches bookings, customers, dumpster_rentals,
-- rental_payments, rental_additional_charges, or booking_photos.
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only. Tells you whether
--    `expenses` already exists in this environment and, if so, which of
--    the new columns (if any) it's already missing — so you know exactly
--    what section 2 below will actually do before you run it.
-- =======================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'expenses'
-- order by ordinal_position;
-- -- Empty result = expenses does not exist yet in this environment; the
-- -- CREATE TABLE IF NOT EXISTS in section 2 will create it fresh with
-- -- every column (original + new) in one step.

-- =======================================================================
-- 1. job_payments — new table.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.job_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,

  -- Append-only ledger row. amount is ALWAYS a positive quantity —
  -- payment_type is what determines whether it increases or decreases
  -- collected revenue (see the "Amount/refund semantics" section of
  -- docs/phase-3/stage3-payments-expenses-proposal.md for the full
  -- reasoning, and job-payments-ledger.js's netCollectedAmount() for the
  -- one place this convention is computed from):
  --   collected = SUM(amount WHERE payment_type='payment' AND voided_at IS NULL)
  --             - SUM(amount WHERE payment_type='refund'  AND voided_at IS NULL)
  amount numeric(10,2) NOT NULL CHECK (amount > 0),

  -- 'card_stripe' is set ONLY by the ledger-mirroring code below (never
  -- selectable by an admin manually entering a payment — the app layer
  -- enforces this, not this CHECK constraint, since a CHECK can't see who
  -- is calling). The other four are the only manual-entry choices.
  payment_method text NOT NULL
    CHECK (payment_method IN ('card_stripe', 'cash', 'zelle', 'venmo', 'check')),

  -- 'payment' increases collected revenue; 'refund' decreases it. There is
  -- no third type — a wrong entry is corrected by voiding it and adding a
  -- new 'payment' row (see reverses_payment_id below), never by an
  -- 'adjustment' type that would leave the sign ambiguous.
  payment_type text NOT NULL DEFAULT 'payment'
    CHECK (payment_type IN ('payment', 'refund')),

  payment_date date NOT NULL,
  notes text NULL,

  -- Set only by the auto-mirroring code (see api/_lib/job-payments-ledger.js).
  -- The partial UNIQUE index below is what makes mirroring idempotent: the
  -- same PaymentIntent can never produce two ledger rows, no matter which
  -- of the several confirmed-success code paths (the synchronous capture
  -- in api/book.js, the synchronous off-session charge in
  -- api/admin/booking.js's handleApprove/handleCheckStatus, or the
  -- asynchronous webhook backstop in api/stripe-webhook.js) happens to be
  -- the one that runs the mirror call for a given transaction.
  stripe_payment_intent_id text NULL,

  -- Financial-audit correction trail (goal: "preserve the original entry,
  -- void/reverse it, create the corrected entry" — never edit amount/
  -- method/type in place). When a new row is entered specifically to
  -- correct a prior wrong one, this points at the row it corrects. Nullable
  -- and purely informational — not required for the void mechanism itself
  -- (voided_at/voided_reason on the ORIGINAL row is what actually excludes
  -- it from the collected-revenue sum), just improves traceability from the
  -- corrected row back to what it replaced.
  reverses_payment_id uuid NULL REFERENCES public.job_payments(id) ON DELETE SET NULL,

  -- Soft-void only — there is no hard-delete path for a payment row, ever
  -- (application code never issues a DELETE against this table, and
  -- service_role is never granted DELETE on it either — see the grants
  -- file). A voided row is excluded from the collected-revenue sum but
  -- stays in the table permanently as the historical record that it
  -- existed and was corrected.
  voided_at timestamptz NULL,
  voided_reason text NULL,

  -- Admin email who recorded this row, for manual entries; NULL for an
  -- auto-mirrored Stripe row (there is no admin action to attribute it to).
  recorded_by text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_payments_booking_id_idx ON public.job_payments (booking_id);

-- Plain (NOT partial) UNIQUE index — the idempotency guarantee for Stripe
-- mirroring described above. Manual entries always have a NULL
-- stripe_payment_intent_id; a plain UNIQUE index already permits unlimited
-- NULLs on its own (NULL is never considered equal to another NULL for
-- uniqueness purposes in Postgres), so no partial WHERE predicate is
-- needed to achieve that — same pattern this project already established
-- for rental_payments.idempotency_key/booking_id and
-- dumpster_rentals.booking_id (see their own migration SQL).
--
-- CORRECTED after a pre-push audit (2026-09-19): the original version of
-- this index added a `WHERE stripe_payment_intent_id IS NOT NULL` partial
-- predicate — reasoned about as "belt and suspenders" for the nullable-
-- safety already noted above, but never actually necessary for it. That
-- predicate is a real bug: PostgreSQL requires an `ON CONFLICT (col)`
-- clause's target to exactly match a unique index, INCLUDING its partial
-- predicate — a plain `ON CONFLICT (stripe_payment_intent_id)` (which is
-- exactly what mirrorStripePaymentToLedger()'s
-- `.upsert(payload, {onConflict: "stripe_payment_intent_id", ignoreDuplicates: true})`
-- call produces) does NOT match a partial index and Postgres rejects it
-- outright with "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" — on every single call, not just on an actual
-- duplicate. Confirmed directly against a real PostgreSQL engine before
-- and after this fix: the partial version fails every upsert; this plain
-- version succeeds, still permits unlimited NULL rows, and a genuine
-- duplicate stripe_payment_intent_id (inserted a second time without
-- ON CONFLICT) is still correctly rejected by the constraint. This bug was
-- never caught by this project's own offline JS test suite because its
-- fake Supabase clients simulate `.upsert()` in memory without replicating
-- real PostgreSQL's ON-CONFLICT-target-matching rules.
CREATE UNIQUE INDEX IF NOT EXISTS job_payments_stripe_pi_idx
  ON public.job_payments (stripe_payment_intent_id);

ALTER TABLE public.job_payments ENABLE ROW LEVEL SECURITY;
-- No RLS policies created — matches every other table in this schema's
-- posture (see docs/phase-1/admin-security-requirements.md): all access is
-- via the service-role client, gated by requireAdmin() before any query
-- runs (the one exception, the ledger-mirroring calls, run from
-- api/stripe-webhook.js and api/book.js, both already service-role-only,
-- signature-verified/server-authoritative code paths with no direct client
-- input reaching this table).

-- =======================================================================
-- 2. expenses — extend in place. CREATE TABLE IF NOT EXISTS carries the
--    ORIGINAL Stage 2.4 shape forward unchanged (so this is a no-op columns-
--    wise if the table already exists, including on staging, which has it
--    at the original shape); every ADD COLUMN IF NOT EXISTS below is
--    additive and nullable, so it back-fills cleanly against any existing
--    rows with no default-value backfill required.
--
--    No existing column (expense_date, category, amount, note, created_at,
--    updated_at) is renamed, retyped, or dropped. No existing persisted
--    category value changes meaning — see api/_lib/expense-categories.js
--    for the full old-key -> new-label mapping; the stable DB keys
--    (fuel/dump_fees/meals/repairs_maintenance/advertising/supplies/
--    miscellaneous) are unchanged, only their display labels and the set of
--    additional keys grew.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL,
  category text NOT NULL,
  amount numeric(10,2) NOT NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS vendor text NULL,
  ADD COLUMN IF NOT EXISTS payment_method text NULL,
  ADD COLUMN IF NOT EXISTS booking_id uuid NULL REFERENCES public.bookings(id) ON DELETE SET NULL,
  -- Plain text field, not a file-upload pipeline — e.g. a receipt number, a
  -- short note of where the receipt is filed, an invoice #. A real
  -- file-attachment feature (mirroring booking_photos' Storage-bucket
  -- pattern) is a bigger addition explicitly out of scope for this stage.
  ADD COLUMN IF NOT EXISTS receipt_reference text NULL,
  -- Soft-void — the ONLY removal mechanism. No hard-delete endpoint exists
  -- in application code, and service_role is never granted DELETE on this
  -- table (see the grants file) — both independently prevent an expense
  -- row from ever disappearing, which is also what keeps
  -- expense_audit_log's foreign key meaningful forever (see §3).
  ADD COLUMN IF NOT EXISTS voided_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS voided_reason text NULL,
  -- Plain columns (not a session variable) read directly by the audit
  -- trigger below via NEW.created_by / NEW.updated_by — see §3 for why this
  -- was chosen over a transaction-local session GUC.
  ADD COLUMN IF NOT EXISTS created_by text NULL,
  ADD COLUMN IF NOT EXISTS updated_by text NULL;

CREATE INDEX IF NOT EXISTS expenses_expense_date_idx ON public.expenses (expense_date);
CREATE INDEX IF NOT EXISTS expenses_booking_id_idx ON public.expenses (booking_id);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 3. expense_audit_log — new table, written automatically by a trigger.
--
-- Why a trigger, not an application-level audit write: this is financial
-- data, and the owner explicitly asked for database-enforced history if it
-- can be done cleanly. A trigger guarantees every change to `expenses` is
-- captured no matter what touches the row — including a hypothetical
-- future direct SQL fix run by hand in the Supabase editor, which an
-- application-level "insert an audit row after every API update" approach
-- would silently miss entirely. It also removes an entire class of bug
-- (the app forgetting to log a field, or logging it inconsistently between
-- the create/update/void code paths) by making the log a single, mechanical
-- function of OLD vs NEW, not something scattered across handler code. The
-- trade-off — a small amount of PL/pgSQL instead of a JS helper — is worth
-- it here specifically because correctness of financial history matters
-- more than avoiding a second language in this one file.
--
-- "Who made the change" (changed_by) is populated by reading NEW.created_by
-- / NEW.updated_by directly — plain columns the API sets as part of the
-- SAME insert/update statement — rather than a transaction-local session
-- variable (e.g. `set_config(...)`), because this project's Supabase access
-- goes through PostgREST via supabase-js, which does not give application
-- code a way to guarantee a `SET` and the following `UPDATE` land in the
-- same transaction. Reading it off NEW instead has no such requirement: the
-- trigger fires within the very statement that set the column.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.expense_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately NOT ON DELETE CASCADE — there is no hard-delete path for
  -- expenses (see §2), but if that ever changed, audit history must never
  -- vanish along with the row it documents. The default (NO ACTION) means
  -- Postgres would refuse to delete an expenses row that still has audit
  -- rows referencing it, which is exactly the safety net wanted here.
  expense_id uuid NOT NULL REFERENCES public.expenses(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NULL,
  change_type text NOT NULL CHECK (change_type IN ('create', 'update', 'void')),
  field_name text NULL,
  old_value text NULL,
  new_value text NULL
);

CREATE INDEX IF NOT EXISTS expense_audit_log_expense_id_idx ON public.expense_audit_log (expense_id);

ALTER TABLE public.expense_audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.expenses_write_audit_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.created_by, 'create', NULL, NULL, NULL);
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' from here down. One row per changed field, so a
  -- multi-field correction (e.g. amount AND category both fixed in the
  -- same edit) produces one clearly separate log entry per field rather
  -- than one row with several values mashed together.
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'void', 'voided_reason', NULL, NEW.voided_reason);
  END IF;

  IF NEW.expense_date IS DISTINCT FROM OLD.expense_date THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'expense_date', OLD.expense_date::text, NEW.expense_date::text);
  END IF;
  IF NEW.category IS DISTINCT FROM OLD.category THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'category', OLD.category, NEW.category);
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'amount', OLD.amount::text, NEW.amount::text);
  END IF;
  IF NEW.note IS DISTINCT FROM OLD.note THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'note', OLD.note, NEW.note);
  END IF;
  IF NEW.vendor IS DISTINCT FROM OLD.vendor THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'vendor', OLD.vendor, NEW.vendor);
  END IF;
  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'payment_method', OLD.payment_method, NEW.payment_method);
  END IF;
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'booking_id', OLD.booking_id::text, NEW.booking_id::text);
  END IF;
  IF NEW.receipt_reference IS DISTINCT FROM OLD.receipt_reference THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'receipt_reference', OLD.receipt_reference, NEW.receipt_reference);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_audit_insert ON public.expenses;
CREATE TRIGGER expenses_audit_insert
  AFTER INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_write_audit_log();

DROP TRIGGER IF EXISTS expenses_audit_update ON public.expenses;
CREATE TRIGGER expenses_audit_update
  AFTER UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_write_audit_log();

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name in ('job_payments', 'expenses', 'expense_audit_log')
--   order by table_name, ordinal_position;
--
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid in ('public.job_payments'::regclass, 'public.expenses'::regclass, 'public.expense_audit_log'::regclass);
--
-- select tgname, tgrelid::regclass from pg_trigger
--   where tgrelid = 'public.expenses'::regclass and not tgisinternal;
--
-- -- Exercise the trigger end-to-end (run in a throwaway transaction, then
-- -- ROLLBACK — never commit test data):
-- -- begin;
-- --   insert into expenses (expense_date, category, amount, created_by)
-- --     values (current_date, 'fuel', 68.00, 'test@example.com') returning id;
-- --   -- (use the returned id below)
-- --   update expenses set amount = 76.00, updated_by = 'test@example.com' where id = '<id>';
-- --   select * from expense_audit_log where expense_id = '<id>' order by changed_at;
-- --   -- expect: one 'create' row, one 'update' row (field_name='amount', old_value='68.00', new_value='76.00')
-- -- rollback;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- DROP TRIGGER IF EXISTS expenses_audit_update ON public.expenses;
-- DROP TRIGGER IF EXISTS expenses_audit_insert ON public.expenses;
-- DROP FUNCTION IF EXISTS public.expenses_write_audit_log();
-- DROP TABLE IF EXISTS public.expense_audit_log;
-- ALTER TABLE public.expenses
--   DROP COLUMN IF EXISTS vendor,
--   DROP COLUMN IF EXISTS payment_method,
--   DROP COLUMN IF EXISTS booking_id,
--   DROP COLUMN IF EXISTS receipt_reference,
--   DROP COLUMN IF EXISTS voided_at,
--   DROP COLUMN IF EXISTS voided_reason,
--   DROP COLUMN IF EXISTS created_by,
--   DROP COLUMN IF EXISTS updated_by;
-- DROP INDEX IF EXISTS expenses_booking_id_idx;
-- DROP TABLE IF EXISTS public.job_payments;
