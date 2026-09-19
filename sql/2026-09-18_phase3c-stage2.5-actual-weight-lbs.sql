-- Phase 3C Stage 2.5 — actual scale weight tracking for overweight billing.
--
-- Why: the 2026-09-18-v2 pricing update ($90/ton -> $125/ton) also makes
-- overweight billing genuinely prorated to actual scale weight, instead of
-- an admin manually typing a "tons over" quantity they computed themselves
-- (see docs/phase-3/stage2.5-stripe-rental-payments-migration.md for the
-- full pricing-change write-up). That requires somewhere to durably store
-- the real weight once it's known. This is also a deliberate data-
-- collection step: the owner wants 1-2 weeks of real actual_weight_lbs
-- data before reconsidering the $349 base rate.
--
-- Adds exactly ONE nullable column to the pre-existing dumpster_rentals
-- table. Nothing else in the schema is touched.
--
-- Nullable, no default, and never required at booking time — scale weight
-- is only known after the dumpster is emptied/weighed, well after
-- api/book.js creates this row. Recording it is independent of whether it
-- results in an overage charge: a rental that comes in at or under the
-- included 4,000 lbs can (and, during the data-collection window, should)
-- still have its actual weight saved — see api/admin/booking.js's
-- handleProposeCharge(), which persists actual_weight_lbs unconditionally
-- and only creates a rental_additional_charges row when the computed
-- overage amount is greater than zero (that table's own amount > 0 CHECK
-- constraint would otherwise reject a $0 charge outright).
--
-- integer, not numeric — actual_weight_lbs is a whole-pound scale reading,
-- never a fractional/rounded value. The CHECK constraint only rules out a
-- negative number; NULL (never weighed / not yet known) remains valid at
-- all times, including forever, for a booking nobody ever weighs.
--
-- Not run against Production or Staging by this session — run manually,
-- the same established convention every prior migration in this project
-- has followed.

ALTER TABLE dumpster_rentals
  ADD COLUMN IF NOT EXISTS actual_weight_lbs integer
    CHECK (actual_weight_lbs IS NULL OR actual_weight_lbs >= 0);

-- ---------------------------------------------------------------------
-- Verification (re-run any of these any time to re-confirm current state)
-- ---------------------------------------------------------------------
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'dumpster_rentals'
--   and column_name = 'actual_weight_lbs';
--
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'dumpster_rentals'::regclass and conname like '%actual_weight_lbs%';

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file)
-- ---------------------------------------------------------------------
-- ALTER TABLE dumpster_rentals DROP COLUMN IF EXISTS actual_weight_lbs;
