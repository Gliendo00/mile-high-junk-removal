// /admin/booking-edit/?id=<uuid> — "Edit Job" (Phase 3C, Existing Job
// Editing). Loads an existing booking, lets the owner correct it, and
// PATCHes /api/admin/booking. The attached client is never changed here —
// there is no picker on this page at all, only a read-only summary.
//
// Server-side is the sole source of truth for every validation rule (date
// bounds, time-window requirements, pricing-mode routing, the concurrency
// check) — this file only ever provides client-side convenience defaults
// and hints, exactly like admin/booking-new.js and admin/booking-past.js
// already do.
//
// Every dynamic value is written with textContent/.value (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  // Mirrors api/_lib/time-windows.js's TIME_WINDOW_DEFS labels — same small,
  // deliberate client-side copy admin/booking-new.js and
  // admin/booking-past.js already keep. The four legacy ids (public /book
  // flow, pre-dating the admin CRM's finer windows) are included too so an
  // older booking's existing value always has a matching option — never a
  // blank/mismatched selection just because the value is legacy.
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
  var LEGACY_TIME_WINDOWS = {
    morning: 'Morning (8am–11am)',
    midday: 'Midday (11am–2pm)',
    afternoon: 'Afternoon (2pm–5pm)',
    evening: 'Evening (5pm–7pm)',
  };

  // Must match api/_lib/historical-floor.js's HISTORICAL_FLOOR_ISO — a
  // client-side convenience copy only, purely to bound the date picker.
  var HISTORICAL_FLOOR_ISO = '2026-01-01';

  // Denver-local "today," computed the same explicit-timezone way the
  // server's own denverTodayIso() does — same small copy
  // admin/booking-past.js already keeps.
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
  var form = document.getElementById('edit-job-form');
  var saveBtn = document.getElementById('save-btn');
  var cancelBtn = document.getElementById('cancel-btn');
  var backLink = document.getElementById('back-link');
  var statusBadge = document.getElementById('status-badge');

  var clientNameEl = document.getElementById('client-name');
  var clientMetaEl = document.getElementById('client-meta');

  var appointmentDateInput = document.getElementById('appointment-date');
  var appointmentDateLabel = document.getElementById('appointment-date-label');
  var dateHint = document.getElementById('date-hint');
  var timeWindowSelect = document.getElementById('time-window');
  var exactTimeInput = document.getElementById('exact-time');
  var timeModeLabelEl = document.getElementById('time-mode-label');
  var timeModeToggle = document.getElementById('time-mode-toggle');
  var serviceTypeSelect = document.getElementById('service-type');

  var serviceAddressInput = document.getElementById('service-address');
  var serviceCityInput = document.getElementById('service-city');
  var serviceStateInput = document.getElementById('service-state');
  var serviceZipInput = document.getElementById('service-zip');

  var estimatedPriceInput = document.getElementById('estimated-price');
  var estimatedPriceMaxInput = document.getElementById('estimated-price-max');
  var quoteModeToggle = document.getElementById('quote-mode-toggle');
  var quoteMaxWrap = document.getElementById('quote-max-wrap');
  var quoteToLabel = document.getElementById('quote-to-label');
  var actualPriceInput = document.getElementById('actual-price');
  var pricingTipRow = document.getElementById('pricing-tip');
  var tipAmountInput = document.getElementById('tip-amount');
  var descriptionInput = document.getElementById('description');
  var internalNotesInput = document.getElementById('internal-notes');

  // Google Places address autocomplete — Phase 3C Stage 2.4. Purely
  // additive; see admin/booking-new.js's identical comment for the full
  // fallback contract when Google isn't configured or fails to load.
  if (window.AdminAddressAutocomplete) {
    window.AdminAddressAutocomplete.attach({
      address: serviceAddressInput,
      city: serviceCityInput,
      state: serviceStateInput,
      zip: serviceZipInput,
    });
  }

  var bookingId = null;
  var isCompleted = false;
  var loadedUpdatedAt = undefined; // the concurrency token captured on load
  var savingInFlight = false;
  var toastTimer = null;

  // Phase 3C Stage 2.5: same "Exact Time | Time Window" and "Exact | Range"
  // segmented toggles as New Job/Past Job — see admin/booking-new.js's
  // identical comment. Edit Job additionally initializes each mode from the
  // loaded booking (see render() below) rather than always defaulting to
  // the first option, so reopening an exact-time or ranged-quote job shows
  // it correctly rather than silently switching it back to the other mode.
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
  function setSegmentedActive(container, mode) {
    var buttons = container.querySelectorAll('.admin-segmented-btn');
    Array.prototype.forEach.call(buttons, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-mode') === mode);
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

  function showError(msg) {
    loadingEl.style.display = 'none';
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

  function getBookingId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function populateTimeWindowOptions(currentValue) {
    while (timeWindowSelect.firstChild) timeWindowSelect.removeChild(timeWindowSelect.firstChild);

    var placeholder = document.createElement('option');
    placeholder.value = '';
    if (isCompleted) {
      placeholder.textContent = 'Time unknown / optional';
    } else {
      placeholder.textContent = 'Select time';
      placeholder.disabled = true;
    }
    timeWindowSelect.appendChild(placeholder);

    var knownValues = TIME_WINDOWS.map(function (w) { return w.value; });
    // If the booking already has a legacy id (from the public /book flow,
    // pre-dating this admin CRM), add it as its own option so the current
    // value is shown correctly rather than falling back to the placeholder.
    if (currentValue && knownValues.indexOf(currentValue) === -1 && LEGACY_TIME_WINDOWS[currentValue]) {
      var legacyOpt = document.createElement('option');
      legacyOpt.value = currentValue;
      legacyOpt.textContent = LEGACY_TIME_WINDOWS[currentValue];
      timeWindowSelect.appendChild(legacyOpt);
    }

    TIME_WINDOWS.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w.value;
      opt.textContent = w.label;
      timeWindowSelect.appendChild(opt);
    });

    timeWindowSelect.value = currentValue || '';
  }

  function applyStatusDisplay(status) {
    // Phase 3C Stage 4: 'rental_out' must be included here too — this is a
    // read-only status mirror (see this file's header: no status picker on
    // this page), but without it a rental job currently "Rental Out" would
    // silently fall back to displaying "New" on Edit Job.
    var known = ['new', 'contacted', 'quoted', 'booked', 'rental_out', 'completed', 'lost'];
    var key = known.indexOf(status) !== -1 ? status : 'new';
    statusBadge.className = 'admin-status-badge admin-status-' + key;
    // 'rental_out' needs its own label ("Rental Out") since naive title-
    // casing of the key would otherwise render the literal "Rental_out".
    statusBadge.textContent = key === 'rental_out' ? 'Rental Out' : key.charAt(0).toUpperCase() + key.slice(1);
  }

  function render(data) {
    var booking = data.booking;
    var customer = data.customer;
    var serviceAddress = data.serviceAddress || {};
    bookingId = booking.id;
    isCompleted = booking.status === 'completed';
    loadedUpdatedAt = booking.updatedAt === undefined ? null : booking.updatedAt;

    backLink.href = '/admin/booking/?id=' + encodeURIComponent(bookingId);
    applyStatusDisplay(booking.status);

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    clientNameEl.textContent = name || 'Unknown client';
    var metaParts = [];
    if (customer && customer.phone) metaParts.push(customer.phone);
    if (customer && customer.email) metaParts.push(customer.email);
    clientMetaEl.textContent = metaParts.length ? metaParts.join(' · ') : 'No contact info on file';

    var todayIso = denverTodayIso();
    if (isCompleted) {
      appointmentDateLabel.textContent = 'Job Date';
      appointmentDateInput.min = HISTORICAL_FLOOR_ISO;
      appointmentDateInput.max = todayIso;
      dateHint.textContent = 'Completed jobs can be corrected to any date from Jan 1, 2026 through today.';
      timeModeLabelEl.textContent = 'Appointment Time (optional)';
    } else {
      appointmentDateLabel.textContent = 'Appointment Date';
      appointmentDateInput.min = todayIso;
      appointmentDateInput.removeAttribute('max');
      dateHint.textContent = 'This job can be moved to another current or future date.';
      timeModeLabelEl.textContent = 'Appointment Time';
    }
    appointmentDateInput.value = booking.appointmentDate || '';
    populateTimeWindowOptions(booking.timeWindow || '');

    // Initial mode: exact time wins if the loaded booking has one (matches
    // effectiveTimeLabel's own precedence server-side), otherwise Time
    // Window — never guessed from anything but what this booking actually
    // has saved.
    timeMode = booking.exactTime ? 'exact' : 'window';
    setSegmentedActive(timeModeToggle, timeMode);
    exactTimeInput.value = booking.exactTime ? booking.exactTime.slice(0, 5) : '';
    exactTimeInput.style.display = timeMode === 'exact' ? 'block' : 'none';
    timeWindowSelect.style.display = timeMode === 'exact' ? 'none' : 'block';

    serviceTypeSelect.value = booking.serviceType || 'junk_removal';

    serviceAddressInput.value = serviceAddress.address || '';
    serviceCityInput.value = serviceAddress.city || '';
    serviceStateInput.value = serviceAddress.state || '';
    serviceZipInput.value = serviceAddress.zip || '';

    // Financial fields (Phase 3C Stage 2.5 addendum): Quoted Amount and
    // Actual Job Amount Collected are independent concepts, both always
    // shown/editable here regardless of status — never gated by
    // completed/booked. Tip stays completed-only.
    estimatedPriceInput.value = booking.estimatedPrice === null || booking.estimatedPrice === undefined ? '' : booking.estimatedPrice;
    // Range mode only when this booking actually has a max saved — never
    // guessed, mirrors the exact-time-vs-window init above.
    quoteMode = booking.estimatedPriceMax !== null && booking.estimatedPriceMax !== undefined ? 'range' : 'exact';
    setSegmentedActive(quoteModeToggle, quoteMode);
    estimatedPriceMaxInput.value = quoteMode === 'range' ? booking.estimatedPriceMax : '';
    quoteToLabel.style.display = quoteMode === 'range' ? 'inline' : 'none';
    quoteMaxWrap.style.display = quoteMode === 'range' ? 'flex' : 'none';

    actualPriceInput.value = booking.finalPrice === null || booking.finalPrice === undefined ? '' : booking.finalPrice;

    if (isCompleted) {
      pricingTipRow.style.display = 'block';
      tipAmountInput.value = booking.tipAmount === null || booking.tipAmount === undefined ? '' : booking.tipAmount;
    } else {
      pricingTipRow.style.display = 'none';
      tipAmountInput.value = '';
    }

    descriptionInput.value = booking.description || '';
    internalNotesInput.value = booking.internalNotes || '';

    loadingEl.style.display = 'none';
    form.style.display = 'block';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (savingInFlight) return;
    clearError();

    if (!appointmentDateInput.value) {
      showError('Please choose a date.');
      return;
    }
    if (!isCompleted) {
      if (timeMode === 'exact' && !exactTimeInput.value) {
        showError('Please choose an exact time.');
        return;
      }
      if (timeMode === 'window' && !timeWindowSelect.value) {
        showError('Please select a time window.');
        return;
      }
    }

    var body = {
      id: bookingId,
      updatedAt: loadedUpdatedAt,
      serviceType: serviceTypeSelect.value,
      appointmentDate: appointmentDateInput.value,
      timeWindow: timeMode === 'window' ? timeWindowSelect.value : '',
      exactTime: timeMode === 'exact' ? exactTimeInput.value : '',
      serviceAddress: {
        address: serviceAddressInput.value.trim(),
        city: serviceCityInput.value.trim(),
        state: serviceStateInput.value.trim(),
        zip: serviceZipInput.value.trim(),
      },
      description: descriptionInput.value.trim(),
      internalNotes: internalNotesInput.value.trim(),
    };
    // Financial fields (Phase 3C Stage 2.5 addendum) — Quoted Amount and
    // Actual Job Amount Collected are independent and always editable here,
    // regardless of status; neither is derived from or overwrites the
    // other. Tip stays completed-only.
    if (quoteMode === 'range' && !estimatedPriceInput.value.trim()) {
      showError('A quote range needs a minimum amount.');
      return;
    }
    if (quoteMode === 'range' && estimatedPriceMaxInput.value.trim() &&
        Number(estimatedPriceMaxInput.value) <= Number(estimatedPriceInput.value)) {
      showError('The maximum quote amount must be greater than the minimum.');
      return;
    }
    var estRaw = estimatedPriceInput.value.trim();
    body.estimatedPrice = estRaw ? Number(estRaw) : '';
    body.estimatedPriceMax = (quoteMode === 'range' && estimatedPriceMaxInput.value.trim()) ? Number(estimatedPriceMaxInput.value) : '';

    var actualRaw = actualPriceInput.value.trim();
    body.finalPrice = actualRaw ? Number(actualRaw) : '';

    if (isCompleted) {
      var tipRaw = tipAmountInput.value.trim();
      body.tipAmount = tipRaw ? Number(tipRaw) : '';
    }

    savingInFlight = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    fetch('/api/admin/booking', {
      method: 'PATCH',
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
            var err = new Error((respBody && respBody.error) || 'Could not save changes.');
            err.code = respBody && respBody.code;
            throw err;
          }
          return respBody;
        });
      })
      .then(function (respBody) {
        if (!respBody) return; // redirected to login
        window.location.href = '/admin/booking/?id=' + encodeURIComponent(bookingId);
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save changes. Please try again.', 'error');
      })
      .finally(function () {
        savingInFlight = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      });
  });

  // Cancel makes zero requests — it only ever navigates back to the
  // booking's detail page, which does its own fresh, unmodified fetch.
  cancelBtn.addEventListener('click', function () {
    window.location.href = bookingId ? '/admin/booking/?id=' + encodeURIComponent(bookingId) : '/admin/';
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
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          throw new Error((body && body.error) || 'Could not load this job.');
        }
        return body;
      });
    })
    .then(function (body) {
      if (!body) return; // redirected to login
      render(body);
    })
    .catch(function (err) {
      showError(err && err.message ? err.message : 'Could not load this job.');
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
