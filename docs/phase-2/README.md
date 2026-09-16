# Phase 2 — Admin Auth + Read-Only Dashboard

Documentation for Phase 2 of the admin portal/CRM project: Supabase Auth
for `/admin`, and a read-only booking dashboard + detail page. Built on top
of the foundation documented in [../phase-1/](../phase-1/README.md).

Status: **implemented, locally tested, not yet deployed.** No commit, push,
or deployment has happened as part of this phase — see the chat report for
the full pre-deployment summary. No production Supabase data was written,
modified, or deleted; no schema change was made.

## Contents

- [auth-architecture.md](./auth-architecture.md) — how `/admin` authentication works end-to-end (Supabase Auth, httpOnly cookies, the admin email allowlist), the new environment variables, and the exact manual Supabase dashboard steps needed before this can be deployed and used.
- [security-review.md](./security-review.md) — a self-review against the nine specific security areas requested (auth bypass, IDOR, secret leakage, cookie security, XSS, signed URL exposure, cache headers, error-message leakage), each with what was actually verified and how.
- [test-matrix.md](./test-matrix.md) — the automated test coverage (25/25 passing, backed by [tests/phase2-admin-api.test.js](../../tests/phase2-admin-api.test.js)) mapped against the 15 requested test scenarios, plus what could not be tested without real Supabase infrastructure.

## What Phase 2 does NOT include

Per the phase instructions, none of the following exist yet: editing any
booking field, changing status, adding notes, SMS, a `booking_activity`
table, or any write path to `customers`/`bookings`/`dumpster_rentals`/
`booking_photos`/Storage. The dashboard and detail page are read-only in
the literal sense — there is no button, form, or API route in this phase
capable of writing to any of those tables.
