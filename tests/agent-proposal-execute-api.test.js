// Site Improvement Agent, Phase 14 — tests for api/admin/bookings.js's
// resource:"agent-proposal" action:"execute". Same offline fake-
// Supabase harness convention as tests/agent-proposals-api.test.js
// (duplicated locally rather than shared, matching this repo's existing
// per-test-file-independence convention). This endpoint never applies/
// commits/pushes anything itself (see its own header in bookings.js) —
// it only (1) refuses a mobile request outright, (2) atomically claims
// the row (approved -> applying), and (3) asks GitHub's REST API to
// dispatch the real execution workflow — so `global.fetch` is mocked
// here instead of git/the agent pipeline.
//
// Run with:  node tests/agent-proposal-execute-api.test.js

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
    const matched = rows.filter((row) => this.eqFilters.every((f) => row[f.col] === f.val));
    if (this._updatePayload) {
      const row = matched[0];
      if (!row) return { data: null, error: null };
      Object.assign(row, this._updatePayload);
      return { data: this._single ? { ...row } : [{ ...row }], error: null };
    }
    return { data: this._single ? (matched[0] ? { ...matched[0] } : null) : matched.map((r) => ({ ...r })), error: null };
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
          throw new Error("Unexpected Supabase key passed to createClient() in agent-proposal-execute-api test: " + key);
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

function freshDb(overrides = {}) {
  return {
    agent_proposals: [
      {
        id: "p1",
        finding_key: "missing-canonical::a.html",
        status: "approved",
        execution: {},
        proposed_fix: { kind: "rewrite-href", file: "a.html", from: "/old", to: "/new.html" },
        ...overrides,
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

function mockFetchOnce(responseFactory) {
  const original = global.fetch;
  global.fetch = async (...args) => responseFactory(...args);
  return () => {
    global.fetch = original;
  };
}

async function main() {
  await test("execute requires admin auth", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", headers: { cookie: "" }, body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("execute refuses a request with a mobile user-agent, before touching the DB at all", async () => {
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({
      method: "PATCH",
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
      body: { resource: "agent-proposal", action: "execute", id: "p1" },
    }));
    assert.strictEqual(res.statusCode, 403);
    assert.ok(/desktop/i.test(res.body.error));
    assert.strictEqual(db.agent_proposals[0].status, "approved", "a refused mobile request must never claim/mutate the row");
  });

  await test("execute refuses a rejected proposal with a clear 400, before attempting to claim it", async () => {
    const db = freshDb({ status: "rejected" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/rejected/i.test(res.body.error));
  });

  await test("execute refuses a proposal that is not currently 'approved' (e.g. 'proposed') with 409", async () => {
    const db = freshDb({ status: "proposed" });
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(db.agent_proposals[0].status, "proposed");
  });

  await test("execute on a nonexistent id returns 404", async () => {
    currentFakeService = makeFakeServiceClient(freshDb());
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "does-not-exist" } }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test("execute with no dispatch token configured: claims then rolls back to 'approved', returns 500, changes nothing lasting", async () => {
    delete process.env.GITHUB_EXECUTE_DISPATCH_TOKEN;
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(db.agent_proposals[0].status, "approved", "must roll back to approved, never stay stuck on applying");
  });

  await test("execute with a token configured and GitHub accepting the dispatch (204): claims the row and returns it as 'applying'", async () => {
    process.env.GITHUB_EXECUTE_DISPATCH_TOKEN = "fake-token";
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetchOnce(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return { status: 204 };
    });
    try {
      const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.proposal.status, "applying");
      assert.strictEqual(db.agent_proposals[0].status, "applying");
      assert.strictEqual(db.agent_proposals[0].execution.requestedBy, "owner@milehighjunkremoval.net");
      assert.ok(/actions\/workflows\/execute-proposal\.yml\/dispatches/.test(capturedUrl));
      assert.strictEqual(capturedBody.ref, "main");
      assert.strictEqual(capturedBody.inputs.proposal_id, "p1");
    } finally {
      restore();
      delete process.env.GITHUB_EXECUTE_DISPATCH_TOKEN;
    }
  });

  await test("execute when GitHub's dispatch call itself fails (non-204): rolls the claim back to 'approved', returns 500", async () => {
    process.env.GITHUB_EXECUTE_DISPATCH_TOKEN = "fake-token";
    const db = freshDb();
    currentFakeService = makeFakeServiceClient(db);
    const restore = mockFetchOnce(async () => ({ status: 401, text: async () => "Bad credentials" }));
    try {
      const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(db.agent_proposals[0].status, "approved", "a failed dispatch must roll the row back to approved, immediately retryable");
    } finally {
      restore();
      delete process.env.GITHUB_EXECUTE_DISPATCH_TOKEN;
    }
  });

  await test("a second concurrent execute call (row already 'applying') is refused with 409 and never dispatches a second workflow run", async () => {
    process.env.GITHUB_EXECUTE_DISPATCH_TOKEN = "fake-token";
    const db = freshDb({ status: "applying" });
    currentFakeService = makeFakeServiceClient(db);
    let dispatchCalled = false;
    const restore = mockFetchOnce(async () => {
      dispatchCalled = true;
      return { status: 204 };
    });
    try {
      const res = await run(makeReq({ method: "PATCH", body: { resource: "agent-proposal", action: "execute", id: "p1" } }));
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(dispatchCalled, false, "must never reach the GitHub dispatch call once the claim itself fails");
    } finally {
      restore();
      delete process.env.GITHUB_EXECUTE_DISPATCH_TOKEN;
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
