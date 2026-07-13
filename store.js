// store.js — accès à la base partagée Supabase (REST/PostgREST).
// Source de vérité COMMUNE aux deux utilisateurs (père + fils).
// Aucune logique métier ici : juste des lectures/écritures qui renvoient des
// données ou LÈVENT une erreur (l'appelant décide quoi afficher). Réutilisable
// par la page (navigateur) et par le script de notifications (Node).
import { SUPA_URL, SUPA_KEY } from './config.js';

const REST = SUPA_URL + '/rest/v1';
const headers = () => ({
  apikey: SUPA_KEY,
  Authorization: 'Bearer ' + SUPA_KEY,
  'Content-Type': 'application/json',
});

async function ok(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} → HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  return res;
}

// Liste des arrosages (tableau [{ jour, minutes, auteur, updated_at }]).
export async function getArrosages() {
  const res = await fetch(`${REST}/arrosages?select=*&order=jour.desc`, {
    headers: headers(), cache: 'no-store',
  });
  await ok(res, 'GET arrosages');
  return res.json();
}

// Réglages (objet { id, objectif_mm, debit_mm_h }) ou null si absent.
export async function getReglages() {
  const res = await fetch(`${REST}/reglages?id=eq.1&select=*`, {
    headers: headers(), cache: 'no-store',
  });
  await ok(res, 'GET reglages');
  const rows = await res.json();
  return rows[0] || null;
}

// Upsert d'un arrosage. ATTENTION : merge-duplicates REMPLACE la ligne du jour.
// L'appelant doit donc passer le TOTAL du jour (existant + nouveau), pas le delta.
export async function upsertArrosage({ jour, minutes, auteur }) {
  const res = await fetch(`${REST}/arrosages`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ jour, minutes, auteur: auteur || null, updated_at: new Date().toISOString() }),
  });
  await ok(res, 'upsert arrosage');
  return (await res.json())[0];
}

// Mise à jour des réglages.
export async function patchReglages(patch) {
  const res = await fetch(`${REST}/reglages?id=eq.1`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  await ok(res, 'patch reglages');
  return (await res.json())[0];
}

// Purge des arrosages antérieurs à `dateIso` (YYYY-MM-DD).
export async function purgeBefore(dateIso) {
  const res = await fetch(`${REST}/arrosages?jour=lt.${dateIso}`, {
    method: 'DELETE', headers: { ...headers(), Prefer: 'return=minimal' },
  });
  await ok(res, 'purge arrosages');
}

// --- Abonnements push (étape 4) ---------------------------------------
// Enregistre/rafraîchit l'abonnement push d'un appareil (clé = endpoint).
export async function upsertSubscription(subscription, auteur) {
  const res = await fetch(`${REST}/push_subscriptions`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ endpoint: subscription.endpoint, subscription, auteur: auteur || null }),
  });
  await ok(res, 'upsert subscription');
}

// Liste tous les abonnements (utilisé par le script d'envoi côté serveur).
export async function getSubscriptions() {
  const res = await fetch(`${REST}/push_subscriptions?select=*`, {
    headers: headers(), cache: 'no-store',
  });
  await ok(res, 'GET subscriptions');
  return res.json();
}

// Supprime un abonnement mort (endpoint renvoyant 404/410).
export async function deleteSubscription(endpoint) {
  const res = await fetch(`${REST}/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE', headers: { ...headers(), Prefer: 'return=minimal' },
  });
  await ok(res, 'delete subscription');
}

// --- Contraintes (absences) — étape « chat » ---------------------------
// Liste les contraintes actives (tableau [{ id, type, debut, fin, note, auteur }]).
export async function getContraintes() {
  const res = await fetch(`${REST}/contraintes?select=*&order=debut.asc`, {
    headers: headers(), cache: 'no-store',
  });
  await ok(res, 'GET contraintes');
  return res.json();
}

// Ajoute une contrainte (ex. une fenêtre d'absence). Renvoie la ligne créée.
export async function addContrainte({ type = 'absence', debut, fin, note, auteur }) {
  const res = await fetch(`${REST}/contraintes`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify({ type, debut, fin, note: note || null, auteur: auteur || null }),
  });
  await ok(res, 'add contrainte');
  return (await res.json())[0];
}

// Supprime une contrainte par id.
export async function deleteContrainte(id) {
  const res = await fetch(`${REST}/contraintes?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...headers(), Prefer: 'return=minimal' },
  });
  await ok(res, 'delete contrainte');
}

// Purge les contraintes passées (fin < dateIso).
export async function purgeContraintesBefore(dateIso) {
  const res = await fetch(`${REST}/contraintes?fin=lt.${dateIso}`, {
    method: 'DELETE', headers: { ...headers(), Prefer: 'return=minimal' },
  });
  await ok(res, 'purge contraintes');
}
