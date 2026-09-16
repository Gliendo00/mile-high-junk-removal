-- Phase 3B Step 4a.1 — customer identity normalization columns
-- Executed and verified: 2026-09-16, against production commit
-- 74093e185792bff4acd743e7b550eb669028ba2a
--
-- Documents the exact schema operations that were run directly in the
-- Supabase SQL editor for Step 4a.1 of the repeat-client-matching
-- architecture (see project conversation history — no separate design
-- doc exists yet). This is a plain reference record of what was done,
-- not a CLI-managed migration — there is no migration runner in this
-- project yet.
--
-- Scope: adds two NULLABLE derived columns to `customers` plus two
-- non-unique indexes. Nothing else in the schema was touched.
--
-- phone_normalized REMAINS NULLABLE as of this file. It is deliberately
-- NOT NOT NULL yet — that constraint is only safe to add after Step 4a.2
-- (the /api/book application code that populates this column on every
-- new insert) has been deployed and verified against a real production
-- booking. Adding NOT NULL before that would break every new booking
-- the moment one arrived under the old code path. That later step will
-- be documented in its own dated file, not added here retroactively.
--
-- No UNIQUE constraint was introduced on either column, and none should
-- be — duplicate phone/email values across customer rows must remain
-- possible. A false automatic match is treated as worse than a
-- duplicate customer row; see the architecture discussion this file
-- accompanies for the full reasoning.
--
-- Contains no literal customer data. The backfill below derives every
-- value from the existing phone/email columns in place — it never
-- embeds an actual phone number or email address.

-- ---------------------------------------------------------------------
-- 1. Add columns (nullable) — executed, verified: both present, type
--    text, is_nullable = YES.
-- ---------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN phone_normalized text,
  ADD COLUMN email_normalized text;

-- ---------------------------------------------------------------------
-- 2. Backfill existing rows — executed, verified: 0 rows left with a
--    NULL phone_normalized; normalized values hand-checked against the
--    one real customer row's raw phone/email.
--    phone_normalized: digits only; if 11 digits with a leading "1",
--    the leading "1" is stripped (assumes US numbers, matching this
--    project's single-market service area).
--    email_normalized: lowercased and trimmed.
-- ---------------------------------------------------------------------
UPDATE customers
SET phone_normalized = CASE
  WHEN length(regexp_replace(phone, '\D', '', 'g')) = 11
       AND left(regexp_replace(phone, '\D', '', 'g'), 1) = '1'
    THEN substring(regexp_replace(phone, '\D', '', 'g') from 2)
  ELSE regexp_replace(phone, '\D', '', 'g')
END
WHERE phone_normalized IS NULL;

UPDATE customers
SET email_normalized = lower(trim(email))
WHERE email IS NOT NULL AND email_normalized IS NULL;

-- ---------------------------------------------------------------------
-- 3. Indexes (non-unique — duplicates must remain possible) — executed,
--    verified: both indexes present with indisvalid = true. Each
--    CREATE INDEX CONCURRENTLY statement was run on its own, never
--    batched with another statement — it cannot execute inside a
--    transaction block, and multi-statement submissions run as one
--    implicit transaction.
-- ---------------------------------------------------------------------
CREATE INDEX CONCURRENTLY idx_customers_phone_email_norm
  ON customers (phone_normalized, email_normalized);

CREATE INDEX CONCURRENTLY idx_customers_email_norm
  ON customers (email_normalized);

-- ---------------------------------------------------------------------
-- Verification used at each step (re-run any of these any time to
-- re-confirm current state)
-- ---------------------------------------------------------------------
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema='public' and table_name='customers'
--   and column_name in ('phone_normalized','email_normalized');
--
-- select count(*) as rows_missing_phone_normalized from customers
--   where phone_normalized is null;  -- expect 0
--
-- select indexname, indexdef from pg_indexes
--   where schemaname='public' and tablename='customers' order by indexname;
--
-- select relname, indisvalid from pg_index
--   join pg_class on pg_class.oid = pg_index.indexrelid
--   where relname in ('idx_customers_phone_email_norm','idx_customers_email_norm');
--
-- select tc.constraint_name, tc.constraint_type, kcu.column_name
--   from information_schema.table_constraints tc
--   join information_schema.key_column_usage kcu
--     on tc.constraint_name = kcu.constraint_name
--    and tc.table_schema = kcu.table_schema
--   where tc.table_schema='public' and tc.table_name='customers'
--   order by tc.constraint_type, kcu.column_name;
--   -- expect only customers_pkey (PRIMARY KEY on id) — confirms no
--   -- UNIQUE constraint was introduced on either normalized column.

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file)
-- ---------------------------------------------------------------------
-- DROP INDEX CONCURRENTLY IF EXISTS idx_customers_email_norm;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_customers_phone_email_norm;
-- ALTER TABLE customers
--   DROP COLUMN IF EXISTS phone_normalized,
--   DROP COLUMN IF EXISTS email_normalized;

-- ---------------------------------------------------------------------
-- Deliberately NOT included in this file:
--   ALTER TABLE customers ALTER COLUMN phone_normalized SET NOT NULL;
-- This runs only after Step 4a.2 (application writes) is deployed and
-- verified against a real production booking. It will be documented in
-- its own dated file when that happens, not added here retroactively.
-- ---------------------------------------------------------------------
