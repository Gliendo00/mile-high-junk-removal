// /admin/home/ — operational-overview dashboard (UI batch). Deliberately
// NOT an analytics page: every number here is either read straight off an
// existing endpoint's response or computed with the exact same formula an
// existing page already uses on that same data (see completedRevenueAmount
// below, a duplicate of admin/schedule-financials.js's own function, same
// per-file-duplication convention this project already follows throughout
// admin/*-list.js/*-detail.js). Nothing here writes anything, and no new
// API endpoint was added for this page — four existing, already-admin-
// authenticated GETs, fetched in parallel:
//   - GET /api/admin/bookings?view=schedule&range=today  (Today's Jobs /
//     Revenue Today / Today's Schedule)
//   - GET /api/admin/bookings?view=schedule&range=week    (Revenue This
//     Week + its sparkline)
//   - GET /api/admin/intake                                (Pending Intake)
//   - GET /api/admin/bookings?view=leads                   (Leads Need
//     Attention / Follow Ups Due / Lead Pipeline / Leads Needing Attention)
//
// "Needs Attention" here is the exact same UI-only bucket union as admin/
// leads-list.js's own Needs Attention sidebar view (Pending Intake + New +
// Waiting on Photos + Follow Up) — duplicated rather than imported, so the
// two pages' counts can never silently drift apart from a shared-module
// refactor gone wrong, matching this project's established convention.
// "New" also merges in website-origin requests (sections.websiteRequests)
// here exactly as it does there: Website Request is a source, not a lead
// stage (see leads-list.js's own header for the full reasoning).
//
// Every dynamic value is written with textContent/DOM construction, never
// innerHTML — same no-innerHTML discipline as every other admin/*.js file.
document.addEventListener('DOMContentLoaded', function () {
  // -----------------------------------------------------------------
  // Sidebar drawer (mobile only — see admin.css's .admin-dash-sidebar).
  // -----------------------------------------------------------------
  var sidebarToggle = document.getElementById('dash-sidebar-toggle');
  var sidebar = document.getElementById('dash-sidebar');
  var sidebarBackdrop = document.getElementById('dash-sidebar-backdrop');
  function openSidebar() {
    sidebar.classList.add('is-open');
    sidebarBackdrop.hidden = false;
    sidebarToggle.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    sidebar.classList.remove('is-open');
    sidebarBackdrop.hidden = true;
    sidebarToggle.setAttribute('aria-expanded', 'false');
  }
  sidebarToggle.addEventListener('click', function () {
    if (sidebar.classList.contains('is-open')) closeSidebar();
    else openSidebar();
  });
  sidebarBackdrop.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSidebar();
  });

  // -----------------------------------------------------------------
  // Greeting — adjusts to the browser's own local time of day (this is a
  // personal greeting, not a business-day boundary, so unlike "today" on
  // Schedule it deliberately does NOT use the server's Denver-local clock).
  // "Junkers" rather than a specific name — more than one person logs into
  // this same admin session (Gerardo's wife included), per explicit
  // request.
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

  function formatPhone(p) {
    return window.formatPhone ? window.formatPhone(p) : p;
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

  // The exact Completed-Revenue rule, duplicated from admin/schedule-
  // financials.js's own completedRevenueAmount() (see that file's header
  // for the full reasoning) — never re-derived differently here.
  function completedRevenueAmount(job) {
    if (job.isComplimentary) return 0;
    var hasFinal = job.finalPrice !== null && job.finalPrice !== undefined && job.finalPrice !== '';
    var amount = Number(hasFinal ? job.finalPrice : job.estimatedPrice);
    return Number.isFinite(amount) ? amount : 0;
  }
  function jobDisplayName(job) {
    return (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client';
  }

  function addDaysIso(iso, days) {
    var parts = iso.split('-').map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
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

  var SOURCE_LABELS = { website: 'Website', screenshot_intake: 'Screenshot Intake', phone: 'Phone', manual: 'Manual' };
  var BUCKET_CHIP_CLASS = {
    pendingIntake: 'admin-lead-bucket-pendingIntake',
    new: 'admin-lead-bucket-new',
    waitingOnPhotos: 'admin-lead-bucket-waitingOnPhotos',
    followUp: 'admin-lead-bucket-followUp',
  };
  var BUCKET_LABELS = { pendingIntake: 'Pending Review', new: 'New', waitingOnPhotos: 'Waiting on Photos', followUp: 'Follow Up' };

  // -----------------------------------------------------------------
  // Today's Schedule — compact rows, up to 6, linking to the canonical
  // booking detail page (same route Schedule's own cards use).
  // -----------------------------------------------------------------
  var SCHEDULE_ROW_LIMIT = 6;
  function buildScheduleRow(job) {
    var row = el('div', 'admin-dash-row');
    var main = document.createElement('a');
    main.className = 'admin-dash-row-main';
    main.href = '/admin/booking/?id=' + encodeURIComponent(job.id);

    var top = el('div', 'admin-dash-row-top');
    top.appendChild(el('span', 'admin-dash-row-time', job.timeLabel || '—'));
    top.appendChild(el('span', 'admin-dash-row-name', jobDisplayName(job)));
    main.appendChild(top);

    var metaParts = [job.serviceLabel || job.serviceType || '—'];
    var city = job.serviceAddress && job.serviceAddress.city;
    if (city) metaParts.push(city);
    main.appendChild(el('div', 'admin-dash-row-meta', metaParts.join(' · ')));
    row.appendChild(main);

    row.appendChild(el('span', 'admin-status-badge admin-status-' + (job.status || 'new'), job.statusLabel || job.status || '—'));

    var actions = el('div', 'admin-dash-row-actions');
    var telHref = buildTelHref(job.customer && job.customer.phone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-dash-row-call';
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
  // + Waiting on Photos + Follow Up, up to 6 rows, each linking to its own
  // canonical detail route (intake / lead / booking, by kind).
  // -----------------------------------------------------------------
  var ATTENTION_ROW_LIMIT = 6;
  function intakeToRow(intake) {
    var name = intake.matchedClientName || intake.extractedClientName || intake.extractedPhone || intake.extractedEmail || 'Unidentified client';
    return {
      href: '/admin/intake/?id=' + encodeURIComponent(intake.id),
      name: name,
      sourceLabel: 'Screenshot Intake',
      bucketKey: 'pendingIntake',
      phone: intake.extractedPhone,
      createdAt: intake.createdAt,
    };
  }
  function leadItemToRow(item, bucketKey) {
    return {
      href: (item.kind === 'booking' ? '/admin/booking/?id=' : '/admin/lead/?id=') + encodeURIComponent(item.id),
      name: item.name || item.phone || 'Unidentified client',
      sourceLabel: SOURCE_LABELS[item.source] || item.source,
      bucketKey: bucketKey,
      phone: item.phone,
      createdAt: item.updatedAt,
    };
  }

  function buildAttentionRow(row) {
    var wrap = el('div', 'admin-dash-row');
    var main = document.createElement('a');
    main.className = 'admin-dash-row-main';
    main.href = row.href;

    main.appendChild(el('div', 'admin-dash-row-name', row.name));
    var metaParts = [];
    if (row.sourceLabel) metaParts.push(row.sourceLabel);
    var age = ageText(row.createdAt);
    if (age) metaParts.push(age);
    main.appendChild(el('div', 'admin-dash-row-meta', metaParts.join(' · ')));
    wrap.appendChild(main);

    wrap.appendChild(el('span', 'admin-status-badge ' + (BUCKET_CHIP_CLASS[row.bucketKey] || 'admin-lead-bucket-new'), BUCKET_LABELS[row.bucketKey] || ''));

    var actions = el('div', 'admin-dash-row-actions');
    var telHref = buildTelHref(row.phone);
    var smsHref = buildSmsHref(row.phone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-dash-row-call';
      callBtn.href = telHref;
      callBtn.setAttribute('aria-label', 'Call ' + row.name);
      callBtn.appendChild(iconPhone());
      actions.appendChild(callBtn);
    }
    if (smsHref) {
      var textBtn = document.createElement('a');
      textBtn.className = 'admin-dash-row-call';
      textBtn.href = smsHref;
      textBtn.setAttribute('aria-label', 'Text ' + row.name);
      textBtn.appendChild(iconText());
      actions.appendChild(textBtn);
    }
    if (actions.childNodes.length) wrap.appendChild(actions);
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
  // Revenue This Week — total + a simple 7-bar sparkline, no charting
  // dependency (per the brief's "without pulling in a heavy new
  // dependency"). Each bar's height is a plain percentage of that week's
  // own highest day; "today" (when it falls in this week) is highlighted.
  // -----------------------------------------------------------------
  function renderSparkline(weekBody) {
    var container = document.getElementById('week-sparkline');
    clear(container);
    if (!weekBody || !weekBody.weekStart) {
      container.appendChild(el('div', 'admin-dash-empty-note', 'No data yet.'));
      return;
    }
    var dayTotals = {};
    (weekBody.jobs || []).forEach(function (job) {
      if (job.status !== 'completed') return;
      dayTotals[job.appointmentDate] = (dayTotals[job.appointmentDate] || 0) + completedRevenueAmount(job);
    });
    var maxVal = 1;
    Object.keys(dayTotals).forEach(function (k) {
      if (dayTotals[k] > maxVal) maxVal = dayTotals[k];
    });
    for (var i = 0; i < 7; i++) {
      var dateIso = addDaysIso(weekBody.weekStart, i);
      var val = dayTotals[dateIso] || 0;
      var bar = el('div', 'admin-dash-sparkline-bar');
      bar.style.height = Math.max(4, Math.round((val / maxVal) * 100)) + '%';
      if (dateIso === weekBody.today) bar.classList.add('is-today');
      bar.title = formatMoney(val);
      container.appendChild(bar);
    }
  }

  // -----------------------------------------------------------------
  // Lead Pipeline — New/Contacted/Estimate Sent/Booked-Won/Lost counts,
  // the exact same bucket counts the Leads sidebar shows.
  // -----------------------------------------------------------------
  function renderPipeline(sections, newMergedCount) {
    var container = document.getElementById('pipeline-list');
    clear(container);
    var rows = [
      { label: 'New', count: newMergedCount, color: '#2f6f13' },
      { label: 'Contacted', count: (sections.contacted || []).length, color: '#b45309' },
      { label: 'Estimate Sent', count: (sections.estimateSent || []).length, color: '#0891b2' },
      { label: 'Booked/Won', count: (sections.bookedWon || []).length, color: '#1d4ed8' },
      { label: 'Lost', count: (sections.lost || []).length, color: '#b91c1c' },
    ];
    rows.forEach(function (r) {
      var row = el('div', 'admin-dash-pipeline-row');
      var labelWrap = el('div', 'admin-dash-pipeline-row-label');
      var dot = el('span', 'admin-dash-pipeline-dot');
      dot.style.background = r.color;
      labelWrap.appendChild(dot);
      labelWrap.appendChild(document.createTextNode(r.label));
      row.appendChild(labelWrap);
      row.appendChild(el('span', 'admin-dash-pipeline-row-count', String(r.count)));
      container.appendChild(row);
    });
  }

  // Pending Intake — the bottom-row panel used in place of a "Recent
  // Activity" feed: there is no single existing data source for a unified
  // cross-entity activity log today (customer_audit_log/booking_audit_log/
  // expense_audit_log are each scoped to one record's own detail page, not
  // a business-wide feed), and building one is explicitly out of scope for
  // this UI batch — see the delivery notes. This panel reuses data this
  // page already fetched for the Leads Need Attention card, so it adds no
  // new query.
  function renderPendingIntakeSummary(intakes) {
    var container = document.getElementById('pending-intake-summary');
    clear(container);
    if (!intakes.length) {
      container.appendChild(el('div', 'admin-dash-empty-note', 'No pending intake right now.'));
      return;
    }
    container.appendChild(el('div', 'admin-dash-pipeline-row', intakes.length === 1 ? '1 screenshot awaiting review' : intakes.length + ' screenshots awaiting review'));
    var link = document.createElement('a');
    link.className = 'admin-tap-link';
    link.href = '/admin/leads/?bucket=pendingIntake';
    link.textContent = 'Review now →';
    container.appendChild(link);
  }

  function render(todayBody, weekBody, intakeBody, leadsBody) {
    var todayJobs = (todayBody && todayBody.jobs) || [];
    var weekJobs = (weekBody && weekBody.jobs) || [];
    var intakes = (intakeBody && intakeBody.intakes) || [];
    var sections = (leadsBody && leadsBody.sections) || {};
    var newMerged = (sections.new || []).concat(sections.websiteRequests || []);
    var waitingOnPhotos = sections.waitingOnPhotos || [];
    var followUp = sections.followUp || [];

    // Today's Jobs
    var todayValue = todayJobs.reduce(function (sum, job) {
      return sum + (job.status === 'completed' ? completedRevenueAmount(job) : Number(job.estimatedPrice) || 0);
    }, 0);
    set('stat-today-jobs', String(todayJobs.length));
    set('stat-today-jobs-sub', todayJobs.length ? formatMoney(todayValue) + ' estimated value' : 'Nothing booked yet');

    // Leads Need Attention
    var needsAttentionCount = intakes.length + newMerged.length + waitingOnPhotos.length + followUp.length;
    set('stat-leads-attention', String(needsAttentionCount));
    set('stat-leads-attention-sub', intakes.length + ' pending intake · ' + newMerged.length + ' new');

    // Revenue Today
    var revenueToday = todayJobs
      .filter(function (j) { return j.status === 'completed'; })
      .reduce(function (sum, j) { return sum + completedRevenueAmount(j); }, 0);
    var revenueWeek = weekJobs
      .filter(function (j) { return j.status === 'completed'; })
      .reduce(function (sum, j) { return sum + completedRevenueAmount(j); }, 0);
    set('stat-revenue-today', formatMoney(revenueToday));
    set('stat-revenue-today-sub', 'This week: ' + formatMoney(revenueWeek));

    // Follow Ups Due
    set('stat-followups', String(followUp.length));
    set('stat-followups-sub', followUp.length === 1 ? '1 lead waiting' : followUp.length + ' leads waiting');

    renderTodaySchedule(todayJobs);

    var attentionRows = intakes
      .map(intakeToRow)
      .concat(newMerged.map(function (item) { return leadItemToRow(item, 'new'); }))
      .concat(waitingOnPhotos.map(function (item) { return leadItemToRow(item, 'waitingOnPhotos'); }))
      .concat(followUp.map(function (item) { return leadItemToRow(item, 'followUp'); }));
    renderAttentionList(attentionRows);

    set('week-revenue-total', formatMoney(revenueWeek));
    renderSparkline(weekBody);
    renderPipeline(sections, newMerged.length);
    renderPendingIntakeSummary(intakes);

    loadingEl.style.display = 'none';
    bodyEl.style.display = 'block';
  }

  // -----------------------------------------------------------------
  // Fetch — 4 independent, already-admin-gated GETs. A single section
  // failing never blanks the whole dashboard (same partial-failure
  // honesty posture as admin/leads-list.js's own ?view=leads handling) —
  // it just renders with that section empty and names it in the error
  // banner.
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
    safeFetch('/api/admin/bookings?view=schedule&range=week', "This week's revenue"),
    safeFetch('/api/admin/intake', 'Pending intake'),
    safeFetch('/api/admin/bookings?view=leads', 'Leads'),
  ]).then(function (results) {
    if (loginRedirected) return;
    render(results[0], results[1], results[2], results[3]);
    if (sectionFailures.length) {
      showError('Some sections failed to load: ' + sectionFailures.join(', ') + '. The rest of the dashboard above is showing correctly.');
    }
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
