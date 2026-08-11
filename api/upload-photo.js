// Vercel serverless function — attaches one customer photo to an already-created
// booking. Called by /book/ after POST /api/book succeeds.
//
// Required environment variables (server-side only, never read by the browser):
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//   UPLOAD_TOKEN_SECRET — must match the secret used to sign the token in api/book.js
//
// Auth model: the caller presents `Authorization: Bearer <uploadToken>`, a short-lived
// (30 min) HMAC-signed token minted by api/book.js on successful booking creation. The
// booking_id is derived ONLY from the verified token payload — never trusted from any
// client-supplied field — so a tampered request body can't redirect an upload to a
// different booking, and the token can't be forged without UPLOAD_TOKEN_SECRET.
//
// Transport: the client sends Content-Type: application/octet-stream (the only content
// type Vercel's Node runtime guarantees is auto-buffered into req.body as a raw Buffer —
// see https://vercel.com/docs/functions/runtimes/node-js#request-body) with the raw image
// bytes as the body, and the actual claimed image type in a custom X-Photo-Type header.
// That claim is independently verified against the file's magic bytes below — the header
// alone is never trusted.
//
// Column names match the live schema exactly: booking_photos(id, booking_id, storage_path, created_at).

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const BUCKET = "booking-photos";
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4 MB — application-level ceiling (see requirement history).
// Comfortably under Vercel's hard 4.5 MB platform request-body limit, independent of the
// bucket's own 6 MB infra-level limit, which stays as configured in Supabase.
const MAX_PHOTOS_PER_BOOKING = 6;

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    const uploadTokenSecret = process.env.UPLOAD_TOKEN_SECRET;
    if (!supabaseUrl || !supabaseSecretKey || !uploadTokenSecret) {
      console.error("Photo upload failed: required environment variables not configured");
      res.status(500).json({ error: "Photo upload is not available right now." });
      return;
    }

    const authHeader = String(req.headers["authorization"] || "");
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) {
      res.status(401).json({ error: "Missing upload authorization." });
      return;
    }
    const bookingId = verifyUploadToken(tokenMatch[1], uploadTokenSecret);
    if (!bookingId) {
      res.status(401).json({ error: "Invalid or expired upload session." });
      return;
    }

    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/octet-stream")) {
      res.status(415).json({ error: "Unsupported content type." });
      return;
    }

    const declaredType = String(req.headers["x-photo-type"] || "").toLowerCase().trim();
    if (!ALLOWED_TYPES[declaredType]) {
      res.status(400).json({ error: "Unsupported photo type." });
      return;
    }

    // Fast-path rejection of oversized uploads via the header. A missing or zero
    // Content-Length is NOT an oversized-payload condition — that's an invalid-body
    // condition, correctly caught by the buffer checks below (400, not 413).
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_PHOTO_BYTES) {
      res.status(413).json({ error: "Photo is too large." });
      return;
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      res.status(400).json({ error: "Invalid photo data." });
      return;
    }
    if (buffer.length > MAX_PHOTO_BYTES) {
      res.status(413).json({ error: "Photo is too large." });
      return;
    }

    if (!matchesMagicBytes(buffer, declaredType)) {
      res.status(400).json({ error: "Photo data does not match its declared type." });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false },
    });

    const { count, error: countError } = await supabase
      .from("booking_photos")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", bookingId);

    if (countError) {
      console.error("Photo upload failed checking existing photo count:", countError);
      res.status(500).json({ error: "Could not upload photo. Please try again." });
      return;
    }
    if ((count || 0) >= MAX_PHOTOS_PER_BOOKING) {
      res.status(400).json({ error: "Maximum number of photos already uploaded for this booking." });
      return;
    }

    const fileName = crypto.randomUUID() + "." + ALLOWED_TYPES[declaredType];
    const storagePath = "bookings/" + bookingId + "/" + fileName;

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: declaredType,
      upsert: false,
    });

    if (uploadError) {
      console.error("Photo upload failed uploading to storage:", uploadError);
      res.status(500).json({ error: "Could not upload photo. Please try again." });
      return;
    }

    const { error: insertError } = await supabase.from("booking_photos").insert({
      booking_id: bookingId,
      storage_path: storagePath,
    });

    if (insertError) {
      console.error("Photo upload failed inserting booking_photos row:", insertError);
      await safeDeleteStorageObject(supabase, storagePath);
      res.status(500).json({ error: "Could not upload photo. Please try again." });
      return;
    }

    // Never echoes back the storage path or booking id — the browser doesn't need them.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Photo upload failed with an unexpected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not upload photo. Please try again." });
    }
  }
};

async function safeDeleteStorageObject(supabase, path) {
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch (err) {
    console.error("Rollback failed deleting storage object " + path + ":", err);
  }
}

function matchesMagicBytes(buffer, type) {
  if (type === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (type === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buffer.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) return false;
    }
    return true;
  }
  if (type === "image/webp") {
    if (buffer.length < 12) return false;
    const riff = buffer.toString("ascii", 0, 4);
    const webp = buffer.toString("ascii", 8, 12);
    return riff === "RIFF" && webp === "WEBP";
  }
  return false;
}

function verifyUploadToken(token, secret) {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.bookingId !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload.bookingId;
}
