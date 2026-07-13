// store.js — accès à la base Supabase (REST/PostgREST), cloisonnée par domicile.
// Aucune logique métier ici : juste des lectures/écritures qui renvoient des
// données ou LÈVENT une erreur (l'appelant décide quoi afficher). Réutilisable
// par la page (navigateur) et par le script de notifications (Node).
//
// AUTH : les en-têtes d'authentification sont INJECTÉS via configureStore() :
//   - navigateur : apikey = clé publishable, Authorization = Bearer <JWT user>
//     → la RLS identifie l'utilisateur (auth.uid()) et filtre par appartenance.
//   - serveur (GitHub Actions) : apikey = clé SECRÈTE (service_role), PAS de Bearer
//     → bypass RLS pour lire tous les domiciles (envoi des notifications).
import { SUPA_URL, SUPA_KEY } from './config.js';

const REST = SUPA_URL + '/rest/v1';

// Fournisseur d'en-têtes d'auth. Défaut = clé publishable seule ; REMPLACÉ au
// démarrage par app.js (JWT) ou morning-push (clé secrète).
let _authProvider = async () => ({ apikey: SUPA_KEY });

// Configure la source des en-têtes d'authentification. `provider` : async () => ({...}).
export function configureStore(provider) { _authProvider = provider; }

async function headers(extra) {
  const auth = await _authProvider();
  return { 'Content-Type': 'application/json', ...auth, ...(extra || {}) };
}

async function ok(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}

// =====================================================================
// DOMICILES & MEMBRES
// =====================================================================

// Mes domiciles (la RLS ne renvoie que ceux dont je suis membre), avec mon rôle
// et mon prénom via la jointure sur domicile_members.
export async function getMyDomiciles(userId) {
  const sel = 'select=*,domicile_members!inner(role,prenom,user_id)';
  const filt = userId ? `&domicile_members.user_id=eq.${userId}` : '';
  const res = await fetch(`${REST}/domiciles?${sel}${filt}&order=created_at.asc`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET domiciles');
  return res.json();
}

// Crée un domicile. owner_id DOIT être l'utilisateur courant (contrôle RLS insert).
// Le trigger l'inscrit automatiquement comme owner-membre.
export async function createDomicile({ ownerId, nom, adresse, lat, lon, timezone, objectif_mm, debit_mm_h, kc, objectif_manuel }) {
  const body = {
    owner_id: ownerId, nom, adresse: adresse || null,
    lat: lat ?? null, lon: lon ?? null, timezone: timezone || 'Europe/Zurich',
  };
  if (objectif_mm != null) body.objectif_mm = objectif_mm;
  if (debit_mm_h != null) body.debit_mm_h = debit_mm_h;
  if (kc != null) body.kc = kc;
  if (objectif_manuel != null) body.objectif_manuel = objectif_manuel;
  const res = await fetch(`${REST}/domiciles`, {
    method: 'POST', headers: await headers({ Prefer: 'return=representation' }), body: JSON.stringify(body),
  });
  await ok(res, 'create domicile');
  return (await res.json())[0];
}

// Met à jour un domicile (réglages, nom, adresse/coordonnées). Admin uniquement (RLS).
export async function patchDomicile(id, patch) {
  const res = await fetch(`${REST}/domiciles?id=eq.${id}`, {
    method: 'PATCH', headers: await headers({ Prefer: 'return=representation' }), body: JSON.stringify(patch),
  });
  await ok(res, 'patch domicile');
  return (await res.json())[0];
}

export async function deleteDomicile(id) {
  const res = await fetch(`${REST}/domiciles?id=eq.${id}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'delete domicile');
}

// Membres d'un domicile (pour l'écran Partage).
export async function getMembers(domicileId) {
  const res = await fetch(`${REST}/domicile_members?domicile_id=eq.${domicileId}&select=*&order=created_at.asc`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET membres');
  return res.json();
}

// Met à jour mon prénom affiché dans un domicile.
export async function setMyPrenom(domicileId, userId, prenom) {
  const res = await fetch(`${REST}/domicile_members?domicile_id=eq.${domicileId}&user_id=eq.${userId}`, {
    method: 'PATCH', headers: await headers({ Prefer: 'return=representation' }), body: JSON.stringify({ prenom }),
  });
  await ok(res, 'set prénom');
  return (await res.json())[0];
}

// Retire un membre (ou soi-même : « quitter »).
export async function removeMember(domicileId, userId) {
  const res = await fetch(`${REST}/domicile_members?domicile_id=eq.${domicileId}&user_id=eq.${userId}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'remove membre');
}

// =====================================================================
// INVITATIONS (lien web)
// =====================================================================

// Crée une invitation, renvoie la ligne (dont le token à mettre dans l'URL).
export async function createInvitation(domicileId, role = 'member') {
  const res = await fetch(`${REST}/invitations`, {
    method: 'POST', headers: await headers({ Prefer: 'return=representation' }),
    body: JSON.stringify({ domicile_id: domicileId, role }),
  });
  await ok(res, 'create invitation');
  return (await res.json())[0];
}

export async function listInvitations(domicileId) {
  const res = await fetch(`${REST}/invitations?domicile_id=eq.${domicileId}&select=*&order=created_at.desc`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET invitations');
  return res.json();
}

export async function revokeInvitation(token) {
  const res = await fetch(`${REST}/invitations?token=eq.${token}`, {
    method: 'PATCH', headers: await headers({ Prefer: 'return=minimal' }), body: JSON.stringify({ revoked: true }),
  });
  await ok(res, 'revoke invitation');
}

// Rejoint un domicile via un token (RPC SECURITY DEFINER). Renvoie la ligne membre.
export async function acceptInvitation(token) {
  const res = await fetch(`${REST}/rpc/accept_invitation`, {
    method: 'POST', headers: await headers(), body: JSON.stringify({ _token: token }),
  });
  await ok(res, 'accept invitation');
  return res.json();
}

// =====================================================================
// ARROSAGES (par domicile)
// =====================================================================

export async function getArrosages(domicileId) {
  const res = await fetch(`${REST}/arrosages?domicile_id=eq.${domicileId}&select=*&order=jour.desc`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET arrosages');
  return res.json();
}

// Upsert d'un arrosage. ATTENTION : merge-duplicates REMPLACE la ligne (domicile, jour).
// L'appelant passe le TOTAL du jour (existant + nouveau), pas le delta.
export async function upsertArrosage({ domicileId, jour, minutes, auteur }) {
  const res = await fetch(`${REST}/arrosages?on_conflict=domicile_id,jour`, {
    method: 'POST',
    headers: await headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ domicile_id: domicileId, jour, minutes, auteur: auteur || null, updated_at: new Date().toISOString() }),
  });
  await ok(res, 'upsert arrosage');
  return (await res.json())[0];
}

export async function purgeBefore(domicileId, dateIso) {
  const res = await fetch(`${REST}/arrosages?domicile_id=eq.${domicileId}&jour=lt.${dateIso}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'purge arrosages');
}

// =====================================================================
// CONTRAINTES / ABSENCES (par domicile)
// =====================================================================

export async function getContraintes(domicileId) {
  const res = await fetch(`${REST}/contraintes?domicile_id=eq.${domicileId}&select=*&order=debut.asc`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET contraintes');
  return res.json();
}

export async function addContrainte({ domicileId, type = 'absence', debut, fin, note, auteur }) {
  const res = await fetch(`${REST}/contraintes`, {
    method: 'POST', headers: await headers({ Prefer: 'return=representation' }),
    body: JSON.stringify({ domicile_id: domicileId, type, debut, fin, note: note || null, auteur: auteur || null }),
  });
  await ok(res, 'add contrainte');
  return (await res.json())[0];
}

export async function deleteContrainte(id) {
  const res = await fetch(`${REST}/contraintes?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'delete contrainte');
}

export async function purgeContraintesBefore(domicileId, dateIso) {
  const res = await fetch(`${REST}/contraintes?domicile_id=eq.${domicileId}&fin=lt.${dateIso}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'purge contraintes');
}

// =====================================================================
// ABONNEMENTS PUSH
// =====================================================================

// Enregistre/rafraîchit l'abonnement push d'un appareil pour un domicile (clé = endpoint).
export async function upsertSubscription(subscription, { userId, domicileId, auteur } = {}) {
  const res = await fetch(`${REST}/push_subscriptions`, {
    method: 'POST', headers: await headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ endpoint: subscription.endpoint, subscription, user_id: userId || null, domicile_id: domicileId || null, auteur: auteur || null }),
  });
  await ok(res, 'upsert subscription');
}

// Tous les abonnements (utilisé côté serveur avec la clé secrète — bypass RLS).
export async function getSubscriptions() {
  const res = await fetch(`${REST}/push_subscriptions?select=*`, {
    headers: await headers(), cache: 'no-store',
  });
  await ok(res, 'GET subscriptions');
  return res.json();
}

export async function deleteSubscription(endpoint) {
  const res = await fetch(`${REST}/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE', headers: await headers({ Prefer: 'return=minimal' }),
  });
  await ok(res, 'delete subscription');
}
