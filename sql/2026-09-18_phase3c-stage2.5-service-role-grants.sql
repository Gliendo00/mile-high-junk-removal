-- Phase 3C Stage 2.5 — explicit, code-tracked service_role grants for the
-- dumpster rental booking/payment flow.
--
-- Why this file exists: during Stage 2.5 staging testing, the booking/
-- payment flow did not work until GRANT statements were run by hand,
-- directly in the Supabase SQL editor, against the staging project. That
-- worked, but it means Production would silently depend on someone
-- remembering to repeat the exact same undocumented manual step during a
-- future Production rollout — a "worked once, from memory" step is
-- exactly the kind of thing that gets missed. This file makes those
-- grants a permanent, reviewable part of the schema instead, to be run
-- (like every other migration in this project) as a deliberate, visible
-- step — never assumed to already be in place.
--
-- CORRECTED 2026-09-18, after review: an earlier draft of this file also
-- included `REVOKE ALL ... FROM anon, authenticated` on all five tables.
-- That is REMOVED here. Staging testing directly observed that
-- `public.bookings` has row-level security ENABLED — so the earlier
-- draft's claim that "none of these tables have RLS" was wrong, and
-- changing anon/authenticated privileges on customers/bookings/
-- dumpster_rentals without first auditing each table's actual RLS
-- state/policies (a separate, not-yet-done piece of work) could silently
-- break something nothing in this Stage 2.5 change is meant to touch.
-- This file's scope is now narrowed to exactly what staging testing
-- proved was missing and needed: service_role's own CRUD grant. See
-- docs/phase-3/stage2.5-stripe-rental-payments-migration.md §5.3 for the
-- full corrected account, including which table is confirmed to have RLS.
--
-- Scope: exactly the CRUD operations the booking/payment flow actually
-- performs (SELECT, INSERT, UPDATE, DELETE — DELETE is used by
-- api/book.js's rollback paths, e.g. rollbackDumpsterBooking()). No
-- sequence/USAGE grant is needed anywhere here: every primary key in this
-- schema is gen_random_uuid(), never a serial/identity column. Table
-- names are schema-qualified (public.*) throughout.
--
-- This statement is idempotent — safe to run on staging (replacing the ad
-- hoc manual grants with this same tracked state) and equally safe to run
-- once, as an added step, during a clean Production install (see
-- sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql §5.1 in
-- docs/phase-3/stage2.5-stripe-rental-payments-migration.md). Nothing in
-- this file has been executed by this session — run it manually, the same
-- established convention every prior migration in this project follows.

-- ---------------------------------------------------------------------
-- service_role: SELECT, INSERT, UPDATE, DELETE on exactly the five tables
-- the dumpster rental booking/payment flow reads or writes.
--
-- Deliberately NOT included here: any change to anon/authenticated
-- privileges on these tables. That requires its own separate privilege/
-- RLS audit first (confirming exactly which tables have RLS enabled, what
-- policies exist, and what anon/authenticated currently can and cannot
-- do) before touching that surface at all — out of scope for this file.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.customers,
     public.bookings,
     public.dumpster_rentals,
     public.rental_payments,
     public.rental_additional_charges
  TO service_role;

-- ---------------------------------------------------------------------
-- service_role: SELECT, INSERT on booking_photos and expenses.
--
-- Discovered missing during Stage 2.5 staging verification of the Preview
-- CRM (not the Stripe rental flow itself) — the CRM's booking-detail and
-- expenses views failed until `GRANT SELECT ON public.booking_photos,
-- public.expenses TO service_role` was run by hand against staging. Same
-- root cause as the block above (§ file header): these two tables were
-- never created by a role whose ALTER DEFAULT PRIVILEGES covers
-- service_role, so the grant never back-filled.
--
-- INSERT is included, not just SELECT, because a source audit of every
-- service-role code path (api/upload-photo.js, api/admin/bookings.js,
-- api/admin/booking.js) found it is demonstrably required:
--   - api/upload-photo.js inserts into booking_photos when a job photo is
--     uploaded.
--   - api/admin/bookings.js inserts into expenses for the Daily Quick
--     Expense feature.
-- UPDATE/DELETE are deliberately NOT included on either table — no code
-- path performs either operation against booking_photos or expenses today.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT
  ON public.booking_photos,
     public.expenses
  TO service_role;

-- ---------------------------------------------------------------------
-- Verification (re-run any of these any time to re-confirm current state)
-- ---------------------------------------------------------------------
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('customers', 'bookings', 'dumpster_rentals', 'rental_payments', 'rental_additional_charges', 'booking_photos', 'expenses')
-- order by table_name, grantee, privilege_type;
-- -- expect: service_role has SELECT/INSERT/UPDATE/DELETE on the first five,
-- -- and SELECT/INSERT (only) on booking_photos and expenses.
--
-- -- Which of these tables actually have RLS enabled today (informational
-- -- only — this file does not change RLS on anything). Staging testing
-- -- directly observed public.bookings has it enabled; this query confirms
-- -- the current state of all seven rather than assuming:
-- select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
-- from pg_class
-- where relnamespace = 'public'::regnamespace
--   and relname in ('customers', 'bookings', 'dumpster_rentals', 'rental_payments', 'rental_additional_charges', 'booking_photos', 'expenses')
-- order by relname;

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file). Not
-- recommended: this would recreate the exact gap that caused the staging
-- failure this file fixes.
-- ---------------------------------------------------------------------
-- REVOKE SELECT, INSERT, UPDATE, DELETE
--   ON public.customers,
--      public.bookings,
--      public.dumpster_rentals,
--      public.rental_payments,
--      public.rental_additional_charges
--   FROM service_role;
--
-- REVOKE SELECT, INSERT
--   ON public.booking_photos,
--      public.expenses
--   FROM service_role;
