// Phase 3 — deterministic dollars<->cents conversion. Deliberately NOT
// `Math.round(Number(value) * 100)`: a Supabase `numeric` value can
// arrive as a string, and multiplying an arbitrary decimal by 100 in
// IEEE-754 floating point is exactly the kind of operation that can
// silently misround a cents value before it ever reaches Stripe. Both
// functions below use only string parsing and BigInt arithmetic — no
// floating-point multiplication or division anywhere in this file.

// Accepts a JS number or string. Strict format: optional leading "-",
// one or more digits, optional "." followed by 1-2 digits. Anything else
// (3+ decimal places, scientific notation, commas, whitespace, NaN,
// Infinity) is rejected outright rather than guessed at. Returns an
// integer number of cents, or null if the input doesn't match.
function decimalDollarsToCents(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!match) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fracStr = (match[3] || "").padEnd(2, "0");
  const frac = BigInt(fracStr);

  const cents = sign * (whole * 100n + frac);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(-Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

// Same as above but rejects a negative result — the shape every caller
// that's about to hand an amount to Stripe actually needs (a
// PaymentIntent amount can never be negative or zero-via-negative-input).
function decimalDollarsToPositiveCents(value) {
  const cents = decimalDollarsToCents(value);
  if (cents === null || cents <= 0) return null;
  return cents;
}

// Exact inverse. cents is always already an integer by the time it
// reaches this function (it came from Stripe, or from
// decimalDollarsToCents above) — dividing/modding an integer by 100 has
// no floating-point imprecision exposure the way multiplying an
// arbitrary decimal does, so plain integer arithmetic is safe here.
function centsToDecimalString(cents) {
  const n = Math.trunc(Number(cents));
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return sign + whole + "." + frac;
}

module.exports = {
  decimalDollarsToCents,
  decimalDollarsToPositiveCents,
  centsToDecimalString,
};
