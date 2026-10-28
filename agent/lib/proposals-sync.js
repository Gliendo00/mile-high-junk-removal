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
// wearing the same key, not the same one recurring.
//
// Pre-acceptance hardening (audit finding #3, baseline 2bff317) — the
// original Phase 4 rule compared ONLY `summary` text. That missed a real
// case: a finding can stay the SAME summary while its `decision`
// reverses (e.g. PROPOSE_CHANGE -> REJECT_OPPORTUNITY once research
// comes back contradicting it) or its attached research's VERDICT
// materially changes — summary text is derived from the audit module's
// type+pages template, not from research, so it can legitimately stay
// byte-identical while the thing an owner actually approved/rejected
// (the DECISION, and the research behind it) flips underneath them.
// computeReviewContentFingerprint() below now compares `decision`,
// `summary`, the finding's own `.evidence`, and the single LATEST
// EFFECTIVE research result (decision.js's own pickLatestResearch() —
// the same authority-tier-aware pick decision.js itself already uses,
// reduced to just {sourceType, verdict, confidence, sufficiency}) —
// deliberately NOT the raw `.research` array, whose length/order can
// grow across runs purely from provenance (a re-fetch that reconfirms
// the SAME conclusion under a new file/timestamp — see research-
// intake.js's attachResearch(), which never removes an old matching
// file) without anything MATERIAL having changed. See that function's
// own header for exactly what counts as material.
//
// If the existing row's `status` is already a reviewed, terminal one
// (`approved` or `rejected`) and this fingerprint differs from what's
// stored — OR the finding_key is REAPPEARING after being absent from
// the owner-review set in the immediately preceding run (audit finding
// #4 — see `previousOwnerReviewKeys` below: a reviewed decision must
// never silently re-apply to a proposal that had stopped being proposed
// for a while, even if its content happens to be byte-identical once it
// comes back) — this resets `status` back to `proposed` and clears
// `reviewed_by`/`reviewed_at`/`review_note`. The owner's prior decision
// never silently carries over onto different (or reappeared) content.
// If the row is still `proposed` (never reviewed), or neither condition
// applies, the owner's existing state (or lack of one) is left alone
// exactly as before.

const { getServiceClient } = require("../../api/_lib/supabase-admin");
const { pickLatestResearch } = require("./decision");
const { buildHandoffReport } = require("./claude-handoff-report");

// Phase 16 — the fingerprint-reset mechanism below (see this file's own
// header) originally only guarded 'approved'/'rejected'. The admin UI
// now offers three more owner decisions on a proposal — 'no_change'
// (Verified — No Change Needed), 'needs_revision', and 'recheck' (see
// sql/2026-10-28_phase16-proposal-decision-states.sql's own header for
// the full action/status list). All five are "a human looked at this
// and decided something" states, so all five get the SAME protection:
// a re-sync with unchanged content never silently resets the decision
// back to 'proposed' — it only resets when the finding's content has
// materially changed, or the finding_key reappears after a run where it
// stopped needing owner review entirely. This is exactly how the spec's
// "an identical no_change proposal must not immediately come back"
// requirement is satisfied, with no new/separate suppression system —
// the EXISTING Phase 4 hardening mechanism, simply applied to a wider
// set of statuses.
const DECIDED_STATUSES = ["approved", "rejected", "no_change", "needs_revision", "recheck"];

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

// Phase 15 — the importance gate: "not every finding deserves a
// proposal." Only an IMPORTANT-classified finding (agent/lib/
// opportunity-classification.js) that also needs owner review ever
// becomes/updates an agent_proposals row — WATCH/LOW_SUPPRESS/PROTECT
// findings are recorded in agent/history/log.ndjson only (see
// agent/runner.js), never here.
//
// FAILS CLOSED: `finding.opportunityClassification` missing — never
// classified at all, a classification step skipped by a future
// refactor, or anything else that isn't an explicit classification
// object — is treated exactly like a non-IMPORTANT classification and
// does NOT sync. This gate's first draft treated a missing
// classification as "unknown, proceed as before `needsOwnerReview()`
// alone", which in practice meant "unknown -> assume IMPORTANT" — a
// production safety gate must never default to permissive on absent
// input, so that fallback was removed (code review finding, 2026-10-26).
// agent/runner.js, the only real production caller, ALWAYS classifies
// every finding before calling syncProposals() (see its
// gatherFindings()/classifyAllOpportunities() call), so this never
// excludes a finding that should sync in a real run. A caller that
// genuinely needs the pre-Phase-15 behavior (a direct/legacy test, say)
// must attach its own `.opportunityClassification` before calling
// syncProposals() — see tests/agent-proposals-sync.test.js's
// decidedFinding() helper, which does exactly that rather than relying
// on this function to guess.
function needsProposal(finding) {
  if (!needsOwnerReview(finding)) return false;
  if (!finding.opportunityClassification) return false;
  return finding.opportunityClassification.classification === "IMPORTANT";
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
// Phase 15 — generates the copy-ready Claude handoff report at sync time
// (never at read time: admin/agent-proposals.js's "Copy Claude Report"
// button just copies this stored text, it never recomputes it) only for
// a finding this run actually classified IMPORTANT. `context.pages` is
// agent/lib/scan.js's scanAllPages() output for this run, passed through
// from runner.js so CURRENT PAGE STATE can be filled with real values —
// omitted (never a placeholder) when not supplied, same discipline
// claude-handoff-report.js's own section() helper follows for every
// section.
function buildHandoffReportIfImportant(finding, context) {
  const classification = finding.opportunityClassification;
  if (!classification || classification.classification !== "IMPORTANT") return null;
  try {
    return buildHandoffReport(finding, classification, context);
  } catch (e) {
    // A report-generation bug must never block the underlying proposal
    // from syncing — same fail-safe posture every other optional
    // enrichment in this pipeline follows (research-intake.js's
    // malformed-file handling, etc.).
    return null;
  }
}

function updatableFields(finding, runId, context = {}) {
  return {
    category: finding.category,
    risk_level: finding.riskLevel || null,
    decision: finding.decision,
    decision_reason: finding.reason || null,
    summary: finding.summary,
    evidence: finding.evidence || [],
    research: finding.research || [],
    // Phase 14 — the same deterministic {kind, file, from, to} fix
    // description findings already carry as `.autoFix` (see
    // agent/lib/findings.js), copied onto the proposal row so the
    // execution engine (agent/lib/execute-proposal.js) has something
    // concrete to act on instead of ever guessing one from prose. NULL
    // for every finding type today (see that module's own header on
    // why no current PROPOSE_CHANGE finding has one) — this is forward
    // wiring, not a behavior change for any existing finding.
    proposed_fix: finding.autoFix || null,
    // Phase 15 — null for every legacy proposal (a finding this run
    // didn't classify, or classified anything other than IMPORTANT never
    // reaches this far — see needsProposal() above), never backfilled
    // for an existing row that already synced before Phase 15 existed.
    opportunity_classification: finding.opportunityClassification || null,
    claude_handoff_report: buildHandoffReportIfImportant(finding, context),
    last_run_id: runId,
    updated_at: new Date().toISOString(),
  };
}

// The full row for a brand-new finding_key — includes the two identity
// fields updatableFields() deliberately omits, since an INSERT is the
// only time they're ever written.
function toRow(finding, runId, context = {}) {
  return {
    finding_type: finding.type,
    pages: finding.pages,
    ...updatableFields(finding, runId, context),
  };
}

// Pre-acceptance hardening (audit finding #3) — reduces a finding's
// `.research[]` to the single result decision.js itself would actually
// rely on (same pickLatestResearch() call decision.js uses), then keeps
// only the fields an owner's review is actually ABOUT: which kind of
// source it is, what it concluded, how confident, and (for a cross-
// source-synthesis result) how sufficient the corroboration was.
// Deliberately excludes accessedAt/source/evidence/limitations/
// recommendation TEXT — provenance and prose, never the kind of thing
// that should force a re-review on its own when the underlying
// conclusion hasn't actually changed.
function latestResearchSnapshot(research) {
  const latest = pickLatestResearch(Array.isArray(research) ? research : []);
  if (!latest) return null;
  return {
    sourceType: latest.sourceType || null,
    verdict: latest.verdict || null,
    confidence: latest.confidence || null,
    sufficiency: latest.sufficiency || null,
  };
}

// Hotfix (second controlled Phase 14 execution test, proposal
// 6ad71748-...) — Postgres's `jsonb` type does NOT preserve object key
// insertion order on storage/retrieval (documented Postgres behavior,
// not a bug in any driver): a plain JS object written to a jsonb column
// can come back out with its keys in a different order, even though
// every key/value pair is byte-identical. `JSON.stringify()` serializes
// an object's keys in whatever order they currently exist in memory, so
// two semantically-identical objects with different key order produce
// two different strings. This is invisible to any test that never
// round-trips through a real jsonb column (which is exactly why the
// in-process scan -> sync -> execute simulation used while diagnosing
// this matched perfectly, while the SAME data, having gone through
// Supabase for real, did not) — proven directly in
// tests/agent-proposals-sync.test.js's "JSON key ordering alone never
// causes a false freshness mismatch" test.
//
// Recursively sorts every object's own keys (never array ORDER, which
// is semantically meaningful) so computeReviewContentFingerprint()
// below is insensitive to this — the one canonicalization step that was
// missing for `proposedFix` (evidence's own VALUES go through this too,
// defensively, even though every current evidence value happens to be
// a primitive).
function canonicalizeForFingerprint(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForFingerprint);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeForFingerprint(value[key]);
    }
    return sorted;
  }
  return value;
}

// Pre-acceptance hardening (audit finding #3) — see this file's header
// for the full rationale. A small, deterministic, ORDER-INSENSITIVE
// (evidence is sorted, and — see canonicalizeForFingerprint() above —
// immune to a jsonb round-trip reordering any object's keys) summary of
// exactly the material facts a reviewed proposal was reviewed ON — used
// to decide whether a reviewed decision may still carry forward, never
// persisted anywhere itself.
function computeReviewContentFingerprint(finding) {
  const evidence = (Array.isArray(finding.evidence) ? finding.evidence : [])
    .map((e) => `${e && e.field}=${JSON.stringify(canonicalizeForFingerprint(e && e.value))}`)
    .sort();
  return JSON.stringify({
    decision: finding.decision,
    summary: finding.summary,
    evidence,
    latestResearch: latestResearchSnapshot(finding.research),
    // Phase 14 — the literal mechanical fix (see updatableFields()'s
    // `proposed_fix` above) is exactly the kind of thing an owner's
    // review is ABOUT once one exists: a finding that keeps the same
    // summary/evidence/decision but silently changes WHAT WOULD BE
    // WRITTEN (a different `to` value, say) must still count as
    // material and reset a prior review — same reasoning as every
    // other field in this fingerprint, see this file's header.
    // `finding.autoFix` here is intentionally read under that name
    // (not `proposedFix`) so this same function keeps working
    // unmodified when called against a DB row shimmed to look like a
    // finding (see execute-proposal.js's own caller). Canonicalized
    // (see canonicalizeForFingerprint() above) so a jsonb round-trip's
    // key reordering of this object can never falsely look like a
    // material change.
    proposedFix: canonicalizeForFingerprint(finding.autoFix || null),
    // Phase 15 — a finding's own IMPORTANCE can change (e.g. a stale
    // analytics snapshot becoming fresh again) even when decision/
    // summary/evidence/research all stay byte-identical — see
    // opportunity-classification.js's freshness guard. That's still a
    // material change an owner's prior review should not silently carry
    // forward across, so it's included here too. Accepts either the
    // camelCase shape a live finding carries (`opportunityClassification`)
    // or the raw snake_case column name a Supabase row comes back as
    // when the caller passes a DB row directly (see this file's own
    // `existingRes.data` call site, which selects this column, and
    // execute-proposal.js's proposalAsFindingShape(), which renames it
    // itself). Absent on either side reads as `null` — never treated as
    // a material change on its own.
    importanceClassification: classificationFromEither(finding),
  });
}

function classificationFromEither(finding) {
  const c = finding.opportunityClassification || finding.opportunity_classification || null;
  return c ? c.classification : null;
}

/**
 * @param {object[]} findings - decided findings (decision.js's output)
 * @param {string} runId
 * @param {object} [options] - { client } to inject a fake Supabase client for tests
 * @param {Set<string>} [options.previousOwnerReviewKeys] - pre-acceptance
 *   hardening (audit finding #4) — the set of finding `key`s that needed
 *   owner review (needsOwnerReview()) as of the immediately PRECEDING
 *   run, read from history by the caller (runner.js — see its own
 *   header). `undefined`/`null` means "unknown" (e.g. the very first
 *   run ever, or a caller that hasn't been updated to pass it) and is
 *   always treated as "not reappearing" — fail-safe: ABSENCE of this
 *   information must never itself force a reset, only its PRESENCE
 *   (a key genuinely missing from it) does. A finding_key currently in
 *   `toSync` that is NOT in this set is reappearing after at least one
 *   run where it didn't need owner review at all — see this file's
 *   header and the reset logic below for why a reviewed decision must
 *   not silently carry forward across that gap, even when the content
 *   happens to be unchanged once it returns.
 */
async function syncProposals(findings, runId, options = {}) {
  const supabase = options.client || getServiceClient();
  if (!supabase) {
    return { skipped: true, reason: "Supabase not configured — proposals not synced to the CRM", synced: 0, total: 0, errors: [], statusByKey: {} };
  }

  // Phase 15 — only an IMPORTANT-classified finding ever syncs (see
  // needsProposal()'s own header).
  const toSync = findings.filter(needsProposal);
  const previousOwnerReviewKeys = options.previousOwnerReviewKeys || null;
  // Phase 15 — agent/lib/scan.js's scanAllPages() output for this run
  // (runner.js passes it through), used only to fill in a generated
  // Claude handoff report's CURRENT PAGE STATE section — see
  // buildHandoffReportIfImportant() above. `[]` (never undefined) so
  // every pre-Phase-15 caller of syncProposals() (including this file's
  // own existing tests) keeps working unmodified; the report simply
  // omits that one section when pages aren't supplied.
  const context = { pages: options.pages || [] };
  let synced = 0;
  const errors = [];
  // Phase 5 — the status each synced finding_key ends up at after this
  // run's sync, so the report/change-detection layer can say "already
  // proposed" / "previously rejected" / "already applied" without a
  // second DB round-trip. Absent for anything sync didn't touch (e.g. a
  // finding that failed to sync, or wasn't in `toSync` at all).
  const statusByKey = {};

  for (const finding of toSync) {
    try {
      const existingRes = await supabase
        .from("agent_proposals")
        .select("id, status, summary, decision, evidence, research, opportunity_classification")
        .eq("finding_key", finding.key)
        .maybeSingle();
      if (existingRes.error) throw existingRes.error;

      if (existingRes.data) {
        const row = updatableFields(finding, runId, context);
        const wasReviewed = DECIDED_STATUSES.indexOf(existingRes.data.status) !== -1;
        const contentChanged = computeReviewContentFingerprint(existingRes.data) !== computeReviewContentFingerprint(finding);
        const reappearedAfterAbsence = Boolean(previousOwnerReviewKeys) && !previousOwnerReviewKeys.has(finding.key);
        if (wasReviewed && (contentChanged || reappearedAfterAbsence)) {
          // See this file's header — a reviewed decision never silently
          // carries over onto materially different content, NOR across
          // a gap where this finding_key stopped needing owner review
          // at all (audit finding #4), even if it happens to look the
          // same once it reappears.
          row.status = "proposed";
          row.reviewed_by = null;
          row.reviewed_at = null;
          row.review_note = null;
        }
        const { error } = await supabase.from("agent_proposals").update(row).eq("finding_key", finding.key);
        if (error) throw error;
        statusByKey[finding.key] = row.status || existingRes.data.status;
      } else {
        const { error } = await supabase.from("agent_proposals").insert({
          finding_key: finding.key,
          status: "proposed",
          ...toRow(finding, runId, context),
        });
        if (error) throw error;
        statusByKey[finding.key] = "proposed";
      }
      synced += 1;
    } catch (e) {
      errors.push({ findingKey: finding.key, message: e && e.message ? e.message : String(e) });
    }
  }

  return { skipped: false, synced, total: toSync.length, errors, statusByKey };
}

module.exports = { syncProposals, needsOwnerReview, needsProposal, toRow, updatableFields, computeReviewContentFingerprint, latestResearchSnapshot, canonicalizeForFingerprint, DECIDED_STATUSES };
