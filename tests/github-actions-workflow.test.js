// Website Agent — GitHub Actions unattended runner, Phase 7.
//
// Static/regression tests for .github/workflows/website-agent.yml's
// invariants — deliberately text/regex-based rather than a YAML-parsing
// dependency (this repo adds no new dependencies for this, matching the
// Agent's own existing no-SDK philosophy). Each test targets ONE
// specific requirement from the brief for this initial, manual-only
// phase of the runner, so a future edit that quietly reintroduces a
// schedule, drops a permission, or lets the job commit the whole
// working tree fails a specific, named test rather than just "the YAML
// changed".
//
// Run with:  node tests/github-actions-workflow.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "website-agent.yml");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

// Strips full-line YAML comments (this file's own explanatory prose,
// which legitimately mentions things like "schedule:" and
// "--apply-safe" IN COMMENTS) so structural checks below only see real
// YAML, never prose that happens to contain the same words.
function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

async function main() {
  assert.ok(fs.existsSync(WORKFLOW_PATH), `expected a workflow file at ${WORKFLOW_PATH}`);
  const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const code = stripComments(raw);

  await test("defines workflow_dispatch with a daily/weekly run_type input, defaulted to daily", () => {
    assert.ok(/\bworkflow_dispatch:/.test(code));
    assert.ok(/run_type:/.test(code));
    assert.ok(/-\s*daily/.test(code) && /-\s*weekly/.test(code));
    assert.ok(/default:\s*daily/.test(code));
  });

  await test("does NOT define a schedule/cron trigger yet (manual-dispatch only, this phase)", () => {
    assert.strictEqual(/^\s*schedule:/m.test(code), false, "a top-level `schedule:` trigger key must not exist yet");
    assert.strictEqual(/\bcron:/.test(code), false, "no cron expression should exist anywhere in the workflow");
  });

  await test("requests id-token: write and contents: write permissions, and nothing broader", () => {
    const permsBlockMatch = code.match(/permissions:\n([\s\S]*?)\n\S/);
    assert.ok(/id-token:\s*write/.test(code));
    assert.ok(/contents:\s*write/.test(code));
    // A non-empty top-level `permissions:` map implicitly sets every
    // OTHER scope to "none" — so just asserting these two keys exist
    // (and that no third permission key was added) is enough to prove
    // least-privilege, without needing a YAML parser.
    const permissionKeys = [...code.matchAll(/^  (\w[\w-]*):\s*(write|read|none)\s*$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(new Set(permissionKeys), new Set(["contents", "id-token"]), "no permission scopes beyond contents/id-token should be requested");
  });

  await test("has a concurrency group covering the whole workflow (daily and weekly serialized against each other), not cancel-in-progress", () => {
    assert.ok(/concurrency:/.test(code));
    assert.ok(/group:\s*website-agent-runner/.test(code));
    assert.ok(/cancel-in-progress:\s*false/.test(code));
  });

  await test("has a job-level timeout-minutes set", () => {
    assert.ok(/timeout-minutes:\s*\d+/.test(code));
  });

  await test("invokes the Agent with --daily/--weekly only — never --apply-safe (mutation stays disabled)", () => {
    const invocationLines = code.split("\n").filter((l) => /agent\/cli\.js/.test(l));
    assert.ok(invocationLines.length >= 1, "expected at least one agent/cli.js invocation");
    for (const line of invocationLines) {
      assert.strictEqual(/apply-safe/.test(line), false, `agent/cli.js invocation must never pass --apply-safe: "${line.trim()}"`);
    }
    assert.ok(invocationLines.some((l) => /RUN_TYPE/.test(l) || /--daily|--weekly/.test(l)));
  });

  await test("fails fast with a clear error if SUPABASE_URL/SUPABASE_SECRET_KEY secrets are missing, before running the Agent", () => {
    assert.ok(/secrets\.SUPABASE_URL/.test(code));
    assert.ok(/secrets\.SUPABASE_SECRET_KEY/.test(code));
    assert.ok(/::error::/.test(code));
    const supabaseCheckIdx = code.indexOf("SUPABASE_URL");
    const agentRunIdx = code.indexOf("agent/cli.js");
    assert.ok(supabaseCheckIdx > -1 && agentRunIdx > -1 && supabaseCheckIdx < agentRunIdx, "the Supabase configuration check must appear before the Agent is run");
  });

  await test("fails fast if the Workload Identity Federation provider / impersonation target aren't configured", () => {
    assert.ok(/vars\.GCP_WORKLOAD_IDENTITY_PROVIDER/.test(code));
    assert.ok(/vars\.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT/.test(code));
  });

  await test("authenticates via google-github-actions/auth using Workload Identity Federation, with no service_account impersonation input (avoids redundant impersonation)", () => {
    assert.ok(/uses:\s*google-github-actions\/auth@v\d/.test(code));
    assert.ok(/workload_identity_provider:/.test(code));
    assert.strictEqual(/service_account:/.test(code), false, "the auth action must not also impersonate a service account — google-auth.js's own impersonation tier (GOOGLE_IMPERSONATE_SERVICE_ACCOUNT) already does this, per-scope");
  });

  await test("never stages the whole working tree — only the dedicated safe-commit script may decide what to commit", () => {
    assert.ok(/safe-commit\.js/.test(code), "expected the workflow to call .github/scripts/safe-commit.js");
    assert.strictEqual(/git add -A/.test(code), false);
    assert.strictEqual(/git add \./.test(code), false);
    assert.strictEqual(/git commit/.test(code), false, "the workflow itself must never run `git commit` directly — only safe-commit.js may, after its allowlist/credential checks");
  });

  await test("never force-pushes and never rewrites history", () => {
    assert.strictEqual(/push.*--force/i.test(code), false);
    assert.strictEqual(/push\s+-f\b/.test(code), false);
    assert.strictEqual(/\brebase\b/.test(code), false);
  });

// Extracts one step's YAML block from a `- name:` line (matched by
// `nameMatcher`) up to (but not including) the next `- name:` line, so
// a test can assert on exactly that step's own `id:`/`if:`/`run:`
// without false-matching some unrelated step.
function extractStepBlock(code, nameMatcher) {
  const lines = code.split("\n");
  const startIdx = lines.findIndex((l) => /^\s*- name:/.test(l) && nameMatcher.test(l));
  assert.ok(startIdx > -1, `expected to find a step matching ${nameMatcher}`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

await test("the safe-commit (persist) step has an explicit id and runs even if the Agent step failed (if: always()), so a failed-run record is still persisted", () => {
  const block = extractStepBlock(code, /Persist Agent artifacts/);
  assert.ok(/id:\s*persist\b/.test(block), "the persist step needs a stable id so the Push step can gate on its outcome");
  assert.ok(/if:\s*always\(\)/.test(block), "the persist step should still run with if: always()");
});

await test("Push to main is gated on the persist step's own outcome — NOT merely a bare if: always()", () => {
  const block = extractStepBlock(code, /Push to main/);
  assert.ok(/steps\.persist\.outcome\s*==\s*['"]success['"]/.test(block), 'the Push step must check steps.persist.outcome == "success" before running');
  // always() alone is insufficient (that was the actual bug this test
  // guards against — see tests/github-actions-safe-commit.test.js's
  // identity-regression history): assert the if: condition is NOT
  // *just* always() with nothing else.
  const ifLineMatch = block.match(/if:\s*(.+)/);
  assert.ok(ifLineMatch, "Push to main must have an explicit if: condition");
  assert.notStrictEqual(ifLineMatch[1].trim(), "always()", "Push to main must not run on a bare always() — it must also require persist to have succeeded");
});

await test("Phase 7B: the rotation-evidence refresh step exists, runs ONLY for weekly dispatches, runs BEFORE the main Agent step, and is not itself apply-safe/mutating", () => {
  const lines = code.split("\n");
  const stepIdx = lines.findIndex((l) => /^\s*- name:/.test(l) && /Refresh weekly rotation evidence/.test(l));
  assert.ok(stepIdx > -1, "expected a step that refreshes weekly rotation evidence");
  const block = extractStepBlock(code, /Refresh weekly rotation evidence/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]weekly['"]/.test(block), "must be gated to weekly dispatches only — a daily run must never attempt this");
  assert.ok(/--refresh-rotation-evidence/.test(block));
  assert.strictEqual(/apply-safe/.test(block), false);

  const mainRunIdx = lines.findIndex((l) => /^\s*- name:/.test(l) && /Run Website Agent/.test(l));
  assert.ok(mainRunIdx > stepIdx, "rotation-evidence refresh must run BEFORE the main --daily/--weekly Agent pass, mirroring --refresh-completed-jobs's precedent");
});

await test("Phase 7D: the diagnostic-golden-search-console run_type option exists alongside daily/weekly, which stay unchanged", () => {
  assert.ok(/-\s*diagnostic-golden-search-console/.test(code), "expected a diagnostic-golden-search-console option on the run_type input");
  assert.ok(/-\s*daily/.test(code) && /-\s*weekly/.test(code), "daily/weekly options must still exist, unchanged");
  assert.ok(/default:\s*daily/.test(code), "default must still be daily — the diagnostic is opt-in only, never the default");
});

await test("Phase 7D: the Golden diagnostic step (1) reuses the EXISTING --fetch-firstparty path (the strict variant) against the committed request file — no new Google client/path", () => {
  const block = extractStepBlock(code, /Run Golden Search Console diagnostic/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]diagnostic-golden-search-console['"]/.test(block), "must be gated to the diagnostic run_type only");
  assert.ok(/--fetch-firstparty-strict=agent\/diagnostics\/golden-search-console-request\.json/.test(block), "must invoke the existing --fetch-firstparty-strict path against the committed, reviewable request file");
  assert.strictEqual(/--fetch-firstparty=/.test(block.replace("--fetch-firstparty-strict=", "")), false, "must use the STRICT variant, not the plain orchestrator-facing one (a config/auth/API failure must fail this job)");
  assert.ok(/GOOGLE_IMPERSONATE_SERVICE_ACCOUNT:\s*\$\{\{\s*vars\.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT\s*\}\}/.test(block), "must use the SAME GOOGLE_IMPERSONATE_SERVICE_ACCOUNT variable production runs use — no separate/local credential path");
  assert.ok(/GSC_SITE_URL:\s*\$\{\{\s*vars\.GSC_SITE_URL\s*\}\}/.test(block));
});

await test("Phase 7D: the Golden diagnostic step (4) is not marked continue-on-error — an auth/API/config failure (strict-mode exit 1) must fail the job visibly, not return green", () => {
  const block = extractStepBlock(code, /Run Golden Search Console diagnostic/);
  assert.strictEqual(/continue-on-error/.test(block), false);
});

await test("Phase 7D: the diagnostic (2) can never reach rotation state — --refresh-rotation-evidence/--weekly are never invoked for it, and the rotation-evidence step stays gated to weekly only", () => {
  const diagnosticBlock = extractStepBlock(code, /Run Golden Search Console diagnostic/);
  assert.strictEqual(/--refresh-rotation-evidence/.test(diagnosticBlock), false);
  assert.strictEqual(/--weekly/.test(diagnosticBlock), false);
  // The ONLY step that ever calls --refresh-rotation-evidence remains
  // gated to weekly alone (re-asserted here, not just in the Phase 7B
  // test above, because this is exactly the invariant that keeps the
  // diagnostic from ever mutating research-rotation-state.json).
  const rotationBlock = extractStepBlock(code, /Refresh weekly rotation evidence/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]weekly['"]/.test(rotationBlock));
});

await test("Phase 7D: the diagnostic (3) can never run the ordinary Agent pipeline, so it can never create/apply a proposal or make a website change — the main Agent step is gated to daily/weekly only", () => {
  const mainAgentBlock = extractStepBlock(code, /Run Website Agent \(\$\{\{ inputs\.run_type \}\}\)/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]daily['"]\s*\|\|\s*inputs\.run_type\s*==\s*['"]weekly['"]/.test(mainAgentBlock), "the --daily/--weekly Agent pass must be gated OUT for the diagnostic run_type");
  const diagnosticBlock = extractStepBlock(code, /Run Golden Search Console diagnostic/);
  assert.strictEqual(/--daily/.test(diagnosticBlock), false);
  assert.strictEqual(/apply-safe/.test(diagnosticBlock), false);
});

await test("Phase 7D: the diagnostic's own Supabase-config check is skipped (irrelevant — no Agent pipeline, no proposal sync ever runs for it)", () => {
  const block = extractStepBlock(code, /Verify required Supabase configuration/);
  assert.ok(/if:\s*inputs\.run_type\s*!=\s*['"]diagnostic-golden-search-console['"]/.test(block));
  assert.ok(/if:\s*inputs\.run_type\s*!=\s*['"]diagnostic-golden-search-console['"]\s*&&\s*inputs\.run_type\s*!=\s*['"]diagnostic-golden-ga4['"]/.test(block), "the Supabase check must also be skipped for the GA4 diagnostic — same reasoning as the Search Console one");
});

await test("Phase 7E: the diagnostic-golden-ga4 run_type option exists alongside daily/weekly/diagnostic-golden-search-console, which stay unchanged", () => {
  assert.ok(/-\s*diagnostic-golden-ga4/.test(code), "expected a diagnostic-golden-ga4 option on the run_type input");
  assert.ok(/-\s*diagnostic-golden-search-console/.test(code), "the existing Search Console diagnostic option must still exist, unchanged");
  assert.ok(/-\s*daily/.test(code) && /-\s*weekly/.test(code), "daily/weekly options must still exist, unchanged");
  assert.ok(/default:\s*daily/.test(code), "default must still be daily — the GA4 diagnostic is opt-in only, never the default");
});

await test("Phase 7E: the Golden GA4 diagnostic step (1) reuses the EXISTING --fetch-firstparty path (the strict variant) against its own committed request file — no new Google client/path, no second GA4 networking implementation", () => {
  const block = extractStepBlock(code, /Run Golden GA4 diagnostic/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]diagnostic-golden-ga4['"]/.test(block), "must be gated to the GA4 diagnostic run_type only");
  assert.ok(/--fetch-firstparty-strict=agent\/diagnostics\/golden-ga4-request\.json/.test(block), "must invoke the existing --fetch-firstparty-strict path against the committed, reviewable GA4 request file");
  assert.strictEqual(/--fetch-firstparty=/.test(block.replace("--fetch-firstparty-strict=", "")), false, "must use the STRICT variant, not the plain orchestrator-facing one (a config/auth/API failure must fail this job)");
  assert.ok(/GOOGLE_IMPERSONATE_SERVICE_ACCOUNT:\s*\$\{\{\s*vars\.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT\s*\}\}/.test(block), "must use the SAME GOOGLE_IMPERSONATE_SERVICE_ACCOUNT variable production runs use — no separate/local credential path");
  assert.ok(/GA4_PROPERTY_ID:\s*\$\{\{\s*vars\.GA4_PROPERTY_ID\s*\}\}/.test(block));
  assert.strictEqual(/GSC_SITE_URL/.test(block), false, "the GA4 diagnostic has no business referencing GSC_SITE_URL — that belongs only to the Search Console diagnostic");
});

await test("Phase 7E: the Golden GA4 diagnostic step is not marked continue-on-error — an auth/API/config failure (strict-mode exit 1) must fail the job visibly, not return green", () => {
  const block = extractStepBlock(code, /Run Golden GA4 diagnostic/);
  assert.strictEqual(/continue-on-error/.test(block), false);
});

await test("Phase 7E: the GA4 diagnostic can never reach rotation state — --refresh-rotation-evidence/--weekly are never invoked for it, and the rotation-evidence step stays gated to weekly only", () => {
  const diagnosticBlock = extractStepBlock(code, /Run Golden GA4 diagnostic/);
  assert.strictEqual(/--refresh-rotation-evidence/.test(diagnosticBlock), false);
  assert.strictEqual(/--weekly/.test(diagnosticBlock), false);
  const rotationBlock = extractStepBlock(code, /Refresh weekly rotation evidence/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]weekly['"]/.test(rotationBlock));
});

await test("Phase 7E: the GA4 diagnostic can never run the ordinary Agent pipeline, so it can never create/apply a proposal or make a website change — the main Agent step stays gated to daily/weekly only", () => {
  const mainAgentBlock = extractStepBlock(code, /Run Website Agent \(\$\{\{ inputs\.run_type \}\}\)/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]daily['"]\s*\|\|\s*inputs\.run_type\s*==\s*['"]weekly['"]/.test(mainAgentBlock), "the --daily/--weekly Agent pass must be gated OUT for every diagnostic run_type, including the new GA4 one");
  const diagnosticBlock = extractStepBlock(code, /Run Golden GA4 diagnostic/);
  assert.strictEqual(/--daily/.test(diagnosticBlock), false);
  assert.strictEqual(/apply-safe/.test(diagnosticBlock), false);
});

await test("Phase 7E: the GA4 diagnostic step runs AFTER the Search Console diagnostic step and does not alter its gating — the two diagnostics are independent, mutually exclusive run_type values, never both active in one dispatch", () => {
  const lines = code.split("\n");
  const gscIdx = lines.findIndex((l) => /^\s*- name:/.test(l) && /Run Golden Search Console diagnostic/.test(l));
  const ga4Idx = lines.findIndex((l) => /^\s*- name:/.test(l) && /Run Golden GA4 diagnostic/.test(l));
  assert.ok(gscIdx > -1 && ga4Idx > -1);
  assert.ok(ga4Idx > gscIdx, "expected the GA4 diagnostic step to be declared after the Search Console diagnostic step");
  const gscBlock = extractStepBlock(code, /Run Golden Search Console diagnostic/);
  assert.ok(/if:\s*inputs\.run_type\s*==\s*['"]diagnostic-golden-search-console['"]/.test(gscBlock), "the Search Console diagnostic's own gating must be unaffected by adding the GA4 diagnostic");
});

  await test("checks out the repo and installs dependencies via npm ci (lockfile-respecting)", () => {
    assert.ok(/uses:\s*actions\/checkout@v\d/.test(code));
    assert.ok(/npm ci\b/.test(code));
  });

  await test("uses Node 24, matching this project's deployed runtime (vercel.json nodeVersion \"24.x\")", () => {
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".vercel", "project.json"), "utf8"));
    assert.ok(vercelConfig.settings.nodeVersion.startsWith("24"), "sanity-check: .vercel/project.json's own nodeVersion should still be 24.x");
    assert.ok(/node-version:\s*["']?24["']?/.test(code));
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
