// Vercel serverless function — sends the contact form as an email via Resend
// so leads land in the inbox without the visitor's email client opening.
// Configure RESEND_API_KEY (required) as an environment variable in Vercel.
// Optional: RESEND_FROM_EMAIL (defaults to Resend's shared sandbox sender
// until milehighjunkremoval.net is verified in Resend) and CONTACT_TO_EMAIL
// (defaults to contact@milehighjunkremoval.net).
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

  const attachments = Array.isArray(photos)
    ? photos.slice(0, 6).map((p) => ({
        filename: (p && p.filename) || "photo.jpg",
        content: p && p.base64,
      })).filter((a) => a.content)
    : [];

  const fromEmail =
    process.env.RESEND_FROM_EMAIL || "Mile High Junk Removal <onboarding@resend.dev>";
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
        subject: "New quote request from " + name,
        html,
        attachments,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      res.status(502).json({ error: "Failed to send.", detail: errText });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to send." });
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
