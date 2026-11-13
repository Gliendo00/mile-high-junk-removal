// Shared Google Places address-autocomplete helper — Phase 3C Stage 2.4.
// Used by every CRM screen that collects a physical address:
// admin/booking-new.js, admin/booking-past.js, admin/booking-edit.js and
// admin/estimate-new.js (static Service Address fields), plus the
// dynamically built Edit Client sheet (admin/client-detail.js) and the
// Intake review's Job fields (admin/intake-detail.js). Each passes its own
// street address / city / state / zip <input>s to attach().
//
// CRM address audit (2026-11): attach() is idempotent per input (safe to
// call again after a modal/form re-renders), the dropdown supports
// ArrowUp/ArrowDown/Enter/Escape as an ARIA combobox, and a failed key/
// script load is no longer cached for the rest of the page's life — the
// next keystroke retries.
//
// Architecture (see docs/phase-3/stage2.4-calendar-address-proposal.md
// "Google Address Autocomplete" for the full writeup):
//   - Uses the modern Places API (New) data classes (AutocompleteSuggestion
//     / AutocompleteSessionToken), never the legacy google.maps.places.
//     Autocomplete widget — Google stopped granting Places API (New)-era
//     projects access to that legacy class for new customers (this is a
//     brand-new Google Cloud project once the owner sets one up), and the
//     stage's own instructions prefer the modern surface regardless.
//   - Renders its own small dropdown positioned under the existing plain
//     <input id="service-address">, rather than swapping in Google's
//     <gmp-place-autocomplete> web component — keeps the existing form
//     markup/ids/styling completely unchanged, and keeps full control over
//     mobile viewport overflow (see attach()'s positioning below).
//   - On selection, reads STRUCTURED address components (addressComponents)
//     and maps them into the four existing fields — never parses a
//     formattedAddress string.
//   - Every failure mode (key fetch fails/401s, no key configured, script
//     fails to load, network error, an unexpected response shape) is
//     caught and treated as "Google unavailable for this session" — the
//     manual fields are never disabled, never required, and never blocked
//     from saving. This file cannot regress a save even if every Google
//     call inside it throws.
//   - Phase 3C Stage 2.4.1: the browser key is no longer a static,
//     committed placeholder (admin/google-maps-config.js, removed this
//     stage). It's fetched lazily from the existing authenticated
//     api/admin/bookings.js?view=google-config endpoint, which reads
//     ADMIN_GOOGLE_MAPS_API_KEY from Vercel's environment configuration —
//     never committed to this repository, never logged by this file.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
window.AdminAddressAutocomplete = (function () {
  var DEBOUNCE_MS = 220;
  var MIN_CHARS = 4;
  // Denver-area location bias (not a hard restriction — a legitimate
  // service address well outside this radius must still be selectable, see
  // the stage's explicit "must not prevent legitimate addresses elsewhere"
  // requirement). A generous circle centered on downtown Denver, bounded
  // by Places API (New)'s own hard cap: locationBias.circle.radius must be
  // <= 50,000 meters (a real 80,000 value here previously made every
  // single autocomplete request fail with INVALID_ARGUMENT once
  // credentials were otherwise correctly configured — found live during
  // Preview verification once the key's API-restriction issue was fixed
  // and this became the next real error). Kept a little under the exact
  // limit rather than exactly 50000 to leave zero boundary-rounding risk.
  var DENVER_BIAS_CENTER = { lat: 39.7392, lng: -104.9903 };
  var DENVER_BIAS_RADIUS_METERS = 48000;

  var placesLibraryPromise = null;
  var apiKeyPromise = null;
  var instanceCount = 0;
  var permissionHintLogged = false;

  // Fetches the restricted Google Maps browser key from the existing
  // authenticated endpoint, exactly once per page load however many
  // fields end up calling attach()/focus. The key is never logged, never
  // stored anywhere beyond this in-memory promise, and never touches
  // anything but the Google script URL built in loadPlacesLibrary() below.
  //
  // Deliberately does NOT redirect to /admin/login/ on a 401 the way this
  // page's own primary-data fetches (e.g. the countsOnly session check on
  // load) already do: this is a background enhancement fetch triggered by
  // focusing an address field, not core page content, so a session that
  // happens to expire mid-form-fill must never yank the owner away from
  // what they were typing — the form's own Save handler already re-checks
  // auth (and redirects) the moment they actually submit. A missing/failed
  // key here just means the dropdown never appears; nothing else changes.
  function fetchApiKey() {
    if (apiKeyPromise) return apiKeyPromise;
    apiKeyPromise = fetch("/api/admin/bookings?view=google-config")
      .then(function (res) {
        if (!res.ok) throw new Error("Could not load Google Maps configuration");
        return res.json();
      })
      .then(function (body) {
        var key = body && typeof body.googleMapsApiKey === "string" ? body.googleMapsApiKey.trim() : "";
        if (!key) throw new Error("Google Maps API key not configured");
        return key;
      })
      .catch(function (err) {
        // Not cached: a transient failure (e.g. a 401 while a sibling
        // request is mid-refresh) must not disable autocomplete for the
        // rest of this page load — the next search simply retries.
        apiKeyPromise = null;
        throw err;
      });
    return apiKeyPromise;
  }

  // Lazily loads the Google Maps JS bootstrap script + the "places" library
  // exactly once per page load, however many fields call attach(). Resolves
  // to the google.maps.places namespace; rejects (never throws) on any
  // failure, which every caller treats as "fall back to manual entry."
  function loadPlacesLibrary() {
    if (placesLibraryPromise) return placesLibraryPromise;

    placesLibraryPromise = fetchApiKey().then(function (key) {
      return new Promise(function (resolve, reject) {
        try {
          if (window.google && window.google.maps && window.google.maps.places) {
            resolve(window.google.maps.places);
            return;
          }
          // A retry after an earlier attempt already loaded the bootstrap
          // script — never append the script a second time.
          if (window.google && window.google.maps && typeof window.google.maps.importLibrary === "function") {
            window.google.maps.importLibrary("places").then(resolve, reject);
            return;
          }
          var script = document.createElement("script");
          script.async = true;
          script.src =
            "https://maps.googleapis.com/maps/api/js?key=" +
            encodeURIComponent(key) +
            "&libraries=places&loading=async&v=weekly";
          script.onerror = function () {
            reject(new Error("Failed to load the Google Maps script"));
          };
          script.onload = function () {
            // The bootstrap script is loaded with loading=async, which defers
            // each library's own initialization to run asynchronously AFTER
            // this onload fires — google.maps.places is not populated yet at
            // this exact moment (confirmed live: every onload firing observed
            // google.maps.places still undefined). google.maps.importLibrary()
            // is the API this loading mode is designed to pair with: it
            // returns its own promise that resolves only once that specific
            // library has actually finished initializing, instead of relying
            // on a script.onload timing assumption that this loading mode
            // does not honor.
            //
            // google.maps.importLibrary itself is ALSO not necessarily defined
            // the instant onload fires — confirmed live via instrumented
            // tracing: importLibrary was still undefined at the exact moment
            // onload fired, and only appeared ~60-90ms later once more of
            // Google's own internal sub-scripts finished loading. So this
            // polls briefly for importLibrary to appear rather than assuming
            // it's ready synchronously here too — the same class of race,
            // one level deeper.
            var importLibraryWaitAttempts = 0;
            var IMPORT_LIBRARY_MAX_WAIT_ATTEMPTS = 100; // ~5s at 50ms apiece
            (function waitForImportLibrary() {
              if (window.google && window.google.maps && typeof window.google.maps.importLibrary === "function") {
                window.google.maps.importLibrary("places").then(resolve, reject);
                return;
              }
              importLibraryWaitAttempts++;
              if (importLibraryWaitAttempts >= IMPORT_LIBRARY_MAX_WAIT_ATTEMPTS) {
                reject(new Error("Google Maps script loaded but google.maps.importLibrary never became available"));
                return;
              }
              setTimeout(waitForImportLibrary, 50);
            })();
          };
          document.head.appendChild(script);
        } catch (err) {
          reject(err);
        }
      });
    }).catch(function (err) {
      placesLibraryPromise = null; // see fetchApiKey()'s matching comment
      throw err;
    });

    return placesLibraryPromise;
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // Reads Google's structured addressComponents array (never a
  // formattedAddress string) into the four fields this form already has.
  // Each component type is looked up independently — a missing optional
  // component (e.g. no subpremise/unit) simply leaves that part blank
  // rather than failing the whole mapping.
  function mapAddressComponents(components) {
    var byType = {};
    (components || []).forEach(function (c) {
      (c.types || []).forEach(function (t) {
        if (!byType[t]) byType[t] = c;
      });
    });
    var streetNumber = byType.street_number ? byType.street_number.longText : "";
    var route = byType.route ? byType.route.longText : "";
    var locality = byType.locality || byType.postal_town || byType.sublocality;
    var admin1 = byType.administrative_area_level_1;
    var postal = byType.postal_code;
    return {
      address: [streetNumber, route].filter(Boolean).join(" "),
      city: locality ? locality.longText : "",
      state: admin1 ? admin1.shortText || admin1.longText : "",
      zip: postal ? postal.longText : "",
    };
  }

  // fields: { address, city, state, zip } — the four existing <input>
  // elements. Returns nothing useful to the caller; every effect happens by
  // writing into those same fields, exactly as if the owner had typed them.
  function attach(fields) {
    var addressInput = fields && fields.address;
    if (!addressInput) return;
    // Idempotent: a page that re-renders a form, or reopens a modal around
    // the same input, can call attach() again without stacking a second
    // dropdown or a second set of listeners.
    if (addressInput.getAttribute("data-address-autocomplete") === "on") return;

    // Manual typing/editing always works from the very first render —
    // everything below is a progressive-enhancement layer added on top,
    // never a replacement for the plain <input>.
    var wrapper = addressInput.parentNode;
    if (!wrapper) return; // no parent to anchor the dropdown to — never touch the input itself
    wrapper.style.position = "relative";
    addressInput.setAttribute("data-address-autocomplete", "on");

    var panelId = "admin-address-autocomplete-" + ++instanceCount;
    var panel = el("div", "admin-address-autocomplete-panel");
    panel.id = panelId;
    panel.setAttribute("role", "listbox");
    panel.setAttribute("hidden", "");
    wrapper.appendChild(panel);

    addressInput.setAttribute("role", "combobox");
    addressInput.setAttribute("aria-autocomplete", "list");
    addressInput.setAttribute("aria-controls", panelId);
    addressInput.setAttribute("aria-expanded", "false");

    var debounceTimer = null;
    var sessionToken = null;
    var currentRequestId = 0;
    var items = []; // [{ btn, prediction }] for the rendered rows
    var activeIndex = -1;
    // applySelection() dispatches a synthetic "input" event on addressInput
    // itself so external listeners (a form's own change tracking) see the
    // populated value — but that same event also reaches this component's
    // OWN "input" listener below, which would otherwise read it as a new
    // user keystroke and kick off another debounced search, reopening the
    // panel ~DEBOUNCE_MS after a selection was just made and closed. This
    // flag lets the synthetic dispatch notify every listener (nothing is
    // suppressed for anyone else) while telling this component's own
    // listener, and only that one, to treat this specific event as an
    // internal echo rather than real typing.
    var suppressNextInputEvent = false;

    function closePanel() {
      panel.setAttribute("hidden", "");
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      items = [];
      activeIndex = -1;
      addressInput.setAttribute("aria-expanded", "false");
      addressInput.removeAttribute("aria-activedescendant");
    }

    function setActive(index) {
      activeIndex = index;
      items.forEach(function (item, i) {
        var on = i === index;
        item.btn.classList.toggle("is-active", on);
        item.btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      if (index >= 0 && items[index]) {
        addressInput.setAttribute("aria-activedescendant", items[index].btn.id);
        if (typeof items[index].btn.scrollIntoView === "function") items[index].btn.scrollIntoView({ block: "nearest" });
      } else {
        addressInput.removeAttribute("aria-activedescendant");
      }
    }

    function selectPrediction(prediction) {
      Promise.resolve(prediction.toPlace())
        .then(function (place) {
          return place.fetchFields({ fields: ["addressComponents"] }).then(function () {
            return place;
          });
        })
        .then(applySelection)
        .catch(function (err) {
          console.error("Address autocomplete: failed to fetch place details", err);
          closePanel();
        });
    }

    function ensureSessionToken(placesLib) {
      if (!sessionToken) sessionToken = new placesLib.AutocompleteSessionToken();
      return sessionToken;
    }

    function applySelection(place) {
      try {
        var mapped = mapAddressComponents(place.addressComponents);
        if (mapped.address) addressInput.value = mapped.address;
        if (fields.city && mapped.city) fields.city.value = mapped.city;
        if (fields.state && mapped.state) fields.state.value = mapped.state;
        if (fields.zip && mapped.zip) fields.zip.value = mapped.zip;
        // Fire native input events so any listener already bound to these
        // fields (e.g. a form's own change tracking) sees the update —
        // this file never assumes it's the only code watching these
        // inputs. addressInput's own "input" listener below is told to
        // ignore this one, specific dispatch (see suppressNextInputEvent
        // above) so this synthetic notification never triggers a new
        // search; every other listener on every field still gets it.
        suppressNextInputEvent = true;
        [addressInput, fields.city, fields.state, fields.zip].forEach(function (input) {
          if (input) input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      } catch (err) {
        // A selection that fails to map cleanly is simply not applied —
        // the fields are left exactly as they were (whatever the owner had
        // typed), never partially overwritten or blanked.
        console.error("Address autocomplete: could not apply the selected place", err);
      }
      sessionToken = null; // a session ends once a Place is fetched, per Google's session-token model
      closePanel();
    }

    function renderSuggestions(placesLib, list) {
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      items = [];
      activeIndex = -1;
      addressInput.removeAttribute("aria-activedescendant");
      list.forEach(function (suggestion) {
        var prediction = suggestion.placePrediction;
        if (!prediction) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-address-autocomplete-item";
        btn.id = panelId + "-option-" + items.length;
        btn.tabIndex = -1; // keyboard focus stays in the input; arrows move the highlight
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", "false");
        var mainText = (prediction.mainText && prediction.mainText.text) || (prediction.text && prediction.text.text) || "";
        var secondaryText = (prediction.secondaryText && prediction.secondaryText.text) || "";
        var mainSpan = document.createElement("span");
        mainSpan.className = "admin-address-autocomplete-item-main";
        mainSpan.textContent = mainText;
        btn.appendChild(mainSpan);
        if (secondaryText) {
          var secSpan = document.createElement("span");
          secSpan.className = "admin-address-autocomplete-item-secondary";
          secSpan.textContent = secondaryText;
          btn.appendChild(secSpan);
        }
        btn.addEventListener("click", function () {
          selectPrediction(prediction);
        });
        panel.appendChild(btn);
        items.push({ btn: btn, prediction: prediction });
      });
      if (!items.length) {
        closePanel();
        return;
      }
      panel.removeAttribute("hidden");
      addressInput.setAttribute("aria-expanded", "true");
    }

    function runSearch(placesLib, term) {
      var requestId = ++currentRequestId;
      var request = {
        input: term,
        sessionToken: ensureSessionToken(placesLib),
        includedRegionCodes: ["us"],
        locationBias: {
          center: DENVER_BIAS_CENTER,
          radius: DENVER_BIAS_RADIUS_METERS,
        },
      };
      placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
        .then(function (result) {
          if (requestId !== currentRequestId) return; // superseded by a newer keystroke
          renderSuggestions(placesLib, (result && result.suggestions) || []);
        })
        .catch(function (err) {
          if (requestId !== currentRequestId) return;
          console.error("Address autocomplete: suggestion request failed", err);
          // A permission error is a Google Cloud configuration problem, not
          // a code bug — say so once, in plain words, without the key.
          if (!permissionHintLogged && /permission|PERMISSION_DENIED|403/i.test(String(err && (err.message || err)))) {
            permissionHintLogged = true;
            console.error(
              "Address autocomplete: Google denied the request. Check that \"Places API (New)\" is enabled for the Google Cloud project and allowed in the browser key's API restrictions, and that this site's domain is in the key's website restrictions."
            );
          }
          closePanel();
        });
    }

    addressInput.addEventListener("input", function () {
      if (suppressNextInputEvent) {
        suppressNextInputEvent = false;
        return;
      }
      clearTimeout(debounceTimer);
      var term = addressInput.value.trim();
      if (term.length < MIN_CHARS) {
        closePanel();
        return;
      }
      debounceTimer = setTimeout(function () {
        loadPlacesLibrary()
          .then(function (placesLib) {
            runSearch(placesLib, term);
          })
          .catch(function () {
            // Google unavailable (no key configured, load failure, etc.) —
            // silently do nothing further. The input stays a fully plain,
            // fully usable manual text field.
          });
      }, DEBOUNCE_MS);
    });

    addressInput.addEventListener("keydown", function (e) {
      var open = !panel.hasAttribute("hidden") && items.length > 0;
      if (e.key === "Escape") {
        if (open) {
          // Inside a modal (e.g. Edit Client's sheet, which closes on a
          // document-level Escape), close only the dropdown first — never
          // throw away the owner's in-progress edit along with it.
          e.preventDefault();
          e.stopPropagation();
        }
        closePanel();
        return;
      }
      if (!open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(activeIndex < items.length - 1 ? activeIndex + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(activeIndex > 0 ? activeIndex - 1 : items.length - 1);
      } else if (e.key === "Enter" && activeIndex >= 0) {
        // Only swallows Enter when a suggestion is highlighted — with
        // nothing highlighted, Enter keeps its normal form behavior.
        e.preventDefault();
        selectPrediction(items[activeIndex].prediction);
      } else if (e.key === "Tab") {
        closePanel();
      }
    });

    // Removes itself once the input leaves the DOM (a closed modal or a
    // re-rendered form), so dynamic screens never accumulate listeners.
    function onDocumentClick(e) {
      if (!addressInput.isConnected) {
        document.removeEventListener("click", onDocumentClick);
        return;
      }
      if (!wrapper.contains(e.target)) closePanel();
    }
    document.addEventListener("click", onDocumentClick);

    // Warms the script load on first focus (not on page load) so a page
    // that never touches the address field never pays the Google script
    // cost at all — and a missing/misconfigured key never delays or blocks
    // the form from being usable.
    addressInput.addEventListener(
      "focus",
      function () {
        loadPlacesLibrary().catch(function () {});
      },
      { once: true }
    );
  }

  return { attach: attach };
})();
