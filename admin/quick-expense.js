// Daily Quick Expense Tracking — Phase 3C Stage 2.4 addendum. Originally
// mounted under the Month view's selected-day panel only; Stage 2.4.2
// (Schedule UX polish) relocated it to a single persistent bar directly
// under the Schedule range tabs (#quick-expense-bar in admin/index.html) so
// it's always in the same place regardless of range — see showBar()/
// hideBar() below, called by admin/schedule.js (Today/Tomorrow/Yesterday/
// day-nav) and admin/calendar-views.js (Week/Month's selected day; hidden
// entirely on Year, which has no single day in view).
//
// Tracking only: this file computes nothing beyond a plain same-day sum
// for the "Tracked expenses: $X" line — never a total described as Profit,
// Net Profit, or any other measure of profitability. Talks to
// api/admin/bookings.js's ?view=expenses / POST {resource:"expense"}
// endpoints, which depend on a production `expenses` table that does NOT
// exist yet as of this stage (see
// docs/phase-3/stage2.4-expenses-migration.md) — a load/save failure here
// is shown as a small, calm inline message and never blocks or hides the
// job schedule above it, which stays fully functional either way.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
window.AdminQuickExpense = (function () {
  // Mirrors api/_lib/expense-categories.js's EXPENSE_CATEGORIES — the
  // server independently re-validates every category against its own copy
  // regardless of what this file sends, per this project's established
  // convention of a small deliberate client-side copy (see
  // api/_lib/historical-floor.js's header) rather than a module shared
  // across runtimes.
  // Stable DB keys unchanged by the Stage 3 category expansion — only
  // labels and the "+ More" list grew; see expense-categories.js's header
  // for why keys are never renamed once persisted.
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
  var QUICK_BUTTONS = [
    { category: 'fuel', label: 'Fuel', icon: '⛽' },
    { category: 'dump_fees', label: 'Dump', icon: '🗑' },
    { category: 'meals', label: 'Meal', icon: '🍔' },
  ];
  var MORE_CATEGORIES = ['labor', 'repairs_maintenance', 'advertising', 'subcontractor', 'vehicle', 'disposal_recycling', 'supplies', 'miscellaneous'];

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
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ---------------------------------------------------------------------
  // Small bottom sheet, reusing the exact .admin-sheet-overlay/.admin-sheet
  // chrome admin/client-picker.js and admin/status-ui.js already
  // established, rather than a new modal pattern.
  // ---------------------------------------------------------------------
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

  // category/dateIso are fixed for this sheet; onSaved(expense) is called
  // once the POST succeeds, so the caller (mount()) can refresh its list
  // without a full page reload.
  function renderAmountForm(category, dateIso, onSaved) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'Add Expense'));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }

    var categoryRow = el('div', 'admin-field');
    categoryRow.appendChild(el('label', null, 'Category'));
    categoryRow.appendChild(el('div', 'admin-quick-expense-readonly', CATEGORY_LABELS[category] || category));
    sheet.appendChild(categoryRow);

    var dateRow = el('div', 'admin-field');
    dateRow.appendChild(el('label', null, 'Date'));
    dateRow.appendChild(el('div', 'admin-quick-expense-readonly', formatDateLabel(dateIso)));
    sheet.appendChild(dateRow);

    var amountRow = el('div', 'admin-field');
    amountRow.appendChild(el('label', 'admin-field-required-label', 'Amount'));
    var amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.inputMode = 'decimal';
    amountInput.min = '0.01';
    amountInput.step = '0.01';
    amountInput.placeholder = 'e.g. 42.00';
    amountRow.appendChild(amountInput);
    sheet.appendChild(amountRow);

    var noteRow = el('div', 'admin-field');
    noteRow.appendChild(el('label', null, 'Note (optional)'));
    var noteInput = document.createElement('textarea');
    noteInput.rows = 2;
    noteRow.appendChild(noteInput);
    sheet.appendChild(noteRow);

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

    setTimeout(function () { amountInput.focus(); }, 0);

    saveBtn.addEventListener('click', function () {
      errorBox.classList.remove('is-visible');
      var amountRaw = amountInput.value.trim();
      if (!amountRaw || !(Number(amountRaw) > 0)) {
        showError('Please enter an amount.');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      adminFetch('/api/admin/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'expense',
          expenseDate: dateIso,
          category: category,
          amount: Number(amountRaw),
          note: noteInput.value.trim(),
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
              if (!res.ok) throw new Error((body && body.error) || 'Could not save this expense.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeSheet();
          if (onSaved) onSaved(body.expense);
        })
        .catch(function (err) {
          showError(err && err.message ? err.message : 'Could not save this expense.');
        })
        .finally(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        });
    });
  }

  function renderCategoryChooser(dateIso, onSaved) {
    clearSheet();
    sheet.appendChild(el('div', 'admin-sheet-title', 'More Categories'));

    var list = el('div', 'admin-sheet-list');
    MORE_CATEGORIES.forEach(function (category) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-sheet-option';
      btn.appendChild(el('span', 'admin-sheet-option-label', CATEGORY_LABELS[category] || category));
      btn.addEventListener('click', function () {
        renderAmountForm(category, dateIso, onSaved);
      });
      list.appendChild(btn);
    });
    sheet.appendChild(list);

    var cancelBtn = el('button', 'admin-sheet-cancel', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closeSheet);
    sheet.appendChild(cancelBtn);
  }

  function openAmountSheet(category, dateIso, onSaved) {
    ensureSheetDom();
    renderAmountForm(category, dateIso, onSaved);
    openSheet();
  }
  function openCategoryChooserSheet(dateIso, onSaved) {
    ensureSheetDom();
    renderCategoryChooser(dateIso, onSaved);
    openSheet();
  }

  // ---------------------------------------------------------------------
  // Day panel section: quick-tap row + "Tracked expenses: $X" + compact
  // list. Re-fetches from scratch on mount() (called fresh each time a
  // different calendar day is selected) and after every successful save —
  // never assumes the previous day's data locally.
  // ---------------------------------------------------------------------
  function mount(container, dateIso) {
    while (container.firstChild) container.removeChild(container.firstChild);

    // The bar now sits above every range's own date display (Stage 2.4.2),
    // so the heading names its own date directly rather than relying on a
    // date heading elsewhere on the page to give it context.
    var heading = el('div', 'admin-form-section-label', 'Quick Expense — ' + formatDateLabel(dateIso));
    container.appendChild(heading);

    var quickRow = el('div', 'admin-quick-expense-row');
    container.appendChild(quickRow);

    function refresh() {
      loadAndRender();
    }

    QUICK_BUTTONS.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-quick-expense-btn';
      btn.appendChild(el('span', 'admin-quick-expense-btn-icon', item.icon));
      btn.appendChild(el('span', 'admin-quick-expense-btn-label', item.label));
      btn.addEventListener('click', function () {
        openAmountSheet(item.category, dateIso, refresh);
      });
      quickRow.appendChild(btn);
    });

    var moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'admin-quick-expense-btn';
    moreBtn.appendChild(el('span', 'admin-quick-expense-btn-icon', '＋'));
    moreBtn.appendChild(el('span', 'admin-quick-expense-btn-label', 'More'));
    moreBtn.addEventListener('click', function () {
      openCategoryChooserSheet(dateIso, refresh);
    });
    quickRow.appendChild(moreBtn);

    var summaryEl = el('div', 'admin-quick-expense-summary');
    summaryEl.style.display = 'none';
    container.appendChild(summaryEl);

    var listEl = el('ul', 'admin-quick-expense-list');
    container.appendChild(listEl);

    var noteEl = el('div', 'admin-field-hint');
    noteEl.style.display = 'none';
    container.appendChild(noteEl);

    function loadAndRender() {
      noteEl.style.display = 'none';
      adminFetch('/api/admin/bookings?view=expenses&startDate=' + encodeURIComponent(dateIso) + '&endDate=' + encodeURIComponent(dateIso))
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/admin/login/';
            return null;
          }
          return res
            .json()
            .catch(function () { return null; })
            .then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || 'Could not load expenses.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          renderList(body.expenses || []);
        })
        .catch(function () {
          // Non-blocking: the job schedule above this panel is unaffected.
          // Most likely cause at this stage is simply that the `expenses`
          // table hasn't been created in production yet (see
          // docs/phase-3/stage2.4-expenses-migration.md) — this message
          // stays generic rather than guessing, since a real transient
          // error would look identical here.
          summaryEl.style.display = 'none';
          while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
          noteEl.textContent = 'Could not load expenses for this date right now.';
          noteEl.style.display = 'block';
        });
    }

    function renderList(expenses) {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      if (!expenses.length) {
        summaryEl.style.display = 'none';
        return;
      }
      var total = expenses.reduce(function (sum, e) { return sum + (Number(e.amount) || 0); }, 0);
      summaryEl.textContent = 'Tracked expenses: ' + formatPrice(total);
      summaryEl.style.display = 'block';

      expenses.forEach(function (e) {
        var li = document.createElement('li');
        li.className = 'admin-quick-expense-item';
        li.appendChild(el('span', 'admin-quick-expense-item-category', e.categoryLabel || e.category));
        li.appendChild(el('span', 'admin-quick-expense-item-amount', formatPrice(e.amount)));
        if (e.note) li.appendChild(el('span', 'admin-quick-expense-item-note', e.note));
        listEl.appendChild(li);
      });
    }

    loadAndRender();
  }

  // ---------------------------------------------------------------------
  // Persistent top-of-page bar (Stage 2.4.2) — the single #quick-expense-bar
  // element in admin/index.html, directly under the Schedule range tabs.
  // showBar() just re-mount()s into it (mount() already rebuilds its
  // container from scratch and re-fetches, so switching which date is
  // "active" is simply calling this again with a new dateIso); hideBar()
  // clears and hides it for ranges with no single day in view.
  // ---------------------------------------------------------------------
  function showBar(dateIso) {
    var bar = document.getElementById('quick-expense-bar');
    if (!bar) return;
    bar.hidden = false;
    mount(bar, dateIso);
  }
  function hideBar() {
    var bar = document.getElementById('quick-expense-bar');
    if (!bar) return;
    bar.hidden = true;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
  }

  return { mount: mount, showBar: showBar, hideBar: hideBar };
})();
