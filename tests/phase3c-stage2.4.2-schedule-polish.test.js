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
//     the day-nav/day-panel previous-next controls, and the address
//     autocomplete ZIP-preview addendum.
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
// 5. Address autocomplete ZIP-preview addendum (mid-task addition: the
//    owner reported the ZIP isn't visible in the dropdown while searching,
//    needed to confirm addresses with clients over the phone before an
//    address is even selected).
// =======================================================================
test("admin/address-autocomplete.js: each rendered suggestion gets its own ZIP-preview span, hidden until a value is actually available", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/admin-address-autocomplete-item-zip/.test(src));
  assert.ok(/zipSpan\.setAttribute\("hidden", ""\)/.test(src));
});

test("admin/address-autocomplete.js: ZIP enrichment is debounced separately from the search itself and bails out if a newer render supersedes it — never fetches Place Details for a suggestion list the owner already typed past", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/ZIP_ENRICH_DELAY_MS/.test(src));
  assert.ok(/renderToken/.test(src));
  const enrichBlock = src.slice(src.indexOf("if (toEnrich.length)"), src.indexOf("if (toEnrich.length)") + 800);
  assert.ok(/if \(myToken !== renderToken\) return;/.test(enrichBlock), "the enrichment timer callback must bail out if superseded before it even starts fetching");
});

test("admin/address-autocomplete.js: a suggestion's Place Details are cached by place ID and reused on click — selecting an already-previewed suggestion must not re-fetch", () => {
  const src = read("admin/address-autocomplete.js");
  assert.ok(/function fetchMappedPlace\(prediction\)/.test(src));
  assert.ok(/addressCache\[placeId\] = mapped/.test(src));
  const fetchBody = src.slice(src.indexOf("function fetchMappedPlace"), src.indexOf("function renderSuggestions"));
  assert.ok(/Object\.prototype\.hasOwnProperty\.call\(addressCache, placeId\)/.test(fetchBody), "must check the cache before ever calling toPlace()/fetchFields() again");
});

test("admin/address-autocomplete.js: applySelection() now takes an already-mapped {address,city,state,zip} object directly (shared by the cache-hit and cache-miss paths), not a raw Google Place", () => {
  const src = read("admin/address-autocomplete.js");
  const body = src.slice(src.indexOf("function applySelection("), src.indexOf("function fetchMappedPlace"));
  assert.ok(/function applySelection\(mapped\) \{/.test(src));
  assert.ok(!/mapAddressComponents\(place\.addressComponents\)/.test(body), "applySelection() must no longer do its own mapping — that now happens once, in fetchMappedPlace()");
});

test("admin/address-autocomplete.js: still requests fields:['addressComponents'] only, even with the new preview fetch — no unnecessary/costlier Place field added", () => {
  const src = read("admin/address-autocomplete.js");
  const matches = src.match(/fetchFields\(\{ fields: \[[^\]]*\] \}\)/g) || [];
  assert.ok(matches.length >= 1);
  matches.forEach((m) => assert.ok(/\["addressComponents"\]/.test(m), "every fetchFields() call must request only addressComponents: " + m));
});

test("admin/address-autocomplete.js never uses innerHTML/insertAdjacentHTML/document.write, even after the ZIP-preview addendum", () => {
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
