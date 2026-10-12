-- Phase 3 (Site Improvement Agent) — "How'd it go?" completion note.
--
-- Adds ONE new nullable text column to `bookings`: a quick, internal-only
-- operational note captured when (or shortly after) a job is marked
-- completed — e.g. "Hot tub removal in Wheat Ridge, easy backyard
-- access, cut into sections." Deliberately separate from the existing
-- `internal_notes` column, which is a general-purpose private note
-- (gate codes, access instructions, etc.) entered any time via the full
-- Edit Job form and used across every status, not specifically an
-- after-the-fact account of how the job itself went.
--
-- This is PRIVATE, operational data. It is never shown to the customer,
-- never sent anywhere automatically, and — per the Site Improvement
-- Agent's business-context boundary (agent/lib/business-context.js) —
-- never used as public website copy on its own. See that module's
-- header and docs for the private/publication-safe separation this feeds.
--
-- No service_role GRANT needed: same situation as
-- sql/2026-10-07_phase3c-stage5d-booking-source-intake.sql's own
-- source_intake_id column — `bookings` has never used this project's
-- later REVOKE-ALL-then-GRANT-exact convention (job_payments/expenses/
-- expense_audit_log only); no migration in this directory grants
-- service_role access to `bookings` at all, because it already had a
-- broad table-wide grant predating that convention. A table-wide GRANT
-- UPDATE with no column list already covers any new column added here.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS operational_note text NULL;

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'bookings' and column_name = 'operational_note';
-- -- expect: operational_note | text | YES

-- select has_column_privilege('service_role', 'public.bookings', 'operational_note', 'UPDATE'); -- expect true, with no new grant run
-- select has_column_privilege('service_role', 'public.bookings', 'operational_note', 'SELECT'); -- expect true, with no new grant run

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS operational_note;
