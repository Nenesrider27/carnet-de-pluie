// domicile.js — état du domicile courant + caches localStorage NAMESPACÉS.
// Un compte peut avoir plusieurs domiciles ; on mémorise lequel est actif et on
// préfixe TOUS les caches par son id, pour ne jamais mélanger deux maisons.
const LS_CURRENT = 'cp.currentDomicile';

let _domiciles = [];   // [{ id, nom, adresse, lat, lon, timezone, objectif_mm, debit_mm_h, kc, objectif_manuel, owner_id, domicile_members:[{role,prenom,user_id}] }]
let _currentId = null;
let _userId = null;

export function setUser(id) { _userId = id; }
export function getUserId() { return _userId; }

// Charge la liste des domiciles et (re)choisit le courant (mémorisé, sinon 1er).
export function setDomiciles(list) {
  _domiciles = Array.isArray(list) ? list : [];
  const saved = _currentId || safeGet(LS_CURRENT);
  _currentId = _domiciles.find((d) => d.id === saved) ? saved : (_domiciles[0]?.id || null);
  if (_currentId) safeSet(LS_CURRENT, _currentId);
  return _currentId;
}

export function getDomiciles() { return _domiciles; }
export function current() { return _domiciles.find((d) => d.id === _currentId) || null; }
export function currentId() { return _currentId; }

export function setCurrent(id) {
  if (_domiciles.find((d) => d.id === id)) { _currentId = id; safeSet(LS_CURRENT, id); }
  return current();
}

// Mon membership dans le domicile courant.
function myMember() {
  const d = current(); if (!d) return null;
  return (d.domicile_members || []).find((x) => x.user_id === _userId) || null;
}
export function myPrenom() { return myMember()?.prenom || ''; }
export function myRole() { return myMember()?.role || null; }
export function isAdmin() { const r = myRole(); return r === 'owner' || r === 'admin'; }

// Réglages du domicile courant, dans la forme attendue par engine.js.
export function currentReglages() {
  const d = current();
  if (!d) return null;
  return {
    objectif_mm: Number(d.objectif_mm),
    debit_mm_h: Number(d.debit_mm_h),
    kc: d.kc != null ? Number(d.kc) : 0.8,
    objectif_manuel: d.objectif_manuel === true,
  };
}

// Coordonnées météo du domicile courant (défaut Anières si absentes).
export function currentLoc() {
  const d = current();
  return {
    lat: d?.lat ?? 46.2777,
    lon: d?.lon ?? 6.2234,
    tz: d?.timezone || 'Europe/Zurich',
  };
}

// Clé de cache localStorage préfixée par le domicile courant.
export function nsKey(base) { return `cp.${_currentId || 'none'}.${base}`; }
// Idem mais pour un domicile EXPLICITE (anti-course : écrire dans le bon namespace
// même si le domicile courant a changé pendant une requête en vol).
export function nsKeyFor(id, base) { return `cp.${id || 'none'}.${base}`; }

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
