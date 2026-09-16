// Vercel serverless function — sends the contact form as an email via Resend
// so leads land in the inbox without the visitor's email client opening.
// Configure RESEND_API_KEY (required) as an environment variable in Vercel.
// Optional: RESEND_FROM_EMAIL (defaults to an address on the now-verified
// milehighjunkremoval.net domain) and CONTACT_TO_EMAIL (defaults to
// contact@milehighjunkremoval.net).
const { getClientIp, isRateLimited, isHoneypotTripped, isSubmittedTooFast } = require("./_lib/spam-protection");

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
// sends the email normally. (This is different from /api/book, where the
// wizard shape makes a false positive implausible and a hard discard is
// safe — see docs/phase-1/fill-time-safety-review.md.)
const MIN_FILL_TIME_MS = 3000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Contact form is not configured yet." });
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited("contact:" + clientIp, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX)) {
    res.status(429).json({ error: "Too many requests. Please wait a bit and try again, or call or text 303-990-1812." });
    return;
  }

  const { name, phone, email, message, photos, hp, elapsedMs } = req.body || {};

  // Honeypot only: a filled honeypot field is a near-zero-false-positive
  // signal (a real visitor never sees or can focus that field), so it's
  // still treated as a hard rejection — respond as if the message sent
  // (without ever calling Resend) so an automated sender gets no feedback
  // that would help it adapt. The fill-time check is handled separately
  // below as a soft signal instead of being folded in here — see
  // MIN_FILL_TIME_MS above for why.
  if (isHoneypotTripped(hp)) {
    console.error("Contact submission rejected as likely spam (honeypot, ip=" + clientIp + ")");
    res.status(200).json({ ok: true });
    return;
  }

  // Soft signal only: flag and log a suspiciously fast submission, but
  // still send it through normally below. A hard discard here risks
  // silently dropping a real lead who autofilled the form — see
  // MIN_FILL_TIME_MS above and docs/phase-1/fill-time-safety-review.md.
  const isSuspiciouslyFast = isSubmittedTooFast(elapsedMs, MIN_FILL_TIME_MS);
  if (isSuspiciouslyFast) {
    console.warn("Contact submission flagged as suspiciously fast (ip=" + clientIp + ", elapsedMs=" + elapsedMs + ") — sending normally.");
  }

  if (!name || !email) {
    res.status(400).json({ error: "Name and email are required." });
    return;
  }

  // Flag (never block) likely B2B sales/marketing pitches sent through the
  // quote form, so they're easy to spot and filter in the inbox instead of
  // being mistaken for real leads.
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
    (pattern) => pattern.test(message || "") || pattern.test(name || "")
  );

  // Same flag-don't-block pattern as the solicitation check above, just
  // for the fill-time signal: prefix the subject so it's easy to spot and
  // review in the inbox, but never withhold the email itself.
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

  const fromEmail =
    process.env.RESEND_FROM_EMAIL || "Mile High Junk Removal <leads@milehighjunkremoval.net>";
  const toEmail = process.env.CONTACT_TO_EMAIL || "contact@milehighjunkremoval.net";

  const html =
    "<p><strong>New quote request from the website</strong></p>" +
    "<p><strong>Name:</strong> " + escapeHtml(name) + "</p>" +
    "<p><strong>Phone:</strong> " + escapeHtml(phone || "—") + "</p>" +
    "<p><strong>Email:</strong> " + escapeHtml(email) + "</p>" +
    "<p><strong>What needs to go:</strong><br>" +
    escapeHtml(message || "—").replace(/\n/g, "<br>") + "</p>";

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: email,
        subject: subjectPrefix + "New quote request from " + name,
        html,
        attachments,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Resend API error:", resendRes.status, errText);
      res.status(502).json({ error: "Failed to send.", detail: errText });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact form send failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Failed to send." });
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
