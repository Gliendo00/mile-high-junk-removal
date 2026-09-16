// /admin/booking/?id=<uuid> — booking detail. Read-only except for one
// control: the status badge, which PATCHes /api/admin/booking-status.
//
// Every dynamic value is written with textContent, and every link's href is
// built from a plain string assignment (never HTML concatenation), so
// customer-supplied text (name, address, description, notes) can never be
// interpreted as markup no matter what it contains.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');
  var toastEl = document.getElementById('admin-toast');
  var statusTrigger = document.getElementById('d-status-trigger');
  var statusLabelEl = document.getElementById('d-status-badge-label');

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];
  var STATUS_TEXT = window.AdminStatusUI.STATUS_TEXT;

  var bookingId = null;
  var currentStatus = 'new';
  var savingInFlight = false;
  var toastTimer = null;

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === null || text === undefined || text === '' ? '—' : text;
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

  // Lower-case sentence-style relative time ("12 min ago"), for the
  // subtitle line — mirrors admin/dashboard.js's timeAgo() (kept as a
  // separate small copy rather than a shared import, matching the existing
  // deliberate-duplication convention documented in
  // api/_lib/booking-format.js, since these two pages load independent
  // <script> files with no bundler tying them together).
  function timeAgo(iso) {
    if (!iso) return '—';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    var diffMs = Math.max(0, Date.now() - then);
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    try {
      return 'on ' + new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  // Builds a tel: href from digits only — never from the raw display
  // string — mirroring the same safe-href pattern used server-side in
  // api/book.js's admin notification email.
  function buildTelHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'tel:+1' + digits : 'tel:+' + digits;
  }

  function getBookingId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function renderPhotos(photos) {
    var section = document.getElementById('d-photos-section');
    var grid = document.getElementById('d-photo-grid');
    if (!photos || !photos.length) return;
    section.style.display = 'block';
    photos.forEach(function (p) {
      if (p.url) {
        var a = document.createElement('a');
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener';
        var img = document.createElement('img');
        img.src = p.url;
        img.loading = 'lazy';
        img.alt = '';
        a.appendChild(img);
        grid.appendChild(a);
      } else {
        var div = document.createElement('div');
        div.className = 'admin-photo-unavailable';
        div.textContent = 'Unavailable';
        grid.appendChild(div);
      }
    });
  }

  function applyStatusDisplay(statusKey) {
    var key = STATUS_CLASSES.indexOf(statusKey) !== -1 ? statusKey : 'new';
    currentStatus = key;
    statusTrigger.className = 'admin-status-badge admin-status-' + key + ' admin-status-trigger';
    statusLabelEl.textContent = STATUS_TEXT[key] || key;
  }

  function render(data) {
    var booking = data.booking;
    var customer = data.customer;
    bookingId = booking.id;

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    set('d-name', name || 'Unknown client');

    applyStatusDisplay(booking.status);

    var whenParts = [formatDate(booking.appointmentDate)];
    if (booking.timeWindowLabel) whenParts.push(booking.timeWindowLabel);
    set('d-when', whenParts.join(' · '));
    set('d-subtitle', (booking.serviceLabel || booking.serviceType || '') + ' · Submitted ' + timeAgo(booking.createdAt));

    var callBtn = document.getElementById('d-call-btn');
    var directionsBtn = document.getElementById('d-directions-btn');

    if (customer) {
      var phoneLink = document.getElementById('d-phone-link');
      var telHref = buildTelHref(customer.phone);
      if (telHref) {
        phoneLink.href = telHref;
        phoneLink.textContent = customer.phone;
        callBtn.href = telHref;
      } else {
        phoneLink.removeAttribute('href');
        phoneLink.textContent = customer.phone || '—';
        callBtn.setAttribute('aria-disabled', 'true');
        callBtn.removeAttribute('href');
      }

      if (customer.email) {
        document.getElementById('d-email-row').style.display = 'block';
        var emailLink = document.getElementById('d-email-link');
        emailLink.href = 'mailto:' + customer.email;
        emailLink.textContent = customer.email;
      }

      var addressLines = [customer.address, [customer.city, customer.state, customer.zip].filter(Boolean).join(', ')]
        .filter(Boolean)
        .join('\n');
      set('d-address', addressLines);

      var mapsQuery = [customer.address, customer.city, customer.state, customer.zip].filter(Boolean).join(', ');
      if (mapsQuery) {
        directionsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
      } else {
        directionsBtn.setAttribute('aria-disabled', 'true');
        directionsBtn.removeAttribute('href');
      }
    } else {
      set('d-address', 'No client record found.');
      callBtn.setAttribute('aria-disabled', 'true');
      callBtn.removeAttribute('href');
      directionsBtn.setAttribute('aria-disabled', 'true');
      directionsBtn.removeAttribute('href');
    }

    set('d-service', booking.serviceLabel);
    set('d-description', booking.description);

    var estimated = formatPrice(booking.estimatedPrice);
    var final = formatPrice(booking.finalPrice);
    set('d-estimated-price', estimated || 'Not set yet');
    set('d-final-price', final || 'Not set yet');

    set('d-notes', booking.internalNotes || 'No internal notes yet.');

    if (data.dumpster) {
      document.getElementById('d-dumpster-section').style.display = 'block';
      set('d-delivery-date', formatDate(data.dumpster.deliveryDate));
      set('d-pickup-date', formatDate(data.dumpster.pickupDate));
      set('d-material', data.dumpster.materialType);
      set('d-placement', data.dumpster.placementNotes);
    }

    renderPhotos(data.photos);

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  function saveStatus(newStatus) {
    if (savingInFlight || newStatus === currentStatus) return;
    savingInFlight = true;

    var targetLabel = STATUS_TEXT[newStatus] || newStatus;
    statusTrigger.disabled = true;
    statusTrigger.classList.add('is-saving');
    statusLabelEl.textContent = 'Saving to ' + targetLabel + '…';

    fetch('/api/admin/booking-status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, status: newStatus }),
    })
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
              throw new Error((body && body.error) || 'Could not update status.');
            }
            return body;
          });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        // The badge only ever shows the server's confirmed value — never
        // the optimistically-tapped target — so a save can never visually
        // claim success before the database update is actually confirmed.
        applyStatusDisplay(body.status);
        showToast('Status updated to ' + (STATUS_TEXT[body.status] || body.status) + '.', 'success');
      })
      .catch(function (err) {
        // Nothing to revert visually: the badge was never changed to the
        // target status in the first place, only its "Saving…" state.
        applyStatusDisplay(currentStatus);
        showToast(err && err.message ? err.message : 'Could not update status. Please try again.', 'error');
      })
      .finally(function () {
        savingInFlight = false;
        statusTrigger.disabled = false;
        statusTrigger.classList.remove('is-saving');
      });
  }

  statusTrigger.addEventListener('click', function () {
    if (savingInFlight) return;
    window.AdminStatusUI.open({
      title: 'Change status',
      selected: currentStatus,
      onSelect: saveStatus,
    });
  });

  var id = getBookingId();
  if (!id) {
    showError('Missing booking id.');
    return;
  }

  fetch('/api/admin/booking?id=' + encodeURIComponent(id))
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
            throw new Error((body && body.error) || 'Could not load this request.');
          }
          return body;
        });
    })
    .then(function (body) {
      if (!body) return; // redirected to login
      render(body);
    })
    .catch(function (err) {
      showError(err && err.message ? err.message : 'Could not load this request.');
    });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });
});
