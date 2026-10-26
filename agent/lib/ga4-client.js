// Site Improvement Agent, Phase 6 — GA4 Data API client (read-only).
//
// Thin wrapper over GA4 Data API's `runReport` — aggregate
// sessions/engagement/conversion behavior by landing page, source/medium,
// device, etc. Returns the RAW API shape to its caller
// (agent/lib/firstparty-fetch.js), which normalizes it into the evidence
// shape agent/lib/firstparty-evidence.js defines; this file's only job is
// "call the API, or fail gracefully."
//
// PRIVACY (agent/README.md's Phase 6 "Privacy" section): this agent uses
// AGGREGATE analytics only. fetchGa4Evidence() in firstparty-fetch.js
// refuses to even call this module with a visitor/client-identifier
// dimension (clientId, userId, userPseudoId, appInstanceId, ...) — this
// module itself stays a dumb pass-through on purpose (one place to
// enforce that boundary, not two independently-drifting ones).
//
// Never called by agent/runner.js/gatherFindings() — only by the separate,
// explicit `node agent/cli.js --fetch-firstparty=<request.json>` step.
//
// AUTH-HARDENING UPDATE: auth now goes through agent/lib/google-auth.js's
// unified resolver (impersonation preferred, then direct ADC, then the
// legacy service-account-JSON key as an optional fallback — see that
// file's header) instead of going straight to the legacy key module.

const { getAccessToken, isGoogleAuthConfigured } = require("./google-auth");

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

function isGa4Configured() {
  return isGoogleAuthConfigured() && Boolean(process.env.GA4_PROPERTY_ID);
}

/**
 * @param {object} args
 * @param {string} args.startDate - "YYYY-MM-DD"
 * @param {string} args.endDate - "YYYY-MM-DD"
 * @param {string[]} [args.dimensions] - GA4 dimension names, e.g. ["landingPage"]
 * @param {string[]} [args.metrics] - GA4 metric names, e.g. ["sessions","conversions"]
 * @param {object} [args.dimensionFilter] - raw GA4 FilterExpression, passed through as-is
 * @param {number} [args.limit]
 * @param {function} [args.fetchImpl] - injectable for tests
 */
async function runReport({ startDate, endDate, dimensions, metrics, dimensionFilter, limit, offset = 0, fetchImpl } = {}) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    return { skipped: true, reason: "GA4_PROPERTY_ID not configured — GA4 evidence not available" };
  }
  const token = await getAccessToken(SCOPE, { fetchImpl });
  if (token.skipped) return token;

  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`;
  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: (dimensions || []).map((name) => ({ name })),
    metrics: (metrics || []).map((name) => ({ name })),
    limit: limit || 25,
    offset,
    ...(dimensionFilter ? { dimensionFilter } : {}),
  };

  try {
    const f = fetchImpl || fetch;
    const res = await f(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      return { skipped: true, status: res.status, reason: `GA4 Data API error: ${(json && json.error && json.error.message) || res.status}` };
    }
    return {
      skipped: false,
      rowCount: json.rowCount || 0,
      metadata: json.metadata || {},
      dimensionHeaders: (json && json.dimensionHeaders) || [],
      metricHeaders: (json && json.metricHeaders) || [],
      rows: (json && json.rows) || [],
    };
  } catch (e) {
    return { skipped: true, reason: `GA4 request failed: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { runReport, isGa4Configured, SCOPE };
