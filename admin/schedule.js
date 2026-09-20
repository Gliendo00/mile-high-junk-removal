// /admin — Schedule homepage: Today/Tomorrow/Yesterday (Yesterday added
// Stage 2.4.2) plus the range-tab orchestrator for all six ranges.
// Week/Month/Year each live in their own view container, rendered by
// admin/calendar-views.js (Week redesigned into a compact 7-day overview in
// Stage 2.4.1 — see that file). Stage 2.4.2 also added the restrained
// previous-day/next-day stepper (#day-nav) so browsing isn't limited to
// exactly these three named days — see loadDate()/applyDayResult() below.
//
// Every dynamic value below is written with textContent (never
// innerHTML/insertAdjacentHTML with a concatenated string), so a
// customer-supplied name/address/description containing "<script>" or any
// other markup is rendered as inert text, never parsed as HTML — same
// discipline as admin/dashboard.js and admin/booking-detail.js.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('schedule-list');
  var rangeTabs = document.querySelectorAll('.admin-range-tab');
  var logoutBtn = document.getElementById('logout-btn');

  var todayTomorrowView = document.getElementById('today-tomorrow-view');
  var weekView = document.getElementById('week-view');
  var monthView = document.getElementById('month-view');
  var yearView = document.getElementById('year-view');
  var dayNavPrevBtn = document.getElementById('day-nav-prev');
  var dayNavNextBtn = document.getElementById('day-nav-next');
  var dayNavLabel = document.getElementById('day-nav-label');

  var currentRange = 'today';
  var requestSeq = 0; // guards against an in-flight request resolving after a newer range change
  // The single date currently on screen — set from the server's own
  // startDate on every today/tomorrow/yesterday/day response, never derived
  // from the client's clock. Backs the previous-day/next-day arrows, which
  // only ever need "one day before/after whatever is showing right now".
  var activeDateIso = null;

  // Small local copy of the historical floor — same value as
  // api/_lib/historical-floor.js, duplicated client-side per this project's
  // established convention (see that file's own header, and
  // admin/calendar-views.js's identical copy) rather than a cross-runtime
  // import.
  var HISTORICAL_FLOOR_ISO = '2026-01-01';

  var EMPTY_MESSAGES = {
    today: 'No jobs scheduled for today.',
    tomorrow: 'No jobs scheduled for tomorrow.',
    yesterday: 'No jobs scheduled for yesterday.',
    day: 'No jobs scheduled for this date.',
  };

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
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

  // Adds `days` calendar days to a YYYY-MM-DD string — a small local copy of
  // api/admin/bookings.js's own addDaysIso, matching admin/calendar-views.js's
  // identical copy (this project's established convention of a small
  // duplicated calendar-math helper per client file rather than a shared
  // cross-runtime import).
  function addDaysIso(iso, days) {
    var p = iso.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  }

  function buildTelHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'tel:+1' + digits : 'tel:+' + digits;
  }
  function buildSmsHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'sms:+1' + digits : 'sms:+' + digits;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function disableAction(btn) {
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
  }

  // Icons are built via the SVG DOM API (createElementNS), never innerHTML
  // — mirrors admin/dashboard.js's cameraIcon() exactly, so this file keeps
  // the same zero-exceptions "no innerHTML/insertAdjacentHTML" discipline as
  // every other admin script, even though this particular markup is a fixed
  // constant rather than server/customer-derived.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  function svgIcon(children) {
    var svg = svgEl('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' });
    children.forEach(function (child) { svg.appendChild(child); });
    return svg;
  }
  function callIcon() {
    return svgIcon([svgEl('path', { d: 'M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.9 21 3 13.1 3 3.9c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1L6.6 10.8Z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' })]);
  }
  function textIcon() {
    return svgIcon([svgEl('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' })]);
  }
  function directionsIcon() {
    return svgIcon([
      svgEl('path', { d: 'M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }),
      svgEl('circle', { cx: '12', cy: '9.5', r: '2.5', stroke: 'currentColor', 'stroke-width': '1.6' }),
    ]);
  }

  function quickBtn(kind, label, iconFn) {
    var a = document.createElement('a');
    a.className = 'admin-quick-btn ' + (kind === 'primary' ? 'admin-quick-primary' : 'admin-quick-secondary');
    a.appendChild(iconFn());
    a.appendChild(document.createTextNode(label));
    return a;
  }

  function renderJobCard(job) {
    var li = document.createElement('li');
    var card = el('div', 'admin-schedule-card admin-card-accent-' + job.status);

    var main = document.createElement('a');
    main.className = 'admin-schedule-card-main';
    main.href = '/admin/booking/?id=' + encodeURIComponent(job.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-card-when', job.timeLabel || '—'));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-status-badge admin-status-' + job.status, job.statusLabel || 'Booked'));
    main.appendChild(top);

    main.appendChild(el('div', 'admin-card-name', (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client'));

    var serviceCityParts = [job.serviceLabel || job.serviceType || '—'];
    if (job.serviceAddress && job.serviceAddress.city) serviceCityParts.push(job.serviceAddress.city);
    main.appendChild(el('div', 'admin-card-service', serviceCityParts.join(' · ')));

    // Status-aware, not a blind final_price-or-estimated_price fallback
    // (Phase 3C Stage 2.5 addendum): a completed job's authoritative
    // revenue figure is Actual Collected (falling back to Quoted only if
    // no actual amount was ever recorded); a non-completed job always
    // shows its Quoted amount, even if an Actual Collected amount already
    // exists on it (recorded early, before the job was marked complete) —
    // showing that number here would incorrectly read as "already paid."
    // One number, unlabeled, to keep the card compact — never both.
    var priceText = job.status === 'completed'
      ? (formatPrice(job.finalPrice) || formatQuotedAmount(job.estimatedPrice, job.estimatedPriceMax))
      : formatQuotedAmount(job.estimatedPrice, job.estimatedPriceMax);
    if (priceText) main.appendChild(el('div', 'admin-schedule-card-price', priceText));

    card.appendChild(main);

    var actions = el('div', 'admin-contact-actions is-triple admin-schedule-card-actions');
    var phone = job.customer ? job.customer.phone : null;
    var telHref = buildTelHref(phone);
    var smsHref = buildSmsHref(phone);

    var callBtn = quickBtn('primary', 'Call', callIcon);
    if (telHref) callBtn.href = telHref; else disableAction(callBtn);
    actions.appendChild(callBtn);

    var textBtn = quickBtn('primary', 'Text', textIcon);
    if (smsHref) textBtn.href = smsHref; else disableAction(textBtn);
    actions.appendChild(textBtn);

    var directionsBtn = quickBtn('secondary', 'Directions', directionsIcon);
    var mapsQuery = job.serviceAddress
      ? [job.serviceAddress.address, job.serviceAddress.city, job.serviceAddress.state, job.serviceAddress.zip].filter(Boolean).join(', ')
      : '';
    if (mapsQuery) {
      directionsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
      directionsBtn.target = '_blank';
      directionsBtn.rel = 'noopener';
    } else {
      disableAction(directionsBtn);
    }
    actions.appendChild(directionsBtn);

    card.appendChild(actions);
    li.appendChild(card);
    return li;
  }

  function render(jobs) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (!jobs.length) {
      emptyEl.textContent = EMPTY_MESSAGES[currentRange] || 'No jobs scheduled.';
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    jobs.forEach(function (job) {
      listEl.appendChild(renderJobCard(job));
    });
  }

  function setActiveTab(range) {
    rangeTabs.forEach(function (btn) {
      var isActive = btn.getAttribute('data-range') === range;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  // Formats the day-nav heading and disables "Previous day" once the
  // displayed date is the historical floor itself — matches
  // admin/calendar-views.js's identical "day before the floor is disabled"
  // treatment on Week/Month/Year's own Prev controls.
  function updateDayNav(iso) {
    var d = new Date(iso + 'T00:00:00');
    dayNavLabel.textContent = isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    dayNavPrevBtn.disabled = iso <= HISTORICAL_FLOOR_ISO;
  }

  // Highlights whichever of the Yesterday/Today/Tomorrow tabs (if any)
  // exactly matches the date just loaded — comparing against the server's
  // own `today`, never the client's clock. A date reached only via the
  // day-nav arrows (e.g. two days from now) matches none of the three, so
  // every tab is correctly left unhighlighted rather than guessing.
  function updateActiveTabForDate(body) {
    var iso = body.startDate;
    var today = body.today;
    var matched = null;
    if (iso === today) matched = 'today';
    else if (iso === addDaysIso(today, -1)) matched = 'yesterday';
    else if (iso === addDaysIso(today, 1)) matched = 'tomorrow';
    setActiveTab(matched || '');
  }

  // Shared tail end of every today/tomorrow/yesterday/day-nav fetch: update
  // the day-nav heading, the active tab, the relocated Quick Expense bar
  // (admin/quick-expense.js), and the job list itself — in that order, so
  // every one of those four stays perfectly in sync with whichever single
  // date the response actually resolved (never the date that was merely
  // requested, which matters for `beforeHistoricalFloor`).
  function applyDayResult(body) {
    activeDateIso = body.startDate;
    updateDayNav(activeDateIso);
    updateActiveTabForDate(body);
    if (body.beforeHistoricalFloor) {
      render([]);
      emptyEl.textContent = 'No historical records before January 1, 2026.';
      window.AdminQuickExpense.hideBar();
      window.AdminScheduleFinancials.hide();
    } else {
      render(body.jobs || []);
      window.AdminQuickExpense.showBar(activeDateIso);
      window.AdminScheduleFinancials.show(activeDateIso, activeDateIso, body.jobs || []);
    }
  }

  // Common setup for every today/tomorrow/yesterday/day-nav fetch: show this
  // view (hiding Week/Month/Year), reset the loading/empty/list UI, and hide
  // the Quick Expense bar until the new date's response actually resolves
  // (rather than briefly showing the previous date's controls).
  function beginDayLoad() {
    todayTomorrowView.hidden = false;
    weekView.hidden = true;
    monthView.hidden = true;
    yearView.hidden = true;

    var seq = ++requestSeq;
    listEl.style.display = 'none';
    emptyEl.style.display = 'none';
    loadingEl.style.display = 'block';
    clearError();
    window.AdminQuickExpense.hideBar();
    window.AdminScheduleFinancials.hide();
    return seq;
  }

  // Served by api/admin/bookings.js's ?view=schedule mode rather than a
  // dedicated api/admin/schedule.js file — see the countsOnly/scheduleView
  // comment in that file (Vercel Hobby plan's 12-Serverless-Function
  // limit; docs/phase-3/vercel-function-limit.md).
  function fetchDay(url, fallbackErrorMsg) {
    return fetch(url).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) {
            throw new Error((body && body.error) || fallbackErrorMsg);
          }
          return body;
        });
    });
  }

  // range: 'today' | 'tomorrow' | 'yesterday' only — Week/Month/Year are all
  // handled by admin/calendar-views.js.
  function load(range) {
    currentRange = range;
    setActiveTab(range);
    var seq = beginDayLoad();

    fetchDay('/api/admin/bookings?view=schedule&range=' + encodeURIComponent(range), 'Could not load the schedule.')
      .then(function (body) {
        if (!body || seq !== requestSeq) return; // redirected to login, or superseded by a newer range change
        loadingEl.style.display = 'none';
        applyDayResult(body);
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load the schedule.');
      });
  }

  // Previous-day/next-day navigation (Stage 2.4.2) — an explicit date via
  // ?range=day&date=, for browsing beyond exactly yesterday/today/tomorrow.
  // "Yesterday" stays its own dedicated tab regardless (see admin/index.html)
  // — this is an additional, independent way to reach any date one step at
  // a time, not a replacement for it.
  function loadDate(iso) {
    currentRange = 'day';
    var seq = beginDayLoad();

    fetchDay('/api/admin/bookings?view=schedule&range=day&date=' + encodeURIComponent(iso), 'Could not load that date.')
      .then(function (body) {
        if (!body || seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        applyDayResult(body);
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load that date.');
      });
  }

  dayNavPrevBtn.addEventListener('click', function () {
    if (dayNavPrevBtn.disabled || !activeDateIso) return;
    loadDate(addDaysIso(activeDateIso, -1));
  });
  dayNavNextBtn.addEventListener('click', function () {
    if (!activeDateIso) return;
    loadDate(addDaysIso(activeDateIso, 1));
  });

  // Week/Month/Year are rendered entirely by admin/calendar-views.js, which
  // manages its own view-container visibility and active-tab state (see
  // that file's hideAllViews()/setActiveRangeTab()) — this file only needs
  // to hand off to it and remember that Today/Tomorrow is no longer the
  // active range, so a later Today/Tomorrow tap is recognized as an actual
  // change.
  rangeTabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var range = btn.getAttribute('data-range');
      if (range === currentRange) return;
      if (range === 'week') {
        currentRange = 'week';
        window.AdminCalendarViews.showWeek();
        return;
      }
      if (range === 'month') {
        currentRange = 'month';
        window.AdminCalendarViews.showMonth();
        return;
      }
      if (range === 'year') {
        currentRange = 'year';
        window.AdminCalendarViews.showYear();
        return;
      }
      load(range);
    });
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  // A back-navigation restored from bfcache can show a stale schedule (e.g.
  // after changing a booking's status on the detail page and tapping
  // "back") — force a clean reload, same reasoning as admin/dashboard.js.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  // Exposed for admin/calendar-views.js to reuse the exact same job-card
  // rendering Today/Tomorrow use — never a second, drifting copy of this
  // markup/logic. (Week's compact overview and the shared selected-day
  // panel use their own simpler card — see calendar-views.js's
  // renderDailyJobCard() — deliberately different from this fuller
  // Call/Text/Directions card, which stays exactly as-is for Today/Tomorrow.)
  window.AdminSchedule = { renderJobCard: renderJobCard };

  load('today');
});
