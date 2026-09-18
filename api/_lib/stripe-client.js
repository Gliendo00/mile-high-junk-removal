// Shared Stripe server-client factory for the rental-payment feature.
// api/book.js (PaymentIntent creation + capture), api/admin/booking.js's
// `?resource=charges` (off-session approved additional charges), and
// api/stripe-webhook.js (signature verification) each call getStripeClient()
// rather than constructing their own client instance. Every credential is
// read from process.env inside a server function and never sent to, echoed
// to, or otherwise reachable from client-side code — same discipline as
// api/_lib/supabase-admin.js's getServiceClient().
//
// Required environment variable (server-side only, never read by the
// browser): STRIPE_SECRET_KEY.
//
// STRIPE_PUBLISHABLE_KEY (a separate, non-secret, publishable value) is read
// directly by api/book.js's GET handler, not through this module: it never
// needs a Stripe client instance, only to be echoed to the browser so
// Stripe.js can initialize the Payment Element.
//
// STRIPE_WEBHOOK_SECRET is read directly by api/stripe-webhook.js, also not
// through this module — it's used with stripe.webhooks.constructEvent(),
// not with the client instance this factory returns.
const Stripe = require("stripe");

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return new Stripe(secretKey);
}

module.exports = { getStripeClient };
