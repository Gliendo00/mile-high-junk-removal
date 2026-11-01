-- Dump Fee Tonnage Tracking (CRM phase, 2026-10-31).
--
-- Adds ONE nullable column to public.expenses — dump_weight_lbs, the
-- scale-ticket weight recorded alongside a Dump Fee expense. Pounds are the
-- canonical stored value (dump scale tickets print pounds); tons are always
-- DERIVED at read time as dump_weight_lbs / 2000 (api/_lib/dump-tonnage.js),
-- never stored, so the two can never drift apart.
--
-- Backward compatible by construction:
--   - nullable, no default, no backfill — every existing expense row stays
--     valid exactly as it is (NULL = "no weight recorded");
--   - no existing column is renamed, retyped, or dropped;
--   - the expense's dollar `amount` is untouched — weight is informational
--     only and never feeds any revenue/expense/net calculation.
--
-- Application rule (enforced in api/admin/bookings.js, not here): only a
-- category = 'dump_fees' row ever carries a weight; any other category is
-- always written with NULL.
--
-- !! ORDERING: run this migration BEFORE deploying the code that ships with
-- it. The new code selects dump_weight_lbs on every expense read; against a
-- database without the column, every expense list/create/edit would fail.
--
-- Run in the Supabase SQL editor. Idempotent (safe to re-run).

-- =======================================================================
-- 1. Column
-- =======================================================================
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS dump_weight_lbs numeric(10,2) NULL;

-- Positive and bounded (200,000 lb = 100 tons — far above any single
-- roll-off/truck scale ticket). NULL always allowed. Named so a re-run's
-- DROP ... IF EXISTS / ADD pair stays idempotent.
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_dump_weight_lbs_chk;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_dump_weight_lbs_chk
  CHECK (dump_weight_lbs IS NULL OR (dump_weight_lbs > 0 AND dump_weight_lbs <= 200000));

-- =======================================================================
-- 2. Grant — service_role's UPDATE on expenses is column-level (see
--    sql/2026-09-19_phase3c-stage3-service-role-grants.sql). Column grants
--    are additive, so this extends that list without restating it. INSERT
--    and SELECT are already table-wide there and cover the new column.
-- =======================================================================
GRANT UPDATE (dump_weight_lbs) ON public.expenses TO service_role;

-- =======================================================================
-- 3. Audit trigger — same function as the Stage 3 migration, re-created
--    with ONE added clause (dump_weight_lbs) so weight corrections land in
--    expense_audit_log exactly like every other field. Everything else is
--    byte-for-byte the original logic.
-- =======================================================================
CREATE OR REPLACE FUNCTION public.expenses_write_audit_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.created_by, 'create', NULL, NULL, NULL);
    RETURN NEW;
  END IF;

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
  IF NEW.dump_weight_lbs IS DISTINCT FROM OLD.dump_weight_lbs THEN
    INSERT INTO public.expense_audit_log (expense_id, changed_by, change_type, field_name, old_value, new_value)
    VALUES (NEW.id, NEW.updated_by, 'update', 'dump_weight_lbs', OLD.dump_weight_lbs::text, NEW.dump_weight_lbs::text);
  END IF;

  RETURN NEW;
END;
$$;
-- The two existing triggers (expenses_audit_insert / expenses_audit_update)
-- already point at this function by name — CREATE OR REPLACE above is
-- picked up by them automatically; they are not re-created here.

-- =======================================================================
-- 4. Index — the Home dashboard's Tonnage Tracked card filters on
--    "weighed dump fees" only. Partial, so it stays tiny.
-- =======================================================================
CREATE INDEX IF NOT EXISTS expenses_dump_weight_idx
  ON public.expenses (expense_date)
  WHERE dump_weight_lbs IS NOT NULL;

-- =======================================================================
-- Verification
-- =======================================================================
-- select column_name, data_type, numeric_precision, numeric_scale, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'expenses' and column_name = 'dump_weight_lbs';
--   -- expect: numeric, 10, 2, YES
--
-- select privilege_type from information_schema.column_privileges
--   where table_name = 'expenses' and column_name = 'dump_weight_lbs' and grantee = 'service_role';
--   -- expect at least: SELECT, INSERT, UPDATE
--
-- begin;
--   insert into expenses (expense_date, category, amount, dump_weight_lbs, created_by)
--     values (current_date, 'dump_fees', 68.00, 5000, 'test@example.com') returning id;
--   update expenses set dump_weight_lbs = 5240, updated_by = 'test@example.com' where id = '<id>';
--   select field_name, old_value, new_value from expense_audit_log where expense_id = '<id>';
--   -- expect: create row, then dump_weight_lbs 5000.00 -> 5240.00
-- rollback;

-- =======================================================================
-- Rollback (reference only — not executed). Re-run section 3 of
-- sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql first to
-- restore the trigger function without the dump_weight_lbs clause.
-- =======================================================================
-- DROP INDEX IF EXISTS public.expenses_dump_weight_idx;
-- REVOKE UPDATE (dump_weight_lbs) ON public.expenses FROM service_role;
-- ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_dump_weight_lbs_chk;
-- ALTER TABLE public.expenses DROP COLUMN IF EXISTS dump_weight_lbs;
