// Site Improvement Agent, Phase 3 — tests for api/admin/bookings.js's
// new ?view=agent-proposals (list) and resource:"agent-proposal" PATCH
// (approve/reject). Same offline fake-Supabase harness convention as
// tests/phase2-admin-api.test.js.
//
// Run with:  node tests/agent-proposals-api.test.js

const Module = require("module");
const assert = require("assert");

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
    // Phase 4 hardening fixture — simulates "the migration has not been
    // applied yet" (Postgres' real 42P01 "relation does not exist").
    if (this.db.__relationMissing) {
      return { data: null, error: { message: `relation "${this.table}" does not exist`, code: "42P01" } };
    }
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
          throw new Error("Unexpected Supabase key passed to createClient() in agent-proposals-api test: " + key);
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

// Pre-acceptance hardening (audit finding #4) — ?view=agent-proposals
// now also reads agent/history/log.ndjson (read-only, via
// currentOwnerReviewKeys() in bookings.js) to compute each row's derived
// `stale` flag. Same "mutate the shared, cached config object before
// first use" redirect tests/agent-reports-api.test.js already relies on,
// so these tests never touch the real committed log file and can fully
// control what the "latest run's owner-review set" looks like.
const os = require("os");
const path = require("path");
const fs = require("fs");
const TEST_LOG_PATH = path.join(os.tmpdir(), `agent-proposals-api-test-${process.pid}.ndjson`);
const config = require("../agent/config");
config.HISTORY_LOG_PATH = TEST_LOG_PATH;

const bookingsHandler = require("../api/admin/bookings.js");
const history = require("../agent/lib/history");

function installSeededLog(runs) {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
  for (const run of runs) {
    history.appendRun(run, TEST_LOG_PATH);
  }
}

function clearSeededLog() {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
}

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
        evidence: [{ file: "a.html", field: "canonical", value: null }],
        research: [],
        status: "proposed",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        last_run_id: "run-1",
        created_at: "2026-10-12T00:00:00.000Z",
        updated_at: "2026-10-12T00:00:00.000Z",
      },
      {
        id: "p2",
        finding_key: "content-gap::blog-x.html",
        finding_type: "content-gap",
        category: "C",
        risk_level: "medium",
        decision: "PROPOSE_CHANGE",
        decision_reason: "internal evidence plus external research support action",
        summary: "blog-x.html's FAQ is thin.",
        pages: ["blog-x.html"],
        evidence: [],
        research: [{ source: "x" }],
        status: "approved",
        reviewed_by: "owner@milehighjunkremoval.net",
        reviewed_at: "2026-10-12T01:00:00.000Z",
        review_note: "Looks good.",
        last_run_id: "run-1",
        created_at: "2026-10-13T00:00:00.000Z",
        updated_at: "2026-10-12T01:00:00.000Z",
      },
    ],
  };
}

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

async function main() {
  await test("?view=agent-proposals requires admin auth", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ query: { view: "agent-proposals" }, headers: { cookie: "" } }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("?view=agent-proposals lists every proposal, newest first, in the camelCase shape", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ query: { view: "agent-proposals" } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposals.length, 2);
    assert.strictEqual(res.body.proposals[0].id, "p2"); // created later -> sorted first
    assert.strictEqual(res.body.proposals[0].findingKey, "content-gap::blog-x.html");
    assert.strictEqual(res.body.proposals[0].reviewedBy, "owner@milehighjunkremoval.net");
  });

  await test("?view=agent-proposals&status=proposed filters to only that status", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ query: { view: "agent-proposals", status: "proposed" } }));
    assert.strictEqual(res.body.proposals.length, 1);
    assert.strictEqual(res.body.proposals[0].id, "p1");
  });

  // --- Pre-acceptance hardening (audit finding #4): the derived `stale` flag ---

  await test("?view=agent-proposals: a row whose finding_key IS in the latest run's owner-review set is NOT stale", async () => {
    installSeededLog([
      {
        runId: "run-9",
        sequence: 1,
        timestamp: "2026-10-15T00:00:00.000Z",
        findings: [
          { key: "missing-canonical::a.html", decision: "PROPOSE_CHANGE" },
          { key: "content-gap::blog-x.html", decision: "PROPOSE_CHANGE" },
        ],
      },
    ]);
    try {
      currentFakeService = makeFakeServiceClient(freshDb());
      const res = await run(makeReq({ query: { view: "agent-proposals" } }));
      assert.strictEqual(res.statusCode, 200);
      const p1 = res.body.proposals.find((p) => p.id === "p1");
      const p2 = res.body.proposals.find((p) => p.id === "p2");
      assert.strictEqual(p1.stale, false);
      assert.strictEqual(p2.stale, false);
    } finally {
      clearSeededLog();
    }
  });

  await test("?view=agent-proposals: a row whose finding_key is ABSENT from the latest run's owner-review set (its decision moved to NO_CHANGE/RESEARCH_MORE, or it simply stopped appearing) IS stale", async () => {
    installSeededLog([
      {
        runId: "run-10",
        sequence: 1,
        timestamp: "2026-10-16T00:00:00.000Z",
        // p1's finding_key ("missing-canonical::a.html") is now
        // NO_CHANGE — no longer in the owner-review set. p2's finding_key
        // doesn't appear in this run's findings at all (the underlying
        // issue was resolved/stopped being produced).
        findings: [{ key: "missing-canonical::a.html", decision: "NO_CHANGE" }],
      },
    ]);
    try {
      currentFakeService = makeFakeServiceClient(freshDb());
      const res = await run(makeReq({ query: { view: "agent-proposals" } }));
      assert.strictEqual(res.statusCode, 200);
      const p1 = res.body.proposals.find((p) => p.id === "p1");
      const p2 = res.body.proposals.find((p) => p.id === "p2");
      assert.strictEqual(p1.stale, true, "a proposal whose finding is now NO_CHANGE must be flagged stale — it must not read as apparently active indefinitely");
      assert.strictEqual(p2.stale, true, "a proposal whose finding_key no longer appears in the latest run at all must also be flagged stale");
      // The underlying `status` itself is never touched by this —
      // staleness is a derived, read-time annotation, not a DB write.
      assert.strictEqual(p1.status, "proposed");
      assert.strictEqual(p2.status, "approved");
    } finally {
      clearSeededLog();
    }
  });

  await test("?view=agent-proposals: when NO run history exists at all (unreadable/missing), every row's `stale` fails safe to false — never guessed true on missing information", async () => {
    clearSeededLog(); // ensure no history file exists
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ query: { view: "agent-proposals" } }));
    assert.strictEqual(res.statusCode, 200);
    for (const p of res.body.proposals) {
      assert.strictEqual(p.stale, false);
    }
  });

  await test("resource=agent-proposal PATCH approve sets status/reviewedBy/reviewedAt/reviewNote", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "approve", note: "Go ahead." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "approved");
    assert.strictEqual(res.body.proposal.reviewedBy, "owner@milehighjunkremoval.net");
    assert.strictEqual(res.body.proposal.reviewNote, "Go ahead.");
    assert.ok(res.body.proposal.reviewedAt);
  });

  await test("resource=agent-proposal PATCH reject sets status to 'rejected'", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "reject" },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "rejected");
  });

  await test("resource=agent-proposal PATCH approving ONE proposal never touches any other proposal's row", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "approve" } }));
    const other = db.agent_proposals.find((r) => r.id === "p2");
    assert.strictEqual(other.status, "approved"); // unchanged from its fixture starting value
    assert.strictEqual(other.review_note, "Looks good."); // unchanged
  });

  await test("resource=agent-proposal PATCH rejects an invalid action (not approve/reject) with 400", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "delete-everything" } }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("resource=agent-proposal PATCH on a nonexistent id returns 404, not a silent success", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "does-not-exist", action: "approve" } }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test("resource=agent-proposal PATCH update payload never includes finding_type/category/pages/evidence (sync-owned fields untouched)", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const before = { ...db.agent_proposals[0] };
    await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "approve" } }));
    const after = db.agent_proposals[0];
    assert.strictEqual(after.finding_type, before.finding_type);
    assert.strictEqual(after.category, before.category);
    assert.deepStrictEqual(after.pages, before.pages);
    assert.deepStrictEqual(after.evidence, before.evidence);
  });

  // Phase 4 hardening — "migration not applied" must degrade gracefully
  // (a clean 500 with a generic message, same posture as every other
  // DB-backed admin view when Supabase errors), never a crash, and
  // crucially must have ZERO effect on the (file-only, Supabase-free)
  // ?view=agent-activity endpoint — see the next two tests.
  await test("?view=agent-proposals returns a clean 500 (not a crash) when the table doesn't exist yet (migration not applied)", async () => {
    const db = freshDb();
    db.__relationMissing = true;
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ query: { view: "agent-proposals" } }));
    assert.strictEqual(res.statusCode, 500);
    assert.ok(res.body.error);
  });

  await test("resource=agent-proposal PATCH returns a clean 500 (not a crash) when the table doesn't exist yet (migration not applied)", async () => {
    const db = freshDb();
    db.__relationMissing = true;
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "approve" } }));
    assert.strictEqual(res.statusCode, 500);
    assert.ok(res.body.error);
  });

  await test("?view=agent-activity (the Home dashboard's feed) is completely unaffected by agent_proposals being missing — it never touches Supabase at all", async () => {
    const db = freshDb();
    db.__relationMissing = true; // would break any Supabase-backed view...
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ query: { view: "agent-activity" } }));
    // ...but agent-activity reads a file, never Supabase, so this must
    // still succeed normally regardless of what __relationMissing says.
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(typeof res.body.connected, "boolean");
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
