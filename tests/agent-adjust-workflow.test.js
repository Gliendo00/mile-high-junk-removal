// Site Improvement Agent, Phase 5 — tests for the "adjust" action on
// resource:"agent-proposal" PATCH (see
// sql/2026-10-14_phase5-agent-adjust-workflow.sql's header for the full
// design). Same offline fake-Supabase harness convention as
// tests/agent-proposals-api.test.js — copied rather than imported, same
// as that file's own relationship to tests/phase2-admin-api.test.js,
// since each test file owns its own Module._load interception.
//
// Run with:  node tests/agent-adjust-workflow.test.js

const Module = require("module");
const assert = require("assert");

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this._updatePayload = null;
    this._single = false;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
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
      return { data: { ...row }, error: null };
    }
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
          throw new Error("Unexpected Supabase key passed to createClient() in agent-adjust-workflow test: " + key);
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
        finding_key: "content-gap::blog-x.html",
        finding_type: "content-gap",
        category: "C",
        risk_level: "medium",
        decision: "PROPOSE_CHANGE",
        decision_reason: "internal evidence plus external research support action",
        summary: "blog-x.html's FAQ is thin.",
        pages: ["blog-x.html"],
        evidence: [],
        research: [],
        status: "proposed",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        adjust_note: null,
        adjusted_at: null,
        last_run_id: "run-1",
        created_at: "2026-10-12T00:00:00.000Z",
        updated_at: "2026-10-12T00:00:00.000Z",
      },
      {
        id: "p2",
        finding_key: "missing-canonical::a.html",
        finding_type: "missing-canonical",
        category: "A",
        risk_level: "medium",
        decision: "PROPOSE_CHANGE",
        decision_reason: "x",
        summary: "a.html has no canonical link tag.",
        pages: ["a.html"],
        evidence: [],
        research: [],
        status: "approved",
        reviewed_by: "owner@milehighjunkremoval.net",
        reviewed_at: "2026-10-11T00:00:00.000Z",
        review_note: "ok",
        adjust_note: null,
        adjusted_at: null,
        last_run_id: "run-1",
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
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
  await test("resource=agent-proposal PATCH action='adjust' requires a non-empty note (nothing to act on otherwise)", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "adjust" } }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("resource=agent-proposal PATCH action='adjust' with feedback moves status to 'adjust_requested' and stores the note — WITHOUT setting reviewed_by/reviewed_at (this is not an approve/reject)", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p1", action: "adjust", note: "Please double-check this applies to this specific page." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "adjust_requested");
    assert.strictEqual(res.body.proposal.adjustNote, "Please double-check this applies to this specific page.");
    assert.ok(res.body.proposal.adjustedAt);
    assert.strictEqual(res.body.proposal.reviewedBy, null, "adjust must never set reviewed_by — it is not an approval/rejection decision");
    assert.strictEqual(res.body.proposal.reviewedAt, null);
  });

  await test("an adjust request on an already-approved proposal clears the prior approval (reviewed_by/reviewed_at/review_note reset to null) — a fresh adjustment supersedes the old verdict", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      body: { resource: "agent-proposal", id: "p2", action: "adjust", note: "Actually, re-check this one too." },
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.proposal.status, "adjust_requested");
    assert.strictEqual(res.body.proposal.reviewedBy, null);
    assert.strictEqual(res.body.proposal.reviewNote, null);
  });

  await test("action='adjust' PATCH update payload only ever touches status/adjust_note/adjusted_at/reviewed_*/updated_at — never finding_type/category/pages/evidence/research (sync-owned fields untouched) and NEVER writes anything that could be mistaken for a website change", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const before = { ...db.agent_proposals[0] };
    await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "adjust", note: "feedback" } }));
    const after = db.agent_proposals[0];
    assert.strictEqual(after.finding_type, before.finding_type);
    assert.strictEqual(after.category, before.category);
    assert.deepStrictEqual(after.pages, before.pages);
    assert.deepStrictEqual(after.evidence, before.evidence);
    assert.strictEqual(after.summary, before.summary, "adjust never rewrites the summary itself — only records feedback for a later re-evaluation");
  });

  await test("adjusting ONE proposal never touches any other proposal's row", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "adjust", note: "feedback" } }));
    const other = db.agent_proposals.find((r) => r.id === "p2");
    assert.strictEqual(other.status, "approved");
  });

  await test("action='adjust' on a nonexistent id returns 404, not a silent success", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "does-not-exist", action: "adjust", note: "x" } }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test("an unrecognized action is still rejected with 400 (adjust did not loosen the existing approve/reject/adjust-only validation)", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", id: "p1", action: "publish" } }));
    assert.strictEqual(res.statusCode, 400);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
