// Shared "find or create a client" widget — Phase 3C Client Typeahead UX.
// Used by admin/booking-new.js ("+ New Job") and admin/booking-past.js
// ("+ Past Job")'s Client field. Evolves the Stage 2.1 bottom-sheet picker:
// the search step is now an inline typeahead mounted directly into the
// page (no modal — see docs/phase-3/stage2-decisions.md and the Client
// Typeahead UX task for why search specifically must not use a sheet).
// Create Client / duplicate-handling keep the exact Stage 2.1 bottom-sheet
// UI and server-side policy unchanged (see
// docs/phase-3/stage2-decisions.md#3-admin-duplicate-client-behavior--locked):
// an exact phone+email match from POST /api/admin/client (409) is shown as
// a prominent "already exists" card with "Use This Client" / "Create
// Anyway" — never silently merged, never silently duplicated.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching the discipline
// already established by admin/status-ui.js and every other admin script.
window.AdminClientPicker = (function () {
  var SEARCH_DEBOUNCE_MS = 150;
  var SEARCH_LIMIT = 8;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------
  // Create/duplicate bottom sheet. Unchanged behavior from Stage 2.1 — only
  // ever opened now via the inline typeahead's "+ Create Client" action
  // (see mount() below), never used for searching.
  // ---------------------------------------------------------------------
  var overlay = null;
  var sheet = null;
  var onCreateResolve = null; // function(client, warnings)

  function ensureSheetDom() {
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
      if (e.target === overlay) closeSheet();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !overlay.hasAttribute("hidden")) closeSheet();
    });

    document.body.appendChild(overlay);
  }

  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }

  function closeSheet() {
    if (!overlay) return;
    overlay.setAttribute("hidden", "");
    clearSheet();
    onCreateResolve = null;
  }

  function resolveCreate(client, warnings) {
    var cb = onCreateResolve;
    closeSheet();
    if (cb) cb(client, warnings || []);
  }

  // Create view: minimal inline form. Only First Name is required — see
  // docs/phase-3/stage2-decisions.md's phone-optional amendment.
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

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "admin-btn admin-btn-outline";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeSheet);
    actions.appendChild(cancelBtn);

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

      adminFetch("/api/admin/client", {
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
            resolveCreate(result.body.client, result.body.warnings || []);
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

  // Duplicate view: an exact phone+email match was found. Prominent, not
  // styled as an error — this is useful information, not a failure.
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
      resolveCreate(existingClient, []);
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

    var cancelBtn = el("button", "admin-sheet-cancel", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", closeSheet);
    sheet.appendChild(cancelBtn);
  }

  // prefillFirstName: the raw typed search text, dropped into the First
  // Name field as-is — same behavior the old search-sheet's "+ Add a new
  // client" button already had (no name-splitting heuristic; never
  // fabricates phone/email/address).
  function openCreateSheet(prefillFirstName, onResolve) {
    onCreateResolve = onResolve;
    ensureSheetDom();
    renderCreateView({ firstName: prefillFirstName || "" });
    overlay.removeAttribute("hidden");
    setTimeout(function () {
      var first = sheet.querySelector("input");
      if (first) first.focus();
    }, 0);
  }

  // ---------------------------------------------------------------------
  // Inline typeahead — mounted directly into the page's Client field.
  // Debounced search against the existing GET /api/admin/clients; never
  // searches on empty/whitespace-only input; a result is only ever chosen
  // by an explicit click/tap (or Enter on a keyboard-highlighted result) —
  // nothing here auto-selects a client.
  // ---------------------------------------------------------------------
  // container: an empty element to render into.
  // opts: { onSelect(client|null, warnings) } — called with null when the
  // owner clears a selection via "Change", and with a client + warnings
  // array (possibly empty) whenever one is chosen or created.
  function mount(container, opts) {
    opts = opts || {};
    var onSelect = opts.onSelect || function () {};

    while (container.firstChild) container.removeChild(container.firstChild);

    var root = el("div", "admin-client-picker");
    container.appendChild(root);

    // Filled (selected) state.
    var summary = el("div", "admin-client-summary");
    summary.setAttribute("hidden", "");
    var summaryText = el("div");
    var summaryName = el("div", "admin-client-summary-name", "—");
    var summaryMeta = el("div", "admin-client-summary-meta", "—");
    summaryText.appendChild(summaryName);
    summaryText.appendChild(summaryMeta);
    summary.appendChild(summaryText);
    var changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "admin-btn admin-btn-outline";
    changeBtn.textContent = "Change";
    summary.appendChild(changeBtn);
    root.appendChild(summary);

    // Empty (typeahead) state.
    var typeahead = el("div", "admin-client-typeahead");
    var input = document.createElement("input");
    input.type = "search";
    input.className = "admin-search-input";
    input.placeholder = "Start typing a client name…";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", "Search clients by name, phone, or email");
    input.setAttribute("aria-expanded", "false");
    typeahead.appendChild(input);

    var panel = el("div", "admin-typeahead-panel");
    panel.setAttribute("hidden", "");
    var resultsBox = el("div", "admin-picker-results");
    panel.appendChild(resultsBox);
    var createToggle = el("button", "admin-picker-create-toggle", "+ Create Client");
    createToggle.type = "button";
    panel.appendChild(createToggle);
    typeahead.appendChild(panel);
    root.appendChild(typeahead);

    var debounceTimer = null;
    var focusables = []; // current result buttons + createToggle, in order
    var highlightedIndex = -1;
    var panelOpen = false;
    var currentAbortController = null; // the one in-flight GET /api/admin/clients, if any

    // Cancels whatever search is currently in flight so its response can
    // never land after (and overwrite) a newer one — the abort rejects that
    // fetch with an AbortError, which runSearch's catch below ignores.
    function abortInFlightSearch() {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    }

    function setHighlight(idx) {
      focusables.forEach(function (b) { b.classList.remove("is-highlighted"); });
      highlightedIndex = idx;
      if (idx >= 0 && idx < focusables.length) {
        focusables[idx].classList.add("is-highlighted");
      }
    }

    function openPanel() {
      panel.removeAttribute("hidden");
      input.setAttribute("aria-expanded", "true");
      panelOpen = true;
    }
    function closePanel() {
      panel.setAttribute("hidden", "");
      input.setAttribute("aria-expanded", "false");
      panelOpen = false;
      setHighlight(-1);
    }

    // Single document-level listener for the life of this widget, guarded
    // by panelOpen — avoids the duplicate-binding bugs a naive add/remove
    // per open() call would risk.
    document.addEventListener("mousedown", function (e) {
      if (panelOpen && !root.contains(e.target)) closePanel();
    }, true);

    function resultsBoxClear() {
      while (resultsBox.firstChild) resultsBox.removeChild(resultsBox.firstChild);
    }

    function showFilled(client) {
      var name = [client.firstName, client.lastName].filter(Boolean).join(" ") || "Unnamed client";
      summaryName.textContent = name;
      var metaParts = [];
      if (client.phone) metaParts.push(client.phone);
      if (client.email) metaParts.push(client.email);
      summaryMeta.textContent = metaParts.length ? metaParts.join(" · ") : "No contact info on file";
      summary.removeAttribute("hidden");
      typeahead.setAttribute("hidden", "");
    }

    function showEmpty(focusInput) {
      summary.setAttribute("hidden", "");
      typeahead.removeAttribute("hidden");
      input.value = "";
      closePanel();
      resultsBoxClear();
      if (focusInput) setTimeout(function () { input.focus(); }, 0);
    }

    function selectExisting(client) {
      abortInFlightSearch(); // the search itself is moot once a result is chosen
      closePanel();
      showFilled(client);
      onSelect(client, []);
    }

    // Immediate feedback shown the instant the owner types — before the
    // debounce/network round trip even starts — so the field never reads as
    // unresponsive while waiting on SEARCH_DEBOUNCE_MS + the request itself.
    function renderLoading() {
      resultsBoxClear();
      resultsBox.appendChild(el("div", "admin-picker-empty", "Searching…"));
      focusables = [createToggle];
      setHighlight(-1);
      openPanel();
    }

    function renderResults(clients) {
      resultsBoxClear();
      if (!clients.length) {
        resultsBox.appendChild(el("div", "admin-picker-empty", "No matching clients"));
      } else {
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
            selectExisting({ id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email });
          });
          resultsBox.appendChild(btn);
        });
      }
      focusables = Array.prototype.slice.call(resultsBox.querySelectorAll(".admin-picker-item")).concat([createToggle]);
      setHighlight(-1);
      openPanel();
    }

    function runSearch(term) {
      // Cancel whatever search is still in flight — its result is obsolete
      // the moment a newer one starts, and an aborted fetch rejects rather
      // than resolving, so it can never render over these fresher results.
      abortInFlightSearch();
      var controller = new AbortController();
      currentAbortController = controller;
      var url = "/api/admin/clients?limit=" + SEARCH_LIMIT + "&search=" + encodeURIComponent(term);
      adminFetch(url, { signal: controller.signal })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = "/admin/login/";
            return null;
          }
          if (!res.ok) throw new Error("search failed");
          return res.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (!body) return;
          renderResults(body.clients || []);
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return; // superseded by a newer search — not a real failure
          resultsBoxClear();
          resultsBox.appendChild(el("div", "admin-picker-empty", "Could not load clients right now."));
          focusables = [createToggle];
          setHighlight(-1);
          openPanel();
        });
    }

    // Debounced (at SEARCH_DEBOUNCE_MS) so we don't fire a request on every
    // raw keystroke; a cleared/whitespace-only input never searches — it
    // just closes the dropdown, matching "Start typing a client name..." as
    // the resting state rather than an always-open recent-clients list. The
    // "Searching..." feedback below fires immediately, independent of the
    // debounce delay, so the field never reads as unresponsive while typing.
    input.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      var value = input.value.trim();
      if (!value) {
        abortInFlightSearch();
        closePanel();
        resultsBoxClear();
        return;
      }
      renderLoading();
      debounceTimer = setTimeout(function () {
        runSearch(value);
      }, SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        // The Client field lives inside the job form — always prevent the
        // default submit, whether or not a result is highlighted.
        e.preventDefault();
        if (highlightedIndex >= 0 && focusables[highlightedIndex]) {
          focusables[highlightedIndex].click();
        }
        return;
      }
      if (e.key === "Escape") {
        if (panelOpen) {
          e.stopPropagation();
          closePanel();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        if (!panelOpen || !focusables.length) return;
        e.preventDefault();
        setHighlight(highlightedIndex < focusables.length - 1 ? highlightedIndex + 1 : 0);
        return;
      }
      if (e.key === "ArrowUp") {
        if (!panelOpen || !focusables.length) return;
        e.preventDefault();
        setHighlight(highlightedIndex > 0 ? highlightedIndex - 1 : focusables.length - 1);
      }
    });

    createToggle.addEventListener("click", function () {
      var typedName = input.value.trim();
      abortInFlightSearch(); // moving to Create Client makes any pending search moot
      closePanel();
      openCreateSheet(typedName, function (client, warnings) {
        showFilled(client);
        onSelect(client, warnings);
      });
    });

    // "Change" clears the current selection outright (never leaves a stale
    // client selected behind a search box that visually reads as empty) —
    // the owner must pick or create a client again from a clean state.
    changeBtn.addEventListener("click", function () {
      onSelect(null, []);
      showEmpty(true);
    });
  }

  return { mount: mount };
})();
