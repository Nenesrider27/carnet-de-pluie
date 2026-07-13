// test/weather.test.mjs — choix du modèle météo par coordonnées (pur, zéro réseau).
// Régression : best_match sur-estimait la pluie en Suisse (20 mm vus alors que
// MétéoSuisse, avec radar local, disait 0.1 mm réel). On force le modèle national.
import { pickModel } from '../weather.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n)); };

console.log('\n=== WEATHER — choix du modèle par pays ===\n');
check('Anières → MétéoSuisse', pickModel(46.2857, 6.236) === 'meteoswiss_icon_ch2');
check('Genève centre → MétéoSuisse', pickModel(46.20, 6.15) === 'meteoswiss_icon_ch2');
check('Zurich → MétéoSuisse', pickModel(47.37, 8.54) === 'meteoswiss_icon_ch2');
check('Loix / Île de Ré → Météo-France', pickModel(46.2257, -1.4336) === 'meteofrance_seamless');
check('Paris → Météo-France', pickModel(48.85, 2.35) === 'meteofrance_seamless');
check('New York → best_match', pickModel(40.7, -74.0) === 'best_match');
check('Tokyo → best_match', pickModel(35.7, 139.7) === 'best_match');

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
