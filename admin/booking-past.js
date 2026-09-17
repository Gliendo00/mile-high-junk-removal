// /admin/booking-past/ — "+ Past Job" (Phase 3C Stage 2.2). Rapid historical
// job entry: select/create a client via the shared window.AdminClientPicker,
// fill in minimal job info, then POST /api/admin/booking with mode:"past".
// Server-side is the sole source of truth for the historical date floor,
// the "completed" status, and every other validated rule — this file only
// ever provides client-side convenience defaults/hints.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  // Mirrors api/_lib/time-windows.js's TIME_WINDOW_DEFS labels — same small,
  // deliberate client-side copy admin/booking-new.js already keeps.
  var TIME_WINDOWS = [
    { value: 'w_0400_0600', label: '4:00 AM – 6:00 AM' },
    { value: 'w_0600_0800', label: '6:00 AM – 8:00 AM' },
    { value: 'w_0800_1000', label: '8:00 AM – 10:00 AM' },
    { value: 'w_1000_1200', label: '10:00 AM – 12:00 PM' },
    { value: 'w_1200_1400', label: '12:00 PM – 2:00 PM' },
    { value: 'w_1400_1600', label: '2:00 PM – 4:00 PM' },
    { value: 'w_1600_1800', label: '4:00 PM – 6:00 PM' },
    { value: 'w_1800_2000', label: '6:00 PM – 8:00 PM' },
    { value: 'w_2000_2200', label: '8:00 PM – 10:00 PM' },
  ];

  // Must match api/_lib/historical-floor.js's HISTORICAL_FLOOR_ISO — a
  // client-side convenience copy only, purely to bound the date picker and
  // default its value. The server independently re-validates this floor on
  // every request; this constant never itself decides what gets saved.
  var HISTORICAL_FLOOR_ISO = '2026-01-01';

  // Denver-local "today," computed the same explicit-timezone way the
  // server's own denverTodayIso() does, rather than the browser's local
  // Date methods — the owner's phone may not be set to America/Denver, and
  // using the wrong timezone here could offer a max/default date the server
  // then rejects as "in the future" (or silently disallow a valid one).
  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var toastEl = document.getElementById('admin-toast');
  var logoutBtn = document.getElementById('logout-btn');
  var form = document.getElementById('past-job-form');
  var saveBtn = document.getElementById('save-btn');

  var clientSummaryEmpty = document.getElementById('client-summary-empty');
  var clientSummaryFilled = document.getElementById('client-summary-filled');
  var clientSummaryName = document.getElementById('client-summary-name');
  var clientSummaryMeta = document.getElementById('client-summary-meta');
  var selectClientBtn = document.getElementById('select-client-btn');
  var changeClientBtn = document.getElementById('change-client-btn');

  var serviceAddressInput = document.getElementById('service-address');
  var serviceCityInput = document.getElementById('service-city');
  var serviceStateInput = document.getElementById('service-state');
  var serviceZipInput = document.getElementById('service-zip');

  var timeWindowSelect = document.getElementById('time-window');
  var appointmentDateInput = document.getElementById('appointment-date');
  var actualPriceInput = document.getElementById('actual-price');
  var descriptionInput = document.getElementById('description');
  var internalNotesInput = document.getElementById('internal-notes');

  var successPanel = document.getElementById('success-panel');
  var successMeta = document.getElementById('success-meta');
  var viewJobBtn = document.getElementById('view-job-btn');
  var addAnotherBtn = document.getElementById('add-another-btn');

  var selectedClient = null;
  var toastTimer = null;
  var savingInFlight = false;

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }
  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
  }
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // Time window options — starts on the unknown/optional placeholder, which
  // (unlike New Job's disabled placeholder) is a real, selectable choice:
  // leaving it selected submits timeWindow:"" and the server stores a real
  // NULL, never an invented time.
  TIME_WINDOWS.forEach(function (w) {
    var opt = document.createElement('option');
    opt.value = w.value;
    opt.textContent = w.label;
    timeWindowSelect.appendChild(opt);
  });

  var todayIso = denverTodayIso();
  appointmentDateInput.min = HISTORICAL_FLOOR_ISO;
  appointmentDateInput.max = todayIso;
  appointmentDateInput.value = todayIso;

  function applyClientSelection(client) {
    selectedClient = client;
    var name = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Unnamed client';
    clientSummaryName.textContent = name;
    var metaParts = [];
    if (client.phone) metaParts.push(client.phone);
    if (client.email) metaParts.push(client.email);
    clientSummaryMeta.textContent = metaParts.length ? metaParts.join(' · ') : 'No contact info on file';
    clientSummaryEmpty.style.display = 'none';
    clientSummaryFilled.style.display = 'flex';
  }

  function openPicker() {
    window.AdminClientPicker.open({
      onSelect: function (client, warnings) {
        applyClientSelection(client);
        if (warnings && warnings.length) {
          showToast('Note: this client shares contact info with an existing client.', 'error');
        }
      },
    });
  }

  selectClientBtn.addEventListener('click', openPicker);
  changeClientBtn.addEventListener('click', openPicker);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (savingInFlight) return;
    clearError();

    if (!selectedClient) {
      showError('Please select or create a client first.');
      return;
    }

    var body = {
      mode: 'past',
      customerId: selectedClient.id,
      serviceType: document.getElementById('service-type').value,
      appointmentDate: appointmentDateInput.value,
      timeWindow: timeWindowSelect.value,
      serviceAddress: {
        address: serviceAddressInput.value.trim(),
        city: serviceCityInput.value.trim(),
        state: serviceStateInput.value.trim(),
        zip: serviceZipInput.value.trim(),
      },
      description: descriptionInput.value.trim(),
      internalNotes: internalNotesInput.value.trim(),
    };
    var priceRaw = actualPriceInput.value.trim();
    if (priceRaw) body.finalPrice = Number(priceRaw);

    savingInFlight = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    fetch('/api/admin/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (respBody) {
          if (!res.ok) {
            throw new Error((respBody && respBody.error) || 'Could not save this job.');
          }
          return respBody;
        });
      })
      .then(function (respBody) {
        if (!respBody) return; // redirected to login
        showSuccess(respBody.booking, selectedClient);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not save this job.');
      })
      .finally(function () {
        savingInFlight = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Past Job';
      });
  });

  function showSuccess(booking, client) {
    form.style.display = 'none';
    var name = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Unnamed client';
    var metaParts = [name, booking.appointmentDate];
    var priceText = formatPrice(booking.finalPrice);
    if (priceText) metaParts.push(priceText);
    successMeta.textContent = metaParts.join(' · ');
    successPanel.style.display = 'block';
    viewJobBtn.onclick = function () {
      window.location.href = '/admin/booking/?id=' + encodeURIComponent(booking.id);
    };
  }

  // Resets every job-specific field for another entry by reloading a fresh
  // copy of this page — deliberately never carries the previous client's
  // identity, address, amount, or notes forward (see
  // docs/phase-3/stage2.2-past-job-proposal.md's rapid-entry requirements).
  addAnotherBtn.addEventListener('click', function () {
    window.location.href = '/admin/booking-past/';
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  // Session check on load — same reasoning as admin/booking-new.js's own:
  // this page has no protected data to fetch of its own, so an
  // expired/absent session is caught here via the existing countsOnly
  // summary endpoint (aggregate counts only, never client/booking records)
  // rather than only surfacing later when the picker or Save is used.
  fetch('/api/admin/bookings?countsOnly=1')
    .then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return;
      }
      if (!res.ok) throw new Error('Could not verify your session.');
      loadingEl.style.display = 'none';
      form.style.display = 'block';
    })
    .catch(function () {
      loadingEl.style.display = 'none';
      showError('Could not verify your session. Please refresh the page.');
    });
});
