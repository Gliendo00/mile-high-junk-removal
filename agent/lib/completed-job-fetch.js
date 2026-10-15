// Site Improvement Agent, Phase 5B — automated completed-job evidence
// retrieval.
//
// Phase 5 shipped `agent/lib/completed-job-intake.js`, which reads
// ALREADY-REDACTED evidence files from agent/research/completed-jobs/ —
// but required a human (or Claude session) to manually pull real booking
// rows from Supabase, redact them, and write that file by hand. THIS
// module is the automated replacement for that manual step: it queries
// Supabase directly, using the EXACT SAME privacy boundary
// (business-context.js's fromCompletedBooking()/redactForPublication())
// that was always the intended path for real production data — nothing
// about the privacy rules changed, only who performs the fetch.
//
// HARD PRIVACY RULES (see agent/README.md's "Privacy guarantees" section
// and tests/agent-completed-job-fetch.test.js for the regression proof):
//
// 1. SELECT_COLUMNS below is the narrowest possible column list — it
//    does NOT request customer_id, final_price, estimated_price,
//    tip_amount, payment_method, service_address, internal_notes, or any
//    other private column, even though they exist on the real `bookings`
//    table. A private value can never enter this process's memory via
//    this query in the first place — this is defense BEFORE
//    fromCompletedBooking()'s own redaction, not instead of it.
// 2. Every row is piped through fromCompletedBooking() immediately — a
//    raw row is never logged, never written to a file, never returned
//    from this module's public functions. Only the function's own
//    already-redacted return value ever leaves this module.
// 3. This module is NEVER called by the network-free deterministic
//    runner.js/gatherFindings() pipeline — only by an explicit, separate
//    CLI step (`node agent/cli.js --refresh-completed-jobs`) that a
//    research-capable orchestrator invokes BEFORE a weekly run, not
//    during one. This keeps the Node runner's "no network access"
//    invariant completely intact.
// 4. The CLI wrapper (agent/cli.js) never logs field values — only a
//    count — so even an accidental schema mistake here can't leak a
//    private value into a terminal/CI log.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getServiceClient } = require("../../api/_lib/supabase-admin");
const { fromCompletedBooking } = require("./business-context");

// Deliberately narrow — see this file's header, rule 1. If a future
// change to fromCompletedBooking() ever needs another raw field, add it
// here explicitly and re-review; never widen this to "select *".
const SELECT_COLUMNS = "status, service_type, service_city, operational_note";

const DEFAULT_OUTPUT_DIR = path.join(config.SITE_ROOT, "agent", "research", "completed-jobs");
const DEFAULT_OUTPUT_FILE = "latest-refresh.json";

/**
 * Pulls recently-completed bookings from Supabase and returns ONLY their
 * already publication-safe evidence (see this file's header). Fails safe
 * exactly like every other optional-Supabase path in this codebase: no
 * credentials configured -> `{skipped: true, reason, evidence: []}`,
 * never thrown.
 * @param {object} [options]
 * @param {object} [options.client] - inject a fake Supabase client for tests
 * @param {number} [options.sinceDays] - how far back to look (default 30)
 */
async function fetchRecentCompletedJobEvidence(options = {}) {
  const supabase = options.client || getServiceClient();
  if (!supabase) {
    return { skipped: true, reason: "Supabase not configured — completed-job evidence not refreshed", evidence: [] };
  }

  const sinceDays = options.sinceDays || 30;
  const cutoffIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from("bookings")
      .select(SELECT_COLUMNS)
      .eq("status", "completed")
      .gte("updated_at", cutoffIso);
    if (error) throw error;

    const evidence = [];
    for (const row of data || []) {
      // fromCompletedBooking() returns null when there's no operational
      // note at all ("no evidence" != "evidence of an empty job" — see
      // its own header) — never pushed as a placeholder.
      const safe = fromCompletedBooking(row);
      if (safe) evidence.push(safe);
    }
    return { skipped: false, evidence };
  } catch (e) {
    return { skipped: true, reason: e && e.message ? e.message : String(e), evidence: [] };
  }
}

/**
 * Writes already-sanitized evidence to a single rolling file (overwritten
 * on every refresh, not accumulated — this is a snapshot of "recent
 * evidence as of the last refresh," not a historical archive; the
 * historical record of what the agent DID with it already lives in
 * agent/history/log.ndjson). Only ever call this with the OUTPUT of
 * fetchRecentCompletedJobEvidence() (or an equivalently pre-redacted
 * array) — this function does not redact anything itself.
 */
function writeCompletedJobEvidence(evidence, dir = DEFAULT_OUTPUT_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, DEFAULT_OUTPUT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { fetchRecentCompletedJobEvidence, writeCompletedJobEvidence, SELECT_COLUMNS, DEFAULT_OUTPUT_DIR, DEFAULT_OUTPUT_FILE };
