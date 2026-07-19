// Stripe webhook — the source of truth for access. Verifies the signature against
// the RAW body, then updates Supabase (via the service_role key). Written to be
// safe under Stripe's at-least-once, possibly out-of-order delivery: every event
// re-reads the subscription's CURRENT state and writes that, so a stale event can
// never resurrect a cancelled sub or vice-versa.

const Stripe = require('stripe');
const { supabaseAdmin } = require('../lib/util');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vercel parses JSON bodies by default, which corrupts the bytes Stripe signed.
// Disable it so we can read the raw body for constructEvent().
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Bad/absent signature — reject. Stripe will not retry a 400.
    return res.status(400).send('Webhook signature verification failed: ' + err.message);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscription(sub, session.metadata);
        } else if (session.mode === 'setup' && session.setup_intent) {
          await handlePaygSetup(session);
        }
        break;
      }
      // Any subscription/invoice change: re-sync current state from Stripe.
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const obj = event.data.object;
        const subId = obj.subscription || obj.id; // invoice has .subscription; sub events have .id
        if (subId && String(subId).startsWith('sub_')) {
          const sub = await stripe.subscriptions.retrieve(String(subId));
          await syncSubscription(sub, sub.metadata);
        }
        break;
      }
      default:
        break; // ignore other event types
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Return 500 so Stripe retries — a transient Supabase error shouldn't drop the event.
    return res.status(500).send('Handler error: ' + (err.message || 'unknown'));
  }
};

// Pay-as-you-go setup finished: pin the saved card as default and flag the user
// ready to be charged per resolution.
async function handlePaygSetup(session) {
  const si = await stripe.setupIntents.retrieve(session.setup_intent);
  const pm = si.payment_method;
  if (pm && session.customer) {
    await stripe.customers.update(session.customer, { invoice_settings: { default_payment_method: pm } });
  }
  const userId = session.metadata && session.metadata.supabase_user_id;
  if (userId) {
    await supabaseAdmin.from('users').update({ payg_ready: true, plan: 'pay_as_you_go' }).eq('id', userId);
  }
}

// Write the subscription's current state onto the owning company or user row.
async function syncSubscription(sub, metadata) {
  const meta = metadata || sub.metadata || {};
  const fields = {
    subscription_status: sub.status, // active | trialing | past_due | canceled | incomplete | ...
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    stripe_subscription_id: sub.id
  };

  // Resolve the target row: prefer metadata, fall back to the Stripe customer id.
  if (meta.supabase_company_id) {
    await supabaseAdmin.from('companies').update({ ...fields, plan: 'company' }).eq('id', meta.supabase_company_id);
  } else if (meta.supabase_user_id) {
    await supabaseAdmin.from('users').update({ ...fields, plan: 'personal' }).eq('id', meta.supabase_user_id);
  } else {
    // No metadata (e.g. a sub created outside checkout) — match on customer id.
    const cust = sub.customer;
    const { data: company } = await supabaseAdmin.from('companies').select('id').eq('stripe_customer_id', cust).maybeSingle();
    if (company) {
      await supabaseAdmin.from('companies').update({ ...fields, plan: 'company' }).eq('id', company.id);
    } else {
      await supabaseAdmin.from('users').update({ ...fields, plan: 'personal' }).eq('stripe_customer_id', cust);
    }
  }
}
