# CRM Status Plan (Proposed — Not Implemented)

Status: **planning document only.** No column was added, no default was
changed, and no existing row was modified as part of this phase. This is
the design for a future admin UI to build against, written down now so
Phase 2 has an agreed-on contract instead of inventing one on the fly.

## Proposed status values

A future `bookings.status` (or equivalent) column is expected to hold one of:

| Status | Meaning |
|---|---|
| `new` | A booking request has come in through `/book` (or a contact-form lead has been converted) and no one has acted on it yet. |
| `contacted` | Someone from the business has reached out to the customer (phone/text/email) to confirm details, but pricing/scheduling isn't finalized. |
| `quoted` | A price has been given to the customer and the business is waiting on their decision. |
| `booked` | The customer has confirmed and the job is on the schedule with an agreed date/time and price. |
| `completed` | The job has been done. |
| `lost` | The lead did not convert — customer went elsewhere, went silent, canceled, or the job fell through for any reason. |

This is a linear happy-path (`new → contacted → quoted → booked →
completed`) with a single exit state (`lost`) reachable from any point.
Nothing about ordering/transitions is enforced by this document — that's an
admin-UI/business-logic decision for Phase 2, not a database constraint
decision for Phase 1.

## How existing data should be interpreted

Per [database-schema.md](./database-schema.md), the current `/api/book`
endpoint **never sets `bookings.status`** — every booking created since this
column has existed (if it has existed since the table's creation) has
whatever the column's default is, or NULL if there is no default. That
default value is itself NEEDS VERIFICATION against the live Supabase
project.

The plan for Phase 2:

- **A future admin UI will treat any booking whose `status` is NULL or an
  empty string as `new`** for display and filtering purposes. This is a
  presentation-layer interpretation, not a data migration.
- **No historical row will be rewritten to literally contain the string
  `"new"`** unless and until an intentional, explicit migration decision is
  made later. Until that happens, "new" for old rows is something the admin
  UI *computes when displaying/filtering*, not something stored.
- This avoids two separate risks: (a) touching production booking rows
  before the admin UI and its authorization model exist to safely manage
  them, and (b) silently asserting "every existing booking really was new
  and untouched" — which may not be true for jobs that were already
  contacted, quoted, or completed by phone/text outside of any system.

## Explicitly out of scope for this phase

- Adding the `status` column (or confirming its current default) — that's a
  live-schema change and is NEEDS VERIFICATION / Phase 2 work, not Phase 1.
- A `booking_activity` table (an audit/history log of status changes,
  notes, etc.) — the original Phase 1 instructions explicitly excluded this;
  it's a reasonable Phase 2 companion to this status system (so a status
  change is traceable to who/when/why) but is not designed here.
- Any UI, API route, or database write that actually sets or changes a
  status value.
