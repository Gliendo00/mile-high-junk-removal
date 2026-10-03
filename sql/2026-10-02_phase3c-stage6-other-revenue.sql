-- Phase 3C Stage 6 (Batch 3) — Other Revenue ledger (Metal Recycling,
-- Resale Sales).
-- To be run manually in the Supabase SQL editor. This project has no
-- migration runner (see sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql
-- for the established convention this file follows).
--
-- Goal: track money the business receives that is NOT a job's own
-- collected/quoted amount (job_payments/bookings.final_price) — starting
-- with scrap-metal recycling proceeds and resale of reusable items/
-- furniture recovered on jobs — without creating a fake booking/job row to
-- hold it. Modeled as a NEW, small, append-only ledger table, closest to
-- job_payments' shape (never edited in place — correct a mistake by
-- voiding it and recording a new row) rather than expenses' shape (which
-- supports in-place edits precisely because expenses has a trigger-backed
-- audit log to make that safe). other_revenue has no "update" action and
-- no audit-log table for the same reason job_payments doesn't: there is
-- nothing to audit beyond create/void, both of which are already fully
-- captured on the row itself (voided_at/voided_reason/voided_by).
--
-- Adds, and nothing else:
--   1. other_revenue — new table. Two allowed `type` values to start
--      (metal_recycling, resale_sale); the CHECK constraint is widened via
--      a future migration if a third type is ever added, same pattern as
--      job_payments.payment_method's own CHECK (see
--      sql/2026-09-19_phase3c-job-payments-add-methods.sql for that
--      precedent in this exact project).
--
-- Nothing in this file touches bookings, customers, job_payments,
-- expenses, expense_audit_log, rental_payments, rental_additional_charges,
-- dumpster_rentals, or booking_photos. bookings.final_price/estimated_price
-- and the existing completed-job Revenue fallback in
-- admin/schedule-financials.js are completely untouched — this table is
-- additive to Revenue, never a replacement for how job revenue is computed.
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.

-- =======================================================================
-- 1. other_revenue — new table.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.other_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Allowlisted source type. 'metal_recycling' = scrap/metal recycling
  -- proceeds. 'resale_sale' = money from reselling a reusable item/
  -- furniture/etc. recovered on a job. Both are Other Revenue, never Job
  -- Revenue — see api/_lib/other-revenue-types.js for the app-level
  -- allowlist this CHECK must stay in sync with.
  type text NOT NULL CHECK (type IN ('metal_recycling', 'resale_sale')),

  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  revenue_date date NOT NULL,

  -- Free-text description (e.g. "Scrap load — appliances" or "Sold
  -- recovered sectional sofa"). Nullable — not every entry needs one, but
  -- the admin UI strongly encourages it since a bare "$185" with no
  -- description is hard to reconcile months later.
  note text NULL,

  -- Optional link to the job this revenue came from (e.g. metal pulled
  -- from a specific cleanout). Deliberately NOT required — the business
  -- also recycles/resells material that isn't tied to one specific job
  -- (e.g. a dump-run accumulation). ON DELETE SET NULL, matching
  -- expenses.booking_id's exact treatment: losing the link if a job is
  -- ever hard-deleted (which nothing in this app actually does) must never
  -- take a real revenue row down with it.
  booking_id uuid NULL REFERENCES public.bookings(id) ON DELETE SET NULL,

  -- Append-only ledger row — no "update" action exists in the application
  -- layer, and service_role's own grant below enforces the same rule a
  -- second way at the database level. A wrong entry is corrected by
  -- voiding it (reason required) and recording a new, correct row — same
  -- financial-audit pattern as job_payments, never an in-place edit.
  voided_at timestamptz NULL,
  voided_reason text NULL,
  -- Who voided it — tracked separately from created_by since this is a
  -- single-purpose ledger where "void" is the only write after creation
  -- (unlike expenses.updated_by, which conflates an edit-author and a
  -- void-author because expenses supports both actions).
  voided_by text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NULL
);

CREATE INDEX IF NOT EXISTS other_revenue_revenue_date_idx ON public.other_revenue (revenue_date);
CREATE INDEX IF NOT EXISTS other_revenue_booking_id_idx ON public.other_revenue (booking_id);

ALTER TABLE public.other_revenue ENABLE ROW LEVEL SECURITY;
-- No RLS policies created — matches every other table in this schema's
-- posture (service_role carries BYPASSRLS; all access is via requireAdmin()
-- gating api/admin/bookings.js before any query runs; see
-- docs/phase-1/admin-security-requirements.md).

-- =======================================================================
-- 2. service_role grants. A newly created table has NO privileges granted
--    to service_role by default in this project (confirmed directly,
--    twice, in Stage 3's and Batch 2's own rollouts) — without this
--    section, every other_revenue write would fail outright. REVOKE ALL
--    first, then GRANT exactly the intended privileges, so the end state
--    is deterministic regardless of whatever (if anything) already exists
--    — the same lesson Stage 3's pre-push audit found the hard way for
--    job_payments/expenses (see docs/phase-3/stage3-payments-expenses-
--    proposal.md §9.2).
--
--    UPDATE is column-scoped to exactly the three void-related columns —
--    amount/type/revenue_date/note/booking_id/created_by/created_at are
--    NEVER grantable for UPDATE, enforcing "append-only, void don't edit"
--    at the database permission layer too, independent of the API.
--    DELETE is never granted at all.
-- =======================================================================
REVOKE ALL ON public.other_revenue FROM service_role;
GRANT SELECT, INSERT ON public.other_revenue TO service_role;
GRANT UPDATE (voided_at, voided_reason, voided_by, updated_at) ON public.other_revenue TO service_role;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'other_revenue'
--   order by ordinal_position;
-- -- expect 12 columns: id, type, amount, revenue_date, note, booking_id,
-- -- voided_at, voided_reason, voided_by, created_at, updated_at, created_by.
--
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.other_revenue'::regclass;
-- -- expect: amount CHECK (amount > 0); type CHECK (type IN ('metal_recycling','resale_sale'));
-- -- booking_id FK to bookings(id) with no ON DELETE CASCADE (SET NULL instead).
--
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role'; -- expect rolbypassrls = true
--
-- -- The authoritative effective-privilege check (what Postgres itself uses
-- -- to allow/deny a query) — run AFTER applying §2 above:
-- select has_table_privilege('service_role', 'public.other_revenue', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.other_revenue', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.other_revenue', 'DELETE');  -- expect false
-- select has_column_privilege('service_role', 'public.other_revenue', 'voided_at', 'UPDATE');     -- expect true
-- select has_column_privilege('service_role', 'public.other_revenue', 'voided_reason', 'UPDATE'); -- expect true
-- select has_column_privilege('service_role', 'public.other_revenue', 'voided_by', 'UPDATE');     -- expect true
-- select has_column_privilege('service_role', 'public.other_revenue', 'amount', 'UPDATE');        -- expect false
-- select has_column_privilege('service_role', 'public.other_revenue', 'type', 'UPDATE');          -- expect false
-- select has_column_privilege('service_role', 'public.other_revenue', 'revenue_date', 'UPDATE');  -- expect false
-- select has_column_privilege('service_role', 'public.other_revenue', 'booking_id', 'UPDATE');    -- expect false

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON public.other_revenue FROM service_role;
-- DROP TABLE IF EXISTS public.other_revenue;
