-- Phase 4, Stage 1 — Dumpster Pickup Auto-Job.
--
-- Two new nullable, self/cross-referential lineage columns so that creating
-- a dumpster_rental booking can automatically create exactly one linked
-- "pickup" booking (service_type = 'dumpster_pickup', an internal-only value
-- never offered to the public /book flow), the same way this project
-- already links estimates/leads/intakes to the bookings they produced
-- (source_intake_id, source_lead_id, source_estimate_id — see
-- sql/2026-10-07_phase3c-stage5d-booking-source-intake.sql and
-- sql/2026-10-12_estimate-workflow.sql). To be run manually in the Supabase
-- SQL editor, same convention as every prior migration in this directory.
-- NOT executed by this session.
--
-- Why two columns instead of one: the application needs to walk the
-- relationship in both directions —
--   1. From the rental's dumpster_rentals row, find its pickup booking
--      quickly (to mirror the pickup date into the pickup booking's
--      appointment_date whenever delivery_date/pickup_date changes, and to
--      show "Pickup job: <link>" on the rental's own detail page).
--   2. From the pickup booking itself, find the rental booking it belongs to
--      (to render "Pickup for <client>'s dumpster rental" on the pickup's
--      own card/detail, and so revenue/overage logic always attributes
--      money to the RENTAL booking, never the pickup booking).
--
-- Both columns are nullable: source_rental_booking_id is NULL for every
-- booking that isn't an auto-generated pickup leg (i.e. every junk_removal/
-- light_demo/dumpster_rental booking, which is the overwhelming majority);
-- pickup_booking_id is NULL for every dumpster_rentals row until its pickup
-- booking has actually been created.
--
-- The partial UNIQUE index on source_rental_booking_id is the actual safety
-- guarantee behind "repeated create/update/retry cannot create duplicate
-- pickup jobs" — enforced by Postgres, not application discipline, exactly
-- like bookings_source_intake_id_uniq / bookings_source_estimate_id_uniq
-- already do for their own idempotency cases. api/admin/booking.js's
-- handleCreate() will get the identical "insert; on a unique_violation
-- against THIS constraint, fetch and return the row that already exists
-- instead of erroring or duplicating" handling those two already use.
--
-- The partial UNIQUE index on dumpster_rentals.pickup_booking_id is a
-- defensive mirror of the same guarantee in the other direction (one
-- booking can never be claimed as the pickup leg of two different rentals)
-- — belt-and-suspenders alongside the bookings-side constraint, matching
-- this project's existing posture of enforcing 1:1 relationships at the DB
-- layer wherever practical (dumpster_rentals.booking_id already has its own
-- UNIQUE for the same reason).
--
-- No ON DELETE override on either FK — bare REFERENCES, same as
-- source_intake_id/source_lead_id/source_estimate_id. This app never hard-
-- deletes bookings (archive-only), so the default RESTRICT behavior is
-- correct and consistent with the existing lineage columns.
--
-- Nothing in this file touches customers, job_payments, expenses,
-- rental_payments, rental_additional_charges, or any other table. No new
-- service_type CHECK constraint is added — service_type has never had a
-- DB-level CHECK in this project (confirmed: grep of every sql/*.sql file
-- finds none), it's enforced only by the app-level SERVICE_TYPES arrays in
-- api/book.js and api/admin/booking.js. The new 'dumpster_pickup' value is
-- added to api/admin/booking.js's internal SERVICE_LABELS only — it is
-- never added to api/book.js's public-facing SERVICE_TYPES, so the public
-- booking API cannot be made to create one.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings' and column_name = 'source_rental_booking_id';
-- -- expect: zero rows (the column doesn't exist yet)
--
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'dumpster_rentals' and column_name = 'pickup_booking_id';
-- -- expect: zero rows (the column doesn't exist yet)
--
-- select has_table_privilege('service_role', 'public.bookings', 'INSERT'); -- expect true (already, from Phase 1)
-- select has_table_privilege('service_role', 'public.dumpster_rentals', 'UPDATE'); -- expect true (already)

-- =======================================================================
-- 1. bookings.source_rental_booking_id — the pickup leg's pointer back to
--    the dumpster rental booking it belongs to.
-- =======================================================================
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS source_rental_booking_id uuid NULL REFERENCES public.bookings(id);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_source_rental_booking_id_uniq
  ON public.bookings (source_rental_booking_id)
  WHERE source_rental_booking_id IS NOT NULL;

-- =======================================================================
-- 2. dumpster_rentals.pickup_booking_id — the rental's pointer forward to
--    its auto-generated pickup booking.
-- =======================================================================
ALTER TABLE public.dumpster_rentals
  ADD COLUMN IF NOT EXISTS pickup_booking_id uuid NULL REFERENCES public.bookings(id);

CREATE UNIQUE INDEX IF NOT EXISTS dumpster_rentals_pickup_booking_id_uniq
  ON public.dumpster_rentals (pickup_booking_id)
  WHERE pickup_booking_id IS NOT NULL;

-- =======================================================================
-- Verification
-- =======================================================================
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings' and column_name = 'source_rental_booking_id';
-- -- expect: uuid, YES (nullable)
--
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'dumpster_rentals' and column_name = 'pickup_booking_id';
-- -- expect: uuid, YES (nullable)
--
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and tablename = 'bookings' and indexname = 'bookings_source_rental_booking_id_uniq';
-- -- expect indexdef to show "WHERE (source_rental_booking_id IS NOT NULL)"
--
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and tablename = 'dumpster_rentals' and indexname = 'dumpster_rentals_pickup_booking_id_uniq';
-- -- expect indexdef to show "WHERE (pickup_booking_id IS NOT NULL)"
--
-- select has_column_privilege('service_role', 'public.bookings', 'source_rental_booking_id', 'INSERT'); -- expect true, with no new grant run
-- select has_column_privilege('service_role', 'public.dumpster_rentals', 'pickup_booking_id', 'UPDATE'); -- expect true, with no new grant run

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- DROP INDEX IF EXISTS public.dumpster_rentals_pickup_booking_id_uniq;
-- ALTER TABLE public.dumpster_rentals DROP COLUMN IF EXISTS pickup_booking_id;
-- DROP INDEX IF EXISTS public.bookings_source_rental_booking_id_uniq;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS source_rental_booking_id;
