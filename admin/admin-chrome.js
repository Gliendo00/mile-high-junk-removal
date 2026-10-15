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
//
// UI refinement pass (2026-10-11): the mobile bottom nav is now exactly 5
// items (Home/Schedule/Leads/Clients/More) instead of 6 — Expenses and
// Other Revenue moved into a "More" bottom sheet, reusing the EXACT same
// .admin-sheet-overlay/.admin-sheet/.admin-sheet-title/.admin-sheet-list/
// .admin-sheet-option/.admin-sheet-cancel chrome admin/status-ui.js and
// admin/quick-expense.js already use elsewhere in this app (no new modal
// pattern). Desktop's inline top nav is completely untouched — still all 6
// SECTIONS, in the same order, same behavior; SECTIONS below remains the
// single source of truth for both. Log Out moves out of the visible mobile
// header (hidden <860px via CSS) into the More sheet on mobile, to make
// room for the branded two-line wordmark — the SAME #logout-btn element and
// its SAME page-provided click handler are reused (the More sheet's Log Out
// row just calls logoutBtn.click() rather than duplicating the logout
// fetch/redirect logic), so every page's existing logout wiring is
// unaffected. On desktop (>=860px, no bottom nav, no More button at all)
// Log Out is shown inline in the header exactly as before.
(function () {
  var ICONS = {
    arrowDown: '<line x1="12" y1="4" x2="12" y2="18"/><polyline points="6 12 12 18 18 12"/>',
    // "More" has no mascot asset (unlike the 6 real sections below) — a
    // plain 2x2 dot grid, same stroke-based icon language as every other
    // inline SVG in this app, rather than commissioning a new mascot image
    // for a menu that isn't a real CRM section.
    moreGrid: '<circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    // Website Agent — also no mascot asset, same reasoning as "More" above:
    // a plain monitor-with-a-pulse-line glyph, same stroke language as
    // every other non-mascot icon in this file, rather than commissioning
    // one just for this pass.
    websiteAgent: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 10l2.5 2.5L12 8l2.5 4.5L17 10"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>'
  };

  function icon(name, cls) {
    return '<svg class="' + cls + '" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // Every section's nav icon is a branded mascot (a raster image), one per
  // destination, all in the same sticker-badge art style — used in BOTH the
  // desktop top nav and the mobile bottom nav/More sheet.
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

  // A section's nav icon is its mascot image when one exists (MASCOT_SRC),
  // else a plain inline SVG from ICONS (same dual-support
  // .admin-sheet-option-icon/.admin-nav-item-icon/.admin-bottom-nav-item-icon
  // already size both identically — see admin.css) — "More"/"Website
  // Agent" are the only sections with no mascot asset.
  var PLAIN_ICON_BY_KEY = { 'website-agent': 'websiteAgent' };
  function sectionIcon(key, cls) {
    if (MASCOT_SRC[key]) return mascotIcon(key, cls);
    return icon(PLAIN_ICON_BY_KEY[key] || 'moreGrid', cls);
  }

  // Section destinations — single source of truth for the desktop nav, the
  // mobile bottom nav's first 4 items, AND the mobile More sheet's items
  // (filtered by key below, never duplicated as separate data). Every
  // section shows its icon (mascot where one exists, see sectionIcon()
  // above) + a text label everywhere it appears.
  var SECTIONS = [
    { key: 'home', href: '/admin/home/', label: 'Home' },
    { key: 'schedule', href: '/admin/', label: 'Schedule' },
    { key: 'leads', href: '/admin/leads/', label: 'Leads' },
    { key: 'clients', href: '/admin/clients/', label: 'Clients' },
    { key: 'expenses', href: '/admin/expenses/', label: 'Expenses' },
    { key: 'other-revenue', href: '/admin/other-revenue/', label: 'Other Revenue' },
    // Website Agent dashboard — UI-organization pass around the existing
    // Site Improvement Agent. Desktop shows it inline like every other
    // section; mobile puts it in the existing More sheet (see
    // MORE_SHEET_KEYS below) rather than bumping something off the 4-item
    // bottom nav.
    { key: 'website-agent', href: '/admin/website-agent/', label: 'Website Agent' }
  ];

  // Mobile bottom nav shows only these 4 as direct links; the rest live in
  // the More sheet. Desktop's inline nav still shows the full SECTIONS list
  // via buildDesktopNav() below, untouched.
  var BOTTOM_NAV_KEYS = ['home', 'schedule', 'leads', 'clients'];
  var MORE_SHEET_KEYS = ['expenses', 'other-revenue', 'website-agent'];

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
    // Website Agent report/proposal pages are reached FROM the dashboard
    // (deep links, not their own nav destination) but should still show
    // the dashboard's nav item as "current" while viewing them.
    if (path.indexOf('/admin/website-agent/') === 0 ||
        path.indexOf('/admin/agent-reports/') === 0 ||
        path.indexOf('/admin/agent-proposals/') === 0) return 'website-agent';
    return 'schedule'; // /admin/, /admin/booking*/
  }

  function buildDesktopNav(activeKey) {
    return SECTIONS.map(function (s) {
      var active = s.key === activeKey;
      return '<a href="' + s.href + '" class="admin-nav-item' + (active ? ' is-active' : '') + '"' +
        (active ? ' aria-current="page"' : '') + '>' +
        sectionIcon(s.key, 'admin-nav-item-icon') +
        '<span>' + s.label + '</span></a>';
    }).join('');
  }

  // 4 real links + 1 "More" button (not a link — opens the sheet below).
  // The More button gets .is-active when the current page is one of the
  // sections that now live inside it (Expenses/Other Revenue), so the
  // bottom nav always shows *some* active state rather than none.
  function buildBottomNav(activeKey) {
    var bySectionKey = {};
    SECTIONS.forEach(function (s) { bySectionKey[s.key] = s; });

    var linksHtml = BOTTOM_NAV_KEYS.map(function (key) {
      var s = bySectionKey[key];
      var active = s.key === activeKey;
      return '<a href="' + s.href + '" class="admin-bottom-nav-item' + (active ? ' is-active' : '') + '"' +
        (active ? ' aria-current="page"' : '') + '>' +
        mascotIcon(s.key, 'admin-bottom-nav-item-icon') +
        '<span>' + s.label + '</span></a>';
    }).join('');

    var moreActive = MORE_SHEET_KEYS.indexOf(activeKey) !== -1;
    var moreHtml = '<button type="button" id="admin-more-toggle" class="admin-bottom-nav-item admin-bottom-nav-item-btn' +
      (moreActive ? ' is-active' : '') + '" aria-haspopup="true" aria-expanded="false" aria-controls="admin-more-sheet">' +
      icon('moreGrid', 'admin-bottom-nav-item-icon') +
      '<span>More</span></button>';

    return linksHtml + moreHtml;
  }

  // The More sheet's own content — Expenses/Other Revenue (from SECTIONS,
  // same mascot icons as everywhere else) plus a Log Out row that reuses
  // the EXISTING #logout-btn element/handler (see this file's header).
  // Built with the exact same .admin-sheet-* classes admin/status-ui.js and
  // admin/quick-expense.js already use — no new sheet/modal pattern.
  function buildMoreSheetHtml() {
    var bySectionKey = {};
    SECTIONS.forEach(function (s) { bySectionKey[s.key] = s; });

    var itemsHtml = MORE_SHEET_KEYS.map(function (key) {
      var s = bySectionKey[key];
      return '<a href="' + s.href + '" class="admin-sheet-option admin-more-sheet-option">' +
        sectionIcon(s.key, 'admin-sheet-option-icon') +
        '<span class="admin-sheet-option-label">' + s.label + '</span></a>';
    }).join('');

    itemsHtml += '<button type="button" id="admin-more-logout" class="admin-sheet-option admin-more-sheet-option">' +
      icon('logout', 'admin-sheet-option-icon admin-more-sheet-logout-icon') +
      '<span class="admin-sheet-option-label">Log Out</span></button>';

    return (
      '<div class="admin-sheet-overlay" id="admin-more-overlay" hidden>' +
        '<div class="admin-sheet" id="admin-more-sheet" role="dialog" aria-modal="true" aria-label="More">' +
          '<div class="admin-sheet-title">More</div>' +
          '<div class="admin-sheet-list">' + itemsHtml + '</div>' +
          '<button type="button" class="admin-sheet-cancel" id="admin-more-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  document.addEventListener('DOMContentLoaded', function () {
    var mount = document.getElementById('admin-chrome');
    if (!mount) return; // login page and any page that opts out

    var activeKey = currentSectionKey();

    mount.innerHTML =
      '<div class="admin-header">' +
        '<div class="admin-header-left">' +
          '<a class="admin-brand" href="/admin/">' +
            '<img class="admin-brand-logo" src="/images/mile-high-junk-removal-logo.webp" alt="Mile High Junk Removal">' +
            '<span class="admin-brand-wordmark">' +
              '<span class="admin-brand-wordmark-line">Mile High</span>' +
              '<span class="admin-brand-wordmark-line">Junk Removal</span>' +
            '</span>' +
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

    // More sheet — appended once, toggled via [hidden]. Only wired up when
    // the bottom nav (and therefore the More button) actually exists in the
    // DOM; harmless no-op on desktop-only sessions since the button is
    // simply never clicked (the bottom nav itself is display:none there).
    var sheetWrap = document.createElement('div');
    sheetWrap.innerHTML = buildMoreSheetHtml();
    document.body.appendChild(sheetWrap.firstChild);

    var moreToggle = document.getElementById('admin-more-toggle');
    var moreOverlay = document.getElementById('admin-more-overlay');
    var moreCancel = document.getElementById('admin-more-cancel');
    var moreLogoutRow = document.getElementById('admin-more-logout');
    var realLogoutBtn = document.getElementById('logout-btn');

    function openMore() {
      moreOverlay.hidden = false;
      moreToggle.setAttribute('aria-expanded', 'true');
    }
    function closeMore() {
      moreOverlay.hidden = true;
      moreToggle.setAttribute('aria-expanded', 'false');
    }

    if (moreToggle) {
      moreToggle.addEventListener('click', function () {
        if (moreOverlay.hidden) openMore(); else closeMore();
      });
    }
    moreOverlay.addEventListener('click', function (e) {
      if (e.target === moreOverlay) closeMore();
    });
    moreCancel.addEventListener('click', closeMore);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !moreOverlay.hidden) closeMore();
    });
    // Reuses the real #logout-btn's own click handler (wired by the page's
    // own script, e.g. admin/home.js) rather than duplicating the logout
    // fetch/redirect logic here — see this file's header comment.
    moreLogoutRow.addEventListener('click', function () {
      closeMore();
      realLogoutBtn.click();
    });
  });
})();
