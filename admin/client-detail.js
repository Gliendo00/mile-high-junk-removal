// /admin/client/?id=<uuid> — client profile: identity/contact, quick
// actions, and full job history. As of Batch 2D, also Edit Client and
// Archive/Restore Client (both PATCH /api/admin/client) — previously this
// page was read-only end to end (unlike admin/booking-detail.js's status
// editor).
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
  var toastEl = document.getElementById('admin-toast');
  var toastTimer = null;

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'rental_out', 'completed', 'lost'];

  var currentClientId = null;
  var currentClient = null;

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
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
    currentClientId = client.id;
    currentClient = client;

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

    renderArchiveState(client);

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  // -----------------------------------------------------------------
  // Batch 2D — Edit Client + Archive/Restore Client. Same
  // .admin-sheet-overlay/.admin-sheet chrome admin/booking-detail.js's own
  // equivalent sheets use (see that file's header for the full reasoning),
  // built with this file's own el() helper for the simple parts and plain
  // document.createElement for form inputs, same mix admin/expenses.js
  // already uses.
  // -----------------------------------------------------------------
  var ARCHIVE_REASON_TEXT = {
    duplicate_client: 'Duplicate client',
    test_spam: 'Test / spam',
    requested_removal: 'Requested removal',
    entered_by_mistake: 'Entered by mistake',
    other: 'Other',
  };
  var editBtn = document.getElementById('c-edit-btn');
  var archiveBtn = document.getElementById('c-archive-btn');
  var restoreBtn = document.getElementById('c-restore-btn');
  var archivedInfoEl = document.getElementById('c-archived-info');

  function renderArchiveState(client) {
    if (client.archivedAt) {
      archiveBtn.style.display = 'none';
      restoreBtn.style.display = '';
      var parts = ['Archived ' + formatDateTime(client.archivedAt)];
      if (client.archivedReason) parts.push('Reason: ' + (ARCHIVE_REASON_TEXT[client.archivedReason] || client.archivedReason));
      if (client.archivedNote) parts.push(client.archivedNote);
      if (client.archivedBy) parts.push('by ' + client.archivedBy);
      archivedInfoEl.textContent = parts.join(' — ');
      archivedInfoEl.classList.add('is-visible');
    } else {
      archiveBtn.style.display = '';
      restoreBtn.style.display = 'none';
      archivedInfoEl.classList.remove('is-visible');
      archivedInfoEl.textContent = '';
    }
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  var sheetOverlay = null;
  var sheet = null;
  function ensureSheetDom() {
    if (sheetOverlay) return;
    sheetOverlay = document.createElement('div');
    sheetOverlay.className = 'admin-sheet-overlay';
    sheetOverlay.setAttribute('hidden', '');
    sheet = document.createElement('div');
    sheet.className = 'admin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheetOverlay.appendChild(sheet);
    sheetOverlay.addEventListener('click', function (e) {
      if (e.target === sheetOverlay) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sheetOverlay.hasAttribute('hidden')) closeSheet();
    });
    document.body.appendChild(sheetOverlay);
  }
  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }
  function closeSheet() {
    if (!sheetOverlay) return;
    sheetOverlay.setAttribute('hidden', '');
    clearSheet();
  }
  function fieldRow(labelText, inputEl) {
    var row = el('div', 'admin-field');
    row.appendChild(el('label', null, labelText));
    row.appendChild(inputEl);
    return row;
  }
  function textInput(value) {
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    return input;
  }

  // Edit Client — pre-filled form, full resend on save (never a partial
  // per-field patch). customerId/bookings are never part of this form —
  // this page has no code path that could send them, so a client's
  // existing jobs stay linked to the exact same customer_id no matter
  // what.
  function openEditSheet() {
    ensureSheetDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', 'Edit Client'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);

    var firstNameInput = textInput(currentClient.firstName);
    var lastNameInput = textInput(currentClient.lastName);
    var phoneInput = textInput(currentClient.phone);
    var emailInput = textInput(currentClient.email);
    var addressInput = textInput(currentClient.address);
    var cityInput = textInput(currentClient.city);
    var stateInput = textInput(currentClient.state);
    stateInput.maxLength = 2;
    var zipInput = textInput(currentClient.zip);

    sheet.appendChild(fieldRow('First Name', firstNameInput));
    sheet.appendChild(fieldRow('Last Name', lastNameInput));
    sheet.appendChild(fieldRow('Phone', phoneInput));
    sheet.appendChild(fieldRow('Email', emailInput));
    sheet.appendChild(fieldRow('Street Address', addressInput));
    sheet.appendChild(fieldRow('City', cityInput));
    sheet.appendChild(fieldRow('State', stateInput));
    sheet.appendChild(fieldRow('ZIP', zipInput));

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var saveBtnEl = document.createElement('button');
    saveBtnEl.type = 'button';
    saveBtnEl.className = 'admin-btn admin-btn-primary';
    saveBtnEl.textContent = 'Save Changes';
    actions.appendChild(saveBtnEl);

    var cancelBtnEl = document.createElement('button');
    cancelBtnEl.type = 'button';
    cancelBtnEl.className = 'admin-btn admin-btn-outline';
    cancelBtnEl.textContent = 'Cancel';
    cancelBtnEl.addEventListener('click', closeSheet);
    actions.appendChild(cancelBtnEl);

    saveBtnEl.addEventListener('click', function () {
      if (!firstNameInput.value.trim()) {
        errorBox.textContent = 'First name is required.';
        errorBox.classList.add('is-visible');
        return;
      }
      errorBox.classList.remove('is-visible');
      saveBtnEl.disabled = true;
      saveBtnEl.textContent = 'Saving…';

      adminFetch('/api/admin/client', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: currentClientId,
          firstName: firstNameInput.value.trim(),
          lastName: lastNameInput.value.trim(),
          phone: phoneInput.value.trim(),
          email: emailInput.value.trim(),
          address: addressInput.value.trim(),
          city: cityInput.value.trim(),
          state: stateInput.value.trim(),
          zip: zipInput.value.trim(),
        }),
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/admin/login/';
            return null;
          }
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not save changes.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeSheet();
          // Reflects the change immediately, everywhere this page shows
          // client data — no full reload needed. Job history/archive state
          // are untouched by this response and stay exactly as rendered.
          currentClient = Object.assign({}, currentClient, body.client);
          currentClientId = currentClient.id;
          applyClientIdentity(currentClient);
          showToast('Client updated.', 'success');
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not save changes.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          saveBtnEl.disabled = false;
          saveBtnEl.textContent = 'Save Changes';
        });
    });

    sheetOverlay.removeAttribute('hidden');
  }

  // Re-renders just the identity/contact fields render() already sets from
  // a fresh client object — factored out of render() so a successful edit
  // can reuse it without re-fetching or touching the job history/archive
  // state at all.
  function applyClientIdentity(client) {
    var name = [client.firstName, client.lastName].filter(Boolean).join(' ');
    set('c-name', name || 'Unnamed client');
    set('c-subtitle', client.city || document.getElementById('job-list').children.length + ' jobs on file');

    var callBtn = document.getElementById('c-call-btn');
    var textBtn = document.getElementById('c-text-btn');
    var emailBtn = document.getElementById('c-email-btn');
    var phoneLink = document.getElementById('c-phone-link');
    var telHref = buildTelHref(client.phone);
    var smsHref = buildSmsHref(client.phone);
    if (telHref) {
      phoneLink.href = telHref;
      phoneLink.textContent = client.phone;
      callBtn.removeAttribute('aria-disabled');
      textBtn.removeAttribute('aria-disabled');
      callBtn.href = telHref;
      textBtn.href = smsHref;
    } else {
      phoneLink.removeAttribute('href');
      phoneLink.textContent = client.phone || '—';
      disableAction(callBtn);
      disableAction(textBtn);
    }

    var emailRow = document.getElementById('c-email-row');
    if (client.email) {
      emailRow.style.display = 'block';
      var emailLink = document.getElementById('c-email-link');
      emailLink.href = 'mailto:' + client.email;
      emailLink.textContent = client.email;
      emailBtn.removeAttribute('aria-disabled');
      emailBtn.href = 'mailto:' + client.email;
    } else {
      emailRow.style.display = 'none';
      disableAction(emailBtn);
    }

    var addressLines = [client.address, [client.city, client.state, client.zip].filter(Boolean).join(', ')].filter(Boolean).join('\n');
    set('c-address', addressLines || 'No address on file.');
  }

  editBtn.addEventListener('click', openEditSheet);

  function openArchiveSheet() {
    ensureSheetDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', 'Archive Client'));
    sheet.appendChild(el('p', 'admin-field-hint', 'This client will be hidden from the Clients list/search and the job picker. Existing bookings and job history are never affected, and this can be undone at any time.'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);

    var reasonSelect = document.createElement('select');
    var placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Select a reason…';
    reasonSelect.appendChild(placeholderOpt);
    ['duplicate_client', 'test_spam', 'requested_removal', 'entered_by_mistake', 'other'].forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = ARCHIVE_REASON_TEXT[key];
      reasonSelect.appendChild(opt);
    });
    sheet.appendChild(fieldRow('Reason', reasonSelect));

    var noteField = fieldRow('Note (required for Other)', document.createElement('textarea'));
    var noteInput = noteField.querySelector('textarea');
    noteInput.rows = 2;
    noteField.style.display = 'none';
    sheet.appendChild(noteField);

    reasonSelect.addEventListener('change', function () {
      noteField.style.display = reasonSelect.value === 'other' ? 'block' : 'none';
    });

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-danger';
    confirmBtn.textContent = 'Archive Client';
    actions.appendChild(confirmBtn);

    var cancelBtnEl = document.createElement('button');
    cancelBtnEl.type = 'button';
    cancelBtnEl.className = 'admin-btn admin-btn-outline';
    cancelBtnEl.textContent = 'Cancel';
    cancelBtnEl.addEventListener('click', closeSheet);
    actions.appendChild(cancelBtnEl);

    confirmBtn.addEventListener('click', function () {
      var reason = reasonSelect.value;
      if (!reason) {
        errorBox.textContent = 'Please choose a reason.';
        errorBox.classList.add('is-visible');
        return;
      }
      var note = noteInput.value.trim();
      if (reason === 'other' && !note) {
        errorBox.textContent = 'A note is required when the reason is Other.';
        errorBox.classList.add('is-visible');
        return;
      }
      errorBox.classList.remove('is-visible');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Archiving…';

      adminFetch('/api/admin/client', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentClientId, action: 'archive', reason: reason, note: note }),
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/admin/login/';
            return null;
          }
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not archive this client.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeSheet();
          currentClient = Object.assign({}, currentClient, body);
          renderArchiveState(currentClient);
          showToast('Client archived.', 'success');
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not archive this client.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Archive Client';
        });
    });

    sheetOverlay.removeAttribute('hidden');
  }

  function openRestoreSheet() {
    ensureSheetDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', 'Restore Client'));
    sheet.appendChild(el('p', 'admin-field-hint', 'This client will reappear in the Clients list/search and the job picker.'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-primary';
    confirmBtn.textContent = 'Restore Client';
    actions.appendChild(confirmBtn);

    var cancelBtnEl = document.createElement('button');
    cancelBtnEl.type = 'button';
    cancelBtnEl.className = 'admin-btn admin-btn-outline';
    cancelBtnEl.textContent = 'Cancel';
    cancelBtnEl.addEventListener('click', closeSheet);
    actions.appendChild(cancelBtnEl);

    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Restoring…';

      adminFetch('/api/admin/client', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentClientId, action: 'restore' }),
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/admin/login/';
            return null;
          }
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not restore this client.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeSheet();
          currentClient = Object.assign({}, currentClient, body);
          renderArchiveState(currentClient);
          showToast('Client restored.', 'success');
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not restore this client.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Restore Client';
        });
    });

    sheetOverlay.removeAttribute('hidden');
  }

  archiveBtn.addEventListener('click', openArchiveSheet);
  restoreBtn.addEventListener('click', openRestoreSheet);

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

  // A back-navigation restored from bfcache can show a stale client record
  // — force a clean reload, same reasoning as admin/dashboard.js and
  // admin/schedule.js.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
