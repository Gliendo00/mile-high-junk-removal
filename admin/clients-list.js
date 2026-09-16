// /admin/clients — read-only, searchable client list.
//
// Every dynamic value below is written with textContent (never
// innerHTML/insertAdjacentHTML with a concatenated string), so a
// customer-supplied name/phone/email/city containing "<script>" or any
// other markup is rendered as inert text, never parsed as HTML — same
// discipline as admin/dashboard.js.
document.addEventListener('DOMContentLoaded', function () {
  var PAGE_SIZE = 50;
  var SEARCH_DEBOUNCE_MS = 300;

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('client-list');
  var loadMoreWrap = document.getElementById('load-more-wrap');
  var loadMoreBtn = document.getElementById('load-more-btn');
  var logoutBtn = document.getElementById('logout-btn');
  var searchInput = document.getElementById('client-search');

  var offset = 0;
  var currentSearch = '';
  var requestSeq = 0; // guards against an in-flight request resolving after a newer search
  var debounceTimer = null;

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderClientCard(c) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'admin-booking-card';
    a.href = '/admin/client/?id=' + encodeURIComponent(c.id);

    a.appendChild(el('div', 'admin-card-name', [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed client'));

    var contactParts = [];
    if (c.phone) contactParts.push(c.phone);
    if (c.city) contactParts.push(c.city);
    a.appendChild(el('div', 'admin-card-service', contactParts.length ? contactParts.join(' · ') : '—'));

    var jobParts = [c.bookingCount + (c.bookingCount === 1 ? ' job' : ' jobs')];
    if (c.lastJobDate) jobParts.push('Last: ' + formatDate(c.lastJobDate));
    a.appendChild(el('div', 'admin-card-when', jobParts.join(' · ')));

    var footer = el('div', 'admin-card-footer');
    footer.appendChild(el('span', null, c.email || ''));
    footer.appendChild(el('span', 'admin-card-view', 'View Client →'));
    a.appendChild(footer);

    li.appendChild(a);
    return li;
  }

  function resetAndLoad() {
    offset = 0;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    listEl.style.display = 'none';
    emptyEl.style.display = 'none';
    loadMoreWrap.style.display = 'none';
    loadingEl.style.display = 'block';
    loadPage();
  }

  function loadPage() {
    var seq = ++requestSeq;
    var url = '/api/admin/clients?limit=' + PAGE_SIZE + '&offset=' + offset;
    if (currentSearch) url += '&search=' + encodeURIComponent(currentSearch);

    return fetch(url)
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
              throw new Error((body && body.error) || 'Could not load clients.');
            }
            return body;
          });
      })
      .then(function (body) {
        if (!body || seq !== requestSeq) return; // redirected to login, or superseded by a newer search
        loadingEl.style.display = 'none';
        clearError();

        if (!body.clients.length && offset === 0) {
          emptyEl.textContent = currentSearch ? 'No clients match your search.' : 'No clients yet.';
          emptyEl.style.display = 'block';
          listEl.style.display = 'none';
        } else {
          listEl.style.display = 'flex';
          body.clients.forEach(function (c) {
            listEl.appendChild(renderClientCard(c));
          });
        }

        offset += body.clients.length;
        loadMoreWrap.style.display = body.hasMore ? 'flex' : 'none';
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load clients.');
      });
  }

  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    var value = searchInput.value;
    debounceTimer = setTimeout(function () {
      var next = value.trim();
      if (next === currentSearch) return;
      currentSearch = next;
      resetAndLoad();
    }, SEARCH_DEBOUNCE_MS);
  });

  loadMoreBtn.addEventListener('click', function () {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
    loadPage().then(function () {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
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

  // A back-navigation restored from bfcache can show a stale list — force a
  // clean reload so the page always reflects the database, not a cached
  // snapshot (same reasoning as admin/dashboard.js).
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  loadPage();
});
