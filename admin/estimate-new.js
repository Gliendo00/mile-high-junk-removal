// /admin/estimate-new/ — "+ New Estimate" (Estimate workflow). Mirrors
// admin/booking-new.js's own structure closely (client picker, time mode
// toggle, service address) rather than inventing a second form pattern —
// see that file's header for the conventions reused here verbatim.
//
// Two entry points, same page:
//   - Independent: /admin/estimate-new/ — a blank form, client picked or
//     created via the shared window.AdminClientPicker exactly like "+ New
//     Job".
//   - From a Lead: /admin/estimate-new/?leadId=<uuid> ("Schedule Estimate"
//     on Lead Detail) — carries forward every field already known about
//     the lead (name/phone/email via the client picker's preselect/
//     autoOpenCreate, address, service type, notes) so the admin only
//     confirms/chooses the date and time. The original Lead is never
//     touched by this page — api/admin/booking.js's handleCreateEstimate()
//     only ever reads it (to validate sourceLeadId), never writes it.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  // Same client-side copy of api/_lib/time-windows.js's labels as
  // admin/booking-new.js — this project's established per-file convention.
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
  var form = document.getElementById('new-estimate-form');
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
  var serviceTypeSelect = document.getElementById('service-type');
  var quotedAmountInput = document.getElementById('quoted-amount');
  var descriptionInput = document.getElementById('description');
  var estimateNotesInput = document.getElementById('estimate-notes');

  var timeMode = 'window';

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

  TIME_WINDOWS.forEach(function (w) {
    var opt = document.createElement('option');
    opt.value = w.value;
    opt.textContent = w.label;
    timeWindowSelect.appendChild(opt);
  });

  // Denver-local "today", same reasoning as booking-new.js's identical copy
  // — the owner's phone may not be set to America/Denver.
  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  var todayIso = denverTodayIso();
  appointmentDateInput.value = todayIso;
  appointmentDateInput.min = todayIso;

  if (window.AdminAddressAutocomplete) {
    window.AdminAddressAutocomplete.attach({
      address: serviceAddressInput,
      city: serviceCityInput,
      state: serviceStateInput,
      zip: serviceZipInput,
    });
  }

  sameAsClientRow.addEventListener('change', function () {
    if (sameAsClientRow.checked && selectedClient && selectedClient.address) {
      serviceAddressInput.value = selectedClient.address || '';
      serviceCityInput.value = selectedClient.city || '';
      serviceStateInput.value = selectedClient.state || '';
      serviceZipInput.value = selectedClient.zip || '';
    }
  });

  function getQueryParam(name) {
    var params = new URLSearchParams(window.location.search);
    return (params.get(name) || '').trim();
  }
  var leadId = getQueryParam('leadId');
  var sourceLead = null; // the full lead record, once fetched — only set when leadId is present

  function onClientSelect(client, warnings) {
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
  }

  // Carries forward everything already known about the Lead: client
  // identity (via the picker's preselect/autoOpenCreate — see
  // client-picker.js), address, service type, and notes. Never deletes or
  // replaces the Lead — this page only ever reads it.
  function applyLeadPrefill(lead) {
    sourceLead = lead;

    if (lead.address) serviceAddressInput.value = lead.address;
    if (lead.city) serviceCityInput.value = lead.city;
    if (lead.state) serviceStateInput.value = lead.state;
    if (lead.zip) serviceZipInput.value = lead.zip;

    if (lead.serviceType) serviceTypeSelect.value = lead.serviceType;
    if (lead.quotedAmount !== null && lead.quotedAmount !== undefined) quotedAmountInput.value = lead.quotedAmount;

    var noteParts = [];
    if (lead.serviceDetails) noteParts.push(lead.serviceDetails);
    if (lead.notes) noteParts.push(lead.notes);
    if (noteParts.length) descriptionInput.value = noteParts.join('\n\n');

    window.AdminClientPicker.mount(clientPickerMount, {
      onSelect: onClientSelect,
      preselect: lead.matchedClient ? { id: lead.matchedClient.id, firstName: lead.matchedClient.firstName, lastName: lead.matchedClient.lastName, phone: lead.matchedClient.phone, email: lead.matchedClient.email } : null,
      autoOpenCreate: lead.matchedClient ? null : { firstName: lead.firstName || '', lastName: lead.lastName || '', phone: lead.phone || '', email: lead.email || '' },
    });
  }

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

    var body = {
      customerId: selectedClient.id,
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
      estimateNotes: estimateNotesInput.value.trim(),
    };
    if (serviceTypeSelect.value) body.serviceType = serviceTypeSelect.value;
    var quotedRaw = quotedAmountInput.value.trim();
    if (quotedRaw) body.quotedAmount = Number(quotedRaw);
    if (leadId) body.sourceLeadId = leadId;

    savingInFlight = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    adminFetch('/api/admin/booking?resource=estimate', {
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
          if (!res.ok) throw new Error((respBody && respBody.error) || 'Could not save this estimate.');
          return respBody;
        });
      })
      .then(function (respBody) {
        if (!respBody) return; // redirected to login
        window.location.href = '/admin/estimate/?id=' + encodeURIComponent(respBody.estimate.id);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not save this estimate.');
      })
      .finally(function () {
        savingInFlight = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Estimate';
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

  function showForm() {
    loadingEl.style.display = 'none';
    form.style.display = 'block';
  }

  if (leadId) {
    adminFetch('/api/admin/lead?id=' + encodeURIComponent(leadId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load this lead.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        applyLeadPrefill(body.lead);
        showForm();
      })
      .catch(function (err) {
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load this lead.');
      });
  } else {
    window.AdminClientPicker.mount(clientPickerMount, { onSelect: onClientSelect });
    // Session check on load — same reasoning as booking-new.js's identical
    // check: this page has no protected data of its own to fetch when
    // there's no leadId, so there's no natural 401 to catch otherwise.
    adminFetch('/api/admin/bookings?countsOnly=1')
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return;
        }
        if (!res.ok) throw new Error('Could not verify your session.');
        showForm();
      })
      .catch(function () {
        loadingEl.style.display = 'none';
        showError('Could not verify your session. Please refresh the page.');
      });
  }

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
