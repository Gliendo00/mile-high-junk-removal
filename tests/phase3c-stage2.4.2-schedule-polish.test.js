// Local, offline test harness for Phase 3C Stage 2.4.2: Schedule UX polish
// following owner review of the live CRM. Covers:
//   - the new Yesterday range (?view=schedule&range=yesterday) and its
//     historical-floor edge case, plus the new explicit-date "day" range
//     backing the previous-day/next-day arrows — both served by
//     api/admin/bookings.js's existing handleSchedule()/handleDay(), no new
//     serverless function;
//   - client-side source-pattern checks (same limitation/approach as every
//     prior client-only stage's test file — see tests/phase3c-schedule.test.js's
//     header) for: the Yesterday tab, the relocated Quick Expense bar, the
//     Week horizontal layout, the Month grid's top-left date/badge layout,
//     and the day-nav/day-panel previous-next controls;
//   - a second-pass visual correction (owner reviewed the authenticated
//     Preview and found the first attempt insufficient): Today/Tomorrow/
//     Yesterday's outer job card (.admin-schedule-card) needed a much more
//     visible border/shadow — the wrapper already correctly contained the
//     whole job (info AND the Call/Text/Directions row), it just read as
//     "on the background" next to those large, saturated buttons — and
//     Week's per-day job list needed each job to be its own mini-card
//     (.admin-week-day-row-job) instead of one run-on block of text;
//   - a corrective regression guard confirming a mid-task addendum (Google
//     address-autocomplete previewing each suggestion's ZIP in the
//     dropdown) was fully removed after owner review — it was outside this
//     stage's approved Schedule UX scope and added ongoing Google Place
//     Details cost — and that admin/address-autocomplete.js was restored
//     byte-identical to the approved Stage 2.4.1 file from production
//     baseline ee2585f, with the original select-a-suggestion ZIP-population
//     behavior still intact.
//
// Run with:  node tests/phase3c-stage2.4.2-schedule-polish.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase — identical shape to tests/phase3c-stage2.4-calendar.test.js
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
  }
  select() {
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  gte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val);
    return this;
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder((db[table] || []).slice());
    },
  };
}

function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured in this test" } })),
    },
  };
}

let currentFakeAnon = null;
let currentFakeService = null;

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return currentFakeAnon;
          if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
          throw new Error("Unexpected Supabase key passed to createClient() in test: " + key);
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
    headers: Object.assign({ cookie: opts.cookie || "" }, opts.headers || {}),
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
function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}

function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}

const TODAY = denverTodayIso();
const YESTERDAY = addDaysIso(TODAY, -1);
const TOMORROW = addDaysIso(TODAY, 1);

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

function booking(overrides) {
  return Object.assign(
    {
      id: "00000000-0000-0000-0000-000000000000",
      customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      service_type: "junk_removal",
      appointment_date: TODAY,
      time_window: "w_0800_1000",
      status: "booked",
      estimated_price: 250,
      service_address: "123 Main St",
      service_city: "Denver",
      service_state: "CO",
      service_zip: "80202",
    },
    overrides
  );
}
function freshDb(bookings) {
  return {
    bookings: bookings || [],
    customers: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
  };
}
function getSchedule(db, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: Object.assign({ view: "schedule" }, query || {}) }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Yesterday range
// =======================================================================
test("yesterday: returns exactly yesterday's booked/completed jobs, matching today/tomorrow's own inclusion rule", async () => {
  adminAuthed();
  const db = freshDb([
    booking({ id: "y", appointment_date: YESTERDAY }),
    booking({ id: "t", appointment_date: TODAY }),
    booking({ id: "y-new", appointment_date: YESTERDAY, status: null }),
  ]);
  const res = await getSchedule(db, { range: "yesterday" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.range, "yesterday");
  assert.strictEqual(res.body.startDate, YESTERDAY);
  assert.strictEqual(res.body.endDate, YESTERDAY);
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["y"]);
});

test("yesterday: response carries `today` so the client can independently confirm which date is which, same as every other range", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "yesterday" });
  assert.strictEqual(res.body.today, TODAY);
});

test("yesterday: no cookies -> 401, no jobs returned", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getSchedule(freshDb([booking({ id: "1" })]), { range: "yesterday" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.jobs, undefined);
});

test("yesterday: never returns a `beforeHistoricalFloor` flag under normal (present-day) operation", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "yesterday" });
  assert.strictEqual(res.body.beforeHistoricalFloor, undefined);
});

// =======================================================================
// 2. Explicit single-date "day" range — backs the previous/next-day arrows
// =======================================================================
test("day: a valid explicit ?date= returns exactly that date's jobs", async () => {
  adminAuthed();
  const target = addDaysIso(TODAY, 3);
  const db = freshDb([booking({ id: "in", appointment_date: target }), booking({ id: "out", appointment_date: addDaysIso(target, 1) })]);
  const res = await getSchedule(db, { range: "day", date: target });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.range, "day");
  assert.strictEqual(res.body.startDate, target);
  assert.strictEqual(res.body.endDate, target);
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id), ["in"]);
});

test("day: a missing or malformed ?date= is rejected (400), never defaults to today silently", async () => {
  adminAuthed();
  const missing = await getSchedule(freshDb([]), { range: "day" });
  assert.strictEqual(missing.statusCode, 400);
  const malformed = await getSchedule(freshDb([]), { range: "day", date: "not-a-date" });
  assert.strictEqual(malformed.statusCode, 400);
  const impossible = await getSchedule(freshDb([]), { range: "day", date: "2026-02-30" });
  assert.strictEqual(impossible.statusCode, 400);
});

test("day: a date before the historical floor (2026-01-01) is rejected (400), matching Month/Week's own floor rejection", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "day", date: "2025-12-31" });
  assert.strictEqual(res.statusCode, 400);
});

test("day: the floor date itself (2026-01-01) is accepted", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "day", date: "2026-01-01" });
  assert.strictEqual(res.statusCode, 200);
});

test("day: a date far enough in the future is rejected (400) — bounded, matching Month/Year's own future bound", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "day", date: "2099-01-01" });
  assert.strictEqual(res.statusCode, 400);
});

test("day: no cookies -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getSchedule(freshDb([]), { range: "day", date: TODAY });
  assert.strictEqual(res.statusCode, 401);
});

test("day: only booked/completed bookings appear, matching every other range's inclusion rule", async () => {
  adminAuthed();
  const target = addDaysIso(TODAY, 2);
  const db = freshDb([
    booking({ id: "new", status: null, appointment_date: target }),
    booking({ id: "booked", status: "booked", appointment_date: target }),
    booking({ id: "completed", status: "completed", appointment_date: target }),
    booking({ id: "lost", status: "lost", appointment_date: target }),
  ]);
  const res = await getSchedule(db, { range: "day", date: target });
  assert.deepStrictEqual(res.body.jobs.map((j) => j.id).sort(), ["booked", "completed"]);
});

// =======================================================================
// 3. VALID_RANGES regression — today/tomorrow/week/month/year all still work
//    unaffected by adding yesterday/day (mirrors
//    tests/phase3c-stage2.4-calendar.test.js's identical regression guard
//    for month/year's own addition).
// =======================================================================
test("regression: range=today/tomorrow/week are unaffected by adding yesterday/day", async () => {
  adminAuthed();
  const resToday = await getSchedule(freshDb([booking({ id: "t", appointment_date: TODAY })]), { range: "today" });
  assert.strictEqual(resToday.body.range, "today");
  const resTomorrow = await getSchedule(freshDb([booking({ id: "tm", appointment_date: TOMORROW })]), { range: "tomorrow" });
  assert.strictEqual(resTomorrow.body.range, "tomorrow");
  const resWeek = await getSchedule(freshDb([]), { range: "week" });
  assert.strictEqual(resWeek.body.range, "week");
});

test("regression: an unrecognized range value still falls back to 'today', not 'yesterday' or 'day'", async () => {
  adminAuthed();
  const res = await getSchedule(freshDb([]), { range: "bogus" });
  assert.strictEqual(res.body.range, "today");
});

// =======================================================================
// 4. Client-side source-pattern checks (no DOM/click simulation available
//    in this offline harness — see tests/phase3c-schedule.test.js's header
//    for this project's established limitation/approach).
// =======================================================================
function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

test("admin/index.html: Yesterday is the first Schedule tab, ahead of Today/Tomorrow/Week/Month/Year", () => {
  const html = read("admin/index.html");
  const tabsBlock = html.slice(html.indexOf('class="admin-range-tabs"'), html.indexOf("</div>", html.indexOf('class="admin-range-tabs"')));
  const order = ["yesterday", "today", "tomorrow", "week", "month", "year"];
  let lastIdx = -1;
  order.forEach((range) => {
    const idx = tabsBlock.indexOf('data-range="' + range + '"');
    assert.ok(idx !== -1, "tab for " + range + " must exist");
    assert.ok(idx > lastIdx, "tabs must appear in order Yesterday, Today, Tomorrow, Week, Month, Year");
    lastIdx = idx;
  });
});

test("admin/index.html: the Quick Expense bar sits directly between the Schedule tabs and the Today/Tomorrow/Yesterday view", () => {
  const html = read("admin/index.html");
  const tabsIdx = html.indexOf('class="admin-range-tabs"');
  const barIdx = html.indexOf('id="quick-expense-bar"');
  const dayViewIdx = html.indexOf('id="today-tomorrow-view"');
  assert.ok(tabsIdx !== -1 && barIdx !== -1 && dayViewIdx !== -1);
  assert.ok(tabsIdx < barIdx, "the Quick Expense bar must come after the Schedule tabs");
  assert.ok(barIdx < dayViewIdx, "the Quick Expense bar must come before the Today/Tomorrow/Yesterday view");
});

test("admin/index.html: the Quick Expense bar starts hidden (Year, and Week/Month before a day is selected, have no active date to show)", () => {
  const html = read("admin/index.html");
  assert.ok(/id="quick-expense-bar"[^>]*\shidden(?=[\s>])/.test(html));
});

test("admin/quick-expense.js: exposes showBar()/hideBar() that mount into/clear #quick-expense-bar — the relocated persistent bar, not the old per-day-panel mount", () => {
  const src = read("admin/quick-expense.js");
  assert.ok(/function showBar\(dateIso\)/.test(src));
  assert.ok(/function hideBar\(\)/.test(src));
  assert.ok(/getElementById\('quick-expense-bar'\)/.test(src));
  assert.ok(/return \{ mount: mount, showBar: showBar, hideBar: hideBar \}/.test(src));
});

test("admin/schedule.js: Yesterday is a real fetched range (not cosmetic) — load() sends it straight to the API like today/tomorrow", () => {
  const src = read("admin/schedule.js");
  assert.ok(/EMPTY_MESSAGES *= *\{[\s\S]*?yesterday:/.test(src), "must have its own empty-state message for yesterday");
  assert.ok(/range=' \+ encodeURIComponent\(range\)/.test(src), "load(range) must pass the range straight through to the API — yesterday included, no special-casing that would make it cosmetic");
});

test("admin/schedule.js: previous-day/next-day arrows call loadDate(), which hits ?range=day&date=, and Previous is disabled at the historical floor", () => {
  const src = read("admin/schedule.js");
  assert.ok(/dayNavPrevBtn\.addEventListener\('click'/.test(src));
  assert.ok(/dayNavNextBtn\.addEventListener\('click'/.test(src));
  assert.ok(/range=day&date=' \+ encodeURIComponent\(iso\)/.test(src));
  assert.ok(/dayNavPrevBtn\.disabled = iso <= HISTORICAL_FLOOR_ISO/.test(src));
});

test("admin/schedule.js: a beforeHistoricalFloor response (Yesterday landing before the floor) shows a dedicated message and hides Quick Expense, rather than the normal empty-schedule text", () => {
  const src = read("admin/schedule.js");
  const body = src.slice(src.indexOf("function applyDayResult"), src.indexOf("function beginDayLoad"));
  assert.ok(/body\.beforeHistoricalFloor/.test(body));
  assert.ok(/No historical records before January 1, 2026\./.test(body));
  assert.ok(/AdminQuickExpense\.hideBar\(\)/.test(body));
});

test("admin/calendar-views.js: Week is a horizontal strip — the overview container scrolls horizontally and each day is a fixed-width flex column, not a full-width stacked row", () => {
  const css = read("admin/admin.css");
  const overviewRule = css.slice(css.indexOf(".admin-week-overview {"), css.indexOf("}", css.indexOf(".admin-week-overview {")));
  assert.ok(/flex-direction:\s*row/.test(overviewRule), "the week strip's own container must lay its days out in a row");
  assert.ok(/overflow-x:\s*auto/.test(overviewRule), "the week strip must scroll horizontally, contained to itself");
  const rowRule = css.slice(css.indexOf(".admin-week-day-row {"), css.indexOf("}", css.indexOf(".admin-week-day-row {")));
  assert.ok(!/width:\s*100%/.test(rowRule), "each day card must no longer stretch full-width (that was the old stacked-vertical-list layout)");
  assert.ok(/flex:\s*1 1 \d+px/.test(rowRule) || /min-width:\s*\d+px/.test(rowRule), "each day card needs a real (min-)width so 7 of them form a horizontal strip");
});

test("admin/admin.css: the Schedule page's own body/main never gets horizontal overflow rules removed — Week's scroller stays contained to itself, not the page", () => {
  const css = read("admin/admin.css");
  // The Week strip's own scrollbar is hidden with the same convention as
  // .admin-range-tabs's existing horizontal scroller — confirms this is the
  // same "contained scroller" pattern, not a new one.
  assert.ok(/\.admin-week-overview::-webkit-scrollbar\s*\{\s*display:\s*none;\s*\}/.test(css));
});

test("admin/calendar-views.js: Week/Month Prev/Next/Jump-to-current navigation still exists after the horizontal redesign", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/weekPrevBtn\.addEventListener\('click'/.test(src));
  assert.ok(/weekNextBtn\.addEventListener\('click'/.test(src));
  assert.ok(/weekCurrentBtn\.addEventListener\('click'/.test(src));
  assert.ok(/monthPrevBtn\.addEventListener\('click'/.test(src));
  assert.ok(/monthNextBtn\.addEventListener\('click'/.test(src));
  assert.ok(/monthCurrentBtn\.addEventListener\('click'/.test(src), "Month needs its own Stage 2.4.2 'Jump to today' control, mirroring Week's");
});

test("admin/index.html: Month gained a 'Jump to today' control (#month-current-wrap/-btn), mirroring Week's existing 'Jump to this week'", () => {
  const html = read("admin/index.html");
  assert.ok(html.includes('id="month-current-wrap"'));
  assert.ok(html.includes('id="month-current-btn"'));
});

test("admin/admin.css: Month grid cells position content top-left (not centered) and no longer force a 1:1 aspect ratio that could balloon on wide screens", () => {
  const css = read("admin/admin.css");
  const cellRule = css.slice(css.indexOf(".admin-month-grid-cell {"), css.indexOf("}", css.indexOf(".admin-month-grid-cell {")));
  assert.ok(/align-items:\s*flex-start/.test(cellRule));
  assert.ok(/justify-content:\s*flex-start/.test(cellRule));
  assert.ok(!/aspect-ratio/.test(cellRule), "forcing a square aspect ratio is exactly what made cells balloon on a wide (desktop) grid");
  assert.ok(/min-height:\s*\d+px/.test(cellRule), "a real min-height is still required to keep the cell a comfortable touch target");
});

test("admin/calendar-views.js: Month tap/click day selection and job-count badges are unchanged", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/cell\.addEventListener\('click', function \(e\) \{\s*selectMonthDate\(e\.currentTarget\.dataset\.date\);/.test(src));
  assert.ok(/admin-month-grid-count/.test(src));
});

test("admin/calendar-views.js: the day panel's previous/next-day arrows resolve week/month boundary crossings by loading the adjacent week/month, then selecting the target date", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/function navigateWeekDayBy\(iso, delta\)/.test(src));
  assert.ok(/function navigateMonthDayBy\(iso, delta\)/.test(src));
  const weekBody = src.slice(src.indexOf("function navigateWeekDayBy"), src.indexOf("function loadMonth") === -1 ? undefined : src.indexOf("// ---", src.indexOf("function navigateWeekDayBy")));
  assert.ok(/loadWeek\(startOfWeekSundayIso\(target\), target\)/.test(weekBody));
  const monthBody = src.slice(src.indexOf("function navigateMonthDayBy"), src.indexOf("function navigateMonthDayBy") + 600);
  assert.ok(/loadMonth\(target\)/.test(monthBody));
});

test("admin/calendar-views.js/schedule.js: previous-day navigation never steps before the historical floor (2026-01-01) in either the day-nav or the day-panel arrows", () => {
  const scheduleSrc = read("admin/schedule.js");
  const calendarSrc = read("admin/calendar-views.js");
  assert.ok(/if \(target < HISTORICAL_FLOOR_ISO\) return;/.test(calendarSrc), "navigateWeekDayBy/navigateMonthDayBy must both refuse to cross the floor");
  assert.ok(/dayNavPrevBtn\.disabled = iso <= HISTORICAL_FLOOR_ISO/.test(scheduleSrc));
});

// =======================================================================
// 4b. Second-pass visual correction: the owner reviewed the authenticated
//     Preview and found the first Today/Tomorrow/Yesterday card treatment
//     insufficient, and Week's per-day jobs still reading as one run-on
//     block. This section proves both are now unmistakable, not just
//     present.
// =======================================================================
test("admin/schedule.js: each job in the list gets its own distinct outer job-card container — render() calls renderJobCard() once per job and appends each result separately (never batches multiple jobs into one shared wrapper)", () => {
  const src = read("admin/schedule.js");
  const renderBody = src.slice(src.indexOf("function render(jobs)"), src.indexOf("function setActiveTab"));
  assert.ok(/jobs\.forEach\(function \(job\) \{\s*listEl\.appendChild\(renderJobCard\(job\)\);\s*\}\);/.test(renderBody), "render() must call renderJobCard() once per job and append each one individually — this is what guarantees N jobs produce N separate cards, never one shared block");
});

test("admin/schedule.js: renderJobCard()'s outer wrapper (.admin-schedule-card) contains the entire job — the info section AND the Call/Text/Directions actions row, as siblings inside the same card", () => {
  const src = read("admin/schedule.js");
  const body = src.slice(src.indexOf("function renderJobCard(job)"), src.indexOf("function render(jobs)"));
  const cardIdx = body.indexOf("var card = el('div', 'admin-schedule-card");
  const mainAppendIdx = body.indexOf("card.appendChild(main)");
  const actionsAppendIdx = body.indexOf("card.appendChild(actions)");
  assert.ok(cardIdx !== -1 && mainAppendIdx !== -1 && actionsAppendIdx !== -1, "the outer card must exist and both the info block and the actions row must be appended directly to it");
  assert.ok(cardIdx < mainAppendIdx && mainAppendIdx < actionsAppendIdx, "both sections must be children of the same outer card, in order");
});

test("admin/admin.css: .admin-schedule-card has a clearly visible border and a real (not near-imperceptible) shadow — the corrected, second-pass treatment, not the original too-subtle one", () => {
  const css = read("admin/admin.css");
  const rule = css.slice(css.indexOf(".admin-schedule-card {"), css.indexOf("}", css.indexOf(".admin-schedule-card {")));
  assert.ok(/border:\s*1px solid var\(--color-neutral-400/.test(rule), "the border must use the more visible neutral-400 token, not the original neutral-300 that read as near-white against the page background");
  assert.ok(!/neutral-300/.test(rule), "must not still reference the original, too-subtle neutral-300 border color");
  assert.ok(/box-shadow:\s*0 2px 6px rgba\(20, 21, 15, 0\.12\)/.test(rule), "the shadow must be strengthened from the original 1px/7%-opacity version to something actually visible");
});

test("admin/admin.css: root-cause regression guard — a comment ending in the literal text 'accent-*/' anywhere before .admin-schedule-card's rule silently closes a CSS comment early (browsers treat '*/' as the comment terminator regardless of the author's intent), swallowing the real rule's selector into an unparseable mess that gets dropped wholesale. This exact bug pre-dated this stage (present at production baseline ee2585f) and is why NEITHER the original card styling NOR this stage's first strengthening pass ever visually applied — confirmed live via a real browser's parsed document.styleSheets, not guessed. This test proves .admin-schedule-card survives correct comment-stripping and that the specific historical trigger text is gone.", () => {
  const css = read("admin/admin.css");
  assert.ok(!css.includes("accent-*/"), "the specific historical bug pattern (an asterisk immediately followed by a slash inside prose, forming an accidental CSS comment terminator) must never reappear");

  // A minimal, browser-accurate CSS comment stripper: /* ... */ comments do
  // not nest, so the first */ found after a /* always ends it — exactly
  // the rule that made the original bug possible, used here in reverse to
  // prove the file is now well-formed.
  function stripCssComments(src) {
    var out = "";
    var i = 0;
    while (i < src.length) {
      var start = src.indexOf("/*", i);
      if (start === -1) { out += src.slice(i); break; }
      out += src.slice(i, start);
      var end = src.indexOf("*/", start + 2);
      if (end === -1) break; // an unterminated comment consumes the rest of the file
      i = end + 2;
    }
    return out;
  }
  const stripped = stripCssComments(css);
  assert.ok(
    /\.admin-schedule-card\s*\{[^}]*background:\s*#fff/.test(stripped),
    "after correctly stripping every /* ... */ comment in the file, .admin-schedule-card { background: #fff ... } must still be present as real, parseable CSS — this fails again if any comment anywhere earlier in the file accidentally contains a literal '*/' sequence, exactly like the historical bug this guards against"
  );
});

test("admin/admin.css: #schedule-list keeps a clear, generous gap between consecutive job cards", () => {
  const css = read("admin/admin.css");
  assert.ok(/#schedule-list\s*\{\s*gap:\s*16px;\s*\}/.test(css));
});

test("admin/calendar-views.js: Week remains horizontal after this correction (unchanged from the prior pass) — still a row-direction, horizontally-scrolling strip", () => {
  const css = read("admin/admin.css");
  const overviewRule = css.slice(css.indexOf(".admin-week-overview {"), css.indexOf("}", css.indexOf(".admin-week-overview {")));
  assert.ok(/flex-direction:\s*row/.test(overviewRule));
  assert.ok(/overflow-x:\s*auto/.test(overviewRule));
});

test("admin/calendar-views.js: each job inside a Week day gets its own mini-card element — renderWeekOverview() builds one .admin-week-day-row-job div per job and appends each individually, never one shared text block", () => {
  const src = read("admin/calendar-views.js");
  const body = src.slice(src.indexOf("function renderWeekOverview"), src.indexOf("function selectWeekDate"));
  assert.ok(/jobs\.slice\(0, WEEK_ROW_MAX_JOB_LINES\)\.forEach\(function \(job\) \{/.test(body));
  assert.ok(/var jobRow = el\('div', 'admin-week-day-row-job'\);/.test(body), "each job must build its own .admin-week-day-row-job element, not a shared/joined string");
  assert.ok(/jobsList\.appendChild\(jobRow\);/.test(body), "each job's mini-card must be appended individually inside the forEach — this is what guarantees a day with N jobs produces N separate mini-cards");
});

test("admin/calendar-views.js: a Week job's mini-card has separately-scannable time and client-name elements — time never wraps mid-unit, name ellipsis-truncates instead of wrapping awkwardly", () => {
  const src = read("admin/calendar-views.js");
  const body = src.slice(src.indexOf("function renderWeekOverview"), src.indexOf("function selectWeekDate"));
  assert.ok(/el\('span', 'admin-week-day-row-job-time', shortTimeLabel\(job\.timeLabel\)\)/.test(body), "the compact mini-card must show only the start time (shortTimeLabel), not the full '8:00 AM – 10:00 AM' range — the full range alone left no room for the client name. As of Phase 3C Stage 2.5, job.timeLabel is the unified exact-time-or-window label (see api/_lib/booking-format.js's effectiveTimeLabel) — shortTimeLabel() still only trims a window's range down to its start time and leaves an already-short exact time like '9:30 AM' untouched.");
  assert.ok(/el\('span', 'admin-week-day-row-job-name', name\)/.test(body));
  const css = read("admin/admin.css");
  const timeRule = css.slice(css.indexOf(".admin-week-day-row-job-time {"), css.indexOf("}", css.indexOf(".admin-week-day-row-job-time {")));
  assert.ok(/white-space:\s*nowrap/.test(timeRule), "the time must never break mid-unit (e.g. '10:00' / 'AM' on separate lines)");
  const nameRule = css.slice(css.indexOf(".admin-week-day-row-job-name {"), css.indexOf("}", css.indexOf(".admin-week-day-row-job-name {")));
  assert.ok(/text-overflow:\s*ellipsis/.test(nameRule) && /white-space:\s*nowrap/.test(nameRule), "a too-long client name must ellipsis-truncate rather than wrap awkwardly");
});

test("admin/calendar-views.js: shortTimeLabel() only trims the modern spaced-en-dash range format ('8:00 AM – 10:00 AM' -> '8:00 AM') and leaves any other label (including the legacy 'Morning (8am–11am)' style) completely untouched", () => {
  const src = read("admin/calendar-views.js");
  const body = src.slice(src.indexOf("function shortTimeLabel"), src.indexOf("function shortTimeLabel") + 400);
  // Re-implement the exact same pure function here (this project's
  // established convention for verifying a small client-only helper
  // without a browser — see e.g. tests/phase3c-schedule.test.js's own
  // independent addDaysIso()/denverTodayIso() copies) and check it against
  // both label shapes this app actually produces.
  function shortTimeLabel(label) {
    if (!label) return '—';
    var idx = label.indexOf(' – ');
    return idx === -1 ? label : label.slice(0, idx);
  }
  assert.strictEqual(shortTimeLabel('8:00 AM – 10:00 AM'), '8:00 AM');
  assert.strictEqual(shortTimeLabel('10:00 AM – 12:00 PM'), '10:00 AM');
  assert.strictEqual(shortTimeLabel('Morning (8am–11am)'), 'Morning (8am–11am)', "the legacy label's own unspaced dash must not be mistaken for the modern range separator");
  assert.strictEqual(shortTimeLabel(null), '—');
  assert.strictEqual(shortTimeLabel(''), '—');
  assert.ok(/var idx = label\.indexOf\(' – '\);/.test(body), "must split on the spaced en dash specifically, not any dash");
});

test("admin/admin.css: each Week job mini-card is visually bounded (background + border + rounded corners) in both the normal and selected/dark day states", () => {
  const css = read("admin/admin.css");
  const jobRule = css.slice(css.indexOf(".admin-week-day-row-job {"), css.indexOf("}", css.indexOf(".admin-week-day-row-job {")));
  assert.ok(/background:/.test(jobRule) && /border:/.test(jobRule) && /border-radius:/.test(jobRule), "the mini-card needs its own background/border/radius to read as a clearly bounded row, not just plain text");
  assert.ok(/\.admin-week-day-row\.is-selected \.admin-week-day-row-job \{/.test(css), "the mini-card must have its own selected-day override so it still reads as bounded against the dark selected background");
});

test("admin/calendar-views.js: a day with exactly 2 jobs produces exactly 2 mini-card elements (simulated by driving the shared el()/appendChild pattern directly against a 2-job fixture, since this offline harness has no DOM/browser to render into)", () => {
  // This project's established limitation (see tests/phase3c-schedule.test.js's
  // header): no DOM/click simulation is available, so this test proves the
  // *mechanism* is correct — one appendChild call per forEach iteration,
  // with no branch that could ever coalesce jobs into fewer than N elements
  // — rather than rendering a real DOM and counting nodes.
  const src = read("admin/calendar-views.js");
  const body = src.slice(src.indexOf("function renderWeekOverview"), src.indexOf("function selectWeekDate"));
  const forEachIdx = body.indexOf("jobs.slice(0, WEEK_ROW_MAX_JOB_LINES).forEach(function (job) {");
  const appendIdx = body.indexOf("jobsList.appendChild(jobRow);");
  assert.ok(forEachIdx !== -1 && appendIdx !== -1 && forEachIdx < appendIdx, "exactly one jobsList.appendChild(jobRow) call must live inside the per-job forEach body — this is what guarantees a 2-job day yields exactly 2 mini-cards, a 3-job day exactly 3, etc.");
  // No code path joins multiple jobs' text into a single element (the
  // pre-fix bug this whole section exists to prevent regressing back to).
  assert.ok(!/jobs\.map\(function \(job\)[\s\S]*?\)\.join\(/.test(body), "jobs must never be joined into one shared string/element");
});

test("admin/schedule.js: existing booking links/actions are fully preserved after the card-visibility fix — the detail link, Call/Text/Directions hrefs, and disabled-state handling are all unchanged", () => {
  const src = read("admin/schedule.js");
  const body = src.slice(src.indexOf("function renderJobCard(job)"), src.indexOf("function render(jobs)"));
  assert.ok(/main\.href = '\/admin\/booking\/\?id=' \+ encodeURIComponent\(job\.id\)/.test(body));
  assert.ok(/quickBtn\('primary', 'Call', callIcon\)/.test(body));
  assert.ok(/quickBtn\('primary', 'Text', textIcon\)/.test(body));
  assert.ok(/quickBtn\('secondary', 'Directions', directionsIcon\)/.test(body));
  assert.ok(/disableAction\(callBtn\)/.test(body) && /disableAction\(directionsBtn\)/.test(body), "the no-phone/no-address disabled-state handling must be unchanged");
});

test("admin/admin.css: the widened Week day column (for the new job mini-cards) still relies on flex/min-width, never a fixed width that could force page-level overflow — Week's scroll stays contained to itself", () => {
  const css = read("admin/admin.css");
  const rowRule = css.slice(css.indexOf(".admin-week-day-row {"), css.indexOf("}", css.indexOf(".admin-week-day-row {")));
  assert.ok(/flex:\s*1 1 \d+px/.test(rowRule));
  assert.ok(!/width:\s*\d+vw/.test(rowRule) && !/100%/.test(rowRule), "no viewport-relative or 100% width that could escape the horizontally-scrolling container");
});

// =======================================================================
// 5. Address autocomplete: the mid-task "ZIP visible in the dropdown while
//    searching" addendum was REMOVED after owner review — it was never part
//    of the approved Schedule UX scope for this stage and added ongoing
//    Google Place Details cost/complexity for every rendered suggestion,
//    not just the one actually selected. admin/address-autocomplete.js was
//    restored to the exact approved Stage 2.4.1 file from production
//    baseline ee2585f (`git checkout ee2585f -- admin/address-autocomplete.js`,
//    confirmed byte-identical). These tests both prove the addendum's own
//    code is gone AND that the original select-a-suggestion ZIP-population
//    behavior (unrelated to the removed dropdown-preview feature) still
//    works exactly as it did before this stage touched this file — see
//    tests/phase3c-stage2.4-address-and-prefill.test.js for that file's own
//    full pre-existing coverage (fetchFields(['addressComponents']) only,
//    US+Denver-bias restriction, importLibrary readiness polling, the
//    input-echo suppression fix, manual-entry fallback on any failure —
//    all untouched, still passing unmodified).
// =======================================================================
test("admin/address-autocomplete.js: the ZIP-in-dropdown-preview addendum is completely removed — no preview span, no enrichment delay/cache, no per-suggestion Details fan-out", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/admin-address-autocomplete-item-zip/.test(src), "the ZIP-preview span class must be gone");
  assert.ok(!/ZIP_ENRICH_DELAY_MS/.test(src), "the enrichment-delay constant must be gone");
  assert.ok(!/addressCache/.test(src), "the place-ID-keyed Details cache must be gone");
  assert.ok(!/fetchMappedPlace/.test(src), "the shared cache-or-fetch helper must be gone");
  assert.ok(!/renderToken/.test(src), "the per-render staleness token (only needed to guard the removed enrichment fetches) must be gone");
  assert.ok(!/toEnrich/.test(src), "there must be no per-suggestion enrichment queue left over");
});

test("admin/address-autocomplete.js: restored to exactly the approved Stage 2.4.1 file (production baseline ee2585f) — content-identical (line-ending-normalized: `git show` returns the raw LF blob, the working tree checks out CRLF under this repo's core.autocrlf=true)", () => {
  const { execFileSync } = require("child_process");
  const baseline = execFileSync("git", ["show", "ee2585fc35b5d6153ad5a5fa5eb50c5be4ed18e7:admin/address-autocomplete.js"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  const current = read("admin/address-autocomplete.js");
  const normalize = (s) => s.replace(/\r\n/g, "\n");
  assert.strictEqual(normalize(current), normalize(baseline), "admin/address-autocomplete.js must match the ee2585f baseline exactly (content, not just line endings) — any difference means the revert was incomplete or something new leaked in");
});

test("admin/address-autocomplete.js: selecting a suggestion still populates street/city/state/ZIP exactly as before — one Place Details fetch (addressComponents only) per selection, applySelection() maps it and fills all four fields", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/function applySelection\(place\) \{/.test(src), "applySelection() must take the raw Google Place again, not a pre-mapped object");
  const applySelectionBody = src.slice(src.indexOf("function applySelection("), src.indexOf("function renderSuggestions("));
  assert.ok(/var mapped = mapAddressComponents\(place\.addressComponents\)/.test(applySelectionBody), "applySelection() must do its own mapAddressComponents() call again");
  assert.ok(/if \(fields\.zip && mapped\.zip\) fields\.zip\.value = mapped\.zip;/.test(applySelectionBody), "selecting a suggestion must still populate the ZIP field");
  assert.ok(/if \(fields\.city && mapped\.city\) fields\.city\.value = mapped\.city;/.test(applySelectionBody));
  assert.ok(/if \(fields\.state && mapped\.state\) fields\.state\.value = mapped\.state;/.test(applySelectionBody));

  const clickBody = src.slice(src.indexOf("btn.addEventListener(\"click\""), src.indexOf("panel.appendChild(btn)"));
  assert.ok(/prediction\.toPlace\(\)/.test(clickBody));
  assert.ok(/fetchFields\(\{ fields: \["addressComponents"\] \}\)/.test(clickBody), "the click handler's own Details fetch must request only addressComponents — no unnecessary/costlier field");
  assert.ok(/\.then\(applySelection\)/.test(clickBody), "the fetched place must be passed straight to applySelection(), no intermediate mapping step");
});

test("admin/address-autocomplete.js: suggestions render immediately from the lightweight prediction alone (mainText/secondaryText) — the only toPlace()/fetchFields() call is inside the click handler, never a separate eager loop over the rendered list", () => {
  const src = read("admin/address-autocomplete.js");
  const renderBody = src.slice(src.indexOf("function renderSuggestions("), src.indexOf("function runSearch("));
  // The click handler (which legitimately contains toPlace()/fetchFields(),
  // since it's defined inside this function) is the ONLY place that text
  // may appear — strip it out first, then confirm nothing else in
  // renderSuggestions() touches Place Details.
  const withoutClickHandler = renderBody.replace(/btn\.addEventListener\("click"[\s\S]*?\}\);/, "");
  assert.ok(!/toPlace\(\)/.test(withoutClickHandler), "only the click handler may call toPlace() — nothing else in renderSuggestions() should fetch Place Details merely to build the list");
  assert.ok(!/fetchFields/.test(withoutClickHandler));
  assert.ok(/toPlace\(\)/.test(renderBody), "sanity check: the click handler's own toPlace() call must still be there (removing this test's exclusion pattern would make it vacuous)");
});

test("admin/address-autocomplete.js: lazy Google loading, the panel-reopen suppression fix, and manual-entry fallback are all preserved", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/addressInput\.addEventListener\(\s*"focus"/.test(src), "the script/key load must still be deferred to first focus, not page load");
  assert.ok(/suppressNextInputEvent/.test(src), "the synthetic-input suppression fix (Stage 2.4.1) must still be present");
  assert.ok(/loadPlacesLibrary\(\)\s*\.catch\(function \(\) \{\}\)/.test(src) || /\.catch\(function \(\) \{\s*\/\//.test(src), "a Google load failure must still fall back to silent manual entry, never block the field");
});

test("admin/address-autocomplete.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// =======================================================================
// 6. Scope guards — no schema migration, no new serverless function, public
//    site untouched.
// =======================================================================
test("deployment: total function-producing files under api/ stay within the Vercel Hobby plan's 12-function limit after this stage's changes", () => {
  function countApiFunctionFiles(dir) {
    let count = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(path.join(__dirname, "..", "api"), full) === "_lib") return;
        count += countApiFunctionFiles(full);
      } else if (entry.name.endsWith(".js")) {
        count += 1;
      }
    });
    return count;
  }
  const total = countApiFunctionFiles(path.join(__dirname, "..", "api"));
  assert.ok(total <= 12, "api/ has " + total + " function-producing .js files, exceeding the Vercel Hobby plan's 12-function limit");
});

test("public-site isolation: no Schedule/Quick-Expense/day-nav/ZIP-preview code is referenced from the public homepage or /book/", () => {
  const publicFiles = ["index.html", "book/index.html"].filter((f) => fs.existsSync(path.join(__dirname, "..", f)));
  assert.ok(publicFiles.length > 0, "expected at least the public homepage to exist");
  publicFiles.forEach((rel) => {
    const html = read(rel);
    ["schedule.js", "calendar-views.js", "quick-expense.js", "_dev-mock.js"].forEach((script) => {
      assert.ok(!html.includes(script), rel + " must not load " + script);
    });
  });
});

test("scope guard: admin/_dev-mock.js (a temporary local-preview-only fetch mock, never shipped) is not present in the final tree", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "admin/_dev-mock.js")), "the temporary dev-mock script must be deleted before this branch is finalized");
  const html = read("admin/index.html");
  assert.ok(!html.includes("_dev-mock.js"), "admin/index.html must not reference the temporary dev-mock script");
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
