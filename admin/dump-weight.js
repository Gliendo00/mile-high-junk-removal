// Dump Fee Tonnage Tracking — the optional "Dump Weight: [____] lbs" row
// shared by admin/expenses.js (full Add/Edit Expense sheet) and
// admin/quick-expense.js (the Schedule/Home quick Dump button). Exposes
// window.AdminDumpWeight; must be loaded before either of those files.
//
// Pounds are what get submitted (dump scale tickets print pounds); the
// "= 2.50 tons" line is a live display-only preview using the same
// lbs / 2000 rule as api/_lib/dump-tonnage.js (small mirrored constant,
// same convention as the category lists). Never touches the dollar amount.
(function () {
  'use strict';

  var LBS_PER_TON = 2000;
  var MAX_LBS = 200000;

  // '' / whitespace -> null (no weight). Tolerates "5,000". Returns NaN
  // for anything else that isn't a positive number within bounds.
  function parseLbs(raw) {
    var cleaned = String(raw == null ? '' : raw).trim().replace(/,/g, '');
    if (!cleaned) return null;
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
    var n = Number(cleaned);
    if (!(n > 0) || n > MAX_LBS) return NaN;
    return Math.round(n * 100) / 100;
  }

  function formatLbs(lbs) {
    return Number(lbs).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function formatTons(lbs) {
    return (Number(lbs) / LBS_PER_TON).toFixed(2);
  }
  function describe(lbs) {
    return formatLbs(lbs) + ' lbs = ' + formatTons(lbs) + ' tons';
  }

  function build(initialLbs) {
    var row = document.createElement('div');
    row.className = 'admin-field admin-dump-weight-field';

    var label = document.createElement('label');
    label.textContent = 'Dump Weight (optional)';
    row.appendChild(label);

    var inputWrap = document.createElement('div');
    inputWrap.className = 'admin-dump-weight-input';
    var input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.placeholder = 'e.g. 5000';
    input.setAttribute('aria-label', 'Dump weight in pounds');
    if (initialLbs !== null && initialLbs !== undefined && initialLbs !== '') input.value = String(initialLbs);
    inputWrap.appendChild(input);
    var unit = document.createElement('span');
    unit.className = 'admin-dump-weight-unit';
    unit.textContent = 'lbs';
    inputWrap.appendChild(unit);
    row.appendChild(inputWrap);

    var preview = document.createElement('div');
    preview.className = 'admin-field-hint admin-dump-weight-preview';
    preview.setAttribute('aria-live', 'polite');
    row.appendChild(preview);

    function refreshPreview() {
      var v = parseLbs(input.value);
      if (v === null) {
        preview.textContent = 'From the scale ticket. Leave blank if you don’t have it.';
        preview.classList.remove('is-error');
      } else if (isNaN(v)) {
        preview.textContent = 'Enter pounds as a number, e.g. 5000.';
        preview.classList.add('is-error');
      } else {
        preview.textContent = describe(v);
        preview.classList.remove('is-error');
      }
    }
    input.addEventListener('input', refreshPreview);
    refreshPreview();

    return {
      el: row,
      input: input,
      setVisible: function (visible) {
        row.style.display = visible ? '' : 'none';
      },
      isValid: function () {
        return !isNaN(parseLbs(input.value));
      },
      // null when blank — the server stores NULL, never 0.
      getValue: function () {
        var v = parseLbs(input.value);
        return v === null || isNaN(v) ? null : v;
      },
    };
  }

  window.AdminDumpWeight = { build: build, describe: describe, formatTons: formatTons, parseLbs: parseLbs };
})();
