# Phase 3C — Confirmed Foreign Key Behavior (Database Audit Finding)

Status: **confirmed against live production Supabase, 2026-09-16.** This is
not new schema, not a migration, and not a code change — it's a direct
verification of facts that [../phase-1/database-schema.md](../phase-1/database-schema.md)
had previously marked NEEDS VERIFICATION (or, in `bookings.customer_id`'s
case, inferred only from a code comment in `api/book.js` and never
independently checked). Recorded here, ahead of any archive/delete feature
work, specifically because it changes the safe design for that future work.

## Confirmed

| Foreign key | Behavior |
|---|---|
| `bookings.customer_id → customers.id` | `ON DELETE CASCADE` |
| `booking_photos.booking_id → bookings.id` | `ON DELETE CASCADE` |
| `dumpster_rentals.booking_id → bookings.id` | `ON DELETE CASCADE` |

## Why this matters

**Deleting a `customers` row deletes every one of that client's `bookings`
rows automatically, at the database level, with no opportunity for
application code to inspect, warn, or block it once the `DELETE` statement is
issued.** This confirms — rather than merely infers, as the code comment in
[api/book.js:227-229](../../api/book.js) did for the narrower case of the
Step 4a.3 repeat-client rollback logic — the exact risk the Phase 3C
architecture audit's record-removal section was built around: a client with
existing jobs must never be casually, silently deletable.

**Deleting a `bookings` row also cascades to its `dumpster_rentals` row (if
any) and every `booking_photos` row for it.** This is a DB-level row cascade
only — it has no reach into Supabase **Storage**. A cascaded delete of
`booking_photos` rows does **not** delete the corresponding files in the
`booking-photos` Storage bucket; those become orphaned objects unless a
future delete endpoint explicitly calls `supabase.storage.from(BUCKET)
.remove([...])` for each photo's `storage_path` before (or alongside) the row
delete — mirroring the existing `safeDeleteStorageObject()` pattern already
used defensively in [api/upload-photo.js](../../api/upload-photo.js) for a
different failure case.

## Consequence for future work (not implemented in this stage)

Per the Phase 3C architecture audit's record-removal section, any future
permanent-delete endpoint for `customers` must count that client's bookings
**before** issuing the delete and refuse by default when the count is
greater than zero — the CASCADE itself offers no point at which application
code can intervene, so the guard has to live entirely in the check that runs
before the `DELETE` is ever sent. Archive (a nullable `archived_at` column,
purely a visibility flag with no cascading effect) remains the recommended
normal-use removal action; this finding is exactly why. No archive or delete
functionality is implemented as part of this stage.
