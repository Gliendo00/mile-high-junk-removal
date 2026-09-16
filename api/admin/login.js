// Vercel serverless function — proxies admin login to Supabase Auth.
//
// The browser never talks to Supabase Auth directly and never sees the
// Supabase anon key: it just POSTs { email, password } to this endpoint.
// This endpoint uses the anon key server-side to perform the password
// grant, then — only if the resulting user's email is on the
// ADMIN_ALLOWED_EMAILS allowlist — stores the session in httpOnly cookies
// and responds. See api/_lib/admin-auth.js for the full architecture.
//
// Required environment variables:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY — the project's public anon/publishable key (Supabase
//     dashboard -> Settings -> API). Safe by design even if it were exposed
//     to a browser (it's meant to be), but this endpoint doesn't expose it
//     either way. This is a NEW env var for Phase 2 — see
//     docs/phase-2/auth-architecture.md for exactly what to configure.
//   ADMIN_ALLOWED_EMAILS — comma-separated list of the only email addresses
//     allowed to use the admin portal.
const { getAnonClient, isAllowedAdminEmail, setSessionCookies } = require("../_lib/admin-auth");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

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
};
