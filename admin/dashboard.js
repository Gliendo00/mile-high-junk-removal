// /admin — read-only dashboard: summary counts + booking list.
//
// Every dynamic value below is written with textContent (never
// innerHTML/insertAdjacentHTML with a concatenated string), so a
// customer-supplied name/address/description containing "<script>" or any
// other markup is rendered as inert text, never parsed as HTML.
document.addEventListener('DOMContentLoaded', function () {
  var PAGE_SIZE = 50;

  var errorBanner = document.getElementById('error-banner');
  var summaryEl = document.getElementById('summary');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('booking-list');
  var loadMoreWrap = document.getElementById('load-more-wrap');
  var loadMoreBtn = document.getElementById('load-more-btn');
  var logoutBtn = document.getElementById('logout-btn');

  var offset = 0;
  var loadedAny = false;

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderBookingCard(b) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'admin-booking-card';
    a.href = '/admin/booking/?id=' + encodeURIComponent(b.id);

    var top = el('div', 'admin-card-top');
    var name = b.customer ? [b.customer.firstName, b.customer.lastName].filter(Boolean).join(' ') : '';
    top.appendChild(el('div', 'admin-card-name', name || 'Unknown client'));

    var statusKey = STATUS_CLASSES.indexOf(b.status) !== -1 ? b.status : 'new';
    top.appendChild(el('span', 'admin-status-badge admin-status-' + statusKey, b.statusLabel || 'New'));
    a.appendChild(top);

    a.appendChild(el('div', 'admin-card-service', b.serviceLabel || b.serviceType || '—'));

    var meta = el('div', 'admin-card-meta');
    meta.appendChild(el('span', null, formatDate(b.appointmentDate)));
    if (b.timeWindowLabel) meta.appendChild(el('span', null, b.timeWindowLabel));
    if (b.customer && b.customer.city) meta.appendChild(el('span', null, b.customer.city));
    a.appendChild(meta);

    var footer = el('div', 'admin-card-footer');
    var footerLeft = el('span', null, formatDateTime(b.createdAt));
    var priceText = formatPrice(b.estimatedPrice);
    var footerRightParts = [];
    if (priceText) footerRightParts.push(priceText);
    footerRightParts.push((b.photoCount || 0) + (b.photoCount === 1 ? ' photo' : ' photos'));
    var footerRight = el('span', null, footerRightParts.join(' · '));
    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);
    a.appendChild(footer);

    li.appendChild(a);
    return li;
  }

  function loadPage() {
    return fetch('/api/admin/bookings?limit=' + PAGE_SIZE + '&offset=' + offset)
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
        if (!body) return; // redirected to login
        loadingEl.style.display = 'none';

        if (!loadedAny) {
          summaryEl.style.display = 'grid';
          document.getElementById('stat-new').textContent = body.summary.new;
          document.getElementById('stat-booked').textContent = body.summary.booked;
          document.getElementById('stat-completed').textContent = body.summary.completed;
          document.getElementById('stat-total').textContent = body.summary.total;
        }

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
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load requests.');
      });
  }

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

  loadPage();
});
