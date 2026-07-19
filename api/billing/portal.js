// Creates a Stripe Billing Portal session so the customer can update their card,
// change plan, or cancel. company_admins manage the company's subscription;
// everyone else manages their own.

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
  const { profile } = auth;

  try {
    let customerId = null;

    if (profile.role === 'company_admin' && profile.company_id) {
      const { data: company } = await supabaseAdmin
        .from('companies').select('stripe_customer_id').eq('id', profile.company_id).maybeSingle();
      customerId = company && company.stripe_customer_id;
    }
    if (!customerId) customerId = profile.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: { message: 'No billing account yet — subscribe first.' } });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: cfg.APP_URL
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Portal failed: ' + (err.message || 'unknown error') } });
  }
};
