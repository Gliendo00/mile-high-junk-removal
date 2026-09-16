# Admin Portal Security Requirements (Future Work — Not Implemented)

Status: **requirements document only.** No auth, no `/admin` route, and no
admin API exists yet. This is the bar the future admin portal must clear
before it can go live, written down now so Phase 2 is built against a
security spec from day one instead of having auth bolted on afterward.

Everything below is a requirement for *future* code. Where useful, it
points at an existing pattern already proven in this codebase that the
future admin code should copy, since this repo already got some of these
problems right for the booking/photo-upload flow.

## 1. Authentication: Supabase Auth

- Admin users must authenticate via Supabase Auth (email/password or magic
  link — either is acceptable; a decision for whoever builds Phase 2).
- There must be no admin-accessible page or API route reachable without a
  valid, current Supabase Auth session. Not "hidden," not "unlinked" —
  actually enforced.
- No hardcoded admin password, shared secret link, or "obscure URL" auth
  substitute. Those are not authentication.

## 2. Server-side enforcement, not client-side gating

- Every admin-only page and every admin-only API route must check the
  caller's session **on the server**, on every request.
- A client-side check (hiding a nav link, redirecting in JS if no session is
  found in local storage, etc.) is UX, not security, and must never be the
  only thing standing between an unauthenticated request and admin data.
- Concretely: an admin API route handler must verify the Supabase session
  token itself (e.g. by validating the JWT or calling Supabase to confirm
  the session is live) before doing anything else — before any database
  read, before any response body is built.

## 3. The service-role key must never reach the browser

- This repo already gets this right for the existing endpoints: in
  `api/book.js` and `api/upload-photo.js`, `SUPABASE_SECRET_KEY` is read
  from `process.env` inside a server function and is never sent to, echoed
  to, or reachable from client-side code. **This exact pattern must
  continue for every future admin API route.**
- The service-role key bypasses Row Level Security entirely — if it ever
  ends up in a bundle shipped to the browser, in a public repo, in a client
  console log, or in a URL, that's a full data breach, not a bug to patch
  later. Any admin code that needs elevated DB access does so from a server
  function, the same way the existing endpoints do.
- The browser-facing admin UI should use a Supabase anon key (subject to
  RLS) if it talks to Supabase directly at all, or — preferably, to keep the
  service-role key usage in one well-understood place — go through the
  same kind of server API routes the site already uses, rather than
  granting the browser any direct elevated path.

## 4. Customer/booking data must never be publicly readable

- Confirm (this is a **NEEDS VERIFICATION** item from
  [database-schema.md](./database-schema.md), repeated here because it's
  also a hard security requirement): the `customers`, `bookings`,
  `dumpster_rentals`, and `booking_photos` tables must not be selectable by
  the `anon` Supabase role. If Row Level Security is not already enabled
  and locked down on these tables, that must happen before any admin
  feature is built on top of them — not after.
- The current public-facing endpoints (`/api/book`, `/api/upload-photo`)
  only ever *insert* using the service-role key from the server; they never
  expose a read path to the browser. That property must hold for the
  *entire* site until admin auth exists — no new endpoint should read back
  customer or booking data for an unauthenticated caller, even "just to
  confirm the booking succeeded," even temporarily for debugging.

## 5. Booking photos remain private

- The `booking-photos` storage bucket must not be public and must not have
  a public-read storage policy (this is also flagged as NEEDS VERIFICATION
  in [database-schema.md](./database-schema.md) — someone needs to confirm
  this in the Supabase dashboard, since nothing in the application code
  proves it either way).
- No admin UI should ever construct or display a permanent public URL to a
  photo in this bucket.

## 6. Short-lived signed URLs for viewing photos

- When an admin views a booking's photos, the admin API should generate a
  Supabase Storage **signed URL** (`createSignedUrl`) server-side, scoped to
  that one object, with a short expiry (minutes, not hours/days) — generated
  fresh per view, not cached/reused long-term.
- This mirrors the upload side's existing pattern almost exactly: today,
  `api/book.js` mints a short-lived (30-minute), HMAC-signed, single-purpose
  token (`signUploadToken`) scoped to exactly one booking, which
  `api/upload-photo.js` verifies before allowing an upload
  (`verifyUploadToken`). The read side for admin photo viewing should follow
  the same shape — short-lived, scoped to one resource, verified
  server-side — just using Supabase's own signed-URL mechanism instead of a
  hand-rolled token, since Supabase Storage already provides this natively.

## 7. Authorization on every future admin API route

Every future `/api/admin/*` (or equivalent) route must, before touching any
data:

1. Verify the caller has a valid, current Supabase Auth session (see #2).
2. Verify that session belongs to an authorized admin user — a valid
   session alone is not sufficient if the admin portal is ever opened to
   non-admin authenticated users (e.g. if Supabase Auth is later reused for
   a customer-facing login). For a single-admin/small-team tool, this can be
   as simple as an allowlist of admin user ids/emails checked server-side —
   but it must be checked on every route, not assumed from the session's
   mere existence.
3. Only then perform the requested read/write, scoped to exactly what the
   authenticated request is authorized to see.

No admin route should trust a role/permission flag sent by the client
(query param, request body, or client-set cookie/header) — authorization
must be derived server-side from the verified session, every time.

## 8. Session expiration / logout

- Use Supabase Auth's own session expiry rather than inventing a custom
  one. Keep the session lifetime reasonably short for an admin tool handling
  customer PII (phone numbers, addresses, emails).
- Provide a real logout action that actually invalidates the session
  (Supabase Auth's sign-out call) — not just a client-side "forget the
  token and redirect to login," which would leave the underlying session
  live if the token were somehow replayed.
- Consider what happens on shared/kiosk-style devices if this portal is
  ever used that way: short idle timeout, no "remember me" that outlives a
  reasonable window, etc. (A judgment call for whoever builds Phase 2 based
  on how the business actually plans to use the portal.)

## 9. IDOR protection — a booking ID must never expose another booking

- This is the single most important carry-over lesson from the existing
  code: **never let a client-supplied ID alone authorize access to a
  resource.** `api/upload-photo.js` already demonstrates the right pattern —
  its header comment states explicitly that `booking_id` "is derived ONLY
  from the verified token payload — never trusted from any client-supplied
  field — so a tampered request body can't redirect an upload to a
  different booking."
- Every future admin route that takes a booking id, customer id, or photo
  id (as a URL param, query string, or request body field) must treat that
  id as "which resource is being requested," never as "proof the requester
  is allowed to see it." Authorization comes from the verified admin
  session (see #7), independent of what id was asked for.
- Concretely: changing `?bookingId=abc` to `?bookingId=xyz` in a request
  must never surface a different customer's data to someone who wasn't
  otherwise authorized to see it. Since this is an internal admin tool
  (every authenticated admin can presumably see every booking — there's no
  "customer A's data hidden from customer B" boundary the way there would be
  in a multi-tenant customer-facing app), the practical requirement is
  narrower but still real: an **unauthenticated** or **non-admin**
  request must never reach booking data no matter what id it guesses,
  enumerates, or brute-forces. Sequential/guessable IDs make this worse in
  practice (though `bookings.id` already appears to be a UUID per
  [database-schema.md](./database-schema.md), which helps against blind
  enumeration but is not a substitute for the authorization check itself).

## Explicitly out of scope for this phase

Nothing in this document has been implemented. No Supabase Auth
configuration, no admin route, no signed-URL code, no session handling. This
is the spec Phase 2 should be built and reviewed against.
