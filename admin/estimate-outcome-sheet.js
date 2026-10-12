// Shared small outcome-note bottom sheet for the Estimate workflow's three
// non-conversion status transitions (complete/cancel/lost) — used by BOTH
// admin/schedule.js's estimate status pill and admin/estimate-detail.js's
// per-action buttons, so neither page re-implements this flow or falls
// back to window.prompt()/window.confirm(). Mirrors the look/structure of
// admin/status-ui.js's and admin/client-picker.js's own bottom sheets
// (.admin-sheet-overlay/.admin-sheet, click-outside/Escape-to-close) —
// never a second overlay implementation.
//
// Deliberately NOT window.AdminJobCloseout: an estimate carries no
// payment/tip/job-financial-closeout concept at all (see
// api/admin/booking.js's handlePatchEstimate() header) — this sheet is a
// single optional note field plus a Confirm/Never mind pair, nothing more.
// "Convert to Job" is never reachable from here — see
// admin/booking-new.js's ?estimateId= prefill flow for that completely
// separate, obviously-distinct action.
//
// This module makes its own network call (PATCH ?resource=estimate),
// same "the sheet owns the write" shape as window.AdminJobCloseout —
// callers only ever get a finished result via onComplete, never a raw
// promise to chain their own PATCH onto.
window.AdminEstimateOutcome = (function () {
  var TITLES = { complete: 'Mark Estimate Completed', cancel: 'Cancel Estimate', lost: 'Did Not Book' };
  var CONFIRM_LABELS = { complete: 'Mark Completed', cancel: 'Cancel Estimate', lost: 'Mark Did Not Book' };
  var NOTE_LABELS = { complete: "How'd it go? (optional)", cancel: 'Reason (optional)', lost: 'Notes (optional)' };
  var HINTS = {
    cancel: 'The originating lead is not affected.',
    lost: 'You can still convert this to a job later if the client calls back.',
  };

  var overlay = null;
  var sheet = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'admin-sheet-overlay';
    overlay.setAttribute('hidden', '');

    sheet = document.createElement('div');
    sheet.className = 'admin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    overlay.appendChild(sheet);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) close();
    });

    document.body.appendChild(overlay);
  }

  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }

  function close() {
    if (!overlay) return;
    overlay.setAttribute('hidden', '');
    clearSheet();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // opts: { estimateId, action ('complete'|'cancel'|'lost'), onComplete(result) }
  // result: { ok: true, estimate } on success — onComplete is only ever
  // called after a confirmed server-side save; a Cancel/Escape/click-
  // outside calls nothing, exactly like window.AdminStatusUI's own sheet.
  function open(opts) {
    opts = opts || {};
    var action = opts.action;
    ensureDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', TITLES[action] || 'Update Estimate'));

    if (HINTS[action]) {
      sheet.appendChild(el('div', 'admin-field-hint', HINTS[action]));
    }

    var field = el('div', 'admin-field');
    var label = document.createElement('label');
    label.textContent = NOTE_LABELS[action] || 'Notes (optional)';
    field.appendChild(label);
    var textarea = document.createElement('textarea');
    textarea.rows = 3;
    field.appendChild(textarea);
    sheet.appendChild(field);

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showFieldError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }
    function clearFieldError() {
      errorBox.textContent = '';
      errorBox.classList.remove('is-visible');
    }

    var actions = el('div', 'admin-duplicate-card-actions');
    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-primary';
    confirmBtn.textContent = CONFIRM_LABELS[action] || 'Confirm';
    actions.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Never mind';
    cancelBtn.addEventListener('click', close);
    actions.appendChild(cancelBtn);
    sheet.appendChild(actions);

    confirmBtn.addEventListener('click', function () {
      clearFieldError();
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Saving…';

      var body = { id: opts.estimateId, action: action };
      var note = textarea.value.trim();
      if (note) {
        if (action === 'cancel') body.cancelledReason = note;
        else body.outcomeNote = note;
      }

      adminFetch('/api/admin/booking?resource=estimate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/admin/login/';
            return null;
          }
          return res
            .json()
            .catch(function () { return null; })
            .then(function (respBody) {
              if (!res.ok) throw new Error((respBody && respBody.error) || 'Could not update this estimate.');
              return respBody;
            });
        })
        .then(function (respBody) {
          if (!respBody) return; // redirected to login
          close();
          if (opts.onComplete) opts.onComplete({ ok: true, estimate: respBody.estimate });
        })
        .catch(function (err) {
          showFieldError(err && err.message ? err.message : 'Could not update this estimate.');
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = CONFIRM_LABELS[action] || 'Confirm';
        });
    });

    overlay.removeAttribute('hidden');
  }

  return { open: open, close: close };
})();
