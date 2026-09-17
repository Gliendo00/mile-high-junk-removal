// /admin — Month and Year calendar navigation (Phase 3C Stage 2.4). Fetched
// from api/admin/bookings.js's ?view=schedule&range=month|year modes (see
// that file's handleMonth()/handleYear() for the exact bounded-query
// contract). Reuses admin/schedule.js's renderJobCard (exposed as
// window.AdminSchedule.renderJobCard) for the selected-day job list rather
// than a second, drifting copy of that markup, and mounts
// admin/quick-expense.js under it for the Daily Quick Expense Tracking
// addendum.
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
  function ymdIso(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  var todayIso = denverTodayIso();
  var todayParts = todayIso.split('-').map(Number);

  var monthView, monthPrevBtn, monthNextBtn, monthLabel, monthLoading, monthError, monthGrid, monthDayPanel;
  var yearView, yearPrevBtn, yearNextBtn, yearLabel, yearLoading, yearError, yearGrid;
  var domReady = false;

  var monthRequestSeq = 0;
  var yearRequestSeq = 0;

  var state = {
    monthYear: todayParts[0],
    monthMonth: todayParts[1],
    yearYear: todayParts[0],
    selectedDate: null,
    monthJobsByDate: {}, // appointmentDate -> jobs[]
  };

  function ensureDom() {
    if (domReady) return;
    domReady = true;

    monthView = document.getElementById('month-view');
    monthPrevBtn = document.getElementById('month-prev');
    monthNextBtn = document.getElementById('month-next');
    monthLabel = document.getElementById('month-label');
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
    document.getElementById('today-tomorrow-week-view').hidden = true;
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

  function showMonth() {
    ensureDom();
    hideAllViews();
    monthView.hidden = false;
    setActiveRangeTab('month');
    loadMonth();
  }

  function showYear() {
    ensureDom();
    hideAllViews();
    yearView.hidden = false;
    setActiveRangeTab('year');
    loadYear();
  }

  // ---------------------------------------------------------------------
  // Month
  // ---------------------------------------------------------------------
  function loadMonth() {
    monthPrevBtn.disabled = state.monthYear === HISTORICAL_FLOOR_YEAR && state.monthMonth === HISTORICAL_FLOOR_MONTH;
    monthLabel.textContent = MONTH_NAMES[state.monthMonth - 1] + ' ' + state.monthYear;
    monthGrid.style.display = 'none';
    monthDayPanel.hidden = true;
    monthError.style.display = 'none';
    monthLoading.style.display = 'block';

    var seq = ++monthRequestSeq;
    fetch('/api/admin/bookings?view=schedule&range=month&year=' + state.monthYear + '&month=' + state.monthMonth)
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
        state.monthJobsByDate = {};
        (body.jobs || []).forEach(function (j) {
          if (!state.monthJobsByDate[j.appointmentDate]) state.monthJobsByDate[j.appointmentDate] = [];
          state.monthJobsByDate[j.appointmentDate].push(j);
        });
        renderMonthGrid(body);
        // Auto-select today if it falls within the loaded month — an
        // immediately useful default rather than an empty grid with
        // nothing selected. Any other month opens with no day selected, an
        // intentionally empty resting state (see renderMonthGrid's "empty
        // days should look intentionally empty, not broken").
        if (body.year === todayParts[0] && body.month === todayParts[1]) {
          selectDate(todayIso);
        } else {
          state.selectedDate = null;
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
      if (iso === state.selectedDate) classes.push('is-selected');
      cell.className = classes.join(' ');
      cell.dataset.date = iso;
      cell.appendChild(el('span', 'admin-month-grid-daynum', String(day)));
      if (jobs.length) {
        cell.appendChild(el('span', 'admin-month-grid-count', String(jobs.length)));
      }
      cell.addEventListener('click', function (e) {
        selectDate(e.currentTarget.dataset.date);
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

  function selectDate(iso) {
    state.selectedDate = iso;
    Array.prototype.forEach.call(monthGrid.querySelectorAll('.admin-month-grid-cell.is-day'), function (cell) {
      cell.classList.toggle('is-selected', cell.dataset.date === iso);
    });
    renderDayPanel(iso);
  }

  function renderDayPanel(iso) {
    while (monthDayPanel.firstChild) monthDayPanel.removeChild(monthDayPanel.firstChild);
    monthDayPanel.hidden = false;

    var heading = el('div', 'admin-day-panel-heading');
    var d = new Date(iso + 'T00:00:00');
    heading.textContent = isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    monthDayPanel.appendChild(heading);

    // A historical date offers "+ Past Job"; today or a future date offers
    // "+ New Job" — either way the selected date rides along as ?date= and
    // is re-validated server-side before it can ever affect a save (see
    // admin/booking-new.js's / admin/booking-past.js's own
    // applyDatePrefill() comments).
    var actionLink = document.createElement('a');
    actionLink.className = 'admin-btn admin-btn-outline admin-day-panel-action';
    if (iso < todayIso) {
      actionLink.href = '/admin/booking-past/?date=' + encodeURIComponent(iso);
      actionLink.textContent = '+ Past Job';
    } else {
      actionLink.href = '/admin/booking-new/?date=' + encodeURIComponent(iso);
      actionLink.textContent = '+ New Job';
    }
    monthDayPanel.appendChild(actionLink);

    var jobs = (state.monthJobsByDate[iso] || []).slice();
    var jobsWrap = el('ul', 'admin-booking-list admin-day-panel-jobs');
    if (!jobs.length) {
      jobsWrap.appendChild(el('li', 'admin-empty', 'No jobs on this date.'));
    } else if (window.AdminSchedule && window.AdminSchedule.renderJobCard) {
      jobs.forEach(function (job) {
        jobsWrap.appendChild(window.AdminSchedule.renderJobCard(job));
      });
    }
    monthDayPanel.appendChild(jobsWrap);

    // Daily Quick Expense Tracking — Phase 3C Stage 2.4 addendum. Mounted
    // below the job list so the job schedule stays visually primary.
    var expenseMount = el('div', 'admin-day-panel-expenses');
    monthDayPanel.appendChild(expenseMount);
    if (window.AdminQuickExpense) window.AdminQuickExpense.mount(expenseMount, iso);
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
    fetch('/api/admin/bookings?view=schedule&range=year&year=' + state.yearYear)
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

  return { showMonth: showMonth, showYear: showYear };
})();
