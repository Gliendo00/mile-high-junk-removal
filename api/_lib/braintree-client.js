// Shared Braintree server-gateway factory for the rental-payment feature.
// api/book.js (initial charge), api/admin/booking.js's `?resource=charges`
// (approved additional charges), and api/braintree-webhook.js (signature
// verification) each call getBraintreeGateway() rather than constructing
// their own gateway instance. Every credential is read from process.env
// inside a server function and never sent to, echoed to, or otherwise
// reachable from client-side code — same discipline as
// api/_lib/supabase-admin.js's getServiceClient().
//
// Required environment variables (server-side only, never read by the
// browser):
//   BRAINTREE_ENVIRONMENT — exactly "Sandbox" or "Production". Deliberately
//     strict (not case-insensitive, no fallback default) — a misspelled
//     value fails closed (getBraintreeGateway() returns null, callers treat
//     that as "payment is not available right now") rather than silently
//     running a live deployment against Sandbox or vice versa.
//   BRAINTREE_MERCHANT_ID
//   BRAINTREE_PUBLIC_KEY
//   BRAINTREE_PRIVATE_KEY
//
// BRAINTREE_TOKENIZATION_KEY (a separate, non-secret, publishable-style
// value — see docs/phase-3/stage2.5-rental-payments-v2-proposal.md §3) is
// read directly by api/book.js's GET handler, not through this module: it
// never needs a gateway instance, only to be echoed to the browser so
// Braintree Drop-in can initialize.
const braintree = require("braintree");

function getBraintreeGateway() {
  const envName = process.env.BRAINTREE_ENVIRONMENT;
  const merchantId = process.env.BRAINTREE_MERCHANT_ID;
  const publicKey = process.env.BRAINTREE_PUBLIC_KEY;
  const privateKey = process.env.BRAINTREE_PRIVATE_KEY;
  if (!merchantId || !publicKey || !privateKey) return null;

  let environment;
  if (envName === "Production") {
    environment = braintree.Environment.Production;
  } else if (envName === "Sandbox") {
    environment = braintree.Environment.Sandbox;
  } else {
    return null;
  }

  return new braintree.BraintreeGateway({
    environment: environment,
    merchantId: merchantId,
    publicKey: publicKey,
    privateKey: privateKey,
  });
}

module.exports = { getBraintreeGateway };
