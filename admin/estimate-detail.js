// /admin/estimate/?id=<uuid> — Estimate detail. Mirrors admin/lead-detail.js's
// structure (hero/status badge, contact actions, detail rows, textContent-
// only rendering) and reuses booking-detail.js's/job-closeout.js's
// "PATCH, then refresh the page" pattern for status actions — but
// deliberately does NOT reuse window.AdminJobCloseout or
// window.AdminStatusUI's default STATUS_ORDER/STATUS_TEXT: an estimate's
// lifecycle (scheduled/completed/cancelled/lost/converted) is its own
// small vocabulary, kept completely separate from bookings.status so an
// estimate can never accidentally be routed through the job payment/tip
// closeout sheet (see api/admin/booking.js's handlePatchEstimate() header
// for the same guarantee, enforced server-side too).
document.addEventListener('DOMContentLoaded', function () {
  var ESTIMATE_STATUS_LABELS = {
    scheduled: 'Scheduled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    lost: 'Did Not Book',
    converted: 'Converted to Job',
  };

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');
  var toastEl = document.getElementById('admin-toast');

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  var toastTimer = null;
  function showToast(msg, kind) {
    if (!toastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3200);
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === null || text === undefined || text === '' ? '—' : text;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
  function disableAction(btn) {
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
  }
  function formatPhone(p) {
    return window.formatPhone ? window.formatPhone(p) : p;
  }

  function getEstimateId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }
  var estimateId = getEstimateId();

  var completeBtn = document.getElementById('e-complete-btn');
  var lostBtn = document.getElementById('e-lost-btn');
  var cancelBtn = document.getElementById('e-cancel-btn');
  var convertBtn = document.getElementById('e-convert-btn');

  function render(data) {
    var estimate = data.estimate;
    var customer = data.customer;
    var lead = data.sourceLead;

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    set('e-name', name || 'Unnamed client');
    set('e-subtitle', 'ESTIMATE' + (estimate.serviceLabel ? ' · ' + estimate.serviceLabel : ''));

    var statusBadge = document.getElementById('e-status-badge');
    statusBadge.className = 'admin-status-badge admin-estimate-status-' + estimate.status;
    set('e-status-label', ESTIMATE_STATUS_LABELS[estimate.status] || estimate.status);

    var clientLink = document.getElementById('e-client-link');
    if (customer) {
      clientLink.href = '/admin/client/?id=' + encodeURIComponent(customer.id);
      clientLink.textContent = name || 'Unnamed client';
    } else {
      clientLink.removeAttribute('href');
      clientLink.textContent = '—';
    }

    var callBtn = document.getElementById('e-call-btn');
    var textBtn = document.getElementById('e-text-btn');
    var phoneLink = document.getElementById('e-phone-link');
    var phone = customer ? customer.phone : null;
    var telHref = buildTelHref(phone);
    var smsHref = buildSmsHref(phone);
    if (telHref) {
      phoneLink.href = telHref;
      phoneLink.textContent = formatPhone(phone);
      callBtn.href = telHref;
      textBtn.href = smsHref;
    } else {
      phoneLink.removeAttribute('href');
      phoneLink.textContent = '—';
      disableAction(callBtn);
      disableAction(textBtn);
    }

    var addressLines = [estimate.serviceAddress, [estimate.serviceCity, estimate.serviceState, estimate.serviceZip].filter(Boolean).join(', ')].filter(Boolean).join('\n');
    set('e-address', addressLines || 'No address on file.');

    var directionsBtn = document.getElementById('e-directions-btn');
    var mapsQuery = [estimate.serviceAddress, estimate.serviceCity, estimate.serviceState, estimate.serviceZip].filter(Boolean).join(', ');
    if (mapsQuery) {
      directionsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
    } else {
      disableAction(directionsBtn);
    }

    set('e-date', formatDate(estimate.appointmentDate));
    set('e-time', estimate.timeLabel || '—');
    set('e-service-type', estimate.serviceLabel || 'Not sure yet');
    set('e-quoted-amount', formatPrice(estimate.quotedAmount) || '—');

    var descRow = document.getElementById('e-description-row');
    if (estimate.description) {
      descRow.style.display = 'block';
      set('e-description', estimate.description);
    } else {
      descRow.style.display = 'none';
    }
    var notesRow = document.getElementById('e-notes-row');
    if (estimate.estimateNotes) {
      notesRow.style.display = 'block';
      set('e-notes', estimate.estimateNotes);
    } else {
      notesRow.style.display = 'none';
    }
    var outcomeRow = document.getElementById('e-outcome-row');
    if (estimate.outcomeNote) {
      outcomeRow.style.display = 'block';
      set('e-outcome-note', estimate.outcomeNote);
    } else {
      outcomeRow.style.display = 'none';
    }

    var leadSection = document.getElementById('e-lead-section');
    if (lead) {
      leadSection.style.display = 'block';
      var leadLink = document.getElementById('e-lead-link');
      leadLink.href = '/admin/lead/?id=' + encodeURIComponent(lead.id);
      var leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unnamed lead';
      leadLink.textContent = leadName + ' →';
    } else {
      leadSection.style.display = 'none';
    }

    var jobSection = document.getElementById('e-job-section');
    if (estimate.convertedBookingId) {
      jobSection.style.display = 'block';
      document.getElementById('e-job-link').href = '/admin/booking/?id=' + encodeURIComponent(estimate.convertedBookingId);
    } else {
      jobSection.style.display = 'none';
    }

    // Actions are status-gated — mirrors api/admin/booking.js's own
    // handlePatchEstimate()/handleCreate() transition rules exactly, so the
    // UI never offers a button the server would reject.
    convertBtn.href = '/admin/booking-new/?estimateId=' + encodeURIComponent(estimate.id);
    var canConvert = estimate.status === 'scheduled' || estimate.status === 'completed' || estimate.status === 'lost';
    convertBtn.style.display = canConvert ? 'inline-flex' : 'none';
    completeBtn.style.display = estimate.status === 'scheduled' ? 'inline-flex' : 'none';
    cancelBtn.style.display = estimate.status === 'scheduled' ? 'inline-flex' : 'none';
    lostBtn.style.display = estimate.status === 'completed' ? 'inline-flex' : 'none';
    document.getElementById('e-actions-section').style.display = canConvert || estimate.status === 'scheduled' ? 'block' : 'none';

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  function load() {
    return adminFetch('/api/admin/booking?resource=estimate&id=' + encodeURIComponent(estimateId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load this estimate.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        render(body);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load this estimate.');
      });
  }

  if (!estimateId) {
    showError('Missing estimate id.');
  } else {
    load();
  }

  // Hardening pass: replaced window.prompt()/window.confirm() with the
  // shared window.AdminEstimateOutcome bottom sheet (admin/estimate-
  // outcome-sheet.js) — same CRM-native sheet pattern as
  // window.AdminStatusUI/window.AdminJobCloseout, never a browser-native
  // dialog. The sheet performs its own PATCH and only calls onComplete
  // after a confirmed save; a dismissed/cancelled sheet calls nothing, so
  // the estimate is left completely untouched, matching every other
  // status-change control in this codebase.
  function onOutcomeComplete(successMessage) {
    return function (result) {
      showToast(successMessage, 'success');
      load();
    };
  }

  completeBtn.addEventListener('click', function () {
    window.AdminEstimateOutcome.open({ estimateId: estimateId, action: 'complete', onComplete: onOutcomeComplete('Estimate marked Completed.') });
  });

  lostBtn.addEventListener('click', function () {
    window.AdminEstimateOutcome.open({ estimateId: estimateId, action: 'lost', onComplete: onOutcomeComplete('Estimate marked Did Not Book.') });
  });

  cancelBtn.addEventListener('click', function () {
    window.AdminEstimateOutcome.open({ estimateId: estimateId, action: 'cancel', onComplete: onOutcomeComplete('Estimate cancelled.') });
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { window.location.href = '/admin/login/'; });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
