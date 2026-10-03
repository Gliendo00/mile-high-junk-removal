// Shared US phone display formatter — Batch 4 (A). Loaded via a plain
// <script> tag (same pattern as admin-fetch.js/nav-badge.js/status-ui.js —
// this project's established convention for logic genuinely shared across
// several admin pages, as opposed to a small constant cheap enough to
// duplicate per file, e.g. buildTelHref()).
//
// Presentation only — never touches storage. customers.phone is stored
// exactly as typed (sanitized/validated, never reformatted — see
// api/admin/client.js/api/book.js), so existing rows are a mix of shapes:
// "3035551234", "(303) 555-1234", "303.555.1234", "+13035551234", etc.
// window.formatPhone() normalizes all of those to one consistent display
// string, "(303) 555-1234", without altering the underlying value anywhere
// it's used for matching/search/texting/calling/integrations — those all
// already derive their own digits-only value directly from the raw stored
// phone (see every admin page's own buildTelHref()/buildSmsHref(), and
// api/_lib/customer-identity.js's normalizePhone() server-side), never
// from this formatter's output.
window.formatPhone = (function () {
  // Same "strip to digits, then drop a leading US country-code 1 only when
  // the result is exactly 11 digits" rule as api/_lib/customer-identity.js's
  // normalizePhone() — so "+1 (303) 555-0100" and "303.555.0100" both
  // format identically, matching the value they'd both normalize to.
  return function formatPhone(raw) {
    var str = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : String(raw).trim();
    if (!str) return "";

    var digits = str.replace(/\D/g, "");
    var tenDigit = digits;
    if (digits.length === 11 && digits.charAt(0) === "1") {
      tenDigit = digits.slice(1);
    }

    if (tenDigit.length === 10) {
      return "(" + tenDigit.slice(0, 3) + ") " + tenDigit.slice(3, 6) + "-" + tenDigit.slice(6);
    }

    // Not a recognizable 10-digit US number — international, an extension,
    // a garbled/partial legacy value, anything unusual. Never mangle it:
    // show exactly what's stored, byte-for-byte.
    return str;
  };
})();
