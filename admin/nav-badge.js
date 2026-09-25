// Shared Requests nav badge, loaded on every /admin page except login (see
// admin/status-ui.js for the equivalent pattern used by the status picker):
// a small restrained count of "new" bookings shown on the Requests nav tab,
// regardless of which admin page the owner is currently on.
//
// Uses /api/admin/bookings?countsOnly=1 rather than a dedicated endpoint —
// see the countsOnly comment in api/admin/bookings.js for why: this project
// is on the Vercel Hobby plan's 12-Serverless-Function-per-deployment limit,
// which a separate new-count.js function would have exceeded. bookings.js
// already computes this exact summary on every call it serves; countsOnly=1
// just skips the (more expensive) booking-row/customer/photo-count work and
// returns only that summary.
//
// Deliberately minimal and fail-safe: if the count can't be loaded for any
// reason (network error, non-200, session expired), the badge simply stays
// hidden rather than showing a stale/wrong number or redirecting the page —
// this is a small enhancement, not a security boundary, and the page's own
// primary data fetch already handles an expired session by redirecting to
// login. Uses the `hidden` attribute (never a "0" left visible) so a count
// of zero is genuinely absent, not just visually quiet.
//
// Uses admin-fetch.js's adminFetch() (loaded before this file on every
// page) rather than plain fetch(): this script's request fires on every
// single admin page alongside that page's own primary fetch, making the two
// the most common concurrent pair in the app — see admin-fetch.js's header
// for the refresh-token race that pairing can trigger. Routing this request
// through adminFetch also registers it in that shared in-flight registry,
// which is what lets a genuinely concurrent primary-fetch 401 wait for
// *this* request specifically before retrying.
document.addEventListener('DOMContentLoaded', function () {
  var badge = document.getElementById('nav-badge-requests');
  if (!badge) return;

  adminFetch('/api/admin/bookings?countsOnly=1')
    .then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    })
    .then(function (body) {
      var count = body && body.summary && typeof body.summary.new === 'number' ? body.summary.new : 0;
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
