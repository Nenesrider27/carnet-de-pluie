// engine.js — Moteur de décision « Carnet de pluie »
// =====================================================================
// SOURCE DE VÉRITÉ UNIQUE de la logique d'arrosage.
// Importé tel quel par :
//   - la page (navigateur, <script type="module">)
//   - le script de notifications matinales (Node, scripts/morning-push.mjs)
// Contraintes de conception :
//   - AUCUNE dépendance, AUCUN accès DOM/réseau, AUCUNE horloge interne.
//   - Tout entre par les paramètres (dont `today`) → 100 % déterministe/testable.
//   - Ne renvoie que des DONNÉES (états, nombres, dates ISO). Le formatage
//     humain (noms de jours FR, phrases) est fait par la couche présentation,
//     pour ne pas coupler la logique à une locale ou à un canal (carte vs push).
// =====================================================================

// --- Constantes horticoles (heuristiques standard, cf. plan) ------------
export const CONSTANTS = {
  MIN_SESSION_MM: 10, // en dessous : arrosage superficiel inutile
  MAX_SESSION_MM: 20, // au-delà en une fois : ruissellement
  SPACING_DAYS: 3,    // été : sessions profondes ~2x/semaine
  RAIN_SOON_MM: 5,    // pluie >= 5 mm sous 48 h -> laisser faire la pluie
  SIGNIF_MM: 8,       // arrosage « significatif » (équiv. mm) pour l'espacement
};

// --- Réglages par défaut (surchargés par la table `reglages`) -----------
export const DEFAULTS = { objectif_mm: 28, debit_mm_h: 27 };

// --- Helpers de dates : calendaires purs, en UTC minuit (pas de DST) -----
export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export function addDays(iso, n) {
  const dt = new Date(parseISO(iso) + n * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function diffDays(isoA, isoB) {
  // (isoA - isoB) en jours entiers
  return Math.round((parseISO(isoA) - parseISO(isoB)) / 86400000);
}

// Somme d'une plage d'indices [from..to], clampée aux bornes, null/NaN ignorés.
function sumRange(arr, from, to) {
  let s = 0;
  const lo = Math.max(0, from);
  const hi = Math.min((arr?.length ?? 0) - 1, to);
  for (let i = lo; i <= hi; i++) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return s;
}

// Trouve l'index d'« aujourd'hui » dans le tableau `time` de l'API.
// Fallback (décalage minuit/fuseau) : dernier jour <= today. -1 si aucun.
export function findTodayIdx(times, today) {
  if (!Array.isArray(times) || times.length === 0) return -1;
  const exact = times.indexOf(today);
  if (exact !== -1) return exact;
  let best = -1;
  const t = parseISO(today);
  for (let i = 0; i < times.length; i++) {
    if (parseISO(times[i]) <= t) best = i;
  }
  return best;
}

// --- Calcul de base -----------------------------------------------------
// weather   : { time:[...], precipitation_sum:[...], precipitation_probability_max:[...] }
// arrosages : [{ jour:'YYYY-MM-DD', minutes:Number, auteur:String }, ...]
// reglages  : { objectif_mm, debit_mm_h }
// today     : 'YYYY-MM-DD' (date locale Europe/Zurich, fournie par l'appelant)
export function computeMetrics({ weather, arrosages, reglages, today }) {
  const r = { ...DEFAULTS, ...(reglages || {}) };
  const times = weather?.time || [];
  const precip = weather?.precipitation_sum || [];
  const idx = findTodayIdx(times, today);

  if (idx === -1) {
    return { ok: false, idx: -1, today, reglages: r };
  }

  // Pluie (mm)
  const pluie_recue = sumRange(precip, idx - 6, idx);      // 7 j, aujourd'hui inclus
  const pluie_prevue = sumRange(precip, idx + 1, idx + 3); // 3 prochains jours
  const pluie_48h = sumRange(precip, idx + 1, idx + 2);    // 2 prochains jours

  // Arrosage : agrège les minutes par jour, puis somme sur les 7 derniers jours.
  const byDay = {};
  for (const a of arrosages || []) {
    const min = Number(a?.minutes) || 0;
    if (min <= 0 || !a?.jour) continue;
    byDay[a.jour] = (byDay[a.jour] || 0) + min;
  }
  const dateMin = addDays(today, -6);
  const tMin = parseISO(dateMin);
  const tToday = parseISO(today);
  let minutes7 = 0;
  for (const jour in byDay) {
    const tj = parseISO(jour);
    if (tj >= tMin && tj <= tToday) minutes7 += byDay[jour];
  }
  const arrose_mm = (minutes7 / 60) * r.debit_mm_h;

  const deficit = Math.max(
    0,
    r.objectif_mm - pluie_recue - pluie_prevue - arrose_mm
  );

  // Dernier arrosage « significatif » (équiv. mm >= SIGNIF_MM), <= aujourd'hui.
  // On parcourt du plus ancien au plus récent : le dernier gardé est le plus récent.
  let lastSignif = null;
  const jours = Object.keys(byDay)
    .filter((j) => parseISO(j) <= tToday)
    .sort();
  for (const j of jours) {
    const mm = (byDay[j] / 60) * r.debit_mm_h;
    if (mm >= CONSTANTS.SIGNIF_MM) {
      lastSignif = { jour: j, minutes: byDay[j], mm, daysAgo: diffDays(today, j) };
    }
  }

  return {
    ok: true,
    idx,
    today,
    pluie_recue,
    pluie_prevue,
    pluie_48h,
    minutes7,
    arrose_mm,
    deficit,
    lastSignif,
    reglages: r,
  };
}

// --- Moteur de décision : 5 règles, dans l'ordre de priorité -----------
// Renvoie un objet décision STRUCTURÉ (données brutes, pas de texte d'UI).
export function decide(input) {
  const C = CONSTANTS;
  const m = computeMetrics(input);
  const r = m.reglages;

  if (!m.ok) {
    return { etat: 'erreur', metrics: m };
  }

  const mmToMin = (mm) => Math.round((mm / r.debit_mm_h) * 60);
  const base = { metrics: m };

  // Règle 1 — déficit couvert
  if (m.deficit <= 0) {
    return { ...base, etat: 'rien' };
  }

  // Règle 2 — pluie imminente (>= RAIN_SOON_MM sous 48 h)
  if (m.pluie_48h >= C.RAIN_SOON_MM) {
    return { ...base, etat: 'pluie' };
  }

  // Règle 3 — dernier arrosage significatif trop récent (< SPACING_DAYS)
  if (m.lastSignif && m.lastSignif.daysAgo < C.SPACING_DAYS) {
    if (m.lastSignif.daysAgo === 0) {
      return { ...base, etat: 'fait' }; // « C'est fait pour aujourd'hui »
    }
    const session_mm = Math.min(m.deficit, C.MAX_SESSION_MM);
    return {
      ...base,
      etat: 'attends',
      prochainJour: addDays(m.lastSignif.jour, C.SPACING_DAYS),
      minutesProchaine: mmToMin(session_mm),
      session_mm,
    };
  }

  // Règle 4 — déficit trop faible pour une session utile
  if (m.deficit < C.MIN_SESSION_MM) {
    return { ...base, etat: 'presque' };
  }

  // Règle 5 — arroser
  const session_mm = Math.min(m.deficit, C.MAX_SESSION_MM);
  const minutes = mmToMin(session_mm);
  let deuxieme = null;
  if (m.deficit > C.MAX_SESSION_MM) {
    const reste_mm = m.deficit - session_mm;
    deuxieme = {
      jour: addDays(m.today, C.SPACING_DAYS),
      mm: reste_mm,
      minutes: mmToMin(reste_mm),
    };
  }
  return { ...base, etat: 'arroser', session_mm, minutes, deuxieme };
}

// --- Projection « semaine à venir » ------------------------------------
// Rejoue le moteur pour chaque jour de today..today+6 (limité aux données),
// en supposant qu'aucun arrosage futur n'a lieu (projection « si on ne fait
// rien »). Utilisé pour la bande 7 jours (étape 5) et exposé dès maintenant.
export function projectWeek(input) {
  const { weather } = input;
  const out = [];
  for (let k = 0; k < 7; k++) {
    const day = addDays(input.today, k);
    if (!weather?.time?.includes(day)) {
      // Au-delà des prévisions dispo (modèle ICON CH2 = 5 j) : inconnu.
      out.push({ jour: day, etat: 'inconnu' });
      continue;
    }
    const d = decide({ ...input, today: day });
    out.push({ jour: day, etat: d.etat, minutes: d.minutes ?? null });
  }
  return out;
}
