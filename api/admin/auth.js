// Vercel serverless function — admin session lifecycle: login and logout.
// Consolidated from the former api/admin/login.js + api/admin/logout.js
// into one file (Phase 3C Stage 2.5-v2) specifically to stay within the
// Vercel Hobby plan's 12-Serverless-Function-per-deployment ceiling while
// adding api/braintree-webhook.js — see
// docs/phase-3/stage2.5-rental-payments-v2-proposal.md §5 and
// docs/phase-3/vercel-function-limit.md for the constraint this responds
// to. This is a legitimate single-concern merge (both were already tiny,
// both were already POST-only, both are exactly "manage this admin's
// session") — not a generic do-everything endpoint.
//
// Both original URLs keep working with ZERO frontend changes: vercel.json
// rewrites /api/admin/login -> /api/admin/auth?action=login and
// /api/admin/logout -> /api/admin/auth?action=logout, so every existing
// `fetch('/api/admin/login', ...)` / `fetch('/api/admin/logout', ...)` call
// site across the admin pages is untouched.
//
// Each branch below is byte-for-byte the same logic the two original files
// had — this is a relocation, not a rewrite.
//
// Required environment variables:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY — the project's public anon/publishable key (Supabase
//     dashboard -> Settings -> API). Safe by design even if it were exposed
//     to a browser (it's meant to be), but this endpoint doesn't expose it
//     either way.
//   ADMIN_ALLOWED_EMAILS — comma-separated list of the only email addresses
//     allowed to use the admin portal.
const { getAnonClient, isAllowedAdminEmail, setSessionCookies, clearSessionCookies, parseCookies, ACCESS_COOKIE, REFRESH_COOKIE } = require("../_lib/admin-auth");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const action = typeof req.query.action === "string" ? req.query.action : "login";
  if (action === "logout") return handleLogout(req, res);
  if (action === "login") return handleLogin(req, res);

  res.status(400).json({ error: "Unknown action." });
};

// Formerly api/admin/login.js. Proxies admin login to Supabase Auth — the
// browser never talks to Supabase Auth directly and never sees the
// Supabase anon key: it just POSTs { email, password } here. This endpoint
// uses the anon key server-side to perform the password grant, then — only
// if the resulting user's email is on the ADMIN_ALLOWED_EMAILS allowlist —
// stores the session in httpOnly cookies and responds.
async function handleLogin(req, res) {
  const anon = getAnonClient();
  if (!anon) {
    console.error("Admin login failed: SUPABASE_URL/SUPABASE_ANON_KEY not configured");
    res.status(500).json({ error: "Admin login is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  let result;
  try {
    result = await anon.auth.signInWithPassword({ email: email, password: password });
  } catch (err) {
    console.error("Admin login failed calling Supabase Auth:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not sign in. Please try again." });
    return;
  }

  // One generic message for every failure reason — wrong password, unknown
  // email, or a real Supabase account that just isn't an allowlisted admin.
  // Distinguishing these in the response would let a caller enumerate valid
  // admin emails for free.
  const genericError = "Invalid email or password.";

  if (result.error || !result.data || !result.data.session || !result.data.user) {
    res.status(401).json({ error: genericError });
    return;
  }

  if (!isAllowedAdminEmail(result.data.user.email)) {
    console.error("Admin login rejected: authenticated Supabase user is not an allowlisted admin (" + result.data.user.email + ")");
    res.status(401).json({ error: genericError });
    return;
  }

  setSessionCookies(req, res, result.data.session);
  res.status(200).json({ ok: true });
}

// Formerly api/admin/logout.js. Does two things, both required: asks
// Supabase Auth to actually invalidate the session server-side
// (auth.signOut(), after hydrating a throwaway client with the caller's own
// tokens via setSession()), and clears the cookies regardless of whether
// that call succeeds. Only clearing the cookie would leave the underlying
// Supabase session live — if the access token were somehow captured before
// logout, it would keep working until it naturally expired.
async function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  const anon = getAnonClient();

  if (anon && accessToken && refreshToken) {
    try {
      await anon.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      await anon.auth.signOut();
    } catch (err) {
      // Best-effort: the cookies are cleared below regardless, so the
      // browser can no longer present this session even if the revoke call
      // itself failed (e.g. Supabase was briefly unreachable).
      console.error("Admin logout: Supabase sign-out call failed (cookies are still cleared):", err && err.stack ? err.stack : err);
    }
  }

  clearSessionCookies(req, res);
  res.status(200).json({ ok: true });
}
