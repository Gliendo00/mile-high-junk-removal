// Phase 3 — invoice access-token cryptography. The raw token handed to a
// client (in an emailed link) is NEVER stored anywhere — only its
// SHA-256 hash (public lookup) and, while a send attempt is unresolved,
// an AES-256-GCM-encrypted copy (crash/recovery only) ever touch this
// database. See sql/2026-10-19_phase3-invoice-delivery-pay-now.sql for
// the full design rationale.
//
// Required environment variable (server-side only, never read by the
// browser): INVOICE_LINK_SECRET — exactly 32 bytes, base64-encoded.
// Dedicated to this one purpose — never reused from STRIPE_SECRET_KEY,
// SUPABASE_SECRET_KEY, UPLOAD_TOKEN_SECRET, or any admin-auth secret.
//
// Envelope format: "v1.<nonce>.<ciphertext>.<tag>", each component
// base64url-encoded. Versioned so a future key/format migration has
// somewhere to go without an ambiguous, unversioned blob already in the
// column. AAD is bound to "<invoiceId>:<attemptId>" — a ciphertext
// copied into a different invoice's row, or a different attempt on the
// same invoice, fails authentication rather than decrypting to a
// wrong-but-plausible token.

const crypto = require("crypto");

const ENVELOPE_VERSION = "v1";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function getLinkSecretKey() {
  const raw = process.env.INVOICE_LINK_SECRET;
  if (!raw) return null;
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch (err) {
    return null;
  }
  if (key.length !== KEY_BYTES) return null;
  return key;
}

// Raw token -> SHA-256 hex (64 lowercase hex chars) — what's actually
// stored and matched against for public lookup. The raw value itself
// never reaches this database.
function hashAccessToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function buildAad(invoiceId, attemptId) {
  return Buffer.from(invoiceId + ":" + attemptId, "utf8");
}

// Encrypts rawToken for transient, recovery-only storage. Throws (caller
// must fail closed — no claim should be left half-set up) if
// INVOICE_LINK_SECRET is missing or the wrong length.
function encryptAccessToken(rawToken, invoiceId, attemptId) {
  const key = getLinkSecretKey();
  if (!key) throw new Error("INVOICE_LINK_SECRET is not configured correctly (must be base64 for exactly 32 bytes).");

  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(buildAad(invoiceId, attemptId));
  const ciphertext = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [ENVELOPE_VERSION, nonce.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

// Decrypts a stored envelope back to the raw token for the SAME
// invoiceId/attemptId it was encrypted with. Returns null (never
// throws) on any failure — wrong key, tampered/copied ciphertext,
// malformed envelope, or AAD mismatch — so callers can treat "decrypt
// failed" as a normal, expected outcome (the 'unrecoverable' transition)
// rather than an unexpected exception.
function decryptAccessToken(envelope, invoiceId, attemptId) {
  const key = getLinkSecretKey();
  if (!key) return null;

  try {
    const parts = String(envelope || "").split(".");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return null;
    const nonce = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (nonce.length !== NONCE_BYTES || ciphertext.length === 0 || tag.length !== 16) return null;

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(buildAad(invoiceId, attemptId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (err) {
    return null;
  }
}

// Fresh raw token for a new delivery attempt — 256 bits, base64url (no
// padding/slashes), safe to embed directly in a URL fragment.
function generateRawAccessToken() {
  return crypto.randomBytes(32).toString("base64url");
}

module.exports = {
  hashAccessToken,
  encryptAccessToken,
  decryptAccessToken,
  generateRawAccessToken,
  getLinkSecretKey,
};
