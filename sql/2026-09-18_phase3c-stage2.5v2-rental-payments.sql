-- Phase 3C Stage 2.5-v2 — Dumpster Rental Real Booking + Braintree Payments
-- To be run manually in the Supabase SQL editor. This project has no
-- migration runner (see sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql
-- for the established convention this file follows).
--
-- Full design writeup: docs/phase-3/stage2.5-rental-payments-v2-proposal.md
--
-- Adds, and nothing else:
--   1. A partial UNIQUE index enforcing "one delivery per (date, time
--      window)" for booked dumpster rentals — the entire server-side
--      availability guarantee for the new online payment flow (§4 of the
--      proposal doc). No fleet/inventory cap is enforced (the owner
--      confirmed there is no fixed dumpster count — delivery capacity is
--      the only real constraint).
--   2. rental_payments — 1:1 with bookings (mirrors dumpster_rentals'
--      existing booking_id-UNIQUE pattern exactly), the initial-charge +
--      Braintree vault reference record.
--   3. rental_additional_charges — many per booking, the propose → approve
--      → process workflow for admin-approved overage/extra-day charges.
--      A row here moving to 'proposed' NEVER calls Braintree — only the
--      admin-approval code path (api/admin/booking.js) does that, and only
--      after requireAdmin() + an explicit approve action.
--
-- Nothing here touches an existing column, table, or row. Both new tables'
-- foreign keys cascade from bookings.id exactly like dumpster_rentals and
-- booking_photos already do — confirmed directly against production
-- Supabase in docs/phase-3/database-schema-updates.md — so deleting a
-- booking cleanly removes its payment/charge history with it, consistent
-- with every other per-booking side table in this schema.
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.
--
-- ---------------------------------------------------------------------
-- IMPORTANT — run statement 1 (CREATE UNIQUE INDEX CONCURRENTLY) on its
-- own, not batched with anything else. CONCURRENTLY cannot run inside a
-- transaction block, and a multi-statement paste into the Supabase SQL
-- editor runs as one implicit transaction. Statements 2–4 (the two CREATE
-- TABLEs and the one regular index) are safe to run together afterward.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Availability: one delivery per (date, time window). Run alone.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_dumpster_delivery_slot
  ON bookings (appointment_date, time_window)
  WHERE service_type = 'dumpster_rental' AND status = 'booked';

-- ---------------------------------------------------------------------
-- 2. rental_payments — the initial charge + Braintree vault reference.
--    idempotency_key is checked by api/book.js BEFORE any Braintree call
--    is made, so a retried/duplicated submit can never double-charge.
--    braintree_payment_method_token is the ONLY payment-method artifact
--    ever stored — never a card number, never a CVV.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rental_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  payment_status text NOT NULL DEFAULT 'processing'
    CHECK (payment_status IN ('processing', 'paid', 'failed', 'voided', 'refunded')),
  amount_charged numeric(10,2),
  braintree_transaction_id text,
  braintree_customer_id text,
  braintree_payment_method_token text,
  payment_method_summary text,
  -- Informational only, set by api/braintree-webhook.js on a
  -- dispute_opened/dispute_lost/dispute_won/dispute_accepted event for the
  -- matching transaction. No automated action is ever taken from this value
  -- — it exists purely so the admin sees a dispute exists without logging
  -- into the Braintree dashboard separately.
  dispute_status text,
  agreement_version text NOT NULL,
  agreement_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- booking_id and idempotency_key are each already UNIQUE above, which
-- creates its own index automatically — no separate index needed for
-- either.

-- ---------------------------------------------------------------------
-- 3. rental_additional_charges — the admin propose/approve/process
--    workflow. rate is snapshotted at proposal time (never re-derived from
--    a possibly-since-changed rate config later) so an approved charge's
--    math stays auditable even if pricing changes in the future.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rental_additional_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  charge_type text NOT NULL CHECK (charge_type IN ('overweight_tonnage', 'additional_days', 'other')),
  quantity numeric(10,2),
  rate numeric(10,2),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  description text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'processing', 'paid', 'failed', 'voided')),
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  braintree_transaction_id text,
  failure_reason text,
  dispute_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. Lookup index — booking_id here is a plain (non-unique) FK, so unlike
--    the two UNIQUE columns above, Postgres does not create this one
--    automatically. Needed for "list this booking's charges" (the Booking
--    Detail admin panel).
-- ---------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rental_additional_charges_booking_id
  ON rental_additional_charges (booking_id);

-- ---------------------------------------------------------------------
-- Verification (re-run any of these any time to re-confirm current state)
-- ---------------------------------------------------------------------
-- select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'bookings'
--   and indexname = 'idx_bookings_dumpster_delivery_slot';
--
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name in ('rental_payments', 'rental_additional_charges')
--   order by table_name, ordinal_position;
--
-- select conname, contype from pg_constraint
--   where conrelid = 'rental_payments'::regclass or conrelid = 'rental_additional_charges'::regclass;
--
-- -- Confirm the delivery-slot uniqueness actually rejects a collision:
-- -- (run in a throwaway transaction, then ROLLBACK — never commit test data)
-- -- begin;
-- --   insert into bookings (customer_id, service_type, appointment_date, time_window, status, description)
-- --     values ('<any existing customer id>', 'dumpster_rental', '2026-12-01', 'w_0800_1000', 'booked', 'test 1');
-- --   insert into bookings (customer_id, service_type, appointment_date, time_window, status, description)
-- --     values ('<any existing customer id>', 'dumpster_rental', '2026-12-01', 'w_0800_1000', 'booked', 'test 2');
-- --   -- expect: second insert fails with "duplicate key value violates unique constraint
-- --   -- idx_bookings_dumpster_delivery_slot"
-- -- rollback;

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file)
-- ---------------------------------------------------------------------
-- DROP INDEX CONCURRENTLY IF EXISTS idx_rental_additional_charges_booking_id;
-- DROP TABLE IF EXISTS rental_additional_charges;
-- DROP TABLE IF EXISTS rental_payments;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_bookings_dumpster_delivery_slot;
