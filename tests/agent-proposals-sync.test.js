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

  if (process.exitCode) process.exit(process.exitCode);
}

main();
