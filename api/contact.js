// Vercel serverless function — the homepage "Get a Quote" form (and the
// standalone /contact.html page, which POSTs here too) now does two
// things, in order:
//   1. Creates a real `leads` row (source: "website") — the durable
//      source of truth. See sql/2026-10-18_phase3-public-reliability.sql
//      for the schema change this required (leads.source previously only
//      allowed 'screenshot_intake'/'phone'/'manual' — see that migration's
//      own header for why widening it, rather than reusing one of those
//      values, is the correct fix here).
//   2. Sends the existing Resend notification email — best-effort, AFTER
//      the lead is durably saved. CRM persistence never depends on this
//      step succeeding: if Resend fails, the lead still exists, the
//      failure is logged server-side, and the response to the client
//      still reflects that their request was received (see the email
//      try/catch below).
//
// Deliberately does NOT create a `bookings` row or touch `customers` as
// anything but a plain lookup/insert — this form stays a Lead, never a
// confirmed booking. That distinction is the whole point of keeping it
// separate from /api/book (see Goal 2 of the commit this file is part
// of). Customer resolution reuses the exact same silent-reuse dedup
// lookup api/book.js's own public path already uses (phone_normalized +
// email_normalized, single-exact-match only, falls open to creating a new
// customer on any ambiguity/error) — this is this codebase's one
// established pattern for unauthenticated public dedup, duplicated here
// rather than reinvented, matching the existing per-file convention for
// small shared logic with no shared-module story on the server (the
// admin-side dedup in api/admin/client.js is a different, 409-blocking
// policy meant for an authenticated human in the loop, not this context).
//
// Configure RESEND_API_KEY (required) as an environment variable in Vercel.
// Optional: RESEND_FROM_EMAIL (defaults to an address on the now-verified
// milehighjunkremoval.net domain) and CONTACT_TO_EMAIL (defaults to
// contact@milehighjunkremoval.net).
const { createClient } = require("@supabase/supabase-js");
const { getClientIp, isRateLimited, isHoneypotTripped, isSubmittedTooFast } = require("./_lib/spam-protection");
const { normalizePhone, normalizeEmail } = require("./_lib/customer-identity");
const { getCorrelationId, logEvent } = require("./_lib/correlation-id");

// Generous on purpose — this only needs to stop scripted abuse, not slow
// down a real customer who might legitimately submit more than once.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 8;
// Unlike /api/book (a multi-step wizard where finishing in under 3s is
// essentially impossible for a human), this form has only three required
// fields (name, phone, email) and browser autofill can plausibly fill and
// submit it in under 3 real seconds for a genuine visitor. So here this is
// a soft spam SIGNAL, not a reason to discard the submission by itself —
// see the isSuspiciouslyFast handling below, which flags and logs but still
// saves/sends normally. (This is different from /api/book, where the
// wizard shape makes a false positive implausible — see
// docs/phase-1/fill-time-safety-review.md. Unchanged by this commit.)
const MIN_FILL_TIME_MS = 3000;

const MAX = { name: 80, phone: 30, email: 254, message: 2000 };

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const correlationId = getCorrelationId(req);
  logEvent(correlationId, "contact.received");

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Contact form is not configured yet." });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey) {
    console.error("[" + correlationId + "] contact.misconfigured: SUPABASE_URL/SUPABASE_SECRET_KEY not set");
    res.status(500).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited("contact:" + clientIp, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX)) {
    res.status(429).json({ error: "Too many requests. Please wait a bit and try again, or call or text 303-990-1812." });
    return;
  }

  const { name, phone, email, message, photos, hp, elapsedMs } = req.body || {};

  // Honeypot: a filled honeypot field is a near-zero-false-positive signal
  // (a real visitor never sees or can focus that field — see index.html's/
  // contact.html's markup), so it's still treated as a rejection. Unlike
  // the previous version of this file, the response is now an honest,
  // generic failure (same shape/wording as any other failure below) rather
  // than a faked 200 success — a legitimate human whose honeypot field got
  // populated by an overzealous browser extension (a real, documented
  // failure mode for this technique, distinct from the near-zero-risk
  // "a human saw and filled it") must see that their request needs a retry,
  // not a lie that it was received. The response text deliberately never
  // mentions spam/honeypot/detection — a script scraping responses sees
  // the exact same message a genuine validation failure would produce.
  if (isHoneypotTripped(hp)) {
    console.error("[" + correlationId + "] contact.spam_rejected: honeypot (ip=" + clientIp + ")");
    res.status(400).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
    return;
  }

  // Soft signal only: flag and log a suspiciously fast submission, but
  // still save/send it through normally below. A hard discard here risks
  // silently dropping a real lead who autofilled the form — see
  // MIN_FILL_TIME_MS above and docs/phase-1/fill-time-safety-review.md.
  const isSuspiciouslyFast = isSubmittedTooFast(elapsedMs, MIN_FILL_TIME_MS);
  if (isSuspiciouslyFast) {
    logEvent(correlationId, "contact.flagged_fast", { elapsedMs: elapsedMs });
  }

  const cleanName = sanitizeText(name, MAX.name);
  const cleanPhone = sanitizeText(phone, MAX.phone);
  const cleanEmail = sanitizeText(email, MAX.email);
  const cleanMessage = sanitizeText(message, MAX.message);

  if (!cleanName) {
    res.status(400).json({ error: "Name is required." });
    return;
  }
  if (!cleanPhone || !isValidPhone(cleanPhone)) {
    res.status(400).json({ error: "Please enter a valid phone number." });
    return;
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }

  // Flag (never block) likely B2B sales/marketing pitches sent through the
  // quote form, so they're easy to spot and filter instead of being
  // mistaken for a real lead. Unchanged from before this commit — still
  // affects only the notification email's subject line, never whether the
  // lead is created.
  const SOLICITATION_PATTERNS = [
    /\bseo\b/i,
    /search engine optimi[sz]ation/i,
    /backlink/i,
    /guest post/i,
    /link building/i,
    /web(site)? (design|development)/i,
    /digital marketing/i,
    /social media (marketing|management)/i,
    /\bppc\b/i,
    /google ads/i,
    /marketing agency/i,
    /increase (your )?(website )?traffic/i,
    /(improve|boost) your (search )?ranking/i,
    /rank (higher|#?1) (on|in) google/i,
    /grow your business/i,
    /partnership opportunity/i,
    /collaboration opportunity/i,
    /sponsor(ship)?/i,
    /advertis(e|ing) (on|with)/i,
    /email marketing/i,
    /lead generation/i,
    /content (writing|marketing)/i,
    /press release/i,
    /influencer/i,
  ];
  const isLikelySolicitation = SOLICITATION_PATTERNS.some(
    (pattern) => pattern.test(cleanMessage || "") || pattern.test(cleanName || "")
  );

  const supabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });

  const phoneNorm = normalizePhone(cleanPhone);
  const emailNorm = normalizeEmail(cleanEmail);

  // Repeat-client reuse — identical rule and failure posture to api/book.js's
  // own public lookup (see that file's Step 4a.3 header comment): only ever
  // reuses when exactly one existing customer matches BOTH normalized phone
  // and normalized email; any lookup failure falls open to creating a new
  // customer rather than ever blocking the submission.
  let customerId = null;
  try {
    const { data: matches, error } = await supabase
      .from("customers")
      .select("id")
      .eq("phone_normalized", phoneNorm)
      .eq("email_normalized", emailNorm);
    if (!error && Array.isArray(matches) && matches.length === 1) {
      customerId = matches[0].id;
    }
  } catch (err) {
    console.error("[" + correlationId + "] contact.customer_lookup_failed (falling open to new customer):", err);
  }

  if (customerId === null) {
    try {
      const { data: customerRow, error } = await supabase
        .from("customers")
        .insert({
          first_name: splitName(cleanName).firstName,
          last_name: splitName(cleanName).lastName,
          phone: cleanPhone,
          email: cleanEmail,
          phone_normalized: phoneNorm,
          email_normalized: emailNorm,
        })
        .select("id")
        .single();
      if (error || !customerRow) {
        console.error("[" + correlationId + "] contact.customer_create_failed:", error);
        res.status(500).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
        return;
      }
      customerId = customerRow.id;
      logEvent(correlationId, "contact.customer_created", { customerId: customerId });
    } catch (err) {
      console.error("[" + correlationId + "] contact.customer_create_failed:", err);
      res.status(500).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
      return;
    }
  } else {
    logEvent(correlationId, "contact.customer_reused", { customerId: customerId });
  }

  // The lead itself — the durable CRM record. `source: "website"` is the
  // one new value this commit adds to leads.source's CHECK constraint (see
  // the migration referenced above); status defaults to the same 'new'
  // every other fresh lead starts at, so it appears in the Leads
  // workspace's existing "New" bucket with no UI changes needed.
  // created_by has no authenticated admin session to record here (this is
  // an unauthenticated public endpoint) — "website" is used as the fixed,
  // literal value, parallel to how `source` already identifies the channel.
  const { firstName, lastName } = splitName(cleanName);
  let leadId;
  try {
    const { data: leadRow, error } = await supabase
      .from("leads")
      .insert({
        created_by: "website",
        source: "website",
        status: "new",
        first_name: firstName,
        last_name: lastName,
        phone: cleanPhone,
        phone_normalized: phoneNorm,
        email: cleanEmail,
        service_details: cleanMessage || null,
        matched_customer_id: customerId,
      })
      .select("id")
      .single();
    if (error || !leadRow) {
      console.error("[" + correlationId + "] contact.lead_create_failed:", error);
      res.status(500).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
      return;
    }
    leadId = leadRow.id;
    logEvent(correlationId, "contact.lead_created", { leadId: leadId });
  } catch (err) {
    console.error("[" + correlationId + "] contact.lead_create_failed:", err);
    res.status(500).json({ error: "Could not submit your request. Please try again or call us at 303-990-1812." });
    return;
  }

  // From here on, the request has definitively succeeded — the lead is
  // durably saved. Everything below (the notification email) is
  // best-effort: its failure is logged and never changes the response or
  // un-saves the lead.
  const subjectFlags = [];
  if (isSuspiciouslyFast) subjectFlags.push("[Fast Submission]");
  if (isLikelySolicitation) subjectFlags.push("[Possible Solicitation]");
  const subjectPrefix = subjectFlags.length ? subjectFlags.join(" ") + " " : "";

  const attachments = Array.isArray(photos)
    ? photos.slice(0, 6).map((p) => ({
        filename: (p && p.filename) || "photo.jpg",
        content: p && p.base64,
      })).filter((a) => a.content)
    : [];

  const fromEmail = process.env.RESEND_FROM_EMAIL || "Mile High Junk Removal <leads@milehighjunkremoval.net>";
  const toEmail = process.env.CONTACT_TO_EMAIL || "contact@milehighjunkremoval.net";

  const html =
    "<p><strong>New quote request from the website</strong></p>" +
    "<p><strong>Name:</strong> " + escapeHtml(cleanName) + "</p>" +
    "<p><strong>Phone:</strong> " + escapeHtml(cleanPhone || "—") + "</p>" +
    "<p><strong>Email:</strong> " + escapeHtml(cleanEmail) + "</p>" +
    "<p><strong>What needs to go:</strong><br>" +
    escapeHtml(cleanMessage || "—").replace(/\n/g, "<br>") + "</p>";

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: cleanEmail,
        subject: subjectPrefix + "New quote request from " + cleanName,
        html,
        attachments,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("[" + correlationId + "] contact.email_failed: Resend API error", resendRes.status, errText);
    } else {
      logEvent(correlationId, "contact.email_sent");
    }
  } catch (err) {
    console.error("[" + correlationId + "] contact.email_failed:", err && err.stack ? err.stack : err);
  }

  // Always reflects the lead's own success, never the email's — see the
  // header comment and Goal 1's "email failure behavior" requirement.
  logEvent(correlationId, "contact.success", { leadId: leadId });
  res.status(200).json({ ok: true });
};

// "Jane Doe" -> { firstName: "Jane", lastName: "Doe" }. "Jane" (no space)
// -> { firstName: "Jane", lastName: null } — leads.last_name is nullable,
// and customers.last_name is NOT required by this endpoint's insert either
// (api/book.js's own public insert treats it the same way: never guesses a
// last name that wasn't actually given). The contact form collects one
// free-text Name field, unlike /book/'s separate first/last inputs — this
// is the one place that difference has to be reconciled.
function splitName(fullName) {
  const trimmed = String(fullName || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { firstName: "", lastName: null };
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { firstName: trimmed, lastName: null };
  return { firstName: trimmed.slice(0, spaceIdx), lastName: trimmed.slice(spaceIdx + 1) };
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped.trim().slice(0, maxLen);
}

// Same validation logic as api/book.js's own isValidPhone/isValidEmail —
// duplicated rather than imported, matching this codebase's established
// per-file convention for small server-side helpers with no shared-module
// story (see api/book.js's own header comments for other examples of this
// same pattern).
function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^[0-9+()\-.\s]+$/.test(value);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX.email;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
