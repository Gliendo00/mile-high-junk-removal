// /admin — Schedule homepage (Phase 3C Stage 1): Today/Tomorrow/Week views
// of booked/completed jobs, ordered chronologically.
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

  var currentRange = 'today';
  var requestSeq = 0; // guards against an in-flight request resolving after a newer range change

  var EMPTY_MESSAGES = {
    today: 'No jobs scheduled for today.',
    tomorrow: 'No jobs scheduled for tomorrow.',
    week: 'No jobs scheduled for the next 7 days.',
  };

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function formatDayHeading(iso) {
    if (!iso) return '';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
    topLeft.appendChild(el('span', 'admin-card-when', job.timeWindowLabel || '—'));
    top.appendChild(topLeft);
    top.appendChild(el('span', 'admin-status-badge admin-status-' + job.status, job.statusLabel || 'Booked'));
    main.appendChild(top);

    main.appendChild(el('div', 'admin-card-name', (job.customer ? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client'));

    var serviceCityParts = [job.serviceLabel || job.serviceType || '—'];
    if (job.serviceAddress && job.serviceAddress.city) serviceCityParts.push(job.serviceAddress.city);
    main.appendChild(el('div', 'admin-card-service', serviceCityParts.join(' · ')));

    var priceText = formatPrice(job.estimatedPrice);
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

    // Week view groups cards under a day heading (the date isn't otherwise
    // shown on a Today/Tomorrow view, where it's implied by the selected
    // tab). Jobs already arrive sorted chronologically from the API.
    var lastDate = null;
    jobs.forEach(function (job) {
      if (currentRange === 'week' && job.appointmentDate !== lastDate) {
        lastDate = job.appointmentDate;
        var headingLi = document.createElement('li');
        headingLi.className = 'admin-schedule-day-heading';
        headingLi.textContent = formatDayHeading(job.appointmentDate);
        listEl.appendChild(headingLi);
      }
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

  function load(range) {
    currentRange = range;
    setActiveTab(range);

    var seq = ++requestSeq;
    listEl.style.display = 'none';
    emptyEl.style.display = 'none';
    loadingEl.style.display = 'block';
    clearError();

    // Served by api/admin/bookings.js's ?view=schedule mode rather than a
    // dedicated api/admin/schedule.js file — see the countsOnly/scheduleView
    // comment in that file (Vercel Hobby plan's 12-Serverless-Function
    // limit; docs/phase-3/vercel-function-limit.md).
    fetch('/api/admin/bookings?view=schedule&range=' + encodeURIComponent(range))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) {
              throw new Error((body && body.error) || 'Could not load the schedule.');
            }
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== requestSeq) return; // redirected to login, or superseded by a newer range change
        loadingEl.style.display = 'none';
        render(body.jobs || []);
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load the schedule.');
      });
  }

  rangeTabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var range = btn.getAttribute('data-range');
      if (range !== currentRange) load(range);
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

  load('today');
});
