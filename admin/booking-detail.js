// /admin/booking/?id=<uuid> — read-only booking detail.
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

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
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
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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

  function render(data) {
    var booking = data.booking;
    var customer = data.customer;

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    set('d-name', name || 'Unknown client');
    set('d-subtitle', (booking.serviceLabel || booking.serviceType || '') + ' · Submitted ' + formatDateTime(booking.createdAt));

    var statusKey = STATUS_CLASSES.indexOf(booking.status) !== -1 ? booking.status : 'new';
    var badge = document.getElementById('d-status-badge');
    badge.className = 'admin-status-badge admin-status-' + statusKey;
    badge.textContent = booking.statusLabel || 'New';
    set('d-status-text', booking.statusLabel || 'New');

    if (customer) {
      var phoneLink = document.getElementById('d-phone-link');
      var telHref = buildTelHref(customer.phone);
      if (telHref) {
        phoneLink.href = telHref;
        phoneLink.textContent = customer.phone;
      } else {
        phoneLink.removeAttribute('href');
        phoneLink.textContent = customer.phone || '—';
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
      var mapsLink = document.getElementById('d-maps-link');
      if (mapsQuery) {
        mapsLink.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
      } else {
        mapsLink.style.display = 'none';
      }
    } else {
      set('d-address', 'No client record found.');
      document.getElementById('d-maps-link').style.display = 'none';
    }

    set('d-service', booking.serviceLabel);
    set('d-date', formatDate(booking.appointmentDate));
    set('d-window', booking.timeWindowLabel);
    set('d-description', booking.description);
    set('d-created', formatDateTime(booking.createdAt));

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
