/* Copy to config.js next to dashboard.html for static hosting (Vercel). See README.md.
   The anon key is public by design; Row Level Security in Supabase is what protects the data.
   Optional: allowSignup: true lets unknown emails create an account via the magic link (default false: invite only). */
window.AEGIS_CONFIG = { apiBase: '', supabaseUrl: 'https://YOUR-PROJECT.supabase.co', supabaseAnonKey: 'YOUR-ANON-KEY', requireAuth: true, mode: 'static' };
