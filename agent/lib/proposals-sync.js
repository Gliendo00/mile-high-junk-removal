// Site Improvement Agent, Phase 3 — syncs actionable/approval-needing
// findings into the live `agent_proposals` table (see
// sql/2026-10-12_phase3-agent-proposals.sql) so the CRM can show and act
// on them — the git-tracked agent/history/log.ndjson stays the full,
// read-only run record; this is the smaller, LIVE-MUTABLE subset the
// owner can actually approve/reject through the admin UI.
//
// Uses the exact same api/_lib/supabase-admin.js service-role client
// every other admin data route uses — but NOT in that module's usual
// context. That module's own header warns it must only be used "AFTER
// requireAdmin() has verified the caller," because it answers live HTTP
// requests; this module is a server-side/CLI step writing to the
// project's own database directly (the same category of thing as a
// migration script or a cron job), not answering an unauthenticated
// request, so that invariant doesn't apply here — there is no "caller"
// to authenticate.
//
// Fails safe exactly like every other optional-Supabase code path in
// this codebase: if SUPABASE_URL/SUPABASE_SECRET_KEY aren't configured
// in the environment the runner executes in (true for this repo's own
// offline dry-run/test environment, and true for this agent's dry-run
// default), syncing is skipped with a clear, honest reason — never a
// thrown error, and never a reason to fail the run itself.
//
// Upsert rule: a finding_key that doesn't exist yet is INSERTed as
// 'proposed'. A finding_key that already exists gets its CONTENT columns
// (summary/decision/evidence/research/etc.) refreshed to this run's
// latest version, but `status`/`reviewed_by`/`reviewed_at`/`review_note`
// are never touched by a re-sync — an owner's prior approve/reject
// decision on a specific proposal is never silently reset back to
// "proposed" just because the underlying finding recurred on a later run.

const { getServiceClient } = require("../../api/_lib/supabase-admin");

// Only findings that actually need an owner's eyes get synced — this is
// deliberately narrower than "every finding", matching the Home
// dashboard's own "concise, not a dump of every observation" posture.
// APPLY_SAFE_FIX findings are handled entirely by the existing Phase 1/2
// auto-apply/validate loop and never need this table at all;
// RESEARCH_MORE/NO_CHANGE/observations have nothing yet for an owner to
// decide on.
function needsOwnerReview(finding) {
  return finding.decision === "PROPOSE_CHANGE" || finding.decision === "REJECT_OPPORTUNITY";
}

function toRow(finding, runId) {
  return {
    finding_type: finding.type,
    category: finding.category,
    risk_level: finding.riskLevel || null,
    decision: finding.decision,
    decision_reason: finding.reason || null,
    summary: finding.summary,
    pages: finding.pages,
    evidence: finding.evidence || [],
    research: finding.research || [],
    last_run_id: runId,
    updated_at: new Date().toISOString(),
  };
}

/**
 * @param {object[]} findings - decided findings (decision.js's output)
 * @param {string} runId
 * @param {object} [options] - { client } to inject a fake Supabase client for tests
 */
async function syncProposals(findings, runId, options = {}) {
  const supabase = options.client || getServiceClient();
  if (!supabase) {
    return { skipped: true, reason: "Supabase not configured — proposals not synced to the CRM", synced: 0, total: 0, errors: [] };
  }

  const toSync = findings.filter(needsOwnerReview);
  let synced = 0;
  const errors = [];

  for (const finding of toSync) {
    try {
      const existingRes = await supabase.from("agent_proposals").select("id").eq("finding_key", finding.key).maybeSingle();
      if (existingRes.error) throw existingRes.error;

      if (existingRes.data) {
        const { error } = await supabase.from("agent_proposals").update(toRow(finding, runId)).eq("finding_key", finding.key);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("agent_proposals").insert({
          finding_key: finding.key,
          status: "proposed",
          ...toRow(finding, runId),
        });
        if (error) throw error;
      }
      synced += 1;
    } catch (e) {
      errors.push({ findingKey: finding.key, message: e && e.message ? e.message : String(e) });
    }
  }

  return { skipped: false, synced, total: toSync.length, errors };
}

module.exports = { syncProposals, needsOwnerReview, toRow };
