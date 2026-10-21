// /admin/invoice-new/ — "+ New Invoice" entry point.
//
// This page creates no new backend surface: client search reuses the exact
// same window.AdminClientPicker every other "+ New X" admin page already
// uses (admin/client-picker.js), the job list reuses GET /api/admin/client
// (already returns a client's bookings — client-detail.js's own "jobs on
// file" list), and creating the invoice reuses the existing, idempotent
// POST /api/admin/booking?resource=invoice (api/admin/booking.js's
// handleCreateInvoice()) exactly as booking-detail.js's "Create Invoice"
// link already does.
//
// Phase 3D Stage B — "Create without job": a job selection is now
// OPTIONAL. Choosing "Create without job" sends { customerId } instead of
// { bookingId }; handleCreateInvoice() creates a standalone invoice
// (booking_id null) that can later be billed via the invoice-specific
// manual payment path and/or attached to a job afterward (see
// admin/invoice.js's "Attach to Job"). selectedBookingId and
// createWithoutJob are mutually exclusive — picking one clears the other.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var toastEl = document.getElementById('admin-toast');
  var logoutBtn = document.getElementById('logout-btn');
  var form = document.getElementById('new-invoice-form');
  var saveBtn = document.getElementById('save-btn');

  var clientPickerMount = document.getElementById('client-picker-mount');
  var jobSection = document.getElementById('job-section');
  var jobLoadingEl = document.getElementById('job-loading');
  var jobEmptyEl = document.getElementById('job-empty');
  var jobListEl = document.getElementById('job-list');
  var jobHintEl = document.getElementById('job-hint');
  var noJobBtn = document.getElementById('no-job-btn');

  var selectedClient = null;
  var selectedBookingId = null;
  var createWithoutJob = false;
  var savingInFlight = false;
  var toastTimer = null;
  var jobsRequestToken = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
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
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3200);
  }
  function formatDate(iso) {
    if (!iso) return null;
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function updateSaveEnabled() {
    saveBtn.disabled = !(selectedClient && (selectedBookingId || createWithoutJob));
  }

  function renderJobCard(b) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-booking-card admin-invoice-job-card';
    btn.setAttribute('data-booking-id', b.id);

    btn.appendChild(el('div', 'admin-card-name', b.serviceLabel || b.serviceType || '—'));

    var addrParts = [];
    var sa = b.serviceAddress;
    if (sa) {
      if (sa.address) addrParts.push(sa.address);
      var cityState = [sa.city, sa.state].filter(Boolean).join(', ');
      if (cityState) addrParts.push(cityState);
    }
    btn.appendChild(el('div', 'admin-card-service', addrParts.length ? addrParts.join(' · ') : 'No service address on file.'));

    var whenParts = [formatDate(b.appointmentDate) || 'No date set'];
    if (b.timeLabel) whenParts.push(b.timeLabel);
    btn.appendChild(el('div', 'admin-card-when', whenParts.join(' · ')));

    var priceText = b.status === 'completed' ? formatPrice(b.finalPrice) : (formatPrice(b.estimatedPrice) || null);
    var footer = el('div', 'admin-card-footer');
    footer.appendChild(el('span', null, priceText || (b.statusLabel || '')));
    footer.appendChild(el('span', 'admin-invoice-job-pick-label', 'Select →'));
    btn.appendChild(footer);

    btn.addEventListener('click', function () {
      selectBooking(b.id, btn);
    });

    li.appendChild(btn);
    return li;
  }

  function selectBooking(bookingId, btnEl) {
    selectedBookingId = bookingId;
    createWithoutJob = false;
    noJobBtn.classList.remove('is-selected');
    var cards = jobListEl.querySelectorAll('.admin-invoice-job-card');
    Array.prototype.forEach.call(cards, function (c) { c.classList.toggle('is-selected', c === btnEl); });
    updateSaveEnabled();
    checkExistingInvoice(bookingId);
  }

  function selectNoJob() {
    createWithoutJob = true;
    selectedBookingId = null;
    noJobBtn.classList.add('is-selected');
    var cards = jobListEl.querySelectorAll('.admin-invoice-job-card');
    Array.prototype.forEach.call(cards, function (c) { c.classList.remove('is-selected'); });
    jobHintEl.textContent = 'This invoice will not be tied to a job yet — you can attach one later from the invoice itself.';
    updateSaveEnabled();
  }
  noJobBtn.addEventListener('click', selectNoJob);

  // A soft heads-up only — the create call below is itself idempotent
  // (handleCreateInvoice() re-fetches/returns the existing active invoice
  // on a unique_violation), so this is purely informational, never a
  // blocker, and never prevents submitting.
  function checkExistingInvoice(bookingId) {
    jobHintEl.textContent = 'Select the job this invoice bills, or create it without one.';
    adminFetch('/api/admin/booking?resource=invoice&bookingId=' + encodeURIComponent(bookingId))
      .then(function (res) {
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      })
      .then(function (body) {
        if (body && body.invoice && selectedBookingId === bookingId) {
          jobHintEl.textContent = 'This job already has a ' + (body.invoice.status === 'draft' ? 'draft' : body.invoice.status) + ' invoice — creating one will open that existing invoice instead of making a new one.';
        }
      })
      .catch(function () {});
  }

  function loadJobsForClient(clientId) {
    var myToken = ++jobsRequestToken;
    jobSection.style.display = 'block';
    jobListEl.style.display = 'none';
    jobEmptyEl.style.display = 'none';
    jobLoadingEl.style.display = 'block';
    while (jobListEl.firstChild) jobListEl.removeChild(jobListEl.firstChild);

    adminFetch('/api/admin/client?id=' + encodeURIComponent(clientId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "Could not load this client's jobs.");
          return body;
        });
      })
      .then(function (body) {
        if (!body || myToken !== jobsRequestToken) return; // redirected to login, or a newer client selection superseded this one
        jobLoadingEl.style.display = 'none';
        // A pickup job can never be invoiced (api/admin/booking.js's
        // handleCreateInvoice() enforces this server-side too) — bill the
        // primary rental instead, same rule job_payments already follows.
        var eligible = (body.bookings || []).filter(function (b) { return b.serviceType !== 'dumpster_pickup'; });
        if (!eligible.length) {
          jobEmptyEl.style.display = 'block';
          return;
        }
        eligible.forEach(function (b) { jobListEl.appendChild(renderJobCard(b)); });
        jobListEl.style.display = 'flex';
      })
      .catch(function (err) {
        if (myToken !== jobsRequestToken) return;
        jobLoadingEl.style.display = 'none';
        showToast(err && err.message ? err.message : "Could not load this client's jobs.", 'error');
      });
  }

  function onClientSelect(client) {
    selectedClient = client;
    selectedBookingId = null;
    createWithoutJob = false;
    noJobBtn.classList.remove('is-selected');
    updateSaveEnabled();
    if (client) {
      loadJobsForClient(client.id);
    } else {
      jobSection.style.display = 'none';
      jobListEl.style.display = 'none';
      jobEmptyEl.style.display = 'none';
      while (jobListEl.firstChild) jobListEl.removeChild(jobListEl.firstChild);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (savingInFlight) return;
    clearError();

    if (!selectedClient) {
      showError('Please select a client first.');
      return;
    }
    if (!selectedBookingId && !createWithoutJob) {
      showError('Please select the job this invoice bills, or choose "Create without job".');
      return;
    }

    savingInFlight = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating…';

    adminFetch('/api/admin/booking?resource=invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createWithoutJob ? { customerId: selectedClient.id } : { bookingId: selectedBookingId }),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not create this invoice.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        window.location.href = '/admin/invoice/?id=' + encodeURIComponent(body.invoice.id);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not create this invoice.');
      })
      .finally(function () {
        savingInFlight = false;
        saveBtn.disabled = !(selectedClient && (selectedBookingId || createWithoutJob));
        saveBtn.textContent = 'Create Draft Invoice';
      });
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { window.location.href = '/admin/login/'; });
  });

  function showForm() {
    loadingEl.style.display = 'none';
    form.style.display = 'block';
  }

  window.AdminClientPicker.mount(clientPickerMount, { onSelect: onClientSelect });

  // Session check on load — same reasoning as admin/estimate-new.js's
  // identical check: this page has no protected data of its own to fetch
  // up front, so there's no natural 401 to catch otherwise.
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

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
