// Charges $15 for one resolved error — pay-as-you-go only. Called when a PAYG user
// marks a resolution helpful. Subscribers (personal or company) are covered and
// never charged. Idempotent per resolution so a double-click can't double-charge.

const Stripe = require('stripe');
const { setCors, verifyUser, supabaseAdmin } = require('../../lib/util');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const RESOLUTION_PRICE_CENTS = 1500;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST.' } });

  const auth = await verifyUser(req);
  if (!auth || !auth.profile) return res.status(401).json({ error: { message: 'Authentication required.' } });
  const { profile } = auth;

  const resolutionRef = req.body && req.body.resolution_ref;
  if (!resolutionRef) return res.status(400).json({ error: { message: 'resolution_ref is required.' } });

  try {
    // Subscribers are covered — never charge them.
    const { data: covered } = await supabaseAdmin.rpc('has_active_subscription', { p_user_id: profile.id });
    if (covered) return res.status(200).json({ charged: false, reason: 'covered_by_subscription' });

    if (!profile.payg_ready || !profile.stripe_customer_id) {
      return res.status(402).json({ error: { message: 'No saved card — set up pay-as-you-go first.' } });
    }

    const customer = await stripe.customers.retrieve(profile.stripe_customer_id);
    const pm = customer && customer.invoice_settings && customer.invoice_settings.default_payment_method;
    if (!pm) return res.status(402).json({ error: { message: 'No default payment method on file.' } });

    const intent = await stripe.paymentIntents.create({
      amount: RESOLUTION_PRICE_CENTS,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: pm,
      off_session: true,
      confirm: true,
      description: 'IFS Error Assistant — resolved error',
      metadata: { supabase_user_id: profile.id, resolution_ref: String(resolutionRef) }
    }, {
      idempotencyKey: `payg_${profile.id}_${resolutionRef}`  // one charge per resolution, ever
    });

    return res.status(200).json({ charged: true, payment_intent: intent.id, status: intent.status });
  } catch (err) {
    // e.g. card declined off_session
    return res.status(402).json({ error: { message: 'Charge failed: ' + (err.message || 'unknown error') } });
  }
};
