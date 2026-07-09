// Test de la logique décision→notification — node test/notify.test.mjs
// Vérifie QUELS états déclenchent un push et le texte, sans rien envoyer.
import { planNotification } from '../scripts/morning-push.mjs';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' → ' + d : ''}`); } };

const TIMES = ['2026-07-02','2026-07-03','2026-07-04','2026-07-05','2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11','2026-07-12','2026-07-13'];
const TODAY = '2026-07-09';
const REG = { objectif_mm: 28, debit_mm_h: 27 };
const z = () => Array(12).fill(0);
const W = (p) => ({ time: TIMES, precipitation_sum: p, precipitation_probability_max: z() });

console.log('\n=== LOGIQUE DE NOTIFICATION MATINALE ===\n');

// ARROSER (sec) → push
{
  const n = planNotification({ weather: W(z()), arrosages: [], reglages: REG, today: TODAY });
  ck('ARROSER → push', n.push && n.etat === 'arroser');
  ck('ARROSER titre contient "~44 min"', /~44 min/.test(n.title), n.title);
  ck('ARROSER corps mentionne le déficit', /28 mm/.test(n.body), n.body);
}

// PLUIE alors qu'un arrosage aurait été dû (8mm demain, sinon sec) → push
{
  const p = z(); p[8] = 8;
  const n = planNotification({ weather: W(p), arrosages: [], reglages: REG, today: TODAY });
  ck('PLUIE (besoin réel) → push', n.push && n.etat === 'pluie', JSON.stringify(n));
  ck('PLUIE titre = "La pluie s\'en charge"', /La pluie s'en charge/.test(n.title), n.title);
}

// PLUIE mais AUCUN besoin (déjà bien arrosé par la pluie passée) → PAS de push
{
  const p = z(); p[7] = 20; p[8] = 6; // 20mm reçus + 6mm demain
  const n = planNotification({ weather: W(p), arrosages: [], reglages: REG, today: TODAY });
  ck('PLUIE sans besoin → PAS de push', !n.push, JSON.stringify(n));
}

// RIEN → pas de push
{
  const p = z(); p[7] = 30;
  const n = planNotification({ weather: W(p), arrosages: [], reglages: REG, today: TODAY });
  ck('RIEN → pas de push', !n.push && n.etat === 'rien');
}

// ATTENDS (arrosé hier) → pas de push (pas de spam)
{
  const n = planNotification({ weather: W(z()), arrosages: [{ jour: '2026-07-08', minutes: 30, auteur: 'Papa' }], reglages: REG, today: TODAY });
  ck('ATTENDS → pas de push', !n.push && n.etat === 'attends');
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
