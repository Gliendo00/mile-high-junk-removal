# Phase 2 Security Review

Self-review against the nine specific areas requested, before deployment.

## 1. Authentication bypass

- Every `/api/admin/bookings` and `/api/admin/booking` request calls
  `requireAdmin()` as its literal first line — verified by reading both
  files; there is no code path in either that reaches a Supabase data query
  before that call returns a session.
- `requireAdmin()` fails closed: any error, missing cookie, invalid token,
  failed refresh, or non-allowlisted email all return `null` → 401. There is
  no default-allow branch.
- Tested directly: `tests/phase2-admin-api.test.js` — "no cookies at all",
  "garbage/forged access token", "valid token but non-allowlisted email",
  and "expired access token + invalid refresh token" all assert 401.

## 2. IDOR (insecure direct object reference)

- `api/admin/booking.js`'s `id` query param determines *which* booking is
  requested, never *whether* the request is authorized — `requireAdmin()`
  runs first and unconditionally, before the `id` param is even read.
- Because this is a single-tier internal admin tool (any authenticated,
  allowlisted admin is authorized to see any booking — there's no
  per-customer scoping the way a multi-tenant app would need), the
  practical IDOR requirement is exactly "an unauthenticated or
  non-allowlisted caller must never reach booking data no matter what id it
  guesses" — satisfied by point 1 above, since the id is never consulted
  until after that gate passes.
- Malformed ids (e.g. a SQL-injection-shaped string) never reach the
  database at all — a regex format check runs before any query, and a
  non-matching value is treated as an immediate 404. Tested directly:
  `"booking detail: malformed id -> safe 404 (never reaches the database)"`.
- A well-formed but nonexistent UUID gets a generic 404, not a 500 or a
  different error shape that might hint at existence-vs-format issues.

## 3. Service-role secret leakage

- `SUPABASE_SECRET_KEY` is read only inside `api/_lib/supabase-admin.js`
  and only ever passed to `createClient()` — never interpolated into a
  string, logged, or included in a response body anywhere in the new code.
- Grepped the entire admin client-side surface
  (`admin/*.html`, `admin/*.js`) for the literal env var name and for any
  Supabase key material: no matches.
- Automated regression guard: `tests/phase2-admin-api.test.js`'s "no admin
  API response ever contains the service-role key or anon key values" test
  asserts this against the actual JSON response bodies from login,
  bookings-list, and booking-detail, not just by code inspection.

## 4. Session/cookie security

- Cookies are `HttpOnly` (unreadable by any JS, including an XSS payload),
  `Secure` (HTTPS-only — verified conditional logic in
  `cookieAttrs()` for the one legitimate exception, plain-http local dev),
  and `SameSite=Lax` (not sent on cross-site subresource loads, only
  top-level navigation — see the CSRF discussion in
  [auth-architecture.md](./auth-architecture.md)).
- Tokens are verified against Supabase itself on every request, not
  trusted from a locally-decoded/unverified JWT.
- Logout revokes the underlying Supabase session (not just a client-side
  cookie clear) — see `api/admin/logout.js`.
- **Known gap, not addressed this phase:** there is no server-side
  "list/revoke other active sessions" capability — if a device is lost
  while still logged in, the only recourse today is changing the password
  in the Supabase dashboard (which invalidates existing refresh tokens) or
  waiting out the access-token expiry. Reasonable for a first version;
  worth revisiting if the portal is used on multiple/shared devices.

## 5. XSS from customer-supplied booking descriptions / names / addresses

- Every dynamic value in `admin/dashboard.js` and `admin/booking-detail.js`
  is written via `textContent` (never `innerHTML`/`insertAdjacentHTML`/
  `document.write` with a concatenated string). Automated regression guard:
  `tests/phase2-admin-api.test.js`'s static-analysis test greps both files
  for those patterns and fails the suite if one is ever introduced.
- **Manually verified in a real browser** (not just statically): a
  temporary local harness (not part of the committed app — created,
  screenshotted, and deleted during this session) fed the dashboard a
  mocked API response where the client's first name, city, service label,
  and time-window label were all classic XSS payloads
  (`<img src=x onerror=...>`, `<script>...</script>`, `"><svg onload=...>`).
  Confirmed in the live DOM: the payloads rendered as literal visible text,
  zero `<img>`/`<script>` elements were created by the render, and the
  probe function they all tried to call never fired
  (`window.__xssFired === false`). Screenshot taken as evidence.
- Links (`tel:`, `mailto:`, Google Maps) are built from plain string
  concatenation into the `.href` *property* (not an HTML attribute string),
  and the phone number's `tel:` href specifically strips everything but
  digits before use — mirroring the existing safe-href pattern already used
  server-side in `api/book.js`'s admin notification email.

## 6. Signed photo URL exposure/lifetime

- URLs are minted by `api/admin/booking.js` via
  `supabase.storage.from("booking-photos").createSignedUrl(path, 300)` — a
  5-minute expiry, generated fresh on every request, never cached or
  persisted anywhere (not in the database, not in a response cache).
- Confirmed a signed URL is only ever generated after `requireAdmin()`
  succeeds: `tests/phase2-admin-api.test.js`'s "signed URLs are only
  generated after authentication succeeds" test asserts the mock storage
  client recorded **zero** signing calls for an unauthenticated request to
  the same booking id, then exactly one for the authenticated retry.
- The response never includes the raw `storage_path` — only the ephemeral
  signed URL (or `null` if signing failed for that one photo) — so a client
  can't reconstruct a durable reference to the object.

## 7. Cache headers on private API responses

- `requireAdmin()` sets `Cache-Control: no-store` before doing anything
  else, so it applies uniformly to every outcome (200, 401, or a later 500)
  from every route that calls it. `api/admin/login.js` and
  `api/admin/logout.js` set it explicitly too, since they run before/
  outside of `requireAdmin()`.
- No admin route sets any competing cache header (`Cache-Control: public`,
  `ETag`, etc.) that could override this.

## 8. Error responses accidentally leaking database information

- Every Supabase query error in `api/admin/bookings.js` and
  `api/admin/booking.js` is caught, logged server-side with
  `console.error` (visible only in Vercel's function logs, never in the
  response), and answered with one generic `{ error: "Could not load
  bookings." }` / `{ error: "Could not load booking." }` — never the raw
  Postgres/PostgREST error object, which could otherwise reveal column
  names, constraint names, or query structure.
- The 404-vs-400 distinction for booking ids (see point 2) was deliberately
  designed so a malformed id and a well-formed-but-missing id both look
  like "not found" from the outside, never confirming which validation
  layer rejected the request.
- Login's error message is identical (`"Invalid email or password."`)
  whether the email doesn't exist, the password is wrong, or the account
  is real but not an allowlisted admin — see
  [auth-architecture.md](./auth-architecture.md).

## 9. Additional note: robots/indexing

Not one of the nine requested review areas, but related to keeping the
portal's existence unadvertised: every admin page carries `<meta
name="robots" content="noindex, nofollow">` and `robots.txt` now disallows
`/admin`. **This is hygiene, not a security control** — it doesn't stop a
targeted request, only discourages search engines from indexing the login
page. The actual security boundary is entirely server-side authentication,
per points 1–8 above.
