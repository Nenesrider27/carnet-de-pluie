// Tests de la couche « contraintes » (absences) — node test/contraintes.test.mjs
import { decide } from '../engine.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' → ' + d : ''}`); } };

const TIMES = ['2026-07-03','2026-07-04','2026-07-05','2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11','2026-07-12','2026-07-13','2026-07-14'];
const REG = { objectif_mm: 28, debit_mm_h: 27 };
const z = () => Array(12).fill(0);
const W = (p) => ({ time: TIMES, precipitation_sum: p || z(), precipitation_probability_max: z() });
// Absence : part demain (11), revient le 13.
const ABS = [{ type: 'absence', debut: '2026-07-11', fin: '2026-07-13' }];

console.log('\n=== COUCHE CONTRAINTES (ABSENCES) ===\n');

// A. Veille du départ, sec → « avant-depart »
{
  const d = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-10', contraintes: ABS });
  console.log(`A veille (10), sec  : etat=${d.etat}, minutes=${d.minutes}`);
  ck('A → avant-depart', d.etat === 'avant-depart', d.etat);
  ck('A minutes = 44 (session pleine)', d.minutes === 44, String(d.minutes));
}

// B. Jour du départ (11) → encore « avant-depart » (dernière chance le matin)
{
  const d = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-11', contraintes: ABS });
  ck('B jour du départ → avant-depart', d.etat === 'avant-depart', d.etat);
}

// C. Pendant l'absence (12) → « absent »
{
  const d = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-12', contraintes: ABS });
  console.log(`C pendant absence(12): etat=${d.etat}, baseEtat=${d.baseEtat}`);
  ck('C → absent', d.etat === 'absent', d.etat);
}

// D. Absence lointaine (part le 14) → règles normales
{
  const far = [{ type: 'absence', debut: '2026-07-14', fin: '2026-07-16' }];
  const d = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-10', contraintes: far });
  ck('D absence lointaine → règles normales (arroser)', d.etat === 'arroser', d.etat);
}

// E. Pluie pendant l'absence → la pluie s'en charge (pas de nudge inutile)
{
  const p = z(); p[9] = 8; // 8 mm le 12, pendant l'absence
  const d = decide({ weather: W(p), arrosages: [], reglages: REG, today: '2026-07-10', contraintes: ABS });
  console.log(`E pluie 8mm pdt abs : etat=${d.etat}`);
  ck('E → pas avant-depart (pluie couvre)', d.etat !== 'avant-depart', d.etat);
}

// F. Jardin déjà servi (arrosé aujourd'hui) → pas de nudge, état de base
{
  const arros = [{ jour: '2026-07-10', minutes: 80, auteur: 'Ernest' }]; // couvre le déficit
  const d = decide({ weather: W(), arrosages: arros, reglages: REG, today: '2026-07-10', contraintes: ABS });
  console.log(`F déjà servi        : etat=${d.etat}, déficit=${d.metrics.deficit}`);
  ck('F → pas avant-depart (pas de besoin)', d.etat !== 'avant-depart', d.etat);
}

// G. Sans contraintes → identique au moteur de base (non-régression)
{
  const d1 = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-10' });
  const d2 = decide({ weather: W(), arrosages: [], reglages: REG, today: '2026-07-10', contraintes: [] });
  ck('G sans contraintes → arroser (inchangé)', d1.etat === 'arroser' && d2.etat === 'arroser');
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
