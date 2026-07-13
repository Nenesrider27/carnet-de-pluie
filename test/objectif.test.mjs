// Tests de l'objectif dynamique ET₀ — node test/objectif.test.mjs
import { decide, computeObjectif } from '../engine.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' → ' + d : ''}`); } };

const TIMES = ['2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11','2026-07-12','2026-07-13','2026-07-14','2026-07-15','2026-07-16','2026-07-17'];
const TODAY = '2026-07-13'; // idx 7
const zeros = () => Array(12).fill(0);
const W = (et0val, precip) => ({ time: TIMES, precipitation_sum: precip || zeros(), precipitation_probability_max: zeros(), et0: et0val == null ? undefined : Array(12).fill(et0val) });
const REG = { objectif_mm: 28, debit_mm_h: 27, kc: 0.8 };

console.log('\n=== OBJECTIF DYNAMIQUE (ET₀) ===\n');

// 1. Canicule ET₀ 7 mm/j → objectif ~39, canicule, espacement resserré
{
  const o = computeObjectif({ weather: W(7), reglages: REG, today: TODAY });
  console.log(`Canicule ET0 7 : objectif=${o.objectif}, source=${o.source}, canicule=${o.canicule}, Σ7j=${o.et0_7j}, mean3=${o.et0_mean3}`);
  ck('ET₀ 7 → objectif 39 (Σ49 × 0.8)', o.objectif === 39, String(o.objectif));
  ck('ET₀ 7 → canicule true', o.canicule === true);
  ck('ET₀ 7 → source et0', o.source === 'et0');
}

// 2. Temps frais ET₀ 2.5 → 14 → borné à 15
{
  const o = computeObjectif({ weather: W(2.5), reglages: REG, today: TODAY });
  console.log(`Frais ET0 2.5  : objectif=${o.objectif}, canicule=${o.canicule}`);
  ck('ET₀ 2.5 → objectif borné à 15 (calcul 14)', o.objectif === 15, String(o.objectif));
  ck('ET₀ 2.5 → pas canicule', o.canicule === false);
}

// 3. ET₀ absente → fallback 28
{
  const o = computeObjectif({ weather: W(null), reglages: REG, today: TODAY });
  console.log(`ET0 absente    : objectif=${o.objectif}, source=${o.source}`);
  ck('ET₀ absente → objectif 28', o.objectif === 28);
  ck('ET₀ absente → source fallback', o.source === 'fallback');
}

// 3b. ET₀ incomplète (un null dans la fenêtre) → fallback
{
  const et0 = Array(12).fill(6); et0[7] = null; // aujourd'hui null
  const o = computeObjectif({ weather: { time: TIMES, precipitation_sum: zeros(), et0 }, reglages: REG, today: TODAY });
  ck('ET₀ incomplète → fallback 28', o.objectif === 28 && o.source === 'fallback', `${o.objectif}/${o.source}`);
}

// 4. Mode manuel → ignore le calcul dynamique
{
  const o = computeObjectif({ weather: W(7), reglages: { ...REG, objectif_manuel: true, objectif_mm: 40 }, today: TODAY });
  console.log(`Manuel (40)    : objectif=${o.objectif}, source=${o.source}, canicule=${o.canicule}`);
  ck('manuel → objectif 40 (calcul ignoré)', o.objectif === 40 && o.source === 'manuel');
  ck('manuel garde l\'info canicule', o.canicule === true);
}

// 5. Kc custom
{
  const o = computeObjectif({ weather: W(5), reglages: { ...REG, kc: 1.0 }, today: TODAY });
  ck('Kc 1.0, ET₀ 5 → objectif 35 (Σ35 × 1.0)', o.objectif === 35, String(o.objectif));
}

console.log('\n=== BASCULES CANICULE (via decide) ===\n');

// 6. Espacement resserré : arrosé il y a 2 j
{
  const arros = [{ jour: '2026-07-11', minutes: 30, auteur: 'Papa' }]; // 30min=13.5mm signif, il y a 2 j
  const dCan = decide({ weather: W(7), arrosages: arros, reglages: REG, today: TODAY });
  const dNorm = decide({ weather: W(4), arrosages: arros, reglages: REG, today: TODAY });
  console.log(`Arrosé J-2 : canicule→${dCan.etat}, normal→${dNorm.etat}`);
  ck('canicule (spacing 2) : J-2 ne bloque plus → arroser', dCan.etat === 'arroser', dCan.etat);
  ck('normal (spacing 3) : J-2 → attends', dNorm.etat === 'attends', dNorm.etat);
}

// 7. Seuil MIN abaissé : déficit 9 (objectif manuel pour isoler)
{
  const dCan = decide({ weather: W(7), arrosages: [], reglages: { ...REG, objectif_manuel: true, objectif_mm: 9 }, today: TODAY });
  const dNorm = decide({ weather: W(4), arrosages: [], reglages: { ...REG, objectif_manuel: true, objectif_mm: 9 }, today: TODAY });
  console.log(`Déficit 9 : canicule→${dCan.etat}, normal→${dNorm.etat}`);
  ck('canicule (MIN 8) : déficit 9 → arroser', dCan.etat === 'arroser', dCan.etat);
  ck('normal (MIN 10) : déficit 9 → presque', dNorm.etat === 'presque', dNorm.etat);
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
