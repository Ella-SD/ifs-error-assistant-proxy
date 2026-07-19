// AI proxy — forwards to the Anthropic API, but only for a signed-in user who has
// an active plan (or pay-as-you-go on file). Auth + access are enforced here so a
// tampered client can't spend the API key. Platform admins are exempt (ops/test).

const { setCors, verifyUser, supabaseAdmin } = require('../lib/util');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'Server misconfigured: ANTHROPIC_API_KEY is not set on this Vercel project.' }
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = await verifyUser(req);
  if (!auth || !auth.profile) {
    return res.status(401).json({ error: { message: 'Authentication required.' } });
  }

  // ── Access gate ─────────────────────────────────────────────────────────
  if (auth.profile.role !== 'platform_admin') {
    const { data: covered } = await supabaseAdmin.rpc('has_active_subscription', { p_user_id: auth.profile.id });
    const allowed = covered || auth.profile.payg_ready;
    if (!allowed) {
      return res.status(402).json({ error: { message: 'A plan is required to resolve errors.' } });
    }
  }

  // ── Forward to Anthropic ─────────────────────────────────────────────────
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({
      error: { message: 'Proxy failed to reach the Anthropic API: ' + (err.message || 'unknown error') }
    });
  }
};
