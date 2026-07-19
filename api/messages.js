module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────
  // Locked to the GitHub Pages origin — this endpoint is backed by a paid API key.
  res.setHeader('Access-Control-Allow-Origin', 'https://ella-sd.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'Server misconfigured: ANTHROPIC_API_KEY environment variable is not set on this Vercel project.' }
    });
  }

  // ── Auth gate ─────────────────────────────────────────────────────────
  // CORS only restrains browsers — it does nothing against a direct curl/script.
  // Require a valid Supabase session so only signed-in app users can spend the
  // API key. The token is the caller's Supabase access_token; we verify it by
  // asking Supabase who it belongs to (200 = valid, anything else = reject).
  // Both values below are public (the publishable key; the project URL) — the
  // security comes from Supabase validating the token, not from hiding these.
  const SUPABASE_URL = 'https://mbzepypmypukwdftvuhb.supabase.co';
  const SUPABASE_ANON = 'sb_publishable_GSfyIsAs1b1W11VYbBMvRg__KaVyltb';
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required.' } });
  }
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON }
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: { message: 'Invalid or expired session. Please sign in again.' } });
    }
  } catch (err) {
    return res.status(502).json({ error: { message: 'Could not verify session: ' + (err.message || 'unknown error') } });
  }

  // ── Forward to Anthropic ──────────────────────────────────────────────
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
