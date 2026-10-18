-- Phase 3 — public-form reliability fixes (Priority 3): homepage quote
-- form becomes a real CRM lead, /book/ junk_removal/light_demo gets
-- idempotency protection. To be run manually in the Supabase SQL editor,
-- same convention as every prior migration in this directory. NOT
-- executed by this session — drafted for Rocky's review. STOP AND ASK
-- before applying, per this change's own explicit instructions.
--
-- Two independent, additive changes. Neither touches existing data.
--
-- =======================================================================
-- WHY THESE CHANGES ARE NEEDED (not workarounds for a frontend-only bug)
-- =======================================================================
--
-- 1. leads.source widened to also allow 'website':
--    leads.source's CHECK constraint currently only allows
--    'screenshot_intake' | 'phone' | 'manual' (sql/2026-10-05_...sql).
--    api/contact.js (the homepage "Get a Quote" form + the standalone
--    /contact.html page, both POST /api/contact) previously created
--    NOTHING in the database — it only sent an email. This migration lets
--    it create a real `leads` row tagged source='website', the durable
--    CRM record the business owner can act on even if the notification
--    email is lost.
--
--    This is NOT the same thing sql/2026-10-05_...sql's header explicitly
--    excluded. That exclusion was about /book/'s own booking SUBMISSIONS
--    — those already have their own correct, singular representation as a
--    `bookings` row (status NULL), merged into the Leads workspace at
--    READ time only (api/admin/bookings.js's handleLeadsView(), which
--    tags that merged view source="website" purely for display — it never
--    writes that tag anywhere). That representation is completely
--    unchanged by this migration: /book/ still never writes to `leads`.
--    This migration is about a DIFFERENT kind of submission — the
--    homepage quote form — which had no database representation at all
--    before now, so there is nothing for a new `leads` row to duplicate
--    or conflict with. 'website' is reused (not a new, different source
--    string) specifically because the Leads UI already shows a "Website"
--    source badge for the read-time-tagged bookings case
--    (admin/leads-list.js's existing SOURCE_LABELS already has
--    `website: 'Website'`) — reusing the same word keeps "this came from
--    the public site" meaning one consistent thing everywhere in the
--    admin UI, regardless of which table actually backs a given card.
--
-- 2. bookings.idempotency_key (+ partial unique index):
--    /book/'s junk_removal and light_demo submissions currently have no
--    idempotency protection at all — a double-click, or a browser retry
--    after a network hang, creates a second, genuinely duplicate booking
--    (confirmed during the Priority 3 audit). dumpster_rental already
--    solved this exact problem for itself via rental_payments's own
--    idempotency_key column + UNIQUE constraint
--    (sql/2026-09-18_..._v2-stripe-rental-payments.sql) — but
--    junk_removal/light_demo bookings have no rental_payments row at all
--    (that table is Stripe/dumpster-specific), so there is no existing
--    column anywhere that could hold this key for them. This migration
--    gives `bookings` itself the same already-proven shape: a nullable
--    key column + a partial unique index, mirroring the exact pattern
--    already used for bookings.source_intake_id/source_estimate_id/
--    source_lead_id (sql/2026-10-07_...sql, sql/2026-10-12_...sql).
--
--    Nullable and additive: every existing booking row keeps
--    idempotency_key = NULL, and NULL is explicitly excluded from the
--    unique index (`WHERE idempotency_key IS NOT NULL`), so any number of
--    existing/older rows can coexist without conflict. dumpster_rental
--    bookings also get NULL here — their idempotency already lives on
--    rental_payments.idempotency_key, untouched by this migration; this
--    new column is never read or written by that flow.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================
-- -- Confirm the actual name of leads.source's CHECK constraint before
-- -- trying to drop it below — it should be the default auto-generated
-- -- name, but confirm rather than assume:
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.leads'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) like '%source%';
-- -- expect one row, conname likely "leads_source_check" — if it's a
-- -- different name, use that name in step 1 below instead.
--
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings'
--   and column_name = 'idempotency_key';
-- -- expect: zero rows (doesn't exist yet)
--
-- select indexname from pg_indexes
--   where schemaname = 'public' and tablename = 'bookings'
--   and indexname = 'bookings_idempotency_key_uniq';
-- -- expect: zero rows (doesn't exist yet)
--
-- -- Sanity check: confirm no existing booking rows already collide on a
-- -- non-null value in this column (impossible today since the column
-- -- doesn't exist yet, but this is the standard preflight shape used by
-- -- every other migration in this directory before a CREATE UNIQUE INDEX).
-- -- No query needed here — the column doesn't exist, so there is nothing
-- -- to collide. Listed for consistency with this directory's convention.

-- =======================================================================
-- 1. leads.source — widen the CHECK constraint
-- =======================================================================
ALTER TABLE public.leads DROP CONSTRAINT leads_source_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('screenshot_intake', 'phone', 'manual', 'website'));

-- =======================================================================
-- 2. bookings.idempotency_key
-- =======================================================================
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency_key_uniq
  ON public.bookings (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.leads'::regclass and contype = 'c'
--   and conname = 'leads_source_check';
-- -- expect definition to include 'website'
--
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings' and column_name = 'idempotency_key';
--
-- select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'bookings'
--   and indexname = 'bookings_idempotency_key_uniq';
-- -- expect indexdef to show "WHERE (idempotency_key IS NOT NULL)"
--
-- select has_column_privilege('service_role', 'public.leads', 'source', 'INSERT'); -- expect true, no new grant needed
-- select has_column_privilege('service_role', 'public.bookings', 'idempotency_key', 'INSERT'); -- expect true, no new grant needed (bookings has never used the REVOKE-ALL-then-GRANT-exact convention — table-wide grants already in place since Phase 1)

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- DROP INDEX CONCURRENTLY IF EXISTS bookings_idempotency_key_uniq;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS idempotency_key;
-- ALTER TABLE public.leads DROP CONSTRAINT leads_source_check;
-- ALTER TABLE public.leads ADD CONSTRAINT leads_source_check
--   CHECK (source IN ('screenshot_intake', 'phone', 'manual'));
