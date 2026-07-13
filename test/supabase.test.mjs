// test/supabase.test.mjs — tests unitaires de store.js (fetch MOCKÉ, zéro réseau).
// L'intégration RLS réelle (isolation entre domiciles, invitation, rôles) est
// validée séparément par supabase/rls_check.sql (simulation SQL en transaction
// annulée). Ici on vérifie que store.js construit les bonnes requêtes :
// filtrage par domicile_id, en-têtes d'auth injectés, RPC d'invitation.
import { configureStore, getArrosages, upsertArrosage, getContraintes, createDomicile,
  createInvitation, acceptInvitation, getMyDomiciles, patchDomicile } from '../store.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? ' → ' + d : '')); } };

// fetch mocké : enregistre chaque appel, renvoie une réponse OK générique.
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, headers: opts.headers || {}, method: opts.method || 'GET', body: opts.body });
  return { ok: true, status: 200, async json() { return [{ ok: true }]; }, async text() { return ''; } };
};

console.log('\n=== STORE.JS (unitaire, fetch mocké) ===\n');

// Provider d'auth simulé (navigateur : JWT).
configureStore(async () => ({ apikey: 'PUB', Authorization: 'Bearer JWT123' }));

// getArrosages : filtre domicile_id + en-têtes d'auth.
calls = []; await getArrosages('DOM1');
check('getArrosages filtre domicile_id', calls[0].url.includes('domicile_id=eq.DOM1'), calls[0].url);
check('getArrosages envoie apikey publishable', calls[0].headers.apikey === 'PUB');
check('getArrosages envoie Bearer JWT (RLS)', calls[0].headers.Authorization === 'Bearer JWT123');

// upsertArrosage : on_conflict (domicile,jour) + body contient domicile_id.
calls = []; await upsertArrosage({ domicileId: 'DOM1', jour: '2020-01-01', minutes: 20, auteur: 'X' });
check('upsert on_conflict=domicile_id,jour', calls[0].url.includes('on_conflict=domicile_id,jour'), calls[0].url);
const b1 = JSON.parse(calls[0].body);
check('upsert body a domicile_id + minutes', b1.domicile_id === 'DOM1' && b1.minutes === 20);
check('upsert Prefer merge-duplicates', String(calls[0].headers.Prefer || '').includes('merge-duplicates'));

// getContraintes : filtre domicile_id.
calls = []; await getContraintes('DOM2');
check('getContraintes filtre domicile_id', calls[0].url.includes('domicile_id=eq.DOM2'));

// createDomicile : owner_id + coordonnées dans le body.
calls = []; await createDomicile({ ownerId: 'U1', nom: 'Test', lat: 1.23, lon: 4.56, timezone: 'Europe/Paris' });
const b2 = JSON.parse(calls[0].body);
check('createDomicile envoie owner_id', b2.owner_id === 'U1');
check('createDomicile envoie lat/lon/timezone', b2.lat === 1.23 && b2.lon === 4.56 && b2.timezone === 'Europe/Paris');

// patchDomicile : cible le bon id.
calls = []; await patchDomicile('DOM1', { debit_mm_h: 30 });
check('patchDomicile cible id=eq.DOM1', calls[0].url.includes('id=eq.DOM1') && calls[0].method === 'PATCH');

// createInvitation : body domicile_id + role.
calls = []; await createInvitation('DOM1', 'member');
const b3 = JSON.parse(calls[0].body);
check('createInvitation body domicile_id+role', b3.domicile_id === 'DOM1' && b3.role === 'member');

// acceptInvitation : appelle la RPC avec _token.
calls = []; await acceptInvitation('TOK');
check('acceptInvitation appelle /rpc/accept_invitation', calls[0].url.includes('/rpc/accept_invitation'));
check('acceptInvitation passe _token', JSON.parse(calls[0].body)._token === 'TOK');

// getMyDomiciles : jointure membership + filtre user.
calls = []; await getMyDomiciles('U1');
check('getMyDomiciles jointure !inner', calls[0].url.includes('domicile_members!inner'));
check('getMyDomiciles filtre user_id', calls[0].url.includes('domicile_members.user_id=eq.U1'));

// Provider serveur (clé secrète, PAS de Bearer).
configureStore(async () => ({ apikey: 'SECRET' }));
calls = []; await getArrosages('DOM1');
check('mode serveur : apikey secrète', calls[0].headers.apikey === 'SECRET');
check('mode serveur : pas de Bearer', !calls[0].headers.Authorization);

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
