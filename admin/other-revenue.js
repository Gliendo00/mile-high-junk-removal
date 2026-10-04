// /admin/other-revenue — Phase 3C Stage 6 (Batch 3): Metal Recycling, Resale
// Sales. Split out of admin/expenses.js onto its own page/nav destination
// (was a same-page tab there) — see admin/admin-chrome.js's SECTIONS entry.
// Talks to api/admin/bookings.js's ?view=other-revenue (GET) /
// resource:"other-revenue" (POST create, PATCH void) — completely
// untouched by this split, same backend contract as before. Unlike
// Expenses, there is no "update" action at all: a wrong entry is corrected
// by voiding it (reason required) and recording a new, correct one — same
// append-only guarantee job_payments makes — so there is no Edit sheet and
// no per-entry History view.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  var OTHER_REVENUE_TYPE_LABELS = { metal_recycling: 'Metal Recycling', resale_sale: 'Resale Sales' };
  var OTHER_REVENUE_TYPE_ORDER = ['metal_recycling', 'resale_sale'];

  var errorBanner = document.getElementById('error-banner');
  var logoutBtn = document.getElementById('logout-btn');

  var orLoadingEl = document.getElementById('or-loading');
  var orEmptyEl = document.getElementById('or-empty');
  var orListEl = document.getElementById('other-revenue-list');
  var orTotalSummaryEl = document.getElementById('other-revenue-total-summary');
  var addOtherRevenueBtn = document.getElementById('add-other-revenue-btn');

  var orFilterStartDate = document.getElementById('or-filter-start-date');
  var orFilterEndDate = document.getElementById('or-filter-end-date');
  var orFilterType = document.getElementById('or-filter-type');
  var orFilterIncludeVoided = document.getElementById('or-filter-include-voided');

  OTHER_REVENUE_TYPE_ORDER.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = OTHER_REVENUE_TYPE_LABELS[key];
    orFilterType.appendChild(opt);
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function formatPrice(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '$0.00';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatDateLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function firstOfMonthIso(todayIso) {
    return todayIso.slice(0, 8) + '01';
  }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function handleAuthRedirect(res) {
    if (res.status === 401) {
      window.location.href = '/admin/login/';
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------
  // Bottom sheet (Add / Void) — same .admin-sheet-overlay/.admin-sheet
  // chrome admin/expenses.js, admin/quick-expense.js, admin/client-picker.js,
  // and admin/status-ui.js already established.
  // -----------------------------------------------------------------
  var overlay = null;
  var sheet = null;
  function ensureSheetDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'admin-sheet-overlay';
    overlay.setAttribute('hidden', '');
    sheet = document.createElement('div');
    sheet.className = 'admin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    overlay.appendChild(sheet);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) closeSheet();
    });
    document.body.appendChild(overlay);
  }
  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }
  function openSheet() {
    overlay.removeAttribute('hidden');
  }
  function closeSheet() {
    if (!overlay) return;
    overlay.setAttribute('hidden', '');
    clearSheet();
  }

  function fieldRow(labelText, inputEl) {
    var row = el('div', 'admin-field');
    row.appendChild(el('label', null, labelText));
    row.appendChild(inputEl);
    return row;
  }
  function selectEl(options, selectedValue) {
    var s = document.createElement('select');
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === selectedValue) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  // Job-link picker: a text input + live results list, backed by
  // ?view=job-search. Selecting a result stores its id in a hidden field
  // and shows a small "linked to <label>" summary with a way to clear it —
  // same shape as admin/client-picker.js, just implemented locally since
  // this is the only place here that needs to pick a JOB (not a client).
  // Identical copy to admin/expenses.js's own buildJobPicker() — both
  // files keep their own, matching this project's established convention
  // of small per-file helpers over a premature shared module.
  function buildJobPicker(initialBookingId, initialLabel) {
    var wrap = el('div', 'admin-field');
    wrap.appendChild(el('label', null, 'Linked Job (optional)'));

    var selectedId = initialBookingId || null;
    var summary = el('div', 'admin-quick-expense-readonly');
    var searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search by client name or phone';
    searchInput.autocomplete = 'off';
    var resultsList = el('div', 'admin-sheet-list');
    resultsList.style.display = 'none';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'admin-btn admin-btn-outline';
    clearBtn.textContent = 'Change / Remove';
    clearBtn.style.marginTop = '6px';

    function showSummary(label) {
      summary.textContent = label ? 'Linked to: ' + label : 'Not linked to a job';
      summary.style.display = 'block';
      searchInput.style.display = 'none';
      resultsList.style.display = 'none';
      clearBtn.style.display = 'inline-block';
    }
    function showSearch() {
      summary.style.display = 'none';
      searchInput.style.display = 'block';
      clearBtn.style.display = 'none';
      searchInput.value = '';
      resultsList.style.display = 'none';
    }

    var debounceTimer = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var q = searchInput.value.trim();
      if (q.length < 2) {
        resultsList.style.display = 'none';
        return;
      }
      debounceTimer = setTimeout(function () {
        adminFetch('/api/admin/bookings?view=job-search&q=' + encodeURIComponent(q))
          .then(function (res) {
            if (handleAuthRedirect(res)) return null;
            return res.json().catch(function () { return null; });
          })
          .then(function (body) {
            if (!body) return;
            while (resultsList.firstChild) resultsList.removeChild(resultsList.firstChild);
            if (!body.jobs || !body.jobs.length) {
              resultsList.appendChild(el('div', 'admin-sheet-option-label', 'No matching jobs'));
              resultsList.style.display = 'block';
              return;
            }
            body.jobs.forEach(function (job) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'admin-sheet-option';
              btn.appendChild(el('span', 'admin-sheet-option-label', job.label));
              btn.addEventListener('click', function () {
                selectedId = job.id;
                showSummary(job.label);
              });
              resultsList.appendChild(btn);
            });
            resultsList.style.display = 'block';
          })
          .catch(function () {});
      }, 250);
    });

    clearBtn.addEventListener('click', function () {
      selectedId = null;
      showSearch();
    });

    wrap.appendChild(summary);
    wrap.appendChild(searchInput);
    wrap.appendChild(resultsList);
    wrap.appendChild(clearBtn);

    if (selectedId) showSummary(initialLabel || 'this job');
    else showSearch();

    return {
      el: wrap,
      getBookingId: function () { return selectedId; },
    };
  }

  function renderAddOtherRevenueForm(onSaved) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'Add Revenue'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showFormError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }

    var typeSelect = selectEl(
      OTHER_REVENUE_TYPE_ORDER.map(function (k) { return { value: k, label: OTHER_REVENUE_TYPE_LABELS[k] }; }),
      'metal_recycling'
    );
    sheet.appendChild(fieldRow('Type', typeSelect));

    var amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.inputMode = 'decimal';
    amountInput.min = '0.01';
    amountInput.step = '0.01';
    amountInput.placeholder = 'e.g. 185.00';
    sheet.appendChild(fieldRow('Amount', amountInput));

    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = denverTodayIso();
    dateInput.max = denverTodayIso();
    sheet.appendChild(fieldRow('Date', dateInput));

    var noteInput = document.createElement('textarea');
    noteInput.rows = 2;
    noteInput.placeholder = 'e.g. Scrap load, or item sold';
    sheet.appendChild(fieldRow('Description / Note (optional)', noteInput));

    var jobPicker = buildJobPicker(null, null);
    sheet.appendChild(jobPicker.el);

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'admin-btn admin-btn-primary';
    saveBtn.textContent = 'Save';
    actions.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeSheet);
    actions.appendChild(cancelBtn);

    saveBtn.addEventListener('click', function () {
      errorBox.classList.remove('is-visible');
      var amountRaw = amountInput.value.trim();
      if (!amountRaw || !(Number(amountRaw) > 0)) {
        showFormError('Please enter a valid amount.');
        return;
      }
      if (!dateInput.value) {
        showFormError('Please choose a date.');
        return;
      }

      var payload = {
        resource: 'other-revenue',
        type: typeSelect.value,
        amount: Number(amountRaw),
        revenueDate: dateInput.value,
        note: noteInput.value.trim(),
        bookingId: jobPicker.getBookingId(),
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      adminFetch('/api/admin/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (handleAuthRedirect(res)) return null;
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not save this revenue entry.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return;
          closeSheet();
          if (onSaved) onSaved(body.otherRevenue);
        })
        .catch(function (err) {
          showFormError(err && err.message ? err.message : 'Could not save this revenue entry.');
        })
        .finally(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        });
    });
  }

  function renderVoidOtherRevenueForm(entry, onVoided) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'Void Revenue Entry'));
    sheet.appendChild(
      el(
        'p',
        'admin-field-hint',
        'This entry (' +
          formatPrice(entry.amount) +
          ' — ' +
          (OTHER_REVENUE_TYPE_LABELS[entry.type] || entry.type) +
          ') will be marked voided and excluded from totals. It stays in the record permanently — voiding never deletes it.'
      )
    );

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);

    var reasonInput = document.createElement('textarea');
    reasonInput.rows = 2;
    reasonInput.placeholder = 'Why is this being voided? (required)';
    sheet.appendChild(fieldRow('Reason', reasonInput));

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var voidBtn = document.createElement('button');
    voidBtn.type = 'button';
    voidBtn.className = 'admin-btn admin-btn-danger';
    voidBtn.textContent = 'Void Entry';
    actions.appendChild(voidBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeSheet);
    actions.appendChild(cancelBtn);

    voidBtn.addEventListener('click', function () {
      var reason = reasonInput.value.trim();
      if (!reason) {
        errorBox.textContent = 'A reason is required.';
        errorBox.classList.add('is-visible');
        return;
      }
      voidBtn.disabled = true;
      voidBtn.textContent = 'Voiding…';
      adminFetch('/api/admin/bookings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'other-revenue', id: entry.id, reason: reason }),
      })
        .then(function (res) {
          if (handleAuthRedirect(res)) return null;
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not void this entry.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return;
          closeSheet();
          if (onVoided) onVoided(body.otherRevenue);
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not void this entry.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          voidBtn.disabled = false;
          voidBtn.textContent = 'Void Entry';
        });
    });
  }

  function openAddOtherRevenueSheet() {
    ensureSheetDom();
    renderAddOtherRevenueForm(function () {
      loadOtherRevenueList();
    });
    openSheet();
  }
  function openVoidOtherRevenueSheet(entry) {
    ensureSheetDom();
    renderVoidOtherRevenueForm(entry, function () {
      loadOtherRevenueList();
    });
    openSheet();
  }

  function renderOtherRevenueCard(r) {
    var li = document.createElement('li');
    var card = el('div', 'admin-expense-row' + (r.isVoided ? ' is-voided' : ''));

    var top = el('div', 'admin-charge-row-top');
    var left = el('div', 'admin-card-top-left');
    left.appendChild(el('span', 'admin-expense-category-badge', OTHER_REVENUE_TYPE_LABELS[r.type] || r.type));
    if (r.isVoided) left.appendChild(el('span', 'admin-status-badge admin-status-lost', 'VOIDED'));
    top.appendChild(left);
    top.appendChild(el('div', 'admin-charge-row-amount', formatPrice(r.amount)));
    card.appendChild(top);

    card.appendChild(el('div', 'admin-charge-row-meta', formatDateLabel(r.revenueDate)));

    if (r.note) card.appendChild(el('div', 'admin-expense-note', r.note));
    if (r.job) {
      var jobLine = el('div', 'admin-expense-job-link');
      jobLine.appendChild(el('span', null, 'Job: '));
      var jobLink = document.createElement('a');
      jobLink.href = '/admin/booking/?id=' + encodeURIComponent(r.bookingId);
      jobLink.textContent = r.job.label;
      jobLine.appendChild(jobLink);
      card.appendChild(jobLine);
    }
    if (r.isVoided && r.voidedReason) {
      card.appendChild(el('div', 'admin-expense-void-reason', 'Voided: ' + r.voidedReason));
    }

    if (!r.isVoided) {
      var actions = el('div', 'admin-expense-actions');
      var voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'admin-btn admin-btn-danger';
      voidBtn.textContent = 'Void';
      voidBtn.addEventListener('click', function () { openVoidOtherRevenueSheet(r); });
      actions.appendChild(voidBtn);
      card.appendChild(actions);
    }

    li.appendChild(card);
    return li;
  }

  var orRequestSeq = 0;

  function buildOtherRevenueQuery() {
    var params = new URLSearchParams();
    params.set('view', 'other-revenue');
    params.set('startDate', orFilterStartDate.value || firstOfMonthIso(denverTodayIso()));
    params.set('endDate', orFilterEndDate.value || denverTodayIso());
    if (orFilterType.value) params.set('type', orFilterType.value);
    if (orFilterIncludeVoided.checked) params.set('includeVoided', '1');
    return params.toString();
  }

  function loadOtherRevenueList() {
    var seq = ++orRequestSeq;
    orLoadingEl.style.display = 'block';
    orEmptyEl.style.display = 'none';
    orListEl.style.display = 'none';

    adminFetch('/api/admin/bookings?' + buildOtherRevenueQuery())
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load other revenue.');
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== orRequestSeq) return;
        orLoadingEl.style.display = 'none';
        clearError();

        while (orTotalSummaryEl.firstChild) orTotalSummaryEl.removeChild(orTotalSummaryEl.firstChild);
        orTotalSummaryEl.appendChild(el('span', 'admin-expense-total-label', 'Total for selected period'));
        var otherRevenueCountText = body.total + (body.total === 1 ? ' entry' : ' entries');
        orTotalSummaryEl.appendChild(el('span', 'admin-expense-total-value admin-expense-total-value-revenue', formatPrice(body.totalAmount)));
        orTotalSummaryEl.appendChild(el('span', 'admin-expense-total-count', otherRevenueCountText));

        while (orListEl.firstChild) orListEl.removeChild(orListEl.firstChild);
        if (!body.otherRevenue.length) {
          orEmptyEl.style.display = 'block';
          orListEl.style.display = 'none';
        } else {
          orListEl.style.display = 'flex';
          body.otherRevenue.forEach(function (r) {
            orListEl.appendChild(renderOtherRevenueCard(r));
          });
        }
      })
      .catch(function (err) {
        if (seq !== orRequestSeq) return;
        orLoadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load other revenue.');
      });
  }

  // -----------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------
  var todayIso = denverTodayIso();
  orFilterStartDate.value = firstOfMonthIso(todayIso);
  orFilterEndDate.value = todayIso;
  orFilterStartDate.max = todayIso;
  orFilterEndDate.max = todayIso;

  [orFilterStartDate, orFilterEndDate, orFilterType, orFilterIncludeVoided].forEach(function (input) {
    input.addEventListener('change', loadOtherRevenueList);
  });

  // ---------------------------------------------------------------
  // Mobile "Filters (N)" bottom sheet — identical pattern to
  // admin/expenses.js's own wireFilterSheet(), kept as its own copy here
  // rather than a shared import (this project's established convention).
  // Desktop never calls any of this (the toggle button is display:none
  // there, see admin.css); the filter fields themselves and their
  // existing change listeners above are completely untouched either way.
  // ---------------------------------------------------------------
  function wireFilterSheet(toggleBtn, panelEl, backdropEl, countFn) {
    function updateLabel() {
      var n = countFn();
      toggleBtn.textContent = n > 0 ? 'Filters (' + n + ')' : 'Filters';
    }
    function open() {
      panelEl.classList.add('is-open');
      backdropEl.hidden = false;
    }
    function close() {
      panelEl.classList.remove('is-open');
      backdropEl.hidden = true;
    }
    toggleBtn.addEventListener('click', function () {
      if (panelEl.classList.contains('is-open')) close(); else open();
    });
    backdropEl.addEventListener('click', close);
    panelEl.addEventListener('change', updateLabel);
    panelEl.addEventListener('input', updateLabel);
    updateLabel();
  }

  wireFilterSheet(
    document.getElementById('other-revenue-filters-toggle'),
    document.getElementById('other-revenue-filters'),
    document.getElementById('other-revenue-filters-backdrop'),
    function () {
      var n = 0;
      if (orFilterType.value) n++;
      if (orFilterIncludeVoided.checked) n++;
      if (orFilterStartDate.value !== firstOfMonthIso(todayIso) || orFilterEndDate.value !== todayIso) n++;
      return n;
    }
  );

  addOtherRevenueBtn.addEventListener('click', openAddOtherRevenueSheet);

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  loadOtherRevenueList();
});
