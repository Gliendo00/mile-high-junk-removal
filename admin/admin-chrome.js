// Shared admin header + nav + mobile bottom nav, injected into every /admin
// page (except /admin/login/, which keeps its own standalone layout).
//
// Why JS-injected rather than static HTML: before this file, the exact same
// topbar+nav markup was hand-duplicated across 13 HTML files — any visual or
// structural change (like this one) meant editing all 13 identically and
// hoping nothing drifted. This is the single source of truth going forward;
// a page only needs an empty `<div id="admin-chrome"></div>` placeholder and
// this script loaded FIRST (before admin-fetch.js and the page's own
// script), so `#logout-btn` exists in the DOM before any other script's own
// DOMContentLoaded handler runs and looks for it — every page's existing
// `document.getElementById('logout-btn').addEventListener('click', ...)`
// logout wiring is left completely untouched, just now finds an element
// that this file created instead of one the page's own HTML contained.
//
// No user-supplied data is ever interpolated into the HTML strings below —
// everything here is a fixed, hardcoded set of nav destinations — so
// innerHTML is safe here unlike the rest of this project's admin/*.js files
// (which must use textContent for anything server/user-derived).
(function () {
  var ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/>',
    calendar: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>',
    leads: '<path d="M3 4h18l-7 9v6l-4 2v-8z"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    receipt: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>',
    arrowDown: '<line x1="12" y1="4" x2="12" y2="18"/><polyline points="6 12 12 18 18 12"/>'
  };

  function icon(name, cls) {
    return '<svg class="' + cls + '" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // The branded mascot icons (raster images) — used for every destination in
  // the MOBILE BOTTOM NAV only. The desktop top nav keeps its original
  // line-art SVGs (via ICONS/icon() above) and Other Revenue's existing
  // icon-only mascot treatment, untouched.
  var MASCOT_SRC = {
    home: '/images/mile-high-nav-home-mascot.png',
    schedule: '/images/mile-high-nav-schedule-mascot.png',
    leads: '/images/mile-high-nav-leads-mascot.png',
    clients: '/images/mile-high-nav-clients-mascot.png',
    expenses: '/images/mile-high-nav-expenses-mascot.png',
    'other-revenue': '/images/mile-high-money-mascot.png'
  };

  function mascotIcon(key, cls) {
    return '<img class="' + cls + '" src="' + MASCOT_SRC[key] + '" alt="" width="26" height="26">';
  }

  // Section destinations — single source of truth for both the desktop nav
  // and the mobile bottom nav. `desktopIcon` is the line-art icon used only
  // in the desktop top nav; the bottom nav always uses the mascot image
  // keyed by `key` in MASCOT_SRC, plus a label, for every section including
  // Other Revenue. `desktopIconOnly` keeps Other Revenue's existing
  // icon-only treatment in the desktop nav specifically (unchanged, per
  // Rocky's earlier explicit choice there).
  var SECTIONS = [
    { key: 'home', href: '/admin/home/', label: 'Home', desktopIcon: 'home' },
    { key: 'schedule', href: '/admin/', label: 'Schedule', desktopIcon: 'calendar' },
    { key: 'leads', href: '/admin/leads/', label: 'Leads', desktopIcon: 'leads' },
    { key: 'clients', href: '/admin/clients/', label: 'Clients', desktopIcon: 'people' },
    { key: 'expenses', href: '/admin/expenses/', label: 'Expenses', desktopIcon: 'receipt' },
    { key: 'other-revenue', href: '/admin/other-revenue/', label: 'Other Revenue', desktopIcon: 'mascot', desktopIconOnly: true }
  ];

  // Which section is "current" — by URL path, so no page needs a data
  // attribute or any other per-page marker. Booking/intake/request/lead
  // detail and sub-flow pages roll up to the section they're reached from.
  // Checked BEFORE the schedule fallback's own '/admin/' prefix (which would
  // otherwise swallow every other path, '/admin/home/' included, since
  // every admin path starts with '/admin/').
  function currentSectionKey() {
    var path = window.location.pathname;
    if (path.indexOf('/admin/home/') === 0) return 'home';
    if (path.indexOf('/admin/leads/') === 0 ||
        path.indexOf('/admin/lead/') === 0 ||
        path.indexOf('/admin/intake') === 0 ||
        path.indexOf('/admin/requests/') === 0) return 'leads';
    if (path.indexOf('/admin/client') === 0) return 'clients'; // /admin/client/ and /admin/clients/
    if (path.indexOf('/admin/other-revenue/') === 0) return 'other-revenue';
    if (path.indexOf('/admin/expenses/') === 0) return 'expenses';
    return 'schedule'; // /admin/, /admin/booking*/
  }

  function buildDesktopNav(activeKey) {
    return SECTIONS.map(function (s) {
      var active = s.key === activeKey;
      var desktopIcon = s.desktopIcon === 'mascot' ? mascotIcon(s.key, 'admin-nav-item-icon') : icon(s.desktopIcon, 'admin-nav-item-icon');
      return '<a href="' + s.href + '" class="admin-nav-item' + (active ? ' is-active' : '') + (s.desktopIconOnly ? ' admin-nav-item-icon-only' : '') + '"' +
        (active ? ' aria-current="page"' : '') + (s.desktopIconOnly ? ' aria-label="' + s.label + '"' : '') + '>' +
        desktopIcon +
        (s.desktopIconOnly ? '' : '<span>' + s.label + '</span>') + '</a>';
    }).join('');
  }

  function buildBottomNav(activeKey) {
    return SECTIONS.map(function (s) {
      var active = s.key === activeKey;
      // Longer labels (currently just "Other Revenue") get a smaller-text
      // modifier so they stay on one line like every other item, instead of
      // wrapping to two and standing out from the rest of the row.
      var longLabel = s.label.length > 10;
      return '<a href="' + s.href + '" class="admin-bottom-nav-item' + (active ? ' is-active' : '') + (longLabel ? ' admin-bottom-nav-item-long-label' : '') + '"' +
        (active ? ' aria-current="page"' : '') + '>' +
        mascotIcon(s.key, 'admin-bottom-nav-item-icon') +
        '<span>' + s.label + '</span></a>';
    }).join('');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var mount = document.getElementById('admin-chrome');
    if (!mount) return; // login page and any page that opts out

    var activeKey = currentSectionKey();

    mount.innerHTML =
      '<div class="admin-header">' +
        '<div class="admin-header-left">' +
          '<a class="admin-brand" href="/admin/">' +
            '<img class="admin-brand-logo" src="/images/mile-high-junk-removal-logo.webp" alt="">' +
            '<span class="admin-brand-word">Admin</span>' +
          '</a>' +
          '<nav class="admin-header-nav" aria-label="Admin sections">' + buildDesktopNav(activeKey) + '</nav>' +
        '</div>' +
        '<div class="admin-header-right">' +
          '<a href="/admin/intake-new/" class="admin-btn admin-btn-primary admin-drop-lead-btn">LEAD' + icon('arrowDown', 'admin-drop-lead-arrow') + '</a>' +
          '<button type="button" id="logout-btn" class="admin-btn admin-btn-ghost">Log Out</button>' +
        '</div>' +
      '</div>';

    var bottomNav = document.createElement('nav');
    bottomNav.className = 'admin-bottom-nav';
    bottomNav.setAttribute('aria-label', 'Admin sections');
    bottomNav.innerHTML = buildBottomNav(activeKey);
    document.body.appendChild(bottomNav);
  });
})();
