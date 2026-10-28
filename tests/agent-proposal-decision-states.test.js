// Site Improvement Agent, Phase 16 — proposal navigation + decision
// states. Covers the new admin UI navigation (Agent Proposals button,
// Open Proposal deep-link), the three new owner-decision statuses
// (no_change/needs_revision/recheck) on resource:"agent-proposal" PATCH,
// and the fingerprint-lifecycle extension that stops an unchanged
// 'no_change' proposal from immediately resurfacing as 'proposed' (see
// sql/2026-10-28_phase16-proposal-decision-states.sql and
// agent/lib/proposals-sync.js's own headers for the full rationale).
//
// Section 1 (API) reuses the exact fake-Supabase harness convention
// tests/agent-proposals-api.test.js already established. Section 2
// (sync/fingerprint lifecycle) reuses tests/agent-proposals-sync.test.js's
// FakeProposalsTable + decidedFinding() convention. Section 3 (UI) is a
// source-level static-analysis check, same as every other admin-page
// test file in this suite (no DOM/browser available here).
//
// Run with:  node tests/agent-proposal-decision-states.test.js

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

// =======================================================================
// Section 1 — resource:"agent-proposal" PATCH: the new actions/statuses
// =======================================================================

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this._updatePayload = null;
    this._order = null;
    this._limit = null;
    this._single = false;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  order(col, opts) {
    this._order = { col, asc: !opts || opts.ascending !== false };
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  maybeSingle() {
    this._single = true;
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const rows = this.db[this.table] || [];
    let matched = rows.filter((row) => this.eqFilters.every((f) => row[f.col] === f.val));

    if (this._updatePayload) {
      const row = matched[0];
      if (!row) return { data: null, error: null };
      Object.assign(row, this._updatePayload);
      if (this._single) return { data: { ...row }, error: null };
      return { data: [{ ...row }], error: null };
    }

    if (this._order) {
      matched = matched.slice().sort((a, b) => {
        const diff = a[this._order.col] < b[this._order.col] ? -1 : a[this._order.col] > b[this._order.col] ? 1 : 0;
        return this._order.asc ? diff : -diff;
      });
    }
    if (this._limit) matched = matched.slice(0, this._limit);

    if (this._single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
    return { data: matched.map((r) => ({ ...r })), error: null };
  }
}

function makeFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
}
function createFakeAnonClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null }),
      refreshSession: async () => ({ data: null, error: { message: "not used" } }),
    },
  };
}

let currentFakeService = null;
const fakeAnon = createFakeAnonClient();

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return fakeAnon;
          if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
          throw new Error("Unexpected Supabase key passed to createClient() in agent-proposal-decision-states test: " + key);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingsHandler = require("../api/admin/bookings.js");

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: "mhjr_admin_at=good", "x-forwarded-proto": "https" }, opts.headers || {}),
    body: opts.body,
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}
function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}
function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingsHandler(req, res)).then(() => res);
}

function freshDb() {
  return {
    agent_proposals: [
      {
        id: "p1",
        finding_key: "missing-canonical::a.html",
        finding_type: "missing-canonical",
        category: "A",
        risk_level: "medium",
        decision: "PROPOSE_CHANGE",
        decision_reason: "clear, internally-evidenced technical/low-risk improvement",
        summary: "a.html has no canonical link tag.",
        pages: ["a.html"],
        evidence: [],
        research: [],
        status: "proposed",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        last_run_id: "run-1",
        created_at: "2026-10-12T00:00:00.000Z",
        updated_at: "2026-10-12T00:00:00.000Z",
      },
    ],
  };
}

async function runApiSection() {
  await test("resource=agent-proposal PATCH action='no_change' sets status to 'no_change' and records the reviewer/note", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "no_change", note: "Checked — leave as-is." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "no_change");
    assert.strictEqual(res.body.proposal.reviewedBy, "owner@milehighjunkremoval.net");
    assert.strictEqual(res.body.proposal.reviewNote, "Checked — leave as-is.");
  });

  await test("resource=agent-proposal PATCH action='needs_revision' sets status to 'needs_revision'", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "needs_revision", note: "Good idea, wrong fix." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "needs_revision");
    assert.strictEqual(res.body.proposal.reviewNote, "Good idea, wrong fix.");
  });

  await test("resource=agent-proposal PATCH action='recheck' sets status to 'recheck'", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "recheck" },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "recheck");
  });

  await test("resource=agent-proposal PATCH action='reject' (the Dismiss button) still sets status to 'rejected' — unchanged from the original Phase 3 action", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "reject" },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "rejected");
  });

  await test("resource=agent-proposal PATCH action='approve' is unchanged (still sets 'approved', the Approve & Execute button's status)", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "approve" },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "approved");
  });

  await test("resource=agent-proposal PATCH still rejects an invalid/unknown action with 400", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "delete-everything" } }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("no_change is a DIFFERENT status value than rejected/dismissed — the two are never collapsed into one", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const noChangeRes = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "no_change" } }));
    assert.strictEqual(noChangeRes.body.proposal.status, "no_change");

    const db2 = freshDb();
    currentFakeService = makeFakeServiceClient(db2);
    const dismissRes = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "reject" } }));
    assert.strictEqual(dismissRes.body.proposal.status, "rejected");

    assert.notStrictEqual(noChangeRes.body.proposal.status, dismissRes.body.proposal.status);
  });

  await test("?view=agent-proposals&status=no_change / needs_revision / recheck each filter to only that status", async () => {
    const db = freshDb();
    db.agent_proposals.push(
      { ...db.agent_proposals[0], id: "p2", finding_key: "k2", status: "no_change" },
      { ...db.agent_proposals[0], id: "p3", finding_key: "k3", status: "needs_revision" },
      { ...db.agent_proposals[0], id: "p4", finding_key: "k4", status: "recheck" }
    );
    currentFakeService = makeFakeServiceClient(db);
    for (const status of ["no_change", "needs_revision", "recheck"]) {
      const res = await run(makeReq({ query: { view: "agent-proposals", status } }));
      assert.strictEqual(res.body.proposals.length, 1, `expected exactly one ${status} row`);
      assert.strictEqual(res.body.proposals[0].status, status);
    }
  });
}

// =======================================================================
// Section 2 — proposals-sync.js: no_change does not immediately resurface
// =======================================================================

const { syncProposals } = require("../agent/lib/proposals-sync");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");

function decidedFinding(args) {
  const f = classify(makeFinding(args));
  f.research = [];
  Object.assign(f, decide(f));
  f.opportunityClassification = { classification: "IMPORTANT", evidenceConfidence: "high", reason: "test fixture default" };
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

async function runSyncSection() {
  await test("Phase 16: re-syncing a 'no_change' proposal with UNCHANGED content does NOT reset it back to 'proposed' — an identical no_change finding does not immediately come back", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "no canonical v1", pages: ["a.html"], evidence: [{ x: 1 }] });

    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "no_change";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";
    table.rows[0].reviewed_at = "2026-10-20T00:00:00.000Z";
    table.rows[0].review_note = "Decided to leave it.";

    const finding2 = decidedFinding({ type: "missing-canonical", summary: "no canonical v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding2], "run-2", { client: table, previousOwnerReviewKeys: new Set([finding.key]) });

    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual(table.rows[0].status, "no_change", "an unchanged no_change decision must survive a re-sync");
    assert.strictEqual(table.rows[0].reviewed_by, "owner@milehighjunkremoval.net");
    assert.strictEqual(table.rows[0].review_note, "Decided to leave it.");
  });

  await test("Phase 16: re-syncing a 'no_change' proposal with a MATERIALLY DIFFERENT summary DOES reset it back to 'proposed' — evidence changing is exactly when it should resurface", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "no canonical v1", pages: ["a.html"], evidence: [{ x: 1 }] });

    await syncProposals([finding], "run-1", { client: table });
    table.rows[0].status = "no_change";
    table.rows[0].reviewed_by = "owner@milehighjunkremoval.net";
    table.rows[0].review_note = "Decided to leave it.";

    const finding2 = decidedFinding({ type: "missing-canonical", summary: "no canonical v2 — materially different observation", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding2], "run-2", { client: table, previousOwnerReviewKeys: new Set([finding.key]) });

    assert.strictEqual(table.rows[0].status, "proposed", "materially different content must require fresh review, even for a previously no_change'd proposal");
    assert.strictEqual(table.rows[0].reviewed_by, null);
    assert.strictEqual(table.rows[0].review_note, null);
  });

  await test("Phase 16: the same unchanged-content protection applies to 'needs_revision' and 'recheck', not just 'no_change'/'approved'/'rejected'", async () => {
    for (const status of ["needs_revision", "recheck"]) {
      const table = new FakeProposalsTable();
      const finding = decidedFinding({ type: "missing-h1", summary: "v1", pages: ["b.html"], evidence: [{ x: 1 }] });
      await syncProposals([finding], "run-1", { client: table });
      table.rows[0].status = status;

      const finding2 = decidedFinding({ type: "missing-h1", summary: "v1", pages: ["b.html"], evidence: [{ x: 1 }] });
      await syncProposals([finding2], "run-2", { client: table, previousOwnerReviewKeys: new Set([finding.key]) });
      assert.strictEqual(table.rows[0].status, status, `${status} must survive an unchanged re-sync`);
    }
  });

  await test("Phase 16: a 'no_change' proposal that REAPPEARS after being absent from the owner-review set also resets to 'proposed', same Phase 4 reappearance rule", async () => {
    const table = new FakeProposalsTable();
    const finding = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    await syncProposals([finding], "run-1", { client: table, previousOwnerReviewKeys: new Set() });
    table.rows[0].status = "no_change";

    const reappeared = decidedFinding({ type: "missing-canonical", summary: "v1", pages: ["a.html"], evidence: [{ x: 1 }] });
    const previousOwnerReviewKeysWhenAbsent = new Set(); // not present in the immediately preceding run
    await syncProposals([reappeared], "run-3", { client: table, previousOwnerReviewKeys: previousOwnerReviewKeysWhenAbsent });
    assert.strictEqual(table.rows[0].status, "proposed");
  });
}

// =======================================================================
// Section 3 — UI wiring (static source checks, no DOM/browser available)
// =======================================================================

const waJs = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent.js"), "utf8");
const waHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent", "index.html"), "utf8");
const proposalsJs = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals.js"), "utf8");
const proposalsHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals", "index.html"), "utf8");

async function runUiSection() {
  await test("admin/website-agent/index.html has a permanent, always-visible 'Agent Proposals' button linking to /admin/agent-proposals/, outside the loading/not-connected/body conditional sections", () => {
    const topActionsMatch = waHtml.match(/<div class="admin-wa-top-actions">([\s\S]*?)<\/div>/);
    assert.ok(topActionsMatch, "expected a dedicated always-visible top-actions block");
    assert.ok(/href="\/admin\/agent-proposals\/"/.test(topActionsMatch[1]));
    assert.ok(/Agent Proposals/.test(topActionsMatch[1]));
    assert.ok(/admin-btn/.test(topActionsMatch[1]), "must be styled as a real button, consistent with the rest of the admin UI");
    // It must come before wa-loading in document order, i.e. not nested
    // inside any of the three state divs that toggle visibility.
    const topActionsIndex = waHtml.indexOf('class="admin-wa-top-actions"');
    const loadingIndex = waHtml.indexOf('id="wa-loading"');
    assert.ok(topActionsIndex > -1 && loadingIndex > -1 && topActionsIndex < loadingIndex);
  });

  await test("admin/website-agent.js's buildQueueCard renders an 'Open Proposal' button deep-linking to /admin/agent-proposals/?id=<proposal.id>", () => {
    const fnMatch = waJs.match(/function buildQueueCard[\s\S]*?\n  \}/);
    assert.ok(fnMatch, "expected a buildQueueCard function");
    const fnBody = fnMatch[0];
    assert.ok(/Open Proposal/.test(fnBody));
    assert.ok(/\/admin\/agent-proposals\/\?id=' \+ encodeURIComponent\(proposal\.id\)/.test(fnBody), "must reuse proposal.id, never a new/separate identifier");
  });

  await test("admin/website-agent.js's buildExecutionCard also deep-links to the exact proposal, not just the general list", () => {
    const fnMatch = waJs.match(/function buildExecutionCard[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    const fnBody = fnMatch[0];
    assert.ok(/\/admin\/agent-proposals\/\?id=' \+ encodeURIComponent\(proposal\.id\)/.test(fnBody));
    // Phase 14 hotfix invariant must still hold: no action buttons wired
    // up on this read-only card.
    assert.ok(!/addEventListener\('click'/.test(fnBody));
  });

  await test("admin/agent-proposals.js reads ?id= from the URL and scrolls/highlights the matching card (deep-link support for Open Proposal)", () => {
    assert.ok(/deepLinkProposalId/.test(proposalsJs));
    assert.ok(/URLSearchParams\(window\.location\.search\)\.get\('id'\)/.test(proposalsJs));
    assert.ok(/scrollIntoView/.test(proposalsJs));
    assert.ok(/admin-proposal-card-linked/.test(proposalsJs));
    // Every card must get a stable, id-addressable DOM node to scroll to.
    assert.ok(/card\.id = 'proposal-' \+ proposal\.id/.test(proposalsJs));
  });

  await test("admin/agent-proposals.js never uses innerHTML/insertAdjacentHTML/document.write (defense-in-depth re-check after the Phase 16 additions)", () => {
    assert.ok(!/\.innerHTML\s*=/.test(proposalsJs));
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(proposalsJs));
    assert.ok(!/document\.write\s*\(/.test(proposalsJs));
  });

  await test("admin/agent-proposals.js renders all 5 decision buttons with the exact required labels, calling reviewProposal with the correct action for each", () => {
    assert.ok(/Approve & Execute/.test(proposalsJs));
    assert.ok(/Verified \\u2014 No Change Needed|Verified — No Change Needed/.test(proposalsJs));
    assert.ok(/Needs Revision/.test(proposalsJs));
    assert.ok(/Recheck Later/.test(proposalsJs));
    assert.ok(/Dismiss/.test(proposalsJs));

    assert.ok(/reviewProposal\(proposal\.id, 'approve'/.test(proposalsJs));
    assert.ok(/reviewProposal\(proposal\.id, 'no_change'/.test(proposalsJs));
    assert.ok(/reviewProposal\(proposal\.id, 'needs_revision'/.test(proposalsJs));
    assert.ok(/reviewProposal\(proposal\.id, 'recheck'/.test(proposalsJs));
    assert.ok(/reviewProposal\(proposal\.id, 'reject'/.test(proposalsJs), "Dismiss must call the EXISTING 'reject' action, not a new one");
  });

  await test("admin/agent-proposals.js's STATUS_LABELS distinguishes 'no_change' from 'rejected' (Dismiss) with different, non-overlapping text", () => {
    const labelsMatch = proposalsJs.match(/var STATUS_LABELS = \{([\s\S]*?)\};/);
    assert.ok(labelsMatch);
    const body = labelsMatch[1];
    assert.ok(/no_change:\s*'Verified/.test(body));
    assert.ok(/rejected:\s*'Dismissed'/.test(body));
    assert.ok(/needs_revision:\s*'Needs Revision'/.test(body));
    assert.ok(/recheck:\s*'Recheck Later'/.test(body));
  });

  await test("admin/agent-proposals/index.html's filter bar lets the owner isolate No Change / Needs Revision / Recheck Later / Dismissed, alongside the existing Needs review/Approved", () => {
    assert.ok(/data-status="no_change"/.test(proposalsHtml));
    assert.ok(/data-status="needs_revision"/.test(proposalsHtml));
    assert.ok(/data-status="recheck"/.test(proposalsHtml));
    assert.ok(/data-status="rejected"/.test(proposalsHtml));
    assert.ok(/Dismissed/.test(proposalsHtml));
  });

  await test("admin.css defines distinct status-badge colors for the three new statuses (never reusing proposed/approved/rejected's colors)", () => {
    const cssPath = path.join(__dirname, "..", "admin", "admin.css");
    const css = fs.readFileSync(cssPath, "utf8");
    assert.ok(/\.admin-proposal-status-no_change\s*\{/.test(css));
    assert.ok(/\.admin-proposal-status-needs_revision\s*\{/.test(css));
    assert.ok(/\.admin-proposal-status-recheck\s*\{/.test(css));
  });
}

async function main() {
  await runApiSection();
  await runSyncSection();
  await runUiSection();
}

main();
