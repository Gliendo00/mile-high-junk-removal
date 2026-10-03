# Phase 3C Batch 5 — `intake-screenshots` Storage Bucket Design

Status: **design only — the bucket does not exist yet.** `api/admin/intake.js`
assumes it already exists, the exact same way `api/upload-photo.js` assumes
`booking-photos` already exists (see
[database-schema.md §Storage](../phase-1/database-schema.md)) — no code path
in this project ever creates a bucket. This document is what Rocky (or
Claude, with explicit go-ahead) needs to set up manually in the Supabase
dashboard before any real screenshot upload can succeed, per
[batch5-screenshot-intake-proposal.md §4.2](./batch5-screenshot-intake-proposal.md#42-storage).

## Required setup (manual, Supabase dashboard)

1. **Create a bucket named exactly `intake-screenshots`** — this is the
   literal `BUCKET` constant in `api/admin/intake.js`; a typo'd name means
   every upload fails with a generic "Could not upload screenshot" error.
2. **Private, not public.** No public-read access, no "anon" `SELECT`
   policy on `storage.objects` scoped to this bucket. Same posture as
   `booking-photos` — admin-only viewing is exclusively via short-lived
   signed URLs (`createSignedUrl`, 300-second TTL, minted fresh per
   `GET /api/admin/intake?id=...` call — see `SCREENSHOT_URL_TTL_SECONDS`).
3. **No explicit `storage.objects` RLS policy needs to be added for
   service-role access.** The service-role key bypasses Supabase Storage
   RLS entirely — the same mechanism `booking-photos` already relies on in
   this exact production project (confirmed in practice: `booking-photos`
   uploads/signed-URL reads have worked in production since Phase 1, which
   is only possible if service-role Storage bypass already holds for this
   project). This is stronger confirmation than
   [database-schema.md](../phase-1/database-schema.md)'s original "NEEDS
   VERIFICATION" note on `booking-photos`, written before that bucket had
   ever been exercised live.
4. **Recommended bucket-level max file size: ~5–6 MB.** Not strictly
   required — the application already rejects anything over 4 MB
   (`MAX_SCREENSHOT_BYTES` in `api/admin/intake.js`) before it ever reaches
   Storage — but a bucket-level cap is defense-in-depth against a future
   code bug, matching the existing relationship between `booking-photos`'
   app-level 4 MB cap and its own (NEEDS VERIFICATION per
   `database-schema.md`) 6 MB infra-level limit.
5. **No lifecycle/TTL policy is configured in Storage itself.** Supabase
   Storage has no built-in automatic object expiry. Cleanup is entirely
   application-driven today — see "Retention" below.

## What the application already enforces (no further Storage config needed)

- **Allowed types:** `image/jpeg`, `image/png`, `image/webp` only —
  verified both by the declared `X-Screenshot-Type` header and by checking
  the file's actual magic bytes (`matchesMagicBytes()` in
  `api/admin/intake.js`, same check `api/upload-photo.js` already uses for
  booking photos), so a mislabeled file is rejected rather than trusted.
- **Per-screenshot size cap:** 4 MB (`MAX_SCREENSHOT_BYTES`) — mirrors
  `api/upload-photo.js`'s existing `MAX_PHOTO_BYTES`, comfortably under
  Vercel's hard 4.5 MB per-request body limit.
- **Per-session screenshot count cap:** 10 (`MAX_SCREENSHOTS_PER_SESSION`)
  — a soft operational cap (not from the original brief) guarding against
  runaway upload/extraction cost, not a Storage-level setting.
- **Path convention:** `intake/<intakeSessionId>/<uuid>.<ext>` — mirrors
  `booking-photos`' own `bookings/<bookingId>/<uuid>.<ext>` convention
  exactly.

## Retention — current behavior vs. open questions

**Discarded**: immediate, unconditional cleanup. `PATCH ?action=discard`
and `PATCH ?action=remove-screenshot` both delete the Storage object
alongside the database row, synchronously, in the same request — a
discarded intake's screenshots do not linger in Storage at all (modulo the
same best-effort-only caveat `api/upload-photo.js`'s own
`safeDeleteStorageObject()` already has: a delete failure is logged, not
retried, so a rare orphan is possible but not expected).

**Pending (`processing`/`pending_review`/`extraction_failed`)**: **no
automatic expiry exists yet.** A screenshot persists in Storage
indefinitely until an admin explicitly discards it or removes it — there is
no scheduled job in this project (this codebase has no cron/background-job
infrastructure at all) that auto-discards a stale pending intake after N
days. This is a real, current gap worth flagging to Rocky, not a decision
already made: if screenshots accumulate because intakes get created but
never reviewed, there is currently no automatic cleanup. A future addition
(out of scope for Batch 5) could add a scheduled Vercel Cron Job that
auto-discards `pending_review`/`extraction_failed` sessions past some age
threshold (e.g. 30 days) — not built here.

**Confirmed**: **undefined — Stage 5D doesn't exist yet**, so there is
literally no code path that reaches a `confirmed` intake's screenshots. A
reasonable default for when 5D is designed: keep them, the same way
`booking_photos` are kept indefinitely once a booking exists (no
auto-delete, since they become a durable record of what the client
originally sent — if storage cost ever becomes a concern, that's a later,
separate, data-retention-policy decision). This is a **recommendation for
5D's design, not an implemented behavior.**

## Summary (quick reference)

| Question | Answer |
|---|---|
| Max screenshots per intake | 10 (app-enforced, `MAX_SCREENSHOTS_PER_SESSION`) |
| Max file size per screenshot | 4 MB (app-enforced, `MAX_SCREENSHOT_BYTES`); recommend ~5–6 MB bucket-level cap as defense-in-depth |
| Retention — discarded | Deleted immediately (row + Storage object), synchronously |
| Retention — pending/extraction_failed | **No automatic expiry** — persists until an admin acts; a future scheduled-cleanup job is a known gap, not built |
| Retention — confirmed | Undefined (Stage 5D not built); recommended default is "kept indefinitely," matching `booking_photos` |
