// Vercel serverless function — sends the contact form as an email via Resend
// so leads land in the inbox without the visitor's email client opening.
// Configure RESEND_API_KEY (required) as an environment variable in Vercel.
// Optional: RESEND_FROM_EMAIL (defaults to an address on the now-verified
// milehighjunkremoval.net domain) and CONTACT_TO_EMAIL (defaults to
// contact@milehighjunkremoval.net).
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

  const { name, phone, email, message, photos } = req.body || {};

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
        subject: (isLikelySolicitation ? "[Possible Solicitation] " : "") + "New quote request from " + name,
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
