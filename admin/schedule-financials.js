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
//              finalPrice is null/undefined/'') over 'completed' jobs only.
//              A real finalPrice of 0 stays 0 (see completedRevenueAmount()).
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
// Stage 4 drill-down addendum: Revenue/Booked/Expenses are real <button>
// elements (admin/index.html) that open a compact read-only breakdown sheet
// — reusing admin/status-ui.js's/admin/quick-expense.js's exact
// .admin-sheet-overlay/.admin-sheet chrome, not a new modal pattern. The
// breakdown NEVER re-fetches or re-filters anything: it lists the exact
// same `jobs`/expense rows already held from the last show() call, run
// through the SAME amount functions (completedRevenueAmount()/
// bookedJobAmount()) the counters themselves use, so a row's sum can never
// drift from the counter it explains. Opening/closing the sheet touches
// only this file's own overlay element — it never calls fetch(), never
// changes the active range/date, and never touches admin/schedule.js's or
// admin/calendar-views.js's state, so closing it always returns to the
// exact same Schedule view. Net has no button/click handler at all, per
// explicit instruction to leave it non-interactive for now.
//
// Every dynamic value is written with textContent, matching every other
// admin script's no-innerHTML discipline.
window.AdminScheduleFinancials = (function () {
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatMoney(n) {
    var v = Number(n) || 0;
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDateShort(iso) {
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Same date twice (a single day) -> just that one date; otherwise a
  // "Sep 13 – Sep 19" range, matching admin/schedule.js's own dash style.
  function dateRangeLabel(startDate, endDate) {
    if (!startDate) return '';
    if (startDate === endDate) return formatDateShort(startDate);
    return formatDateShort(startDate) + ' – ' + formatDateShort(endDate);
  }

  function jobDisplayName(job) {
    return (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client';
  }

  // The exact Completed-Revenue rule, in ONE place — computeFromJobs() (the
  // counter) and buildRevenueRows() (the breakdown) both call this, so the
  // two can never disagree. Checks the RAW finalPrice for missing before
  // ever coercing it with Number() — see the regression tests in
  // tests/phase3c-schedule.test.js for the exact bug this guards against
  // (Number(null) === 0, and 0 is finite).
  function completedRevenueAmount(job) {
    var hasFinal = job.finalPrice !== null && job.finalPrice !== undefined && job.finalPrice !== '';
    var amount = Number(hasFinal ? job.finalPrice : job.estimatedPrice);
    return Number.isFinite(amount) ? amount : 0;
  }

  // Same reasoning: the one place Booked's per-job amount is computed,
  // shared by the counter and the breakdown.
  function bookedJobAmount(job) {
    return Number(job.estimatedPrice) || 0;
  }

  function computeFromJobs(jobs) {
    var revenue = 0;
    var booked = 0;
    (jobs || []).forEach(function (job) {
      if (job.status === 'completed') {
        revenue += completedRevenueAmount(job);
      } else if (job.status === 'booked' || job.status === 'rental_out') {
        booked += bookedJobAmount(job);
      }
    });
    return { revenue: revenue, booked: booked };
  }

  function buildRevenueRows(jobs) {
    return (jobs || [])
      .filter(function (job) {
        return job.status === 'completed';
      })
      .map(function (job) {
        return { id: job.id, name: jobDisplayName(job), service: job.serviceLabel || job.serviceType || '—', date: job.appointmentDate, amount: completedRevenueAmount(job) };
      });
  }

  function buildBookedRows(jobs) {
    return (jobs || [])
      .filter(function (job) {
        return job.status === 'booked' || job.status === 'rental_out';
      })
      .map(function (job) {
        return {
          id: job.id,
          name: jobDisplayName(job),
          service: job.serviceLabel || job.serviceType || '—',
          date: job.appointmentDate,
          statusLabel: job.statusLabel || job.status,
          amount: bookedJobAmount(job),
        };
      });
  }

  function buildExpenseRows(expenseRows) {
    return (expenseRows || []).map(function (e) {
      return { id: e.id, category: e.categoryLabel || e.category, date: e.expenseDate, amount: Number(e.amount) || 0, note: e.note || null, vendor: e.vendor || null };
    });
  }

  var container = null;
  var revenueEl, bookedEl, expensesEl, netEl, netCardEl;
  var revenueCardEl, bookedCardEl, expensesCardEl;
  var domReady = false;
  // Guards an in-flight expenses fetch from resolving after a newer
  // show()/hide() call already moved on to a different date range — same
  // request-sequence pattern every other admin script in this project uses.
  var requestSeq = 0;

  // Snapshot of the data behind whatever the counters currently show —
  // exactly what a click needs, never re-fetched. lastExpenseRows/
  // lastExpensesTotal stay null until the expenses request resolves;
  // clicking Expenses before then shows a calm "not loaded yet" state
  // (same posture as admin/quick-expense.js's own load-failure message).
  var lastStartDate = null;
  var lastEndDate = null;
  var lastJobs = [];
  var lastExpenseRows = null;
  var lastExpensesTotal = null;

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

    revenueCardEl = document.getElementById('financial-revenue-card');
    bookedCardEl = document.getElementById('financial-booked-card');
    expensesCardEl = document.getElementById('financial-expenses-card');
    if (revenueCardEl) revenueCardEl.addEventListener('click', openRevenueBreakdown);
    if (bookedCardEl) bookedCardEl.addEventListener('click', openBookedBreakdown);
    if (expensesCardEl) expensesCardEl.addEventListener('click', openExpensesBreakdown);
  }

  // ---------------------------------------------------------------------
  // Breakdown sheet — reuses the exact .admin-sheet-overlay/.admin-sheet
  // chrome admin/status-ui.js and admin/quick-expense.js already
  // established, rather than a new modal pattern. Read-only: no option is
  // selectable, there's just a Close button.
  // ---------------------------------------------------------------------
  var overlay = null;
  var sheet = null;

  function ensureSheetDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'admin-sheet-overlay';
    overlay.setAttribute('hidden', '');

    sheet = document.createElement('div');
    sheet.className = 'admin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    overlay.appendChild(sheet);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && !overlay.hasAttribute('hidden')) closeSheet();
    });

    document.body.appendChild(overlay);
  }

  function closeSheet() {
    if (!overlay) return;
    overlay.setAttribute('hidden', '');
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }

  function renderRow(mainName, amount, metaText, noteText) {
    var row = el('div', 'admin-financial-breakdown-row');
    var main = el('div', 'admin-financial-breakdown-row-main');
    main.appendChild(el('span', 'admin-financial-breakdown-row-name', mainName));
    main.appendChild(el('span', 'admin-financial-breakdown-row-amount', formatMoney(amount)));
    row.appendChild(main);
    row.appendChild(el('div', 'admin-financial-breakdown-row-meta', metaText));
    if (noteText) row.appendChild(el('div', 'admin-financial-breakdown-row-note', noteText));
    return row;
  }

  // title/emptyText/totalLabel: static per-counter strings. rows/total:
  // this specific range's data. rowToEl(row): builds one row's markup.
  function openBreakdownSheet(title, emptyText, rows, total, totalLabel, rowToEl) {
    ensureSheetDom();
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);

    sheet.appendChild(el('div', 'admin-sheet-title', title));
    var rangeLabel = dateRangeLabel(lastStartDate, lastEndDate);
    if (rangeLabel) sheet.appendChild(el('div', 'admin-financial-breakdown-range', rangeLabel));

    var list = el('div', 'admin-financial-breakdown-list');
    if (!rows.length) {
      list.appendChild(el('div', 'admin-empty', emptyText));
    } else {
      rows.forEach(function (row) {
        list.appendChild(rowToEl(row));
      });
    }
    sheet.appendChild(list);

    var totalRow = el('div', 'admin-financial-breakdown-total');
    totalRow.appendChild(el('span', null, totalLabel));
    totalRow.appendChild(el('span', null, formatMoney(total)));
    sheet.appendChild(totalRow);

    var closeBtn = el('button', 'admin-sheet-cancel', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeSheet);
    sheet.appendChild(closeBtn);

    overlay.removeAttribute('hidden');
  }

  function openRevenueBreakdown() {
    var rows = buildRevenueRows(lastJobs);
    var total = rows.reduce(function (sum, r) {
      return sum + r.amount;
    }, 0);
    openBreakdownSheet('Revenue', 'No completed jobs in this range.', rows, total, 'Total Revenue', function (row) {
      return renderRow(row.name, row.amount, row.service + ' · ' + formatDateShort(row.date));
    });
  }

  function openBookedBreakdown() {
    var rows = buildBookedRows(lastJobs);
    var total = rows.reduce(function (sum, r) {
      return sum + r.amount;
    }, 0);
    openBreakdownSheet('Booked', 'No booked or Rental Out jobs in this range.', rows, total, 'Total Booked', function (row) {
      return renderRow(row.name, row.amount, row.service + ' · ' + formatDateShort(row.date) + ' · ' + row.statusLabel);
    });
  }

  function openExpensesBreakdown() {
    // lastExpensesTotal (not a client-side re-sum of the rows) is always
    // what's shown as the total, so it can never drift from the Expenses
    // counter even in the (practically never-hit, for this business's real
    // volume) case where the API's own row limit trims the row list below
    // the true total — see api/admin/bookings.js's EXPENSE_LIST_DEFAULT_LIMIT.
    if (lastExpenseRows === null) {
      openBreakdownSheet('Expenses', 'Could not load expense details right now.', [], 0, 'Total Expenses', function () {
        return el('div');
      });
      return;
    }
    var rows = buildExpenseRows(lastExpenseRows);
    openBreakdownSheet('Expenses', 'No expenses in this range.', rows, lastExpensesTotal || 0, 'Total Expenses', function (row) {
      var metaParts = [formatDateShort(row.date)];
      if (row.vendor) metaParts.push(row.vendor);
      return renderRow(row.category, row.amount, metaParts.join(' · '), row.note);
    });
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
    closeSheet(); // never leave a stale breakdown open across a range change
    container.hidden = false;

    lastStartDate = startDate;
    lastEndDate = endDate;
    lastJobs = jobs || [];
    lastExpenseRows = null;
    lastExpensesTotal = null;

    var seq = ++requestSeq;
    var totals = computeFromJobs(lastJobs);
    // Revenue/Booked render immediately (everything needed is already in
    // hand); Expenses/Net fill in a moment later once that request
    // resolves — never blocked on it.
    render(totals.revenue, totals.booked, null);

    adminFetch('/api/admin/bookings?view=expenses&startDate=' + encodeURIComponent(startDate) + '&endDate=' + encodeURIComponent(endDate))
      .then(function (res) {
        // A 401 here just means Expenses/Net stay unknown for this render —
        // the page's own primary data fetch already owns redirecting to
        // /admin/login/, so this doesn't duplicate that. adminFetch() (see
        // admin-fetch.js) already absorbs a same-page refresh-token race on
        // its own, so this still resolves most of the time even when it
        // raced admin/schedule.js's own fetch or nav-badge.js's.
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      })
      .then(function (body) {
        if (seq !== requestSeq) return; // superseded by a newer range/date
        var expenses = body && typeof body.totalAmount === 'number' ? body.totalAmount : null;
        if (expenses !== null) {
          lastExpensesTotal = expenses;
          lastExpenseRows = Array.isArray(body.expenses) ? body.expenses : [];
        }
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
    closeSheet();
    container.hidden = true;
  }

  return { show: show, hide: hide };
})();
