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
// latest version.
//
// Phase 4 hardening — PROPOSAL IDENTITY: `finding_key` alone
// (type::sorted-pages) is NOT treated as a strong enough identity to
// carry a prior APPROVED/REJECTED decision forward unconditionally. A
// later run can legitimately re-observe "the same" finding_key with a
// materially different `summary` (e.g. a different word-count gap, a
// different recommendation) — that is a DIFFERENT concrete proposal
// wearing the same key, not the same one recurring. So: if the existing
// row's `status` is already a reviewed, terminal one (`approved` or
// `rejected`) and the new `summary` differs from what's stored, this
// resets `status` back to `proposed` and clears `reviewed_by`/
// `reviewed_at`/`review_note` — the owner's prior decision never
// silently carries over onto different content. If the row is still
// `proposed` (never reviewed), or the summary is unchanged, the owner's
// existing state (or lack of one) is left alone exactly as before.

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

// The columns genuinely mutable on an EXISTING row — notably excludes
// `finding_type`/`pages`. Those two are redundant to ever re-send on an
// UPDATE: finding_key is literally derived FROM them
// (findings.js's makeKey: `${type}::${sortedPages}`), so any row this
// module matches by finding_key necessarily already has the same type
// and pages — there is nothing to refresh. Keeping them off this list
// (and off the SQL grant's UPDATE column list — see
// sql/2026-10-12_phase3-agent-proposals.sql) means the real Postgres
// column-level grant and this module's actual UPDATE statement stay in
// lockstep, instead of silently drifting the way an earlier draft of
// this migration did (caught by tests/agent-migrations-review.test.js).
function updatableFields(finding, runId) {
  return {
    category: finding.category,
    risk_level: finding.riskLevel || null,
    decision: finding.decision,
    decision_reason: finding.reason || null,
    summary: finding.summary,
    evidence: finding.evidence || [],
    research: finding.research || [],
    last_run_id: runId,
    updated_at: new Date().toISOString(),
  };
}

// The full row for a brand-new finding_key — includes the two identity
// fields updatableFields() deliberately omits, since an INSERT is the
// only time they're ever written.
function toRow(finding, runId) {
  return {
    finding_type: finding.type,
    pages: finding.pages,
    ...updatableFields(finding, runId),
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
      const existingRes = await supabase.from("agent_proposals").select("id, status, summary").eq("finding_key", finding.key).maybeSingle();
      if (existingRes.error) throw existingRes.error;

      if (existingRes.data) {
        const row = updatableFields(finding, runId);
        const wasReviewed = existingRes.data.status === "approved" || existingRes.data.status === "rejected";
        const contentChanged = existingRes.data.summary !== row.summary;
        if (wasReviewed && contentChanged) {
          // See this file's header — a reviewed decision never silently
          // carries over onto materially different content.
          row.status = "proposed";
          row.reviewed_by = null;
          row.reviewed_at = null;
          row.review_note = null;
        }
        const { error } = await supabase.from("agent_proposals").update(row).eq("finding_key", finding.key);
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

module.exports = { syncProposals, needsOwnerReview, toRow, updatableFields };
