-- Phase 3C Stage 2.5-v2 — Dumpster Rental Real Booking + Stripe Payments
-- To be run manually in the Supabase SQL editor. This project has no
-- migration runner (see sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql
-- for the established convention this file follows).
--
-- Full design writeup: docs/phase-3/stage2.5-stripe-rental-payments-migration.md
--
-- SUPERSEDES sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql (the
-- original Braintree-schema migration). That file was NEVER run against
-- Production or Staging — Braintree was abandoned before any rollout — so
-- this is a clean Stripe schema from the start, not an ALTER of a
-- Braintree schema. Do not run both files; run this one only.
--
-- Adds, and nothing else:
--   1. A partial UNIQUE index enforcing "one delivery per (date, time
--      window)" for booked dumpster rentals — the entire server-side
--      availability guarantee for the online payment flow. Processor-
--      agnostic — identical to the original Braintree-era design. No
--      fleet/inventory cap is enforced (the owner confirmed there is no
--      fixed dumpster count — delivery capacity is the only real
--      constraint).
--   2. rental_payments — 1:1 with bookings (mirrors dumpster_rentals'
--      existing booking_id-UNIQUE pattern exactly), the initial-charge +
--      Stripe Customer/PaymentMethod reference record, plus the renter's
--      typed electronic signature (signature_name) captured alongside the
--      agreement acceptance fields.
--   3. rental_additional_charges — many per booking, the propose -> approve
--      -> process workflow for admin-approved overage/extra-day charges.
--      A row here moving to 'proposed' NEVER calls Stripe — only the
--      admin-approval code path (api/admin/booking.js) does that, and only
--      after requireAdmin() + an explicit approve action.
--
-- Nothing here touches an existing column, table, or row. Both new tables'
-- foreign keys cascade from bookings.id exactly like dumpster_rentals and
-- booking_photos already do, so deleting a booking cleanly removes its
-- payment/charge history with it, consistent with every other per-booking
-- side table in this schema.
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.
--
-- ---------------------------------------------------------------------
-- IMPORTANT — run statement 1 (CREATE UNIQUE INDEX CONCURRENTLY) on its
-- own, not batched with anything else. CONCURRENTLY cannot run inside a
-- transaction block, and a multi-statement paste into the Supabase SQL
-- editor runs as one implicit transaction. Statements 2-4 (the two CREATE
-- TABLEs and the one regular index) are safe to run together afterward.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 0. PREFLIGHT — run this FIRST, by itself, before statement 1. Read-only:
--    does not modify, cancel, merge, or touch any existing row. Finds any
--    existing 'booked' dumpster_rental rows that already share the same
--    (appointment_date, time_window) — these would make statement 1's
--    CREATE UNIQUE INDEX fail outright. An empty result means the index
--    will build cleanly; a non-empty result means those specific
--    booking_ids need a manual decision (reschedule one, mark one
--    cancelled/lost, etc. — a business call, not something this script
--    makes for you) before statement 1 can succeed.
-- ---------------------------------------------------------------------
-- SELECT appointment_date, time_window, COUNT(*) AS conflicting_count, array_agg(id) AS booking_ids
-- FROM bookings
-- WHERE service_type = 'dumpster_rental' AND status = 'booked'
-- GROUP BY appointment_date, time_window
-- HAVING COUNT(*) > 1
-- ORDER BY appointment_date, time_window;

-- ---------------------------------------------------------------------
-- 1. Availability: one delivery per (date, time window). Run alone.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_dumpster_delivery_slot
  ON bookings (appointment_date, time_window)
  WHERE service_type = 'dumpster_rental' AND status = 'booked';

-- ---------------------------------------------------------------------
-- 2. rental_payments — the initial charge + Stripe Customer/PaymentMethod
--    reference. idempotency_key is checked by api/book.js BEFORE any
--    PaymentIntent capture is attempted, so a retried/duplicated submit
--    can never double-charge. stripe_payment_method_id is the ONLY
--    payment-method artifact ever stored — never a card number, never a
--    CVV; Stripe itself holds the card, we hold only its opaque id.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rental_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately NULLABLE (still UNIQUE — Postgres permits multiple NULLs
  -- under a UNIQUE constraint) rather than NOT NULL. api/book.js inserts
  -- this row FIRST, before any booking exists, specifically to claim
  -- idempotency_key's uniqueness atomically before the delivery-slot
  -- uniqueness check below is ever touched — this is what lets a
  -- same-idempotency-key concurrent duplicate be caught here, safely,
  -- without risking cancellation of a sibling request's still-needed
  -- shared Stripe PaymentIntent authorization. booking_id is linked via an
  -- UPDATE once the booking is actually inserted.
  booking_id uuid UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  -- 'processing': a PaymentIntent has been authorized (capture_method:
  --   manual -> status requires_capture on Stripe's side) and the slot has
  --   been claimed by the bookings insert, but capture has not yet been
  --   attempted or confirmed in this row.
  -- 'paid': Stripe's capture call returned success=true synchronously, and
  --   this row's confirmation write succeeded.
  -- 'failed': a definitive decline — either at authorization (Stripe.js's
  --   own confirmPayment reported an error) or at capture time (a
  --   StripeCardError). No money moved; safe to show a customer-facing
  --   decline reason and let them try again with a fresh attempt.
  -- 'voided': a booking that had a valid, uncaptured authorization but was
  --   never captured (e.g. the delivery slot was lost to a concurrent
  --   booking and the PaymentIntent was cancelled to release the hold).
  -- 'refunded': set by admin/reconciliation tooling outside this stage's
  --   scope (no refund code path is built here) — reserved for future use.
  -- 'error_pending_review': the Stripe capture call itself
  --   threw/timed out with NO definitive response — outcome unknown, may
  --   have actually captured. Never auto-resolved and never auto-retried;
  --   api/book.js preserves this row and every row around it (never rolls
  --   back) specifically so an admin can check the Stripe Dashboard for a
  --   matching PaymentIntent before anyone takes further action.
  -- 'paid_reconciliation_required': Stripe DEFINITELY returned success
  --   (we have a real stripe_payment_intent_id) but writing that
  --   confirmation to this row failed even after retries — a
  --   local-persistence gap, not an unknown outcome. api/book.js attempts
  --   this row's full update up to 3 times with short backoff first; only
  --   if every attempt fails does the row end up here, via a second,
  --   minimal fallback write carrying just this status and the
  --   PaymentIntent id. api/stripe-webhook.js's payment_intent.succeeded
  --   handler is also able to self-heal a row stuck here back to 'paid'
  --   once the asynchronous webhook event arrives — unlike Braintree's
  --   settlement webhooks (ACH/SEPA-only, dead code for card/Venmo),
  --   Stripe's payment_intent.succeeded genuinely fires for every
  --   successful card/Venmo/wallet capture, so it doubles as a real
  --   reconciliation backstop here, not just documentation.
  payment_status text NOT NULL DEFAULT 'processing'
    CHECK (payment_status IN ('processing', 'paid', 'failed', 'voided', 'refunded', 'error_pending_review', 'paid_reconciliation_required')),
  amount_charged numeric(10,2),
  -- Rate-schedule snapshot, frozen at the moment THIS booking's PaymentIntent
  -- was created — never re-derived from api/_lib/rental-pricing.js's
  -- current constants later. A future pricing change must never
  -- retroactively alter what an already-booked rental's overage charges are
  -- computed from; see api/admin/booking.js's handleProposeCharge(), which
  -- reads these columns in preference to the current global rate.
  base_rate numeric(10,2),
  included_days integer,
  included_tons numeric(10,2),
  overage_ton_rate numeric(10,2),
  overage_day_rate numeric(10,2),
  stripe_payment_intent_id text,
  stripe_customer_id text,
  -- The vaulted PaymentMethod id (e.g. "pm_..."), saved via
  -- setup_future_usage: 'off_session' on the initial PaymentIntent. Used
  -- for later admin-approved off-session charges — Stripe's server never
  -- needs the card again, and neither does this database.
  stripe_payment_method_id text,
  payment_method_summary text,
  -- Set on a clean decline (payment_status: 'failed') or an ambiguous
  -- Stripe-call failure (payment_status: 'error_pending_review') — a
  -- human-readable reason for admin review. NULL for 'processing'/'paid'.
  failure_reason text,
  -- Informational only, set by api/stripe-webhook.js on a
  -- charge.dispute.created/closed/funds_withdrawn/funds_reinstated event
  -- for the matching PaymentIntent. No automated action is ever taken from
  -- this value — it exists purely so the admin sees a dispute exists
  -- without logging into the Stripe Dashboard separately. Stores Stripe's
  -- own dispute.status value verbatim (e.g. "needs_response", "won",
  -- "lost", "warning_closed") rather than a remapped enum, since Stripe's
  -- own dispute lifecycle has more states than Braintree's did and
  -- remapping them would lose information for no benefit.
  dispute_status text,
  agreement_version text NOT NULL,
  agreement_accepted_at timestamptz NOT NULL,
  -- Typed electronic signature (the renter's full legal name, as typed)
  -- captured at the same moment agreement_version/agreement_accepted_at
  -- are — both are written in the one api/book.js insert that only runs
  -- once the customer has clicked "Pay & Book Now" with both the
  -- agreement checkbox checked AND this field non-empty (validateBooking()
  -- enforces both server-side, not just in the browser). NOT NULL for the
  -- same reason agreement_version/agreement_accepted_at are: every row in
  -- this table is created at that single finalize step, never earlier.
  signature_name text NOT NULL,
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
  -- numeric(10,4), not (10,2) — a 2026-09-18-v2 pricing-update correction.
  -- overweight_tonnage's quantity is overweightLbs/2000 (see
  -- api/_lib/rental-pricing.js's overweightCharge()); since 2000 = 2^4*5^3,
  -- that division always terminates in exactly 4 decimal places for any
  -- integer overweightLbs, never more. At (10,2), a small overage (e.g.
  -- 1 lb -> 0.0005 tons) rounded down to a misleading "0.00" next to a
  -- real, nonzero dollar amount -- the money was always correct (amount is
  -- computed directly from raw pounds, never from this column), but the
  -- stored record read as internally inconsistent. additional_days' own
  -- quantity (a plain day count, unaffected by any of this) still gets
  -- round2'd in code; a wider column accepts that unchanged, since extra
  -- available decimal places never alter what an already-2-decimal value
  -- means. See docs/phase-3/stage2.5-stripe-rental-payments-migration.md
  -- for the full write-up, and sql/2026-09-18_phase3c-stage2.5-quantity-precision.sql
  -- for staging's own catch-up (this table already exists there at the
  -- old (10,2) precision).
  quantity numeric(10,4),
  rate numeric(10,2),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  description text,
  -- 'error_pending_review': the Stripe call for this approved charge
  --   failed/timed out with no definitive response. Deliberately NOT
  --   reachable again from api/admin/booking.js's approve action (only
  --   'proposed' and 'failed' are retryable) — an ambiguous outcome
  --   requires a human to check the Stripe Dashboard directly, never an
  --   automatic retry that could double-charge.
  -- 'paid_reconciliation_required': same distinction as rental_payments'
  --   own value — Stripe definitely succeeded (a real
  --   stripe_payment_intent_id exists) but the final "mark paid" write
  --   failed even after retries. Also excluded from the retry-eligible
  --   approve set for the same double-charge-safety reason as
  --   'error_pending_review'.
  -- 'requires_customer_action' (Stripe-specific — no Braintree equivalent
  --   existed): an off-session confirmation attempt came back with Stripe's
  --   authentication_required error — the card issuer requires the
  --   customer to complete Strong Customer Authentication before this
  --   charge can succeed, which cannot happen automatically off-session.
  --   Deliberately excluded from the normal Approve-retry set (retrying
  --   blindly would just re-attempt the same off-session confirmation and
  --   likely fail the same way, or in the worst case create ambiguity
  --   about which attempt the customer actually authenticated). Recovery
  --   is the dedicated, non-charging `action: "check-status"` admin action
  --   (api/admin/booking.js) — a read-only re-fetch of the PaymentIntent's
  --   current status, safe to call any number of times, which advances the
  --   charge to 'paid' or 'failed' once the customer has (or has not)
  --   completed authentication out-of-band (see
  --   docs/phase-3/stage2.5-stripe-rental-payments-migration.md for the
  --   full recovery-path writeup and the Dashboard setting that emails the
  --   customer an authentication link).
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'processing', 'paid', 'failed', 'voided', 'error_pending_review', 'paid_reconciliation_required', 'requires_customer_action')),
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  stripe_payment_intent_id text,
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
