// Site Improvement Agent, Phase 6 — Search Console API client (read-only).
//
// Thin wrapper over two Search Console endpoints — Search Analytics
// (clicks/impressions/ctr/position by query/page/device/date) and URL
// Inspection (indexing/canonical state for one URL at a time). Returns
// RAW API shapes to its caller (agent/lib/firstparty-fetch.js), which is
// the ONLY module responsible for normalizing them into the evidence
// shape agent/lib/firstparty-evidence.js defines — this file's job is
// just "call the API, or fail gracefully."
//
// Never called by agent/runner.js/gatherFindings() — see
// agent/README.md's Phase 6 section: the network-free deterministic
// pipeline stays network-free. This module is only ever invoked by the
// separate, explicit `node agent/cli.js --fetch-firstparty=<request.json>`
// step (see cli.js + firstparty-fetch.js).
//
// AUTH-HARDENING UPDATE: auth now goes through agent/lib/google-auth.js's
// unified resolver (impersonation preferred, then direct ADC, then the
// legacy service-account-JSON key as an optional fallback — see that
// file's header) instead of going straight to the legacy key module.

const { getAccessToken, isGoogleAuthConfigured } = require("./google-auth");

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SEARCH_ANALYTICS_BASE = "https://www.googleapis.com/webmasters/v3/sites";
const URL_INSPECTION_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

function isSearchConsoleConfigured() {
  return isGoogleAuthConfigured() && Boolean(process.env.GSC_SITE_URL);
}

/**
 * @param {object} args
 * @param {string} args.startDate - "YYYY-MM-DD"
 * @param {string} args.endDate - "YYYY-MM-DD"
 * @param {string[]} [args.dimensions] - e.g. ["query"], ["page"], ["query","page"]
 * @param {object[]} [args.dimensionFilterGroups] - raw Search Console filter groups, passed through as-is
 * @param {number} [args.rowLimit]
 * @param {function} [args.fetchImpl] - injectable for tests
 */
async function querySearchAnalytics({ startDate, endDate, dimensions, dimensionFilterGroups, rowLimit, startRow = 0, dataState, aggregationType, fetchImpl } = {}) {
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) {
    return { skipped: true, reason: "GSC_SITE_URL not configured — Search Console evidence not available" };
  }
  const token = await getAccessToken(SCOPE, { fetchImpl });
  if (token.skipped) return token;

  const endpoint = `${SEARCH_ANALYTICS_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const body = {
    startDate,
    endDate,
    dimensions: dimensions || ["query"],
    rowLimit: rowLimit || 25,
    startRow,
    ...(dataState ? { dataState } : {}),
    ...(aggregationType ? { aggregationType } : {}),
    ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
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
      return { skipped: true, status: res.status, reason: `Search Analytics API error: ${(json && json.error && json.error.message) || res.status}` };
    }
    return { skipped: false, rows: (json && json.rows) || [] };
  } catch (e) {
    return { skipped: true, reason: `Search Analytics request failed: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * @param {object} args
 * @param {string} args.inspectionUrl - the fully-qualified URL to inspect
 * @param {function} [args.fetchImpl] - injectable for tests
 */
async function inspectUrl({ inspectionUrl, fetchImpl } = {}) {
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) {
    return { skipped: true, reason: "GSC_SITE_URL not configured — URL Inspection evidence not available" };
  }
  const token = await getAccessToken(SCOPE, { fetchImpl });
  if (token.skipped) return token;

  try {
    const f = fetchImpl || fetch;
    const res = await f(URL_INSPECTION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    });
    const json = await res.json();
    if (!res.ok) {
      return { skipped: true, reason: `URL Inspection API error: ${(json && json.error && json.error.message) || res.status}` };
    }
    return { skipped: false, result: (json && json.inspectionResult) || {} };
  } catch (e) {
    return { skipped: true, reason: `URL Inspection request failed: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { querySearchAnalytics, inspectUrl, isSearchConsoleConfigured, SCOPE };
