// Shared authentication/authorization helper for every /api/admin/* route.
// This is the single place that decides "is this caller allowed to see
// admin data" — every admin route calls requireAdmin() first and does
// nothing else until it returns a session.
//
// Architecture (see docs/phase-2/auth-architecture.md for the full writeup):
//   - Login (api/admin/login.js) proxies email+password to Supabase Auth
//     using the ANON key, server-side only. The anon key never reaches the
//     browser — the login page just POSTs credentials to our own endpoint.
//   - On success, the session (access + refresh token) is stored in two
//     httpOnly, Secure, SameSite=Lax cookies. httpOnly means client-side JS
//     (including an XSS payload) cannot read them — only the browser can
//     send them back to us automatically.
//   - Every admin API route verifies the access token against Supabase Auth
//     itself (getAdminSession -> supabase.auth.getUser(token)), not by
//     locally decoding the JWT. If the access token is expired, a valid
//     refresh token is used to mint a new one (rotating the stored cookie),
//     so a mobile session doesn't die every hour. If neither is valid, this
//     fails closed: no session, no data, no exception.
//   - Being a valid Supabase Auth user is NOT enough by itself — the
//     caller's email must also be in ADMIN_ALLOWED_EMAILS. This is what
//     stops a stray/compromised Supabase Auth signup (there is no public
//     signup UI in this app, but nothing stops someone from calling
//     Supabase's signup API directly) from ever reaching booking data.
//   - Actual data queries use the SERVICE-ROLE key (see
//     api/_lib/supabase-admin.js), but only ever after requireAdmin()
//     succeeds. The service-role key is never used to answer a request from
//     an unauthenticated or non-admin caller.

const { createClient } = require("@supabase/supabase-js");

const ACCESS_COOKIE = "mhjr_admin_at";
const REFRESH_COOKIE = "mhjr_admin_rt";
const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days — a cap on how long the cookie lingers in the browser; the actual refresh-token lifetime is governed by the Supabase project's Auth settings (NEEDS VERIFICATION, see docs/phase-2/auth-architecture.md)

// A client authorized only as the anonymous/public role, used exclusively
// for auth operations (sign in, verify a token, refresh, sign out) — never
// for querying booking/customer data. Every call site creates its own
// instance rather than sharing one module-level client, since a Vercel
// serverless function is stateless per invocation and this avoids any risk
// of one request's session bleeding into another's.
function getAnonClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  header.split(";").forEach(function (part) {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

// Comma-separated list of the only email addresses allowed to use the admin
// portal, configured via the ADMIN_ALLOWED_EMAILS environment variable
// (never hardcoded — see docs/phase-2/auth-architecture.md for how to set
// it). Comparison is case-insensitive; Supabase itself normalizes emails to
// lowercase, but this doesn't rely on that.
function isAllowedAdminEmail(email) {
  const raw = process.env.ADMIN_ALLOWED_EMAILS || "";
  const list = raw
    .split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  return !!email && list.indexOf(String(email).toLowerCase()) !== -1;
}

function cookieAttrs(req, maxAgeSeconds) {
  // Secure cookies require HTTPS. Production/preview Vercel traffic is
  // always HTTPS (fronted by Vercel's proxy, which sets this header) — the
  // only case this is ever "http" is a plain local dev server, where
  // Secure would silently prevent the browser from storing the cookie at
  // all. VERCEL_ENV is unset outside of Vercel's own environments, so a
  // fully local `node` run (e.g. this repo's test suite) also takes the
  // non-secure branch, which is correct there since there's no HTTPS to
  // require.
  const proto = req.headers["x-forwarded-proto"];
  const isSecure = proto ? proto === "https" : process.env.VERCEL_ENV !== undefined;
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (isSecure) attrs.push("Secure");
  if (typeof maxAgeSeconds === "number") attrs.push("Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds)));
  return attrs.join("; ");
}

function appendSetCookie(res, newCookies) {
  const existing = res.getHeader ? res.getHeader("Set-Cookie") : null;
  const combined = existing ? (Array.isArray(existing) ? existing : [existing]).concat(newCookies) : newCookies;
  res.setHeader("Set-Cookie", combined);
}

// session is a Supabase Auth session object: { access_token, refresh_token,
// expires_in, ... }. Called both on login and whenever getAdminSession()
// silently refreshes an expired access token.
function setSessionCookies(req, res, session) {
  const accessMaxAge = typeof session.expires_in === "number" ? session.expires_in : 3600;
  appendSetCookie(res, [
    ACCESS_COOKIE + "=" + encodeURIComponent(session.access_token) + "; " + cookieAttrs(req, accessMaxAge),
    REFRESH_COOKIE + "=" + encodeURIComponent(session.refresh_token) + "; " + cookieAttrs(req, REFRESH_COOKIE_MAX_AGE_SECONDS),
  ]);
}

function clearSessionCookies(req, res) {
  appendSetCookie(res, [
    ACCESS_COOKIE + "=; " + cookieAttrs(req, 0),
    REFRESH_COOKIE + "=; " + cookieAttrs(req, 0),
  ]);
}

// Verifies the caller's session server-side and checks the admin allowlist.
// Returns { email, accessToken } on success. Returns null on EVERY failure
// mode — missing cookies, an invalid/expired/tampered access token, a
// failed refresh, or a real-but-non-admin Supabase user — so callers always
// respond identically (401) regardless of which of these actually happened.
// That's deliberate: telling an attacker "your token parsed fine but you're
// not an admin" vs. "that token is garbage" leaks information for free.
async function getAdminSession(req, res) {
  const anon = getAnonClient();
  if (!anon) {
    console.error("Admin auth misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY not set");
    return null;
  }

  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  if (!accessToken && !refreshToken) return null;

  if (accessToken) {
    let got;
    try {
      got = await anon.auth.getUser(accessToken);
    } catch (err) {
      got = { error: err };
    }
    if (!got.error && got.data && got.data.user) {
      const email = got.data.user.email;
      if (!isAllowedAdminEmail(email)) return null;
      return { email: email, accessToken: accessToken };
    }
  }

  if (!refreshToken) return null;

  // Access token missing/invalid/expired — try the refresh token so a
  // mobile session doesn't die mid-shift every time the access token's
  // ~1-hour lifetime elapses. If the refresh token is itself
  // invalid/expired/revoked (e.g. after logout), this fails closed.
  let refreshed;
  try {
    refreshed = await anon.auth.refreshSession({ refresh_token: refreshToken });
  } catch (err) {
    refreshed = { error: err };
  }
  if (refreshed.error || !refreshed.data || !refreshed.data.session || !refreshed.data.user) {
    return null;
  }

  const refreshedEmail = refreshed.data.user.email;
  if (!isAllowedAdminEmail(refreshedEmail)) return null;

  // Supabase rotates the refresh token on every use — the one just spent is
  // now invalid. Persisting the new pair here is required, not optional:
  // without it, the *next* request's refresh attempt would present an
  // already-used refresh token and fail.
  setSessionCookies(req, res, refreshed.data.session);
  return { email: refreshedEmail, accessToken: refreshed.data.session.access_token };
}

// Call at the top of every /api/admin/* route (login/logout excepted, since
// they run before or outside of a session). Sends 401 and returns null if
// the caller isn't an authenticated, allowlisted admin; otherwise returns
// the session and the route may proceed. Always marks the response
// no-store, since every admin API response — including 401s — carries
// nothing that should ever be cached by a shared/browser cache.
async function requireAdmin(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = await getAdminSession(req, res);
  if (!session) {
    res.status(401).json({ error: "Not authenticated." });
    return null;
  }
  return session;
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  getAnonClient,
  parseCookies,
  isAllowedAdminEmail,
  setSessionCookies,
  clearSessionCookies,
  getAdminSession,
  requireAdmin,
};
