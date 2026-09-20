-- Phase 3C Stage 4 — widen bookings.status's CHECK constraint to allow
-- "rental_out".
--
-- Why: Stage 4 added a new dumpster-rental-only lifecycle status,
-- "rental_out" (a rental delivered and currently at the client's
-- property; lifecycle: booked -> rental_out -> completed). The
-- application-level allowlist (api/admin/booking-status.js's
-- ALLOWED_STATUSES, api/_lib/booking-format.js's STATUS_LABELS) was
-- updated for this in an earlier commit on this same branch, but a real
-- database-level CHECK constraint on bookings.status — bookings_status_check
-- — was then confirmed directly against the Staging database (owner-run,
-- 2026-09-19; this repo had no tracked record of it, since no CREATE TABLE
-- for bookings exists here — the table was created directly in the
-- Supabase SQL editor before this project's sql/ directory convention
-- started). That constraint does not yet allow "rental_out". Until this
-- migration is run, any attempt to write status = 'rental_out' is rejected
-- by Postgres with a constraint violation, regardless of what the
-- application layer allows — see api/admin/booking-status.js, which already
-- guards this and surfaces a clean error rather than a raw 500 for every
-- OTHER kind of rejection, but a DB-level CHECK violation here would still
-- surface as a generic 500 until this migration runs.
--
-- A CHECK constraint can't be widened in place — it has to be dropped and
-- recreated with the new value list. This migration drops ONLY
-- bookings_status_check and recreates it with the exact same six
-- previously-allowed values plus "rental_out" — nothing else about the
-- constraint, column, table, or any other constraint/trigger/index is
-- touched.
--
-- What this does NOT do: it does not restrict "rental_out" to
-- service_type = 'dumpster_rental' bookings. That restriction is
-- deliberately enforced at the application layer only
-- (api/admin/booking-status.js fetches the booking's existing service_type
-- and rejects the write with a 400 before it ever reaches the database if
-- the booking isn't a dumpster rental — see RENTAL_ONLY_STATUS/
-- RENTAL_SERVICE_TYPE in that file). This CHECK constraint remains a plain
-- status-value allowlist, the same shape it already was — it is
-- deliberately NOT widened into a cross-column business rule tying status
-- to service_type. Postgres can technically express a multi-column CHECK,
-- but adding one here would be a materially bigger, riskier change than
-- this small, additive migration is meant to be, and would duplicate a
-- rule the application already enforces with no other real write path to
-- protect against (the only code path that ever sets bookings.status to
-- 'rental_out' is that one guarded endpoint).
--
-- Additive only. No existing row's status is touched (every currently
-- allowed value keeps working exactly as before), no other column, table,
-- index, or trigger is affected. NULL statuses (this project's "new" — see
-- api/_lib/booking-format.js's normalizedStatus()) are unaffected either
-- way: a CHECK constraint only fails on a FALSE result, and comparing NULL
-- against any value list evaluates to NULL, not FALSE, so NULL rows
-- already satisfy this constraint both before and after this change.

-- =======================================================================
-- PREFLIGHT — run this FIRST, by itself. Read-only. Confirms the
-- constraint's current exact name/definition before the ALTER below
-- assumes it — same convention as
-- sql/2026-09-19_phase3c-job-payments-add-methods.sql's identical preflight.
-- =======================================================================
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.bookings'::regclass
--   and contype = 'c'
--   and pg_get_constraintdef(oid) ilike '%status%';

-- =======================================================================
-- MIGRATION
-- =======================================================================
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('new', 'contacted', 'quoted', 'booked', 'rental_out', 'completed', 'lost'));

-- =======================================================================
-- Verification (re-run any time to re-confirm current state)
-- =======================================================================
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.bookings'::regclass
--   and conname = 'bookings_status_check';
-- Expect: CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text,
--   'quoted'::text, 'booked'::text, 'rental_out'::text, 'completed'::text,
--   'lost'::text])))

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
-- ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
--   CHECK (status IN ('new', 'contacted', 'quoted', 'booked', 'completed', 'lost'));
-- Note: rolling back after any 'rental_out' row has already been written
-- would leave that row violating the narrowed constraint — the rollback
-- ALTER would then fail until that row is moved to a different status, by
-- Postgres's own design (a CHECK constraint is validated against existing
-- rows when added).
