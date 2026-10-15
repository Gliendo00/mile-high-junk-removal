// Site Improvement Agent, Phase 6 auth-hardening — Application Default
// Credentials (ADC) loader: Google's standard KEYLESS credential
// discovery, reimplemented with plain `fs`/`fetch` (no
// `googleapis`/`google-auth-library` dependency — same posture as every
// other Google integration in this agent). Used as:
//   - the BASE identity for service-account impersonation
//     (agent/lib/google-impersonation.js) — the preferred path, see
//     agent/lib/google-auth.js's header; or
//   - directly, where practical (see this file's own notes on scope
//     limitations below).
//
// Discovery order (matches Google's own ADC convention):
//   1. GOOGLE_APPLICATION_CREDENTIALS env var -> a credential file path.
//   2. The well-known file `gcloud auth application-default login`
//      writes — Windows: %APPDATA%\gcloud\application_default_credentials.json;
//      else ~/.config/gcloud/application_default_credentials.json.
//   3. The GCE/Cloud Run metadata server — only reachable when actually
//      running ON Google Cloud compute; zero configuration needed there.
//
// Two credential FILE types are understood:
//   - "authorized_user" — a human's own `gcloud auth application-default
//     login` (a refresh token tied to THEIR identity, never a service-
//     account key). Its scope was fixed at login time (gcloud's default:
//     cloud-platform + userinfo.email) and cannot be narrowed per
//     request — fine as the BASE token for impersonation (which only
//     needs cloud-platform scope to call the IAM Credentials API), but
//     only useful DIRECTLY against Search Console/GA4 if that login
//     explicitly included their scopes via `gcloud auth
//     application-default login --scopes=...`.
//   - "service_account" — a key file (kept for parity with
//     GOOGLE_SERVICE_ACCOUNT_JSON — still optional, still not required;
//     reuses google-service-account-auth.js's signer, one implementation).
// A third type, "external_account" (Workload Identity Federation — e.g.
// a GitHub Actions OIDC identity federated into GCP with no Google
// credential at all) IS now implemented, but only the one concrete shape
// `google-github-actions/auth` actually writes when given a
// `workload_identity_provider` with NO `service_account` input: a
// URL-sourced credential (`credential_source.url`/`.headers`, JSON
// format with a `subject_token_field_name`). That shape is fetched for
// a fresh subject token (the short-lived GitHub Actions OIDC JWT — must
// be re-fetched per resolution, never cached, since GitHub's own token
// is only valid for a few minutes) and exchanged via RFC 8693 token
// exchange against the file's own `token_url` (Google's STS endpoint)
// for a `cloud-platform`-scoped ADC-equivalent token for the FEDERATED
// identity itself — see exchangeExternalAccountToken() below. This is
// deliberately the BASE identity only, exactly like an "authorized_user"
// file: it still needs GOOGLE_IMPERSONATE_SERVICE_ACCOUNT (resolved by
// google-auth.js, tier 1) to actually mint a scope-specific
// (webmasters.readonly/analytics.readonly) token for
// mile-high-site-agent@... — the federated identity is granted
// `roles/iam.workloadIdentityUser` on that service account, the exact
// same shape of grant a human's ADC identity needs
// (roles/iam.serviceAccountTokenCreator is requested indirectly via that
// impersonation call), never direct API scopes of its own. A
// file-sourced (`credential_source.file`) or non-JSON-format external_
// account config is NOT implemented (no such shape exists anywhere in
// this project's intended CI) and fails honestly rather than guessing at
// its handling.
//
// NEVER logs anything, and the only data this module ever returns is
// {skipped, accessToken, expiresInSeconds, source} (or a skip reason
// string) — it never echoes a credential file's own secret fields
// (refresh_token/private_key/client_secret) back to any caller. See
// tests/agent-google-adc.test.js's "no credential material leaks" tests.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { signAndExchangeServiceAccountKey } = require("./google-service-account-auth");

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STS_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const STS_REQUESTED_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const METADATA_TOKEN_ENDPOINT = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
// Short — a non-GCP machine (e.g. this Windows dev box) has no route to
// this hostname at all, but a bounded timeout keeps a slow/odd network
// environment from ever making a real fetch attempt feel like a hang.
const METADATA_SERVER_TIMEOUT_MS = 1000;

function wellKnownAdcPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, "gcloud", "application_default_credentials.json") : null;
  }
  return path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

function resolveAdcFilePath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return wellKnownAdcPath();
}

/**
 * Synchronous, network-free "is a credential FILE present" check — used
 * only for report-display purposes (search-console-client.js/
 * ga4-client.js's isXConfigured(), surfaced in report.firstPartyEvidence
 * .integrations). Deliberately does NOT probe the metadata server (that
 * needs a real network call, which the deterministic runner must never
 * make — see agent/runner.js's header) — a true positive there is only
 * ever discovered lazily, inside getAdcAccessToken() itself, when a real
 * fetch is actually attempted by the separate --fetch-firstparty step.
 */
function isAdcFileConfigured() {
  const filePath = resolveAdcFilePath();
  return Boolean(filePath && fs.existsSync(filePath));
}

function readAdcFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

async function exchangeAuthorizedUserRefreshToken(credential, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const res = await f(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        refresh_token: credential.refresh_token,
      }).toString(),
    });
    const body = await res.json();
    if (!res.ok || !body || !body.access_token) {
      const reason = (body && (body.error_description || body.error)) || `HTTP ${res.status}`;
      return { skipped: true, reason: `ADC (authorized_user) token refresh failed: ${reason}` };
    }
    return { skipped: false, accessToken: body.access_token, expiresInSeconds: body.expires_in || 3600, source: "adc-authorized-user" };
  } catch (e) {
    return { skipped: true, reason: `ADC (authorized_user) token refresh error: ${e && e.message ? e.message : String(e)}` };
  }
}

// Fetches the subject token for a URL-sourced "external_account"
// credential_source — the shape `google-github-actions/auth` writes for
// GitHub Actions: a GET to `credential_source.url` (GitHub's own
// short-lived OIDC token-request endpoint, pre-bound with the right
// `audience`) carrying `credential_source.headers` (the bearer token
// GitHub's Actions runtime issued for THIS job step only), returning a
// JSON body whose `credential_source.format.subject_token_field_name`
// field (GitHub's convention: "value") is the actual OIDC JWT. Returns
// `{token}` or `{error}` — never throws, never logs either the header
// or the fetched token.
async function fetchExternalAccountSubjectToken(credentialSource, fetchImpl) {
  const f = fetchImpl || fetch;
  const format = credentialSource.format || { type: "json", subject_token_field_name: "value" };
  if (format.type && format.type !== "json") {
    return { error: `credential_source.format.type "${format.type}" is not supported (only a JSON-formatted subject token is)` };
  }
  const fieldName = format.subject_token_field_name || "value";
  try {
    const res = await f(credentialSource.url, { headers: credentialSource.headers || {} });
    if (!res.ok) {
      return { error: `subject-token request failed: HTTP ${res.status}` };
    }
    const body = await res.json();
    const token = body && body[fieldName];
    if (!token) {
      return { error: `subject-token response had no "${fieldName}" field` };
    }
    return { token };
  } catch (e) {
    return { error: `subject-token request error: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Resolves a base access token for a Workload Identity Federation
 * ("external_account") ADC credential file — see this file's header for
 * exactly which shape is supported (URL-sourced, JSON format; e.g.
 * `google-github-actions/auth`'s GitHub Actions output). Two network
 * calls, in order: (1) fetch a fresh subject token from
 * `credential_source.url` (never cached — GitHub's OIDC token is only
 * valid briefly), (2) RFC 8693 token exchange against the file's own
 * `token_url` (Google's STS endpoint) for a token scoped to `scope`,
 * representing the FEDERATED identity itself (see google-auth.js's
 * header on why that identity still needs
 * GOOGLE_IMPERSONATE_SERVICE_ACCOUNT to reach the target service
 * account). Never thrown; degrades to {skipped:true, reason}. Neither
 * the fetched subject token nor any request header is ever included in
 * the returned result.
 * @param {object} credential - a parsed "external_account" ADC credential file
 * @param {string} scope - the OAuth scope the exchanged token should carry
 * @param {function} [fetchImpl] - injectable for tests
 */
async function exchangeExternalAccountToken(credential, scope, fetchImpl) {
  const source = credential.credential_source;
  if (!source || !source.url) {
    return {
      skipped: true,
      reason:
        'ADC credential file is a Workload Identity Federation ("external_account") config with no URL-sourced credential_source — only that shape (e.g. GitHub Actions OIDC, as written by google-github-actions/auth) is supported',
    };
  }
  if (!credential.token_url || !credential.audience) {
    return { skipped: true, reason: 'ADC credential file ("external_account") is missing a required "token_url"/"audience" field' };
  }
  if (!scope) {
    return { skipped: true, reason: 'ADC (external_account) token exchange requires an OAuth scope, none was requested' };
  }

  const subject = await fetchExternalAccountSubjectToken(source, fetchImpl);
  if (subject.error) {
    return { skipped: true, reason: `ADC (external_account) ${subject.error}` };
  }

  const f = fetchImpl || fetch;
  try {
    const res = await f(credential.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: STS_GRANT_TYPE,
        audience: credential.audience,
        scope,
        requested_token_type: STS_REQUESTED_TOKEN_TYPE,
        subject_token: subject.token,
        subject_token_type: credential.subject_token_type || "urn:ietf:params:oauth:token-type:jwt",
      }).toString(),
    });
    const body = await res.json();
    if (!res.ok || !body || !body.access_token) {
      const reason = (body && (body.error_description || body.error)) || `HTTP ${res.status}`;
      return { skipped: true, reason: `ADC (external_account) STS token exchange failed: ${reason}` };
    }
    return { skipped: false, accessToken: body.access_token, expiresInSeconds: body.expires_in || 3600, source: "adc-external-account" };
  } catch (e) {
    return { skipped: true, reason: `ADC (external_account) STS token exchange error: ${e && e.message ? e.message : String(e)}` };
  }
}

async function fetchMetadataServerToken(scope, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const url = scope ? `${METADATA_TOKEN_ENDPOINT}?scopes=${encodeURIComponent(scope)}` : METADATA_TOKEN_ENDPOINT;
    const res = await f(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(METADATA_SERVER_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) {
      return { skipped: true, reason: `GCE/Cloud Run metadata server token request failed: HTTP ${res.status}` };
    }
    const body = await res.json();
    if (!body || !body.access_token) {
      return { skipped: true, reason: "GCE/Cloud Run metadata server returned no access token" };
    }
    return { skipped: false, accessToken: body.access_token, expiresInSeconds: body.expires_in || 3600, source: "adc-metadata-server" };
  } catch (e) {
    return { skipped: true, reason: `Metadata server unreachable — not running on GCP compute (${e && e.message ? e.message : String(e)})` };
  }
}

/**
 * Resolves a short-lived access token from Application Default
 * Credentials. Tries, in order: a credential FILE (GOOGLE_APPLICATION_
 * CREDENTIALS, else the well-known gcloud path), then the GCE/Cloud Run
 * metadata server. Never thrown — degrades to {skipped:true, reason}.
 * @param {string} [scope] - requested OAuth scope. Honored by the
 *   metadata-server path (its `?scopes=` param) and a "service_account"
 *   file (a real JWT scope claim) — an "authorized_user" refresh
 *   token's scope was fixed at login time and cannot be narrowed here
 *   (see this file's header).
 * @param {object} [options]
 * @param {function} [options.fetchImpl] - injectable for tests
 */
async function getAdcAccessToken(scope, options = {}) {
  const fetchImpl = options.fetchImpl;
  const filePath = resolveAdcFilePath();

  if (filePath && fs.existsSync(filePath)) {
    const credential = readAdcFile(filePath);
    if (!credential || typeof credential !== "object") {
      return { skipped: true, reason: `ADC credential file at "${filePath}" could not be read/parsed` };
    }
    if (credential.type === "authorized_user") {
      return exchangeAuthorizedUserRefreshToken(credential, fetchImpl);
    }
    if (credential.type === "service_account") {
      return signAndExchangeServiceAccountKey(credential, scope, fetchImpl);
    }
    if (credential.type === "external_account") {
      return exchangeExternalAccountToken(credential, scope, fetchImpl);
    }
    return { skipped: true, reason: `ADC credential file at "${filePath}" has an unrecognized type "${credential && credential.type}"` };
  }

  // No file — only the metadata server is left, and it only answers
  // when actually running on Google Cloud compute.
  return fetchMetadataServerToken(scope, fetchImpl);
}

module.exports = {
  getAdcAccessToken,
  isAdcFileConfigured,
  resolveAdcFilePath,
  wellKnownAdcPath,
};
