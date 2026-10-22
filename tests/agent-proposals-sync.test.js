// Site Improvement Agent, Phase 3 — tests for proposals-sync.js, the
// module that syncs PROPOSE_CHANGE/REJECT_OPPORTUNITY findings into the
// live agent_proposals table. Uses a small in-memory fake Supabase
// client injected via `options.client` (proposals-sync.js supports this
// specifically for testing — see its own JSDoc) rather than intercepting
// "@supabase/supabase-js" at require-time, since this module's only
// Supabase touchpoint is the one factory call this test bypasses
// directly.
//
// Run with:  node tests/agent-proposals-sync.test.js

const assert = require("assert");
const { syncProposals, needsOwnerReview } = require("../agent/lib/proposals-sync");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");

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

function decidedFinding(args) {
  const f = classify(makeFinding(args));
  f.research = [];
  Object.assign(f, decide(f));
  return f;
}

class FakeProposalsTable {
  constructor() {
    this.rows = [];
  }
  from(table) {
    assert.strictEqual(table, "agent_proposals");
    return this._query();
  }
  _query() {
    const self = this;
    const state = { eqFilters: [] };
    return {
      select() {
        return this;
      },
      eq(col, val) {
        state.eqFilters.push({ col, val });
        return this;
      },
      async maybeSingle() {
        const row = self.rows.find((r) => state.eqFilters.every((f) => r[f.col] === f.val));
        return { data: row ? { ...row } : null, error: null };
      },
      insert(payload) {
        self.rows.push({ ...payload, id: "id-" + (self.rows.length + 1) });
        return { then: (resolve) => resolve({ error: null }) };
      },
      update(payload) {
        return {
          async eq(col, val) {
            const row = self.rows.find((r) => r[col] === val);
            if (row) Object.assign(row, payload);
            return { error: null };
          },
        };
      },
    };
  }
}

async function main() {
  await test("needsOwnerReview is true only for PROPOSE_CHANGE/REJECT_OPPORTUNITY, never APPLY_SAFE_FIX/RESEARCH_MORE/NO_CHANGE", () => {
    assert.strictEqual(needsOwnerReview({ decision: "PROPOSE_CHANGE" }), true);
    assert.strictEqual(needsOwnerReview({ decision: "REJECT_OPPORTUNITY" }), true);
    assert.strictEqual(needsOwnerReview({ decision: "APPLY_SAFE_FIX" }), false);
    assert.strictEqual(needsOwnerReview({ decision: "RESEARCH_MORE" }), false);
    assert.strictEqual(needsOwnerReview({ decision: "NO_CHANGE" }), false);
  });

  await test("syncProposals is skipped gracefully (never throws) when no client/Supabase config is available", async () => {
    const finding = decidedFinding({ type: "missing-title", summary: "no title", pages: ["a.html"], evidence: [{ x: 1 }] });
    const result = await syncProposals([finding], "run-1", {});
    assert.strictEqual(result.skipped, true);
    assert.ok(result.reason.includes("not configured"));
  });

  await test("syncProposals only syncs findings that actually need owner review, skipping APPLY_SAFE_FIX/RESEARCH_MORE/NO_CHANGE", async () => {
    const table = new FakeProposalsTable();
    const proposeChange = decidedFinding({ type: "missing-canonical", summary: "no canonical", pages: ["a.html"], evidence: [{ x: 1 }] });
    const noChange = decidedFinding({ type: "title-length", summary: "71 chars", pages: ["b.html"], evidence: [{ x: 1 }] });
    const result = await syncProposals([proposeChange, noChange], "run-1", { client: table });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.synced, 1);
    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual(table.rows[0].finding_key, proposeChange.key);
    assert.strictEqual(table.rows[0].status, "proposed");
  });

  await test("syncProposals inserts a NEW finding_key as status 'proposed'", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "duplicate-title", summary: "dup", pages: ["a.html", "b.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    assert.strictEqual(table.rows[0].status, "proposed");
    assert.deepStrictEqual(table.rows[0].pages, ["a.html", "b.html"]);
  });

  await test("syncProposals re-syncing the SAME finding_key with the SAME summary preserves an owner's prior approve/reject decision", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "a.html has no canonical link tag.", pages: ["a.html"], evidence: [{ x: 1 }] });

    await syncProposals([finding], "run-1", { client: table });
    // Simulate the owner approving it through the CRM in between runs.
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    // Same type+pages -> same summary text (seo-audit.js's template is
    // deterministic for identical inputs) -> same finding_key AND the
    // same summary, i.e. genuinely the same observation recurring.
    const finding2 = decidedFinding({ type: "missing-canonical", summary: "a.html has no canonical link tag.", pages: ["a.html"], evidence: [{ x: 1 }] });
    assert.strictEqual(finding2.key, finding.key, "fixture sanity check: same type+pages must produce the same stable key");

    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows.length, 1, "must update the existing row, never insert a second one for the same finding_key");
    assert.strictEqual(table.rows[0].status, "approved", "an unchanged observation must NOT reset the owner's prior review");
    assert.strictEqual(table.rows[0].reviewed_by, "owner@milehighjunkremoval.net", "the owner's review must survive a re-sync when nothing material changed");
  });

  await test("Phase 4 hardening: re-syncing the SAME finding_key with a MATERIALLY DIFFERENT summary resets an already-reviewed proposal back to 'proposed' — an approval never silently carries over onto different content", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "no canonical v1", pages: ["a.html"], evidence: [{ x: 1 }] });

    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";
    table.rows[0].reviewed_at = "2026-10-12T00:00:00.000Z";
    table.rows[0].review_note = "Looks fine.";

    const finding2 = decidedFinding({ type: "missing-canonical", summary: "no canonical v2 — materially different observation", pages: ["a.html"], evidence: [{ x: 1 }] });
    assert.strictEqual(finding2.key, finding.key, "fixture sanity check: same type+pages must still produce the same stable key");

    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual(table.rows[0].summary, "no canonical v2 — materially different observation", "content must refresh");
    assert.strictEqual(table.rows[0].status, "proposed", "a changed observation must require fresh review, never silently inherit the old approval");
    assert.strictEqual(table.rows[0].reviewed_by, null, "the stale review's attribution must be cleared, not left attached to new content");
    assert.strictEqual(table.rows[0].reviewed_at, null);
    assert.strictEqual(table.rows[0].review_note, null);
  });

  await test("Phase 4 hardening: the same reset applies to a REJECTED proposal, not just an approved one", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "rejected";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    const finding2 = decidedFinding({ type: "missing-canonical", summary: "v2 different", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows[0].status, "proposed");
  });

  await test("Phase 4 hardening: a proposal still in 'proposed' (never reviewed) is simply refreshed on content change — nothing to protect yet", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    assert.strictEqual(table.rows[0].status, "proposed");

    const finding2 = decidedFinding({ type: "missing-canonical", summary: "v2 different", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows[0].status, "proposed");
    assert.strictEqual(table.rows[0].summary, "v2 different");
  });

  // --- Pre-acceptance hardening (audit finding #3) -----------------------

  await test("Pre-acceptance hardening (audit finding #3): a decision reversal (PROPOSE_CHANGE -> REJECT_OPPORTUNITY) resets a reviewed proposal back to 'proposed' even when the summary text is UNCHANGED", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "a.html has no canonical link tag.", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";
    table.rows[0].reviewed_at = "2026-10-12T00:00:00.000Z";
    table.rows[0].review_note = "Fine as proposed.";

    // Same summary text, but the DECISION reverses (e.g. new research
    // came back contradicting the opportunity) — decidedFinding() always
    // runs real decide(), so force the reversal explicitly to isolate
    // exactly the scenario under test.
    const finding2 = { ...finding, decision: "REJECT_OPPORTUNITY", reason: "research contradicts this opportunity" };
    assert.strictEqual(finding2.summary, finding.summary, "fixture sanity check: summary text is unchanged");

    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual(table.rows[0].decision, "REJECT_OPPORTUNITY");
    assert.strictEqual(table.rows[0].status, "proposed", "a decision reversal must force fresh review even though the summary text never changed");
    assert.strictEqual(table.rows[0].reviewed_by, null);
    assert.strictEqual(table.rows[0].reviewed_at, null);
    assert.strictEqual(table.rows[0].review_note, null);
  });

  await test("Pre-acceptance hardening (audit finding #3): a MATERIAL research reversal (verdict flips, same decision, same summary) resets a reviewed proposal back to 'proposed'", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "a.html has no canonical link tag.", pages: ["a.html"], evidence: [{ x: 1 }] });
    finding.research = [{ sourceType: "cross-source-synthesis", verdict: "supports-opportunity", confidence: "medium", sufficiency: "partially-corroborated", accessedAt: "2026-10-01T00:00:00.000Z" }];
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    // Same decision, same summary, but the LATEST EFFECTIVE research
    // verdict materially reverses (stale-support supersession writing a
    // later, contradicting/inconclusive result — see
    // agent/lib/cross-source-synthesis.js).
    const finding2 = {
      ...finding,
      research: [...finding.research, { sourceType: "cross-source-synthesis", verdict: "inconclusive", confidence: "low", sufficiency: "unsupported", accessedAt: "2026-10-08T00:00:00.000Z" }],
    };
    assert.strictEqual(finding2.summary, finding.summary);
    assert.strictEqual(finding2.decision, finding.decision);

    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows[0].status, "proposed", "a material research-verdict reversal must force fresh review, even with an unchanged decision/summary");
    assert.strictEqual(table.rows[0].reviewed_by, null);
  });

  await test("Pre-acceptance hardening (audit finding #3): a NON-MATERIAL re-sync (identical decision/summary/evidence/latest-effective-research-verdict, only the underlying research array's provenance/order/timestamp differs) does NOT reset a reviewed proposal", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "a.html has no canonical link tag.", pages: ["a.html"], evidence: [{ x: 1 }] });
    finding.research = [{ sourceType: "cross-source-synthesis", verdict: "supports-opportunity", confidence: "medium", sufficiency: "partially-corroborated", accessedAt: "2026-10-01T00:00:00.000Z", evidence: ["gsc: supports — detail A"] }];
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";
    table.rows[0].reviewed_at = "2026-10-12T00:00:00.000Z";
    table.rows[0].review_note = "Looks fine.";

    // A later run re-confirms the SAME conclusion under a NEWER file
    // (research-intake.js never deletes the old one — both now match
    // this findingKey) — same verdict/confidence/sufficiency, only the
    // accessedAt/evidence-text provenance differs, and pickLatestResearch()
    // naturally prefers the newer one. This must NOT read as a material
    // change.
    const finding2 = {
      ...finding,
      research: [...finding.research, { sourceType: "cross-source-synthesis", verdict: "supports-opportunity", confidence: "medium", sufficiency: "partially-corroborated", accessedAt: "2026-10-05T00:00:00.000Z", evidence: ["gsc: supports — detail A (re-confirmed)"] }],
    };

    await syncProposals([finding2], "run-2", { client: table });
    assert.strictEqual(table.rows[0].status, "approved", "re-confirming the SAME conclusion under new provenance/timestamps must NOT reset an owner's prior review");
    assert.strictEqual(table.rows[0].reviewed_by, "owner@milehighjunkremoval.net");
    assert.strictEqual(table.rows[0].reviewed_at, "2026-10-12T00:00:00.000Z");
    assert.strictEqual(table.rows[0].review_note, "Looks fine.");
  });

  // --- Pre-acceptance hardening (audit finding #4) -----------------------

  await test("Pre-acceptance hardening (audit finding #4): a finding that drops out of the owner-review set (decision moves to NO_CHANGE) is simply left untouched in the DB — the approved row is never silently mutated by a sync that doesn't include it", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    // The finding is now NO_CHANGE (e.g. stale-support supersession) —
    // needsOwnerReview() correctly excludes it from `toSync`.
    const resolvedFinding = { ...finding, decision: "NO_CHANGE" };
    const result = await syncProposals([resolvedFinding], "run-2", { client: table });
    assert.strictEqual(result.total, 0, "a NO_CHANGE finding must never be in toSync");
    assert.strictEqual(table.rows[0].status, "approved", "the existing row is left exactly as it was — this run simply never touches it");
    assert.strictEqual(table.rows[0].reviewed_by, "owner@milehighjunkremoval.net");
  });

  await test("Pre-acceptance hardening (audit finding #4): a finding that drops to RESEARCH_MORE is likewise left untouched (not synced), same as NO_CHANGE", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";

    const researchMoreFinding = { ...finding, decision: "RESEARCH_MORE" };
    const result = await syncProposals([researchMoreFinding], "run-2", { client: table });
    assert.strictEqual(result.total, 0);
    assert.strictEqual(table.rows[0].status, "approved");
  });

  await test("Pre-acceptance hardening (audit finding #4): a proposal that REAPPEARS in the owner-review set after being absent from the immediately preceding run returns to 'proposed' — it must NOT silently inherit the old approval, even when content happens to be identical", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    // Run 2: this finding_key was NOT in the owner-review set (it had
    // gone quiet — e.g. NO_CHANGE for a run or two). previousOwnerReviewKeys
    // reflects that absence.
    const previousOwnerReviewKeysWhenAbsent = new Set(); // this key was NOT present
    // Run 2 doesn't even call syncProposals with this finding (it wasn't
    // in toSync while absent) — jump straight to run 3, where it
    // reappears with IDENTICAL content to what was approved.
    const reappeared = { ...finding };
    const result = await syncProposals([reappeared], "run-3", { client: table, previousOwnerReviewKeys: previousOwnerReviewKeysWhenAbsent });
    assert.strictEqual(table.rows.length, 1, "must update the existing row, never insert a second one");
    assert.strictEqual(table.rows[0].status, "proposed", "reappearing after an absence must require fresh review, even though the content is byte-identical to what was approved before");
    assert.strictEqual(table.rows[0].reviewed_by, null, "the stale approval's attribution must be cleared");
    assert.strictEqual(result.statusByKey[finding.key], "proposed");
  });

  await test("Pre-acceptance hardening (audit finding #4): a proposal that was CONTINUOUSLY present in every run's owner-review set is NOT treated as 'reappearing' — previousOwnerReviewKeys containing its key must not force a reset on its own", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    const previousOwnerReviewKeysWhenPresent = new Set([finding.key]);
    await syncProposals([finding], "run-2", { client: table, previousOwnerReviewKeys: previousOwnerReviewKeysWhenPresent });
    assert.strictEqual(table.rows[0].status, "approved", "a continuously-present, content-unchanged proposal must not be reset merely because previousOwnerReviewKeys was supplied");
    assert.strictEqual(table.rows[0].reviewed_by, "owner@milehighjunkremoval.net");
  });

  await test("Pre-acceptance hardening (audit finding #4): when previousOwnerReviewKeys is not supplied at all (e.g. an older caller, or genuinely unknown), reappearance detection fails safe and never forces a reset on its own", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    await syncProposals([finding], "run-2", { client: table }); // no previousOwnerReviewKeys option at all
    assert.strictEqual(table.rows[0].status, "approved", "absence of previousOwnerReviewKeys information must never itself trigger a reset");
  });

  await test("syncProposals never writes finding_key/finding_type/pages/evidence via the UPDATE path's payload keys that the DB grants don't allow (defense-in-depth check on this module's own payload shape)", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    const finding2 = decidedFinding({ type: "missing-canonical", summary: "v2", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding2], "run-2", { client: table });
    // The real UPDATE grant (sql/2026-10-12_phase3-agent-proposals.sql)
    // excludes finding_key from the column list — this just proves this
    // module's own update payload never tries to send it either.
    assert.strictEqual(table.rows[0].finding_key, finding.key, "finding_key itself must be stable/unchanged across re-syncs");
  });

  await test("Phase 14: syncProposals copies a finding's .autoFix onto the row as proposed_fix when present (e.g. a medium-risk mechanical rewrite that stays PROPOSE_CHANGE rather than auto-applying)", async () => {
    const table = new FakeProposalsTable();
    const fix = { kind: "rewrite-href", file: "a.html", from: "/old-url", to: "/new-url.html" };
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }], autoFix: fix });
    assert.strictEqual(finding.decision, "PROPOSE_CHANGE", "medium risk + autoFix must still require approval, not auto-apply");
    await syncProposals([finding], "run-1", { client: table });
    assert.deepStrictEqual(table.rows[0].proposed_fix, fix);
  });

  await test("Phase 14: syncProposals writes proposed_fix as null for every finding without an autoFix (every real finding type today)", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table });
    assert.strictEqual(table.rows[0].proposed_fix, null);
  });

  await test("Phase 14: a reviewed proposal is reset back to 'proposed' if its proposed_fix changes, even when decision/summary/evidence stay identical", async () => {
    const table = new FakeProposalsTable();
    const fixA = { kind: "rewrite-href", file: "a.html", from: "/old-url", to: "/new-url-a.html" };
    const fixB = { kind: "rewrite-href", file: "a.html", from: "/old-url", to: "/new-url-b.html" };
    const findingA = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }], autoFix: fixA });
    await syncProposals([findingA], "run-1", { client: table });
    table.rows[0].status = "approved";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";

    const findingB = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }], autoFix: fixB });
    await syncProposals([findingB], "run-2", { client: table, previousOwnerReviewKeys: new Set([findingA.key]) });
    assert.strictEqual(table.rows[0].status, "proposed", "a changed proposed_fix is material and must reset a prior approval");
    assert.deepStrictEqual(table.rows[0].proposed_fix, fixB);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
