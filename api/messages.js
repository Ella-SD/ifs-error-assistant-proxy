module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────
  // Locked to the GitHub Pages origin — this endpoint is backed by a paid API key.
  res.setHeader('Access-Control-Allow-Origin', 'https://ella-sd.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
