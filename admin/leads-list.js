// /admin/leads — the Leads workspace shell (Batch 6, Leads consolidation).
// Assembles 9 sections from TWO existing, unchanged read-only endpoints:
//   - GET /api/admin/intake (default, status=pending_review) -> Pending
//     Intake. The exact same endpoint/shape admin/intakes-list.js already
//     renders — this file duplicates its name-fallback priority
//     (matchedClientName -> extractedClientName -> phone -> email ->
//     "Unidentified client") rather than importing it, matching this
//     project's established small-per-file-helper convention.
//   - GET /api/admin/bookings?view=leads -> the other 8 sections, a
//     READ-ONLY merge of website-origin `bookings` rows and the new
//     `leads` table (not yet migrated anywhere) — see that endpoint's own
//     header comment in api/admin/bookings.js for the full contract.
//
// Neither fetch writes anything.
//
// Follow-up (same batch, still Batch 6) — sub-tabs/pills: exactly ONE of
// the 9 sections is shown at a time, selected via the horizontally-
// scrollable .admin-leads-tabs row. Every section's data is still fetched
// and rendered up front (so switching tabs is instant, no re-fetch); only
// VISIBILITY is tab-driven. Default-selection cascade is simply "first
// non-empty bucket in SECTION_ORDER" — which, given that order, already
// satisfies every rule asked for: Pending Intake first, then Website
// Requests, then the active-lead-pipeline buckets (new through
// followUp), with Booked/Won and Lost last — so they only ever become
// the default when everything ahead of them is empty. If literally every
// bucket is empty, the first tab (Pending Intake) is still selected, just
// showing its own empty state.
//
// Every dynamic value below is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string) — same discipline as
// every other admin/*-list.js file in this project.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var sectionsEl = document.getElementById('leads-sections');
  var tabsEl = document.getElementById('leads-tabs');
  var tabsPrevBtn = document.getElementById('leads-tabs-prev');
  var tabsNextBtn = document.getElementById('leads-tabs-next');
  var logoutBtn = document.getElementById('logout-btn');

  // Fixed tab order — see the header comment above for why this single
  // array is also the entire default-selection rule.
  var SECTION_ORDER = ['pendingIntake', 'websiteRequests', 'new', 'contacted', 'waitingOnPhotos', 'estimateSent', 'followUp', 'bookedWon', 'lost'];

  var SOURCE_LABELS = {
    website: 'Website',
    screenshot_intake: 'Screenshot Intake',
    phone: 'Phone',
    manual: 'Manual',
  };

  var INTAKE_CLASSIFICATION_TEXT = {
    lead_only: 'Lead',
    quote_discussion: 'Quote Discussion',
    booking_confirmed: 'Booking Confirmed',
    follow_up: 'Follow-Up',
    existing_job_update: 'Existing Job Update',
    unclear: 'Unclear',
  };

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Small stroke-icon helper — built via SVG DOM APIs (createElementNS),
  // never innerHTML, so this file's "no innerHTML" discipline (see header
  // comment) holds even for these static, non-user-supplied glyphs.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(shapes) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
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
  function iconMapPin() {
    return svgIcon([
      { tag: 'path', attrs: { d: 'M12 21 C12 21 5 13.5 5 9 C5 5.1 8.1 2 12 2 C15.9 2 19 5.1 19 9 C19 13.5 12 21 12 21 Z' } },
      { tag: 'circle', attrs: { cx: '12', cy: '9', r: '2', fill: 'currentColor', stroke: 'none' } },
    ]);
  }
  function iconCalendar() {
    return svgIcon([
      { tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '16', rx: '2' } },
      { tag: 'line', attrs: { x1: '3', y1: '10', x2: '21', y2: '10' } },
      { tag: 'line', attrs: { x1: '8', y1: '2', x2: '8', y2: '6' } },
      { tag: 'line', attrs: { x1: '16', y1: '2', x2: '16', y2: '6' } },
    ]);
  }

  // Same safe digit-only tel: normalization as admin/booking-detail.js's
  // buildTelHref — duplicated rather than imported, matching this
  // project's established per-file convention (see this file's own header
  // comment re: renderIntakeCard above).
  function buildTelHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'tel:+1' + digits : 'tel:+' + digits;
  }

  function metadataItem(iconNode, text) {
    var item = el('span', 'admin-metadata-item');
    item.appendChild(iconNode);
    item.appendChild(el('span', null, text));
    return item;
  }

  function formatWhen(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return iso;
    }
  }

  function formatFollowUp(dateStr) {
    if (!dateStr) return '';
    try {
      // dateStr is a plain YYYY-MM-DD (no time component) — parsed as
      // UTC-midnight and displayed as a calendar date only, same treatment
      // every other plain-date field in this admin app already gets.
      var d = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(d.getTime())) return 'Follow up ' + dateStr;
      return 'Follow up ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (e) {
      return 'Follow up ' + dateStr;
    }
  }

  // Shared card renderer for every section except Pending Intake (which has
  // its own shape — see renderIntakeCard below). `item` is one entry from
  // GET /api/admin/bookings?view=leads's sections.*, already carrying
  // {id, kind, source, name, phone, serviceLabel, city, statusLabel,
  // updatedAt, nextFollowUpDate}.
  function renderLeadCard(item) {
    var li = document.createElement('li');
    var card = el('div', 'admin-booking-card admin-lead-card');

    // A website booking already has a real detail page; a leads-table row
    // doesn't yet (Lead -> Booking conversion, and a lead detail screen,
    // are both out of scope for this batch) — so only booking-kind cards'
    // main area is a link; a lead-kind card's is a plain non-interactive
    // div instead (same information, just not yet clickable).
    var main = item.kind === 'booking' ? document.createElement('a') : document.createElement('div');
    main.className = 'admin-lead-card-main';
    if (item.kind === 'booking') main.href = '/admin/booking/?id=' + encodeURIComponent(item.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-source-badge admin-source-badge-' + item.source, SOURCE_LABELS[item.source] || item.source));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-card-timeago', formatWhen(item.updatedAt)));
    main.appendChild(top);

    main.appendChild(el('div', 'admin-card-name', item.name || item.phone || 'Unidentified client'));
    main.appendChild(el('div', 'admin-card-service', item.serviceLabel || '—'));

    var metaRow = el('div', 'admin-metadata-row');
    if (item.phone) metaRow.appendChild(metadataItem(iconPhone(), item.phone));
    if (item.city) metaRow.appendChild(metadataItem(iconMapPin(), item.city));
    if (metaRow.childNodes.length) main.appendChild(metaRow);

    var followUpText = formatFollowUp(item.nextFollowUpDate);
    if (followUpText) {
      var followRow = el('div', 'admin-lead-card-followup');
      followRow.appendChild(iconCalendar());
      followRow.appendChild(document.createTextNode(followUpText));
      main.appendChild(followRow);
    }

    card.appendChild(main);

    var actions = el('div', 'admin-lead-card-actions');
    actions.appendChild(el('span', 'admin-lead-card-status', item.statusLabel || ''));
    var telHref = buildTelHref(item.phone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-btn admin-btn-primary admin-lead-card-call';
      callBtn.href = telHref;
      callBtn.textContent = 'Call';
      actions.appendChild(callBtn);
    }
    card.appendChild(actions);

    li.appendChild(card);
    return li;
  }

  // Pending Intake card — same name-fallback priority and shape as
  // admin/intakes-list.js's own renderIntakeCard(), duplicated rather than
  // imported (this project's established per-file convention). Source is
  // always "Screenshot Intake" here: every row GET /api/admin/intake
  // returns is, by definition, a raw screenshot upload.
  function renderIntakeCard(intake) {
    var li = document.createElement('li');
    var card = el('div', 'admin-booking-card admin-lead-card');

    var main = document.createElement('a');
    main.className = 'admin-lead-card-main';
    main.href = '/admin/intake/?id=' + encodeURIComponent(intake.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-source-badge admin-source-badge-screenshot_intake', 'Screenshot Intake'));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-card-timeago', formatWhen(intake.createdAt)));
    main.appendChild(top);

    var title = intake.matchedClientName || intake.extractedClientName || intake.extractedPhone || intake.extractedEmail || 'Unidentified client';
    main.appendChild(el('div', 'admin-card-name', title));

    var classificationText = INTAKE_CLASSIFICATION_TEXT[intake.classification] || 'Unclassified';
    if (intake.extractedServiceType) classificationText += ' · ' + intake.extractedServiceType;
    main.appendChild(el('div', 'admin-card-service', classificationText));

    if (intake.extractedPhone) {
      var metaRow = el('div', 'admin-metadata-row');
      metaRow.appendChild(metadataItem(iconPhone(), intake.extractedPhone));
      main.appendChild(metaRow);
    }

    card.appendChild(main);

    var actions = el('div', 'admin-lead-card-actions');
    actions.appendChild(el('span', 'admin-lead-card-status', 'Pending Review'));
    var telHref = buildTelHref(intake.extractedPhone);
    if (telHref) {
      var callBtn = document.createElement('a');
      callBtn.className = 'admin-btn admin-btn-primary admin-lead-card-call';
      callBtn.href = telHref;
      callBtn.textContent = 'Call';
      actions.appendChild(callBtn);
    } else {
      var reviewLink = document.createElement('a');
      reviewLink.className = 'admin-card-view';
      reviewLink.href = main.href;
      reviewLink.textContent = 'Review →';
      actions.appendChild(reviewLink);
    }
    card.appendChild(actions);

    li.appendChild(card);
    return li;
  }

  var counts = {}; // key -> item count, filled in as each section renders

  // Renders a section's cards (or a small inline empty notice) and its
  // tab's count badge. Visibility is handled separately by selectBucket()
  // — this never shows/hides the section itself.
  function renderSection(key, items, renderFn) {
    var listEl = document.getElementById('list-' + key);
    var countBadge = document.getElementById('tab-count-' + key);
    var n = items ? items.length : 0;
    counts[key] = n;

    if (n > 0) {
      countBadge.textContent = n > 99 ? '99+' : String(n);
      countBadge.hidden = false;
      items.forEach(function (item) {
        listEl.appendChild(renderFn(item));
      });
    } else {
      countBadge.hidden = true;
      // Reuses .admin-empty's existing dashed-box styling (defined for
      // the page-level #empty banner) rather than a new class — same
      // look, just scoped to one bucket's own content area.
      listEl.appendChild(el('li', 'admin-empty', 'Nothing here yet.'));
    }
  }

  // Tab slider — desktop left/right controls wrapping the existing
  // horizontally-scrollable .admin-leads-tabs row (admin.css's
  // .admin-leads-tabs-row). Arrows are plain scroll-by-a-page buttons, not
  // a carousel with discrete "pages" of tabs — simplest correct behavior
  // for a row whose items have very different widths ("New" vs. "Waiting
  // on Photos"). Each arrow's `hidden` attribute reflects whether there's
  // actually more content in that direction right now, recomputed on every
  // scroll/resize so it never shows a dead-end arrow.
  function updateTabArrows() {
    var maxScroll = tabsEl.scrollWidth - tabsEl.clientWidth;
    // Sub-pixel rounding from zoom/fractional scaling can leave scrollLeft
    // a hair short of 0 or maxScroll — 1px tolerance avoids a flickering
    // arrow that never quite reaches hidden.
    tabsPrevBtn.hidden = tabsEl.scrollLeft <= 1;
    tabsNextBtn.hidden = tabsEl.scrollLeft >= maxScroll - 1;
  }

  function scrollTabsBy(delta) {
    tabsEl.scrollBy({ left: delta, behavior: 'smooth' });
  }

  tabsPrevBtn.addEventListener('click', function () { scrollTabsBy(-160); });
  tabsNextBtn.addEventListener('click', function () { scrollTabsBy(160); });
  tabsEl.addEventListener('scroll', updateTabArrows);
  window.addEventListener('resize', updateTabArrows);

  // A plain vertical mouse wheel (no shift, no trackpad's native horizontal
  // delta) over the tab row scrolls it horizontally instead of doing
  // nothing — trackpad/touch horizontal scrolling already works natively
  // via the row's own overflow-x and needs no help here.
  tabsEl.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // already a horizontal gesture
    tabsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  function scrollActiveTabIntoView(key) {
    var tabEl = tabsEl.querySelector('[data-bucket="' + key + '"]');
    if (!tabEl) return;
    var tabsRect = tabsEl.getBoundingClientRect();
    var tabRect = tabEl.getBoundingClientRect();
    if (tabRect.left < tabsRect.left || tabRect.right > tabsRect.right) {
      tabEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  // Exactly one bucket visible at a time: unhide the selected section (and
  // hide every other), mark its tab .is-active, clear the rest.
  function selectBucket(key) {
    SECTION_ORDER.forEach(function (k) {
      var sectionEl = document.getElementById('section-' + k);
      var tabEl = tabsEl.querySelector('[data-bucket="' + k + '"]');
      sectionEl.hidden = k !== key;
      if (tabEl) {
        tabEl.classList.toggle('is-active', k === key);
        tabEl.setAttribute('aria-selected', k === key ? 'true' : 'false');
      }
    });
    scrollActiveTabIntoView(key);
  }

  function defaultBucket() {
    for (var i = 0; i < SECTION_ORDER.length; i++) {
      if (counts[SECTION_ORDER[i]] > 0) return SECTION_ORDER[i];
    }
    return SECTION_ORDER[0]; // every bucket empty — still land on Pending Intake
  }

  function finish() {
    loadingEl.style.display = 'none';
    sectionsEl.style.display = 'block';
    var total = SECTION_ORDER.reduce(function (sum, k) { return sum + (counts[k] || 0); }, 0);
    emptyEl.style.display = total === 0 ? 'block' : 'none';
    selectBucket(defaultBucket());
    // Only meaningful once the row is actually laid out (it was
    // display:none until sectionsEl.style.display = 'block' just above) —
    // no 'scroll' event fires for a display-toggle to trigger this itself.
    updateTabArrows();
  }

  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.admin-leads-tab') : null;
    if (!btn) return;
    selectBucket(btn.getAttribute('data-bucket'));
  });

  Promise.all([
    adminFetch('/api/admin/intake').then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load Pending Intake.');
          return body;
        });
    }),
    adminFetch('/api/admin/bookings?view=leads').then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load leads.');
          return body;
        });
    }),
  ])
    .then(function (results) {
      var intakeBody = results[0];
      var leadsBody = results[1];
      if (!intakeBody || !leadsBody) return; // one of the two redirected to login

      renderSection('pendingIntake', intakeBody.intakes, renderIntakeCard);
      var sections = leadsBody.sections || {};
      renderSection('websiteRequests', sections.websiteRequests, renderLeadCard);
      renderSection('new', sections.new, renderLeadCard);
      renderSection('contacted', sections.contacted, renderLeadCard);
      renderSection('waitingOnPhotos', sections.waitingOnPhotos, renderLeadCard);
      renderSection('estimateSent', sections.estimateSent, renderLeadCard);
      renderSection('followUp', sections.followUp, renderLeadCard);
      renderSection('bookedWon', sections.bookedWon, renderLeadCard);
      renderSection('lost', sections.lost, renderLeadCard);

      finish();

      // Partial-failure honesty (Preview QA finding, 2026-10): api/admin/
      // bookings.js's ?view=leads now degrades per-query rather than
      // failing the whole response — every section backed by a query that
      // DID succeed is rendered above exactly as always. This just makes
      // sure a section that failed is never silently indistinguishable
      // from "genuinely empty" — the empty-state message above would
      // otherwise read as "nothing waiting" when something actually
      // failed to load.
      if (leadsBody.sectionErrors && leadsBody.sectionErrors.length) {
        showError('Some sections failed to load: ' + leadsBody.sectionErrors.join(', ') + '. Other sections above are showing correctly.');
      }
    })
    .catch(function (err) {
      loadingEl.style.display = 'none';
      showError(err && err.message ? err.message : 'Could not load leads.');
    });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
