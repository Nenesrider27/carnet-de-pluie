// config.js — connexion Supabase.
// Valeurs PUBLIQUES : l'URL du projet et la clé « publishable » sont conçues
// pour vivre dans le code de la page (elle sera publiée sur GitHub Pages).
// L'accès est encadré par les policies RLS de la base.
// ⚠️ NE JAMAIS mettre ici la clé « secret » (sb_secret_...).
export const SUPA_URL = 'https://ekfpscnhmfpwlyxtoxfx.supabase.co';
export const SUPA_KEY = 'sb_publishable_KhET2u38G7fH0IWCpSlkLA_t_X3LIh1';

// Clé VAPID PUBLIQUE pour les notifications push (étape 4).
// Générée par `npx web-push generate-vapid-keys` — colle ici la "Public Key".
// La clé PRIVÉE ne va PAS ici : elle va dans un secret GitHub Actions (VAPID_PRIVATE_KEY).
export const VAPID_PUBLIC = 'BJlRvjYJnVMz5LLxB-RDCn2TQOEBBndXTcsQpErz7AekULcFRKmvK8oJUEVVxi3QnkxHDkOn4jGee_QgO_-TxGE';

// Endpoint GoTrue (authentification email/mot de passe). La lib auth-js
// (vendor/auth-js.js) y accède ; l'en-tête apikey reste la clé publishable.
export const AUTH_URL = SUPA_URL + '/auth/v1';

// Edge Function « chat » (proxy Claude) — déployée sur Supabase.
export const CHAT_URL = SUPA_URL + '/functions/v1/chat';
