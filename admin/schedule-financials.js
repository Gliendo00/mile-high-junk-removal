// Compact Revenue/Booked/Expenses/Net counters for the Schedule's currently
// visible Day/Week/Month range — Phase 3C Stage 4. Revenue/Booked are
// computed client-side from the exact same `jobs` array each view already
// fetched to render its cards (no second booking query); Expenses reuses
// the existing GET ?view=expenses&startDate=&endDate= endpoint for the same
// range (admin/quick-expense.js's own endpoint, just called with a wider
// range than its single-day bar uses). Never shown on Year — that view
// deliberately carries no revenue/expense data at all (see
// api/admin/bookings.js's handleYear()) and this file respects the same
// boundary; see admin/calendar-views.js's hideFinancials().
//
// Amount rules (locked with the owner — see docs/phase-3/ for the full
// stage 4 proposal):
//   Revenue  = SUM(finalPrice, falling back to estimatedPrice only if
//              finalPrice is null) over 'completed' jobs only.
//   Booked   = SUM(estimatedPrice) over 'booked' + 'rental_out' jobs —
//              never estimatedPriceMax, matching what the schedule cards
//              already display as the primary quoted figure.
//   Expenses = the expenses endpoint's own totalAmount for the same range
//              (already excludes voided rows by default).
//   Net      = Revenue - Expenses. Booked is never part of Net.
// A booking's status is exclusive at any moment, so its amount can only
// ever land in exactly one of Revenue/Booked — booked -> rental_out keeps
// it in Booked, rental_out -> completed moves it into Revenue — never both,
// never neither, with no separate bookkeeping to keep in sync; this file
// simply recomputes both totals fresh from the current status every time
// a view loads.
//
// Every dynamic value is written with textContent, matching every other
// admin script's no-innerHTML discipline.
window.AdminScheduleFinancials = (function () {
  function formatMoney(n) {
    var v = Number(n) || 0;
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var container = null;
  var revenueEl, bookedEl, expensesEl, netEl, netCardEl;
  var domReady = false;
  // Guards an in-flight expenses fetch from resolving after a newer
  // show()/hide() call already moved on to a different date range — same
  // request-sequence pattern every other admin script in this project uses.
  var requestSeq = 0;

  function ensureDom() {
    if (domReady) return;
    domReady = true;
    container = document.getElementById('schedule-financials');
    if (!container) return;
    revenueEl = document.getElementById('financial-revenue-value');
    bookedEl = document.getElementById('financial-booked-value');
    expensesEl = document.getElementById('financial-expenses-value');
    netEl = document.getElementById('financial-net-value');
    netCardEl = document.getElementById('financial-net-card');
  }

  function computeFromJobs(jobs) {
    var revenue = 0;
    var booked = 0;
    (jobs || []).forEach(function (job) {
      if (job.status === 'completed') {
        // Check for "missing" on the RAW value before ever calling Number()
        // on it — Number(null) === 0, and 0 is finite, so a naive
        // Number.isFinite() check on the coerced value can't tell "a real
        // $0 final price" apart from "no final price was ever set" (a real
        // bug this exact file shipped with once already — see
        // tests/phase3c-schedule.test.js's regression tests for this). A
        // real 0 must stay 0, never fall back to estimatedPrice.
        var hasFinal = job.finalPrice !== null && job.finalPrice !== undefined && job.finalPrice !== '';
        var amount = Number(hasFinal ? job.finalPrice : job.estimatedPrice);
        revenue += Number.isFinite(amount) ? amount : 0;
      } else if (job.status === 'booked' || job.status === 'rental_out') {
        booked += Number(job.estimatedPrice) || 0;
      }
    });
    return { revenue: revenue, booked: booked };
  }

  // expenses === null means "not yet known" (still loading, or the fetch
  // failed) — shown as an em dash rather than a misleading $0 that would
  // make Net silently read as if it exactly equaled Revenue.
  function render(revenue, booked, expenses) {
    revenueEl.textContent = formatMoney(revenue);
    bookedEl.textContent = formatMoney(booked);
    if (expenses === null) {
      expensesEl.textContent = '—';
      netEl.textContent = '—';
      netCardEl.classList.remove('is-negative');
      return;
    }
    expensesEl.textContent = formatMoney(expenses);
    var net = revenue - expenses;
    netEl.textContent = formatMoney(net);
    netCardEl.classList.toggle('is-negative', net < 0);
  }

  // startDate/endDate: the exact visible range (the same date twice for a
  // single day). jobs: the same array the caller is about to render as
  // cards — never re-fetched here, so this never doubles the booking query
  // Day/Week/Month already made.
  function show(startDate, endDate, jobs) {
    ensureDom();
    if (!container) return;
    container.hidden = false;

    var seq = ++requestSeq;
    var totals = computeFromJobs(jobs);
    // Revenue/Booked render immediately (everything needed is already in
    // hand); Expenses/Net fill in a moment later once that request
    // resolves — never blocked on it.
    render(totals.revenue, totals.booked, null);

    fetch('/api/admin/bookings?view=expenses&startDate=' + encodeURIComponent(startDate) + '&endDate=' + encodeURIComponent(endDate))
      .then(function (res) {
        // A 401 here just means Expenses/Net stay unknown for this render —
        // the page's own primary data fetch already owns redirecting to
        // /admin/login/, so this doesn't duplicate that.
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      })
      .then(function (body) {
        if (seq !== requestSeq) return; // superseded by a newer range/date
        var expenses = body && typeof body.totalAmount === 'number' ? body.totalAmount : null;
        render(totals.revenue, totals.booked, expenses);
      })
      .catch(function () {
        // Non-blocking, same posture as admin/quick-expense.js: Revenue/
        // Booked stay correct and visible regardless of this failing.
      });
  }

  function hide() {
    ensureDom();
    if (!container) return;
    ++requestSeq; // invalidate any in-flight expenses fetch
    container.hidden = true;
  }

  return { show: show, hide: hide };
})();
