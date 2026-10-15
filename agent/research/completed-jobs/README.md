# Completed-job evidence (publication-safe)

One JSON file per batch of completed-job evidence, each an object (or an
array of objects) containing ONLY fields from
`agent/lib/business-context.js`'s `PUBLICATION_SAFE_FIELDS` allowlist
(`serviceType`, `city`, `accessNotes`, `outcomeTag`) — nothing else is
ever accepted by `agent/lib/completed-job-intake.js`'s loader, regardless
of what a file claims.

These files are produced by whoever (or whatever) actually has real
Supabase access — a Claude-assisted session, or a future small script —
by pulling recent completed `bookings` rows and mapping each one through
`business-context.js`'s `fromCompletedBooking()` (never hand-rolling a
second redaction implementation). Never by `agent/runner.js` itself,
which has no database access by design (see `agent/README.md`).

This directory is intentionally empty on a fresh checkout — same posture
as `agent/research/results/` before Phase 3's first real research-assisted
finding: no evidence should ever be manufactured just to fill this folder.

This is EVIDENCE for the weekly research rotation (see
`agent/lib/research-rotation.js`) to weigh alongside other signals — e.g.
"several real jobs recently mention X in city Y" — never an automatic
trigger to publish anything. See `agent/lib/business-context.js`'s own
header for the full privacy boundary this depends on.
