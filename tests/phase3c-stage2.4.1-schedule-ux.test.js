// Local, offline test harness for Phase 3C Stage 2.4.1: the Selected-day/
// Daily layout reorder (originally Selected date -> Quick Expense icons ->
// Jobs; Stage 2.4.2 later moved Quick Expense out to its own persistent bar
// — see the first two tests below, updated in place rather than left
// asserting stale behavior), the new compact per-job card, and the Week
// redesign (a 7-day overview + the shared selected-day panel, replacing the
// old rolling list-of-cards presentation — Stage 2.4.2 additionally made
// this overview horizontal instead of stacked; see
// tests/phase3c-stage2.4.2-schedule-polish.test.js for that CSS/markup
// coverage). No API contract changed this stage — Week/Month/Year all
// still call the exact same api/admin/bookings.js ?view=schedule endpoint
// established in Stage 2.4 (see tests/phase3c-stage2.4-calendar.test.js for
// that server-side coverage, unchanged and still passing).
//
// This is client-rendering-only work, so — matching this project's
// established, previously-disclosed limitation (no DOM/click simulation
// available in this test setup, see tests/phase3c-schedule.test.js's
// header) — this suite verifies it via source-pattern checks, the same
// approach tests/phase3c-stage2.4-address-and-prefill.test.js already
// uses for other client-only behavior. The actual interactive behavior
// (7 days always rendering, a day's job-count/compact lines, tapping a day
// showing the correct selected-day panel, the reordered hierarchy) was
// additionally verified directly in a local browser session with the
// fetch API mocked to match the real endpoint's response shape — see the
// stage report.
//
// Run with:  node tests/phase3c-stage2.4.1-schedule-ux.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

const src = read("admin/calendar-views.js");

// Isolates a named function's body (up to the next top-level "function "
// or the end of the IIFE) purely for scoped checks below — e.g. confirming
// renderDailyJobCard() itself never references Call/Text/Directions,
// without that check accidentally matching some other function.
function functionBody(name) {
  const start = src.indexOf("function " + name);
  assert.ok(start !== -1, name + " must exist in admin/calendar-views.js");
  const nextFn = src.indexOf("\n  function ", start + 1);
  return nextFn === -1 ? src.slice(start) : src.slice(start, nextFn);
}

// =======================================================================
// 1. Selected-day panel hierarchy: Selected date (with previous/next-day
//    arrows, Stage 2.4.2) -> Jobs (the action link + each job card), in
//    that order. Quick Expense no longer mounts inside this panel as of
//    Stage 2.4.2 — see tests/phase3c-stage2.4.2-schedule-polish.test.js for
//    its relocated-bar coverage.
// =======================================================================
test("renderDayPanel(): appends the heading row, then the action link, then the jobs list — in that order", () => {
  const body = functionBody("renderDayPanel");
  const headingRowIdx = body.indexOf("container.appendChild(headingRow)");
  const actionIdx = body.indexOf("container.appendChild(actionLink)");
  const jobsIdx = body.indexOf("container.appendChild(jobsWrap)");
  [headingRowIdx, actionIdx, jobsIdx].forEach((i) => assert.ok(i !== -1, "all three sections must be appended to the day panel"));
  assert.ok(headingRowIdx < actionIdx, "the date heading row must come before the Jobs section");
  assert.ok(actionIdx < jobsIdx, "the +New/Past Job action stays with the Jobs section, immediately above the job cards");
});

test("renderDayPanel(): Stage 2.4.2 — no longer mounts admin/quick-expense.js inside the day panel (relocated to the persistent top-of-page bar)", () => {
  const body = functionBody("renderDayPanel");
  assert.ok(!/AdminQuickExpense\.mount/.test(body), "the day panel must not mount Quick Expense directly any more");
});

test("renderDayPanel(): previous/next-day arrows call the caller-supplied onNavigate(-1)/onNavigate(1), and Previous is disabled at the historical floor", () => {
  const body = functionBody("renderDayPanel");
  assert.ok(/onNavigate\(-1\)/.test(body), "the previous-day arrow must call onNavigate(-1)");
  assert.ok(/onNavigate\(1\)/.test(body), "the next-day arrow must call onNavigate(1)");
  assert.ok(/prevBtn\.disabled = iso <= HISTORICAL_FLOOR_ISO/.test(body), "previous-day must be disabled once the displayed date is the historical floor itself");
});

test("selectWeekDate()/selectMonthDate() each pass their own onNavigate callback into renderDayPanel(), and call showQuickExpenseFor() with the selected date", () => {
  assert.ok(/function selectWeekDate\(iso\) \{[\s\S]*?renderDayPanel\(weekDayPanel, iso, state\.weekJobsByDate\[iso\] \|\| \[\], function \(delta\) \{ navigateWeekDayBy\(iso, delta\); \}\);[\s\S]*?showQuickExpenseFor\(iso\);/.test(src));
  assert.ok(/function selectMonthDate\(iso\) \{[\s\S]*?renderDayPanel\(monthDayPanel, iso, state\.monthJobsByDate\[iso\] \|\| \[\], function \(delta\) \{ navigateMonthDayBy\(iso, delta\); \}\);[\s\S]*?showQuickExpenseFor\(iso\);/.test(src));
});

test("renderDayPanel(): the +New/Past Job split by historical-vs-current/future date is unchanged", () => {
  const body = functionBody("renderDayPanel");
  assert.ok(/if \(iso < todayIso\) \{/.test(body));
  assert.ok(/booking-past\/\?date=' \+ encodeURIComponent\(iso\)/.test(body));
  assert.ok(/booking-new\/\?date=' \+ encodeURIComponent\(iso\)/.test(body));
});

test("renderDayPanel() is shared: both Month's selectMonthDate() and Week's selectWeekDate() call it — never two separate copies", () => {
  assert.ok(/function selectMonthDate\(iso\) \{[\s\S]*?renderDayPanel\(monthDayPanel, iso,/.test(src));
  assert.ok(/function selectWeekDate\(iso\) \{[\s\S]*?renderDayPanel\(weekDayPanel, iso,/.test(src));
});

// =======================================================================
// 2. Daily jobs are compact, fully-tappable cards — Time, Client name, one
//    secondary line, no separate Call/Text/Directions row, entire card is
//    a single link to the existing booking detail page.
// =======================================================================
test("formatPrice(): null/undefined/empty-string are treated as 'no price' (omitted), never coerced to $0 — found live on Production (a real job with no estimatedPrice rendered '$0' before this guard was restored)", () => {
  const body = functionBody("formatPrice");
  assert.ok(/if \(value === null \|\| value === undefined \|\| value === ''\) return null;/.test(body), "must reject null/undefined/'' BEFORE Number(value) — Number(null) and Number('') are both 0, a finite number, so without this guard a missing price silently renders as $0");
});

test("renderDailyJobCard(): the whole card is a single <a> to the existing booking detail page — never a small nested link", () => {
  const body = functionBody("renderDailyJobCard");
  assert.ok(/var a = document\.createElement\('a'\)/.test(body));
  assert.ok(/a\.href = '\/admin\/booking\/\?id=' \+ encodeURIComponent\(job\.id\)/.test(body));
});

test("renderDailyJobCard(): information hierarchy is Time, then Client name, then one secondary meta line", () => {
  const body = functionBody("renderDailyJobCard");
  const timeIdx = body.indexOf("admin-daily-job-card-time");
  const nameIdx = body.indexOf("admin-daily-job-card-name");
  const metaIdx = body.indexOf("admin-daily-job-card-meta");
  assert.ok(timeIdx !== -1 && nameIdx !== -1 && metaIdx !== -1);
  assert.ok(timeIdx < nameIdx, "time must render before the client name");
  assert.ok(nameIdx < metaIdx, "client name must render before the secondary meta line");
});

test("renderDailyJobCard(): never overcrowded with a separate Call/Text/Directions action row (those stay one tap away on booking detail)", () => {
  const body = functionBody("renderDailyJobCard");
  assert.ok(!/tel:/.test(body) && !/sms:/.test(body) && !/Directions/.test(body), "the compact daily card must not duplicate the fuller schedule card's action buttons");
});

test("renderDailyJobCard() is a different, simpler renderer than admin/schedule.js's renderJobCard() — Today/Tomorrow's fuller card is preserved untouched", () => {
  const scheduleSrc = read("admin/schedule.js");
  assert.ok(/function renderJobCard\(job\) \{/.test(scheduleSrc), "schedule.js must still export its own, unmodified renderJobCard for Today/Tomorrow");
  assert.ok(/admin-schedule-card-actions/.test(scheduleSrc), "Today/Tomorrow's Call/Text/Directions row must be untouched");
});

// =======================================================================
// 3. Week redesign: a compact 7-day overview, not seven stacked Daily
//    views. Every day renders, including empty ones; a busy day is capped.
// =======================================================================
test("renderWeekOverview(): always builds exactly 7 day rows, unconditionally — a zero-job day is never skipped", () => {
  const body = functionBody("renderWeekOverview");
  assert.ok(/for \(var i = 0; i < 7; i\+\+\) \{/.test(body));
  // The row itself (weekday + date) must be appended outside any
  // jobs.length-gated branch, so it happens for every day regardless.
  const forIdx = body.indexOf("for (var i = 0; i < 7; i++)");
  const appendIdx = body.indexOf("weekOverviewEl.appendChild(row)");
  const ifJobsIdx = body.indexOf("if (jobs.length) {");
  assert.ok(forIdx < appendIdx);
  assert.ok(appendIdx > ifJobsIdx, "row append must happen after (outside) the jobs-only compact-lines block, so it still runs when a day has zero jobs");
});

test("a busy day's compact lines are capped (WEEK_ROW_MAX_JOB_LINES) with a '+N more' indicator, never left to grow unbounded", () => {
  assert.ok(/WEEK_ROW_MAX_JOB_LINES/.test(src));
  assert.ok(/jobs\.slice\(0, WEEK_ROW_MAX_JOB_LINES\)/.test(src));
  assert.ok(/admin-week-day-row-more/.test(src));
  assert.ok(/'\+' \+ \(jobs\.length - WEEK_ROW_MAX_JOB_LINES\) \+ ' more'/.test(src));
});

test("each week day row shows weekday + date, and a job count only when jobs exist", () => {
  const body = functionBody("renderWeekOverview");
  assert.ok(/admin-week-day-row-weekday/.test(body));
  assert.ok(/admin-week-day-row-date/.test(body));
  assert.ok(/if \(jobs\.length\) \{\s*head\.appendChild\(el\('span', 'admin-week-day-row-count'/.test(body));
});

test("tapping a week day row calls selectWeekDate() with that row's own date, never a stale closed-over value", () => {
  const body = functionBody("renderWeekOverview");
  assert.ok(/selectWeekDate\(e\.currentTarget\.dataset\.date\)/.test(body), "must read the date from the event target, not a shared loop variable, to avoid the classic var-in-a-loop closure bug");
});

test("Week: Prev/Next/Jump-to-this-week are preserved and still driven by the server's own canGoPrevious/isCurrentWeek", () => {
  assert.ok(/weekPrevBtn\.addEventListener\('click'/.test(src));
  assert.ok(/weekNextBtn\.addEventListener\('click'/.test(src));
  assert.ok(/weekCurrentBtn\.addEventListener\('click'/.test(src));
  assert.ok(/weekPrevBtn\.disabled = body\.canGoPrevious === false/.test(src));
  assert.ok(/weekCurrentWrap\.style\.display = body\.isCurrentWeek \? 'none' : 'block'/.test(src));
});

test("Week still fetches via the existing ?view=schedule&range=week endpoint — no new API endpoint added", () => {
  assert.ok(/'\/api\/admin\/bookings\?view=schedule&range=week'/.test(src));
  assert.ok(!/api\/admin\/week/.test(src), "must not introduce a new dedicated week endpoint");
});

test("Week auto-selects today when it falls within the displayed week (matches Month's own auto-select-today default)", () => {
  const body = functionBody("loadWeek");
  assert.ok(/if \(todayIso >= body\.weekStart && todayIso <= body\.weekEnd\) \{/.test(body));
  assert.ok(/selectWeekDate\(todayIso\)/.test(body));
});

// =======================================================================
// Regression: XSS/rendering discipline unchanged after the redesign.
// =======================================================================
test("admin/calendar-views.js and admin/schedule.js still never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/calendar-views.js", "admin/schedule.js"].forEach((rel) => {
    const fileSrc = read(rel);
    assert.ok(!/\.innerHTML\s*=/.test(fileSrc), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(fileSrc), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(fileSrc), rel + " must not call document.write(...)");
  });
});

test("regression: admin/index.html still loads calendar-views.js and quick-expense.js only (no new admin-only script added by this stage)", () => {
  const html = read("admin/index.html");
  assert.ok(/<script src="calendar-views\.js"><\/script>/.test(html));
  assert.ok(/<script src="quick-expense\.js"><\/script>/.test(html));
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
