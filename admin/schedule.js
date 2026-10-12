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
  var toastEl = document.getElementById('admin-toast');

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

  // CRM-only UX fix — status-change feedback for the new clickable status
  // pill below, same transient-toast pattern admin/booking-detail.js
  // already uses (#admin-toast, admin/index.html).
  var toastTimer = null;
  function showToast(msg, kind) {
    if (!toastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
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
  // Same small down-chevron admin/booking/index.html's own
  // #d-status-trigger button ships statically — built here via the DOM
  // API (see svgEl() above) since this card is rendered dynamically.
  function statusChevronIcon() {
    var svg = svgEl('svg', { width: '9', height: '9', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { d: 'M1 3l4 4 4-4', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return svg;
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
    // Elevated (real shadow, see .admin-card-elevated in admin.css) only
    // for the Today view specifically — the one place "what needs my
    // attention right now" applies. Every other range (Yesterday,
    // Tomorrow, a day reached via the day-nav arrows, Week/Month) keeps
    // the existing flatter bordered treatment, same as Leads/Clients/
    // Expenses' own routine-scanning cards.
    var cardClass = 'admin-schedule-card admin-card-accent-' + job.status;
    if (currentRange === 'today') cardClass += ' is-today-elevated';
    var card = el('div', cardClass);

    // CRM-only UX fix — status is now its own clickable control, so (per
    // admin.css's own rule: "open detail" and action buttons are siblings,
    // never nested <a> tags) this whole row moves outside the anchor below.
    var top = el('div', 'admin-card-top admin-schedule-card-topbar');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-card-when', job.timeLabel || '—'));
    top.appendChild(topLeft);

    var statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.className = 'admin-status-badge admin-status-' + job.status + ' admin-status-trigger';
    var statusLabelEl = el('span', null, job.statusLabel || 'Booked');
    statusBtn.appendChild(statusLabelEl);
    statusBtn.appendChild(statusChevronIcon());
    statusBtn.addEventListener('click', function () {
      openJobStatusSheet(job, statusBtn, statusLabelEl);
    });
    top.appendChild(statusBtn);
    card.appendChild(top);

    var main = document.createElement('a');
    main.className = 'admin-schedule-card-main';
    main.href = '/admin/booking/?id=' + encodeURIComponent(job.id);

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

  // Estimate workflow — visually distinct from a job card (an "ESTIMATE"
  // type badge in the topbar, a different accent class) but built from the
  // exact same markup skeleton/CSS classes as renderJobCard() above
  // (admin-schedule-card/-topbar/-main/-actions) rather than a second
  // layout. Clicking the card opens /admin/estimate/, never /admin/booking/
  // — an estimate is never a bookings row (see
  // sql/2026-10-12_estimate-workflow.sql). The status pill opens
  // openEstimateStatusSheet() below, which is a completely separate
  // function from openJobStatusSheet() — an estimate card can never reach
  // openScheduleCloseout()/window.AdminJobCloseout, by construction, not by
  // a runtime check.
  var ESTIMATE_STATUS_TEXT = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', lost: 'Did Not Book' };

  function renderEstimateCard(estimate) {
    var li = document.createElement('li');
    var cardClass = 'admin-schedule-card admin-schedule-card-estimate admin-estimate-accent-' + estimate.status;
    if (currentRange === 'today') cardClass += ' is-today-elevated';
    var card = el('div', cardClass);

    var top = el('div', 'admin-card-top admin-schedule-card-topbar');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-estimate-type-badge', 'ESTIMATE'));
    topLeft.appendChild(el('span', 'admin-card-when', estimate.timeLabel || '—'));
    top.appendChild(topLeft);

    var statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.className = 'admin-status-badge admin-estimate-status-' + estimate.status + ' admin-status-trigger';
    var statusLabelEl = el('span', null, ESTIMATE_STATUS_TEXT[estimate.status] || estimate.status);
    statusBtn.appendChild(statusLabelEl);
    statusBtn.appendChild(statusChevronIcon());
    statusBtn.addEventListener('click', function () {
      openEstimateStatusSheet(estimate);
    });
    top.appendChild(statusBtn);
    card.appendChild(top);

    var main = document.createElement('a');
    main.className = 'admin-schedule-card-main';
    main.href = '/admin/estimate/?id=' + encodeURIComponent(estimate.id);
    main.appendChild(el('div', 'admin-card-name', (estimate.customer ? [estimate.customer.firstName, estimate.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client'));

    var serviceCityParts = [estimate.serviceLabel || 'Estimate'];
    if (estimate.serviceAddress && estimate.serviceAddress.city) serviceCityParts.push(estimate.serviceAddress.city);
    main.appendChild(el('div', 'admin-card-service', serviceCityParts.join(' · ')));

    var quotedText = formatPrice(estimate.quotedAmount);
    if (quotedText) main.appendChild(el('div', 'admin-schedule-card-price', 'Ballpark ' + quotedText));
    card.appendChild(main);

    var actions = el('div', 'admin-contact-actions is-triple admin-schedule-card-actions');
    var phone = estimate.customer ? estimate.customer.phone : null;
    var telHref = buildTelHref(phone);
    var smsHref = buildSmsHref(phone);

    var callBtn = quickBtn('primary', 'Call', callIcon);
    if (telHref) callBtn.href = telHref; else disableAction(callBtn);
    actions.appendChild(callBtn);

    var textBtn = quickBtn('primary', 'Text', textIcon);
    if (smsHref) textBtn.href = smsHref; else disableAction(textBtn);
    actions.appendChild(textBtn);

    var directionsBtn = quickBtn('secondary', 'Directions', directionsIcon);
    var mapsQuery = estimate.serviceAddress
      ? [estimate.serviceAddress.address, estimate.serviceAddress.city, estimate.serviceAddress.state, estimate.serviceAddress.zip].filter(Boolean).join(', ')
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

  // Opens the shared change-status bottom sheet (admin/status-ui.js) with
  // the Estimate workflow's own small vocabulary (via the `labels` option
  // that module now supports) — completely independent of
  // window.AdminStatusUI.STATUS_ORDER/STATUS_TEXT, which stay
  // bookings.status-only. "converted" is never offered here — Convert to
  // Job is its own dedicated action on the Estimate detail page, since
  // converting creates a whole new job record rather than just changing a
  // status.
  //
  // Hardening pass: picking a status here now opens the shared
  // window.AdminEstimateOutcome sheet (admin/estimate-outcome-sheet.js) —
  // the SAME sheet admin/estimate-detail.js's own per-action buttons use —
  // rather than PATCHing directly on select. This both replaces the
  // original direct-PATCH-on-select behavior with the CRM-native sheet
  // pattern and gives Schedule a way to add an optional outcome note/
  // reason, which it never had before. The sheet performs its own PATCH
  // and write-then-refresh; this function never touches the network
  // itself.
  function openEstimateStatusSheet(estimate) {
    var values = estimate.status === 'scheduled' ? ['scheduled', 'completed', 'cancelled'] : ['completed', 'lost'];
    window.AdminStatusUI.open({
      title: 'Change estimate status',
      values: values,
      selected: estimate.status,
      labels: ESTIMATE_STATUS_TEXT,
      onSelect: function (newStatus) {
        if (newStatus === estimate.status) return;
        var action = newStatus === 'completed' ? 'complete' : newStatus === 'cancelled' ? 'cancel' : newStatus === 'lost' ? 'lost' : null;
        if (!action) return;
        window.AdminEstimateOutcome.open({
          estimateId: estimate.id,
          action: action,
          onComplete: function () {
            showToast('Estimate updated.', 'success');
            refreshCurrentView();
          },
        });
      },
    });
  }

  // Estimate workflow — small local copy of api/_lib/time-windows.js's
  // start-hour table (this file's own established per-file-duplication
  // convention — see addDaysIso()/formatPrice() above for prior examples),
  // just enough to interleave estimates with jobs by time of day on the
  // client. Each of `jobs`/`estimates` already arrives individually sorted
  // from the server; this only needs to merge the two.
  var WINDOW_START_HOUR = {
    morning: 8, midday: 11, afternoon: 14, evening: 17,
    w_0400_0600: 4, w_0600_0800: 6, w_0800_1000: 8, w_1000_1200: 10,
    w_1200_1400: 12, w_1400_1600: 14, w_1600_1800: 16, w_1800_2000: 18, w_2000_2200: 20,
  };
  function parseExactTimeMinutes(raw) {
    if (typeof raw !== 'string') return null;
    var m = /^(\d{2}):(\d{2})/.exec(raw.trim());
    if (!m) return null;
    var h = Number(m[1]), min = Number(m[2]);
    if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(min) || min < 0 || min > 59) return null;
    return h * 60 + min;
  }
  function effectiveTimeSortMinutes(timeWindow, exactTime) {
    var exactMinutes = parseExactTimeMinutes(exactTime);
    if (exactMinutes !== null) return exactMinutes;
    var hour = WINDOW_START_HOUR[timeWindow];
    return hour === undefined ? null : hour * 60;
  }
  function mergeJobsAndEstimates(jobs, estimates) {
    var combined = (jobs || []).map(function (j) { return { kind: 'job', data: j }; }).concat(
      (estimates || []).map(function (e) { return { kind: 'estimate', data: e }; })
    );
    combined.sort(function (a, b) {
      if (a.data.appointmentDate !== b.data.appointmentDate) {
        return a.data.appointmentDate < b.data.appointmentDate ? -1 : 1;
      }
      var aMin = effectiveTimeSortMinutes(a.data.timeWindow, a.data.exactTime);
      var bMin = effectiveTimeSortMinutes(b.data.timeWindow, b.data.exactTime);
      if (aMin === null && bMin === null) return 0;
      if (aMin === null) return 1;
      if (bMin === null) return -1;
      return aMin - bMin;
    });
    return combined;
  }

  function render(items) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (!items.length) {
      emptyEl.textContent = EMPTY_MESSAGES[currentRange] || 'No jobs scheduled.';
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    items.forEach(function (item) {
      listEl.appendChild(item.kind === 'estimate' ? renderEstimateCard(item.data) : renderJobCard(item.data));
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
      // Estimates are merged into the SAME rendered list as jobs (never a
      // separate calendar) but kept out of admin/schedule-financials.js
      // entirely — that module is handed only `body.jobs`, exactly as
      // before, so Revenue/Booked/Net can never see an estimate.
      render(mergeJobsAndEstimates(body.jobs, body.estimates));
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
    return adminFetch(url).then(function (res) {
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

  // CRM-only UX fix — re-fetches whichever single day is currently on
  // screen after a status/closeout change, so the card's badge/price/
  // revenue counters reflect the save immediately, without a manual
  // reload. Only ever called from a job card's own status button, which
  // only renders on Today/Tomorrow/Yesterday/a day-nav date — never while
  // Week/Month/Year is the active range (those use admin/calendar-views.js's
  // own separate, unaffected card renderer).
  function refreshCurrentView() {
    if (currentRange === 'day') {
      loadDate(activeDateIso);
    } else {
      load(currentRange);
    }
  }

  // Same bare PATCH /api/admin/booking?resource=status call
  // admin/booking-detail.js's own patchStatus() makes, kept as its own
  // small copy here rather than a shared cross-file import — this
  // project's established per-file convention (see e.g. this file's own
  // formatPrice()/addDaysIso()) for a thin, one-endpoint network wrapper.
  // Never used for the 'completed' transition — that always goes through
  // window.AdminJobCloseout (see openScheduleCloseout() below), the one
  // shared implementation of the actual closeout write sequence.
  function patchJobStatusOnly(jobId, newStatus) {
    return adminFetch('/api/admin/booking?resource=status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, status: newStatus }),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not update status.');
          return body;
        });
    });
  }

  // Tracks which jobs currently have a status save in flight (by id, not a
  // single page-wide flag) so an overlapping tap on a DIFFERENT job's
  // status button is never blocked by one that's still saving.
  var statusSavingIds = {};

  function saveJobStatus(job, newStatus, statusBtn) {
    if (statusSavingIds[job.id]) return;
    statusSavingIds[job.id] = true;
    statusBtn.disabled = true;
    statusBtn.classList.add('is-saving');

    patchJobStatusOnly(job.id, newStatus)
      .then(function (body) {
        if (!body) return; // redirected to login
        showToast('Status updated to ' + (window.AdminStatusUI.STATUS_TEXT[body.status] || body.status) + '.', 'success');
        refreshCurrentView();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not update status. Please try again.', 'error');
      })
      .finally(function () {
        delete statusSavingIds[job.id];
        statusBtn.disabled = false;
        statusBtn.classList.remove('is-saving');
      });
  }

  // Completing a job from Schedule opens the exact same Payment + Tip +
  // How'd it go? closeout sheet admin/booking-detail.js's Status control
  // uses (admin/job-closeout.js) — never a second, Schedule-specific
  // implementation of that flow or its writes. A cancel from the sheet
  // calls nothing, so the job's status is left completely untouched; a
  // failed status save leaves it untouched too (the sheet's own error box
  // reports it) — refreshCurrentView() only ever runs after a confirmed
  // server-side success.
  function openScheduleCloseout(job) {
    window.AdminJobCloseout.open({
      bookingId: job.id,
      onComplete: function (result) {
        var messages = ['Job marked Completed.'];
        if (result.paymentSaved) messages.push('Payment saved.');
        if (result.paymentError) messages.push('Payment NOT saved: ' + result.paymentError);
        if (result.tipSaved) messages.push('Tip saved.');
        if (result.tipError) messages.push('Tip NOT saved: ' + result.tipError);
        var hadError = !!(result.paymentError || result.tipError);
        showToast(messages.join(' '), hadError ? 'error' : 'success');
        refreshCurrentView();
      },
    });
  }

  // Opens the exact same change-status bottom sheet (admin/status-ui.js)
  // admin/booking-detail.js's own openStatusSheet() uses, with the exact
  // same "only a dumpster rental ever offers Rental Out" filter and the
  // exact same "Completed opens the closeout sheet, everything else saves
  // immediately" routing — the one difference is which page it's tapped
  // from.
  function openJobStatusSheet(job, statusBtn) {
    if (statusSavingIds[job.id]) return;
    var values = window.AdminStatusUI.STATUS_ORDER.filter(function (key) {
      return key !== 'rental_out' || job.serviceType === 'dumpster_rental';
    });
    window.AdminStatusUI.open({
      title: 'Change status',
      values: values,
      selected: job.status,
      onSelect: function (newStatus) {
        if (newStatus === job.status) return;
        if (newStatus === 'completed') {
          openScheduleCloseout(job);
        } else {
          saveJobStatus(job, newStatus, statusBtn);
        }
      },
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
