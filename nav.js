document.addEventListener('DOMContentLoaded', function () {
  // GA4: fire phone_click for any tel: link anywhere on the page (nav bar,
  // sticky mobile call bar, in-page CTAs, booking pages, etc). Attached
  // before the hamburger-menu guard below so it never depends on that markup.
  document.addEventListener('click', function (e) {
    var telLink = e.target.closest ? e.target.closest('a[href^="tel:"]') : null;
    if (telLink && typeof window.gtag === 'function') {
      window.gtag('event', 'phone_click');
    }
  });

  var toggle = document.getElementById('nav-hamburger');
  var menu = document.getElementById('mobile-menu');
  if (!toggle || !menu) return;

  function closeMenu() {
    menu.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  }
  function openMenu() {
    menu.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
  }

  toggle.addEventListener('click', function () {
    if (menu.classList.contains('is-open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  menu.addEventListener('click', function (e) {
    // Only real destination links close the mobile menu — the Services
    // accordion trigger below is a <button>, not an <a>, so closest('a')
    // naturally never matches it and the accordion can open without the
    // whole hamburger panel collapsing underneath it.
    var link = e.target.closest ? e.target.closest('a') : null;
    if (link && menu.contains(link)) closeMenu();
  });

  // --- Services dropdown (desktop) ---------------------------------------
  var servicesTrigger = document.getElementById('services-trigger');
  var servicesDropdown = document.getElementById('services-dropdown');
  var servicesPanel = document.getElementById('services-menu');

  function openServicesDropdown() {
    servicesTrigger.setAttribute('aria-expanded', 'true');
    servicesPanel.classList.add('is-open');
  }
  function closeServicesDropdown(returnFocus) {
    servicesTrigger.setAttribute('aria-expanded', 'false');
    servicesPanel.classList.remove('is-open');
    if (returnFocus) servicesTrigger.focus();
  }

  if (servicesTrigger && servicesDropdown && servicesPanel) {
    servicesTrigger.addEventListener('click', function () {
      if (servicesTrigger.getAttribute('aria-expanded') === 'true') {
        closeServicesDropdown(false);
      } else {
        openServicesDropdown();
      }
    });

    // Enter/Space are handled natively by the <button> element's own click
    // activation, so no extra keydown handling is needed to open it.

    servicesPanel.addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('a') : null;
      if (link) closeServicesDropdown(false);
    });

    document.addEventListener('click', function (e) {
      if (servicesTrigger.getAttribute('aria-expanded') === 'true' && !servicesDropdown.contains(e.target)) {
        closeServicesDropdown(false);
      }
    });
  }

  // --- Services accordion (mobile, nested inside the hamburger panel) ----
  var mobileServicesTrigger = document.getElementById('mobile-services-trigger');
  var mobileServicesPanel = document.getElementById('mobile-services-panel');

  function closeMobileServicesAccordion() {
    mobileServicesTrigger.setAttribute('aria-expanded', 'false');
    mobileServicesPanel.classList.remove('is-open');
  }

  if (mobileServicesTrigger && mobileServicesPanel) {
    mobileServicesTrigger.addEventListener('click', function () {
      var isOpen = mobileServicesTrigger.getAttribute('aria-expanded') === 'true';
      mobileServicesTrigger.setAttribute('aria-expanded', String(!isOpen));
      mobileServicesPanel.classList.toggle('is-open', !isOpen);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeMenu();
    if (servicesTrigger && servicesTrigger.getAttribute('aria-expanded') === 'true') {
      closeServicesDropdown(true);
    }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 860) {
      closeMenu();
      if (mobileServicesTrigger && mobileServicesPanel) closeMobileServicesAccordion();
    } else if (servicesTrigger && servicesTrigger.getAttribute('aria-expanded') === 'true') {
      closeServicesDropdown(false);
    }
  });
});
