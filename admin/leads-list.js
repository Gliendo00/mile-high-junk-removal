// /admin/leads — the Leads workspace shell. Assembles sections from TWO
// existing, unchanged read-only endpoints:
//   - GET /api/admin/intake (default, status=pending_review) -> Pending
//     Intake. The exact same endpoint/shape admin/intakes-list.js already
//     renders — this file duplicates its name-fallback priority
//     (matchedClientName -> extractedClientName -> phone -> email ->
//     "Unidentified client") rather than importing it, matching this
//     project's established small-per-file-helper convention.
//   - GET /api/admin/bookings?view=leads -> the other 8 sections, a
//     READ-ONLY merge of website-origin `bookings` rows and the `leads`
//     table (screenshot-intake/phone/manual leads) — see that endpoint's
//     own header comment in api/admin/bookings.js for the full contract.
//
// Neither fetch writes anything.
//
// UI batch (Leads sidebar redesign): the old horizontal 9-pill tab row is
// replaced by a dark sidebar (shared layout with /admin/home/ — see
// admin.css's .admin-dash-* rules; this file wires its own mobile-drawer
// toggle independently rather than sharing a script with admin/home.js,
// matching this project's established per-file-duplication convention).
// Two structural changes to the bucket model itself, both UI-only (no new
// database status, see api/admin/bookings.js — completely unchanged):
//   1. "Website Requests" is no longer its own sidebar destination —
//      Website Request is a SOURCE (like Screenshot Intake/Phone/Manual),
//      not a lead stage, so its items are folded into the "New" bucket
//      here (merged client-side with the existing sections.new) and shown
//      via the same source badge every other card already has.
//   2. "Needs Attention" is a new smart combined view — Pending Intake +
//      New + Waiting on Photos + Follow Up, rendered side by side under
//      small group labels. Purely a different arrangement of the exact
//      same items the 4 individual buckets already show; selecting it
//      never changes what's fetched or how any other bucket renders.
//
// UI batch (lead-detail navigation fix): a lead-kind card's main area used
// to be a plain non-interactive <div> (no detail page existed for a
// `leads` table row). It is now a real link to the new canonical
// /admin/lead/?id= route (see admin/lead-detail.js + api/admin/lead.js's
// new GET), exactly like a booking-kind card already links to
// /admin/booking/?id=.
//
// Every dynamic value below is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string) — same discipline as
// every other admin/*-list.js file in this project.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var sectionsEl = document.getElementById('leads-sections');
  var logoutBtn = document.getElementById('logout-btn');
  var searchInput = document.getElementById('leads-search');
  var totalCountEl = document.getElementById('leads-total-count');

  // -----------------------------------------------------------------
  // Sidebar drawer (mobile only — see admin.css's .admin-dash-sidebar).
  // Duplicated from admin/home.js rather than shared — see this file's
  // header.
  // -----------------------------------------------------------------
  var sidebarToggle = document.getElementById('dash-sidebar-toggle');
  var sidebarToggleLabel = document.getElementById('dash-sidebar-toggle-label');
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

  // Fixed sidebar order — also the entire default-selection cascade (see
  // defaultBucket() below): "Needs Attention" first (it's the smart view
  // combining the 4 most actionable buckets), then Pending Intake, then
  // the active-lead-pipeline buckets (New through Follow Up), with
  // Booked/Won and Lost last.
  var SECTION_ORDER = ['needsAttention', 'pendingIntake', 'new', 'contacted', 'waitingOnPhotos', 'estimateSent', 'followUp', 'bookedWon', 'lost'];
  var NEEDS_ATTENTION_KEYS = ['pendingIntake', 'new', 'waitingOnPhotos', 'followUp'];

  var BUCKET_LABELS = {
    needsAttention: 'Needs Attention',
    pendingIntake: 'Pending Intake',
    new: 'New',
    contacted: 'Contacted',
    waitingOnPhotos: 'Waiting on Photos',
    estimateSent: 'Estimate Sent',
    followUp: 'Follow Up',
    bookedWon: 'Booked/Won',
    lost: 'Lost',
  };
  var bucketHeaderLabel = document.getElementById('bucket-section-header-label');
  var bucketHeaderCount = document.getElementById('bucket-section-header-count');

  // Maps each Leads bucket (not a `bookings.status` value) to its own chip
  // color, via admin.css's .admin-lead-bucket-* classes.
  var BUCKET_CHIP_CLASS = {
    pendingIntake: 'admin-lead-bucket-pendingIntake',
    new: 'admin-lead-bucket-new',
    contacted: 'admin-lead-bucket-contacted',
    waitingOnPhotos: 'admin-lead-bucket-waitingOnPhotos',
    estimateSent: 'admin-lead-bucket-estimateSent',
    followUp: 'admin-lead-bucket-followUp',
    bookedWon: 'admin-lead-bucket-bookedWon',
    lost: 'admin-lead-bucket-lost',
  };

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
  // project's established per-file convention.
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

  // Shared card renderer for every bucket except Pending Intake (which has
  // its own shape — see renderIntakeCard below). `item` is one entry from
  // GET /api/admin/bookings?view=leads's sections.*, already carrying
  // {id, kind, source, name, phone, serviceLabel, city, statusLabel,
  // updatedAt, nextFollowUpDate}. `kind` ('booking' or 'lead') decides the
  // canonical detail route — UI batch (lead-detail navigation fix): both
  // kinds are clickable now, the main link just points at a different
  // route depending on which table the row actually lives in.
  function renderLeadCard(item, bucketKey) {
    var li = document.createElement('li');
    var card = el('div', 'admin-booking-card admin-lead-card');

    var main = document.createElement('a');
    main.className = 'admin-lead-card-main';
    main.href = item.kind === 'booking' ? '/admin/booking/?id=' + encodeURIComponent(item.id) : '/admin/lead/?id=' + encodeURIComponent(item.id);

    // Exactly 2 chips, never more: source + status.
    var top = el('div', 'admin-card-top admin-lead-card-chips');
    top.appendChild(el('span', 'admin-source-badge admin-source-badge-' + item.source, SOURCE_LABELS[item.source] || item.source));
    var statusChipClass = BUCKET_CHIP_CLASS[bucketKey] || 'admin-lead-bucket-new';
    top.appendChild(el('span', 'admin-status-badge ' + statusChipClass, item.statusLabel || BUCKET_LABELS[bucketKey] || ''));
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

    // One quiet secondary link + one clear primary action — status is
    // already shown as a chip above, not repeated here.
    var actions = el('div', 'admin-lead-card-actions');
    var viewLink = document.createElement('a');
    viewLink.className = 'admin-card-view admin-lead-card-view';
    viewLink.href = main.href;
    viewLink.textContent = 'View details';
    actions.appendChild(viewLink);
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

    var top = el('div', 'admin-card-top admin-lead-card-chips');
    top.appendChild(el('span', 'admin-source-badge admin-source-badge-screenshot_intake', 'Screenshot Intake'));
    top.appendChild(el('span', 'admin-status-badge admin-lead-bucket-pendingIntake', 'Pending Review'));
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
    var telHref = buildTelHref(intake.extractedPhone);
    if (telHref) {
      var reviewLink2 = document.createElement('a');
      reviewLink2.className = 'admin-card-view admin-lead-card-view';
      reviewLink2.href = main.href;
      reviewLink2.textContent = 'Review';
      actions.appendChild(reviewLink2);
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

  // key -> item count. key -> raw items array (kept so Needs Attention and
  // the search filter can both re-derive from the same source data rather
  // than re-reading already-rendered DOM).
  var counts = {};
  var itemsByBucket = {};

  // Renders a bucket's cards (or a small inline empty notice) and its
  // sidebar count badge. Visibility is handled separately by selectBucket()
  // — this never shows/hides the section itself.
  function renderSection(key, items, renderFn) {
    var listEl = document.getElementById('list-' + key);
    var countBadge = document.getElementById('sidebar-count-' + key);
    var n = items ? items.length : 0;
    counts[key] = n;
    itemsByBucket[key] = items || [];

    if (n > 0) {
      countBadge.textContent = n > 99 ? '99+' : String(n);
      countBadge.hidden = false;
      items.forEach(function (item) {
        listEl.appendChild(renderFn(item, key));
      });
    } else {
      countBadge.hidden = true;
      listEl.appendChild(el('li', 'admin-empty', 'Nothing here yet.'));
    }
  }

  // Needs Attention — a composite view, built directly from the same
  // source arrays each individual bucket already rendered from (never from
  // cloned/queried DOM, so it can never disagree with what those buckets
  // themselves show). Grouped under small labels rather than one flat list
  // so it's still obvious which stage each card is actually in.
  var NEEDS_ATTENTION_GROUP_LABELS = { pendingIntake: 'Pending Intake', new: 'New', waitingOnPhotos: 'Waiting on Photos', followUp: 'Follow Up' };
  function renderNeedsAttention() {
    var container = document.getElementById('section-needsAttention');
    while (container.firstChild) container.removeChild(container.firstChild);

    var total = 0;
    NEEDS_ATTENTION_KEYS.forEach(function (key) {
      var items = itemsByBucket[key] || [];
      total += items.length;
    });
    counts.needsAttention = total;

    var badge = document.getElementById('sidebar-count-needsAttention');
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }

    if (!total) {
      container.appendChild(el('div', 'admin-empty', 'Nothing needs attention right now.'));
      return;
    }

    NEEDS_ATTENTION_KEYS.forEach(function (key) {
      var items = itemsByBucket[key] || [];
      if (!items.length) return;
      var group = el('div', 'admin-leads-needs-attention-group');
      group.appendChild(el('div', 'admin-leads-needs-attention-group-label', NEEDS_ATTENTION_GROUP_LABELS[key] + ' (' + items.length + ')'));
      var ul = el('ul', 'admin-booking-list admin-leads-grid');
      items.forEach(function (item) {
        ul.appendChild(key === 'pendingIntake' ? renderIntakeCard(item) : renderLeadCard(item, key));
      });
      group.appendChild(ul);
      container.appendChild(group);
    });
  }

  // Exactly one bucket visible at a time: unhide the selected section (and
  // hide every other), mark its sidebar item active, clear the rest.
  function selectBucket(key) {
    SECTION_ORDER.forEach(function (k) {
      var sectionEl = document.getElementById('section-' + k);
      var navEl = sidebar.querySelector('[data-bucket="' + k + '"]');
      sectionEl.hidden = k !== key;
      if (navEl) {
        navEl.classList.toggle('is-active', k === key);
        navEl.setAttribute('aria-selected', k === key ? 'true' : 'false');
      }
    });
    bucketHeaderLabel.textContent = BUCKET_LABELS[key] || key;
    bucketHeaderCount.textContent = counts[key] ? String(counts[key]) : '';
    sidebarToggleLabel.textContent = BUCKET_LABELS[key] || key;
    // A bucket switch always starts from a clean, unfiltered view of the
    // newly-selected section rather than silently carrying over a filter
    // typed for a different bucket.
    if (searchInput.value) {
      searchInput.value = '';
    }
    applySearchFilter('');
    closeSidebar();
  }

  function defaultBucket() {
    for (var i = 0; i < SECTION_ORDER.length; i++) {
      if (counts[SECTION_ORDER[i]] > 0) return SECTION_ORDER[i];
    }
    return SECTION_ORDER[0]; // every bucket empty — still land on Needs Attention
  }

  // Stage 5D — Confirm Booking/Confirm as Lead redirects here with
  // ?bucket=new (etc.) so the admin lands on the bucket their just-created
  // lead actually appears in, instead of the generic non-empty-bucket
  // default. Any other/missing value is silently ignored (falls through to
  // defaultBucket()) rather than erroring — this is a convenience only.
  function requestedBucket() {
    var requested = new URLSearchParams(window.location.search).get('bucket');
    return requested && SECTION_ORDER.indexOf(requested) !== -1 ? requested : null;
  }

  // Client-side, name/phone-only filter over whichever section is
  // currently visible — never a server round-trip, never changes which
  // bucket is selected. Matches against the card's own name/phone text
  // nodes (.admin-card-name / .admin-metadata-item), so it works the same
  // way for every bucket's cards, Needs Attention's grouped clones
  // included (they're just more renderLeadCard()/renderIntakeCard() output,
  // same markup).
  function applySearchFilter(term) {
    var normalized = term.trim().toLowerCase();
    var activeKey = SECTION_ORDER.filter(function (k) {
      var sectionEl = document.getElementById('section-' + k);
      return sectionEl && !sectionEl.hidden;
    })[0];
    if (!activeKey) return;
    var container = document.getElementById('section-' + activeKey);
    var cards = container.querySelectorAll('li');
    cards.forEach(function (li) {
      if (!normalized) {
        li.hidden = false;
        return;
      }
      var nameEl = li.querySelector('.admin-card-name');
      var phoneEl = li.querySelector('.admin-metadata-item');
      var haystack = ((nameEl ? nameEl.textContent : '') + ' ' + (phoneEl ? phoneEl.textContent : '')).toLowerCase();
      li.hidden = haystack.indexOf(normalized) === -1;
    });
  }
  searchInput.addEventListener('input', function () {
    applySearchFilter(searchInput.value);
  });

  function finish() {
    loadingEl.style.display = 'none';
    sectionsEl.style.display = 'block';
    renderNeedsAttention();
    var total = NEEDS_ATTENTION_KEYS.concat(['contacted', 'estimateSent', 'bookedWon', 'lost']).reduce(function (sum, k) {
      return sum + (counts[k] || 0);
    }, 0);
    emptyEl.style.display = total === 0 ? 'block' : 'none';
    totalCountEl.textContent = total === 0 ? '' : total + (total === 1 ? ' lead' : ' leads');
    selectBucket(requestedBucket() || defaultBucket());
  }

  sidebar.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-bucket]') : null;
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
      // "New" merges the lead-table new rows with website-origin requests
      // — Website Request is a source, not a stage (see this file's
      // header); the merge is a plain array concat, each item keeps its
      // own real id/kind/source, so it still opens via the correct
      // canonical route.
      renderSection('new', (sections.new || []).concat(sections.websiteRequests || []), renderLeadCard);
      renderSection('contacted', sections.contacted, renderLeadCard);
      renderSection('waitingOnPhotos', sections.waitingOnPhotos, renderLeadCard);
      renderSection('estimateSent', sections.estimateSent, renderLeadCard);
      renderSection('followUp', sections.followUp, renderLeadCard);
      renderSection('bookedWon', sections.bookedWon, renderLeadCard);
      renderSection('lost', sections.lost, renderLeadCard);

      finish();

      // Partial-failure honesty (Preview QA finding, 2026-10): api/admin/
      // bookings.js's ?view=leads degrades per-query rather than failing
      // the whole response — every section backed by a query that DID
      // succeed is rendered above exactly as always. This just makes sure
      // a section that failed is never silently indistinguishable from
      // "genuinely empty."
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
