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
  MAX_DRY_DAYS: 3,    // filet : au-delà, on n'attend plus la pluie annoncée
};

// --- Réglages par défaut (surchargés par la table `reglages`) -----------
export const DEFAULTS = { objectif_mm: 28, debit_mm_h: 27, kc: 0.8, objectif_manuel: false };

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
export const round1 = (n) => Math.round(n * 10) / 10;

// Objectif « temps normal » de référence (repère pour le bandeau + fallback).
export const OBJECTIF_REF = 28;

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

// --- Objectif hebdo DYNAMIQUE (évapotranspiration ET₀) ------------------
// Le « combien » s'adapte au climat : objectif = Σ(ET₀ 7 j) × Kc, borné 15–55.
// Fenêtre 7 j = 3 passés + aujourd'hui + 3 prévus → anticipe la canicule.
// ET₀ absente/incomplète → repli sur l'objectif fixe (jamais faux en silence).
export function computeObjectif({ weather, reglages, today }) {
  const r = { ...DEFAULTS, ...(reglages || {}) };
  const et0 = weather?.et0 || weather?.et0_fao_evapotranspiration || [];
  const times = weather?.time || [];
  const idx = findTodayIdx(times, today);

  // ET₀ moyen des 3 prochains jours → seuil canicule (≥ 6 mm/j).
  const next3 = [];
  if (idx !== -1) {
    for (let i = idx + 1; i <= idx + 3; i++) {
      const v = et0[i];
      if (typeof v === 'number' && Number.isFinite(v)) next3.push(v);
    }
  }
  const et0_mean3 = next3.length ? next3.reduce((a, b) => a + b, 0) / next3.length : null;
  const canicule = et0_mean3 != null && et0_mean3 >= 6;
  const meanOut = et0_mean3 != null ? round1(et0_mean3) : null;

  // Mode manuel : court-circuite le calcul dynamique.
  if (r.objectif_manuel) {
    return { objectif: r.objectif_mm, source: 'manuel', canicule, et0_7j: null, et0_mean3: meanOut, ref: OBJECTIF_REF };
  }

  // Fenêtre 7 j (3 passés + aujourd'hui + 3 prévus). Toutes les valeurs requises.
  const win = [];
  let complete = idx !== -1;
  for (let i = idx - 3; i <= idx + 3; i++) {
    const v = et0[i];
    if (typeof v === 'number' && Number.isFinite(v)) win.push(v);
    else complete = false;
  }

  if (!complete || win.length < 7) {
    return { objectif: OBJECTIF_REF, source: 'fallback', canicule, et0_7j: null, et0_mean3: meanOut, ref: OBJECTIF_REF };
  }

  const kc = Number(r.kc) > 0 ? Number(r.kc) : 0.8;
  const sum = win.reduce((a, b) => a + b, 0);
  const objectif = Math.max(15, Math.min(55, Math.round(sum * kc)));
  return { objectif, source: 'et0', canicule, et0_7j: round1(sum), et0_mean3: meanOut, kc, ref: OBJECTIF_REF };
}

// Constantes horticoles resserrées en canicule (rendues visibles dans l'UI).
export function effConstants(canicule) {
  return canicule
    ? { ...CONSTANTS, SPACING_DAYS: 2, MIN_SESSION_MM: 8, MAX_DRY_DAYS: 2 } // MAX reste 20 (ruissellement)
    : CONSTANTS;
}

// --- Calcul de base -----------------------------------------------------
// weather   : { time:[...], precipitation_sum:[...], precipitation_probability_max:[...], et0:[...] }
// arrosages : [{ jour:'YYYY-MM-DD', minutes:Number, auteur:String }, ...]
// reglages  : { objectif_mm, debit_mm_h }
// today     : 'YYYY-MM-DD' (date locale Europe/Zurich, fournie par l'appelant)
export function computeMetrics({ weather, arrosages, reglages, today }) {
  const r = { ...DEFAULTS, ...(reglages || {}) };
  // Garde débit : ≤ 0 ou non fini → division par zéro / déficit gonflé. Repli sûr.
  r.debit_mm_h = Number(r.debit_mm_h) > 0 ? Number(r.debit_mm_h) : DEFAULTS.debit_mm_h;
  const times = weather?.time || [];
  const precip = weather?.precipitation_sum || [];
  const idx = findTodayIdx(times, today);

  if (idx === -1) {
    return { ok: false, idx: -1, today, reglages: r };
  }

  // Pluie (mm). Le PASSÉ + aujourd'hui (index ≤ idx) est du RÉEL → compté à 100 %.
  // Le FUTUR (index > idx) est PONDÉRÉ par sa probabilité : une pluie annoncée mais
  // peu probable compte moins (on ne parie pas dessus). Proba manquante → 100 % (repli).
  const probs = weather?.precipitation_probability_max || [];
  const precipEff = precip.map((v, i) => {
    if (i <= idx) return v;                                   // réel
    if (typeof v !== 'number' || !Number.isFinite(v)) return v;
    const p = probs[i];
    const conf = (typeof p === 'number' && Number.isFinite(p)) ? Math.max(0, Math.min(1, p / 100)) : 1;
    return v * conf;                                          // pondéré
  });
  const pluie_recue = sumRange(precip, idx - 6, idx);          // 7 j réels, aujourd'hui inclus
  const pluie_prevue = sumRange(precipEff, idx + 1, idx + 3);  // 3 j prévus, PONDÉRÉS
  const pluie_48h = sumRange(precipEff, idx + 1, idx + 2);     // 2 j prévus, PONDÉRÉS
  const pluie_prevue_brute = sumRange(precip, idx + 1, idx + 3); // valeurs brutes (transparence)
  const pluie_48h_brute = sumRange(precip, idx + 1, idx + 2);

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

  const obj = computeObjectif({ weather, reglages: r, today });
  const deficit = Math.max(
    0,
    obj.objectif - pluie_recue - pluie_prevue - arrose_mm
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

  // Filet : jours depuis le dernier apport d'eau SÉRIEUX RÉEL (≤ aujourd'hui) —
  // pluie TOMBÉE ≥ RAIN_SOON_MM, ou arrosage sérieux. La pluie PRÉVUE ne compte pas
  // (elle n'est pas tombée). 99 si aucune eau sérieuse sur la fenêtre.
  let lastWaterISO = lastSignif ? lastSignif.jour : null;
  for (let i = Math.max(0, idx - 13); i <= idx; i++) {
    const v = precip[i];
    if (typeof v === 'number' && Number.isFinite(v) && v >= CONSTANTS.RAIN_SOON_MM && times[i]) {
      if (!lastWaterISO || times[i] > lastWaterISO) lastWaterISO = times[i];
    }
  }
  const dryDays = lastWaterISO ? diffDays(today, lastWaterISO) : 99;

  return {
    ok: true,
    idx,
    today,
    pluie_recue,
    pluie_prevue,
    pluie_48h,
    pluie_prevue_brute,
    pluie_48h_brute,
    dryDays,
    minutes7,
    arrose_mm,
    deficit,
    lastSignif,
    reglages: r,
    objectif: obj.objectif,
    objectif_source: obj.source,   // 'et0' | 'manuel' | 'fallback'
    canicule: obj.canicule,
    et0_7j: obj.et0_7j,
    et0_mean3: obj.et0_mean3,
    obj_ref: obj.ref,
    kc: obj.kc ?? null,
  };
}

// --- Moteur de décision : 5 règles, dans l'ordre de priorité -----------
// Renvoie un objet décision STRUCTURÉ (données brutes, pas de texte d'UI).
function baseDecide(input) {
  const m = computeMetrics(input);
  const r = m.reglages;

  if (!m.ok) {
    return { etat: 'erreur', metrics: m };
  }
  const C = effConstants(m.canicule); // 3→2 j d'espacement, MIN 10→8 mm en canicule

  // Filet de sécurité : trop longtemps sans eau réelle + déficit réel → on n'attend
  // plus la pluie annoncée (même très probable : elle peut ne pas tomber).
  const filet = m.dryDays >= C.MAX_DRY_DAYS && m.deficit >= C.MIN_SESSION_MM;

  const mmToMin = (mm) => Math.round((mm / r.debit_mm_h) * 60);
  const base = { metrics: m };

  // Règle 1 — déficit couvert
  if (m.deficit <= 0) {
    return { ...base, etat: 'rien' };
  }

  // Règle 2 — pluie imminente probable (>= RAIN_SOON_MM pondéré sous 48 h),
  // SAUF si le filet impose d'arroser (trop longtemps sans eau réelle).
  if (!filet && m.pluie_48h >= C.RAIN_SOON_MM) {
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
    // Plafonner la 2e session aussi (sinon jusqu'à ~35 mm d'un coup → ruissellement).
    const reste_mm = Math.min(m.deficit - session_mm, C.MAX_SESSION_MM);
    deuxieme = {
      jour: addDays(m.today, C.SPACING_DAYS),
      mm: reste_mm,
      minutes: mmToMin(reste_mm),
    };
  }
  return { ...base, etat: 'arroser', session_mm, minutes, deuxieme, filet };
}

// --- Couche « contraintes » : absences (père/fils au même jardin) -------
// Post-traite la décision de base SANS toucher aux 5 règles (une seule logique) :
//   - jour où l'on est absent (après le départ, jusqu'au retour) → « absent »
//     (personne au jardin ; on ne recommande pas d'arroser dans le vide) ;
//   - départ aujourd'hui ou demain + besoin réel qui tombera pendant l'absence
//     + peu de pluie prévue → « avant-depart » : arrose avant de partir.
// contraintes : [{ type:'absence', debut:'YYYY-MM-DD', fin:'YYYY-MM-DD' }]
function withContraintes(base, input) {
  const abs = (input.contraintes || []).filter((c) => c && c.type === 'absence' && c.debut && c.fin);
  if (!abs.length || !base.metrics?.ok) return base;
  const C = effConstants(base.metrics.canicule);

  const today = input.today;
  const tTo = parseISO(today);
  const r = base.metrics.reglages;

  // 1) Absent AUJOURD'HUI (strictement après le jour de départ, jusqu'au retour).
  //    Le jour de départ lui-même reste une occasion d'arroser (cf. règle 2).
  const during = abs.find((c) => parseISO(c.debut) < tTo && tTo <= parseISO(c.fin));
  if (during) {
    return { ...base, etat: 'absent', baseEtat: base.etat, absence: during };
  }

  // 2) Départ aujourd'hui (debut === today) ou demain (debut === today+1) :
  //    dernière chance d'arroser avant de partir.
  const tTom = parseISO(addDays(today, 1));
  const leaving = abs.find((c) => { const d = parseISO(c.debut); return d === tTo || d === tTom; });
  if (leaving) {
    // Besoin réel pendant l'absence ? Déficit projeté au dernier jour d'absence
    // (sans arroser d'ici là) + peu de pluie sur la fenêtre.
    // ⚠️ La pluie prévue APRÈS le retour ne compte pas : elle n'aide pas le
    // jardin pendant l'absence — on la neutralise avant de projeter le déficit.
    const tFin = parseISO(leaving.fin);
    const times = input.weather?.time || [];
    const precip = input.weather?.precipitation_sum || [];
    const probs = input.weather?.precipitation_probability_max || [];
    const idxNow = findTodayIdx(times, today);
    // Confiance d'un jour : passé/aujourd'hui = 100 % (réel) ; futur = sa probabilité.
    // Même prudence que le moteur : une pluie annoncée peu probable pendant l'absence
    // ne doit PAS supprimer l'arrosage avant départ (fenêtre non rattrapable).
    const conf = (i) => {
      if (i <= idxNow) return 1;
      const p = probs[i];
      return (typeof p === 'number' && Number.isFinite(p)) ? Math.max(0, Math.min(1, p / 100)) : 1;
    };
    // Pluie PENDANT l'absence : pondérée. Pluie APRÈS le retour : ne compte pas.
    const precipTrunc = precip.map((v, i) => {
      const t = times[i];
      if (t && parseISO(t) > tFin) return 0;
      if (typeof v !== 'number' || !Number.isFinite(v)) return v;
      return v * conf(i);
    });
    const mFin = computeMetrics({ ...input, weather: { ...input.weather, precipitation_sum: precipTrunc }, today: leaving.fin });
    const defFin = mFin.ok ? mFin.deficit : 0;
    let rainAbs = 0;
    for (let i = 0; i < times.length; i++) {
      const t = parseISO(times[i]);
      if (t >= parseISO(leaving.debut) && t <= tFin) {
        const v = precip[i];
        if (typeof v === 'number' && Number.isFinite(v)) rainAbs += v * conf(i);
      }
    }
    if (defFin >= C.MIN_SESSION_MM && rainAbs < C.RAIN_SOON_MM) {
      const session_mm = Math.min(defFin, C.MAX_SESSION_MM);
      const minutes = Math.round((session_mm / r.debit_mm_h) * 60);
      return { ...base, etat: 'avant-depart', session_mm, minutes, absence: leaving, deficitFin: round1(defFin) };
    }
  }
  return base;
}

// Décision publique : règles de base + couche contraintes. Source unique.
export function decide(input) {
  return withContraintes(baseDecide(input), input);
}

// --- Projection « semaine à venir » ------------------------------------
// Rejoue le moteur pour chaque jour de today..today+6, en SIMULANT qu'on suit
// la reco : si un jour est « arroser », on ajoute un arrosage virtuel ce jour-là
// (ce qui déclenche l'espacement et réduit le déficit les jours suivants).
// Résultat : la bande montre les VRAIES prochaines sessions (💧 … ⏳ repos … 💧),
// pas « arroser » répété. Répond à « quand tomberont les prochaines sessions ? ».
export function projectWeek(input) {
  const { weather } = input;
  let sim = [...(input.arrosages || [])]; // arrosages réels + simulés au fil des jours
  const out = [];
  for (let k = 0; k < 7; k++) {
    const day = addDays(input.today, k);
    if (!weather?.time?.includes(day)) {
      // Au-delà des prévisions dispo (modèle ICON CH2 = 5 j) : inconnu.
      out.push({ jour: day, etat: 'inconnu', minutes: null });
      continue;
    }
    const d = decide({ ...input, arrosages: sim, today: day });
    out.push({ jour: day, etat: d.etat, minutes: d.minutes ?? null });
    if (d.etat === 'arroser' || d.etat === 'avant-depart') {
      sim = sim.concat({ jour: day, minutes: d.minutes, auteur: null });
    }
  }
  return out;
}
