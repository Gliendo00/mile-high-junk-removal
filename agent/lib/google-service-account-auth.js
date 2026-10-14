// Site Improvement Agent, Phase 6 — shared Google service-account auth.
//
// A minimal OAuth2 "JWT bearer" token exchange (RFC 7523) for read-only
// access to Search Console + GA4 Data API, using only Node's built-in
// `crypto` and global `fetch` — no `googleapis`/`google-auth-library`
// dependency, matching this repo's existing lightweight-fetch style
// (api/reviews.js already calls a Google API, Places, the same way: a
// plain fetch, no SDK — see agent/README.md's Phase 6 credentials section
// for why a second pattern wasn't introduced).
//
// Fails safe exactly like api/_lib/supabase-admin.js's getServiceClient():
// missing/invalid configuration returns {skipped:true, reason}, never
// throws — so a Site Improvement Agent run (or the separate, explicit
// --fetch-firstparty CLI step — see firstparty-fetch.js) can never be
// taken down by a missing credential.
//
// One service account, one credential, two scopes — the smallest secure
// model for two read-only Google integrations (see agent/README.md's
// Phase 6 "Credentials" section for required Google Cloud / Search
// Console / GA4 setup steps; NOT configured in this environment).

const crypto = require("crypto");

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function isGoogleServiceAccountConfigured() {
  return loadServiceAccount() !== null;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signJwt(serviceAccount, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  const encodedSignature = signature
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${unsigned}.${encodedSignature}`;
}

/**
 * Exchanges the configured service account for a short-lived access token
 * scoped to exactly one OAuth scope. Never caches across calls (a Site
 * Improvement Agent fetch step is a short-lived CLI invocation, not a long
 * running server — see firstparty-fetch.js) and never attempts a network
 * call at all when unconfigured.
 * @param {string} scope - a single OAuth scope string
 * @param {object} [options]
 * @param {function} [options.fetchImpl] - injectable for tests; defaults to global fetch
 */
async function getAccessToken(scope, options = {}) {
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    return { skipped: true, reason: "GOOGLE_SERVICE_ACCOUNT_JSON not configured or invalid — first-party evidence not available" };
  }

  const fetchImpl = options.fetchImpl || fetch;
  try {
    const assertion = signJwt(serviceAccount, scope);
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const body = await res.json();
    if (!res.ok || !body || !body.access_token) {
      const reason = (body && (body.error_description || body.error)) || `HTTP ${res.status}`;
      return { skipped: true, reason: `Google OAuth token exchange failed: ${reason}` };
    }
    return { skipped: false, accessToken: body.access_token, expiresInSeconds: body.expires_in || 3600 };
  } catch (e) {
    return { skipped: true, reason: `Google OAuth token exchange error: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { getAccessToken, isGoogleServiceAccountConfigured, loadServiceAccount, TOKEN_ENDPOINT };
