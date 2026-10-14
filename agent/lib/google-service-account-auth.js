// Site Improvement Agent, Phase 6 — legacy service-account-KEY auth
// (TIER 3 — optional fallback only, lowest priority).
//
// A minimal OAuth2 "JWT bearer" token exchange (RFC 7523) for read-only
// access to Search Console + GA4 Data API, using only Node's built-in
// `crypto` and global `fetch` — no `googleapis`/`google-auth-library`
// dependency, matching this repo's existing lightweight-fetch style
// (api/reviews.js already calls a Google API, Places, the same way: a
// plain fetch, no SDK).
//
// AUTH-HARDENING UPDATE (Phase 6 follow-up): this module is no longer
// the only, or the preferred, way to authenticate — see
// agent/lib/google-auth.js for the unified resolver every client now
// actually imports. This file is kept ONLY as an optional, explicit,
// lowest-priority fallback (`GOOGLE_SERVICE_ACCOUNT_JSON`), because:
//   1. The org's `iam.disableServiceAccountKeyCreation` policy means a
//      long-lived key for mile-high-site-agent@... cannot be created in
//      the first place — this module's env var is realistically unused
//      for THIS service account going forward.
//   2. It's still useful compatibility for a differently-governed
//      project/service-account that doesn't have that policy, or for
//      tests — so it is kept working, never required.
// `signAndExchangeServiceAccountKey()` below is also reused by
// agent/lib/google-adc.js for the (rare) case of an ADC credential FILE
// that happens to be a service-account key rather than a human's
// `gcloud auth application-default login` refresh token — one signing
// implementation, not two.
//
// Fails safe exactly like api/_lib/supabase-admin.js's getServiceClient():
// missing/invalid configuration returns {skipped:true, reason}, never
// throws — so a Site Improvement Agent run (or the separate, explicit
// --fetch-firstparty CLI step — see firstparty-fetch.js) can never be
// taken down by a missing credential.

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
 * Signs a JWT for `serviceAccount` and exchanges it for a short-lived
 * access token — the one place this (long-lived-key-based) exchange is
 * implemented, reused by both this module's own getAccessToken() below
 * (TIER 3, `GOOGLE_SERVICE_ACCOUNT_JSON` env var) and
 * agent/lib/google-adc.js's handling of a "service_account"-typed ADC
 * credential FILE — one implementation, not two. Returns ONLY
 * {skipped, accessToken, expiresInSeconds, source} on success — never
 * echoes any field of `serviceAccount` (private_key included) back to
 * the caller.
 * @param {object} serviceAccount - a parsed service-account key object ({client_email, private_key, ...})
 * @param {string} scope - a single OAuth scope string
 * @param {function} [fetchImpl] - injectable for tests; defaults to global fetch
 */
async function signAndExchangeServiceAccountKey(serviceAccount, scope, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const assertion = signJwt(serviceAccount, scope);
    const res = await f(TOKEN_ENDPOINT, {
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
    return { skipped: false, accessToken: body.access_token, expiresInSeconds: body.expires_in || 3600, source: "service-account-key" };
  } catch (e) {
    return { skipped: true, reason: `Google OAuth token exchange error: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Exchanges the configured (GOOGLE_SERVICE_ACCOUNT_JSON env var) service
 * account for a short-lived access token scoped to exactly one OAuth
 * scope. Never caches across calls and never attempts a network call at
 * all when unconfigured. TIER 3 — see agent/lib/google-auth.js for the
 * resolver that only reaches this when Phase 6's auth-hardening update's
 * preferred keyless tiers (impersonation, direct ADC) aren't configured.
 * @param {string} scope - a single OAuth scope string
 * @param {object} [options]
 * @param {function} [options.fetchImpl] - injectable for tests; defaults to global fetch
 */
async function getAccessToken(scope, options = {}) {
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    return { skipped: true, reason: "GOOGLE_SERVICE_ACCOUNT_JSON not configured or invalid — first-party evidence not available" };
  }
  return signAndExchangeServiceAccountKey(serviceAccount, scope, options.fetchImpl);
}

module.exports = { getAccessToken, signAndExchangeServiceAccountKey, isGoogleServiceAccountConfigured, loadServiceAccount, TOKEN_ENDPOINT };
