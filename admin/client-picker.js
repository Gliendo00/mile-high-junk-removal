// Shared "find or create a client" bottom sheet — Phase 3C Stage 2.1.
// Used by admin/booking-new.js ("+ New Job") today; built reusable
// (window.AdminClientPicker, mirroring window.AdminStatusUI's shape) since
// "+ Past Job" (a later stage) needs the identical picker.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching the discipline
// already established by admin/status-ui.js and every other admin script.
//
// Duplicate-client policy implemented here (locked, see
// docs/phase-3/stage2-decisions.md#3-admin-duplicate-client-behavior--locked):
// an exact phone+email match from POST /api/admin/client (409) is shown as
// a prominent "already exists" card with "Use This Client" / "Create
// Anyway" — never silently merged, never silently duplicated.
window.AdminClientPicker = (function () {
  var SEARCH_DEBOUNCE_MS = 300;
  var SEARCH_LIMIT = 8;

  var overlay = null;
  var sheet = null;
  var onSelectCallback = null;
  var onCloseCallback = null;
  var searchSeq = 0;
  var debounceTimer = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

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

  function selectClient(client, warnings) {
    var cb = onSelectCallback;
    close();
    if (cb) cb(client, warnings || []);
  }

  // ---------------------------------------------------------------------
  // Search view: a search box + results, and a way to switch to creating a
  // new client instead.
  // ---------------------------------------------------------------------
  function renderSearchView(prefillName) {
    clearSheet();

    var title = el("div", "admin-sheet-title", "Find Client");
    sheet.appendChild(title);

    var searchBar = el("div", "admin-search-bar");
    var input = document.createElement("input");
    input.type = "search";
    input.className = "admin-search-input";
    input.placeholder = "Search by name, phone, or email";
    if (prefillName) input.value = prefillName;
    searchBar.appendChild(input);
    sheet.appendChild(searchBar);

    var results = el("div", "admin-picker-results");
    sheet.appendChild(results);

    var createToggle = el("button", "admin-picker-create-toggle", "+ Add a new client");
    createToggle.type = "button";
    createToggle.addEventListener("click", function () {
      renderCreateView({ firstName: input.value.trim() });
    });
    sheet.appendChild(createToggle);

    var cancel = el("button", "admin-sheet-cancel", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", close);
    sheet.appendChild(cancel);

    function renderResults(clients) {
      while (results.firstChild) results.removeChild(results.firstChild);
      if (!clients.length) {
        results.appendChild(el("div", "admin-picker-empty", "No matching clients. You can add a new one below."));
        return;
      }
      clients.forEach(function (c) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-picker-item";
        var name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed client";
        btn.appendChild(el("span", "admin-picker-item-name", name));
        var metaParts = [];
        if (c.phone) metaParts.push(c.phone);
        if (c.city) metaParts.push(c.city);
        btn.appendChild(el("span", "admin-picker-item-meta", metaParts.join(" · ") || "No contact info on file"));
        btn.addEventListener("click", function () {
          selectClient({ id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email }, []);
        });
        results.appendChild(btn);
      });
    }

    function runSearch(term) {
      var seq = ++searchSeq;
      var url = "/api/admin/clients?limit=" + SEARCH_LIMIT + (term ? "&search=" + encodeURIComponent(term) : "");
      fetch(url)
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = "/admin/login/";
            return null;
          }
          if (!res.ok) throw new Error("search failed");
          return res.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (!body || seq !== searchSeq) return;
          renderResults(body.clients || []);
        })
        .catch(function () {
          if (seq !== searchSeq) return;
          results.appendChild(el("div", "admin-picker-empty", "Could not load clients right now."));
        });
    }

    input.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      var value = input.value.trim();
      debounceTimer = setTimeout(function () {
        runSearch(value);
      }, SEARCH_DEBOUNCE_MS);
    });

    runSearch(prefillName || "");
    setTimeout(function () { input.focus(); }, 0);
  }

  // ---------------------------------------------------------------------
  // Create view: minimal inline form. Only First Name is required — see
  // docs/phase-3/stage2-decisions.md's phone-optional amendment.
  // ---------------------------------------------------------------------
  function renderCreateView(prefill, confirmCreateAnyway) {
    clearSheet();
    prefill = prefill || {};

    sheet.appendChild(el("div", "admin-sheet-title", "Add New Client"));

    var errorBox = el("div", "admin-alert admin-alert-error");
    sheet.appendChild(errorBox);
    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add("is-visible");
    }
    function clearError() {
      errorBox.textContent = "";
      errorBox.classList.remove("is-visible");
    }

    function field(labelText, type, value) {
      var wrap = el("div", "admin-field");
      var label = document.createElement("label");
      label.textContent = labelText;
      wrap.appendChild(label);
      var input = document.createElement("input");
      input.type = type || "text";
      if (value) input.value = value;
      wrap.appendChild(input);
      sheet.appendChild(wrap);
      return input;
    }

    var firstNameInput = field("First Name", "text", prefill.firstName);
    var lastNameInput = field("Last Name (optional)", "text", prefill.lastName);
    var phoneInput = field("Phone (optional)", "tel", prefill.phone);
    var emailInput = field("Email (optional)", "email", prefill.email);

    var actions = el("div", "admin-duplicate-card-actions");
    sheet.appendChild(actions);

    var createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "admin-btn admin-btn-primary";
    createBtn.textContent = "Create Client";
    actions.appendChild(createBtn);

    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "admin-btn admin-btn-outline";
    backBtn.textContent = "Back to Search";
    backBtn.addEventListener("click", function () {
      renderSearchView(firstNameInput.value.trim());
    });
    actions.appendChild(backBtn);

    var cancel = el("button", "admin-sheet-cancel", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", close);
    sheet.appendChild(cancel);

    createBtn.addEventListener("click", function () {
      clearError();
      var payload = {
        firstName: firstNameInput.value.trim(),
        lastName: lastNameInput.value.trim(),
        phone: phoneInput.value.trim(),
        email: emailInput.value.trim(),
      };
      if (!payload.firstName) {
        showError("First name is required.");
        return;
      }
      if (confirmCreateAnyway) payload.confirmCreateAnyway = true;

      createBtn.disabled = true;
      createBtn.textContent = "Creating…";

      fetch("/api/admin/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = "/admin/login/";
            return null;
          }
          return res.json().catch(function () { return null; }).then(function (body) {
            return { status: res.status, body: body };
          });
        })
        .then(function (result) {
          if (!result) return; // redirected to login
          if (result.status === 200 && result.body && result.body.ok) {
            selectClient(result.body.client, result.body.warnings || []);
            return;
          }
          if (result.status === 409 && result.body && result.body.code === "duplicate_client") {
            renderDuplicateView(result.body.existingClient, payload);
            return;
          }
          showError((result.body && result.body.error) || "Could not create client.");
        })
        .catch(function () {
          showError("Could not create client. Please try again.");
        })
        .finally(function () {
          createBtn.disabled = false;
          createBtn.textContent = "Create Client";
        });
    });
  }

  // ---------------------------------------------------------------------
  // Duplicate view: an exact phone+email match was found. Prominent, not
  // styled as an error — this is useful information, not a failure.
  // ---------------------------------------------------------------------
  function renderDuplicateView(existingClient, attemptedPayload) {
    clearSheet();
    sheet.appendChild(el("div", "admin-sheet-title", "Client Already Exists"));

    var card = el("div", "admin-duplicate-card");
    card.appendChild(el("div", "admin-duplicate-card-title", "Matching phone and email found"));
    var name = [existingClient.firstName, existingClient.lastName].filter(Boolean).join(" ") || "Unnamed client";
    card.appendChild(el("div", "admin-duplicate-card-name", name));
    var metaParts = [];
    if (existingClient.phone) metaParts.push(existingClient.phone);
    if (existingClient.email) metaParts.push(existingClient.email);
    if (existingClient.city) metaParts.push(existingClient.city);
    card.appendChild(el("div", "admin-duplicate-card-meta", metaParts.join(" · ")));

    var actions = el("div", "admin-duplicate-card-actions");
    var useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "admin-btn admin-btn-primary";
    useBtn.textContent = "Use This Client";
    useBtn.addEventListener("click", function () {
      selectClient(existingClient, []);
    });
    actions.appendChild(useBtn);

    var anywayBtn = document.createElement("button");
    anywayBtn.type = "button";
    anywayBtn.className = "admin-btn admin-btn-outline";
    anywayBtn.textContent = "Create Anyway";
    anywayBtn.addEventListener("click", function () {
      renderCreateView(attemptedPayload, true);
    });
    actions.appendChild(anywayBtn);

    card.appendChild(actions);
    sheet.appendChild(card);

    var backBtn = el("button", "admin-sheet-cancel", "Back to Search");
    backBtn.type = "button";
    backBtn.addEventListener("click", function () {
      renderSearchView(attemptedPayload.firstName);
    });
    sheet.appendChild(backBtn);
  }

  // opts: { onSelect(client, warnings), onClose(), prefillName }
  function open(opts) {
    opts = opts || {};
    onSelectCallback = opts.onSelect || null;
    onCloseCallback = opts.onClose || null;
    ensureDom();
    renderSearchView(opts.prefillName || "");
    overlay.removeAttribute("hidden");
  }

  return { open: open, close: close };
})();
