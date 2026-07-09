// Tests du moteur — exécuter : node test/engine.test.mjs
// Vérifie les 5 scénarios du plan + les cas limites, au chiffre près.
import { decide, computeMetrics, findTodayIdx, addDays, diffDays, CONSTANTS } from '../engine.js';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// Fenêtre identique à l'API réelle : 07-02..07-13, aujourd'hui = 07-09 (idx 7).
const TIMES = ['2026-07-02','2026-07-03','2026-07-04','2026-07-05','2026-07-06',
               '2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11',
               '2026-07-12','2026-07-13'];
const TODAY = '2026-07-09';
const zeros = () => Array(12).fill(0);
function weather(precip, prob) {
  return { time: TIMES, precipitation_sum: precip, precipitation_probability_max: prob || zeros() };
}
const REG = { objectif_mm: 28, debit_mm_h: 27 };

console.log('\n=== MOTEUR DE DÉCISION — SCÉNARIOS DU PLAN ===\n');

// -- Scénario 1 : déficit 0 → « Rien à faire »
{
  const p = zeros(); p[7] = 30; // 30 mm de pluie aujourd'hui
  const d = decide({ weather: weather(p), arrosages: [], reglages: REG, today: TODAY });
  console.log(`Scénario 1 (pluie reçue 30mm) : etat=${d.etat}, déficit=${d.metrics.deficit}`);
  check('S1 → rien', d.etat === 'rien', d.etat);
  check('S1 déficit = 0', d.metrics.deficit === 0);
}

// -- Scénario 2 : déficit > 0 mais 8 mm de pluie demain → « La pluie s'en charge »
{
  const p = zeros(); p[8] = 8; // 8 mm demain (07-10)
  const d = decide({ weather: weather(p), arrosages: [], reglages: REG, today: TODAY });
  console.log(`Scénario 2 (8mm demain)      : etat=${d.etat}, pluie_48h=${d.metrics.pluie_48h}, déficit=${d.metrics.deficit}`);
  check('S2 → pluie', d.etat === 'pluie', d.etat);
  check('S2 pluie_48h = 8', d.metrics.pluie_48h === 8);
  check('S2 déficit > 0 (sinon règle 1 primerait)', d.metrics.deficit > 0);
}

// -- Scénario 3 : déficit > 0, arrosé hier (significatif) → « Attends [jour] »
{
  const arros = [{ jour: '2026-07-08', minutes: 30, auteur: 'Papa' }]; // 30min=13.5mm >= 8
  const d = decide({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  console.log(`Scénario 3 (arrosé hier 30m) : etat=${d.etat}, prochainJour=${d.prochainJour}, minProchaine=${d.minutesProchaine}, déficit=${d.metrics.deficit.toFixed(1)}`);
  check('S3 → attends', d.etat === 'attends', d.etat);
  check('S3 prochain arrosage = 07-11 (07-08 + 3j)', d.prochainJour === '2026-07-11', d.prochainJour);
  check('S3 lastSignif à J-1', d.metrics.lastSignif?.daysAgo === 1);
}

// -- Scénario 4 : déficit 6 mm, sec → « Presque bon »
{
  const p = zeros(); p[7] = 22; // pluie reçue 22 → déficit 6
  const d = decide({ weather: weather(p), arrosages: [], reglages: REG, today: TODAY });
  console.log(`Scénario 4 (déficit 6mm)     : etat=${d.etat}, déficit=${d.metrics.deficit}`);
  check('S4 → presque', d.etat === 'presque', d.etat);
  check('S4 déficit = 6', d.metrics.deficit === 6);
}

// -- Scénario 5 : déficit 28 mm, rien de récent → « Arroser 44 min » + 2e session
{
  const d = decide({ weather: weather(zeros()), arrosages: [], reglages: REG, today: TODAY });
  console.log(`Scénario 5 (déficit 28mm)    : etat=${d.etat}, minutes=${d.minutes}, session_mm=${d.session_mm}, 2e=${d.deuxieme ? d.deuxieme.minutes + 'min le ' + d.deuxieme.jour : 'aucune'}`);
  check('S5 → arroser', d.etat === 'arroser', d.etat);
  check('S5 déficit = 28', d.metrics.deficit === 28);
  check('S5 minutes = 44', d.minutes === 44, String(d.minutes));
  check('S5 session_mm = 20 (plafonné MAX)', d.session_mm === 20);
  check('S5 2e session annoncée', !!d.deuxieme);
  check('S5 2e session = 18 min le 07-12', d.deuxieme?.minutes === 18 && d.deuxieme?.jour === '2026-07-12',
        JSON.stringify(d.deuxieme));
}

console.log('\n=== CAS LIMITES ===\n');

// -- Fuseau : today présent → idx exact
check('todayIdx exact = 7', findTodayIdx(TIMES, TODAY) === 7);
// -- Fallback : today au-delà des données → dernier jour <= today
check('fallback today futur → idx 11', findTodayIdx(TIMES, '2026-07-20') === 11, String(findTodayIdx(TIMES, '2026-07-20')));
// -- Fallback : today avant la fenêtre → -1
check('today avant fenêtre → -1', findTodayIdx(TIMES, '2026-06-01') === -1);
// -- idx introuvable → état erreur (pas de fausse reco)
{
  const d = decide({ weather: { time: [], precipitation_sum: [] }, arrosages: [], reglages: REG, today: TODAY });
  check('time vide → etat erreur', d.etat === 'erreur', d.etat);
}

// -- Arrosé AUJOURD'HUI (significatif) → « C'est fait pour aujourd'hui »
{
  const arros = [{ jour: '2026-07-09', minutes: 30, auteur: 'Papa' }];
  const d = decide({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  console.log(`Arrosé aujourd'hui 30m       : etat=${d.etat}, déficit=${d.metrics.deficit.toFixed(1)}`);
  check('arrosé aujourd\'hui → fait', d.etat === 'fait', d.etat);
}

// -- Minutes <= 0 ou jour manquant → ignorés dans le calcul
{
  const arros = [{ jour: '2026-07-08', minutes: 0 }, { jour: '2026-07-08', minutes: -5 }, { minutes: 40 }];
  const m = computeMetrics({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  check('arrosages invalides ignorés (minutes7 = 0)', m.minutes7 === 0, String(m.minutes7));
}

// -- Agrégation de 2 arrosages le même jour (père + fils) → sommés
{
  const arros = [{ jour: '2026-07-08', minutes: 20, auteur: 'Papa' }, { jour: '2026-07-08', minutes: 20, auteur: 'Fils' }];
  const m = computeMetrics({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  check('2 arrosages même jour sommés (40 min)', m.minutes7 === 40, String(m.minutes7));
  // 40 min = 18 mm >= 8 significatif, J-1 → attends
  const d = decide({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  check('agrégé J-1 → attends', d.etat === 'attends', d.etat);
}

// -- Arrosage faible hier (< significatif) ne bloque PAS l'espacement
{
  const arros = [{ jour: '2026-07-08', minutes: 10, auteur: 'Papa' }]; // 10min=4.5mm < 8
  const d = decide({ weather: weather(zeros()), arrosages: arros, reglages: REG, today: TODAY });
  console.log(`Arrosé 10min hier (4.5mm)    : etat=${d.etat} (attendu arroser, non bloquant)`);
  check('arrosage faible hier → pas attends', d.etat !== 'attends', d.etat);
}

// -- Cohérence : debit/objectif custom
{
  const d = decide({ weather: weather(zeros()), arrosages: [], reglages: { objectif_mm: 15, debit_mm_h: 30 }, today: TODAY });
  // déficit 15 → session min(15,20)=15 → round(15/30*60)=30 min
  check('réglages custom (obj15,débit30) → 30 min', d.etat === 'arroser' && d.minutes === 30, `${d.etat}/${d.minutes}`);
}

console.log('\n' + results.join('\n'));
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
