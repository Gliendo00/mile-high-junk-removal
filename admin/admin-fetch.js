// Batch 1 (auth reliability): a drop-in replacement for fetch() used by
// every admin page for its /api/admin/* calls. Loaded on every /admin page
// except login (../admin/login/index.html), the same way nav-badge.js
// already is — see that file's header for the "stay under Vercel Hobby's
// 12-function ceiling" constraint this also respects (no new endpoint per
// page, just a shared client-side helper).
//
// The bug this fixes: this app has no single-page-app shell, so each admin
// page loads several independent scripts that each fire their own request
// on DOMContentLoaded — e.g. admin/index.html loads nav-badge.js,
// schedule-financials.js, schedule.js and calendar-views.js together; every
// other page loads nav-badge.js alongside its own primary fetch. When the
// access-token cookie has expired, two or more of those requests can each
// try to use the SAME refresh-token cookie to mint a new session at the
// same time. Supabase rotates a refresh token on first use (see
// docs/phase-2/auth-architecture.md), so only one concurrent
// refreshSession() call can win — the other(s) get a hard 401 from
// api/_lib/admin-auth.js's getAdminSession(), even though the session
// itself is perfectly valid a moment later. Previously, whichever fetch on
// the page owned the 401 -> /admin/login/ redirect (e.g. admin/schedule.js)
// could lose this race and send a genuinely logged-in owner to the login
// page — the root cause behind both "I got randomly logged out" and the
// Back-button-lands-on-a-stale-login-page bug.
//
// The fix is a single retry, but the retry timing is NOT a guess. Rather
// than waiting an arbitrary number of milliseconds and hoping a sibling
// request has finished rotating the cookie by then, every adminFetch() call
// currently in flight on the page is tracked here, and a 401 waits for
// every OTHER in-flight call to actually settle (succeed or fail) before
// retrying once. That wait is exact, not probabilistic: a browser applies a
// response's Set-Cookie header(s) to the cookie jar as part of receiving
// that response — before the fetch() promise for it ever resolves — so the
// instant a sibling's promise has settled, any cookie it rotated is already
// what the browser will send on the very next request. There is no timing
// window left to race against once every sibling has actually finished,
// and no wait at all when nothing else happened to be in flight.
//
// If every sibling also fails (a real, fully expired/revoked session), the
// retry repeats the exact same request and gets the exact same 401, so a
// caller's existing `if (res.status === 401) window.location.href =
// '/admin/login/'` still fires exactly as before. This file only ever
// changes the *timing* of when a 401 is reported to the caller, never
// whether one is reported — fail-closed behavior is unchanged. Retrying is
// always safe here even for a POST/PATCH mutation: requireAdmin() runs
// before any route touches data, so a 401 response is a guarantee nothing
// happened server-side yet — never a partial/duplicate write.
(function () {
  var inFlight = [];

  // Not a retry-timing guess (see this file's header) — a circuit breaker
  // for the one thing settlement-based waiting can't bound on its own:
  // fetch() has no built-in timeout, so a sibling stuck on a genuinely
  // stalled connection (dead wifi, a black-holed connection) would never
  // settle, and waitForSiblings() would then wait forever, hanging the
  // retry — and with it, the caller's own .then() — indefinitely. This
  // only ever matters in that pathological case: in the normal case
  // (everything here since Batch 1 shipped), every sibling settles in well
  // under a second and this deadline is never reached, so it changes
  // nothing about the exact, settlement-driven retry timing described
  // above. If it IS reached, the retry just proceeds with whatever cookie
  // currently exists — exactly as if that hung sibling had never been
  // in flight at all.
  var SIBLING_WAIT_TIMEOUT_MS = 5000;

  function untrack(promise) {
    var idx = inFlight.indexOf(promise);
    if (idx !== -1) inFlight.splice(idx, 1);
  }

  // Resolves once every OTHER currently-tracked adminFetch() call has
  // settled, however it settled, or once SIBLING_WAIT_TIMEOUT_MS elapses —
  // whichever comes first. Never itself rejects. Always clears the deadline
  // timer before returning — a no-op if it already fired, but required so a
  // sibling that settles well within the normal case doesn't leave a
  // 5-second timer sitting around doing nothing.
  function waitForSiblings(exclude) {
    var others = inFlight.filter(function (p) { return p !== exclude; });
    if (!others.length) return Promise.resolve();
    var timerId;
    var deadline = new Promise(function (resolve) {
      timerId = setTimeout(resolve, SIBLING_WAIT_TIMEOUT_MS);
    });
    var settled = Promise.all(
      others.map(function (p) {
        return p.then(function () {}, function () {});
      })
    );
    return Promise.race([settled, deadline]).then(function (result) {
      clearTimeout(timerId);
      return result;
    });
  }

  function fire(url, options) {
    var p = fetch(url, options);
    inFlight.push(p);
    p.then(function () { untrack(p); }, function () { untrack(p); });
    return p;
  }

  window.adminFetch = function adminFetch(url, options) {
    var first = fire(url, options);
    return first.then(function (res) {
      if (res.status !== 401) return res;
      return waitForSiblings(first).then(function () {
        return fire(url, options);
      });
    });
  };
})();
