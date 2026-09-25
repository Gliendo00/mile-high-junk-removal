// /admin/login — posts credentials to our own server endpoint, which is the
// only thing that talks to Supabase Auth. This page never touches Supabase
// directly and never holds a Supabase key of any kind.
document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('login-form');
  var errorBox = document.getElementById('login-error');
  var submitBtn = document.getElementById('login-submit');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('is-visible');
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.remove('is-visible');
  }

  // Batch 1 (auth reliability): is the owner already logged in? Checked
  // both on a normal page load and — critically — every time this page is
  // restored from the browser's back/forward cache (bfcache). This page is
  // static HTML with no server-side auth check of its own, so without this,
  // pressing Back enough times to reach this page in browser history shows
  // a stale, un-rechecked login form even when the real session is still
  // perfectly valid: exactly the "frozen login page" bug. A bfcache restore
  // never re-runs DOMContentLoaded (the whole JS context is just resumed,
  // not restarted), so `pageshow` + `event.persisted` is the only hook that
  // fires for it — see https://web.dev/bfcache/. Uses GET
  // /api/admin/auth?action=session (see api/admin/auth.js), a thin wrapper
  // around the exact same requireAdmin() every other /api/admin/* route
  // already uses, so this never duplicates or drifts from that logic.
  // Fails open to *showing* the form (never the reverse) on any ambiguous
  // outcome — a network error here must never block a legitimate login.
  function redirectIfAlreadyAuthenticated() {
    return fetch('/api/admin/auth?action=session')
      .then(function (res) {
        if (res.status === 200) {
          // replace(), not href: this page shouldn't become a Back
          // destination again immediately after this redirect — see the
          // matching change in the submit handler below.
          window.location.replace('/admin/');
        }
      })
      .catch(function () {});
  }

  redirectIfAlreadyAuthenticated();
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) redirectIfAlreadyAuthenticated();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    if (!email || !password) {
      showError('Email and password are required.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in…';

    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) {
              throw new Error((body && body.error) || 'Could not log in. Please try again.');
            }
            return body;
          });
      })
      .then(function () {
        // replace(), not href: a completed login shouldn't leave this page
        // sitting in browser history as a Back destination — see
        // redirectIfAlreadyAuthenticated() above, which is the backstop for
        // the rare case this page is reached via Back/bfcache regardless.
        window.location.replace('/admin/');
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not log in. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      });
  });
});
