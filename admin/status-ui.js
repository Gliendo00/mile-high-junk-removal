// Shared status-picker bottom sheet, used by:
//   - admin/dashboard.js (the "More" filter menu — read-only, picks which
//     status to filter the list by)
//   - admin/booking-detail.js (the status editor — picks a new value to
//     save via PATCH /api/admin/booking-status)
//
// This module only renders UI and reports which option was tapped; it never
// makes a network call itself. All rendering uses textContent/DOM
// construction (no innerHTML), matching the rest of /admin.
window.AdminStatusUI = (function () {
  var STATUS_ORDER = ["new", "contacted", "quoted", "booked", "completed", "lost"];
  var STATUS_TEXT = { new: "New", contacted: "Contacted", quoted: "Quoted", booked: "Booked", completed: "Completed", lost: "Lost" };

  var overlay = null;
  var sheet = null;
  var onCloseCallback = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "admin-sheet-overlay";
    overlay.setAttribute("hidden", "");

    sheet = document.createElement("div");
    sheet.className = "admin-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    overlay.appendChild(sheet);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !overlay.hasAttribute("hidden")) close();
    });

    document.body.appendChild(overlay);
  }

  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }

  function close() {
    if (!overlay) return;
    overlay.setAttribute("hidden", "");
    clearSheet();
    if (onCloseCallback) {
      var cb = onCloseCallback;
      onCloseCallback = null;
      cb();
    }
  }

  // opts: { title, values (array of status keys to show, defaults to all
  // six), selected (current status key), onSelect(statusKey), onClose }
  function open(opts) {
    opts = opts || {};
    ensureDom();
    clearSheet();

    if (opts.title) {
      var titleEl = document.createElement("div");
      titleEl.className = "admin-sheet-title";
      titleEl.textContent = opts.title;
      sheet.appendChild(titleEl);
    }

    var list = document.createElement("div");
    list.className = "admin-sheet-list";
    var values = opts.values && opts.values.length ? opts.values : STATUS_ORDER;

    values.forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "admin-sheet-option";
      if (key === opts.selected) btn.classList.add("is-selected");

      var dot = document.createElement("span");
      dot.className = "admin-sheet-dot admin-status-dot-" + key;
      btn.appendChild(dot);

      var label = document.createElement("span");
      label.className = "admin-sheet-option-label";
      label.textContent = STATUS_TEXT[key] || key;
      btn.appendChild(label);

      if (key === opts.selected) {
        var check = document.createElement("span");
        check.className = "admin-sheet-check";
        check.textContent = "✓";
        check.setAttribute("aria-hidden", "true");
        btn.appendChild(check);
      }

      btn.addEventListener("click", function () {
        close();
        if (opts.onSelect) opts.onSelect(key);
      });

      list.appendChild(btn);
    });
    sheet.appendChild(list);

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "admin-sheet-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    sheet.appendChild(cancel);

    onCloseCallback = opts.onClose || null;
    overlay.removeAttribute("hidden");
  }

  return { open: open, close: close, STATUS_ORDER: STATUS_ORDER, STATUS_TEXT: STATUS_TEXT };
})();
