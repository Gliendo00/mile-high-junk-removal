// Site Improvement Agent, Phase 6 auth-hardening — short-lived service-
// account impersonation via the IAM Credentials API's
// `generateAccessToken`. This is the PREFERRED auth path (see
// agent/lib/google-auth.js's header): a human (via `gcloud auth
// application-default login`, on this Windows machine) or an eventual
// hosted/unattended identity authenticates as THEMSELVES via
// Application Default Credentials (agent/lib/google-adc.js) — never as
// the target service account — and is granted ONLY
// `roles/iam.serviceAccountTokenCreator` on
// mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com (an
// owner-side IAM grant in Google Cloud Console, not performed by this
// code — see agent/README.md's Phase 6 auth-hardening section for the
// exact steps).
//
// The resulting access token:
//   - is scoped to EXACTLY the scope requested (e.g.
//     webmasters.readonly or analytics.readonly), regardless of the
//     base ADC credential's own scope — this is what makes impersonation
//     reliably work where a direct-ADC token often cannot without extra
//     login-time --scopes configuration (see google-adc.js's header).
//   - lives for at most ~1 hour (the IAM Credentials API's default/max
//     lifetime for this call) and is never written to disk anywhere in
//     this codebase.
//   - requires NO long-lived service-account key to exist, satisfying
//     the org's `iam.disableServiceAccountKeyCreation` policy by
//     construction, not by a workaround or an exception request.

const IAM_CREDENTIALS_ENDPOINT = (serviceAccountEmail) =>
  `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:generateAccessToken`;

/**
 * @param {object} args
 * @param {string} args.serviceAccountEmail - the target SA to impersonate (GOOGLE_IMPERSONATE_SERVICE_ACCOUNT)
 * @param {string} args.scope - the single OAuth scope the resulting token should carry
 * @param {string} args.baseAccessToken - an ADC-derived token for the CALLING identity — needs
 *   `roles/iam.serviceAccountTokenCreator` on the target service account
 * @param {function} [args.fetchImpl] - injectable for tests; defaults to global fetch
 */
async function generateImpersonatedAccessToken({ serviceAccountEmail, scope, baseAccessToken, fetchImpl } = {}) {
  if (!serviceAccountEmail) {
    return { skipped: true, reason: "generateImpersonatedAccessToken requires a serviceAccountEmail" };
  }
  const f = fetchImpl || fetch;
  try {
    const res = await f(IAM_CREDENTIALS_ENDPOINT(serviceAccountEmail), {
      method: "POST",
      headers: { Authorization: `Bearer ${baseAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: [scope] }),
    });
    const body = await res.json();
    if (!res.ok || !body || !body.accessToken) {
      const reason = (body && body.error && body.error.message) || `HTTP ${res.status}`;
      return { skipped: true, reason: `Service-account impersonation failed for "${serviceAccountEmail}": ${reason}` };
    }
    return { skipped: false, accessToken: body.accessToken, expireTime: body.expireTime || null, source: "impersonation" };
  } catch (e) {
    return { skipped: true, reason: `Service-account impersonation request error: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { generateImpersonatedAccessToken, IAM_CREDENTIALS_ENDPOINT };
