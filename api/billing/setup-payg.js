// Pay-as-you-go step 1: save a card. Opens a Stripe Checkout in 'setup' mode to
// collect + store a payment method on the user's customer. On completion the
// webhook marks users.payg_ready = true and pins it as the default payment method,
// so later per-resolution charges can run off_session.

const Stripe = require('stripe');
const { setCors, verifyUser, supabaseAdmin } = require('../../lib/util');
const cfg = require('../../lib/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST.' } });

  const auth = await verifyUser(req);
  if (!auth || !auth.profile) return res.status(401).json({ error: { message: 'Authentication required.' } });
  const { authUser, profile } = auth;

  try {
    // Ensure the user has a Stripe customer.
    let customerId = profile.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: authUser.email, metadata: { supabase_user_id: profile.id } });
      customerId = customer.id;
      await supabaseAdmin.from('users').update({ stripe_customer_id: customerId }).eq('id', profile.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      currency: 'usd',   // required by Stripe for setup-mode sessions
      customer: customerId,
      client_reference_id: profile.id,
      metadata: { supabase_user_id: profile.id, purpose: 'payg' },
      success_url: `${cfg.APP_URL}?billing=payg_ready`,
      cancel_url: `${cfg.APP_URL}?billing=cancelled`
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Card setup failed: ' + (err.message || 'unknown error') } });
  }
};
