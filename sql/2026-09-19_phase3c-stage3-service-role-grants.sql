-- Phase 3C Stage 3 — service_role grants for job_payments/expenses/
-- expense_audit_log. Run AFTER sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql.
--
-- Same reasoning as sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql:
-- a table not created by the role whose ALTER DEFAULT PRIVILEGES covers
-- service_role does not automatically back-fill that role's privileges —
-- make the grant an explicit, reviewable, re-runnable step instead of an
-- assumption. Idempotent; safe to run more than once.
--
-- CORRECTED after a pre-push privilege audit (2026-09-19): the original
-- version of this file only ever added grants (GRANT SELECT/INSERT, then
-- GRANT UPDATE on specific columns) without first REVOKEing anything. That
-- is a real gap: PostgreSQL privileges are strictly ADDITIVE — a later,
-- narrower GRANT UPDATE (col1, col2) never revokes a pre-existing BROADER
-- table-level UPDATE that service_role might already hold from some other
-- source (a prior manual grant, a schema-wide "GRANT ALL ON ALL TABLES IN
-- SCHEMA public" someone ran at some point, etc.). Verified directly
-- against a real PostgreSQL engine (not just reasoned about): a table with
-- a pre-existing `GRANT UPDATE ON t TO service_role` still allows updating
-- a column that was never explicitly listed, even after running
-- `GRANT UPDATE (that_one_column) ON t TO service_role` on top of it —
-- has_column_privilege() confirms this. Only REVOKE can narrow an existing
-- grant.
--
-- This session has no credentials to query Production/Staging's actual
-- current grants directly, and project convention (and safety rules)
-- prohibit running SQL against them from here. Project-specific evidence
-- weighs against a pre-existing blanket grant existing at all: Stage 2.5's
-- own staging rollout (sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql,
-- and docs/phase-3/stage2.5-stripe-rental-payments-migration.md §5.3)
-- directly observed service_role missing basic SELECT/INSERT on brand-new
-- tables created via the SQL editor — which could not happen if this
-- project had a working schema-wide or default-privilege catch-all for
-- service_role. But rather than depend on that inference holding for
-- job_payments/expenses/expense_audit_log specifically, this file now
-- REVOKEs first and grants exactly the intended privileges second, so the
-- end state is deterministic regardless of whatever (if anything) already
-- existed — no assumption required. Confirmed via the same real-engine
-- test: REVOKE ALL then a narrow re-grant DOES correctly leave the
-- unlisted column un-updatable and DELETE disallowed, even starting from a
-- pre-existing broad grant.
--
-- Deliberately narrow FINAL grants, matching this file's design goal of
-- DB-enforced financial-record safety, not just application-code
-- discipline:
--   - job_payments: SELECT/INSERT (full row), but UPDATE only on the three
--     void-related columns — even a future application bug (or a stray
--     prior grant) cannot alter a payment's amount/method/type/booking
--     after it's written, only void it. No DELETE, ever (append-only
--     ledger).
--   - expenses: SELECT/INSERT, and UPDATE only on the editable/void
--     columns — id/created_at/created_by excluded, on top of never being
--     sent by application code. No DELETE, ever (soft-void only — see that
--     file's §2 comment).
--   - expense_audit_log: SELECT/INSERT only (INSERT is needed because the
--     audit trigger's own INSERT runs as service_role, the role that fired
--     the triggering statement). No UPDATE, no DELETE, ever — a fully
--     immutable audit trail, enforced at the database permission level, not
--     just by "the app never does this."

-- ---------------------------------------------------------------------
-- job_payments — REVOKE ALL first so the result is deterministic no
-- matter what (if anything) service_role already had on this table.
-- ---------------------------------------------------------------------
REVOKE ALL ON public.job_payments FROM service_role;
GRANT SELECT, INSERT ON public.job_payments TO service_role;
GRANT UPDATE (voided_at, voided_reason, updated_at) ON public.job_payments TO service_role;

-- ---------------------------------------------------------------------
-- expenses — same REVOKE-first pattern. This intentionally also re-states
-- (not just extends) the SELECT/INSERT already granted by
-- sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql, so this file is
-- a complete, self-contained statement of exactly what service_role can do
-- on this table as of this stage, not dependent on that earlier file's
-- grants still being intact/unmodified.
-- ---------------------------------------------------------------------
REVOKE ALL ON public.expenses FROM service_role;
GRANT SELECT, INSERT ON public.expenses TO service_role;
GRANT UPDATE (
  expense_date, category, amount, note, vendor, payment_method,
  booking_id, receipt_reference, voided_at, voided_reason, updated_at, updated_by
) ON public.expenses TO service_role;

-- ---------------------------------------------------------------------
-- expense_audit_log
-- ---------------------------------------------------------------------
REVOKE ALL ON public.expense_audit_log FROM service_role;
GRANT SELECT, INSERT ON public.expense_audit_log TO service_role;

-- ---------------------------------------------------------------------
-- Verification — run ALL of these after applying this file. The
-- has_*_privilege() queries are the AUTHORITATIVE check (exactly what
-- PostgreSQL itself consults to allow/deny a query) — prefer them over
-- eyeballing the raw grant-listing queries, which only show WHICH GRANT
-- statements exist, not the final composed/effective permission.
-- ---------------------------------------------------------------------

-- Raw grant listing (what statements exist):
-- select grantee, table_name, privilege_type, is_grantable
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('job_payments', 'expenses', 'expense_audit_log')
--   and grantee = 'service_role'
-- order by table_name, privilege_type;
-- -- expect: job_payments -> SELECT, INSERT only (no bare table-level UPDATE
-- -- or DELETE row); expenses -> SELECT, INSERT only (same); expense_audit_log
-- -- -> SELECT, INSERT only. A table-level UPDATE or DELETE row appearing
-- -- here for job_payments or expenses means something outside this file
-- -- granted it — investigate before relying on the column-scoped
-- -- protection below.
--
-- select table_name, column_name, privilege_type
-- from information_schema.role_column_grants
-- where table_schema = 'public'
--   and table_name in ('job_payments', 'expenses')
--   and grantee = 'service_role'
--   and privilege_type = 'UPDATE'
-- order by table_name, column_name;
-- -- expect: job_payments -> exactly voided_at, voided_reason, updated_at.
-- -- expenses -> exactly the 12 columns listed in the GRANT UPDATE above.

-- EFFECTIVE privilege checks (the decisive answer — run these and expect
-- exactly the boolean shown in each comment):
-- select has_column_privilege('service_role', 'public.job_payments', 'amount', 'UPDATE');           -- expect false
-- select has_column_privilege('service_role', 'public.job_payments', 'payment_method', 'UPDATE');    -- expect false
-- select has_column_privilege('service_role', 'public.job_payments', 'booking_id', 'UPDATE');        -- expect false
-- select has_column_privilege('service_role', 'public.job_payments', 'voided_at', 'UPDATE');         -- expect true
-- select has_column_privilege('service_role', 'public.job_payments', 'voided_reason', 'UPDATE');     -- expect true
-- select has_table_privilege('service_role', 'public.job_payments', 'DELETE');                       -- expect false
-- select has_column_privilege('service_role', 'public.expenses', 'id', 'UPDATE');                    -- expect false
-- select has_column_privilege('service_role', 'public.expenses', 'created_at', 'UPDATE');            -- expect false
-- select has_column_privilege('service_role', 'public.expenses', 'created_by', 'UPDATE');            -- expect false
-- select has_column_privilege('service_role', 'public.expenses', 'amount', 'UPDATE');                -- expect true
-- select has_table_privilege('service_role', 'public.expenses', 'DELETE');                           -- expect false
-- select has_table_privilege('service_role', 'public.expense_audit_log', 'INSERT');                  -- expect true
-- select has_table_privilege('service_role', 'public.expense_audit_log', 'UPDATE');                  -- expect false
-- select has_table_privilege('service_role', 'public.expense_audit_log', 'DELETE');                  -- expect false

-- ---------------------------------------------------------------------
-- Rollback (reference only — not executed as part of this file)
-- ---------------------------------------------------------------------
-- REVOKE ALL ON public.job_payments FROM service_role;
-- REVOKE ALL ON public.expenses FROM service_role;
-- GRANT SELECT, INSERT ON public.expenses TO service_role; -- restores the pre-Stage-3 (Stage 2.5) grant
-- REVOKE ALL ON public.expense_audit_log FROM service_role;
