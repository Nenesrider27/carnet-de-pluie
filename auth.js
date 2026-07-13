// auth.js — session utilisateur (email / mot de passe) via GoTrue (Supabase Auth).
// On délègue la GESTION DE SESSION (rotation du refresh token, expiration, verrou
// multi-onglets) à la librairie officielle vendorisée `vendor/auth-js.js` — c'est
// le point où le code maison accumule des bugs de sécurité subtils. Le reste de
// l'app (accès données) reste vanilla : store.js consomme juste `accessToken()`.
import { GoTrueClient } from './vendor/auth-js.js';
import { SUPA_URL, SUPA_KEY } from './config.js';

const client = new GoTrueClient({
  url: SUPA_URL + '/auth/v1',       // endpoint GoTrue
  headers: { apikey: SUPA_KEY },    // /auth/v1 exige l'en-tête apikey (clé publishable)
  storageKey: 'cdp-auth',           // clé localStorage propre (pas de collision)
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: true,         // capte le token d'un lien (reset mot de passe)
  flowType: 'pkce',
});

// S'abonne aux changements de session (SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT,
// PASSWORD_RECOVERY). Renvoie l'objet subscription (.unsubscribe()).
export function onAuthChange(cb) {
  const { data } = client.onAuthStateChange((event, session) => cb(event, session));
  return data?.subscription;
}

export async function getSession() {
  const { data } = await client.getSession();
  return data?.session || null;
}

// Jeton d'accès courant (JWT), pour l'en-tête Authorization de store.js. null si déconnecté.
export async function accessToken() {
  const s = await getSession();
  return s?.access_token || null;
}

export async function currentUser() {
  const s = await getSession();
  return s?.user || null;
}

export async function signUp(email, password) {
  const { data, error } = await client.signUp({ email, password });
  if (error) throw new Error(mapAuthError(error));
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await client.signInWithPassword({ email, password });
  if (error) throw new Error(mapAuthError(error));
  return data;
}

export async function signOut() {
  await client.signOut();
}

export async function resetPassword(email) {
  const redirectTo = location.origin + location.pathname;
  const { error } = await client.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new Error(mapAuthError(error));
}

// Applique un nouveau mot de passe (après clic sur le lien de reset : la session
// est en mode PASSWORD_RECOVERY, captée par detectSessionInUrl).
export async function updatePassword(password) {
  const { error } = await client.updateUser({ password });
  if (error) throw new Error(mapAuthError(error));
}

// Traduit en français les messages d'erreur GoTrue les plus fréquents.
function mapAuthError(error) {
  const m = error?.message || 'Erreur d\'authentification';
  if (/invalid login credentials/i.test(m)) return 'Email ou mot de passe incorrect.';
  if (/user already registered/i.test(m) || /already been registered/i.test(m)) return 'Un compte existe déjà avec cet email.';
  if (/password should be at least/i.test(m)) return 'Mot de passe trop court (6 caractères minimum).';
  if (/email not confirmed/i.test(m)) return 'Email pas encore confirmé — vérifie ta boîte mail.';
  if (/unable to validate email address/i.test(m) || /invalid email/i.test(m)) return 'Adresse email invalide.';
  if (/rate limit/i.test(m) || /too many requests/i.test(m)) return 'Trop de tentatives — réessaie dans un instant.';
  return m;
}
