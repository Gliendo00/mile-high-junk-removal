// /admin/intake-new — upload one or more screenshots, then run extraction
// (Batch 5). Mirrors book/book.js's uploadPhoto()/uploadAllPhotos() pattern
// for the raw-octet-stream upload itself (fetch() accepts a File/Blob body
// directly), but against the admin-authenticated
// POST /api/admin/intake?action=upload-screenshot route instead of the
// public, upload-token-gated /api/upload-photo.
//
// Every dynamic value below is written with textContent/DOM construction
// (never innerHTML/insertAdjacentHTML with a concatenated string) — same
// discipline as every other admin script.
document.addEventListener('DOMContentLoaded', function () {
  var MAX_BYTES = 4 * 1024 * 1024; // mirrors api/admin/intake.js's MAX_SCREENSHOT_BYTES
  var MAX_SHOTS = 10; // mirrors api/admin/intake.js's MAX_SCREENSHOTS_PER_SESSION
  var ALLOWED_TYPES = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };

  var errorBanner = document.getElementById('error-banner');
  var fileInput = document.getElementById('file-input');
  var addBtn = document.getElementById('add-btn');
  var shotList = document.getElementById('shot-list');
  var shotEmpty = document.getElementById('shot-empty');
  var extractBtn = document.getElementById('extract-btn');
  var progressEl = document.getElementById('progress');
  var logoutBtn = document.getElementById('logout-btn');

  var selectedFiles = []; // [{ file, previewUrl }]
  var sessionId = null; // created lazily on first "Extract Information" click, reused on retry

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }
  function showProgress(msg) {
    progressEl.textContent = msg;
    progressEl.style.display = 'block';
  }
  function hideProgress() {
    progressEl.style.display = 'none';
    progressEl.textContent = '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderShots() {
    while (shotList.firstChild) shotList.removeChild(shotList.firstChild);
    if (!selectedFiles.length) {
      shotList.style.display = 'none';
      shotEmpty.style.display = 'block';
      extractBtn.disabled = true;
      return;
    }
    shotEmpty.style.display = 'none';
    shotList.style.display = 'flex';
    extractBtn.disabled = false;

    selectedFiles.forEach(function (entry, index) {
      var li = document.createElement('li');
      var img = document.createElement('img');
      img.src = entry.previewUrl;
      img.alt = 'Screenshot ' + (index + 1);
      li.appendChild(img);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'admin-btn admin-btn-ghost';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () {
        URL.revokeObjectURL(entry.previewUrl);
        selectedFiles.splice(index, 1);
        renderShots();
      });
      li.appendChild(removeBtn);

      shotList.appendChild(li);
    });
  }

  function addFiles(fileList) {
    clearError();
    var files = Array.prototype.slice.call(fileList || []);
    var rejected = [];
    files.forEach(function (file) {
      if (selectedFiles.length >= MAX_SHOTS) {
        rejected.push(file.name + ' (max ' + MAX_SHOTS + ' screenshots per intake)');
        return;
      }
      if (!ALLOWED_TYPES[file.type]) {
        rejected.push(file.name + ' (unsupported type)');
        return;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(file.name + ' (too large)');
        return;
      }
      selectedFiles.push({ file: file, previewUrl: URL.createObjectURL(file) });
    });
    if (rejected.length) showError('Could not add: ' + rejected.join(', '));
    renderShots();
  }

  addBtn.addEventListener('click', function () {
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  function uploadOne(file) {
    return fetch('/api/admin/intake?action=upload-screenshot', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Intake-Session-Id': sessionId,
        'X-Screenshot-Type': file.type,
      },
      body: file,
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return Promise.reject(new Error('Session expired.'));
      }
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not upload a screenshot.');
          return body;
        });
    });
  }

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return adminFetch('/api/admin/intake', { method: 'POST' })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return Promise.reject(new Error('Session expired.'));
        }
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not start a new intake.');
            sessionId = body.id;
            return sessionId;
          });
      });
  }

  function uploadAllSequentially(files, onProgress) {
    var chain = Promise.resolve();
    files.forEach(function (entry, index) {
      chain = chain.then(function () {
        onProgress(index + 1, files.length);
        return uploadOne(entry.file);
      });
    });
    return chain;
  }

  function runExtract() {
    return adminFetch('/api/admin/intake?action=extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId }),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return Promise.reject(new Error('Session expired.'));
      }
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not extract intake information.');
          return body;
        });
    });
  }

  extractBtn.addEventListener('click', function () {
    if (!selectedFiles.length) return;
    clearError();
    extractBtn.disabled = true;
    addBtn.disabled = true;

    // Screenshots already uploaded in a previous (failed) attempt stay on
    // the server — only files not yet successfully uploaded this run need
    // sending again. Tracked per-entry so a retry after a mid-list failure
    // never re-uploads the same screenshot twice.
    var pending = selectedFiles.filter(function (entry) {
      return !entry.uploaded;
    });

    ensureSession()
      .then(function () {
        showProgress('Uploading screenshots…');
        return uploadAllSequentially(pending, function (done, total) {
          showProgress('Uploading screenshot ' + done + ' of ' + total + '…');
          pending[done - 1].uploaded = true;
        });
      })
      .then(function () {
        showProgress('Extracting information…');
        return runExtract();
      })
      .then(function (body) {
        if (body.status === 'extraction_failed') {
          throw new Error(body.error || 'Extraction failed. You can try again.');
        }
        window.location.href = '/admin/intake/?id=' + encodeURIComponent(sessionId);
      })
      .catch(function (err) {
        hideProgress();
        extractBtn.disabled = false;
        addBtn.disabled = false;
        showError(err && err.message ? err.message : 'Something went wrong. Please try again.');
      });
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  renderShots();
});
