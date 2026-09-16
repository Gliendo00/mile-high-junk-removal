# Phase 1 — Admin Portal / CRM Foundation

Documentation produced during Phase 1 of the admin portal / CRM project.
Phase 1 is **spam protection + foundational documentation only** — no
`/admin` UI, no auth implementation, no database schema changes, and no
production Supabase writes happened as part of this phase.

Everything in this folder is written to be read on its own by whoever picks
up Phase 2, without needing this conversation's context.

## Contents

- [database-schema.md](./database-schema.md) — what's actually confirmed about the `customers`, `bookings`, `dumpster_rentals`, and `booking_photos` tables from reading the codebase, and what still needs to be checked against the live Supabase project before Phase 2 relies on it.
- [crm-status-plan.md](./crm-status-plan.md) — the proposed future `bookings.status` values and how a NULL/empty status on an existing row should be interpreted once an admin UI exists. Not implemented — no column or data was touched.
- [time-windows.md](./time-windows.md) — every `time_window` value the booking form has ever written (legacy broad windows and the current 2-hour windows), their labels, and how a future admin UI should display old records.
- [admin-security-requirements.md](./admin-security-requirements.md) — the security bar the future `/admin` portal and its APIs must clear before they can go live. Requirements only — nothing here is implemented yet.
- [fill-time-safety-review.md](./fill-time-safety-review.md) — a focused review of the 3-second minimum-fill-time bot check, including one real bug it found (client/server clock-skew, fixed) and a second finding (a real false-positive risk on `/contact`) that led to a post-approval change request: `/contact` now flags a fast submission instead of discarding it, while `/book` is unchanged.
- [test-matrix.md](./test-matrix.md) — what was tested for the Phase 1 spam-protection change, how (mocked/local, via [tests/phase1-api.test.js](../../tests/phase1-api.test.js)), and what could not be safely tested without touching production, with reasons.

## Source of truth

Everything marked "confirmed" in these documents was confirmed by reading
the actual code in this repository as of this phase (`api/book.js`,
`api/contact.js`, `api/upload-photo.js`, `book/book.js`, `book/index.html`,
`contact.html`). Nothing here was invented. Anything about the live Supabase
project that cannot be seen from the code — column types, constraints,
indexes, defaults, RLS policies, storage bucket privacy — is explicitly
marked **NEEDS VERIFICATION** and must be checked against the actual
Supabase dashboard/CLI before Phase 2 code depends on it.
