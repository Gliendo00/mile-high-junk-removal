// /admin — read-only dashboard: filter/summary bar + booking list.
//
// Every dynamic value below is written with textContent (never
// innerHTML/insertAdjacentHTML with a concatenated string), so a
// customer-supplied name/address/description containing "<script>" or any
// other markup is rendered as inert text, never parsed as HTML.
document.addEventListener('DOMContentLoaded', function () {
  var PAGE_SIZE = 50;
  var MORE_STATUSES = ['contacted', 'quoted', 'lost'];

  var errorBanner = document.getElementById('error-banner');
  var filterBar = document.getElementById('filter-bar');
  var moreBtn = document.getElementById('filter-more-btn');
  var moreDot = document.getElementById('more-dot');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('booking-list');
  var loadMoreWrap = document.getElementById('load-more-wrap');
  var loadMoreBtn = document.getElementById('load-more-btn');
  var logoutBtn = document.getElementById('logout-btn');

  var offset = 0;
  var loadedAny = false;
  var currentFilter = ''; // '' = All. Otherwise one of the six status keys.
  var requestSeq = 0; // guards against an in-flight request resolving after a newer filter change

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  // "12 MIN AGO" / "3 HR AGO" / "5 DAYS AGO" style relative label. Falls
  // back to a short absolute date once something is more than a week old,
  // since "312 HR AGO" stops being useful information at a glance.
  function timeAgo(iso) {
    if (!iso) return '—';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    var diffMs = Date.now() - then;
    if (diffMs < 0) diffMs = 0;
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'JUST NOW';
    if (mins < 60) return mins + ' MIN AGO';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' HR AGO';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' DAY AGO' : ' DAYS AGO');
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    } catch (e) {
      return '';
    }
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function cameraIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '13.5');
    circle.setAttribute('r', '3');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.6');
    svg.appendChild(path);
    svg.appendChild(circle);
    return svg;
  }

  function renderBookingCard(b) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    var statusKey = STATUS_CLASSES.indexOf(b.status) !== -1 ? b.status : 'new';
    a.className = 'admin-booking-card admin-card-accent-' + statusKey;
    a.href = '/admin/booking/?id=' + encodeURIComponent(b.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-status-badge admin-status-' + statusKey, b.statusLabel || 'New'));
    topLeft.appendChild(el('span', 'admin-card-timeago', timeAgo(b.createdAt)));
    top.appendChild(topLeft);
    a.appendChild(top);

    a.appendChild(el('div', 'admin-card-name', (b.customer ? [b.customer.firstName, b.customer.lastName].filter(Boolean).join(' ') : '') || 'Unknown client'));

    var serviceCityParts = [b.serviceLabel || b.serviceType || '—'];
    if (b.serviceCity) serviceCityParts.push(b.serviceCity);
    a.appendChild(el('div', 'admin-card-service', serviceCityParts.join(' · ')));

    var whenParts = [formatDate(b.appointmentDate)];
    if (b.timeLabel) whenParts.push(b.timeLabel);
    a.appendChild(el('div', 'admin-card-when', whenParts.join(' · ')));

    var footer = el('div', 'admin-card-footer');
    var photos = el('span', 'admin-card-photos');
    photos.appendChild(cameraIcon());
    var photoText = (b.photoCount || 0) + (b.photoCount === 1 ? ' photo' : ' photos');
    var priceText = formatPrice(b.finalPrice) || formatQuotedAmount(b.estimatedPrice, b.estimatedPriceMax);
    photos.appendChild(document.createTextNode((priceText ? priceText + ' · ' : '') + photoText));
    footer.appendChild(photos);
    footer.appendChild(el('span', 'admin-card-view', 'View Request →'));
    a.appendChild(footer);

    li.appendChild(a);
    return li;
  }

  function setActivePill(status) {
    var pills = filterBar.querySelectorAll('.admin-filter-pill[data-status]');
    for (var i = 0; i < pills.length; i++) {
      var isActive = pills[i].getAttribute('data-status') === status;
      pills[i].classList.toggle('is-active', isActive);
      pills[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    moreBtn.classList.toggle('is-active', MORE_STATUSES.indexOf(status) !== -1);
  }

  function resetAndLoad(status) {
    currentFilter = status;
    offset = 0;
    loadedAny = false;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    listEl.style.display = 'none';
    emptyEl.style.display = 'none';
    loadMoreWrap.style.display = 'none';
    loadingEl.style.display = 'block';
    setActivePill(status);
    loadPage();
  }

  function loadPage() {
    var seq = ++requestSeq;
    var url = '/api/admin/bookings?limit=' + PAGE_SIZE + '&offset=' + offset;
    if (currentFilter) url += '&status=' + encodeURIComponent(currentFilter);

    return fetch(url)
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
              throw new Error((body && body.error) || 'Could not load requests.');
            }
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== requestSeq) return; // redirected to login, or superseded by a newer filter change
        loadingEl.style.display = 'none';
        clearError();

        filterBar.style.display = 'flex';
        document.getElementById('count-all').textContent = body.summary.total;
        document.getElementById('count-new').textContent = body.summary.new;
        document.getElementById('count-booked').textContent = body.summary.booked;
        document.getElementById('count-completed').textContent = body.summary.completed;
        moreDot.hidden = (body.summary.contacted + body.summary.quoted + body.summary.lost) === 0;

        loadedAny = true;

        if (!body.bookings.length && offset === 0) {
          emptyEl.style.display = 'block';
          listEl.style.display = 'none';
        } else {
          listEl.style.display = 'flex';
          body.bookings.forEach(function (b) {
            listEl.appendChild(renderBookingCard(b));
          });
        }

        offset += body.bookings.length;
        loadMoreWrap.style.display = body.hasMore ? 'flex' : 'none';
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load requests.');
      });
  }

  filterBar.addEventListener('click', function (e) {
    var pill = e.target.closest('.admin-filter-pill[data-status]');
    if (pill) {
      var status = pill.getAttribute('data-status');
      if (status !== currentFilter) resetAndLoad(status);
    }
  });

  moreBtn.addEventListener('click', function () {
    window.AdminStatusUI.open({
      title: 'More statuses',
      values: MORE_STATUSES,
      selected: MORE_STATUSES.indexOf(currentFilter) !== -1 ? currentFilter : null,
      onSelect: function (status) {
        resetAndLoad(status);
      },
    });
  });

  loadMoreBtn.addEventListener('click', function () {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
    loadPage().then(function () {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
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

  // A back-navigation restored from bfcache can show a stale list (e.g.
  // after changing a booking's status on the detail page and tapping
  // "back"). Force a clean reload in that case so the dashboard always
  // reflects the database, not a cached snapshot of the previous visit.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  loadPage();
});
