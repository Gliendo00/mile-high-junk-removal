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
        window.location.href = '/admin/';
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not log in. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      });
  });
});
