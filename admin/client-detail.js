// /admin/client/?id=<uuid> — client profile: identity/contact, quick
// actions, and full job history. Read-only end to end — no PATCH/POST from
// this page at all (unlike admin/booking-detail.js's status editor).
//
// Every dynamic value is written with textContent, and every link's href is
// built from a plain string assignment (never HTML concatenation), so
// customer-supplied text (name, address) can never be interpreted as
// markup no matter what it contains — same discipline as
// admin/booking-detail.js, which this file mirrors closely.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'rental_out', 'completed', 'lost'];

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

  // "$350" for an exact quote, "$350 – $475" for a range (Phase 3C Stage
  // 2.5) — never a duplicated value when there's no max.
  function formatQuotedAmount(min, max) {
    var minText = formatPrice(min);
    if (!minText) return null;
    var maxText = formatPrice(max);
    return maxText ? minText + ' – ' + maxText : minText;
  }

  // Same digit-only normalization as admin/booking-detail.js's
  // buildTelHref/buildSmsHref — never built from the raw display string.
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

  function disableAction(btn) {
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
  }

  function getClientId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderJobCard(b) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    var statusKey = STATUS_CLASSES.indexOf(b.status) !== -1 ? b.status : 'new';
    a.className = 'admin-booking-card admin-card-accent-' + statusKey;
    a.href = '/admin/booking/?id=' + encodeURIComponent(b.id);

    var top = el('div', 'admin-card-top');
    var topLeft = el('div', 'admin-card-top-left');
    topLeft.appendChild(el('span', 'admin-status-badge admin-status-' + statusKey, b.statusLabel || 'New'));
    top.appendChild(topLeft);
    a.appendChild(top);

    a.appendChild(el('div', 'admin-card-name', b.serviceLabel || b.serviceType || '—'));

    var addrParts = [];
    var sa = b.serviceAddress;
    if (sa) {
      if (sa.address) addrParts.push(sa.address);
      var cityState = [sa.city, sa.state].filter(Boolean).join(', ');
      if (cityState) addrParts.push(cityState);
    }
    a.appendChild(el('div', 'admin-card-service', addrParts.length ? addrParts.join(' · ') : 'No service address on file.'));

    var whenParts = [formatDate(b.appointmentDate)];
    if (b.timeLabel) whenParts.push(b.timeLabel);
    a.appendChild(el('div', 'admin-card-when', whenParts.join(' · ')));

    var footer = el('div', 'admin-card-footer');
    // Status-aware (Phase 3C Stage 2.5 addendum) — see admin/schedule.js's
    // identical comment: completed prefers Actual Collected, non-completed
    // always shows Quoted, never implying a not-yet-completed job is paid.
    var priceText = b.status === 'completed'
      ? (formatPrice(b.finalPrice) || formatQuotedAmount(b.estimatedPrice, b.estimatedPriceMax))
      : formatQuotedAmount(b.estimatedPrice, b.estimatedPriceMax);
    footer.appendChild(el('span', null, priceText || ''));
    footer.appendChild(el('span', 'admin-card-view', 'View Request →'));
    a.appendChild(footer);

    li.appendChild(a);
    return li;
  }

  function render(data) {
    var client = data.client;
    var bookings = data.bookings || [];

    var name = [client.firstName, client.lastName].filter(Boolean).join(' ');
    set('c-name', name || 'Unnamed client');
    set('c-subtitle', client.city ? client.city : (bookings.length + (bookings.length === 1 ? ' job on file' : ' jobs on file')));

    var callBtn = document.getElementById('c-call-btn');
    var textBtn = document.getElementById('c-text-btn');
    var emailBtn = document.getElementById('c-email-btn');

    var phoneLink = document.getElementById('c-phone-link');
    var telHref = buildTelHref(client.phone);
    var smsHref = buildSmsHref(client.phone);
    if (telHref) {
      phoneLink.href = telHref;
      phoneLink.textContent = client.phone;
      callBtn.href = telHref;
      textBtn.href = smsHref;
    } else {
      phoneLink.removeAttribute('href');
      phoneLink.textContent = client.phone || '—';
      disableAction(callBtn);
      disableAction(textBtn);
    }

    if (client.email) {
      document.getElementById('c-email-row').style.display = 'block';
      var emailLink = document.getElementById('c-email-link');
      emailLink.href = 'mailto:' + client.email;
      emailLink.textContent = client.email;
      emailBtn.href = 'mailto:' + client.email;
    } else {
      disableAction(emailBtn);
    }

    var addressLines = [client.address, [client.city, client.state, client.zip].filter(Boolean).join(', ')]
      .filter(Boolean)
      .join('\n');
    set('c-address', addressLines || 'No address on file.');

    var listEl = document.getElementById('job-list');
    var emptyEl = document.getElementById('job-empty');
    if (bookings.length) {
      bookings.forEach(function (b) {
        listEl.appendChild(renderJobCard(b));
      });
      listEl.style.display = 'flex';
      emptyEl.style.display = 'none';
    } else {
      listEl.style.display = 'none';
      emptyEl.style.display = 'block';
    }

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  var id = getClientId();
  if (!id) {
    showError('Missing client id.');
    return;
  }

  adminFetch('/api/admin/client?id=' + encodeURIComponent(id))
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
            throw new Error((body && body.error) || 'Could not load this client.');
          }
          return body;
        });
    })
    .then(function (body) {
      if (!body) return; // redirected to login
      render(body);
    })
    .catch(function (err) {
      showError(err && err.message ? err.message : 'Could not load this client.');
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
