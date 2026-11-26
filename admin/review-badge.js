// Client review star, shown right after a client's name on any CRM screen.
// The status comes from the API (api/_lib/review-status.js):
//   "received"  -> gold filled star   ("Review received")
//   "requested" -> grey outline star  ("Review requested, not received yet")
//   "none"/missing -> nothing at all
//
// Usage (every caller guards on window.ReviewBadge so a page that doesn't
// load this file just shows no star, never an error):
//   if (window.ReviewBadge) window.ReviewBadge.append(nameEl, status);
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STAR_PATH = 'M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95L12 2.5z';

  // Name elements whose CSS truncates with an ellipsis (admin/admin.css).
  var TRUNCATING_NAMES = '.admin-client-row-name, .admin-home-row-name';

  var LABELS = {
    received: 'Review received',
    requested: 'Review requested, not received yet',
  };

  function create(status) {
    if (status !== 'received' && status !== 'requested') return null;
    var wrap = document.createElement('span');
    wrap.className = 'admin-review-star admin-review-star-' + status;
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', LABELS[status]);
    wrap.title = LABELS[status];

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', STAR_PATH);
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);
    wrap.appendChild(svg);
    return wrap;
  }

  // Appends the star to `parent` (replacing any star already there, so a
  // re-render or a status change never stacks two). Returns the star or null.
  function append(parent, status) {
    if (!parent) return null;
    var existing = parent.querySelector(':scope > .admin-review-star');
    if (existing) existing.parentNode.removeChild(existing);
    var star = create(status);
    if (!star) return null;
    // A few name styles truncate with an ellipsis (Clients list, Home
    // rows). For those only, move the name's own text into its own span so
    // THAT is what truncates, and the star after it always stays visible.
    // Everywhere else the star just sits inline after the last word.
    var textNodes = [];
    if (parent.matches && parent.matches(TRUNCATING_NAMES)) {
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (parent.childNodes[i].nodeType === 3) textNodes.push(parent.childNodes[i]);
      }
    }
    if (textNodes.length) {
      var textSpan = document.createElement('span');
      textSpan.className = 'admin-review-name-text';
      parent.insertBefore(textSpan, textNodes[0]);
      textNodes.forEach(function (t) { textSpan.appendChild(t); });
      parent.classList.add('admin-review-has-star');
    }
    parent.appendChild(star);
    return star;
  }

  window.ReviewBadge = { create: create, append: append, LABELS: LABELS };
})();
