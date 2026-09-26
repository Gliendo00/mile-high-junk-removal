-- Phase 3C Stage 5 — Job Archive/Restore, Review-Request Tracking, Admin
-- Dumpster-Rental Workflow, Client Edit + Archive/Restore.
-- To be run manually in the Supabase SQL editor. This project has no
-- migration runner (see sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql
-- for the established convention this file follows).
--
-- Full design writeup: this session's Batch 2 schema report (not yet a
-- committed doc file — see the four proposals worked through in chat: job
-- archive, review-request tracking, dumpster pickup-date derivation, client
-- edit/archive).
--
-- Adds, and nothing else:
--   1. bookings — 6 new nullable columns: archived_at/archived_reason/
--      archived_note/archived_by (job archive/restore), review_request_sent_at/
--      review_request_sent_by (review-request tracking). No existing column
--      touched.
--   2. booking_audit_log — new table, application-written (not a trigger —
--      see the "why not a trigger" note in §2 below), covering archive/
--      restore/review-request events only.
--   3. dumpster_rentals — 1 new column: pickup_date_is_manual, defaulting
--      false. No existing column touched. pickup_date itself already exists
--      (Phase 1) and is unchanged in shape.
--   4. customers — 6 new nullable columns: archived_at/archived_reason/
--      archived_note/archived_by (client archive/restore), updated_at/
--      updated_by (client edit — this table has never had "last edited"
--      tracking before this stage). No existing column touched.
--   5. customer_audit_log — new table, same shape as booking_audit_log,
--      covering archive/restore only (NOT a general edit-history log —
--      deliberately out of scope for this stage, see §4 below).
--
-- Nothing in this file touches job_payments, rental_payments,
-- rental_additional_charges, expenses, expense_audit_log, or booking_photos.
-- No archive/restore/edit code path added by this stage ever queries or
-- writes any of those tables either (see the application code for the
-- enforcement of that — this migration only documents the DB-level
-- guarantee that nothing here CAN touch them, since no FK or trigger below
-- references them).
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only. Confirms current
--    shape of bookings/customers/dumpster_rentals in whichever environment
--    this runs against, and (critically) confirms service_role's EXISTING
--    privilege level on bookings/customers/dumpster_rentals before this
--    file assumes it below.
-- =======================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name in ('bookings', 'customers', 'dumpster_rentals')
-- order by table_name, ordinal_position;
--
-- -- This migration assumes service_role already holds a broad table-level
-- -- UPDATE on bookings/customers/dumpster_rentals (proven by already-live
-- -- features: tip_amount edits, status changes, client creation, the
-- -- actual_weight_lbs PATCH on dumpster_rentals all already work in
-- -- production) — NOT the narrow column-scoped grant pattern
-- -- job_payments/expenses/expense_audit_log deliberately use (see
-- -- sql/2026-09-19_phase3c-stage3-service-role-grants.sql's header for why
-- -- that pattern exists specifically for financial-ledger protection).
-- -- If the query below returns a table-level UPDATE row for all three,
-- -- this assumption holds and section 1/3/4 below need no new grant
-- -- statement. If it does NOT (e.g. these were also set up with narrow
-- -- column grants at some point), STOP and add the equivalent narrow
-- -- GRANT UPDATE (<explicit column list including the new ones>) statements
-- -- before relying on this file alone.
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('bookings', 'customers', 'dumpster_rentals')
--   and grantee = 'service_role'
-- order by table_name, privilege_type;

-- =======================================================================
-- 1. bookings — extend in place. Job archive/restore + review-request
--    tracking. All six columns nullable; NULL is the "not archived" /
--    "review request not sent" steady state for every existing row —
--    zero backfill required.
-- =======================================================================
ALTER TABLE public.bookings
  -- Job archive/restore (visibility flag only, no cascading effect on
  -- anything — exactly the pattern docs/phase-3/database-schema-updates.md
  -- already recommended for this, after confirming customers->bookings is
  -- ON DELETE CASCADE and a hard job-delete would be irreversible).
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  -- App-level allowlist (client_canceled, duplicate_booking, test_spam,
  -- no_show, entered_by_mistake, other), NOT a DB CHECK constraint — same
  -- treatment this codebase already gives bookings.status and expenses.category,
  -- both plain text + an application-side allowlist rather than a DB enum/
  -- CHECK, for consistency (see api/admin/booking-status.js's
  -- ALLOWED_STATUSES for the established shape this mirrors).
  ADD COLUMN IF NOT EXISTS archived_reason text NULL,
  -- Required by the application only when archived_reason = 'other'.
  ADD COLUMN IF NOT EXISTS archived_note text NULL,
  -- Admin email who archived/restored it (restore does not change this —
  -- it always reflects the most recent archive action; see booking_audit_log
  -- for who/when restored).
  ADD COLUMN IF NOT EXISTS archived_by text NULL,

  -- Review-request tracking (completed jobs only, enforced at the
  -- application layer — this column has no service_type/status-level
  -- constraint of its own, same reasoning as the rental_out status CHECK
  -- deliberately staying a plain allowlist rather than a cross-column rule).
  ADD COLUMN IF NOT EXISTS review_request_sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS review_request_sent_by text NULL;

CREATE INDEX IF NOT EXISTS bookings_archived_at_idx ON public.bookings (archived_at);

-- =======================================================================
-- 2. booking_audit_log — new table. Application-written, NOT a database
--    trigger (unlike expense_audit_log — see stage3-payments-expenses-proposal.md
--    §3.3 for why a trigger was chosen THERE): that choice was specifically
--    about financial data needing to survive even a hand-run SQL fix in the
--    Supabase editor. Archive/restore/review-request are administrative
--    state, not financial records, and the application already has exactly
--    one, single, narrow code path for each event type (mirroring how
--    api/admin/booking.js's resource=charges approve/void already writes
--    approved_by/approved_at directly in application code, no trigger) —
--    a trigger would add PL/pgSQL complexity with no correctness benefit
--    here.
--
-- FK design (the one genuinely new decision in this stage): booking_id is
-- nullable with ON DELETE SET NULL, NOT ON DELETE CASCADE and NOT the
-- default NO ACTION. Reasoning:
--   - NOT NO ACTION (expense_audit_log's choice): that works for expenses
--     ONLY because expenses have no hard-delete path at all, so the FK
--     existing to BLOCK a delete is exactly the point there. bookings
--     already has a real, existing hard-delete path today (the
--     customers -> bookings ON DELETE CASCADE, confirmed in
--     database-schema-updates.md) — a NO ACTION FK here would silently
--     make it impossible to delete a customer who has any audit history,
--     breaking existing behavior this stage did not intend to touch.
--   - NOT ON DELETE CASCADE: deleting a booking must not also erase the
--     fact that it was once archived/restored/review-requested — the
--     audit trail's whole purpose is to survive the record it documents.
--   - ON DELETE SET NULL, PLUS an immutable booking_id_snapshot (never
--     updated after INSERT) and a short human-readable
--     booking_summary_snapshot: this is what keeps an orphaned row (the
--     booking has since been hard-deleted via the customer cascade)
--     understandable on its own, without booking_id_snapshot being usable
--     to look anything up (the booking is gone) and without duplicating
--     the full bookings row.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.booking_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NULL REFERENCES public.bookings(id) ON DELETE SET NULL,
  booking_id_snapshot uuid NOT NULL,
  booking_summary_snapshot text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('archive', 'restore', 'review_request_sent', 'review_request_cleared')),
  reason text NULL,
  note text NULL,
  changed_by text NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_audit_log_booking_id_idx ON public.booking_audit_log (booking_id);

ALTER TABLE public.booking_audit_log ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 3. dumpster_rentals — extend in place. One new column: tracks whether
--    pickup_date (already exists, Phase 1 — unchanged in shape here) is
--    currently system-derived (delivery_date + 5 calendar days, recomputed
--    whenever delivery_date changes) or has been manually overridden by an
--    admin (frozen — later delivery_date edits never touch it again).
--    Defaulting false means every existing rental row is treated as
--    system-derived until an admin explicitly edits its pickup date —
--    the correct default for rows that predate this feature, since their
--    pickup_date was in fact whatever the customer entered on /book (not
--    literally "delivery + 5" in every historical case, but there is no
--    reliable way to distinguish that after the fact, and treating them as
--    derived just means a future delivery-date edit would recompute pickup
--    going forward, which is the safe, non-destructive default either way).
-- =======================================================================
ALTER TABLE public.dumpster_rentals
  ADD COLUMN IF NOT EXISTS pickup_date_is_manual boolean NOT NULL DEFAULT false;

-- =======================================================================
-- 4. customers — extend in place. Client edit (this table's first-ever
--    "last edited" tracking — confirmed no updated_at/updated_by existed
--    before this stage) + client archive/restore (identical shape to
--    bookings' own archive columns above, same reasoning).
-- =======================================================================
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  -- App-level allowlist: duplicate_client, test_spam, requested_removal,
  -- entered_by_mistake, other. Required note when 'other'.
  ADD COLUMN IF NOT EXISTS archived_reason text NULL,
  ADD COLUMN IF NOT EXISTS archived_note text NULL,
  ADD COLUMN IF NOT EXISTS archived_by text NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS updated_by text NULL;

CREATE INDEX IF NOT EXISTS customers_archived_at_idx ON public.customers (archived_at);

-- =======================================================================
-- 5. customer_audit_log — new table, identical shape/reasoning to
--    booking_audit_log above (§2), scoped to archive/restore ONLY —
--    deliberately NOT a general before/after field-change log for plain
--    client edits (locked decision for this stage: customers.updated_at/
--    updated_by is sufficient "last edited" tracking for a normal edit;
--    expanding this table into full per-field edit history is explicitly
--    out of scope here, matching the same "don't build machinery beyond
--    what's asked" restraint expense_audit_log's trigger-per-field design
--    was a deliberate EXCEPTION to, for financial-data reasons that don't
--    apply to a client's contact info).
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.customer_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_id_snapshot uuid NOT NULL,
  customer_summary_snapshot text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('archive', 'restore')),
  reason text NULL,
  note text NULL,
  changed_by text NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_audit_log_customer_id_idx ON public.customer_audit_log (customer_id);

ALTER TABLE public.customer_audit_log ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 6. service_role grants for the two brand-new tables. A newly created
--    table has NO privileges granted to service_role by default in this
--    project (confirmed directly, twice, in Stage 2.5 and Stage 3's own
--    rollouts — see sql/2026-09-19_phase3c-stage3-service-role-grants.sql's
--    header) — without this section, every archive/restore/review-request
--    write would fail outright the moment this ships, not just be
--    under-protected. SELECT + INSERT only, matching expense_audit_log's
--    exact treatment: an audit log is written once per event and never
--    modified or removed by application code, so there is nothing to
--    UPDATE or DELETE here, ever.
--
--    bookings/customers/dumpster_rentals themselves need no new grant
--    statement here — see §0's preflight query and comment: this migration
--    assumes (and asks the owner to confirm before relying on) the
--    existing broad table-level UPDATE those tables already have, proven
--    by already-live features writing to other columns on them today.
-- =======================================================================
REVOKE ALL ON public.booking_audit_log FROM service_role;
GRANT SELECT, INSERT ON public.booking_audit_log TO service_role;

REVOKE ALL ON public.customer_audit_log FROM service_role;
GRANT SELECT, INSERT ON public.customer_audit_log TO service_role;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name in ('bookings', 'booking_audit_log', 'dumpster_rentals', 'customers', 'customer_audit_log')
--   order by table_name, ordinal_position;
--
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid in ('public.booking_audit_log'::regclass, 'public.customer_audit_log'::regclass);
--
-- select has_table_privilege('service_role', 'public.booking_audit_log', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.booking_audit_log', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.booking_audit_log', 'UPDATE');  -- expect false
-- select has_table_privilege('service_role', 'public.booking_audit_log', 'DELETE');  -- expect false
-- select has_table_privilege('service_role', 'public.customer_audit_log', 'SELECT'); -- expect true
-- select has_table_privilege('service_role', 'public.customer_audit_log', 'INSERT'); -- expect true
-- select has_table_privilege('service_role', 'public.customer_audit_log', 'UPDATE'); -- expect false
-- select has_table_privilege('service_role', 'public.customer_audit_log', 'DELETE'); -- expect false
--
-- -- Exercise the ON DELETE SET NULL behavior end-to-end (run in a
-- -- throwaway transaction, then ROLLBACK — never commit test data):
-- -- begin;
-- --   insert into bookings (customer_id, service_type, appointment_date, description)
-- --     values ((select id from customers limit 1), 'junk_removal', current_date, 'test') returning id;
-- --   -- (use the returned id below)
-- --   insert into booking_audit_log (booking_id, booking_id_snapshot, booking_summary_snapshot, event_type, reason, changed_by)
-- --     values ('<id>', '<id>', 'Junk Removal -- Test -- ' || current_date, 'archive', 'test_spam', 'test@example.com');
-- --   delete from bookings where id = '<id>';
-- --   select * from booking_audit_log where booking_id_snapshot = '<id>';
-- --   -- expect: the row still exists, booking_id is now NULL, booking_id_snapshot
-- --   -- and booking_summary_snapshot are unchanged (the delete did not cascade
-- --   -- to this table, and the row is still fully readable/understandable)
-- -- rollback;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON public.customer_audit_log FROM service_role;
-- REVOKE ALL ON public.booking_audit_log FROM service_role;
-- DROP TABLE IF EXISTS public.customer_audit_log;
-- ALTER TABLE public.customers
--   DROP COLUMN IF EXISTS archived_at,
--   DROP COLUMN IF EXISTS archived_reason,
--   DROP COLUMN IF EXISTS archived_note,
--   DROP COLUMN IF EXISTS archived_by,
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS updated_by;
-- DROP INDEX IF EXISTS customers_archived_at_idx;
-- ALTER TABLE public.dumpster_rentals DROP COLUMN IF EXISTS pickup_date_is_manual;
-- DROP TABLE IF EXISTS public.booking_audit_log;
-- ALTER TABLE public.bookings
--   DROP COLUMN IF EXISTS archived_at,
--   DROP COLUMN IF EXISTS archived_reason,
--   DROP COLUMN IF EXISTS archived_note,
--   DROP COLUMN IF EXISTS archived_by,
--   DROP COLUMN IF EXISTS review_request_sent_at,
--   DROP COLUMN IF EXISTS review_request_sent_by;
-- DROP INDEX IF EXISTS bookings_archived_at_idx;
