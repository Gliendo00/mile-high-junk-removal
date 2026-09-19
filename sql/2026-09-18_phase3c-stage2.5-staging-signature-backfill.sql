-- Phase 3C Stage 2.5 — STAGING-ONLY catch-up: add signature_name to an
-- ALREADY-LIVE staging rental_payments table.
--
-- NOT FOR PRODUCTION. Production has not received
-- sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql at all yet —
-- when it does, rental_payments is created there with signature_name
-- text NOT NULL already built in (see that file), so this catch-up file
-- has nothing to do on Production and should never be run there.
--
-- Why this file exists: staging is NOT a clean/unmigrated environment.
-- The Stripe migration (sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-
-- payments.sql) has already been run there, and one real end-to-end $349
-- Stripe Test Mode dumpster booking has already been completed against it
-- — BEFORE the typed-electronic-signature feature (and this column) was
-- added to that migration file. That existing row has no signature_name
-- value, so a plain
--   ALTER TABLE rental_payments ADD COLUMN signature_name text NOT NULL;
-- would fail outright: Postgres has no default to fill the existing row
-- with, and NOT NULL rejects it immediately.
--
-- This is a plan only. Nothing in this file has been executed. Run it
-- manually against the STAGING Supabase project only, statement by
-- statement, the same way every prior stage's migration in this project
-- has been run (see sql/2026-09-16_phase3b-step4a1-customer-identity-
-- columns.sql for the established convention). Never run this against
-- Production.
--
-- Approach chosen, and why: add the column nullable, backfill ONLY the
-- existing NULL row(s) with an explicit, clearly-non-name sentinel value
-- (never a fabricated legal name — that would misrepresent a real
-- electronic signature as having been collected when it wasn't), then
-- lock the column to NOT NULL. This lands staging on the exact same final
-- schema shape a fresh Production install gets (signature_name text NOT
-- NULL), while leaving an honest, auditable trail that this one row
-- predates the requirement — never silently inventing consent that was
-- never given. The alternative (leaving the column nullable permanently)
-- was rejected because it would let staging's schema drift from the
-- Production-bound CREATE TABLE definition, undermining staging's whole
-- purpose as a rehearsal of the real install.
--
-- Every statement below is safe to re-run: the backfill only ever touches
-- rows where signature_name IS NULL, and ADD COLUMN/SET NOT NULL are
-- no-ops (or clean errors) if already applied.

-- ---------------------------------------------------------------------
-- 0. PREFLIGHT — read-only. Run first to see exactly which row(s) this
--    will touch before changing anything. Expect exactly the one known
--    pre-signature test booking today; confirm there isn't more than
--    expected before proceeding.
-- ---------------------------------------------------------------------
-- select id, booking_id, payment_status, amount_charged, created_at
-- from rental_payments
-- where signature_name is null
-- order by created_at;

-- ---------------------------------------------------------------------
-- 1. Add the column, nullable for now — safe against any existing rows,
--    matches the nullable-first pattern this project already uses (see
--    sql/2026-09-16_..._customer-identity-columns.sql, step 1).
-- ---------------------------------------------------------------------
ALTER TABLE rental_payments
  ADD COLUMN IF NOT EXISTS signature_name text;

-- ---------------------------------------------------------------------
-- 2. Backfill ONLY rows left NULL by step 1 — i.e. only bookings taken
--    before this column/feature existed. A sentinel string, not a real
--    name: bracketed and sentence-shaped so it can never be mistaken for
--    an actual typed legal name in an admin view, export, or later query.
--    Idempotent: re-running this after it has already applied finds zero
--    matching rows and changes nothing.
-- ---------------------------------------------------------------------
UPDATE rental_payments
SET signature_name = '[no signature collected - booked before the Stage 2.5 electronic-signature requirement was added]'
WHERE signature_name IS NULL;

-- ---------------------------------------------------------------------
-- 3. Lock it down to NOT NULL — now safe, since step 2 guarantees zero
--    remaining NULLs. Matches signature_name's definition in the main
--    migration file exactly, so staging and a fresh Production install
--    end up with an identical rental_payments schema.
-- ---------------------------------------------------------------------
ALTER TABLE rental_payments
  ALTER COLUMN signature_name SET NOT NULL;

-- ---------------------------------------------------------------------
-- Verification (re-run any of these any time to re-confirm current state)
-- ---------------------------------------------------------------------
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'rental_payments'
--   and column_name = 'signature_name';
--
-- select count(*) as rows_missing_signature from rental_payments
--   where signature_name is null;  -- expect 0
--
-- select id, signature_name from rental_payments
--   where signature_name like '[no signature collected%'
--   order by created_at;  -- confirms exactly the pre-existing row(s), clearly flagged, nothing else

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file)
-- ---------------------------------------------------------------------
-- ALTER TABLE rental_payments ALTER COLUMN signature_name DROP NOT NULL;
-- ALTER TABLE rental_payments DROP COLUMN IF EXISTS signature_name;
