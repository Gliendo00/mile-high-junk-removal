// Site Improvement Agent — GSC/GA4 integration health probe (CRM
// cleanup/verification audit, 2026-10-21).
//
// WHY THIS EXISTS: the Website Agent dashboard used to decide CONNECTED
// vs NOT CONFIGURED purely from isSearchConsoleConfigured()/
// isGa4Configured() (plain process.env presence) evaluated INSIDE THE
// VERCEL FUNCTION that serves the dashboard (api/admin/bookings.js's
// handleAgentDashboard()). But GOOGLE_IMPERSONATE_SERVICE_ACCOUNT /
// GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_SERVICE_ACCOUNT_JSON /
// GSC_SITE_URL / GA4_PROPERTY_ID are, by this project's own documented
// design (see agent/README.md's "Vercel / DB impact" section), read ONLY
// by this Node CLI, in whatever environment runs it (GitHub Actions) —
// deliberately never provisioned to Vercel. The dashboard's Vercel
// function could therefore never see them as anything but absent,
// regardless of whether the real GitHub Actions -> WIF -> Google API
// path is actually working — and a credential that IS present but
// broken (bad IAM permission, revoked key) would misleadingly render as
// CONNECTED, since presence-only never calls the API at all.
//
// This module runs a minimal, REAL probe of each integration from inside
// the one environment where the credentials genuinely live (this CLI —
// see the new `--check-integrations` flag in cli.js, wired into the
// EXISTING daily scheduled workflow run in
// .github/workflows/website-agent.yml, not a new manual-only diagnostic),
// and persists the outcome to a small, OVERWRITTEN-each-run JSON file
// (agent/history/integration-health.json) that the dashboard reads
// instead (handleAgentDashboard()) — the exact same cross-process-
// boundary pattern agent/lib/local-source-candidate-log.js already
// established for "tell the next process what actually happened over
// here," not a new mechanism invented for this file.
//
// Deliberately minimal: a single 1-day, 1-row request to each API — just
// enough to prove the full auth -> API -> 2xx round trip genuinely works,
// never a real data pull. gatherFindings()/the daily pipeline's own
// research step is completely unrelated to and unaffected by this file.
//
// Three honest outcomes per integration, never collapsed into two:
//   - { configured: false, ok: null,  reason: null }   -> dashboard: NOT CONFIGURED
//   - { configured: true,  ok: false, reason: "..." }  -> dashboard: ERROR
//   - { configured: true,  ok: true,  reason: null }   -> dashboard: CONNECTED
//     (or STALE, if `at` is older than the dashboard's own freshness
//     threshold — that classification lives in handleAgentDashboard(),
//     not here, since "how stale is too stale" is a dashboard-display
//     concern, not a probe concern.)

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { isSearchConsoleConfigured, querySearchAnalytics } = require("./search-console-client");
const { isGa4Configured, runReport } = require("./ga4-client");

const HEALTH_PATH = path.join(config.SITE_ROOT, "agent", "history", "integration-health.json");

// Yesterday, not today — today's own data may still be incomplete/absent
// in either API depending on processing lag; yesterday is the same
// "always has an answer" convention agent/diagnostics' golden request
// files already use for their own 28-day windows, just narrowed to the
// single most-recent day since this is a connectivity probe, not a real
// data pull.
function yesterdayIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function probeSearchConsole(fetchImpl) {
  if (!isSearchConsoleConfigured()) return { configured: false, ok: null, reason: null };
  const date = yesterdayIso();
  const result = await querySearchAnalytics({ startDate: date, endDate: date, rowLimit: 1, fetchImpl });
  if (result.skipped) return { configured: true, ok: false, reason: result.reason };
  return { configured: true, ok: true, reason: null };
}

async function probeGa4(fetchImpl) {
  if (!isGa4Configured()) return { configured: false, ok: null, reason: null };
  const date = yesterdayIso();
  const result = await runReport({ startDate: date, endDate: date, dimensions: ["date"], metrics: ["sessions"], limit: 1, fetchImpl });
  if (result.skipped) return { configured: true, ok: false, reason: result.reason };
  return { configured: true, ok: true, reason: null };
}

/**
 * @param {object} [args]
 * @param {function} [args.fetchImpl] - injectable for tests, passed through to both clients
 */
async function checkIntegrationHealth({ fetchImpl } = {}) {
  const [gsc, ga4] = await Promise.all([probeSearchConsole(fetchImpl), probeGa4(fetchImpl)]);
  return { at: new Date().toISOString(), gsc, ga4 };
}

function writeIntegrationHealth(health, healthPath = HEALTH_PATH) {
  const dir = path.dirname(healthPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n", "utf8");
  return healthPath;
}

/**
 * Fails safe exactly like local-source-candidate-log.js's own loader: a
 * missing or malformed file is "nothing known yet," never a thrown error
 * — a corrupt side-file must never crash the dashboard request.
 */
function loadIntegrationHealth(healthPath = HEALTH_PATH) {
  if (!fs.existsSync(healthPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.gsc || !parsed.ga4 || typeof parsed.at !== "string") return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

module.exports = { HEALTH_PATH, checkIntegrationHealth, writeIntegrationHealth, loadIntegrationHealth };
