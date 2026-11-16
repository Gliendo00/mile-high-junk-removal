// Interactive Pricing Calculator — offline tests.
// Covers:
//   - admin/pricing-calculator-core.js (the one shared price engine): all
//     nine load tiers, disposal quantities, labor, custom charges,
//     discounts, rounding, invalid input, reset/blank state, and that the
//     prices still match the public /pricing.html.
//   - api/admin/booking.js ?resource=price-estimate (via
//     api/_lib/price-estimate.js) against an in-memory fake Supabase:
//     auth, server-side recomputation, duplicate-save prevention,
//     overwrite protection, Quoted Amount rules, failure + retry,
//     persistence, and a write audit proving nothing financial is touched.
//   - Structural guarantees for the UI that need no browser: Customer View
//     hides staff-only content, user text is never written as HTML, and the
//     nav entry exists.
//
// "@supabase/supabase-js" is intercepted at require-time — never the
// network, never production. Run with: node tests/pricing-calculator.test.js
const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const Core = require("../admin/pricing-calculator-core.js");

// ---------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------
let nextId = 1;
const makeId = () => "dddddddd-dddd-4ddd-8ddd-" + String(100000000000 + nextId++);
let db;
let writes; // audit of every insert/update: { table, op, data }

class FakeQuery {
  constructor(table) { this.t = table; this.filters = []; this.ins = null; this.upd = null; this.one = null; }
  select() { return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  is(k, v) { this.filters.push((r) => (r[k] === undefined ? null : r[k]) === v); return this; }
  in(k, a) { const s = new Set(a); this.filters.push((r) => s.has(r[k])); return this; }
  order() { return this; }
  limit() { return this; }
  insert(d) { this.ins = d; return this; }
  update(d) { this.upd = d; return this; }
  maybeSingle() { this.one = "m"; return this.run(); }
  single() { this.one = "s"; return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  async run() {
    if (!(this.t in db)) return { data: null, error: { code: "42P01", message: 'relation "public.' + this.t + '" does not exist' } };
    const inject = db.__fail && db.__fail[this.t] && db.__fail[this.t][this.ins ? "insert" : this.upd ? "update" : "select"];
    if (inject) { db.__fail[this.t][this.ins ? "insert" : this.upd ? "update" : "select"] = null; return { data: null, error: inject }; }
    if (this.ins) {
      if (this.t === "job_price_estimates" && db[this.t].some((r) => r.booking_id === this.ins.booking_id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
      const row = Object.assign({ id: makeId() }, JSON.parse(JSON.stringify(this.ins)));
      db[this.t].push(row);
      writes.push({ table: this.t, op: "insert", data: this.ins });
      return { data: this.one ? row : [row], error: null };
    }
    let rows = db[this.t].filter((r) => this.filters.every((f) => f(r)));
    if (this.upd) {
      rows.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(this.upd))));
      writes.push({ table: this.t, op: "update", data: this.upd, matched: rows.length });
    }
    if (this.one === "m") return rows.length > 1 ? { data: null, error: { message: "multiple" } } : { data: rows[0] || null, error: null };
    if (this.one === "s") return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "none" } };
    return { data: rows, error: null };
  }
}
const fakeService = { from: (t) => new FakeQuery(t) };
const fakeAnon = {
  auth: {
    getUser: async (tok) => (tok === "good-token" ? { data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null } : { data: null, error: { message: "invalid" } }),
    refreshSession: async () => ({ data: null, error: { message: "no" } }),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@supabase/supabase-js") {
    return { createClient: (_u, key) => (key === process.env.SUPABASE_ANON_KEY ? fakeAnon : fakeService) };
  }
  return origLoad.call(this, request, parent, isMain);
};
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingHandler = require("../api/admin/booking.js");

const BOOKED = "b1000000-0000-4000-8000-000000000001";
const QUOTED = "b1000000-0000-4000-8000-000000000002";
const COMPLETED = "b1000000-0000-4000-8000-000000000003";
const DUMPSTER = "b1000000-0000-4000-8000-000000000004";
const COMPLIMENTARY = "b1000000-0000-4000-8000-000000000005";
const CUSTOMER = "c1000000-0000-4000-8000-000000000001";

function freshDb() {
  const base = { customer_id: CUSTOMER, appointment_date: "2026-11-20", estimated_price_max: null, final_price: null, is_complimentary: false, archived_at: null, updated_at: "2026-11-15T10:00:00Z" };
  db = {
    customers: [{ id: CUSTOMER, first_name: "Pat", last_name: "Example" }],
    bookings: [
      Object.assign({}, base, { id: BOOKED, service_type: "junk_removal", status: "booked", estimated_price: null }),
      Object.assign({}, base, { id: QUOTED, service_type: "junk_removal", status: "quoted", estimated_price: "350.00" }),
      Object.assign({}, base, { id: COMPLETED, service_type: "junk_removal", status: "completed", estimated_price: null, final_price: 400 }),
      Object.assign({}, base, { id: DUMPSTER, service_type: "dumpster_rental", status: "booked", estimated_price: 349 }),
      Object.assign({}, base, { id: COMPLIMENTARY, service_type: "junk_removal", status: "booked", estimated_price: null, is_complimentary: true }),
    ],
    job_price_estimates: [],
    job_payments: [],
    invoices: [],
    invoice_line_items: [],
  };
  writes = [];
}

function req(opts) {
  return {
    method: opts.method || "GET",
    headers: { cookie: opts.cookie === undefined ? "mhjr_admin_at=good-token" : opts.cookie, "x-forwarded-proto": "https" },
    query: Object.assign({ resource: "price-estimate" }, opts.query || {}),
    body: opts.body,
    socket: { remoteAddress: "127.0.0.1" },
  };
}
async function call(opts) {
  const headers = {};
  const res = {
    statusCode: null, body: null,
    getHeader: (n) => headers[n.toLowerCase()], setHeader: (n, v) => { headers[n.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
  };
  await bookingHandler(req(opts), res);
  return res;
}

const SAMPLE = { loadTier: "half", disposal: { tv_under_48: 1 }, laborQuarterHours: 0, customCharges: [], discounts: [], notes: "", confirmedOnSite: false };
let keyN = 0;
function saveBody(overrides) {
  const input = (overrides && overrides.input) || SAMPLE;
  const total = Core.computeEstimate(Core.normalizeInput(input).value).totalCents;
  return Object.assign({ bookingId: BOOKED, input: input, clientTotalCents: total, expectedRevision: null, requestKey: "test-key-" + String(++keyN).padStart(4, "0"), applyToQuotedAmount: false }, overrides || {});
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// =====================================================================
// Price engine
// =====================================================================
const EXPECTED_TIERS = { minimum: 10000, eighth: 15000, quarter: 20000, three_eighths: 27500, half: 35000, five_eighths: 42500, three_quarters: 47500, seven_eighths: 55000, full: 60000 };

Object.keys(EXPECTED_TIERS).forEach((key) => {
  test("load tier " + key + " prices at " + Core.formatCents(EXPECTED_TIERS[key]) + " with the first labor hour at $0", () => {
    const est = Core.computeEstimate(Core.normalizeInput({ loadTier: key }).value);
    assert.strictEqual(est.totalCents, EXPECTED_TIERS[key]);
    assert.strictEqual(est.lines[0].kind, "load");
    assert.strictEqual(est.lines[1].kind, "labor_included");
    assert.strictEqual(est.lines[1].amountCents, 0);
  });
});

test("exactly nine tiers, one selectable at a time (loadTier is a single key)", () => {
  assert.strictEqual(Core.LOAD_TIERS.length, 9);
  const r = Core.normalizeInput({ loadTier: ["half", "full"] });
  assert.strictEqual(r.ok, false);
});

test("catalog matches the published prices on /pricing.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "pricing.html"), "utf8");
  const tierBlock = html.slice(html.indexOf("Minimum Pickup</div>"), html.indexOf("Disposal fees for special items"));
  const tierPrices = [...tierBlock.matchAll(/font-size:30px">\$(\d+)</g)].map((m) => Number(m[1]) * 100);
  assert.deepStrictEqual(tierPrices, Core.LOAD_TIERS.map((t) => t.cents));
  const fee = (label) => {
    const i = html.indexOf(label);
    assert.ok(i !== -1, "pricing.html missing " + label);
    return Number(/\$(\d+)/.exec(html.slice(i, i + 400))[1]) * 100;
  };
  assert.strictEqual(fee("Tires (no rim)"), Core.itemByKey("tire_no_rim").cents);
  assert.strictEqual(fee("Tires (with rim)"), Core.itemByKey("tire_with_rim").cents);
  assert.strictEqual(fee("Latex / oil-based paint"), Core.itemByKey("paint_can").cents);
  assert.strictEqual(fee("Freon items"), Core.itemByKey("freon_item").cents);
  assert.strictEqual(fee("TVs (48\" &amp; over)"), Core.itemByKey("tv_48_plus").cents);
  assert.strictEqual(fee("TVs (under 48\")"), Core.itemByKey("tv_under_48").cents);
  assert.ok(/additional labor is billed at \$125\/hour/i.test(html));
  assert.strictEqual(Core.LABOR_RATE_CENTS, 12500);
});

test("multiple disposal charges with multiple quantities", () => {
  const est = Core.computeEstimate(Core.normalizeInput({ loadTier: "quarter", disposal: { tire_no_rim: 4, tire_with_rim: 2, paint_can: 3, freon_item: 1, tv_under_48: 2, tv_48_plus: 1 } }).value);
  // 200 + 4*5 + 2*10 + 3*15 + 25 + 2*25 + 50 = 410
  assert.strictEqual(est.totalCents, 41000);
  const tires = est.lines.find((l) => l.key === "tire_no_rim");
  assert.deepStrictEqual([tires.quantity, tires.unitCents, tires.amountCents], [4, 500, 2000]);
});

test("zero-quantity items produce no line", () => {
  const est = Core.computeEstimate(Core.normalizeInput({ loadTier: "half", disposal: { paint_can: 0 } }).value);
  assert.ok(!est.lines.some((l) => l.key === "paint_can"));
});

test("additional labor: quarter-hour steps at $125/hr, never charging the included first hour", () => {
  const n = (q) => Core.computeEstimate(Core.normalizeInput({ loadTier: "minimum", laborQuarterHours: q }).value);
  assert.strictEqual(n(0).totalCents, 10000);
  assert.strictEqual(n(1).totalCents, 10000 + 3125);
  assert.strictEqual(n(4).totalCents, 10000 + 12500);
  assert.strictEqual(n(6).totalCents, 10000 + 18750);
  assert.strictEqual(n(6).lines.find((l) => l.kind === "labor").quantityLabel, "1.5 hrs");
  assert.strictEqual(n(0).lines.filter((l) => l.kind === "labor").length, 0);
});

test("custom charges and discounts are itemized; discounts are negative lines", () => {
  const est = Core.computeEstimate(Core.normalizeInput({ loadTier: "half", customCharges: [{ description: "Hot tub cut-up", amount: "75" }], discounts: [{ description: "Repeat customer", amount: "25.50" }] }).value);
  assert.strictEqual(est.subtotalCents, 42500);
  assert.strictEqual(est.discountCents, 2550);
  assert.strictEqual(est.totalCents, 39950);
  assert.strictEqual(est.lines.find((l) => l.kind === "discount").amountCents, -2550);
});

test("rounding: cent amounts sum exactly (no floating-point drift)", () => {
  const est = Core.computeEstimate(Core.normalizeInput({ loadTier: "minimum", laborQuarterHours: 3, customCharges: [{ description: "a", amount: "0.10" }, { description: "b", amount: "0.20" }] }).value);
  assert.strictEqual(est.totalCents, 10000 + 9375 + 30);
  assert.strictEqual(Core.formatCents(est.totalCents), "$194.05");
  assert.strictEqual(Core.formatCents(123456789), "$1,234,567.89");
});

test("money parsing is strict", () => {
  assert.strictEqual(Core.parseDollarsToCents("25"), 2500);
  assert.strictEqual(Core.parseDollarsToCents("25.5"), 2550);
  assert.strictEqual(Core.parseDollarsToCents("$1,250.05"), 125005);
  ["", " ", "-5", "1.234", "1e3", "abc", "12,34", "NaN", "Infinity", null, undefined, {}].forEach((bad) => {
    assert.strictEqual(Core.parseDollarsToCents(bad), null, "should reject " + JSON.stringify(bad));
  });
});

test("negative and invalid inputs are rejected, never coerced", () => {
  const bad = [
    { loadTier: "huge" },
    { loadTier: "half", disposal: { tv_under_48: -1 } },
    { loadTier: "half", disposal: { tv_under_48: 1.5 } },
    { loadTier: "half", disposal: { tv_under_48: 100 } },
    { loadTier: "half", disposal: { couch: 1 } },
    { loadTier: "half", laborQuarterHours: -1 },
    { loadTier: "half", laborQuarterHours: 2.5 },
    { loadTier: "half", customCharges: [{ description: "x", amount: "-10" }] },
    { loadTier: "half", customCharges: [{ description: "x", amountCents: -1000 }] },
    { loadTier: "half", customCharges: [{ description: "", amount: "10" }] },
    { loadTier: "half", customCharges: [{ description: "x", amount: "0" }] },
    { loadTier: "half", customCharges: [{ description: "x", amount: "10000.01" }] },
    { loadTier: "half", discounts: [{ description: "x", amount: "abc" }] },
    { loadTier: "half", customCharges: new Array(11).fill({ description: "x", amount: "1" }) },
  ];
  bad.forEach((input) => assert.strictEqual(Core.normalizeInput(input).ok, false, JSON.stringify(input)));
});

test("a discount larger than the charges is rejected (total can never go negative)", () => {
  const r = Core.normalizeInput({ loadTier: "minimum", discounts: [{ description: "too much", amount: "100.01" }] });
  assert.strictEqual(r.ok, false);
  assert.ok(/more than the charges/.test(r.errors[0]));
  const exact = Core.normalizeInput({ loadTier: "minimum", discounts: [{ description: "all", amount: "100" }] });
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(Core.computeEstimate(exact.value).totalCents, 0);
});

test("reset: a blank estimate has no lines and a $0.00 total", () => {
  const est = Core.computeEstimate(Core.normalizeInput({}).value);
  assert.deepStrictEqual(est.lines, []);
  assert.strictEqual(est.totalCents, 0);
  const src = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.js"), "utf8");
  assert.ok(/function doReset\(\)[\s\S]*state = emptyState\(\)/.test(src));
  assert.ok(/Start a new estimate\?/.test(src), "reset asks before discarding work");
  assert.ok(/beforeunload/.test(src), "leaving with unsaved changes is guarded");
});

test("descriptions are stored as plain text; HTML stays inert text", () => {
  const r = Core.normalizeInput({ loadTier: "half", customCharges: [{ description: "<img src=x onerror=alert(1)>\n\tTab", amount: "5" }] });
  assert.strictEqual(r.value.customCharges[0].description, "<img src=x onerror=alert(1)> Tab");
});

// =====================================================================
// UI structure (no browser needed)
// =====================================================================
test("calculator scripts never write user data as HTML", () => {
  ["admin/pricing-calculator.js", "admin/price-estimate-summary.js", "admin/pricing-calculator-core.js"].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src), f + " must use textContent only");
  });
});

test("Customer View hides CRM chrome, staff tray, notes, and job info — and stays interactive", () => {
  const html = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator/index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.css"), "utf8");
  assert.ok(/\.pc-focus #admin-chrome, \.pc-focus \.admin-bottom-nav, \.pc-focus \.pc-staff-only \{ display: none !important; \}/.test(css));
  // Staff notes and job chip live only inside .pc-staff-only containers.
  const staffSection = html.slice(html.indexOf('<section class="pc-staff pc-staff-only"'), html.indexOf("</section>", html.indexOf('<section class="pc-staff pc-staff-only"')));
  assert.ok(staffSection.includes('id="pc-notes"'));
  assert.ok(staffSection.includes('id="pc-save-btn"'));
  const toolbar = html.slice(html.indexOf('<div class="pc-toolbar pc-staff-only">'), html.indexOf('id="error-banner"'));
  assert.ok(toolbar.includes('id="pc-job-chip"'));
  // The customer-facing receipt contains no staff fields.
  const receipt = html.slice(html.indexOf('<aside class="pc-receipt"'), html.indexOf("</aside>"));
  ["pc-notes", "pc-save-btn", "pc-job-chip"].forEach((id) => assert.ok(!receipt.includes(id)));
  assert.ok(receipt.includes("Final pricing is confirmed on-site before loading. Additional charges may apply if the scope changes."));
  // Controls are NOT hidden in focus mode — the crew keeps editing live.
  assert.ok(!/\.pc-focus \.pc-controls[^{]*\{[^}]*display:\s*none/.test(css));
  const js = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.js"), "utf8");
  assert.ok(/Confirmed on-site/.test(js) && /Preliminary estimate/.test(js), "confirmed vs preliminary is shown");
});

test("Customer View also suppresses staff messages (errors, toasts, sheets)", () => {
  const css = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.css"), "utf8");
  const rule = /\.pc-focus #error-banner, \.pc-focus #admin-toast, \.pc-focus #pc-sheet-overlay, \.pc-focus #admin-more-overlay \{ display: none !important; \}/;
  assert.ok(rule.test(css), "error banner, toast, and sheets hidden in Customer View");
  const js = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.js"), "utf8");
  assert.ok(/if \(on && !sheetOverlay\.hidden && !saveInFlight\) closeSheet\(\);/.test(js));
});

test("Quoted Amount checkbox is never pre-checked; overwrite is named on the confirming button", () => {
  const js = fs.readFileSync(path.join(ROOT, "admin/pricing-calculator.js"), "utf8");
  assert.ok(!/quoteBox\.checked = true/.test(js), "quote update must be an explicit selection");
  assert.ok(/' & replace quote'/.test(js));
  assert.ok(/confirmQuotedOverwrite: applyQuote && quoteDiffers/.test(js));
});

test("nav: Pricing section is registered and marked active on its own page", () => {
  const src = fs.readFileSync(path.join(ROOT, "admin/admin-chrome.js"), "utf8");
  assert.ok(src.includes("{ key: 'pricing-calculator', href: '/admin/pricing-calculator/', label: 'Pricing' }"));
  assert.ok(/MORE_SHEET_KEYS = \['pricing-calculator'/.test(src));
  assert.ok(src.includes("if (path.indexOf('/admin/pricing-calculator/') === 0) return 'pricing-calculator';"));
});

test("server module imports nothing that can move money or send messages", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/_lib/price-estimate.js"), "utf8");
  ["stripe", "job-payments-ledger", "invoice-helpers", "resend", "invoice-crypto"].forEach((m) => assert.ok(!src.includes(m), "must not import " + m));
});

// =====================================================================
// API — ?resource=price-estimate
// =====================================================================
test("auth: unauthenticated GET and POST get 401 and touch nothing", async () => {
  freshDb();
  const g = await call({ cookie: "", query: { bookingId: BOOKED } });
  const p = await call({ cookie: "mhjr_admin_at=bad", method: "POST", body: saveBody() });
  assert.strictEqual(g.statusCode, 401);
  assert.strictEqual(p.statusCode, 401);
  assert.strictEqual(writes.length, 0);
});

test("save: first save stores the server-computed breakdown; quote untouched unless asked", async () => {
  freshDb();
  const r = await call({ method: "POST", body: saveBody({ input: Object.assign({}, SAMPLE, { notes: "Gate code 1234", confirmedOnSite: true }) }) });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.estimate.totalCents, 37500);
  assert.strictEqual(r.body.estimate.revision, 1);
  assert.strictEqual(r.body.estimate.confirmedOnSite, true);
  assert.strictEqual(r.body.quotedAmountUpdated, false);
  const row = db.job_price_estimates[0];
  assert.strictEqual(row.total_cents, 37500);
  assert.strictEqual(row.staff_notes, "Gate code 1234");
  assert.strictEqual(row.updated_by, "owner@milehighjunkremoval.net");
  assert.strictEqual(db.bookings.find((b) => b.id === BOOKED).estimated_price, null);
  assert.deepStrictEqual(writes.map((w) => w.table), ["job_price_estimates"]);
});

test("server never trusts the browser total (mismatch -> 409, nothing written)", async () => {
  freshDb();
  const r = await call({ method: "POST", body: saveBody({ clientTotalCents: 100 }) });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.code, "total_mismatch");
  assert.strictEqual(r.body.serverTotalCents, 37500);
  assert.strictEqual(writes.length, 0);
});

test("server validates selections (invalid -> 400, nothing written)", async () => {
  freshDb();
  const cases = [
    saveBody({ input: { loadTier: null } }),
    Object.assign(saveBody(), { input: { loadTier: "half", customCharges: [{ description: "x", amountCents: -500 }] }, clientTotalCents: 34500 }),
    Object.assign(saveBody(), { input: { loadTier: "minimum", discounts: [{ description: "x", amount: "200" }] }, clientTotalCents: 0 }),
    saveBody({ bookingId: "not-a-uuid" }),
    saveBody({ requestKey: "x" }),
    saveBody({ expectedRevision: 0 }),
    Object.assign(saveBody(), { clientTotalCents: "37500" }),
  ];
  for (const body of cases) {
    const r = await call({ method: "POST", body });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(body) + " -> " + JSON.stringify(r.body));
  }
  assert.strictEqual(writes.length, 0);
});

test("job association is validated server-side (unknown -> 404, dumpster -> 400)", async () => {
  freshDb();
  const missing = await call({ method: "POST", body: saveBody({ bookingId: "b1000000-0000-4000-8000-000000000999" }) });
  assert.strictEqual(missing.statusCode, 404);
  const dumpster = await call({ method: "POST", body: saveBody({ bookingId: DUMPSTER }) });
  assert.strictEqual(dumpster.statusCode, 400);
  assert.strictEqual(writes.length, 0);
});

test("duplicate-save prevention: the same requestKey never writes twice", async () => {
  freshDb();
  const body = saveBody();
  const a = await call({ method: "POST", body });
  const b = await call({ method: "POST", body });
  assert.strictEqual(a.statusCode, 200);
  assert.strictEqual(b.statusCode, 200);
  assert.strictEqual(b.body.duplicate, true);
  assert.strictEqual(db.job_price_estimates.length, 1);
  assert.strictEqual(db.job_price_estimates[0].revision, 1);
  assert.strictEqual(writes.length, 1);
});

test("overwrite protection: an existing saved estimate needs an explicit replace", async () => {
  freshDb();
  await call({ method: "POST", body: saveBody() });
  const blind = await call({ method: "POST", body: saveBody({ input: Object.assign({}, SAMPLE, { loadTier: "full" }) }) });
  assert.strictEqual(blind.statusCode, 409);
  assert.strictEqual(blind.body.code, "estimate_exists");
  assert.strictEqual(blind.body.existing.revision, 1);
  assert.strictEqual(db.job_price_estimates[0].total_cents, 37500);

  const replace = await call({ method: "POST", body: saveBody({ input: Object.assign({}, SAMPLE, { loadTier: "full" }), expectedRevision: 1 }) });
  assert.strictEqual(replace.statusCode, 200);
  assert.strictEqual(replace.body.estimate.revision, 2);
  assert.strictEqual(db.job_price_estimates.length, 1);
  assert.strictEqual(db.job_price_estimates[0].total_cents, 62500);

  const stale = await call({ method: "POST", body: saveBody({ expectedRevision: 1 }) });
  assert.strictEqual(stale.statusCode, 409);
  assert.strictEqual(stale.body.code, "revision_conflict");
  assert.strictEqual(db.job_price_estimates[0].total_cents, 62500);
});

test("overwrite race: UPDATE is conditioned on the revision read", async () => {
  freshDb();
  await call({ method: "POST", body: saveBody() });
  // Simulate another device bumping the revision between our read and write.
  const origRun = FakeQuery.prototype.run;
  FakeQuery.prototype.run = async function () {
    if (this.t === "job_price_estimates" && this.upd) db.job_price_estimates[0].revision = 5;
    return origRun.call(this);
  };
  try {
    const r = await call({ method: "POST", body: saveBody({ expectedRevision: 1 }) });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, "revision_conflict");
  } finally {
    FakeQuery.prototype.run = origRun;
  }
});

test("quoted amount: replacing a different existing quote requires explicit confirmation", async () => {
  freshDb();
  const ask = await call({ method: "POST", body: saveBody({ bookingId: QUOTED, applyToQuotedAmount: true }) });
  assert.strictEqual(ask.statusCode, 409);
  assert.strictEqual(ask.body.code, "quote_overwrite_required");
  assert.strictEqual(ask.body.newQuote, "375.00");
  assert.strictEqual(writes.length, 0, "refused before ANY write");

  const ok = await call({ method: "POST", body: saveBody({ bookingId: QUOTED, applyToQuotedAmount: true, confirmQuotedOverwrite: true }) });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.body.quotedAmountUpdated, true);
  const b = db.bookings.find((x) => x.id === QUOTED);
  assert.strictEqual(b.estimated_price, 375);
  assert.strictEqual(b.estimated_price_max, null);
  assert.notStrictEqual(b.updated_at, "2026-11-15T10:00:00Z", "updated_at bumped so open Edit Job forms get a 409");
  assert.strictEqual(b.final_price, null);
  assert.strictEqual(b.status, "quoted");
});

test("quoted amount: unset quote is filled when asked; matching quote is not rewritten", async () => {
  freshDb();
  const r = await call({ method: "POST", body: saveBody({ applyToQuotedAmount: true }) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.quotedAmountUpdated, true);
  assert.strictEqual(db.bookings.find((x) => x.id === BOOKED).estimated_price, 375);
  writes = [];
  const same = await call({ method: "POST", body: saveBody({ applyToQuotedAmount: true, expectedRevision: 1, input: Object.assign({}, SAMPLE, { notes: "edit" }) }) });
  assert.strictEqual(same.statusCode, 200);
  assert.strictEqual(same.body.quotedAmountUpdated, false);
  assert.ok(!writes.some((w) => w.table === "bookings"));
});

test("quoted amount is never written on completed or complimentary jobs (revenue safety)", async () => {
  freshDb();
  for (const id of [COMPLETED, COMPLIMENTARY]) {
    const r = await call({ method: "POST", body: saveBody({ bookingId: id, applyToQuotedAmount: true, confirmQuotedOverwrite: true }) });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, "quote_not_writable");
  }
  assert.strictEqual(writes.length, 0);
  // The breakdown alone CAN be saved to a completed job; its prices stay put.
  const ok = await call({ method: "POST", body: saveBody({ bookingId: COMPLETED }) });
  assert.strictEqual(ok.statusCode, 200);
  const b = db.bookings.find((x) => x.id === COMPLETED);
  assert.strictEqual(b.estimated_price, null);
  assert.strictEqual(b.final_price, 400);
});

test("concurrent job edit: breakdown saves, quote update is skipped with a clear warning", async () => {
  freshDb();
  const origRun = FakeQuery.prototype.run;
  FakeQuery.prototype.run = async function () {
    if (this.t === "bookings" && this.upd) db.bookings.find((x) => x.id === BOOKED).updated_at = "2026-11-16T09:00:00Z";
    return origRun.call(this);
  };
  try {
    const r = await call({ method: "POST", body: saveBody({ applyToQuotedAmount: true }) });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.quotedAmountUpdated, false);
    assert.ok(/quoted amount was not updated/.test(r.body.warning));
    assert.strictEqual(db.bookings.find((x) => x.id === BOOKED).estimated_price, null);
  } finally {
    FakeQuery.prototype.run = origRun;
  }
});

test("failure + retry: a failed write reports clearly, and the identical retry saves once", async () => {
  freshDb();
  db.__fail = { job_price_estimates: { insert: { code: "08006", message: "connection reset" } } };
  const body = saveBody();
  const fail = await call({ method: "POST", body });
  assert.strictEqual(fail.statusCode, 500);
  assert.ok(/Nothing was charged or sent/.test(fail.body.error));
  assert.strictEqual(db.job_price_estimates.length, 0);
  const retry = await call({ method: "POST", body });
  assert.strictEqual(retry.statusCode, 200);
  const again = await call({ method: "POST", body });
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(db.job_price_estimates.length, 1);
});

test("migration not applied yet: POST 503 (nothing saved), GET still works", async () => {
  freshDb();
  delete db.job_price_estimates;
  const p = await call({ method: "POST", body: saveBody() });
  assert.strictEqual(p.statusCode, 503);
  assert.strictEqual(p.body.code, "storage_not_ready");
  const g = await call({ query: { bookingId: BOOKED } });
  assert.strictEqual(g.statusCode, 200);
  assert.strictEqual(g.body.storageReady, false);
  assert.strictEqual(g.body.estimate, null);
});

test("persistence: GET returns the saved selections for reopening", async () => {
  freshDb();
  const input = { loadTier: "three_quarters", disposal: { paint_can: 2 }, laborQuarterHours: 6, customCharges: [{ description: "Stairs", amount: "40" }], discounts: [{ description: "Neighbor", amount: "15" }], notes: "Back alley", confirmedOnSite: true };
  await call({ method: "POST", body: saveBody({ input }) });
  const g = await call({ query: { bookingId: BOOKED } });
  assert.strictEqual(g.statusCode, 200);
  const e = g.body.estimate;
  assert.strictEqual(e.loadTier, "three_quarters");
  assert.deepStrictEqual(e.input.disposal, { paint_can: 2 });
  assert.strictEqual(e.input.laborQuarterHours, 6);
  assert.deepStrictEqual(e.input.customCharges, [{ description: "Stairs", amountCents: 4000 }]);
  assert.deepStrictEqual(e.input.discounts, [{ description: "Neighbor", amountCents: 1500 }]);
  assert.strictEqual(e.staffNotes, "Back alley");
  assert.strictEqual(e.totalCents, 47500 + 3000 + 18750 + 4000 - 1500);
  // Re-normalizing the stored input reproduces the stored total exactly.
  assert.strictEqual(Core.computeEstimate(Core.normalizeInput(e.input).value).totalCents, e.totalCents);
  assert.strictEqual(g.body.booking.customerName, "Pat Example");
  assert.strictEqual(g.body.booking.quoteWritable, true);
});

test("GET flags non-priceable and non-writable jobs; bad ids are 404", async () => {
  freshDb();
  assert.strictEqual((await call({ query: { bookingId: DUMPSTER } })).body.booking.priceable, false);
  assert.strictEqual((await call({ query: { bookingId: COMPLETED } })).body.booking.quoteWritable, false);
  assert.strictEqual((await call({ query: { bookingId: "nope" } })).statusCode, 404);
  assert.strictEqual((await call({ query: { bookingId: "b1000000-0000-4000-8000-000000000999" } })).statusCode, 404);
});

test("write audit: only job_price_estimates and bookings' quote fields are ever written", async () => {
  freshDb();
  await call({ method: "POST", body: saveBody({ bookingId: QUOTED, applyToQuotedAmount: true, confirmQuotedOverwrite: true }) });
  await call({ method: "POST", body: saveBody({ bookingId: QUOTED, applyToQuotedAmount: true, confirmQuotedOverwrite: true, expectedRevision: 1, input: Object.assign({}, SAMPLE, { loadTier: "full" }) }) });
  writes.forEach((w) => {
    assert.ok(["job_price_estimates", "bookings"].includes(w.table), "unexpected write to " + w.table);
    if (w.table === "bookings") assert.deepStrictEqual(Object.keys(w.data).sort(), ["estimated_price", "estimated_price_max", "updated_at"]);
  });
  assert.strictEqual(db.job_payments.length, 0);
  assert.strictEqual(db.invoices.length, 0);
  assert.strictEqual(db.invoice_line_items.length, 0);
});

test("other methods are refused", async () => {
  freshDb();
  for (const method of ["PATCH", "DELETE", "PUT"]) {
    const r = await call({ method, body: saveBody() });
    assert.strictEqual(r.statusCode, 405);
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("  " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : err));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  if (failed) process.exitCode = 1;
})();
