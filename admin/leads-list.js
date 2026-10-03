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
    // A website booking already has a real detail page; a leads-table row
    // doesn't yet (Lead -> Booking conversion, and a lead detail screen,
    // are both out of scope for this batch) — so only booking-kind cards
    // are links for now.
    var card = item.kind === 'booking' ? document.createElement('a') : document.createElement('div');
    card.className = 'admin-booking-card';
    if (item.kind === 'booking') card.href = '/admin/booking/?id=' + encodeURIComponent(item.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-source-badge admin-source-badge-' + item.source, SOURCE_LABELS[item.source] || item.source));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-card-timeago', formatWhen(item.updatedAt)));
    card.appendChild(top);

    card.appendChild(el('div', 'admin-card-name', item.name || item.phone || 'Unidentified client'));

    var serviceParts = [item.serviceLabel || '—'];
    if (item.city) serviceParts.push(item.city);
    card.appendChild(el('div', 'admin-card-service', serviceParts.join(' · ')));

    if (item.phone) card.appendChild(el('div', 'admin-card-when', item.phone));

    var footer = el('div', 'admin-card-footer');
    footer.appendChild(el('span', null, item.statusLabel || ''));
    footer.appendChild(el('span', null, formatFollowUp(item.nextFollowUpDate)));
    card.appendChild(footer);

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
    var a = document.createElement('a');
    a.className = 'admin-booking-card';
    a.href = '/admin/intake/?id=' + encodeURIComponent(intake.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-source-badge admin-source-badge-screenshot_intake', 'Screenshot Intake'));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-card-timeago', formatWhen(intake.createdAt)));
    a.appendChild(top);

    var title = intake.matchedClientName || intake.extractedClientName || intake.extractedPhone || intake.extractedEmail || 'Unidentified client';
    a.appendChild(el('div', 'admin-card-name', title));

    var classificationText = INTAKE_CLASSIFICATION_TEXT[intake.classification] || 'Unclassified';
    if (intake.extractedServiceType) classificationText += ' · ' + intake.extractedServiceType;
    a.appendChild(el('div', 'admin-card-service', classificationText));

    if (intake.extractedPhone) a.appendChild(el('div', 'admin-card-when', intake.extractedPhone));

    var footer = el('div', 'admin-card-footer');
    footer.appendChild(el('span', null, 'Pending Review'));
    footer.appendChild(el('span', 'admin-card-view', 'Review →'));
    a.appendChild(footer);

    li.appendChild(a);
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
