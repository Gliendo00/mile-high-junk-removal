# Phase 3C Stage 1 — Test Matrix

All automated, offline, local (`node tests/<file>.test.js`) — no real network
call, no real Supabase project touched, matching every prior phase's test
approach. New coverage lives in
[tests/phase3c-schedule.test.js](../../tests/phase3c-schedule.test.js) (28
tests). The full existing suite was re-run alongside it to confirm no
regression from the `api/_lib/booking-format.js` time-window refactor or the
static-file restructuring.

| Requested coverage | Where | Result |
|---|---|---|
| Schedule endpoint auth | `GET schedule:` no-cookie / bad-token / non-admin-email → 401; `Cache-Control: no-store`; non-GET → 405; no key leakage | 6/6 pass |
| Today/Tomorrow/Week range handling | Default-to-today; unrecognized range falls back to today; tomorrow returns only tomorrow's job; week includes today..+6 days and excludes +7/yesterday | 4/4 pass |
| Chronological ordering | Same-day jobs sort by time-window start hour (not insertion order); an unrecognized time_window sorts last, never dropped; earlier dates sort before later dates regardless of window | 3/3 pass |
| Status/date inclusion architecture | Only `booked`/`completed` bookings ever appear; `new` (NULL)/`contacted`/`quoted`/`lost` never do, even on a matching date — confirms no second operational-status system was introduced | 1/1 pass |
| Response shape | Each job carries time/client/service/address/price/status/phone; legacy bookings with no `service_city` snapshot fall back to the customer's current city | 2/2 pass |
| Requests badge count | `GET new-count:` auth gate; counts only NULL-status rows, matching `bookings.js`'s own "new" definition; response shape is exactly `{ok, new}` | 4/4 pass |
| Badge hidden at zero | Endpoint returns `{new: 0}` correctly (verified); the DOM-level hide-on-zero behavior in `admin/nav-badge.js` is verified by code review, not by this offline harness — there is no DOM/click simulation available in this project's test setup, the same disclosed limitation `tests/phase3a-admin-status-write.test.js` already notes for its own client-side double-tap guard | 1 endpoint test + manual/code-review verification of the client behavior |
| Moved Requests page | `admin/requests/index.html` exists and still loads the unmodified `dashboard.js`; `admin/index.html` now loads `schedule.js` and no longer loads `dashboard.js`; the booking-detail back-link now points at `/admin/requests/` | 3/3 pass |
| Navigation | All three tabs (Schedule/Requests/Clients) present on every non-login admin page; login page unchanged (no nav); badge markup present and starts `hidden` everywhere | 3/3 pass |
| XSS/rendering discipline | `admin/schedule.js` and `admin/nav-badge.js` added to the existing innerHTML/insertAdjacentHTML/document.write grep guard | 1/1 pass |
| No unexpected new admin write paths | Write-audit grep extended to include `api/admin/schedule.js`, `api/admin/new-count.js`, and `api/_lib/time-windows.js` — asserts the found write-call list is **unchanged**: still exactly `api/admin/booking-status.js: .update(` | 1/1 pass |

**Phase 3C Stage 1 total: 28/28 passing.**

## Full-suite regression run (all phases)

| File | Result |
|---|---|
| `tests/phase1-api.test.js` | 22/22 pass |
| `tests/phase2-admin-api.test.js` | 29/29 pass (includes the pre-existing `timeWindowLabel(...)` assertions, which pass unmodified against the refactored `api/_lib/booking-format.js` — confirming the shared `api/_lib/time-windows.js` module produces byte-identical labels) |
| `tests/phase3a-admin-status-write.test.js` | 33/33 pass (its own write-audit assertion, scoped only to `booking-status.js`, is unaffected by Stage 1's new read-only files) |
| `tests/phase3b-clients.test.js` | 28/28 pass |
| `tests/phase3b-step4a2-customer-identity.test.js` | 13/13 pass |
| `tests/phase3b-step4a3-repeat-client-reuse.test.js` | 14/14 pass |
| `tests/phase3c-schedule.test.js` (new) | 28/28 pass |

**Grand total: 167/167 passing, 0 failed.**

## What could not be tested in this offline harness

- Real Supabase network behavior (RLS, actual FK cascade firing, real query
  performance) — the FK cascade facts recorded in
  [database-schema-updates.md](./database-schema-updates.md) were confirmed
  directly against the live project outside of this test suite, per the
  stage instructions, not by any automated test here.
- Real browser DOM behavior for `admin/schedule.js`/`admin/nav-badge.js`
  (click handling, badge show/hide, card layout at actual mobile viewport
  widths) — verified instead via the local static-file browser preview
  (`site-static` in `.claude/launch.json`) at a 375×812 mobile viewport, with
  console output checked for JavaScript errors. That preview has no backend,
  so all `/api/*` calls correctly 404 and every page's existing error-banner
  path was exercised (and rendered cleanly) rather than the success path,
  which requires real Supabase credentials this environment doesn't have.
