// /admin/invoices/ — Invoices list (Phase 2, Core Invoicing).
//
// Unlike every other filterable list in this app (Requests/Expenses/etc.,
// which re-fetch per filter), this page fetches GET /api/admin/bookings
// ?view=invoices exactly ONCE and does every filter — status pill AND
// search — entirely client-side over that one cached array. That endpoint
// already returns every invoice with its derived displayStatus/isOverdue
// precomputed (api/_lib/invoice-helpers.js's deriveInvoiceStatus(), the
// same helper the invoice detail page uses) — there is no pagination to
// fight with yet (see that endpoint's own header), so re-fetching per
// filter would just be extra network round trips for data already in
// hand.
document.addEventListener('DOMContentLoaded', function () {
  var SEARCH_DEBOUNCE_MS = 200;
  var STATUS_LABELS = {
    draft: 'Draft',
    finalized: 'Finalized',
    partially_paid: 'Partially Paid',
    paid: 'Paid',
    void: 'Void',
  };

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('invoice-list');
  var logoutBtn = document.getElementById('logout-btn');
  var searchInput = document.getElementById('invoice-search');
  var filterBar = document.getElementById('filter-bar');

  var allInvoices = [];
  var currentStatus = '';
  var currentSearch = '';
  var debounceTimer = null;

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderInvoiceRow(inv) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'admin-booking-card admin-invoice-row';
    a.href = '/admin/invoice/?id=' + encodeURIComponent(inv.id);

    var main = el('div', 'admin-invoice-row-main');
    main.appendChild(el('div', 'admin-invoice-row-number', inv.invoiceNumber || 'Draft Invoice'));
    main.appendChild(el('div', 'admin-invoice-row-client', inv.customerName || 'Unnamed client'));
    a.appendChild(main);

    var meta = el('div', 'admin-invoice-row-meta');
    var badges = el('div', 'admin-invoice-row-badges');
    var statusBadge = el('span', 'admin-status-badge admin-invoice-status-' + inv.displayStatus, STATUS_LABELS[inv.displayStatus] || inv.displayStatus);
    badges.appendChild(statusBadge);
    if (inv.isOverdue) badges.appendChild(el('span', 'admin-overdue-badge', 'Overdue'));
    meta.appendChild(badges);
    var amountText = inv.displayStatus === 'draft' || inv.displayStatus === 'void' ? formatPrice(inv.totalAmount) : formatPrice(inv.balanceDue) + ' due';
    meta.appendChild(el('span', 'admin-invoice-row-amount', amountText || '$0.00'));
    if (inv.dueDate) meta.appendChild(el('span', 'admin-client-row-meta-text', 'Due ' + formatDate(inv.dueDate)));
    a.appendChild(meta);

    li.appendChild(a);
    return li;
  }

  function matchesSearch(inv, search) {
    if (!search) return true;
    var haystack = ((inv.invoiceNumber || '') + ' ' + (inv.customerName || '')).toLowerCase();
    return haystack.indexOf(search) !== -1;
  }
  function matchesStatus(inv, status) {
    if (!status) return true;
    if (status === 'overdue') return !!inv.isOverdue;
    return inv.displayStatus === status;
  }

  function updateCounts() {
    var counts = { all: allInvoices.length, draft: 0, finalized: 0, partially_paid: 0, paid: 0, overdue: 0, void: 0 };
    allInvoices.forEach(function (inv) {
      if (counts[inv.displayStatus] !== undefined) counts[inv.displayStatus]++;
      if (inv.isOverdue) counts.overdue++;
    });
    Object.keys(counts).forEach(function (key) {
      var node = document.getElementById('count-' + key);
      if (node) node.textContent = counts[key];
    });
  }

  function applyFiltersAndRender() {
    var search = currentSearch.toLowerCase();
    var filtered = allInvoices.filter(function (inv) {
      return matchesStatus(inv, currentStatus) && matchesSearch(inv, search);
    });

    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (!filtered.length) {
      emptyEl.textContent = allInvoices.length ? 'No invoices match your filters.' : 'No invoices yet.';
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    filtered.forEach(function (inv) {
      listEl.appendChild(renderInvoiceRow(inv));
    });
  }

  function setActivePill(status) {
    var pills = filterBar.querySelectorAll('.admin-filter-pill[data-status]');
    for (var i = 0; i < pills.length; i++) {
      var isActive = pills[i].getAttribute('data-status') === status;
      pills[i].classList.toggle('is-active', isActive);
      pills[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function load() {
    return adminFetch('/api/admin/bookings?view=invoices')
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load invoices.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        loadingEl.style.display = 'none';
        clearError();
        allInvoices = body.invoices || [];
        updateCounts();
        applyFiltersAndRender();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load invoices.');
      });
  }

  filterBar.addEventListener('click', function (e) {
    var pill = e.target.closest('.admin-filter-pill[data-status]');
    if (!pill) return;
    var status = pill.getAttribute('data-status');
    if (status === currentStatus) return;
    currentStatus = status;
    setActivePill(status);
    applyFiltersAndRender();
  });

  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    var value = searchInput.value;
    debounceTimer = setTimeout(function () {
      currentSearch = value.trim();
      applyFiltersAndRender();
    }, SEARCH_DEBOUNCE_MS);
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { window.location.href = '/admin/login/'; });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  load();
});
