-- Client review status — "review received" tracking on customers.
-- To be run manually in the Supabase SQL editor (this project has no
-- migration runner; same convention as every other file in sql/).
--
-- What this adds, and nothing else:
--   1. customers — 2 new nullable columns: review_received_at (when Rocky
--      marked that this client left a review) and review_received_by (the
--      admin email who marked it). No existing column touched.
--   2. customer_audit_log — widens the event_type CHECK so the new
--      "mark received" / "clear" actions are written to the same audit
--      trail as archive/restore.
--
-- "Review request SENT" is NOT new: it already lives per job as
-- bookings.review_request_sent_at (Phase 3C Stage 5). The CRM's client star
-- is derived from both:
--   gold star    = customers.review_received_at IS NOT NULL
--   outline star = any of the client's jobs has review_request_sent_at set
--   no star      = neither
--
-- Safe to run before or after the code ships: api/_lib/review-status.js
-- falls back to "request sent / nothing" if these columns don't exist yet,
-- and the Review received toggle just shows an error until this runs.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS review_received_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS review_received_by text NULL;

ALTER TABLE public.customer_audit_log
  DROP CONSTRAINT IF EXISTS customer_audit_log_event_type_check;
ALTER TABLE public.customer_audit_log
  ADD CONSTRAINT customer_audit_log_event_type_check
  CHECK (event_type IN ('archive', 'restore', 'review_received', 'review_received_cleared'));

-- Speeds up the "which of these clients have a review request sent" lookup
-- the star uses on every list screen.
CREATE INDEX IF NOT EXISTS bookings_customer_review_request_idx
  ON public.bookings (customer_id)
  WHERE review_request_sent_at IS NOT NULL;

-- Rollback (only if needed):
-- DROP INDEX IF EXISTS public.bookings_customer_review_request_idx;
-- ALTER TABLE public.customer_audit_log DROP CONSTRAINT IF EXISTS customer_audit_log_event_type_check;
-- ALTER TABLE public.customer_audit_log ADD CONSTRAINT customer_audit_log_event_type_check CHECK (event_type IN ('archive', 'restore'));
-- ALTER TABLE public.customers DROP COLUMN IF EXISTS review_received_by, DROP COLUMN IF EXISTS review_received_at;
