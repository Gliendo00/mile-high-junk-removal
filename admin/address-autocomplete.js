// Shared Google Places address-autocomplete helper — Phase 3C Stage 2.4.
// Used by admin/booking-new.js, admin/booking-past.js, and
// admin/booking-edit.js's Service Address fields (three plain <input>s:
// street address / city / state / zip — same ids on every page).
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
            if (window.google && window.google.maps && typeof window.google.maps.importLibrary === "function") {
              window.google.maps.importLibrary("places").then(resolve, reject);
            } else {
              reject(new Error("Google Maps script loaded but google.maps.importLibrary is unavailable"));
            }
          };
          document.head.appendChild(script);
        } catch (err) {
          reject(err);
        }
      });
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

    // Manual typing/editing always works from the very first render —
    // everything below is a progressive-enhancement layer added on top,
    // never a replacement for the plain <input>.
    var wrapper = addressInput.parentNode;
    if (wrapper) wrapper.style.position = "relative";

    var panel = el("div", "admin-address-autocomplete-panel");
    panel.setAttribute("hidden", "");
    if (wrapper) wrapper.appendChild(panel);
    else return; // no parent to anchor the dropdown to — never touch the input itself

    var debounceTimer = null;
    var sessionToken = null;
    var currentRequestId = 0;
    var suggestions = []; // the current AutocompleteSuggestion[]

    function closePanel() {
      panel.setAttribute("hidden", "");
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      suggestions = [];
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
        // inputs.
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
      if (!list.length) {
        panel.setAttribute("hidden", "");
        return;
      }
      list.forEach(function (suggestion) {
        var prediction = suggestion.placePrediction;
        if (!prediction) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-address-autocomplete-item";
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
        });
        panel.appendChild(btn);
      });
      panel.removeAttribute("hidden");
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
          suggestions = (result && result.suggestions) || [];
          renderSuggestions(placesLib, suggestions);
        })
        .catch(function (err) {
          if (requestId !== currentRequestId) return;
          console.error("Address autocomplete: suggestion request failed", err);
          closePanel();
        });
    }

    addressInput.addEventListener("input", function () {
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
      if (e.key === "Escape") closePanel();
    });

    document.addEventListener("click", function (e) {
      if (wrapper && !wrapper.contains(e.target)) closePanel();
    });

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
