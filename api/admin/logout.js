// Vercel serverless function — logs an admin out.
//
// This does two things, both required: it asks Supabase Auth to actually
// invalidate the session server-side (auth.signOut(), after hydrating a
// throwaway client with the caller's own tokens via setSession()), and it
// clears the cookies regardless of whether that call succeeds. Only
// clearing the cookie would leave the underlying Supabase session live —
// if the access token were somehow captured before logout, it would keep
// working until it naturally expired.
const { getAnonClient, parseCookies, clearSessionCookies, ACCESS_COOKIE, REFRESH_COOKIE } = require("../_lib/admin-auth");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

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
};
