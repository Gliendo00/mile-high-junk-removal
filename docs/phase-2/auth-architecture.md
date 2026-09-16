# Phase 2 Auth Architecture

Status: implemented and locally tested, **not yet deployed**. This document
explains how `/admin` authentication works end-to-end, and lists exactly
what has to be configured in the Supabase dashboard and in Vercel before
this can go live — none of which this session can do itself.

## Why this shape

The requirement was Supabase Auth, enforced server-side on every admin
route, with the service-role key never reaching the browser. This site has
no framework (no Next.js, no `@supabase/ssr`) — it's static HTML + vanilla
JS + standalone Vercel serverless functions — so the architecture is a thin,
hand-rolled session layer on top of `@supabase/supabase-js`'s auth methods,
built specifically to fit that shape rather than pulling in a framework-
specific auth package that assumes routing/middleware this project doesn't
have.

## The pieces

**Two Supabase API keys are used, for two different purposes, never mixed:**

- **Anon key** (`SUPABASE_ANON_KEY`, new in Phase 2) — used *only* for auth
  operations: signing in, verifying a token, refreshing a session, signing
  out. Never used to query `bookings`/`customers`/`booking_photos`.
- **Service-role key** (`SUPABASE_SECRET_KEY`, already configured since
  Phase 1) — used *only* for actual data queries, and only ever after
  `requireAdmin()` (see below) has already confirmed the caller is an
  authenticated, allowlisted admin.

**The browser never sees either key.** The login page
([admin/login/index.html](../../admin/login/index.html)) just POSTs
`{email, password}` as JSON to `/api/admin/login`
([api/admin/login.js](../../api/admin/login.js)), which performs the actual
Supabase Auth password grant server-side using the anon key. This is
stricter than the typical Supabase SPA pattern (which usually does ship the
anon key to the browser — safe by design, since it's meant to be public and
is gated by Row Level Security) — here it doesn't even need to.

**Sessions live in httpOnly cookies, not localStorage.** On a successful
login, `api/_lib/admin-auth.js`'s `setSessionCookies()` stores the Supabase
session's `access_token` and `refresh_token` in two cookies:
`mhjr_admin_at` and `mhjr_admin_rt`, both `HttpOnly; Secure; SameSite=Lax;
Path=/`. HttpOnly means client-side JavaScript — including an XSS payload,
if one ever existed — cannot read these values at all; only the browser can
send them back to us automatically on same-origin requests. This is a
deliberate improvement over the common "store the Supabase session in
localStorage" pattern, which is directly readable by any script running on
the page.

**Every `/api/admin/*` route calls `requireAdmin(req, res)` first, and does
nothing else until it returns a session.** This is the single shared
authentication/authorization helper requested — see
[api/_lib/admin-auth.js](../../api/_lib/admin-auth.js). It:

1. Reads the two cookies from the request.
2. Verifies the access token against Supabase Auth itself
   (`supabase.auth.getUser(accessToken)`) — not by locally decoding the
   JWT. This means a forged or tampered token is rejected by Supabase's own
   verification, not by our own (fallible) crypto code.
3. If the access token is missing/invalid/expired, tries the refresh token
   (`supabase.auth.refreshSession()`). Supabase rotates the refresh token on
   every use, so the new pair is written back to the cookies immediately —
   skipping this would break the *next* refresh attempt.
4. If neither produces a valid Supabase user, returns null → the route
   responds `401 { error: "Not authenticated." }`. This is "fail closed":
   there is no code path that returns admin data without step 2 or 3 having
   succeeded.
5. **Only then** checks the resulting email against `ADMIN_ALLOWED_EMAILS`
   (see below). A real, currently-valid Supabase user who isn't on this list
   is treated identically to an invalid token — 401, same generic handling —
   so nothing about *why* access was denied ever leaks.

**Being a valid Supabase Auth user is not enough by itself.**
`ADMIN_ALLOWED_EMAILS` (new in Phase 2) is a comma-separated env var listing
the only email addresses allowed to use the portal. There is no `admins`
database table and no schema change — this is intentionally the simplest
mechanism that satisfies "every route must verify the session belongs to an
authorized admin" without touching the database at all, which matters
because this phase must not modify the schema. If the business ever needs
more than a small, mostly-static set of admin users, replacing this
env-var allowlist with a real admin-roles table is the natural next step —
but that's more machinery than a single-owner admin tool needs on day one.

**Logout actually revokes the session**
([api/admin/logout.js](../../api/admin/logout.js)), not just clearing
cookies: it hydrates a throwaway Supabase client with the caller's own
tokens (`auth.setSession()`) and calls `auth.signOut()`, which invalidates
the refresh token at Supabase's end. Cookies are cleared regardless of
whether that call succeeds, so the browser can't present the session again
either way.

## Environment variables

| Variable | Status | Purpose |
|---|---|---|
| `SUPABASE_URL` | Already configured (Phase 1) | Same project, used by both the anon and service-role clients. |
| `SUPABASE_SECRET_KEY` | Already configured (Phase 1) | Service-role key — data queries only, after `requireAdmin()` succeeds. |
| `SUPABASE_ANON_KEY` | **NEW — must be added** | Anon/publishable key — auth operations only. Found in Supabase dashboard → Settings → API → "anon public" key. |
| `ADMIN_ALLOWED_EMAILS` | **NEW — must be added** | Comma-separated admin email allowlist, e.g. `owner@milehighjunkremoval.net`. |

## Supabase dashboard configuration required (cannot be done from this repo)

This session has no access to the live Supabase project and cannot perform
any of the following. Per the instruction to stop and report exactly what's
needed rather than invent credentials, here is the exact manual checklist:

1. **Get the anon key.** Supabase dashboard → your project → Settings →
   API → copy the "anon" / "public" key (NOT the "service_role" key, which
   is already in use). Add it to Vercel as `SUPABASE_ANON_KEY`.
2. **Create the first admin user.** There is no signup form anywhere in
   this app (intentionally — a public signup endpoint would be a real
   vulnerability for an admin tool). Supabase dashboard → Authentication →
   Users → "Add user" → enter the admin's real email and a password **you
   choose** (this session will not invent one). Check "Auto Confirm User"
   so the account is immediately usable without an email-confirmation step
   (or send the confirmation email and confirm it, if preferred — either
   works, since login only requires an active/confirmed account).
3. **Set `ADMIN_ALLOWED_EMAILS` in Vercel** to that same email address
   (comma-separate if there will be more than one admin).
4. **Confirm email/password sign-in is enabled** for the project.
   Supabase dashboard → Authentication → Providers → Email should be
   enabled (it is by default on a new project, but this has not been
   independently verified for this specific project since this session
   never connected to it).
5. **Confirm Row Level Security is enabled and locked down** on
   `customers`, `bookings`, `dumpster_rentals`, and `booking_photos`, and
   that the `booking-photos` storage bucket is not public. Both of these
   were already flagged as NEEDS VERIFICATION in
   [docs/phase-1/database-schema.md](../phase-1/database-schema.md) and
   [docs/phase-1/admin-security-requirements.md](../phase-1/admin-security-requirements.md) —
   Phase 2's code assumes both are true (the admin routes only ever use the
   service-role key, which bypasses RLS regardless, but an *unauthenticated*
   caller must not be able to read this data some other way, e.g. directly
   from a client-side Supabase call using the anon key against an
   unprotected table). This still needs to be checked directly in the
   dashboard — it was not and cannot be checked from this repository.
6. **Session/token lifetime** (optional to tune): Supabase dashboard →
   Authentication → Settings has the access-token (JWT) expiry (default
   3600s/1hr — this is what the silent-refresh logic in `requireAdmin()` is
   built around) and refresh-token reuse/expiry settings. The defaults are
   fine for Phase 2; no change is required unless you want a shorter or
   longer effective session length.

**Nothing above was invented.** No password was chosen, no user was
created, no dashboard setting was changed. This is the exact list of manual
steps needed before Phase 2 can be deployed and actually logged into.

## What was deliberately NOT built

- **No password reset / forgot-password flow.** Out of scope for a
  first-version, single/small-admin-team tool. If a password is lost, reset
  it directly in the Supabase dashboard.
- **No "remember me" / long-lived session beyond the refresh-token cookie's
  30-day `Max-Age`.** That cap is just when the browser stops sending the
  cookie at all; the actual session validity is entirely governed by
  Supabase's own refresh-token settings.
- **No CSRF token scheme.** Every mutating action in this phase is limited
  to login/logout, both of which require the caller to already possess
  valid credentials or an existing session; every data-reading route is a
  GET. `SameSite=Lax` cookies are not sent on cross-site subresource
  requests (img/fetch/XHR/form-POST from another origin) in modern
  browsers — only on top-level navigation — so there's no meaningful
  cross-site attack surface here to add a separate token scheme against.
  This should be revisited if/when Phase 3 adds real mutations (status
  changes, notes, etc.).
