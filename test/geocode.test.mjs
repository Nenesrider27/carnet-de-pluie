// Tests du module de géocodage — exécuter : node test/geocode.test.mjs
// AUCUN appel réseau réel : on MOCKE globalThis.fetch (et navigator au besoin).
// Même harnais maison que les autres tests (check + compteurs + exit code).
import {
  round4,
  geocodeAddress,
  geocodeAddressPrecise,
  reverseGeocode,
  currentPosition,
} from '../geocode.js';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// --- Utilitaires de mock ------------------------------------------------
// Fabrique une Response minimale (juste ce que le module consomme : ok/status/json).
function mockResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}
// Installe un faux fetch qui enregistre l'URL demandée et renvoie `response`.
// Retourne { calls } pour inspecter les URLs appelées.
function installFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  return { calls };
}
// Sauvegarde/restaure fetch et navigator autour de chaque bloc.
const ORIG_FETCH = globalThis.fetch;
const ORIG_NAV = globalThis.navigator;
function restore() {
  globalThis.fetch = ORIG_FETCH;
  // navigator : propriété parfois non configurable → on tente proprement.
  try { globalThis.navigator = ORIG_NAV; } catch { /* ignore */ }
}

console.log('\n=== GÉOCODAGE — TESTS (mock réseau, zéro appel réel) ===\n');

// -- round4 --------------------------------------------------------------
{
  check('round4 46.27772 → 46.2777', round4(46.27772) === 46.2777, String(round4(46.27772)));
  check('round4 6.22341 → 6.2234', round4(6.22341) === 6.2234, String(round4(6.22341)));
  check('round4 arrondit (46.27775 → 46.2778)', round4(46.27775) === 46.2778, String(round4(46.27775)));
  check('round4 accepte une string ("6.2234001")', round4('6.2234001') === 6.2234, String(round4('6.2234001')));
}

// -- geocodeAddress : parse une réponse Open-Meteo mockée ---------------
{
  const body = {
    results: [
      {
        name: 'Anières',
        latitude: 46.277720,
        longitude: 6.223410,
        timezone: 'Europe/Zurich',
        admin1: 'Genève',
        country: 'Suisse',
      },
      {
        name: 'Anières-le-Haut',
        latitude: 46.30,
        longitude: 6.24,
        timezone: 'Europe/Zurich',
        admin1: 'Genève',
        country: 'Suisse',
      },
    ],
  };
  const { calls } = installFetch(() => mockResponse(body));
  const out = await geocodeAddress('Anières');
  restore();

  check('geocodeAddress → tableau de 2', Array.isArray(out) && out.length === 2, JSON.stringify(out));
  check('geocodeAddress URL Open-Meteo + encodeURIComponent',
    calls[0]?.url.startsWith('https://geocoding-api.open-meteo.com/v1/search?name=Ani%C3%A8res') &&
    calls[0]?.url.includes('count=5') && calls[0]?.url.includes('language=fr'),
    calls[0]?.url);
  check('geocodeAddress label lisible « Anières, Genève, Suisse »',
    out[0].label === 'Anières, Genève, Suisse', out[0].label);
  check('geocodeAddress lat round4 (46.2777)', out[0].lat === 46.2777, String(out[0].lat));
  check('geocodeAddress lon round4 (6.2234)', out[0].lon === 6.2234, String(out[0].lon));
  check('geocodeAddress timezone conservé', out[0].timezone === 'Europe/Zurich', out[0].timezone);
  check('geocodeAddress admin = admin1', out[0].admin === 'Genève', out[0].admin);
  check('geocodeAddress country conservé', out[0].country === 'Suisse', out[0].country);
}

// -- geocodeAddress : label sans admin1 (parties vides retirées) --------
{
  const body = { results: [{ name: 'Nulle-part', latitude: 1, longitude: 2, country: 'Pays' }] };
  installFetch(() => mockResponse(body));
  const out = await geocodeAddress('x');
  restore();
  check('geocodeAddress label sans admin1 → « Nulle-part, Pays » (pas de virgule vide)',
    out[0].label === 'Nulle-part, Pays', out[0].label);
}

// -- geocodeAddress : réponse vide → [] ---------------------------------
{
  installFetch(() => mockResponse({})); // pas de champ results
  const out = await geocodeAddress('zzz introuvable');
  restore();
  check('geocodeAddress sans results → []', Array.isArray(out) && out.length === 0, JSON.stringify(out));

  installFetch(() => mockResponse({ results: [] })); // results vide
  const out2 = await geocodeAddress('zzz');
  restore();
  check('geocodeAddress results vide → []', Array.isArray(out2) && out2.length === 0, JSON.stringify(out2));
}

// -- geocodeAddress : HTTP non-ok → lève --------------------------------
{
  installFetch(() => mockResponse(null, { ok: false, status: 503 }));
  let threw = false, msg = '';
  try { await geocodeAddress('boom'); } catch (e) { threw = true; msg = e.message; }
  restore();
  check('geocodeAddress HTTP 503 → lève', threw, msg);
  check('geocodeAddress message d\'erreur contient le status', /503/.test(msg), msg);
}

// -- geocodeAddressPrecise : parse une réponse Nominatim mockée ---------
{
  const body = [
    { display_name: '12 Rue du Jardin, Anières, Genève, Suisse', lat: '46.278001', lon: '6.223999' },
    { display_name: 'Autre', lat: '46.30', lon: '6.24' },
  ];
  const { calls } = installFetch(() => mockResponse(body));
  const out = await geocodeAddressPrecise('12 Rue du Jardin, Anières');
  restore();

  check('geocodeAddressPrecise → tableau de 2', Array.isArray(out) && out.length === 2, JSON.stringify(out));
  check('geocodeAddressPrecise URL Nominatim /search',
    calls[0]?.url.startsWith('https://nominatim.openstreetmap.org/search?q=') &&
    calls[0]?.url.includes('format=jsonv2') && calls[0]?.url.includes('limit=5'),
    calls[0]?.url);
  check('geocodeAddressPrecise label = display_name',
    out[0].label === '12 Rue du Jardin, Anières, Genève, Suisse', out[0].label);
  check('geocodeAddressPrecise lat Number+round4 (46.278)', out[0].lat === 46.278, String(out[0].lat));
  check('geocodeAddressPrecise lon Number+round4 (6.224)', out[0].lon === 6.224, String(out[0].lon));
}

// -- geocodeAddressPrecise : HTTP non-ok → lève -------------------------
{
  installFetch(() => mockResponse(null, { ok: false, status: 429 }));
  let threw = false, msg = '';
  try { await geocodeAddressPrecise('boom'); } catch (e) { threw = true; msg = e.message; }
  restore();
  check('geocodeAddressPrecise HTTP 429 → lève', threw, msg);
}

// -- reverseGeocode : succès → { label } --------------------------------
{
  const body = { display_name: 'Anières, Genève, Suisse' };
  const { calls } = installFetch(() => mockResponse(body));
  const out = await reverseGeocode(46.2777, 6.2234);
  restore();
  check('reverseGeocode succès → { label }', out && out.label === 'Anières, Genève, Suisse', JSON.stringify(out));
  check('reverseGeocode URL /reverse + coords',
    calls[0]?.url.startsWith('https://nominatim.openstreetmap.org/reverse?lat=46.2777&lon=6.2234') &&
    calls[0]?.url.includes('zoom=14'),
    calls[0]?.url);
}

// -- reverseGeocode : échecs → null (best-effort, ne lève pas) ----------
{
  installFetch(() => mockResponse({}, { ok: false, status: 500 }));
  const outHttp = await reverseGeocode(1, 2); // HTTP non-ok
  restore();
  check('reverseGeocode HTTP non-ok → null', outHttp === null, JSON.stringify(outHttp));

  installFetch(() => mockResponse({})); // pas de display_name
  const outNoName = await reverseGeocode(1, 2);
  restore();
  check('reverseGeocode sans display_name → null', outNoName === null, JSON.stringify(outNoName));

  installFetch(() => { throw new Error('réseau coupé'); }); // panne réseau
  const outNet = await reverseGeocode(1, 2);
  restore();
  check('reverseGeocode panne réseau → null (ne lève pas)', outNet === null, JSON.stringify(outNet));
}

// -- currentPosition : succès → { lat, lon } arrondis -------------------
{
  globalThis.navigator = {
    geolocation: {
      getCurrentPosition: (ok, _err, opts) => {
        // On vérifie au passage que les options attendues sont transmises.
        globalThis.__opts = opts;
        ok({ coords: { latitude: 46.277721, longitude: 6.223412 } });
      },
    },
  };
  const out = await currentPosition();
  const opts = globalThis.__opts;
  restore();
  check('currentPosition succès → lat round4 (46.2777)', out.lat === 46.2777, String(out.lat));
  check('currentPosition succès → lon round4 (6.2234)', out.lon === 6.2234, String(out.lon));
  check('currentPosition options { enableHighAccuracy, timeout:10000, maximumAge:0 }',
    opts?.enableHighAccuracy === true && opts?.timeout === 10000 && opts?.maximumAge === 0,
    JSON.stringify(opts));
}

// -- currentPosition : code 1 (permission refusée) → rejette « Autorise »
{
  globalThis.navigator = {
    geolocation: {
      getCurrentPosition: (_ok, err) => { err({ code: 1 }); },
    },
  };
  let threw = false, msg = '';
  try { await currentPosition(); } catch (e) { threw = true; msg = e.message; }
  restore();
  check('currentPosition code 1 → rejette', threw, msg);
  check('currentPosition code 1 → message contient « Autorise »', /Autorise/.test(msg), msg);
}

// -- currentPosition : pas de navigator (contexte Node) → rejette proprement
{
  try { globalThis.navigator = undefined; } catch { /* ignore */ }
  let threw = false, msg = '';
  try { await currentPosition(); } catch (e) { threw = true; msg = e.message; }
  restore();
  check('currentPosition sans navigator → rejette proprement', threw, msg);
}

console.log('\n' + results.join('\n'));
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
