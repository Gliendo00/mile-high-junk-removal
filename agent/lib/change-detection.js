// Site Improvement Agent — change detection since the previous run.
//
// Compares this run's findings against the single most recent PRIOR run
// recorded in agent/history/log.ndjson (readAllRuns() — the caller passes
// in whatever "previous run" is appropriate; this module has no file
// access of its own) and classifies each current finding as:
//
//   "new"        - this finding.key was not present in the previous run
//   "still-open" - this finding.key was already present in the previous run
//
// ...and separately lists which of the PREVIOUS run's finding keys are
// simply gone now ("resolved" — the underlying condition is no longer
// detected; could be a manual fix, a safe auto-fix, or a page changing for
// an unrelated reason. Either way, it is honest to say the issue is gone).
//
// This is deliberately scoped to "changed since last run," not "changed
// ever" — see agent/README.md's change-detection section for why: without
// this, a daily report would either repeat the same 15 observation lines
// every single day (notification spam) or require a much heavier
// historical-trend system this phase does not need.

function classifyChanges(currentFindings, previousRun) {
  const previousKeys = new Set(
    previousRun && Array.isArray(previousRun.findings) ? previousRun.findings.map((f) => f.key) : []
  );
  const currentKeys = new Set(currentFindings.map((f) => f.key));

  const byStatus = { new: [], stillOpen: [] };
  for (const finding of currentFindings) {
    if (previousKeys.has(finding.key)) {
      byStatus.stillOpen.push(finding.key);
    } else {
      byStatus.new.push(finding.key);
    }
  }

  const resolved = [...previousKeys].filter((key) => !currentKeys.has(key));

  return {
    hasPreviousRun: Boolean(previousRun),
    previousRunId: previousRun ? previousRun.runId : null,
    new: byStatus.new,
    stillOpen: byStatus.stillOpen,
    resolved,
    counts: {
      new: byStatus.new.length,
      stillOpen: byStatus.stillOpen.length,
      resolved: resolved.length,
    },
  };
}

// Attaches `proposalStatus` (from proposals-sync.js's statusByKey, when
// Supabase sync actually ran) onto a change-detection summary, so a report
// can say "already proposed" / "previously rejected" / "already applied"
// without a second DB round-trip. `statusByKey` may be undefined (sync
// skipped) — every lookup below degrades to null, never throws.
function annotateWithProposalStatus(findings, statusByKey) {
  const map = statusByKey || {};
  return findings.map((f) => ({
    key: f.key,
    proposalStatus: map[f.key] || null,
  }));
}

module.exports = { classifyChanges, annotateWithProposalStatus };
