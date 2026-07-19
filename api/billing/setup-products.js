// ONE-TIME setup: creates the two subscription Products/Prices in Stripe (test
// mode), tagged with stable lookup keys so checkout can resolve them without
// hardcoded ids. Idempotent — re-running reuses existing prices.
//
// TEMPORARY / test-mode utility: requires an authenticated Supabase user (so it's
// not open to the public) and only ever touches test-mode data. Remove this route
// before switching Stripe to Live mode.

const Stripe = require('stripe');
const { setCors, verifyUser } = require('../../lib/util');
const cfg = require('../../lib/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = [
  { name: 'IFS Error Assistant — Personal', amount: 4900,  lookup: cfg.LOOKUP_PERSONAL },
  { name: 'IFS Error Assistant — Company',  amount: 29900, lookup: cfg.LOOKUP_COMPANY }
];

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST.' } });

  const auth = await verifyUser(req);
  if (!auth) return res.status(401).json({ error: { message: 'Authentication required.' } });

  try {
    const result = {};
    for (const plan of PLANS) {
      // Reuse an existing price with this lookup key if present.
      const existing = await stripe.prices.list({ lookup_keys: [plan.lookup], active: true, limit: 1 });
      if (existing.data.length) {
        result[plan.lookup] = { price: existing.data[0].id, created: false };
        continue;
      }
      const product = await stripe.products.create({ name: plan.name });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.amount,
        currency: 'usd',
        recurring: { interval: 'month' },
        lookup_key: plan.lookup
      });
      result[plan.lookup] = { price: price.id, product: product.id, created: true };
    }
    return res.status(200).json({ ok: true, prices: result });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Setup failed: ' + (err.message || 'unknown error') } });
  }
};
