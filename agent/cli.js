#!/usr/bin/env node
// Site Improvement Agent — CLI entry point.
//
//   node agent/cli.js                 dry-run (default, always safe)
//   node agent/cli.js --dry-run       same, explicit
//   node agent/cli.js --apply-safe    additionally applies the narrow
//                                     auto-fix whitelist (refuses if the
//                                     working tree is dirty)
//   node agent/cli.js --json          print the full run record as JSON
//                                     instead of the human summary

const { run } = require("./runner");

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--apply-safe") ? "apply-safe" : "dry-run";
  const asJson = args.includes("--json");

  const record = await run({ mode });

  if (asJson) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  console.log(`Site Improvement Agent — run ${record.runId} (${record.mode})`);
  console.log(`Scanned ${record.summary.pagesScanned} pages, ${record.summary.findingsTotal} finding(s).`);
  if (record.applySkippedReason) {
    console.log(`NOTE: ${record.applySkippedReason}`);
  }
  console.log(`By category: ${JSON.stringify(record.summary.byCategory)}`);
  console.log(`By decision: ${JSON.stringify(record.summary.byDecision)}`);
  console.log(`Auto-applied: ${record.summary.autoApplied}, Proposed: ${record.summary.proposed}, Research questions raised: ${record.summary.researchQuestionsRaised}`);
  if (record.validation.performed) {
    console.log(`Post-apply validation: ${record.validation.confirmed} confirmed-resolved, ${record.validation.reverted} reverted automatically.`);
  }
  if (record.proposalsSync.skipped) {
    console.log(`CRM proposal sync: skipped (${record.proposalsSync.reason}).`);
  } else {
    console.log(`CRM proposal sync: ${record.proposalsSync.synced}/${record.proposalsSync.total} synced.`);
  }
  console.log("");

  if (record.findings.length === 0) {
    console.log("No worthwhile change today.");
    return;
  }

  for (const f of record.findings) {
    const tag = f.status === "applied" ? "[APPLIED]" : `[${f.category}/${f.riskLevel} -> ${f.decision}]`;
    console.log(`${tag} ${f.type}: ${f.summary}`);
    console.log(`    reason: ${f.decisionReason}`);
    if (f.decision === "RESEARCH_MORE" && f.researchQuestion) {
      console.log(`    research question: ${f.researchQuestion.question}`);
    }
    if (f.recommendation) console.log(`    -> ${f.recommendation}`);
  }
}

main().catch((err) => {
  console.error("Site Improvement Agent run failed:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
