// /admin/lead/?id=<uuid> — canonical Lead detail view. UI batch
// (confirmed-intake lead-open bug fix): before this file existed, a
// `leads` table row (created by Confirm as Lead — see api/admin/lead.js's
// handleConfirm()) had no detail page at all; admin/leads-list.js
// deliberately rendered its card's main area as a plain non-interactive
// <div> rather than a dead link. This is the one canonical route every
// kind:'lead' card now points at — screenshot-intake-confirmed, phone, or
// manual source alike — via GET /api/admin/lead?id=.
//
// Read-only: this page has no save/edit/status-change action of its own
// (out of scope for this batch — see api/admin/lead.js's header; `leads`
// has a write grant for a future status-update action, just nothing here
// uses it yet). Every dynamic value is written with textContent and every
// link's href via a plain string assignment — same no-innerHTML discipline
// as admin/client-detail.js, which this file's structure mirrors.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');

  // snake_case lead.status -> the existing .admin-lead-bucket-* chip class
  // admin/leads-list.js's cards already use (admin.css's BUCKET_CHIP_CLASS
  // palette) — reused as-is rather than a second status-color set.
  var STATUS_TO_BUCKET_CLASS = {
    new: 'admin-lead-bucket-new',
    contacted: 'admin-lead-bucket-contacted',
    waiting_on_photos: 'admin-lead-bucket-waitingOnPhotos',
    estimate_sent: 'admin-lead-bucket-estimateSent',
    follow_up: 'admin-lead-bucket-followUp',
    booked: 'admin-lead-bucket-bookedWon',
    lost: 'admin-lead-bucket-lost',
  };
  var SOURCE_LABELS = {
    screenshot_intake: 'Screenshot Intake',
    phone: 'Phone',
    manual: 'Manual',
  };

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
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // Same digit-only normalization as every other admin detail page's own
  // copy (admin/booking-detail.js, admin/client-detail.js, admin/leads-
  // list.js) — this project's established per-file convention.
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

  function formatPhone(p) {
    return window.formatPhone ? window.formatPhone(p) : p;
  }

  function getLeadId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function render(lead) {
    var name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
    set('l-name', name || lead.phone || 'Unidentified lead');

    var subtitleParts = [];
    if (lead.serviceLabel) subtitleParts.push(lead.serviceLabel);
    if (lead.city) subtitleParts.push(lead.city);
    set('l-subtitle', subtitleParts.length ? subtitleParts.join(' · ') : 'No service details yet.');

    var statusBadge = document.getElementById('l-status-badge');
    statusBadge.className = 'admin-status-badge ' + (STATUS_TO_BUCKET_CLASS[lead.status] || 'admin-lead-bucket-new');
    set('l-status-label', lead.statusLabel || lead.status);

    var callBtn = document.getElementById('l-call-btn');
    var textBtn = document.getElementById('l-text-btn');
    var emailBtn = document.getElementById('l-email-btn');

    var phoneLink = document.getElementById('l-phone-link');
    var telHref = buildTelHref(lead.phone);
    var smsHref = buildSmsHref(lead.phone);
    if (telHref) {
      phoneLink.href = telHref;
      phoneLink.textContent = formatPhone(lead.phone);
      callBtn.href = telHref;
      textBtn.href = smsHref;
    } else {
      phoneLink.removeAttribute('href');
      phoneLink.textContent = formatPhone(lead.phone) || '—';
      disableAction(callBtn);
      disableAction(textBtn);
    }

    if (lead.email) {
      document.getElementById('l-email-row').style.display = 'block';
      var emailLink = document.getElementById('l-email-link');
      emailLink.href = 'mailto:' + lead.email;
      emailLink.textContent = lead.email;
      emailBtn.href = 'mailto:' + lead.email;
    } else {
      disableAction(emailBtn);
    }

    var addressLines = [lead.address, [lead.city, lead.state, lead.zip].filter(Boolean).join(', ')].filter(Boolean).join('\n');
    set('l-address', addressLines || 'No address on file.');

    set('l-service', lead.serviceLabel || '—');
    set('l-service-details', lead.serviceDetails || '—');
    set('l-load-size', lead.estimatedLoadSize || '—');
    set('l-quoted-amount', formatPrice(lead.quotedAmount) || '—');

    var followUpRow = document.getElementById('l-followup-row');
    if (lead.nextFollowUpDate) {
      followUpRow.style.display = 'block';
      set('l-followup-date', formatDate(lead.nextFollowUpDate));
    } else {
      followUpRow.style.display = 'none';
    }

    var matchedSection = document.getElementById('l-matched-section');
    if (lead.matchedClient) {
      matchedSection.style.display = 'block';
      var link = document.getElementById('l-matched-client-link');
      link.href = '/admin/client/?id=' + encodeURIComponent(lead.matchedClient.id);
      var clientName = [lead.matchedClient.firstName, lead.matchedClient.lastName].filter(Boolean).join(' ') || 'Unnamed client';
      var clientMeta = [];
      if (lead.matchedClient.phone) clientMeta.push(formatPhone(lead.matchedClient.phone));
      if (lead.matchedClient.city) clientMeta.push(lead.matchedClient.city);
      link.textContent = clientMeta.length ? clientName + ' (' + clientMeta.join(' · ') + ') →' : clientName + ' →';
    } else {
      matchedSection.style.display = 'none';
    }

    var notesSection = document.getElementById('l-notes-section');
    if (lead.notes) {
      notesSection.style.display = 'block';
      set('l-notes', lead.notes);
    } else {
      notesSection.style.display = 'none';
    }

    set('l-source', SOURCE_LABELS[lead.source] || lead.source || '—');
    var createdParts = ['Added ' + formatDateTime(lead.createdAt)];
    if (lead.createdBy) createdParts.push('by ' + lead.createdBy);
    set('l-created', createdParts.join(' '));

    var sourceIntakeRow = document.getElementById('l-source-intake-row');
    if (lead.sourceIntakeId) {
      sourceIntakeRow.style.display = 'block';
      document.getElementById('l-source-intake-link').href = '/admin/intake/?id=' + encodeURIComponent(lead.sourceIntakeId);
    } else {
      sourceIntakeRow.style.display = 'none';
    }

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  var id = getLeadId();
  if (!id) {
    showError('Missing lead id.');
    return;
  }

  adminFetch('/api/admin/lead?id=' + encodeURIComponent(id))
    .then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load this lead.');
          return body;
        });
    })
    .then(function (body) {
      if (!body) return; // redirected to login
      render(body.lead);
    })
    .catch(function (err) {
      showError(err && err.message ? err.message : 'Could not load this lead.');
    });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  // A back-navigation restored from bfcache can show a stale lead record —
  // force a clean reload, same reasoning as every other admin detail page.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
