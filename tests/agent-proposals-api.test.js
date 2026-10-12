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

  if (process.exitCode) process.exit(process.exitCode);
}

main();
