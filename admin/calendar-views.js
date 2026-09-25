// /admin — Week, Month, and Year calendar navigation (Phase 3C Stage 2.4;
// Week redesigned and the selected-day panel reordered in Stage 2.4.1; Week
// made genuinely horizontal, the day panel gained previous/next-day arrows,
// and Quick Expense moved out to the shared top-of-page bar in Stage 2.4.2).
// Fetched from api/admin/bookings.js's ?view=schedule&range=week|month|year
// modes (see that file's handleSchedule()/handleMonth()/handleYear() for
// the exact bounded-query contract) — no new API endpoint was added for
// this redesign, only how the client renders the same responses.
//
// Shared "selected day" experience: renderDayPanel() builds, in this exact
// order —
//   1. the selected date (heading), flanked by previous-day/next-day arrows
//      (Stage 2.4.2 — see the onNavigate callback each caller passes in)
//   2. Jobs for that date (the "+ New/Past Job" action, then each job as
//      its own compact tappable card — see renderDailyJobCard())
// — used by both Month's day panel and Week's per-day selection, so the two
// can never visually drift apart. Quick Expense (admin/quick-expense.js) no
// longer mounts inside this panel as of Stage 2.4.2 — it lives in the one
// persistent bar directly under the Schedule tabs instead (see
// showQuickExpenseFor()/hideQuickExpense() below), so its active date stays
// obviously in sync no matter which range is open.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
window.AdminCalendarViews = (function () {
  var HISTORICAL_FLOOR_ISO = '2026-01-01';
  var HISTORICAL_FLOOR_YEAR = 2026;
  var HISTORICAL_FLOOR_MONTH = 1;
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  // A week day row shows at most this many "time · client" lines before
  // collapsing the rest into "+N more" — keeps one unusually busy day from
  // making the whole week overview enormous (the owner's explicit
  // requirement).
  var WEEK_ROW_MAX_JOB_LINES = 3;

  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  }
  function dayOfWeekIso(iso) {
    var p = iso.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0)).getUTCDay();
  }
  function addDaysIso(iso, days) {
    var p = iso.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  }
  // The Sunday on/before `iso` — a small local copy of
  // api/admin/bookings.js's identical helper (Stage 2.4.2's day-panel
  // previous/next-day arrows need it client-side to know which week to load
  // when a delta steps outside the currently displayed one).
  function startOfWeekSundayIso(iso) {
    return addDaysIso(iso, -dayOfWeekIso(iso));
  }
  function ymdIso(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function formatMonthDay(iso) {
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // "$350" for an exact quote, "$350 – $475" for a range (Phase 3C Stage
  // 2.5) — never a duplicated value when there's no max.
  function formatQuotedAmount(min, max) {
    var minText = formatPrice(min);
    if (!minText) return null;
    var maxText = formatPrice(max);
    return maxText ? minText + ' – ' + maxText : minText;
  }

  // Stage 2.4.2 (second pass): Week's compact per-job mini-card has room
  // for a start time and a client name, not a full "8:00 AM – 10:00 AM"
  // range plus a name — the range alone was already most of the card's
  // width, leaving the name truncated to nothing. Only api/_lib/time-
  // windows.js's modern w_HHMM_HHMM labels use a spaced en dash (" – ")
  // between two clock times; the older morning/midday/afternoon/evening
  // labels ("Morning (8am–11am)") use an unspaced dash inside their own
  // parentheses and are left completely untouched by this split — this is
  // a plain string trim, never a second copy of the time-window-to-label
  // table client-side.
  function shortTimeLabel(label) {
    if (!label) return '—';
    var idx = label.indexOf(' – ');
    return idx === -1 ? label : label.slice(0, idx);
  }

  var todayIso = denverTodayIso();
  var todayParts = todayIso.split('-').map(Number);

  var weekView, weekPrevBtn, weekNextBtn, weekRangeLabel, weekCurrentWrap, weekCurrentBtn, weekLoading, weekError, weekOverviewEl, weekDayPanel;
  var monthView, monthPrevBtn, monthNextBtn, monthLabel, monthCurrentWrap, monthCurrentBtn, monthLoading, monthError, monthGrid, monthDayPanel;
  var yearView, yearPrevBtn, yearNextBtn, yearLabel, yearLoading, yearError, yearGrid;
  var domReady = false;

  var weekRequestSeq = 0;
  var monthRequestSeq = 0;
  var yearRequestSeq = 0;

  var state = {
    weekStart: null, // ISO Sunday; null until the first response tells us the current week
    weekSelectedDate: null,
    weekJobsByDate: {},
    monthYear: todayParts[0],
    monthMonth: todayParts[1],
    monthSelectedDate: null,
    monthJobsByDate: {}, // appointmentDate -> jobs[]
    yearYear: todayParts[0],
  };

  function ensureDom() {
    if (domReady) return;
    domReady = true;

    weekView = document.getElementById('week-view');
    weekPrevBtn = document.getElementById('week-prev');
    weekNextBtn = document.getElementById('week-next');
    weekRangeLabel = document.getElementById('week-range-label');
    weekCurrentWrap = document.getElementById('week-current-wrap');
    weekCurrentBtn = document.getElementById('week-current-btn');
    weekLoading = document.getElementById('week-loading');
    weekError = document.getElementById('week-error');
    weekOverviewEl = document.getElementById('week-overview');
    weekDayPanel = document.getElementById('week-day-panel');

    monthView = document.getElementById('month-view');
    monthPrevBtn = document.getElementById('month-prev');
    monthNextBtn = document.getElementById('month-next');
    monthLabel = document.getElementById('month-label');
    monthCurrentWrap = document.getElementById('month-current-wrap');
    monthCurrentBtn = document.getElementById('month-current-btn');
    monthLoading = document.getElementById('month-loading');
    monthError = document.getElementById('month-error');
    monthGrid = document.getElementById('month-grid');
    monthDayPanel = document.getElementById('month-day-panel');

    yearView = document.getElementById('year-view');
    yearPrevBtn = document.getElementById('year-prev');
    yearNextBtn = document.getElementById('year-next');
    yearLabel = document.getElementById('year-label');
    yearLoading = document.getElementById('year-loading');
    yearError = document.getElementById('year-error');
    yearGrid = document.getElementById('year-grid');

    weekPrevBtn.addEventListener('click', function () {
      if (weekPrevBtn.disabled || !state.weekStart) return;
      loadWeek(addDaysIso(state.weekStart, -7));
    });
    weekNextBtn.addEventListener('click', function () {
      if (!state.weekStart) return;
      loadWeek(addDaysIso(state.weekStart, 7));
    });
    weekCurrentBtn.addEventListener('click', function () {
      loadWeek(null);
    });

    monthPrevBtn.addEventListener('click', function () {
      if (monthPrevBtn.disabled) return;
      var m = state.monthMonth - 1, y = state.monthYear;
      if (m < 1) { m = 12; y -= 1; }
      state.monthYear = y;
      state.monthMonth = m;
      loadMonth();
    });
    monthNextBtn.addEventListener('click', function () {
      var m = state.monthMonth + 1, y = state.monthYear;
      if (m > 12) { m = 1; y += 1; }
      state.monthYear = y;
      state.monthMonth = m;
      loadMonth();
    });
    monthCurrentBtn.addEventListener('click', function () {
      state.monthYear = todayParts[0];
      state.monthMonth = todayParts[1];
      loadMonth(todayIso);
    });
    yearPrevBtn.addEventListener('click', function () {
      if (yearPrevBtn.disabled) return;
      state.yearYear -= 1;
      loadYear();
    });
    yearNextBtn.addEventListener('click', function () {
      state.yearYear += 1;
      loadYear();
    });
  }

  function hideAllViews() {
    document.getElementById('today-tomorrow-view').hidden = true;
    weekView.hidden = true;
    monthView.hidden = true;
    yearView.hidden = true;
  }

  function setActiveRangeTab(range) {
    document.querySelectorAll('.admin-range-tab').forEach(function (btn) {
      var isActive = btn.getAttribute('data-range') === range;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  // Stage 2.4.2: the relocated Quick Expense bar (#quick-expense-bar,
  // directly under the Schedule tabs — see admin/index.html) is shared with
  // admin/schedule.js's Today/Tomorrow/Yesterday/day-nav. Week/Month show it
  // for whichever day is currently selected; Year hides it outright (no
  // single day is ever "selected" in Year). Hidden up front on every
  // show*()/load*() so a stale previous date's controls never linger while
  // a new range's own data is still loading.
  function showQuickExpenseFor(iso) {
    if (window.AdminQuickExpense) window.AdminQuickExpense.showBar(iso);
  }
  function hideQuickExpense() {
    if (window.AdminQuickExpense) window.AdminQuickExpense.hideBar();
  }

  // Phase 3C Stage 4: Revenue/Booked/Expenses/Net counters for whichever
  // range is currently loaded — Week/Month only, never Year (see
  // admin/schedule-financials.js's header for why). Guarded the same way
  // showQuickExpenseFor()/hideQuickExpense() are, in case this script ever
  // loads on a page without admin/schedule-financials.js.
  function showFinancialsFor(startDate, endDate, jobs) {
    if (window.AdminScheduleFinancials) window.AdminScheduleFinancials.show(startDate, endDate, jobs);
  }
  function hideFinancials() {
    if (window.AdminScheduleFinancials) window.AdminScheduleFinancials.hide();
  }

  function showWeek() {
    ensureDom();
    hideAllViews();
    weekView.hidden = false;
    setActiveRangeTab('week');
    hideQuickExpense();
    loadWeek(state.weekStart);
  }
  function showMonth() {
    ensureDom();
    hideAllViews();
    monthView.hidden = false;
    setActiveRangeTab('month');
    hideQuickExpense();
    loadMonth();
  }
  function showYear() {
    ensureDom();
    hideAllViews();
    yearView.hidden = false;
    setActiveRangeTab('year');
    hideQuickExpense();
    hideFinancials();
    loadYear();
  }

  // ---------------------------------------------------------------------
  // Shared: the selected-day panel (Selected date, with previous/next-day
  // arrows -> Jobs), and the compact job card used inside it.
  // ---------------------------------------------------------------------
  function renderDailyJobCard(job) {
    var a = document.createElement('a');
    a.className = 'admin-daily-job-card';
    a.href = '/admin/booking/?id=' + encodeURIComponent(job.id);

    var top = el('div', 'admin-daily-job-card-top');
    top.appendChild(el('span', 'admin-daily-job-card-time', job.timeLabel || '—'));
    top.appendChild(el('span', 'admin-status-badge admin-status-' + job.status, job.statusLabel || 'Booked'));
    a.appendChild(top);

    var name = (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client';
    a.appendChild(el('div', 'admin-daily-job-card-name', name));

    var metaParts = [job.serviceLabel || job.serviceType || '—'];
    if (job.serviceAddress && job.serviceAddress.city) metaParts.push(job.serviceAddress.city);
    // Same status-aware precedence as admin/schedule.js's Today/Tomorrow/
    // Yesterday cards — completed prefers Actual Collected, non-completed
    // always shows Quoted (never implies a booked job is already paid).
    var priceText = job.status === 'completed'
      ? (formatPrice(job.finalPrice) || formatQuotedAmount(job.estimatedPrice, job.estimatedPriceMax))
      : formatQuotedAmount(job.estimatedPrice, job.estimatedPriceMax);
    if (priceText) metaParts.push(priceText);
    a.appendChild(el('div', 'admin-daily-job-card-meta', metaParts.join(' · ')));

    return a;
  }

  // container: the .admin-day-panel element to fill. iso: the selected
  // date. jobs: that date's jobs (already filtered by the caller).
  // onNavigate(deltaDays): called with -1/+1 when the previous-day/next-day
  // arrow is tapped — left to the caller (selectWeekDate/selectMonthDate)
  // to decide how to resolve a delta that lands outside the currently
  // loaded week/month (see navigateWeekDayBy()/navigateMonthDayBy() below).
  function renderDayPanel(container, iso, jobs, onNavigate) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.hidden = false;

    // 1. Selected date, flanked by restrained previous-day/next-day arrows
    // (Stage 2.4.2) — reuses the exact same .admin-calendar-nav/-btn chrome
    // as Week/Month/Year's own Prev/Next row for a consistent look.
    var headingRow = el('div', 'admin-calendar-nav admin-day-panel-heading-row');
    var prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'admin-calendar-nav-btn';
    prevBtn.setAttribute('aria-label', 'Previous day');
    prevBtn.textContent = '←';
    prevBtn.disabled = iso <= HISTORICAL_FLOOR_ISO;
    prevBtn.addEventListener('click', function () { onNavigate(-1); });
    headingRow.appendChild(prevBtn);

    var heading = el('span', 'admin-day-panel-heading');
    var d = new Date(iso + 'T00:00:00');
    heading.textContent = isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    headingRow.appendChild(heading);

    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'admin-calendar-nav-btn';
    nextBtn.setAttribute('aria-label', 'Next day');
    nextBtn.textContent = '→';
    nextBtn.addEventListener('click', function () { onNavigate(1); });
    headingRow.appendChild(nextBtn);

    container.appendChild(headingRow);

    // 2. Jobs: the create-job action, then each job as its own compact,
    // fully-tappable card (see renderDailyJobCard()) — never a tiny "View"
    // link tucked at the bottom. (Quick Expense used to mount here too —
    // Stage 2.4.2 moved it to the persistent top-of-page bar instead; see
    // showQuickExpenseFor(), called by selectWeekDate()/selectMonthDate()
    // below.)
    var actionLink = document.createElement('a');
    actionLink.className = 'admin-btn admin-btn-outline admin-day-panel-action';
    if (iso < todayIso) {
      actionLink.href = '/admin/booking-past/?date=' + encodeURIComponent(iso);
      actionLink.textContent = '+ Past Job';
    } else {
      actionLink.href = '/admin/booking-new/?date=' + encodeURIComponent(iso);
      actionLink.textContent = '+ New Job';
    }
    container.appendChild(actionLink);

    var jobsWrap = el('div', 'admin-daily-job-list');
    if (!jobs.length) {
      jobsWrap.appendChild(el('div', 'admin-empty', 'No jobs on this date.'));
    } else {
      jobs.forEach(function (job) {
        jobsWrap.appendChild(renderDailyJobCard(job));
      });
    }
    container.appendChild(jobsWrap);
  }

  function groupJobsByDate(jobs) {
    var byDate = {};
    (jobs || []).forEach(function (j) {
      if (!byDate[j.appointmentDate]) byDate[j.appointmentDate] = [];
      byDate[j.appointmentDate].push(j);
    });
    return byDate;
  }

  // ---------------------------------------------------------------------
  // Week — Stage 2.4.1 redesign: a compact 7-day overview (all Sun-Sat
  // days always shown, including empty ones) with the shared selected-day
  // panel below once a day is tapped. Never seven full Daily views stacked
  // together.
  // ---------------------------------------------------------------------
  // selectAfterLoad (Stage 2.4.2, optional): an explicit date to select once
  // this week loads, used by navigateWeekDayBy() when the previous/next-day
  // arrow steps outside the currently displayed week — overrides the
  // default "auto-select today if it's in range" behavior below.
  function loadWeek(weekStartOverride, selectAfterLoad) {
    weekOverviewEl.style.display = 'none';
    weekDayPanel.hidden = true;
    weekError.style.display = 'none';
    weekLoading.style.display = 'block';
    weekCurrentWrap.style.display = 'none';
    hideQuickExpense();
    hideFinancials();

    var seq = ++weekRequestSeq;
    var url = '/api/admin/bookings?view=schedule&range=week';
    if (weekStartOverride) url += '&weekStart=' + encodeURIComponent(weekStartOverride);

    adminFetch(url)
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load the week.');
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== weekRequestSeq) return;
        weekLoading.style.display = 'none';
        state.weekStart = body.weekStart;
        state.weekJobsByDate = groupJobsByDate(body.jobs);
        weekPrevBtn.disabled = body.canGoPrevious === false;
        weekRangeLabel.textContent = formatMonthDay(body.weekStart) + ' – ' + formatMonthDay(body.weekEnd);
        weekCurrentWrap.style.display = body.isCurrentWeek ? 'none' : 'block';
        renderWeekOverview(body.weekStart);
        showFinancialsFor(body.weekStart, body.weekEnd, body.jobs);
        if (selectAfterLoad) {
          selectWeekDate(selectAfterLoad);
        } else if (todayIso >= body.weekStart && todayIso <= body.weekEnd) {
          // Auto-select today when it falls within the displayed week — a
          // useful default, matching Month's own auto-select-today behavior.
          selectWeekDate(todayIso);
        } else {
          state.weekSelectedDate = null;
        }
      })
      .catch(function (err) {
        if (seq !== weekRequestSeq) return;
        weekLoading.style.display = 'none';
        weekError.textContent = err && err.message ? err.message : 'Could not load the week.';
        weekError.style.display = 'block';
      });
  }

  function renderWeekOverview(weekStart) {
    while (weekOverviewEl.firstChild) weekOverviewEl.removeChild(weekOverviewEl.firstChild);

    for (var i = 0; i < 7; i++) {
      var iso = addDaysIso(weekStart, i);
      var jobs = (state.weekJobsByDate[iso] || []).slice();

      var row = document.createElement('button');
      row.type = 'button';
      var classes = ['admin-week-day-row'];
      if (iso === todayIso) classes.push('is-today');
      if (iso === state.weekSelectedDate) classes.push('is-selected');
      row.className = classes.join(' ');
      row.dataset.date = iso;

      var head = el('div', 'admin-week-day-row-head');
      head.appendChild(el('span', 'admin-week-day-row-weekday', WEEKDAY_SHORT[i]));
      head.appendChild(el('span', 'admin-week-day-row-date', formatMonthDay(iso)));
      if (jobs.length) {
        head.appendChild(el('span', 'admin-week-day-row-count', jobs.length + (jobs.length === 1 ? ' job' : ' jobs')));
      }
      row.appendChild(head);

      if (jobs.length) {
        // Stage 2.4.2 (second pass): each job is its own compact mini-card
        // — not one run-on line — so multiple jobs on a busy day read as
        // distinct grouped objects. Time is its own non-wrapping element
        // (so "10:00 AM" never breaks mid-unit) and the client name
        // ellipsis-truncates instead of wrapping awkwardly if the column is
        // too narrow for both — see .admin-week-day-row-job's CSS.
        var jobsList = el('div', 'admin-week-day-row-jobs');
        jobs.slice(0, WEEK_ROW_MAX_JOB_LINES).forEach(function (job) {
          var name = (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client';
          var jobRow = el('div', 'admin-week-day-row-job');
          jobRow.appendChild(el('span', 'admin-week-day-row-job-time', shortTimeLabel(job.timeLabel)));
          jobRow.appendChild(el('span', 'admin-week-day-row-job-name', name));
          jobsList.appendChild(jobRow);
        });
        if (jobs.length > WEEK_ROW_MAX_JOB_LINES) {
          jobsList.appendChild(el('div', 'admin-week-day-row-more', '+' + (jobs.length - WEEK_ROW_MAX_JOB_LINES) + ' more'));
        }
        row.appendChild(jobsList);
      }

      row.addEventListener('click', function (e) {
        selectWeekDate(e.currentTarget.dataset.date);
      });
      weekOverviewEl.appendChild(row);
    }

    weekOverviewEl.style.display = 'flex';
  }

  function selectWeekDate(iso) {
    state.weekSelectedDate = iso;
    Array.prototype.forEach.call(weekOverviewEl.querySelectorAll('.admin-week-day-row'), function (row) {
      row.classList.toggle('is-selected', row.dataset.date === iso);
    });
    renderDayPanel(weekDayPanel, iso, state.weekJobsByDate[iso] || [], function (delta) { navigateWeekDayBy(iso, delta); });
    showQuickExpenseFor(iso);
  }

  // Previous-day/next-day arrows inside Week's day panel (Stage 2.4.2).
  // Staying within the currently loaded week is just re-selecting a date
  // already in state.weekJobsByDate; stepping past Saturday into the next
  // week (or before Sunday into the previous one) loads that week first,
  // then selects the target date once it arrives — never left showing a
  // date whose data was never fetched.
  function navigateWeekDayBy(iso, delta) {
    var target = addDaysIso(iso, delta);
    if (target < HISTORICAL_FLOOR_ISO) return;
    var weekEnd = addDaysIso(state.weekStart, 6);
    if (target >= state.weekStart && target <= weekEnd) {
      selectWeekDate(target);
    } else {
      loadWeek(startOfWeekSundayIso(target), target);
    }
  }

  // ---------------------------------------------------------------------
  // Month
  // ---------------------------------------------------------------------
  // selectAfterLoad (Stage 2.4.2, optional): an explicit date to select once
  // this month loads — used by navigateMonthDayBy() when the previous/
  // next-day arrow steps into an adjacent month.
  function loadMonth(selectAfterLoad) {
    monthPrevBtn.disabled = state.monthYear === HISTORICAL_FLOOR_YEAR && state.monthMonth === HISTORICAL_FLOOR_MONTH;
    monthLabel.textContent = MONTH_NAMES[state.monthMonth - 1] + ' ' + state.monthYear;
    monthGrid.style.display = 'none';
    monthDayPanel.hidden = true;
    monthError.style.display = 'none';
    monthLoading.style.display = 'block';
    hideQuickExpense();
    hideFinancials();

    var seq = ++monthRequestSeq;
    adminFetch('/api/admin/bookings?view=schedule&range=month&year=' + state.monthYear + '&month=' + state.monthMonth)
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load the month.');
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== monthRequestSeq) return;
        monthLoading.style.display = 'none';
        state.monthJobsByDate = groupJobsByDate(body.jobs);
        monthCurrentWrap.style.display = (body.year === todayParts[0] && body.month === todayParts[1]) ? 'none' : 'block';
        renderMonthGrid(body);
        showFinancialsFor(body.startDate, body.endDate, body.jobs);
        if (selectAfterLoad && Number(selectAfterLoad.slice(0, 4)) === body.year && Number(selectAfterLoad.slice(5, 7)) === body.month) {
          selectMonthDate(selectAfterLoad);
        } else if (body.year === todayParts[0] && body.month === todayParts[1]) {
          // Auto-select today if it falls within the loaded month — an
          // immediately useful default rather than an empty grid with
          // nothing selected. Any other month opens with no day selected, an
          // intentionally empty resting state (see renderMonthGrid's "empty
          // days should look intentionally empty, not broken").
          selectMonthDate(todayIso);
        } else {
          state.monthSelectedDate = null;
        }
      })
      .catch(function (err) {
        if (seq !== monthRequestSeq) return;
        monthLoading.style.display = 'none';
        monthError.textContent = err && err.message ? err.message : 'Could not load the month.';
        monthError.style.display = 'block';
      });
  }

  function renderMonthGrid(body) {
    while (monthGrid.firstChild) monthGrid.removeChild(monthGrid.firstChild);

    WEEKDAY_HEADERS.forEach(function (label) {
      monthGrid.appendChild(el('div', 'admin-month-grid-weekday', label));
    });

    var year = body.year, month = body.month;
    var firstOfMonth = ymdIso(year, month, 1);
    var leadingBlanks = dayOfWeekIso(firstOfMonth);
    var totalDays = daysInMonth(year, month);

    // Leading padding cells (the tail of the previous month) — muted,
    // non-interactive. Standard calendar-grid convention; this is separate
    // from the historical floor, which bounds which MONTH is navigable at
    // all (Prev is disabled once at January 2026), not which padding days
    // a valid month's own grid happens to show.
    for (var i = 0; i < leadingBlanks; i++) {
      monthGrid.appendChild(el('div', 'admin-month-grid-cell is-outside'));
    }

    for (var day = 1; day <= totalDays; day++) {
      var iso = ymdIso(year, month, day);
      var jobs = state.monthJobsByDate[iso] || [];
      var cell = document.createElement('button');
      cell.type = 'button';
      var classes = ['admin-month-grid-cell', 'is-day'];
      if (iso === todayIso) classes.push('is-today');
      if (iso === state.monthSelectedDate) classes.push('is-selected');
      cell.className = classes.join(' ');
      cell.dataset.date = iso;
      cell.appendChild(el('span', 'admin-month-grid-daynum', String(day)));
      if (jobs.length) {
        cell.appendChild(el('span', 'admin-month-grid-count', String(jobs.length)));
      }
      cell.addEventListener('click', function (e) {
        selectMonthDate(e.currentTarget.dataset.date);
      });
      monthGrid.appendChild(cell);
    }

    // Trailing padding so the grid always ends on a full week row.
    var totalCells = leadingBlanks + totalDays;
    var trailing = (7 - (totalCells % 7)) % 7;
    for (var t = 0; t < trailing; t++) {
      monthGrid.appendChild(el('div', 'admin-month-grid-cell is-outside'));
    }

    monthGrid.style.display = 'grid';
  }

  function selectMonthDate(iso) {
    state.monthSelectedDate = iso;
    Array.prototype.forEach.call(monthGrid.querySelectorAll('.admin-month-grid-cell.is-day'), function (cell) {
      cell.classList.toggle('is-selected', cell.dataset.date === iso);
    });
    renderDayPanel(monthDayPanel, iso, state.monthJobsByDate[iso] || [], function (delta) { navigateMonthDayBy(iso, delta); });
    showQuickExpenseFor(iso);
  }

  // Previous-day/next-day arrows inside Month's day panel (Stage 2.4.2).
  // Staying within the currently loaded month is just re-selecting a date
  // already in state.monthJobsByDate; stepping past the 1st or the last day
  // of the month switches month/year state and reloads first, then selects
  // the target date once that month's data arrives.
  function navigateMonthDayBy(iso, delta) {
    var target = addDaysIso(iso, delta);
    if (target < HISTORICAL_FLOOR_ISO) return;
    var targetYear = Number(target.slice(0, 4));
    var targetMonth = Number(target.slice(5, 7));
    if (targetYear === state.monthYear && targetMonth === state.monthMonth) {
      selectMonthDate(target);
    } else {
      state.monthYear = targetYear;
      state.monthMonth = targetMonth;
      loadMonth(target);
    }
  }

  // ---------------------------------------------------------------------
  // Year — navigation only; per-month JOB COUNTS shown, never revenue/
  // profit/expenses (see api/admin/bookings.js's handleYear()).
  // ---------------------------------------------------------------------
  function loadYear() {
    yearPrevBtn.disabled = state.yearYear <= HISTORICAL_FLOOR_YEAR;
    yearLabel.textContent = String(state.yearYear);
    yearGrid.style.display = 'none';
    yearError.style.display = 'none';
    yearLoading.style.display = 'block';

    var seq = ++yearRequestSeq;
    adminFetch('/api/admin/bookings?view=schedule&range=year&year=' + state.yearYear)
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load the year.');
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== yearRequestSeq) return;
        yearLoading.style.display = 'none';
        renderYearGrid(body);
      })
      .catch(function (err) {
        if (seq !== yearRequestSeq) return;
        yearLoading.style.display = 'none';
        yearError.textContent = err && err.message ? err.message : 'Could not load the year.';
        yearError.style.display = 'block';
      });
  }

  function renderYearGrid(body) {
    while (yearGrid.firstChild) yearGrid.removeChild(yearGrid.firstChild);
    var counts = {};
    (body.monthCounts || []).forEach(function (m) { counts[m.month] = m.count; });

    for (var m = 1; m <= 12; m++) {
      var isBeforeFloor = body.year === HISTORICAL_FLOOR_YEAR && m < HISTORICAL_FLOOR_MONTH;
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'admin-year-grid-tile' + (isBeforeFloor ? ' is-disabled' : '');
      tile.disabled = isBeforeFloor;
      tile.dataset.month = String(m);
      tile.appendChild(el('span', 'admin-year-grid-month', MONTH_NAMES[m - 1]));
      var count = counts[m] || 0;
      if (count > 0) {
        tile.appendChild(el('span', 'admin-year-grid-count', count + (count === 1 ? ' job' : ' jobs')));
      }
      tile.addEventListener('click', function (e) {
        var month = Number(e.currentTarget.dataset.month);
        state.monthYear = body.year;
        state.monthMonth = month;
        showMonth();
      });
      yearGrid.appendChild(tile);
    }
    yearGrid.style.display = 'grid';
  }

  return { showWeek: showWeek, showMonth: showMonth, showYear: showYear };
})();
