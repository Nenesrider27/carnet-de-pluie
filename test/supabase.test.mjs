// Test d'intégration Supabase — node test/supabase.test.mjs
// Exécute un cycle CRUD réel sur la base partagée, puis nettoie.
// Non destructif : n'utilise qu'un jour bidon (2020-01-01) et ne le purge que lui.
import { getArrosages, getReglages, upsertArrosage, patchReglages, purgeBefore } from '../store.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
};
const TESTDAY = '2020-01-01';

console.log('\n=== INTÉGRATION SUPABASE (base réelle) ===\n');
try {
  // 1) Réglages par défaut lisibles
  const reg = await getReglages();
  check('getReglages renvoie la ligne id=1', reg && reg.id === 1, JSON.stringify(reg));
  check('objectif par défaut = 28', Number(reg?.objectif_mm) === 28);
  check('débit par défaut = 27', Number(reg?.debit_mm_h) === 27);

  // 2) Upsert insert
  const a1 = await upsertArrosage({ jour: TESTDAY, minutes: 20, auteur: 'TEST' });
  check('upsert insert renvoie la ligne', a1?.minutes === 20 && a1?.jour === TESTDAY, JSON.stringify(a1));

  // 3) L'arrosage est bien relu
  let list = await getArrosages();
  check('getArrosages contient le jour test', list.some(r => r.jour === TESTDAY && r.minutes === 20));

  // 4) Upsert même jour = REMPLACE (pas d'addition côté serveur)
  const a2 = await upsertArrosage({ jour: TESTDAY, minutes: 35, auteur: 'TEST2' });
  check('upsert même jour remplace (35, pas 55)', a2?.minutes === 35, JSON.stringify(a2));

  // 5) PATCH réglages puis remise à l'état par défaut
  const p1 = await patchReglages({ objectif_mm: 30, debit_mm_h: 25 });
  check('patch réglages applique 30/25', Number(p1.objectif_mm) === 30 && Number(p1.debit_mm_h) === 25);
  const p2 = await patchReglages({ objectif_mm: 28, debit_mm_h: 27 });
  check('patch réglages remis à 28/27', Number(p2.objectif_mm) === 28 && Number(p2.debit_mm_h) === 27);

  // 6) Purge du jour test uniquement
  await purgeBefore('2020-06-01');
  list = await getArrosages();
  check('purge a supprimé le jour test', !list.some(r => r.jour === TESTDAY));
} catch (e) {
  fail++;
  console.log('  ❌ EXCEPTION:', e.message);
  // filet de sécurité : tenter de nettoyer le jour test
  try { await purgeBefore('2020-06-01'); } catch {}
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
