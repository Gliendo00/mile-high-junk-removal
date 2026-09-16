# Phase 1 Test Matrix

All tests below were run **locally, offline, with no network calls and no
access to the production Supabase project.** The harness is checked in at
[tests/phase1-api.test.js](../../tests/phase1-api.test.js) and can be
re-run any time with:

```bash
node tests/phase1-api.test.js
```

It works by intercepting `require("@supabase/supabase-js")` process-wide
(no package install, no `node_modules`/lockfile changes) and `global.fetch`,
replacing both with in-memory fakes that record every call. The real
`api/book.js`, `api/contact.js`, and `api/upload-photo.js` handler code runs
unmodified against those fakes — so this tests the actual application logic
(validation, spam checks, rate limiting, response shaping, token
signing/verification), just without a real database or a real outbound
email.

**Current result: 20/20 passing** (last run during this phase; re-run
before relying on this if the API code changes again).

**Change log:** after initial Phase 1 approval, a change request updated
`/api/contact`'s fill-time behavior from a hard discard to a soft flag (see
[fill-time-safety-review.md](./fill-time-safety-review.md) finding #2's
"Resolution"). `/api/book`'s fill-time behavior is unchanged. The matrix
below reflects the current (post-change-request) behavior.

## Matrix

| # | Requirement | Status | Method |
|---|---|---|---|
| 1 | Junk removal booking | **TESTED (mocked)** | `book: junk removal booking succeeds and writes customer+booking rows` — asserts 200, an `uploadToken` is returned, and exactly the expected `customers` + `bookings` inserts happen with `service_type: "junk_removal"`. |
| 2 | Light demo booking | **TESTED (mocked)** | `book: light demo booking succeeds` — same shape, `service_type: "light_demo"`. |
| 3 | Dumpster rental booking | **TESTED (mocked)** | `book: dumpster rental booking succeeds and writes a dumpster_rentals row` — asserts the insert order `customers → bookings → dumpster_rentals`. |
| 4 | Booking without photos | **TESTED (mocked)** | `book: booking with no photos still returns a usable uploadToken` — the booking endpoint's behavior doesn't depend on whether photos follow; confirms a normal booking with zero photos still succeeds and returns a token. |
| 5 | Booking with photos | **TESTED (mocked), end-to-end across two endpoints** | Covered jointly by the "uploadToken is well-formed" test and the upload-photo tests (#10/#11 below) — a real token minted by a real `/api/book` call in the test run is then used to authorize a real (mocked-storage) call into `/api/upload-photo`, proving the two endpoints' handoff actually works together, not just in isolation. |
| 6 | Invalid booking | **TESTED (mocked)** | `book: invalid booking (missing item description) is rejected with 400` — asserts a 400 with an error message, and that **zero** database calls occur (an invalid booking never reaches Supabase). |
| 7 | Honeypot submission | **TESTED (mocked)**, both endpoints | `book: honeypot-filled submission returns fake success and touches no data` and the equivalent contact test — assert a 200 fake-success, no DB calls, no Resend call. Honeypot handling is unchanged by the fill-time change request below — still a hard rejection on both endpoints. |
| 8 | Rate-limit behavior | **TESTED (mocked)**, both endpoints | 9 rapid requests from the same IP; the 9th is asserted to return 429 (limit is 8/15min per IP per endpoint). See the important caveat in "Not fully production-tested" below. |
| 9 | Existing Resend notification path | **TESTED (mocked transport)** | `book: successful booking calls the Resend API with expected fields` — asserts the code actually calls `fetch("https://api.resend.com/emails", ...)` with the right subject prefix and that the customer's name appears in the generated HTML. The HTTP call itself is faked (see "Not fully production-tested"). |
| 10 | Photo-upload token generation | **TESTED (mocked)** | `book: response uploadToken is a well-formed signed token usable by upload-photo` — confirms the real `signUploadToken()` code path (unmodified, not reimplemented) in `api/book.js` produces a `payload.signature`-shaped token, then actually uses that exact token against `/api/upload-photo` in the next test rather than a hand-crafted fake. |
| 11 | Photo-upload authorization | **TESTED (mocked)** | Four cases: (a) valid token + valid JPEG magic-byte-correct buffer → 200; (b) missing `Authorization` header → 401; (c) tampered token (signature broken) → 401; (d) expired token, HMAC-signed with the exact same scheme as `signUploadToken()` but with `exp` in the past → 401. Also confirms the max-6-photos-per-booking limit is enforced (mocked existing count of 6 → 400). |
| 12 | Contact form | **TESTED (mocked)** | Five cases: valid submission (200, Resend called); honeypot-filled (200 fake-success, Resend NOT called — still a hard rejection); suspiciously fast (200, Resend **still called**, subject prefixed `[Fast Submission]` — see the change-request note below, this is intentionally *not* discarded); normal-speed (200, Resend called, no `[Fast Submission]` prefix); and the 9th-rapid-request rate limit (429). |

## What "TESTED (mocked)" actually proves, and what it doesn't

These tests run the real validation logic, the real spam-protection logic,
the real token signing/verification, and the real response-shaping code
exactly as they'll run in production. They prove the application-level
behavior is correct. They do **not** prove anything about the real Supabase
database, real Supabase Storage, the real Resend API, or real Vercel
infrastructure — those are all replaced with fakes. See below for exactly
what remains unverified and why that's the right call for this phase.

## NOT PRODUCTION-TESTED

These items cannot be safely verified without touching real production
infrastructure, and were **not** tested against it, per the explicit
instruction not to generate test records in production Supabase:

- **Real Supabase writes/reads.** No test in this phase connected to the
  actual Supabase project. Confirming the real `customers`/`bookings`/
  `dumpster_rentals`/`booking_photos` tables accept these exact payloads
  (correct column names, types, constraints) requires either a Supabase
  **staging/local** project (e.g. `supabase start` locally, or a separate
  non-production project) or careful manual review in the Supabase
  dashboard — not something this session had access to or should attempt
  against production.
- **Real Supabase Storage upload.** The `booking-photos` bucket upload in
  `api/upload-photo.js` is mocked; a real upload (and the real 6MB
  bucket-level limit mentioned in a code comment) was not exercised.
- **Real Resend email delivery.** `global.fetch` is faked to return a
  canned "ok" response; no email was actually sent to
  `contact@milehighjunkremoval.net` or anywhere else. The *request that
  would be sent* (URL, headers, subject, HTML body) was verified — the
  actual Resend API accepting it and an inbox receiving it was not.
- **Rate limiting under real multi-instance Vercel deployment.** The
  limiter is in-memory and per-warm-instance (documented in
  `api/_lib/spam-protection.js`). The local test proves the *algorithm* is
  correct (a sliding window correctly blocks the 9th request in 8), but it
  runs in a single Node process — it cannot demonstrate how the limit
  behaves across multiple concurrent Vercel function instances in
  production, where each instance has its own independent counter. This is
  a known, documented limitation of the chosen approach (see the comment
  block at the top of `api/_lib/spam-protection.js`), not a testing gap
  that could be closed locally.
- **Real browser autofill / real human timing on `/contact.html`.** Covered
  in detail in [fill-time-safety-review.md](./fill-time-safety-review.md)
  finding #2 — a real risk was reasoned about from the markup, but no
  actual autofill-driven submission was captured.
- **Real bfcache back/forward navigation.** Covered in
  [fill-time-safety-review.md](./fill-time-safety-review.md) finding #4 —
  argued from bfcache's specified behavior, not captured live.
- **End-to-end browser submission through the full 6-step `/book` wizard**
  (clicking through the actual date/time picker widget in a real browser).
  This session did manually drive the wizard's first three steps in the
  Browser pane (service selection, job details text fields, skipping
  optional photos) and confirmed the honeypot field is genuinely invisible
  and unfocusable on both `/book/` and `/contact.html`, and that adding it
  didn't change either page's visible layout. It did not click through the
  custom calendar/time-window picker UI to reach a real submit click,
  since that UI is unrelated to this phase's changes (this phase never
  touched the date/time picker) and the server-side contract it eventually
  produces (`elapsedMs`, `hp`, and the rest of the booking payload) is
  already fully covered by the handler-level integration tests above.
