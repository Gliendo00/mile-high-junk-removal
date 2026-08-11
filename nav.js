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
    if (e.target.tagName === 'A') closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 860) closeMenu();
  });
});
