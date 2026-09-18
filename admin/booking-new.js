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
  var exactTimeInput = document.getElementById('exact-time');
  var timeModeToggle = document.getElementById('time-mode-toggle');
  var appointmentDateInput = document.getElementById('appointment-date');

  var estimatedPriceInput = document.getElementById('estimated-price');
  var estimatedPriceMaxInput = document.getElementById('estimated-price-max');
  var quoteModeToggle = document.getElementById('quote-mode-toggle');
  var quoteMaxWrap = document.getElementById('quote-max-wrap');
  var quoteToLabel = document.getElementById('quote-to-label');

  // Phase 3C Stage 2.5: "Exact Time | Time Window" and "Exact | Range" are
  // both simple two-button segmented toggles — see admin.css's
  // .admin-segmented. Tracked as plain variables (not re-derived from which
  // element happens to be visible) so submit-time logic is unambiguous even
  // if a field was filled in, then the mode was switched away from it.
  var timeMode = 'window';
  var quoteMode = 'exact';

  function setupSegmented(container, onSelect) {
    var buttons = container.querySelectorAll('.admin-segmented-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(buttons, function (b) { b.classList.toggle('is-active', b === btn); });
        onSelect(btn.getAttribute('data-mode'));
      });
    });
  }

  setupSegmented(timeModeToggle, function (mode) {
    timeMode = mode;
    var isExact = mode === 'exact';
    exactTimeInput.style.display = isExact ? 'block' : 'none';
    timeWindowSelect.style.display = isExact ? 'none' : 'block';
  });

  setupSegmented(quoteModeToggle, function (mode) {
    quoteMode = mode;
    var isRange = mode === 'range';
    quoteToLabel.style.display = isRange ? 'inline' : 'none';
    quoteMaxWrap.style.display = isRange ? 'flex' : 'none';
    if (!isRange) estimatedPriceMaxInput.value = '';
  });

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
  // Denver-local, not the browser's own local time — the owner's phone may
  // not be set to America/Denver, matching admin/booking-past.js's own
  // reasoning for using this same explicit-timezone approach rather than
  // plain `new Date()` getters.
  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  var todayIso = denverTodayIso();
  appointmentDateInput.value = todayIso;
  appointmentDateInput.min = todayIso;

  // Date-aware entry (Phase 3C Stage 2.4): a Month/Year calendar day's
  // "+ New Job" link may carry ?date=YYYY-MM-DD so the form opens with that
  // date already selected. Never trusted blindly — an arbitrary URL value
  // is validated against exactly the same rule the server itself enforces
  // (a real calendar date, today or later); anything else is silently
  // ignored and the field keeps its ordinary today default, never a broken
  // or out-of-range prefill. This is a convenience only: the server
  // independently re-validates the submitted date regardless of what
  // prefilled this field.
  (function applyDatePrefill() {
    var params = new URLSearchParams(window.location.search);
    var requested = (params.get('date') || '').trim();
    if (!requested) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return;
    var d = new Date(requested + 'T00:00:00Z');
    if (isNaN(d.getTime())) return;
    var parts = requested.split('-').map(Number);
    if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() + 1 !== parts[1] || d.getUTCDate() !== parts[2]) return; // rejects an impossible date like 2026-02-30
    if (requested < todayIso) return; // New Job only ever accepts today-or-later; an earlier date is silently ignored, not "corrected" to today's own different meaning
    appointmentDateInput.value = requested;
  })();

  // Only offer "same as client's address" when a full street address is
  // actually known for this client (true right after inline-creating one
  // — that response includes it; a client picked from search only ever
  // carries name/phone/email/city, never the full address, so there is
  // nothing honest to prefill from in that case). Also resets whenever the
  // selection is cleared (client === null, via "Change").
  // Google Places address autocomplete — Phase 3C Stage 2.4, key fetched
  // lazily from the server since Stage 2.4.1 (see admin/address-
  // autocomplete.js's header). Purely additive: if the key isn't
  // configured server-side, the fetch fails, or the Google script fails
  // to load, this call is a safe no-op and every field below stays a
  // fully manual, fully required-nothing text input exactly as before
  // this feature.
  if (window.AdminAddressAutocomplete) {
    window.AdminAddressAutocomplete.attach({
      address: serviceAddressInput,
      city: serviceCityInput,
      state: serviceStateInput,
      zip: serviceZipInput,
    });
  }

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

    if (timeMode === 'exact') {
      if (!exactTimeInput.value) {
        showError('Please choose an exact time.');
        return;
      }
    } else if (!timeWindowSelect.value) {
      showError('Please select a time window.');
      return;
    }

    if (quoteMode === 'range' && !estimatedPriceInput.value.trim()) {
      showError('A quote range needs a minimum amount.');
      return;
    }
    if (quoteMode === 'range' && estimatedPriceMaxInput.value.trim() &&
        Number(estimatedPriceMaxInput.value) <= Number(estimatedPriceInput.value)) {
      showError('The maximum quote amount must be greater than the minimum.');
      return;
    }

    var body = {
      customerId: selectedClient.id,
      serviceType: document.getElementById('service-type').value,
      appointmentDate: appointmentDateInput.value,
      timeWindow: timeMode === 'window' ? timeWindowSelect.value : '',
      exactTime: timeMode === 'exact' ? exactTimeInput.value : '',
      serviceAddress: {
        address: serviceAddressInput.value.trim(),
        city: serviceCityInput.value.trim(),
        state: serviceStateInput.value.trim(),
        zip: serviceZipInput.value.trim(),
      },
      description: document.getElementById('description').value.trim(),
      internalNotes: document.getElementById('internal-notes').value.trim(),
    };
    var priceRaw = estimatedPriceInput.value.trim();
    if (priceRaw) body.estimatedPrice = Number(priceRaw);
    if (quoteMode === 'range') {
      var maxRaw = estimatedPriceMaxInput.value.trim();
      if (maxRaw) body.estimatedPriceMax = Number(maxRaw);
    }

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
