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
- [test-matrix.md](./test-matrix.md) — automated test coverage for Stage 1, backed by [tests/phase3c-schedule.test.js](../../tests/phase3c-schedule.test.js), plus the full existing suite re-run to confirm no regression.

## Status

**Stage 1 (Schedule homepage) implemented, locally tested, not yet deployed
or pushed to `main`.** Every other stage in the Phase 3C plan (create/edit
jobs, payment/tip fields, client creation/management, archive/delete,
operational job status, route map, SMS) remains audited but unimplemented —
see the architecture audit for the full staged plan and priority order.

## What Phase 3C Stage 1 does NOT include

Per the stage instructions: no route map/"View Route", no payment/tip/
payment-status editing, no Create Job/Create Client workflow, no archive or
delete functionality, and no database schema change. `bookings.status`'s
six values are unchanged and untouched — the Schedule reuses them exactly as
they already exist, rather than adding a parallel operational-status field.
