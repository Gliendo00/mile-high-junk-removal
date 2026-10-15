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
// credential at all) is intentionally NOT implemented yet: there is no
// WIF pool/provider configured for this project today, and reimplementing
// the STS token-exchange protocol for a feature nobody can use yet would
// be exactly the overbuilding this phase was asked to avoid. It fails
// honestly with a clear "not yet supported" reason — see
// agent/README.md's Phase 6 auth-hardening section for the documented
// upgrade path once/if an external identity provider is ever wired up.
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
      return {
        skipped: true,
        reason:
          'ADC credential file is a Workload Identity Federation ("external_account") config — not yet supported by this agent (see agent/README.md\'s Phase 6 auth-hardening section for the planned upgrade path)',
      };
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
