// Shared Requests nav badge, loaded on every /admin page except login (see
// admin/status-ui.js for the equivalent pattern used by the status picker):
// a small restrained count of "new" bookings shown on the Requests nav tab,
// regardless of which admin page the owner is currently on.
//
// Deliberately minimal and fail-safe: if the count can't be loaded for any
// reason (network error, non-200, session expired), the badge simply stays
// hidden rather than showing a stale/wrong number or redirecting the page —
// this is a small enhancement, not a security boundary, and the page's own
// primary data fetch already handles an expired session by redirecting to
// login. Uses the `hidden` attribute (never a "0" left visible) so a count
// of zero is genuinely absent, not just visually quiet.
document.addEventListener('DOMContentLoaded', function () {
  var badge = document.getElementById('nav-badge-requests');
  if (!badge) return;

  fetch('/api/admin/new-count')
    .then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    })
    .then(function (body) {
      var count = body && typeof body.new === 'number' ? body.new : 0;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    })
    .catch(function () {
      badge.hidden = true;
    });
});
