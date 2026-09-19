// /admin/expenses — Phase 3C Stage 3 full Expense Management. Add/view/
// edit/void, search/filter/sort, job-linking, and a per-expense audit-
// history view. Talks to api/admin/bookings.js's expense handlers
// (?view=expenses / resource:"expense" POST+PATCH / ?view=expense-audit /
// ?view=job-search) — see that file for the full validation/write
// contract. Quick Expense (admin/quick-expense.js) stays the fast one-tap
// entry surface on Schedule; this page is where entries get managed.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  // Mirrors api/_lib/expense-categories.js's EXPENSE_CATEGORIES — the
  // server independently re-validates regardless of what this file sends,
  // per this project's established convention of a small deliberate
  // client-side copy rather than a module shared across runtimes.
  var CATEGORY_LABELS = {
    fuel: 'Fuel',
    dump_fees: 'Dump Fee',
    labor: 'Labor',
    supplies: 'Supplies',
    repairs_maintenance: 'Equipment / Repair',
    advertising: 'Advertising / Marketing',
    subcontractor: 'Subcontractor',
    vehicle: 'Vehicle',
    disposal_recycling: 'Disposal / Recycling',
    meals: 'Meals',
    miscellaneous: 'Other',
  };
  var CATEGORY_ORDER = ['fuel', 'dump_fees', 'labor', 'supplies', 'repairs_maintenance', 'advertising', 'subcontractor', 'vehicle', 'disposal_recycling', 'meals', 'miscellaneous'];

  // Mirrors api/_lib/job-payments-ledger.js's VALID_PAYMENT_METHODS.
  // "card_stripe" is relabeled "Card" here — for an EXPENSE (how the
  // business paid a vendor) this just means "paid by card," unlike
  // job_payments.payment_method's card_stripe, which specifically means
  // "the customer's Stripe checkout" and is never a choice a human picks.
  var PAYMENT_METHOD_LABELS = { card_stripe: 'Card', cash: 'Cash', zelle: 'Zelle', venmo: 'Venmo', check: 'Check' };
  var PAYMENT_METHOD_ORDER = ['cash', 'card_stripe', 'zelle', 'venmo', 'check'];

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('expense-list');
  var totalSummaryEl = document.getElementById('expense-total-summary');
  var logoutBtn = document.getElementById('logout-btn');
  var addBtn = document.getElementById('add-expense-btn');

  var filterStartDate = document.getElementById('filter-start-date');
  var filterEndDate = document.getElementById('filter-end-date');
  var filterCategory = document.getElementById('filter-category');
  var filterPaymentMethod = document.getElementById('filter-payment-method');
  var filterSearch = document.getElementById('filter-search');
  var filterSort = document.getElementById('filter-sort');
  var filterSortDir = document.getElementById('filter-sort-dir');
  var filterIncludeVoided = document.getElementById('filter-include-voided');

  CATEGORY_ORDER.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = CATEGORY_LABELS[key];
    filterCategory.appendChild(opt);
  });
  PAYMENT_METHOD_ORDER.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PAYMENT_METHOD_LABELS[key];
    filterPaymentMethod.appendChild(opt);
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
  function formatDateTimeLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
  // Bottom sheet (Add / Edit / Void / History) — same
  // .admin-sheet-overlay/.admin-sheet chrome admin/quick-expense.js,
  // admin/client-picker.js, and admin/status-ui.js already established.
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
  // same "search -> pick -> summary with a clear option" shape as
  // admin/client-picker.js, just implemented locally here since this is
  // the only place in the admin UI that needs to pick a JOB (not a
  // client).
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
        fetch('/api/admin/bookings?view=job-search&q=' + encodeURIComponent(q))
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

  function renderAddOrEditForm(existing, onSaved) {
    clearSheet();
    var isEdit = !!existing;
    sheet.appendChild(el('div', 'admin-sheet-title', isEdit ? 'Edit Expense' : 'Add Expense'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showFormError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }

    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = (existing && existing.expenseDate) || denverTodayIso();
    dateInput.max = denverTodayIso();
    sheet.appendChild(fieldRow('Date', dateInput));

    var categorySelect = selectEl(
      CATEGORY_ORDER.map(function (k) { return { value: k, label: CATEGORY_LABELS[k] }; }),
      (existing && existing.category) || 'fuel'
    );
    sheet.appendChild(fieldRow('Category', categorySelect));

    var amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.inputMode = 'decimal';
    amountInput.min = '0.01';
    amountInput.step = '0.01';
    amountInput.placeholder = 'e.g. 42.00';
    if (existing) amountInput.value = existing.amount;
    sheet.appendChild(fieldRow('Amount', amountInput));

    var vendorInput = document.createElement('input');
    vendorInput.type = 'text';
    vendorInput.maxLength = 120;
    vendorInput.placeholder = 'e.g. Denver Dump Co.';
    if (existing && existing.vendor) vendorInput.value = existing.vendor;
    sheet.appendChild(fieldRow('Vendor / Payee (optional)', vendorInput));

    var paymentMethodSelect = selectEl(
      [{ value: '', label: 'Not specified' }].concat(PAYMENT_METHOD_ORDER.map(function (k) { return { value: k, label: PAYMENT_METHOD_LABELS[k] }; })),
      (existing && existing.paymentMethod) || ''
    );
    sheet.appendChild(fieldRow('Payment Method (optional)', paymentMethodSelect));

    var receiptInput = document.createElement('input');
    receiptInput.type = 'text';
    receiptInput.maxLength = 120;
    receiptInput.placeholder = 'e.g. receipt #, where it is filed';
    if (existing && existing.receiptReference) receiptInput.value = existing.receiptReference;
    sheet.appendChild(fieldRow('Receipt Reference (optional)', receiptInput));

    var noteInput = document.createElement('textarea');
    noteInput.rows = 2;
    if (existing && existing.note) noteInput.value = existing.note;
    sheet.appendChild(fieldRow('Note (optional)', noteInput));

    var jobPicker = buildJobPicker(existing && existing.bookingId, existing && existing.job && existing.job.label);
    sheet.appendChild(jobPicker.el);

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'admin-btn admin-btn-primary';
    saveBtn.textContent = isEdit ? 'Save Changes' : 'Save';
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
        resource: 'expense',
        expenseDate: dateInput.value,
        category: categorySelect.value,
        amount: Number(amountRaw),
        vendor: vendorInput.value.trim(),
        paymentMethod: paymentMethodSelect.value || null,
        receiptReference: receiptInput.value.trim(),
        note: noteInput.value.trim(),
        bookingId: jobPicker.getBookingId(),
      };
      if (isEdit) payload.id = existing.id;

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      fetch('/api/admin/bookings', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (handleAuthRedirect(res)) return null;
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not save this expense.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return;
          closeSheet();
          if (onSaved) onSaved(body.expense);
        })
        .catch(function (err) {
          showFormError(err && err.message ? err.message : 'Could not save this expense.');
        })
        .finally(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = isEdit ? 'Save Changes' : 'Save';
        });
    });
  }

  function renderVoidForm(expense, onVoided) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'Void Expense'));
    sheet.appendChild(el('p', 'admin-field-hint', 'This expense (' + formatPrice(expense.amount) + ' — ' + (CATEGORY_LABELS[expense.category] || expense.category) + ') will be marked voided and excluded from totals. It stays in the record permanently — voiding never deletes it.'));

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
    voidBtn.textContent = 'Void Expense';
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
      fetch('/api/admin/bookings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'expense', id: expense.id, action: 'void', reason: reason }),
      })
        .then(function (res) {
          if (handleAuthRedirect(res)) return null;
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not void this expense.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return;
          closeSheet();
          if (onVoided) onVoided(body.expense);
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not void this expense.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          voidBtn.disabled = false;
          voidBtn.textContent = 'Void Expense';
        });
    });
  }

  function renderHistoryView(expense) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'History — ' + (CATEGORY_LABELS[expense.category] || expense.category) + ' ' + formatPrice(expense.amount)));

    var listWrap = el('div', 'admin-expense-history-list');
    listWrap.appendChild(el('p', 'admin-field-hint', 'Loading history…'));
    sheet.appendChild(listWrap);

    var cancelBtn = el('button', 'admin-sheet-cancel', 'Close');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closeSheet);
    sheet.appendChild(cancelBtn);

    fetch('/api/admin/bookings?view=expense-audit&expenseId=' + encodeURIComponent(expense.id))
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load history.');
            return body;
          });
      })
      .then(function (body) {
        if (!body) return;
        while (listWrap.firstChild) listWrap.removeChild(listWrap.firstChild);
        if (!body.history.length) {
          listWrap.appendChild(el('p', 'admin-field-hint', 'No history recorded yet.'));
          return;
        }
        body.history.forEach(function (h) {
          var row = el('div', 'admin-expense-history-row');
          var top = el('div', 'admin-expense-history-row-top');
          top.appendChild(el('span', 'admin-expense-history-when', formatDateTimeLabel(h.changedAt)));
          if (h.changedBy) top.appendChild(el('span', 'admin-expense-history-who', h.changedBy));
          row.appendChild(top);

          var desc;
          if (h.changeType === 'create') {
            desc = 'Expense created';
          } else if (h.changeType === 'void') {
            desc = 'Voided — ' + (h.newValue || '');
          } else {
            desc = (h.fieldLabel || h.fieldName) + ': ' + (h.oldValue || '—') + ' → ' + (h.newValue || '—');
          }
          row.appendChild(el('div', 'admin-expense-history-desc', desc));
          listWrap.appendChild(row);
        });
      })
      .catch(function (err) {
        while (listWrap.firstChild) listWrap.removeChild(listWrap.firstChild);
        listWrap.appendChild(el('p', 'admin-field-hint', err && err.message ? err.message : 'Could not load history.'));
      });
  }

  function openAddSheet() {
    ensureSheetDom();
    renderAddOrEditForm(null, function () {
      loadList();
    });
    openSheet();
  }
  function openEditSheet(expense) {
    ensureSheetDom();
    renderAddOrEditForm(expense, function () {
      loadList();
    });
    openSheet();
  }
  function openVoidSheet(expense) {
    ensureSheetDom();
    renderVoidForm(expense, function () {
      loadList();
    });
    openSheet();
  }
  function openHistorySheet(expense) {
    ensureSheetDom();
    renderHistoryView(expense);
    openSheet();
  }

  // -----------------------------------------------------------------
  // List rendering
  // -----------------------------------------------------------------
  function renderExpenseCard(e) {
    var li = document.createElement('li');
    var card = el('div', 'admin-expense-row' + (e.isVoided ? ' is-voided' : ''));

    var top = el('div', 'admin-charge-row-top');
    var left = el('div', 'admin-card-top-left');
    left.appendChild(el('span', 'admin-expense-category-badge', CATEGORY_LABELS[e.category] || e.category));
    if (e.isVoided) left.appendChild(el('span', 'admin-status-badge admin-status-lost', 'VOIDED'));
    top.appendChild(left);
    top.appendChild(el('div', 'admin-charge-row-amount', formatPrice(e.amount)));
    card.appendChild(top);

    var metaParts = [formatDateLabel(e.expenseDate)];
    if (e.vendor) metaParts.push(e.vendor);
    if (e.paymentMethod) metaParts.push(PAYMENT_METHOD_LABELS[e.paymentMethod] || e.paymentMethod);
    card.appendChild(el('div', 'admin-charge-row-meta', metaParts.join(' · ')));

    if (e.note) card.appendChild(el('div', 'admin-expense-note', e.note));
    if (e.job) {
      var jobLine = el('div', 'admin-expense-job-link');
      jobLine.appendChild(el('span', null, 'Job: '));
      var jobLink = document.createElement('a');
      jobLink.href = '/admin/booking/?id=' + encodeURIComponent(e.bookingId);
      jobLink.textContent = e.job.label;
      jobLine.appendChild(jobLink);
      card.appendChild(jobLine);
    }
    if (e.isVoided && e.voidedReason) {
      card.appendChild(el('div', 'admin-expense-void-reason', 'Voided: ' + e.voidedReason));
    }

    var actions = el('div', 'admin-expense-actions');
    var historyBtn = document.createElement('button');
    historyBtn.type = 'button';
    historyBtn.className = 'admin-btn admin-btn-outline';
    historyBtn.textContent = 'History';
    historyBtn.addEventListener('click', function () { openHistorySheet(e); });
    actions.appendChild(historyBtn);

    if (!e.isVoided) {
      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'admin-btn admin-btn-outline';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openEditSheet(e); });
      actions.appendChild(editBtn);

      var voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'admin-btn admin-btn-danger';
      voidBtn.textContent = 'Void';
      voidBtn.addEventListener('click', function () { openVoidSheet(e); });
      actions.appendChild(voidBtn);
    }
    card.appendChild(actions);

    li.appendChild(card);
    return li;
  }

  var requestSeq = 0;
  var searchDebounce = null;

  function buildQuery() {
    var params = new URLSearchParams();
    params.set('view', 'expenses');
    params.set('startDate', filterStartDate.value || firstOfMonthIso(denverTodayIso()));
    params.set('endDate', filterEndDate.value || denverTodayIso());
    if (filterCategory.value) params.set('category', filterCategory.value);
    if (filterPaymentMethod.value) params.set('paymentMethod', filterPaymentMethod.value);
    if (filterSearch.value.trim()) params.set('search', filterSearch.value.trim());
    params.set('sort', filterSort.value);
    params.set('sortDir', filterSortDir.value);
    if (filterIncludeVoided.checked) params.set('includeVoided', '1');
    return params.toString();
  }

  function loadList() {
    var seq = ++requestSeq;
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    listEl.style.display = 'none';

    fetch('/api/admin/bookings?' + buildQuery())
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load expenses.');
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        clearError();

        totalSummaryEl.textContent = 'Total for selected period: ' + formatPrice(body.totalAmount) + ' (' + body.total + (body.total === 1 ? ' expense' : ' expenses') + ')';

        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        if (!body.expenses.length) {
          emptyEl.style.display = 'block';
          listEl.style.display = 'none';
        } else {
          listEl.style.display = 'flex';
          body.expenses.forEach(function (e) {
            listEl.appendChild(renderExpenseCard(e));
          });
        }
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load expenses.');
      });
  }

  // -----------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------
  var todayIso = denverTodayIso();
  filterStartDate.value = firstOfMonthIso(todayIso);
  filterEndDate.value = todayIso;
  filterStartDate.max = todayIso;
  filterEndDate.max = todayIso;

  [filterStartDate, filterEndDate, filterCategory, filterPaymentMethod, filterSort, filterSortDir, filterIncludeVoided].forEach(function (input) {
    input.addEventListener('change', loadList);
  });
  filterSearch.addEventListener('input', function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadList, 300);
  });

  addBtn.addEventListener('click', openAddSheet);

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

  loadList();
});
