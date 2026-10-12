// Site Improvement Agent — post-change validation.
//
// Closes the loop on the Phase 1 auto-apply whitelist: after
// rewrite-href.apply() changes a file, this module re-scans the site and
// confirms (a) the original issue is actually gone and (b) the new href
// doesn't itself now show up as broken (a regression). Git is the
// underlying rollback mechanism — no separate backup/snapshot system is
// built here — but since the whole point of "safe mechanical fix" is that
// its inverse is exactly as mechanical and verifiable as the forward fix,
// an automatic revert is done the same way the fix itself was: one more
// call to rewrite-href.apply(), with `from`/`to` swapped.

const rewriteHref = require("./apply/rewrite-href");

/**
 * @param {object} appliedFinding - a finding whose status is "applied" (has .autoFix and .appliedResult)
 * @param {object[]} rescannedFindings - fresh findings from re-running the full audit pipeline AFTER the fix
 */
function validateAppliedFinding(appliedFinding, rescannedFindings) {
  const { file, from, to } = appliedFinding.autoFix;
  const page = appliedFinding.pages[0];

  const stillBroken = rescannedFindings.some(
    (f) =>
      f.pages.includes(page) &&
      (f.type === "broken-internal-link" || f.type === "broken-internal-link-fixable" || f.type === "redirect-hop-internal-link") &&
      f.evidence.some((e) => e.value === from)
  );
  if (stillBroken) {
    return { status: "fix-not-verified", reason: `re-scan still shows "${from}" as an issue on ${page} after the fix was applied` };
  }

  const newRegression = rescannedFindings.some(
    (f) => f.pages.includes(page) && f.type === "broken-internal-link" && f.evidence.some((e) => e.value === to)
  );
  if (newRegression) {
    return { status: "regression-detected", reason: `the rewritten link "${to}" on ${page} is now itself reported broken` };
  }

  return { status: "confirmed-resolved", reason: `re-scan confirms "${from}" no longer appears as an issue on ${page}, and "${to}" is not broken` };
}

/**
 * Validates every applied finding and, for any that fail, automatically
 * reverts it (deterministic: the exact inverse of the mechanical fix that
 * was just applied) and marks it accordingly. Returns the updated list of
 * applied findings plus a summary count.
 */
function validateAndRevertIfNeeded(appliedFindings, rescanFn) {
  if (appliedFindings.length === 0) {
    return { validated: [], reverted: 0, confirmed: 0 };
  }

  const rescannedFindings = rescanFn();
  let reverted = 0;
  let confirmed = 0;

  for (const finding of appliedFindings) {
    const validation = validateAppliedFinding(finding, rescannedFindings);
    finding.validation = validation;

    if (validation.status === "confirmed-resolved") {
      confirmed += 1;
      continue;
    }

    // fix-not-verified or regression-detected: revert automatically,
    // since the inverse rewrite is exactly as safe/deterministic as the
    // forward one was (same single-unambiguous-occurrence guard).
    const revertResult = rewriteHref.apply({
      file: finding.autoFix.file,
      from: finding.autoFix.to,
      to: finding.autoFix.from,
    });

    if (revertResult.changed) {
      finding.status = "reverted";
      finding.revertResult = revertResult;
      reverted += 1;
    } else {
      // The revert itself couldn't proceed deterministically (e.g. the
      // file changed again in the meantime) — stop pretending this
      // succeeded and require a human to look at it, per the product
      // spec's "otherwise stop and require review."
      finding.status = "apply-failed-requires-review";
      finding.revertResult = revertResult;
    }
  }

  return { validated: appliedFindings, reverted, confirmed };
}

module.exports = { validateAppliedFinding, validateAndRevertIfNeeded };
