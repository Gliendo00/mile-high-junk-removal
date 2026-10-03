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

## Retention — implemented (hardening pass)

**Discarded**: immediate, unconditional cleanup, unchanged from the
original design. `PATCH ?action=discard` and `PATCH ?action=remove-screenshot`
both delete the Storage object alongside the database row, synchronously, in
the same request — a discarded intake's screenshots do not linger in
Storage at all (modulo the same best-effort-only caveat
`api/upload-photo.js`'s own `safeDeleteStorageObject()` already has: a
delete failure is logged, not retried, so a rare orphan is possible but not
expected).

**Pending (`processing`/`pending_review`/`extraction_failed`)**: screenshots
are removed **7 days** after the intake was created if nobody has acted on
it (`PENDING_RETENTION_DAYS` in `api/admin/intake.js`). **Confirmed**
(Stage 5D, not built — this branch is a no-op until then): **30 days**
(`CONFIRMED_RETENTION_DAYS`).

In both cases, only the screenshots are removed — `intake_sessions.extracted_data`,
`ai_raw_extraction`, `classification`, `match_status`, and every other
column survive untouched. The structured review record outlives its source
images; the "duplicate/existing-job detection" and audit trail an admin
might still need to reference are never lost just because the retention
window passed. `screenshots_expired_at` is set at that point so the review
screen can show "screenshots expired on \<date\>" instead of a silently
empty grid that looks like a bug (`admin/intake-detail.js`'s
`renderScreenshotsExpiredNote()`).

### Cleanup mechanism — no new Vercel function

`GET`/`POST /api/admin/intake?action=cleanup-expired` is a new action on the
**existing** `api/admin/intake.js` file — not a new endpoint file, so the
function count stays at 12/12. It is the one action on that file **not**
gated by `requireAdmin()`: a Vercel Cron job (configured in `vercel.json`'s
new `"crons"` entry, `0 9 * * *` — once daily, within the Hobby plan's
cron-frequency limit) has no browser session cookie to present, so it
authenticates instead with a bearer token matching the `CRON_SECRET`
environment variable — Vercel's own documented pattern for securing
cron-triggered endpoints (Vercel automatically attaches
`Authorization: Bearer $CRON_SECRET` to the requests it sends to trigger a
configured cron). Until `CRON_SECRET` is set, this action always returns
401 and touches nothing — same "documented, not configured, fails safe"
posture as `OPENAI_API_KEY`.

**`CRON_SECRET` is a second new environment variable this batch needs,
beyond `OPENAI_API_KEY`** — not an AI credential, just a shared secret
authenticating the cron trigger. Also **not yet added anywhere**, same
explicit-go-ahead rule as every other new environment variable.

**Preview caveat:** per Vercel's documented cron behavior, a configured
cron job only fires against the **Production** deployment, not Preview —
so the daily sweep itself cannot be exercised by deploying to Preview alone
(confirm this against Vercel's current docs when actually wiring it up; not
independently re-verified from this environment, which has no live Vercel
access). To test `?action=cleanup-expired` in Preview, call it directly
(e.g. `curl -X POST https://<preview-url>/api/admin/intake?action=cleanup-expired
-H "Authorization: Bearer $CRON_SECRET"`) once `CRON_SECRET` is set there —
this exercises the exact same code path a real cron trigger would.

## Summary (quick reference)

| Question | Answer |
|---|---|
| Max screenshots per intake | 10 (app-enforced, `MAX_SCREENSHOTS_PER_SESSION`) |
| Max file size per screenshot | 4 MB (app-enforced, `MAX_SCREENSHOT_BYTES`); recommend ~5–6 MB bucket-level cap as defense-in-depth |
| Retention — discarded | Deleted immediately (row + Storage object), synchronously |
| Retention — pending/processing/extraction_failed | **7 days** (`PENDING_RETENTION_DAYS`), swept by the daily cron |
| Retention — confirmed | **30 days** (`CONFIRMED_RETENTION_DAYS`); Stage 5D not built, so unreachable today |
| Structured data after screenshot cleanup | **Always retained** — only the images/rows in `intake_screenshots` are deleted |
| Cleanup mechanism | `?action=cleanup-expired` on the existing `api/admin/intake.js`, triggered by Vercel Cron (`vercel.json`), auth'd by `CRON_SECRET` — zero new functions |
