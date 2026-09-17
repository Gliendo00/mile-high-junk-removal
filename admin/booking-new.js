// /admin/booking-new/ — "+ New Job" (Phase 3C Stage 2.1). Select/create a
// client via the shared window.AdminClientPicker, fill in job info and a
// service address, then POST /api/admin/booking.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  // Mirrors api/_lib/time-windows.js's TIME_WINDOW_DEFS labels — a small,
  // deliberate client-side copy of the same lookup already duplicated
  // server-side between api/book.js and api/_lib/time-windows.js, per this
  // project's established convention (see api/_lib/booking-format.js's
  // header) rather than a new shared-across-runtimes module.
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

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var toastEl = document.getElementById('admin-toast');
  var logoutBtn = document.getElementById('logout-btn');
  var form = document.getElementById('new-job-form');
  var saveBtn = document.getElementById('save-btn');

  var clientPickerMount = document.getElementById('client-picker-mount');

  var sameAsClientRow = document.getElementById('same-as-client-address');
  var serviceAddressInput = document.getElementById('service-address');
  var serviceCityInput = document.getElementById('service-city');
  var serviceStateInput = document.getElementById('service-state');
  var serviceZipInput = document.getElementById('service-zip');

  var timeWindowSelect = document.getElementById('time-window');
  var appointmentDateInput = document.getElementById('appointment-date');

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

  // Time window options
  TIME_WINDOWS.forEach(function (w) {
    var opt = document.createElement('option');
    opt.value = w.value;
    opt.textContent = w.label;
    timeWindowSelect.appendChild(opt);
  });

  // Default appointment date to today (client-side convenience only — the
  // server independently enforces "today or later" in America/Denver).
  var today = new Date();
  var todayIso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  appointmentDateInput.value = todayIso;
  appointmentDateInput.min = todayIso;

  // Only offer "same as client's address" when a full street address is
  // actually known for this client (true right after inline-creating one
  // — that response includes it; a client picked from search only ever
  // carries name/phone/email/city, never the full address, so there is
  // nothing honest to prefill from in that case). Also resets whenever the
  // selection is cleared (client === null, via "Change").
  window.AdminClientPicker.mount(clientPickerMount, {
    onSelect: function (client, warnings) {
      selectedClient = client;
      if (client && warnings && warnings.length) {
        showToast('Note: this client shares contact info with an existing client.', 'error');
      }
      if (client && client.address) {
        sameAsClientRow.disabled = false;
        sameAsClientRow.checked = false;
      } else {
        sameAsClientRow.disabled = true;
        sameAsClientRow.checked = false;
      }
    },
  });

  sameAsClientRow.addEventListener('change', function () {
    if (sameAsClientRow.checked && selectedClient && selectedClient.address) {
      serviceAddressInput.value = selectedClient.address || '';
      serviceCityInput.value = selectedClient.city || '';
      serviceStateInput.value = selectedClient.state || '';
      serviceZipInput.value = selectedClient.zip || '';
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (savingInFlight) return;
    clearError();

    if (!selectedClient) {
      showError('Please select or create a client first.');
      return;
    }

    if (!timeWindowSelect.value) {
      showError('Please select a time window.');
      return;
    }

    var body = {
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
      description: document.getElementById('description').value.trim(),
      internalNotes: document.getElementById('internal-notes').value.trim(),
    };
    var priceRaw = document.getElementById('estimated-price').value.trim();
    if (priceRaw) body.estimatedPrice = Number(priceRaw);

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
        window.location.href = '/admin/booking/?id=' + encodeURIComponent(respBody.booking.id);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not save this job.');
      })
      .finally(function () {
        savingInFlight = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Job';
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

  // Session check on load — this page has no protected data to fetch of its
  // own (it's a blank create form), so unlike every other admin page it has
  // no natural "primary fetch" whose 401 already triggers a redirect. The
  // form stays hidden (see the inline style in booking-new/index.html) until
  // this check confirms a live session, so an expired/absent session is
  // caught here instead of only surfacing later when the picker or Save is
  // used. Reuses the existing countsOnly summary endpoint purely to verify
  // auth — it returns aggregate counts only, never client/booking records,
  // and needs no new endpoint (see the Vercel function-count constraint).
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
