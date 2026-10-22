// Site Improvement Agent — Phase 14 execution-pipeline test-only audit.
//
// Exists SOLELY to let the Phase 14 execution engine
// (agent/lib/execute-proposal.js) be tested end-to-end against the real
// agent_proposals approve/execute pipeline, without ever touching a real
// finding type, a real page, or a real risk/decision rule.
//
// Why this is needed: every REAL finding type that carries a
// `rewrite-href` autoFix today (redirect-hop-internal-link,
// broken-internal-link-fixable — see link-audit.js) is risk.js's
// riskLevel:"low" + tier:"actionable", which classify() makes
// unconditionally autoApplyEligible. That routes it to decision
// APPLY_SAFE_FIX, which proposals-sync.js's needsOwnerReview() excludes
// from agent_proposals entirely (see that module's own header). So there
// is today no real finding that is BOTH synced to agent_proposals AND
// carries a supported autoFix — execute-proposal.js's own header already
// says as much. Phase 14 has no real finding it could ever be tested
// against.
//
// This module closes that gap with narrow, self-contained,
// self-expiring fixtures: it reads each dedicated file in FIXTURE_FILES
// below (none of them scanned marketing pages, linked, indexed, or in
// any sitemap) and, for each one that still contains the exact sentinel
// href, emits one finding of a brand-new type
// ("execution-pipeline-test-fixture") that risk.js classifies as
// riskLevel:"medium" (see that file's matching RULES entry) — NOT "low"
// — so it is NEVER autoApplyEligible despite carrying an autoFix, and
// decision.js resolves it to PROPOSE_CHANGE exactly like a real
// human-reviewed proposal. Once a given fixture's fix is actually
// applied (its sentinel href rewritten), THAT fixture stops producing a
// finding on every subsequent run — nothing to clean up afterward.
//
// Multiple entries in FIXTURE_FILES deliberately exist as independent
// controlled tests: a finding's `key` (agent/lib/findings.js's
// makeKey()) is derived from type + PAGES ONLY, never from content — so
// two fixtures with byte-identical content but different paths get two
// different finding_keys, and therefore two independent agent_proposals
// rows. This is what lets a second controlled execution test be run
// (its own, fresh proposal id) without ever touching an earlier
// fixture's proposal — e.g. one deliberately left at needs_review as an
// audit record (proposals-sync.js only ever resets a REVIEWED
// approved/rejected row back to "proposed" on content drift; a
// needs_review row is never auto-reset by a resync, by design — see
// that module's own header).
//
// Never touches any real page, any real finding type, or any real risk
// rule. Safe to delete this file, risk.js's one matching RULES entry,
// its require() in runner.js, and any/all of the fixture files
// themselves at any time, with zero effect on any other finding.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeFinding } = require("./findings");

const FIXTURE_FILES = [
  "agent/test-fixtures/execution-pipeline-test.html",
  "agent/test-fixtures/execution-pipeline-test-2.html",
];
const SENTINEL_HREF = "/execution-test-placeholder";
const FIXED_HREF = "/execution-test-placeholder-fixed";

function auditExecutionTestFixture() {
  const findings = [];
  for (const file of FIXTURE_FILES) {
    const fullPath = path.join(config.SITE_ROOT, file);
    if (!fs.existsSync(fullPath)) continue;

    const html = fs.readFileSync(fullPath, "utf8");
    const needle = `href="${SENTINEL_HREF}"`;
    if (!html.includes(needle)) continue;

    findings.push(
      makeFinding({
        type: "execution-pipeline-test-fixture",
        summary: `Test fixture ${file} still contains its placeholder link ("${SENTINEL_HREF}") — a Phase 14 execution-pipeline test proposal, not a real site issue.`,
        pages: [file],
        evidence: [{ file, field: "testSentinelHref", value: SENTINEL_HREF }],
        recommendation: `Test-only: rewrite the sentinel href in ${file} from "${SENTINEL_HREF}" to "${FIXED_HREF}" to exercise the Phase 14 execution engine end-to-end.`,
        autoFix: {
          kind: "rewrite-href",
          file,
          from: SENTINEL_HREF,
          to: FIXED_HREF,
        },
      })
    );
  }
  return findings;
}

module.exports = { auditExecutionTestFixture, FIXTURE_FILES, SENTINEL_HREF, FIXED_HREF };
