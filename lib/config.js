// Shared config for the billing functions.
// Public values (project URL, publishable key, price lookup keys) live here;
// secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY)
// come from Vercel env vars and are never committed.

module.exports = {
  APP_ORIGIN: 'https://ella-sd.github.io',
  APP_URL: 'https://ella-sd.github.io/ifs-error-assistant/',
  SUPABASE_URL: 'https://mbzepypmypukwdftvuhb.supabase.co',
  SUPABASE_ANON: 'sb_publishable_GSfyIsAs1b1W11VYbBMvRg__KaVyltb',

  // Subscription prices are resolved at runtime by these stable lookup keys, so
  // no price_… IDs need to be hardcoded. The setup-products route creates the
  // Products/Prices with exactly these keys ($49/mo personal, $299/mo company).
  // Pay-as-you-go is a direct $15 charge (no Price object needed).
  LOOKUP_PERSONAL: 'ifs_personal_monthly',
  LOOKUP_COMPANY: 'ifs_company_monthly'
};
