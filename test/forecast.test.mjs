// test/forecast.test.mjs — prévisions prudentes : pondération par probabilité + filet.
import { decide, CONSTANTS } from '../engine.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (d ? ' → ' + d : ''))); };

// Fenêtre : aujourd'hui = 07-09 (idx 7).
const TIMES = ['2026-07-02','2026-07-03','2026-07-04','2026-07-05','2026-07-06',
               '2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11',
               '2026-07-12','2026-07-13'];
const TODAY = '2026-07-09';
const REG = { objectif_mm: 28, debit_mm_h: 27 };
const z = () => Array(12).fill(0);
const W = (precip, prob) => ({ time: TIMES, precipitation_sum: precip, precipitation_probability_max: prob });

console.log('\n=== PRÉVISIONS PRUDENTES (pondération + filet) ===\n');

// 1) Pluie prévue DOUTEUSE (12 mm demain @ 30 %), eau récente (filet off) → on arrose quand même.
{
  const p = z(); p[6] = 6; p[8] = 12;
  const prob = z(); prob[8] = 30;
  const d = decide({ weather: W(p, prob), arrosages: [], reglages: REG, today: TODAY });
  ck('pluie douteuse (30 %) → arrose', d.etat === 'arroser', d.etat + ' pluie48=' + d.metrics.pluie_48h);
  ck('  48h pondéré ≈ 3.6', Math.abs(d.metrics.pluie_48h - 3.6) < 0.01, String(d.metrics.pluie_48h));
  ck('  valeur brute conservée = 12', d.metrics.pluie_48h_brute === 12);
}

// 2) Pluie prévue SÛRE (12 mm demain @ 95 %), eau récente → « la pluie s'en charge ».
{
  const p = z(); p[6] = 6; p[8] = 12;
  const prob = z(); prob[8] = 95;
  const d = decide({ weather: W(p, prob), arrosages: [], reglages: REG, today: TODAY });
  ck('pluie sûre (95 %) → la pluie s\'en charge', d.etat === 'pluie', d.etat);
  ck('  48h pondéré ≈ 11.4', Math.abs(d.metrics.pluie_48h - 11.4) < 0.01, String(d.metrics.pluie_48h));
}

// 3) FILET : sec depuis longtemps + déficit réel + pluie SÛRE annoncée → on arrose (le filet neutralise la pluie).
{
  const p = z(); p[8] = 8;            // 8 mm demain, aucune eau avant
  const prob = z(); prob[8] = 100;
  const d = decide({ weather: W(p, prob), arrosages: [], reglages: REG, today: TODAY });
  ck('sec longtemps + pluie sûre → FILET arrose', d.etat === 'arroser', d.etat);
  ck('  drapeau filet levé', d.filet === true);
  ck('  dryDays >= seuil', d.metrics.dryDays >= CONSTANTS.MAX_DRY_DAYS, String(d.metrics.dryDays));
}

// 4) Filet INACTIF si eau récente (dryDays < seuil) → la pluie sûre reprend la main.
{
  const p = z(); p[6] = 6; p[8] = 8; // eau hier
  const prob = z(); prob[8] = 100;
  const d = decide({ weather: W(p, prob), arrosages: [], reglages: REG, today: TODAY });
  ck('eau récente → filet inactif → pluie', d.etat === 'pluie', d.etat);
  ck('  pas de drapeau filet', !d.filet);
}

// 5) Probabilité MANQUANTE → repli à 100 % (pas de régression).
{
  const p = z(); p[6] = 6; p[8] = 8;
  const probMissing = Array(12).fill(undefined);
  const d = decide({ weather: W(p, probMissing), arrosages: [], reglages: REG, today: TODAY });
  ck('proba manquante → 100 % → pluie_48h = 8', d.metrics.pluie_48h === 8, String(d.metrics.pluie_48h));
  ck('  → la pluie s\'en charge', d.etat === 'pluie', d.etat);
}

// 6) Filet resserré en CANICULE (2 j au lieu de 3) : ET₀ élevé + 2 j sans eau + déficit → arrose malgré pluie.
{
  const p = z(); p[5] = 6; p[8] = 8;  // eau il y a 3 j (07-07), rien depuis ; pluie demain
  const prob = z(); prob[8] = 100;
  const et0 = z().map(() => 7);        // ET₀ ~7 mm/j → canicule
  const w = { ...W(p, prob), et0 };
  const d = decide({ weather: w, arrosages: [], reglages: { ...REG, kc: 0.8 }, today: TODAY });
  ck('canicule + 2 j sans eau → filet arrose', d.etat === 'arroser', d.etat + ' dry=' + d.metrics.dryDays + ' canic=' + d.metrics.canicule);
}

// 7) AVANT-DÉPART : pluie annoncée PENDANT l'absence mais PEU PROBABLE → ne supprime
// PAS l'arrosage avant départ (fenêtre non rattrapable). (fix audit HIGH)
{
  const p = z(); p[9] = 8;            // 8 mm le 07-11 (pendant l'absence)
  const prob = z(); prob[9] = 20;     // à 20 %
  const abs = [{ type: 'absence', debut: '2026-07-10', fin: '2026-07-12' }];
  const arr = [{ jour: '2026-07-08', minutes: 30, auteur: 'x' }]; // arrosage récent → base 'attends'
  const d = decide({ weather: W(p, prob), arrosages: arr, reglages: REG, today: TODAY, contraintes: abs });
  ck('absence + pluie peu probable → avant-depart (pas supprimé)', d.etat === 'avant-depart', d.etat);
}

// 8) Même absence mais pluie SÛRE et suffisante → on ne force pas l'arrosage avant départ.
{
  const p = z(); p[9] = 12;
  const prob = z(); prob[9] = 100;
  const abs = [{ type: 'absence', debut: '2026-07-10', fin: '2026-07-12' }];
  const arr = [{ jour: '2026-07-08', minutes: 30, auteur: 'x' }];
  const d = decide({ weather: W(p, prob), arrosages: arr, reglages: REG, today: TODAY, contraintes: abs });
  ck('absence + pluie sûre suffisante → pas d\'avant-depart', d.etat !== 'avant-depart', d.etat);
}

// 9) 2e session plafonnée à MAX_SESSION_MM (pas de 35 mm d'un coup). (fix audit LOW)
{
  const d = decide({ weather: W(z(), z()), arrosages: [], reglages: { objectif_mm: 60, objectif_manuel: true, debit_mm_h: 27 }, today: TODAY });
  ck('2e session plafonnée à ≤ 20 mm', d.etat === 'arroser' && d.deuxieme && d.deuxieme.mm <= 20, JSON.stringify(d.deuxieme));
}

// 10) débit ≤ 0 → repli au défaut, pas d'Infinity. (fix audit LOW)
{
  const d = decide({ weather: W(z(), z()), arrosages: [], reglages: { objectif_mm: 28, objectif_manuel: true, debit_mm_h: 0 }, today: TODAY });
  ck('débit 0 → pas d\'Infinity (repli)', Number.isFinite(d.minutes ?? 0) && d.metrics.reglages.debit_mm_h > 0, JSON.stringify({ min: d.minutes, debit: d.metrics.reglages.debit_mm_h }));
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
