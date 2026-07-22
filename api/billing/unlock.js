// Pay-as-you-go unlock: charge the configured price (default $4.99) for one
// resolution, then reveal the steps. Idempotent — a resolution that's already
// unlocked returns its steps without charging again (covers "paid but the reveal
// didn't load"). Subscribers are revealed free here too, as a defensive fallback
// (the app routes them to the free reveal_solution RPC instead).

const Stripe = require('stripe');
const { setCors, verifyUser, supabaseAdmin } = require('../../lib/util');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const DEFAULT_PRICE_CENTS = 499;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST.' } });

  const auth = await verifyUser(req);
  if (!auth || !auth.profile) return res.status(401).json({ error: { message: 'Authentication required.' } });
  const { profile } = auth;

  const resolutionId = req.body && req.body.resolution_id;
  if (!resolutionId) return res.status(400).json({ error: { message: 'resolution_id is required.' } });

  try {
    // Load the resolution and make sure it belongs to the caller.
    const { data: r } = await supabaseAdmin.from('resolutions').select('*').eq('id', resolutionId).maybeSingle();
    if (!r || r.user_id !== profile.id) return res.status(404).json({ error: { message: 'Resolution not found.' } });
    if (!r.solution_id) return res.status(400).json({ error: { message: 'No solution to unlock.' } });

    // Full solution (service role — bypasses the steps column lock).
    const { data: sol } = await supabaseAdmin.from('solutions').select('*').eq('id', r.solution_id).maybeSingle();
    if (!sol) return res.status(404).json({ error: { message: 'Solution not found.' } });

    // Already unlocked? Return the snapshot, no charge.
    if (r.state !== 'matched_locked') {
      return res.status(200).json(stepsPayload(r.steps_snapshot || sol.instructions, sol, r.price_cents));
    }

    // Subscribers unlock free; PAYG pays the configured price.
    const { data: covered } = await supabaseAdmin.rpc('has_active_subscription', { p_user_id: profile.id });
    let priceCents = 0, paymentIntentId = null;

    if (!covered) {
      if (!profile.payg_ready || !profile.stripe_customer_id) {
        return res.status(402).json({ error: { message: 'No saved card — set up pay-as-you-go first.' } });
      }
      // A live/curated match charges the standard resolution price; an unreviewed
      // AI-assembled fix (non-live status) charges the separate assemble price.
      const LIVE_STATUSES = ['PUBLISHED', 'VERIFIED', 'NEEDS_REVIEW'];
      const priceKey = LIVE_STATUSES.includes(sol.status) ? 'payg_price_cents' : 'assemble_price';
      const { data: cfg } = await supabaseAdmin.from('app_config').select('value').eq('key', priceKey).maybeSingle();
      priceCents = cfg ? parseInt(cfg.value, 10) : DEFAULT_PRICE_CENTS;

      const customer = await stripe.customers.retrieve(profile.stripe_customer_id);
      const pm = customer && customer.invoice_settings && customer.invoice_settings.default_payment_method;
      if (!pm) return res.status(402).json({ error: { message: 'No default payment method on file.' } });

      const intent = await stripe.paymentIntents.create({
        amount: priceCents, currency: 'usd', customer: profile.stripe_customer_id,
        payment_method: pm, off_session: true, confirm: true,
        description: 'IFS Error Assistant — unlock solution',
        metadata: { supabase_user_id: profile.id, resolution_id: resolutionId }
      }, {
        idempotencyKey: `unlock_${resolutionId}`   // one charge per resolution, ever
      });
      paymentIntentId = intent.id;
    }

    // Snapshot the steps and transition the resolution.
    await supabaseAdmin.from('resolutions').update({
      state: 'matched_unlocked',
      solution_version: sol.version,
      steps_snapshot: sol.instructions,
      price_cents: priceCents,
      stripe_payment_intent: paymentIntentId,
      updated_at: new Date().toISOString()
    }).eq('id', resolutionId);

    await supabaseAdmin.from('solutions')
      .update({ times_served: (sol.times_served || 0) + 1 }).eq('id', sol.id);

    return res.status(200).json(stepsPayload(sol.instructions, sol, priceCents));
  } catch (err) {
    // e.g. card declined off_session
    return res.status(402).json({ error: { message: 'Unlock failed: ' + (err.message || 'unknown error') } });
  }
};

function stepsPayload(steps, sol, priceCents) {
  return {
    steps: steps || [],
    title: sol.title,
    who_acts: sol.who_acts,
    source: sol.source,
    sources: sol.assembled_sources,
    version: sol.version,
    charged_cents: priceCents
  };
}
