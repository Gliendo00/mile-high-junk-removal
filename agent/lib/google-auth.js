// Site Improvement Agent, Phase 6 auth-hardening — unified Google auth
// resolver. agent/lib/search-console-client.js and agent/lib/ga4-client.js
// both import getAccessToken()/isGoogleAuthConfigured() from HERE now
// (not directly from google-service-account-auth.js anymore) — this is
// the one place that decides which auth mechanism to use.
//
// Three tiers, tried in this fixed priority. Each tier is GATED on its
// own "is this explicitly/discoverably configured" check; once a tier
// is configured, its result (success OR a specific, honest failure) is
// returned DIRECTLY — never silently swapped for a different tier. A
// misconfigured preferred tier fails loudly instead of masking the
// mistake by quietly trying something else.
//
//   1. IMPERSONATION (preferred) — GOOGLE_IMPERSONATE_SERVICE_ACCOUNT is
//      set. Uses ADC (google-adc.js) as the base identity, then
//      google-impersonation.js's generateAccessToken() for a short-lived
//      token scoped to EXACTLY what was requested. No key file, ever —
//      satisfies org policy iam.disableServiceAccountKeyCreation by
//      construction. This is the path BOTH a human on this Windows
//      machine (via one-time `gcloud auth application-default login`)
//      and an eventual unattended orchestrator use.
//   2. DIRECT ADC (keyless, narrower applicability) — no impersonation
//      configured, but an ADC credential FILE is present
//      (GOOGLE_APPLICATION_CREDENTIALS, or the well-known gcloud path).
//      Requests the target scope directly from that credential — only
//      actually succeeds if it already carries the target scope (see
//      google-adc.js's header on authorized_user's fixed login-time
//      scope) — kept because the brief asked for ADC "where practical",
//      but documented honestly as narrower than impersonation.
//   3. LEGACY SERVICE-ACCOUNT KEY (optional fallback, lowest explicit
//      priority) — GOOGLE_SERVICE_ACCOUNT_JSON is set. Kept ONLY for
//      forward/backward compatibility (e.g. a differently-governed
//      project without this org's key-creation policy, or tests) —
//      never required, never the recommended path going forward.
//
// If NONE of the three are explicitly/discoverably configured, there is
// exactly one thing left worth trying: the GCE/Cloud Run metadata
// server, for the case of an eventual unattended orchestrator actually
// HOSTED on Google Cloud compute with zero environment configuration at
// all. This is attempted LAST, not as tier 2's equal, specifically so
// it never interferes with (or gets silently preferred over) an
// explicitly configured tier 1/2/3 — see tests/agent-google-auth.test.js
// for the regression proving an explicit GOOGLE_SERVICE_ACCOUNT_JSON
// config is used directly, with zero metadata-server network attempt.
//
// None configured anywhere -> {skipped:true, reason} naming all the
// options, never thrown — same fails-safe posture as every other
// optional integration in this codebase.

const { getAdcAccessToken, isAdcFileConfigured } = require("./google-adc");
const { generateImpersonatedAccessToken } = require("./google-impersonation");
const legacy = require("./google-service-account-auth");

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function isImpersonationConfigured() {
  return Boolean(process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT);
}

// Synchronous, network-free — a credential FILE's mere presence, not a
// network probe. See google-adc.js's isAdcFileConfigured() header for
// why this deliberately can't see the metadata-server case.
function isDirectAdcConfigured() {
  return isAdcFileConfigured();
}

function isLegacyServiceAccountConfigured() {
  return legacy.isGoogleServiceAccountConfigured();
}

/**
 * Synchronous, network-free "is ANY auth mechanism explicitly/
 * discoverably configured" check — used by search-console-client.js/
 * ga4-client.js's isXConfigured() for report-display purposes only (see
 * agent/lib/report.js's firstPartyEvidence.integrations). Never used to
 * gate whether a real fetch is attempted: getAccessToken() below is the
 * actual source of truth, and additionally tries the GCE/Cloud Run
 * metadata server as a last resort this sync check cannot see.
 */
function isGoogleAuthConfigured() {
  return isImpersonationConfigured() || isDirectAdcConfigured() || isLegacyServiceAccountConfigured();
}

/**
 * @param {string} scope - the OAuth scope the caller needs (e.g.
 *   https://www.googleapis.com/auth/webmasters.readonly)
 * @param {object} [options]
 * @param {function} [options.fetchImpl] - injectable for tests
 */
async function getAccessToken(scope, options = {}) {
  const fetchImpl = options.fetchImpl;

  if (isImpersonationConfigured()) {
    const serviceAccountEmail = process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
    const base = await getAdcAccessToken(CLOUD_PLATFORM_SCOPE, { fetchImpl });
    if (base.skipped) {
      return {
        skipped: true,
        reason: `Impersonation configured (GOOGLE_IMPERSONATE_SERVICE_ACCOUNT="${serviceAccountEmail}") but no base Application Default Credentials were available: ${base.reason}`,
      };
    }
    return generateImpersonatedAccessToken({ serviceAccountEmail, scope, baseAccessToken: base.accessToken, fetchImpl });
  }

  if (isDirectAdcConfigured()) {
    return getAdcAccessToken(scope, { fetchImpl });
  }

  if (isLegacyServiceAccountConfigured()) {
    return legacy.getAccessToken(scope, { fetchImpl });
  }

  // Last resort: nothing explicit is configured at all — still worth
  // checking whether we're running ON Google Cloud compute, where ADC
  // is available with zero configuration via the metadata server. When
  // a credential FILE already existed (tier 2's gate above), this branch
  // is never reached, so there is no double-checking / wasted lookup.
  return getAdcAccessToken(scope, { fetchImpl });
}

module.exports = {
  getAccessToken,
  isGoogleAuthConfigured,
  isImpersonationConfigured,
  isDirectAdcConfigured,
  isLegacyServiceAccountConfigured,
};
