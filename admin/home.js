// /admin/home/ — "Morning Command Center" operational dashboard (redesign
// pass, 2026-10-11). Replaces the previous dark-sidebar dashboard shell
// with a single-column, mobile-first layout. Deliberately NOT an
// analytics page: every number here is either read straight off an
// existing endpoint's response or computed with the EXACT SAME formula an
// existing page already uses on that same data — see completedRevenueAmount
// and bookedJobAmount below, both byte-for-byte duplicates of admin/
// schedule-financials.js's own functions (same per-file-duplication
// convention this project already follows throughout admin/*-list.js/
// *-detail.js), so Revenue/Booked here can never silently disagree with
// what Schedule's own Business Pulse counters show for the same range.
// Nothing here writes anything (except the inline Add Expense action,
// which reuses admin/quick-expense.js's own existing, already-tested write
// path unchanged), and no new API endpoint was added for this page — six
// existing, already-admin-authenticated GETs, fetched in two stages:
//
//   Stage 1 (parallel, independent):
//   - GET /api/admin/bookings?view=schedule&range=today  (Today's Jobs /
//     Today's Schedule)
//   - GET /api/admin/bookings?view=schedule&range=week    (Booked This
//     Week / Revenue This Week / Business Pulse — jobs + the week's real
//     startDate/endDate, needed for stage 2 below)
//   - GET /api/admin/intake                                (Pending Intake)
//   - GET /api/admin/bookings?view=leads                   (Leads Need
//     Attention / Leads Need Your Attention)
//
//   Stage 2 (parallel, fired only once the week's startDate/endDate are
//   known from stage 1 — never guessed client-side, so the range can never
//   drift from what Schedule itself queries for "This Week"):
//   - GET /api/admin/bookings?view=expenses&startDate=&endDate=
//   - GET /api/admin/bookings?view=other-revenue&startDate=&endDate=
//
// Revenue This Week = completed-job revenue (completedRevenueAmount, sum
// over 'completed' jobs in the week) + Other Revenue's totalAmount for the
// same week — the EXACT definition admin/schedule-financials.js's own
// computeFromJobs()/show() use for its "Revenue" counter. Booked This Week
// = SUM(estimatedPrice) over 'booked'+'rental_out' jobs in the week — same
// exact rule as that file's bookedJobAmount(). Business Pulse's "Completed"
// figure is deliberately a plain job COUNT, not a dollar amount — there is
// no existing "completed dollar amount distinct from Revenue" definition in
// this codebase, and inventing one was explicitly out of scope for this
// pass; a count needs no formula at all, so it can't drift.
//
// If the week schedule fetch fails, stage 2 is skipped entirely rather than
// guessing a week boundary client-side (which risks a Revenue/Booked number
// that silently disagrees with Schedule's own, the one thing this pass was
// told must never happen) — Business Pulse/Booked This Week/Revenue This
// Week simply render "—" and the failure is named in the error banner,
// same partial-failure honesty posture as every section below.
//
// "Needs Attention" here is the exact same UI-only bucket union as admin/
// leads-list.js's own Needs Attention sidebar view (Pending Intake + New +
// Waiting on Photos + Follow Up) — duplicated rather than imported, so the
// two pages' counts can never silently drift apart from a shared-module
// refactor gone wrong, matching this project's established convention.
// "New" also merges in website-origin requests (sections.websiteRequests)
// here exactly as it does there: Website Request is a source, not a lead
// stage (see leads-list.js's own header for the full reasoning). Follow Up
// is every lead currently in that status, not ones whose next_follow_up_date
// has actually arrived — deliberately NOT relabeled "Due" or filtered by
// date here, since that would be a lead-business-logic change, explicitly
// out of scope for this pass.
//
// Search Whisperer is a disabled visual shell only — the input and button
// both carry the native `disabled` attribute, there is no click handler,
// no fetch, and no backend for it. It is wired to real search in a future
// pass.
//
// Every dynamic value is written with textContent/DOM construction, never
// innerHTML — same no-innerHTML discipline as every other admin/*.js file.
document.addEventListener('DOMContentLoaded', function () {
  var logoutBtn = document.getElementById('logout-btn');
  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  // -----------------------------------------------------------------
  // Greeting — adjusts to the browser's own local time of day (this is a
  // personal greeting, not a business-day boundary, so unlike "today" on
  // Schedule it deliberately does NOT use the server's Denver-local clock).
  // "Junkers" rather than a specific name — more than one person logs into
  // this same admin session.
  // -----------------------------------------------------------------
  var hour = new Date().getHours();
  var timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('dash-greeting').textContent = timeGreeting + ', Junkers.';

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var bodyEl = document.getElementById('dash-body');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === null || text === undefined || text === '' ? '—' : text;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function formatMoney(n) {
    var v = Number(n) || 0;
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  // Business Pulse specifically mirrors admin/schedule-financials.js's own
  // Revenue/Booked/Expenses/Net display, which always shows 2 decimals
  // (see that file's own formatMoney()) — used only for the Business Pulse
  // card below, so its figures look identical to Schedule's own breakdown,
  // not just compute to the same value.
  function formatMoneyFixed(n) {
    var v = Number(n) || 0;
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(shapes) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    shapes.forEach(function (shape) {
      var node = document.createElementNS(SVG_NS, shape.tag);
      Object.keys(shape.attrs).forEach(function (k) { node.setAttribute(k, shape.attrs[k]); });
      svg.appendChild(node);
    });
    return svg;
  }
  function iconPhone() {
    return svgIcon([{ tag: 'path', attrs: { d: 'M5 3 L9 3 L10.5 7 L8 9.5 C9.5 12.5 11.5 14.5 14.5 16 L17 13.5 L21 15 L21 19 C21 20.1 20.1 21 19 21 C10.7 21 3 13.3 3 5 C3 3.9 3.9 3 5 3 Z' } }]);
  }
  function iconText() {
    return svgIcon([{ tag: 'path', attrs: { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z' } }]);
  }
  function iconArrowRight() {
    return svgIcon([{ tag: 'path', attrs: { d: 'M5 12h13M12 5l7 7-7 7' } }]);
  }

  // The exact Completed-Revenue / Booked rules, duplicated from admin/
  // schedule-financials.js's own completedRevenueAmount()/bookedJobAmount()
  // (see that file's header for the full reasoning) — never re-derived
  // differently here.
  function completedRevenueAmount(job) {
    if (job.isComplimentary) return 0;
    var hasFinal = job.finalPrice !== null && job.finalPrice !== undefined && job.finalPrice !== '';
    var amount = Number(hasFinal ? job.finalPrice : job.estimatedPrice);
    return Number.isFinite(amount) ? amount : 0;
  }
  function bookedJobAmount(job) {
    return Number(job.estimatedPrice) || 0;
  }
  function jobDisplayName(job) {
    return (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client';
  }

  function ageText(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diffMins = Math.floor((Date.now() - then) / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    var hours = Math.floor(diffMins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  var BUCKET_CHIP_CLASS = {
    pendingIntake: 'admin-lead-bucket-pendingIntake',
    new: 'admin-lead-bucket-new',
    waitingOnPhotos: 'admin-lead-bucket-waitingOnPhotos',
    followUp: 'admin-lead-bucket-followUp',
  };
  var BUCKET_LABELS = { pendingIntake: 'Pending Review', new: 'New', waitingOnPhotos: 'Waiting on Photos', followUp: 'Follow Up' };

  // -----------------------------------------------------------------
  // Today's Schedule — compact rows, up to 4, linking to the canonical
  // booking detail page (same route Schedule's own cards use).
  // -----------------------------------------------------------------
  var SCHEDULE_ROW_LIMIT = 4;
  function buildScheduleRow(job) {
    var row = el('div', 'admin-home-row');
    var main = document.createElement('a');
    main.className = 'admin-home-row-main';
    main.href = '/admin/booking/?id=' + encodeURIComponent(job.id);
    main.style.textDecoration = 'none';
    main.style.color = 'inherit';
    main.style.display = 'block';

    // Status badge lives IN the wrapping top row (same pattern Leads Need
    // Your Attention's rows already use) rather than as a separate flex
    // sibling of the whole row — on a narrow phone with a long time+name,
    // this lets the badge wrap onto its own line under the job info
    // instead of getting squeezed/clipped against the row's action icons.
    var top = el('div', 'admin-home-row-top');
    top.appendChild(el('span', 'admin-home-row-time', job.timeLabel || '—'));
    top.appendChild(el('span', 'admin-home-row-name', jobDisplayName(job)));
    top.appendChild(el('span', 'admin-status-badge admin-status-' + (job.status || 'new'), job.statusLabel || job.status || '—'));
    main.appendChild(top);

    var metaParts = [job.serviceLabel || job.serviceType || '—'];
    var city = job.serviceAddress && job.serviceAddress.city;
    if (city) metaParts.push(city);
    main.appendChild(el('div', 'admin-home-row-meta', metaParts.join(' · ')));
    row.appendChild(main);

    var actions = el('div', 'admin-home-row-actions');
    var telHref = buildTelHref(job.customer && job.customer.phone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-home-row-icon-btn';
      callBtn.href = telHref;
      callBtn.setAttribute('aria-label', 'Call ' + jobDisplayName(job));
      callBtn.appendChild(iconPhone());
      actions.appendChild(callBtn);
    }
    row.appendChild(actions);
    return row;
  }

  function renderTodaySchedule(jobs) {
    var listEl = document.getElementById('today-schedule-list');
    var emptyEl = document.getElementById('today-schedule-empty');
    clear(listEl);
    if (!jobs.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    jobs.slice(0, SCHEDULE_ROW_LIMIT).forEach(function (job) {
      listEl.appendChild(buildScheduleRow(job));
    });
  }

  // -----------------------------------------------------------------
  // Leads Needing Attention — merges Pending Intake + New (lead + website)
  // + Waiting on Photos + Follow Up, top 3 rows (the highest-priority
  // section on this page), each with a truthful "short context" line built
  // only from real fields (service type + city) — never a fabricated quote
  // or note, since no free-text context field exists on this view's data —
  // and an explicit Call / Text / Open row of actions.
  // -----------------------------------------------------------------
  var ATTENTION_ROW_LIMIT = 3;
  function intakeToRow(intake) {
    var name = intake.matchedClientName || intake.extractedClientName || intake.extractedPhone || intake.extractedEmail || 'Unidentified client';
    return {
      href: '/admin/intake/?id=' + encodeURIComponent(intake.id),
      name: name,
      contextLabel: intake.extractedServiceType || null,
      bucketKey: 'pendingIntake',
      phone: intake.extractedPhone,
      createdAt: intake.createdAt,
    };
  }
  function leadItemToRow(item, bucketKey) {
    return {
      href: (item.kind === 'booking' ? '/admin/booking/?id=' : '/admin/lead/?id=') + encodeURIComponent(item.id),
      name: item.name || item.phone || 'Unidentified client',
      contextLabel: [item.serviceLabel, item.city].filter(Boolean).join(' · ') || null,
      bucketKey: bucketKey,
      phone: item.phone,
      createdAt: item.updatedAt,
    };
  }

  function buildAttentionRow(row) {
    var wrap = el('div', 'admin-home-row');
    var main = el('div', 'admin-home-row-main');

    var top = el('div', 'admin-home-row-top');
    top.appendChild(el('span', 'admin-home-row-name', row.name));
    top.appendChild(el('span', 'admin-status-badge ' + (BUCKET_CHIP_CLASS[row.bucketKey] || 'admin-lead-bucket-new'), BUCKET_LABELS[row.bucketKey] || ''));
    main.appendChild(top);

    var metaParts = [];
    if (row.contextLabel) metaParts.push(row.contextLabel);
    var age = ageText(row.createdAt);
    if (age) metaParts.push(age);
    if (metaParts.length) main.appendChild(el('div', 'admin-home-row-meta', metaParts.join(' · ')));
    wrap.appendChild(main);

    var actions = el('div', 'admin-home-row-actions');
    var telHref = buildTelHref(row.phone);
    var smsHref = buildSmsHref(row.phone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-home-row-icon-btn';
      callBtn.href = telHref;
      callBtn.setAttribute('aria-label', 'Call ' + row.name);
      callBtn.appendChild(iconPhone());
      actions.appendChild(callBtn);
    }
    if (smsHref) {
      var textBtn = document.createElement('a');
      textBtn.className = 'admin-home-row-icon-btn';
      textBtn.href = smsHref;
      textBtn.setAttribute('aria-label', 'Text ' + row.name);
      textBtn.appendChild(iconText());
      actions.appendChild(textBtn);
    }
    // An explicit arrow icon (always rendered) plus a text label that CSS
    // hides below ~400px (see .admin-home-row-open-label), so Call/Text/
    // Open stay three equally-compact circular buttons on a narrow phone
    // instead of the full-width "Open" pill crowding them — the aria-label
    // keeps it accessible either way, icon-only or with its label visible.
    var openLink = document.createElement('a');
    openLink.className = 'admin-home-row-open';
    openLink.href = row.href;
    openLink.setAttribute('aria-label', 'Open ' + row.name);
    openLink.appendChild(iconArrowRight());
    openLink.appendChild(el('span', 'admin-home-row-open-label', 'Open'));
    actions.appendChild(openLink);
    wrap.appendChild(actions);
    return wrap;
  }

  function renderAttentionList(rows) {
    var listEl = document.getElementById('attention-list');
    var emptyEl = document.getElementById('attention-empty');
    clear(listEl);
    if (!rows.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    rows.slice(0, ATTENTION_ROW_LIMIT).forEach(function (row) {
      listEl.appendChild(buildAttentionRow(row));
    });
  }

  // -----------------------------------------------------------------
  // Quick Actions — New Job / Scan Lead / Other Revenue are plain
  // links to their existing pages. Add Expense mounts the SAME
  // window.AdminQuickExpense module admin/index.html already uses
  // (identical write path, identical UI, just targeted at this page's own
  // container instead of Schedule's #quick-expense-bar) rather than
  // navigating away or rebuilding the flow.
  //
  // Deliberately NOT included: a "+ New Client" action. There is no
  // standalone client-creation page today — Create Client only exists
  // inline inside the client-picker used by New Job/Past Job/Intake
  // confirmation, exactly the same gap "+ New Lead" has (see below) — so
  // rather than link it to something that wouldn't actually create a
  // client, it's left out of this pass.
  // -----------------------------------------------------------------
  var quickExpenseBtn = document.getElementById('qa-add-expense-btn');
  var quickExpenseMount = document.getElementById('home-quick-expense-mount');
  if (quickExpenseBtn && quickExpenseMount) {
    quickExpenseBtn.addEventListener('click', function () {
      var opening = quickExpenseMount.hidden;
      quickExpenseMount.hidden = !opening;
      quickExpenseBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening && window.AdminQuickExpense) {
        var todayIso = new Date().toISOString().slice(0, 10);
        window.AdminQuickExpense.mount(quickExpenseMount, todayIso);
      }
    });
  }

  function render(todayBody, weekBody, intakeBody, leadsBody, expensesBody, otherRevenueBody) {
    var todayJobs = (todayBody && todayBody.jobs) || [];
    var weekJobs = (weekBody && weekBody.jobs) || [];
    var intakes = (intakeBody && intakeBody.intakes) || [];
    var sections = (leadsBody && leadsBody.sections) || {};
    var newMerged = (sections.new || []).concat(sections.websiteRequests || []);
    var waitingOnPhotos = sections.waitingOnPhotos || [];
    var followUp = sections.followUp || [];

    // Today's Jobs
    set('stat-today-jobs', String(todayJobs.length));
    set('stat-today-jobs-sub', todayJobs.length === 1 ? '1 job' : todayJobs.length + ' jobs');

    // Leads Need Attention
    var needsAttentionCount = intakes.length + newMerged.length + waitingOnPhotos.length + followUp.length;
    set('stat-leads-attention', String(needsAttentionCount));
    set('stat-leads-attention-sub', intakes.length + ' intake · ' + newMerged.length + ' new');
    // Deliberately bypasses set()'s empty-string-→-em-dash fallback: a
    // zero count means no badge at all next to the heading, not a stray "—".
    document.getElementById('attention-count').textContent = needsAttentionCount ? '(' + needsAttentionCount + ')' : '';

    // Booked This Week — SUM(estimatedPrice) over booked+rental_out jobs in
    // the week, the exact Schedule/Business-Pulse "Booked" definition. A
    // null weekBody (the week fetch failed) is surfaced honestly as
    // "Unavailable" rather than silently showing $0, which would read as
    // "genuinely nothing booked" instead of "unknown right now".
    var weekKnown = !!weekBody;
    var bookedJobsWeek = weekJobs.filter(function (j) { return j.status === 'booked' || j.status === 'rental_out'; });
    var bookedWeekAmount = bookedJobsWeek.reduce(function (sum, j) { return sum + bookedJobAmount(j); }, 0);
    set('stat-booked-week', weekKnown ? formatMoney(bookedWeekAmount) : '—');
    set('stat-booked-week-sub', weekKnown ? 'This week' : 'Unavailable');

    // Completed (Business Pulse) — a plain job count, not a dollar amount;
    // see this file's header for why.
    var completedJobsWeek = weekJobs.filter(function (j) { return j.status === 'completed'; });
    set('pulse-completed', completedJobsWeek.length === 1 ? '1 job' : completedJobsWeek.length + ' jobs');

    // Revenue This Week — completed-job revenue + Other Revenue, the exact
    // Schedule/Business-Pulse "Revenue" definition. Other Revenue is only
    // ever a known number when its own fetch succeeded (stage 2); a null
    // weekBody or a failed Other Revenue fetch is surfaced honestly rather
    // than silently treated as $0, which would understate Revenue relative
    // to what Schedule itself would show for the same range.
    var completedRevenueWeek = completedJobsWeek.reduce(function (sum, j) { return sum + completedRevenueAmount(j); }, 0);
    var otherRevenueKnown = otherRevenueBody && typeof otherRevenueBody.totalAmount === 'number';
    var otherRevenueWeek = otherRevenueKnown ? otherRevenueBody.totalAmount : 0;
    var revenueWeek = completedRevenueWeek + otherRevenueWeek;
    if (weekKnown) {
      set('stat-revenue-week', formatMoney(revenueWeek));
      set('stat-revenue-week-sub', otherRevenueKnown ? 'This week' : 'This week · partial');
    } else {
      set('stat-revenue-week', '—');
      set('stat-revenue-week-sub', 'Unavailable');
    }

    // Expenses / Net (Business Pulse) — only ever rendered when the
    // expenses fetch actually succeeded; never defaults to $0, which would
    // silently overstate Net.
    var expensesKnown = expensesBody && typeof expensesBody.totalAmount === 'number';
    if (expensesKnown && weekBody) {
      set('pulse-expenses', formatMoneyFixed(expensesBody.totalAmount));
      set('pulse-net', formatMoneyFixed(revenueWeek - expensesBody.totalAmount));
    } else {
      set('pulse-expenses', '—');
      set('pulse-net', '—');
    }

    renderTodaySchedule(todayJobs);

    var attentionRows = intakes
      .map(intakeToRow)
      .concat(newMerged.map(function (item) { return leadItemToRow(item, 'new'); }))
      .concat(waitingOnPhotos.map(function (item) { return leadItemToRow(item, 'waitingOnPhotos'); }))
      .concat(followUp.map(function (item) { return leadItemToRow(item, 'followUp'); }));
    renderAttentionList(attentionRows);

    loadingEl.style.display = 'none';
    bodyEl.style.display = 'block';
  }

  // -----------------------------------------------------------------
  // Fetch — stage 1 (4 independent, already-admin-gated GETs), then stage 2
  // (2 more, dependent on stage 1's week range). A single section failing
  // never blanks the whole dashboard (same partial-failure honesty posture
  // as admin/leads-list.js's own ?view=leads handling) — it just renders
  // with that section empty/unavailable and names it in the error banner.
  // -----------------------------------------------------------------
  var loginRedirected = false;
  function fetchJson(url) {
    return adminFetch(url).then(function (res) {
      if (res.status === 401) {
        loginRedirected = true;
        window.location.href = '/admin/login/';
        return null;
      }
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || 'Request failed.');
        return body;
      });
    });
  }

  var sectionFailures = [];
  function safeFetch(url, label) {
    return fetchJson(url).catch(function () {
      sectionFailures.push(label);
      return null;
    });
  }

  Promise.all([
    safeFetch('/api/admin/bookings?view=schedule&range=today', "Today's schedule"),
    safeFetch('/api/admin/bookings?view=schedule&range=week', "This week's jobs"),
    safeFetch('/api/admin/intake', 'Pending intake'),
    safeFetch('/api/admin/bookings?view=leads', 'Leads'),
  ]).then(function (stage1) {
    if (loginRedirected) return;
    var todayBody = stage1[0], weekBody = stage1[1], intakeBody = stage1[2], leadsBody = stage1[3];

    // Stage 2 depends on the real week startDate/endDate the server just
    // returned — never computed client-side, so it can't drift from what
    // Schedule's own "This Week" query would use for the same range. If
    // the week fetch failed, stage 2 is skipped entirely (see this file's
    // header) rather than guessing a range.
    if (!weekBody || !weekBody.startDate || !weekBody.endDate) {
      render(todayBody, weekBody, intakeBody, leadsBody, null, null);
      if (sectionFailures.length) {
        showError('Some sections failed to load: ' + sectionFailures.join(', ') + '. The rest of the dashboard above is showing correctly.');
      }
      return;
    }

    var qs = 'startDate=' + encodeURIComponent(weekBody.startDate) + '&endDate=' + encodeURIComponent(weekBody.endDate);
    return Promise.all([
      safeFetch('/api/admin/bookings?view=expenses&' + qs, "This week's expenses"),
      safeFetch('/api/admin/bookings?view=other-revenue&' + qs, "This week's other revenue"),
    ]).then(function (stage2) {
      if (loginRedirected) return;
      render(todayBody, weekBody, intakeBody, leadsBody, stage2[0], stage2[1]);
      if (sectionFailures.length) {
        showError('Some sections failed to load: ' + sectionFailures.join(', ') + '. The rest of the dashboard above is showing correctly.');
      }
    });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
