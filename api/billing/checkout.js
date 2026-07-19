// Creates a Stripe Checkout Session for a subscription tier and returns its URL.
// Personal -> the user is the customer; Company -> the company is the customer and
// only a company_admin may start it. Card + PayPal come from the dashboard's
// enabled payment methods (no per-session config needed).

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

  const tier = (req.body && req.body.tier) || '';
  const { authUser, profile } = auth;

  try {
    let customerId, priceId, metadata, successParam;

    if (tier === 'personal') {
      priceId = await resolvePriceId(cfg.LOOKUP_PERSONAL);
      customerId = await getOrCreateUserCustomer(profile, authUser);
      metadata = { supabase_user_id: profile.id, tier: 'personal' };
      successParam = 'personal';
    } else if (tier === 'company') {
      if (profile.role !== 'company_admin') {
        return res.status(403).json({ error: { message: 'Only a company admin can subscribe the company.' } });
      }
      if (!profile.company_id) {
        return res.status(400).json({ error: { message: 'No company on this account.' } });
      }
      priceId = await resolvePriceId(cfg.LOOKUP_COMPANY);
      customerId = await getOrCreateCompanyCustomer(profile.company_id, authUser);
      metadata = { supabase_company_id: profile.company_id, tier: 'company' };
      successParam = 'company';
    } else {
      return res.status(400).json({ error: { message: 'Unknown tier. Use "personal" or "company".' } });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: profile.id,
      metadata,
      subscription_data: { metadata },   // so subscription.* events also carry the mapping
      allow_promotion_codes: true,
      success_url: `${cfg.APP_URL}?billing=success&tier=${successParam}`,
      cancel_url: `${cfg.APP_URL}?billing=cancelled`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Checkout failed: ' + (err.message || 'unknown error') } });
  }
};

// Resolve a live Price id from its stable lookup key (set by setup-products).
async function resolvePriceId(lookupKey) {
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!prices.data.length) throw new Error(`No active price for lookup key "${lookupKey}" — run the products setup.`);
  return prices.data[0].id;
}

// Reuse the stored customer if present, else create one and persist its id.
async function getOrCreateUserCustomer(profile, authUser) {
  if (profile.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: authUser.email,
    metadata: { supabase_user_id: profile.id }
  });
  await supabaseAdmin.from('users').update({ stripe_customer_id: customer.id }).eq('id', profile.id);
  return customer.id;
}

async function getOrCreateCompanyCustomer(companyId, authUser) {
  const { data: company } = await supabaseAdmin
    .from('companies').select('id, name, stripe_customer_id').eq('id', companyId).maybeSingle();
  if (company && company.stripe_customer_id) return company.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: authUser.email,
    name: company ? company.name : undefined,
    metadata: { supabase_company_id: companyId }
  });
  await supabaseAdmin.from('companies').update({ stripe_customer_id: customer.id }).eq('id', companyId);
  return customer.id;
}
