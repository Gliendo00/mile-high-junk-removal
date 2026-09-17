# Phase 3 — Job Tracking, Scheduling & CRM Growth

Documentation for Phase 3 of the admin portal/CRM project. Builds on the
read-only foundation from [../phase-2/](../phase-2/README.md) (auth,
dashboard, detail page) and the Clients section / repeat-client identity
work already shipped in Phase 3A/3B (status write, `/admin/clients`,
`phone_normalized`/`email_normalized`).

Phase 3C is the current work: an architecture audit followed by staged
implementation of a mobile-first operational Schedule, job creation/editing,
payment tracking, client creation/management, and safe record removal —
implemented incrementally, one reviewed stage at a time.

## Contents

- [database-schema-updates.md](./database-schema-updates.md) — the confirmed `ON DELETE CASCADE` behavior of all three `bookings`/`customers`/`dumpster_rentals`/`booking_photos` foreign keys, verified directly against production Supabase, and why it matters for the not-yet-built archive/delete stage.
- [schedule-architecture.md](./schedule-architecture.md) — Stage 1: `/admin/` becomes the Schedule homepage, Requests moves to `/admin/requests/`, and how the Today/Tomorrow/Week views are built without introducing a second operational-status system.
- [vercel-function-limit.md](./vercel-function-limit.md) — a real Preview deployment failure hit during Stage 1 verification: this project's Vercel Hobby plan caps a deployment at 12 Serverless Functions, and Stage 1 initially exceeded it. How it was fixed, and what it means for later stages that each want their own new endpoint.
- [test-matrix.md](./test-matrix.md) — automated test coverage for Stage 1, backed by [tests/phase3c-schedule.test.js](../../tests/phase3c-schedule.test.js), plus the full existing suite re-run to confirm no regression.
- [stage2-plus-requirements.md](./stage2-plus-requirements.md) — the locked product requirements gathered after Stage 1 shipped: Month/Year Schedule, historical migration back to Jan 1 2026, New/Past Job creation, client creation, job money tracking (tips/payment), lightweight expense tracking, archive/restore/delete, and the future route-map/SMS stages. Requirements only — no implementation.
- [stage2-plus-architecture-audit.md](./stage2-plus-architecture-audit.md) — how those requirements land on the current codebase: conflicts with existing behavior (the rolling-7-day "week," `booking-status.js`'s deliberately narrow write scope), the schema changes they imply, a concrete plan for fitting the new write surface inside the Vercel Hobby function limit, security implications, a technically-ordered staged sequence, and the decisions that needed Rocky's/the owner's input before Stage 2 starts (now resolved — see below).
- [stage2-decisions.md](./stage2-decisions.md) — the owner's answers to the architecture audit's open questions: stay on Vercel Hobby and consolidate; retire `booking-status.js` later as its own reviewed change, not bundled into New Job; the locked admin duplicate-client policy (block on exact phone+email match, warn-only on a partial match, never auto-merge); the Past Job duplicate policy (never re-enter a job that already exists in the CRM); and the revised Stage 2 sequence (Month/Year moved up ahead of financial reporting).
- [stage2-preflight.md](./stage2-preflight.md) — the read-only schema check requested before Stage 2 money/time-window work: confirming `bookings.estimated_price`/`final_price`/`time_window`'s live type, precision, and nullability. Blocked on dashboard access this environment doesn't have; the exact query/steps are recorded so anyone can run it and report back.
- [stage2.1-new-job-proposal.md](./stage2.1-new-job-proposal.md) — the implementation boundary for `+ New Job` + inline Create Client: exact files, API contracts for `POST /api/admin/booking` and `POST /api/admin/client`, the duplicate-check flow, function-count impact (stays at 12/12, zero new files), tests, and the Preview testing plan that never mutates production Supabase. **Implemented** on branch `phase-3c/stage2.1-new-job` (commit `c65aa80`) — not merged, not deployed.
- [stage2.4-calendar-address-proposal.md](./stage2.4-calendar-address-proposal.md) — Month/Year/navigable-Week calendar navigation, date-aware `+ New Job`/`+ Past Job` entry, the shared Google Address Autocomplete component (modern Places API (New), manual fallback mandatory), and the Daily Quick Expense Tracking addendum. **Implemented** on branch `phase-3c/stage2.4-calendar-address` — not merged, not deployed.
- [stage2.4-expenses-migration.md](./stage2.4-expenses-migration.md) — the `expenses` table migration the Quick Expense Tracking addendum depends on: exact `CREATE TABLE` SQL. **Executed by the owner** (with an added `CHECK (amount > 0)` constraint), confirmed live.
- [stage2.4.1-schedule-ux-proposal.md](./stage2.4.1-schedule-ux-proposal.md) — Selected-day/Daily layout reorder (date → Quick Expense icons → Jobs), the new compact tappable job card, Week redesigned into a 7-day overview, plus two investigations (completed-job date editing — no bug found; Google autocomplete — absent config, not a bug) and a public-site isolation audit. **Implemented** on branch `phase-3c/stage2.4.1-schedule-ux-fixes` — not merged, not deployed.

## Status

**Production `main` is at `afddeb0`** as of this writing — Stage 1, Stage
2.1, Stage 2.2 (+ Past Job, + Tip Amount), Stage 2.3 (Existing Job Editing,
Client Typeahead), and Stage 2.4 (Calendar/Month/Year, date-aware entry,
Google Address Autocomplete, Daily Quick Expense Tracking) are all live —
including the `expenses` table, created by the owner in production Supabase.
**Stage 2.4.1 (Schedule UX polish + two investigations) is implemented on
feature branch `phase-3c/stage2.4.1-schedule-ux-fixes`** (now including the
Google Maps key-delivery implementation, §5a), 480/480 tests
passing, function count still exactly 12/12 —
but **not merged to `main` and not deployed**. See
[stage2.4.1-schedule-ux-proposal.md](./stage2.4.1-schedule-ux-proposal.md)
for the full writeup. Money-field revenue summaries, archive/restore/delete,
expense reporting, route map, and SMS remain unimplemented, to be built and
reviewed individually per [stage2-decisions.md](./stage2-decisions.md)'s
sequence.

## What Phase 3C Stage 1 does NOT include

Per the stage instructions: no route map/"View Route", no payment/tip/
payment-status editing, no Create Job/Create Client workflow, no archive or
delete functionality, and no database schema change. `bookings.status`'s
six values are unchanged and untouched — the Schedule reuses them exactly as
they already exist, rather than adding a parallel operational-status field.
