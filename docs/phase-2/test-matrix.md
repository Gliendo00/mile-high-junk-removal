# Phase 2 Test Matrix

All automated tests below ran **locally, offline, with no network calls and
no access to the production Supabase project** — same approach as Phase 1.
The harness is checked in at
[tests/phase2-admin-api.test.js](../../tests/phase2-admin-api.test.js):

```bash
node tests/phase2-admin-api.test.js
```

It intercepts `require("@supabase/supabase-js")` process-wide (no package
install, no `node_modules`/lockfile changes) and replaces it with an
in-memory fake: a small hand-built query builder supporting exactly the
operations the admin routes use (`.select/.eq/.in/.order/.range/
.maybeSingle`, count-only head queries, `storage.createSignedUrl`), plus a
mockable `auth` namespace (`signInWithPassword`/`getUser`/
`refreshSession`/`setSession`/`signOut`). The real `api/admin/*.js` and
`api/_lib/*.js` code runs unmodified against those fakes.

**Current result: 25/25 passing.** Phase 1's suite
([tests/phase1-api.test.js](../../tests/phase1-api.test.js)) was also
re-run and is unaffected: **20/20 passing**.

## Matrix (against the 15 items requested)

| # | Requirement | Status | Method |
|---|---|---|---|
| 1 | Unauthenticated `/admin` API access → denied | **TESTED (mocked)** | Three variants: no cookies at all, a garbage/forged access token, and a valid-but-non-allowlisted email — all assert 401 from both `/api/admin/bookings` and `/api/admin/booking`. |
| 2 | Authenticated booking list → allowed | **TESTED (mocked)** | Asserts 200, correct summary counts, newest-first ordering, and per-booking field shape against a 2-row fixture database. |
| 3 | Authenticated booking detail → allowed | **TESTED (mocked)** | Asserts 200 and full field mapping (customer, dumpster, photos) for an existing booking id. |
| 4 | Invalid/expired session → denied | **TESTED (mocked)** | Covers both "access token invalid, no refresh token" (401 immediately) and "access token invalid, refresh token *also* invalid/expired" (401 after a failed refresh attempt) — fails closed in both. |
| 5 | Missing booking ID → safe error | **TESTED (mocked)** | Asserts 400 with no query issued when `?id=` is absent. |
| 6 | Nonexistent booking ID → safe 404 | **TESTED (mocked)** | A well-formed UUID not present in the fixture database gets a generic 404, not a 500 or a leaked "0 rows" detail. |
| 7 | NULL status → displayed as New | **TESTED (mocked + unit)** | Unit-tested directly against `normalizedStatus()`/`statusLabel()` for `null`/`""`/`undefined`, and integration-tested via a fixture booking with `status: null` appearing in both the list (counted under `summary.new`) and detail responses with `status: "new"` / `statusLabel: "New"`. |
| 8 | Legacy time-window → readable label | **TESTED (unit + integration)** | `timeWindowLabel("morning")` → `"Morning (8am–11am)"`; the fixture booking using `time_window: "morning"` shows that exact label in the list response. |
| 9 | Current time-window → readable label | **TESTED (unit + integration)** | `timeWindowLabel("w_0800_1000")` → `"8:00 AM – 10:00 AM"`, both as a unit test and via a fixture booking. |
| 10 | Booking with zero photos | **TESTED (mocked)** | Asserts `photos: []` (not an error, not `null`) for a booking with no `booking_photos` rows. |
| 11 | Booking with photos | **TESTED (mocked)** | Asserts a populated `photos` array with a working mock-signed `url` for a booking with one `booking_photos` row. |
| 12 | Signed photo URLs generated only after authentication | **TESTED (mocked)** | Confirms zero calls to the mock storage client's `createSignedUrl` for an unauthenticated request to a booking with a photo, then exactly one call for the same booking once authenticated. |
| 13 | Customer-supplied HTML/script content does not execute | **TESTED (static analysis + real browser)** | Automated: greps `admin/dashboard.js` and `admin/booking-detail.js` for `innerHTML=`/`insertAdjacentHTML(`/`document.write(` — none present, and this now fails the suite if one is ever added. Manually verified live in a real browser DOM with actual XSS payloads standing in for a customer name/city/labels — see [security-review.md](./security-review.md) point 5 for the specifics; that harness was temporary and was not committed. |
| 14 | No service-role secret appears in browser-visible output | **TESTED (mocked + grep)** | Automated: asserts the JSON bodies of login/list/detail responses never contain the mock service-role or anon key strings. Manually grepped every file under `admin/` for the env var name and any key material — no matches. |
| 15 | Use mocks/local testing; no production Supabase records | **Followed throughout** | No test in this phase connects to a real Supabase project. See "NOT PRODUCTION-TESTED" below for what that leaves unverified. |

Additional coverage beyond the 15 requested, exercised because the
implementation needed it to be correct:

- Login: valid admin credentials succeed and set properly-flagged cookies (`HttpOnly`, `Secure`, `SameSite=Lax`).
- Login: wrong password → generic 401, no cookies set.
- Login: correct Supabase credentials but a non-allowlisted email → identical generic 401, no cookies (this is also item #1/#4's authorization half).
- Login: allowlist comparison is case-insensitive and tolerates whitespace around entries.
- Login: missing email/password → 400 before any Supabase call is made.
- Access-token expiry + valid refresh token → succeeds, and the rotated access+refresh pair is written back to cookies (verified by asserting the new cookie values, not just that *some* cookie was set).
- Logout: hydrates a client with the caller's session and calls `signOut()`, then clears both cookies with `Max-Age=0` regardless.
- `timeWindowLabel()` on a value that matches neither a legacy nor current window falls back to the raw string instead of throwing.

## NOT PRODUCTION-TESTED

These require real infrastructure this session was explicitly told not to
touch, or a live Supabase project this session has no access to:

- **Real Supabase Auth.** No test in this phase calls the actual
  `signInWithPassword`/`getUser`/`refreshSession`/`signOut` REST endpoints.
  The mock replicates the documented request/response shape of the v2 SDK,
  but the real project's behavior — token expiry timing, refresh-token
  rotation/reuse-detection specifics, rate limiting on failed logins — was
  not observed directly.
- **Whether `SUPABASE_ANON_KEY`/`ADMIN_ALLOWED_EMAILS` are actually
  configured correctly in Vercel.** Cannot be tested until they're set; see
  [auth-architecture.md](./auth-architecture.md) for the exact manual
  steps.
- **Whether RLS is actually enabled/locked-down on the four tables, and
  whether the `booking-photos` bucket is actually private.** Flagged as
  NEEDS VERIFICATION since Phase 1
  ([database-schema.md](../phase-1/database-schema.md)) and still not
  independently confirmed — the admin routes' own security doesn't depend
  on RLS (they use the service-role key, which bypasses it), but the
  broader claim "unauthenticated callers can't read this data some other
  way" does.
- **Real Supabase Storage `createSignedUrl` against the real
  `booking-photos` bucket** — the mock returns a syntactically similar but
  fake URL; actual signing (and what happens if a `storage_path` from the
  database doesn't correspond to a real object) was not exercised.
- **The real booking list/detail against real production data shapes** —
  column types, unexpected NULLs in columns other than `status`, or a
  `dumpster_rentals`/`booking_photos` row that doesn't match the shape this
  code assumes, would only surface against the real database. The code
  defends against the *known* unknowns (missing customer row, missing
  dumpster row, zero photos, a signing failure for one photo) but a truly
  unanticipated data shape could still surface as a generic 500 rather than
  rendering — which is the safe failure mode (no raw error/data leak), but
  it would still need to be fixed.
- **End-to-end browser testing of the login flow itself** (typing real
  credentials, submitting, landing on `/admin`, then loading real data) —
  impossible without a real Supabase Auth user and the anon key configured,
  neither of which exist yet for this project. The login *page* was visually
  verified (renders correctly, mobile-sized); the login *request* was only
  tested against the mock in `tests/phase2-admin-api.test.js`.
- **Mobile UX on a real phone.** Verified via the Browser pane's mobile
  viewport emulation (375×812) for the login page; the dashboard and detail
  pages were verified at desktop width with mocked data. Not tested on an
  actual device.
