// The Supabase project behind inmo accounts. Both values are meant to be public:
// the publishable key only allows what the row-level security rules in
// supabase/schema.sql allow, which is each signed-in person reading and
// changing their own rows. Leave them empty and the app runs without accounts.
// Never put a secret (sb_secret_…) or service_role key here.
//
// Find them in the Supabase dashboard: the URL on the project's home page, the
// key under Project Settings → API Keys → Publishable key.
export const SUPABASE_URL = 'https://isuhvbeziwoyelwcosof.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_swhCIjlxbPiMcckUB1cJ8g_b7LrOinc';

// true once the project sends its own emails with a 6-digit {{ .Token }} in the
// "Confirm signup" and "Reset password" templates (supabase/README.md, steps 2-3).
// Until then Supabase's default emails carry only a link: sign-up is confirmed by
// clicking it, and "Forgot password?" is hidden.
export const EMAIL_CODES = false;

// The page a confirmation link opens after confirming. It must also be listed in
// Authentication → URL Configuration → Redirect URLs.
export const EMAIL_LINK_LANDING = 'https://github.com/rrr090/inmo';
