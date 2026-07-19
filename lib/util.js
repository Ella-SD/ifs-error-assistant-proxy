// Shared helpers for the billing functions: a service-role Supabase client,
// CORS, and Supabase-token verification (same gate the AI proxy uses).

const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, APP_ORIGIN } = require('./config');

// Service-role client — bypasses RLS. Used ONLY server-side (webhook writes,
// admin lookups). Never exposed to the browser. Created lazily so a missing env
// var surfaces as a clear runtime error instead of crashing the whole module.
let _client = null;
const supabaseAdmin = new Proxy({}, {
  get(_t, prop) {
    if (!_client) {
      _client = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
    }
    const v = _client[prop];
    return typeof v === 'function' ? v.bind(_client) : v;
  }
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Verify the caller's Supabase access token and return their auth user + their
// public.users profile (with billing state). Returns null if not authenticated.
async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) return null;

  const { data: profile } = await supabaseAdmin
    .from('users').select('*').eq('id', data.user.id).maybeSingle();

  return { authUser: data.user, token, profile: profile || null };
}

module.exports = { supabaseAdmin, setCors, verifyUser };
