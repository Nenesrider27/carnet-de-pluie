// scripts/morning-push.mjs — rappel matinal (GitHub Actions).
// Réutilise LE MÊME engine.js que la page : aucune logique de décision dupliquée.
// Le workflow tourne à 4h30 ET 5h30 UTC ; le script ne fait quelque chose que si
// l'heure locale Europe/Zurich est 6h (gère été/hiver sans magie). FORCE=1 bypass.
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';
import { decide, findTodayIdx, round1 } from '../engine.js';
import { configureStore, getAllDomiciles, getArrosages, getContraintes, getSubscriptions, deleteSubscription } from '../store.js';
import { fetchWeatherData } from '../weather.js';
import { VAPID_PUBLIC } from '../config.js';

// Serveur : la RLS est fermée → on lit avec la clé SECRÈTE (service_role, secret
// GitHub Actions SB_SECRET). Les nouvelles clés vont UNIQUEMENT dans `apikey`
// (jamais en Authorization: Bearer, sinon la plateforme la rejette).
const SB_SECRET = process.env.SB_SECRET;
configureStore(async () => ({ apikey: SB_SECRET }));

// Heure / date locale d'un domicile (chaque domicile a son fuseau).
function localHour(tz, d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(d));
}
function localToday(tz, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// --- Décision → notification (PURE, testable) --------------------------
// Renvoie { push, title, body, etat }. Notifie pour ARROSER et AVANT-DEPART,
// et pour PLUIE seulement si un arrosage aurait été dû sans la pluie.
// ABSENT → silence (on ne pousse pas « arrose » à quelqu'un qui n'est pas là).
export function planNotification({ weather, arrosages, reglages, today, contraintes }) {
  const d = decide({ weather, arrosages, reglages, today, contraintes });
  const m = d.metrics;

  if (d.etat === 'arroser') {
    return {
      push: true, etat: 'arroser',
      title: `💧 Arrose ~${d.minutes} min ce matin`,
      body: `Il manque ${round1(m.deficit)} mm pour l'objectif. Arrose tôt, tant qu'il fait frais.`,
    };
  }

  if (d.etat === 'avant-depart') {
    return {
      push: true, etat: 'avant-depart',
      title: `🧳 Arrose ~${d.minutes} min avant de partir`,
      body: `Personne au jardin pendant ton absence et pas de pluie prévue (déficit ~${round1(d.deficitFin)} mm au retour).`,
    };
  }

  if (d.etat === 'pluie') {
    // La pluie couvre-t-elle un besoin réel ? On rejoue sans la pluie des 48 h.
    const idx = findTodayIdx(weather.time, today);
    const precip = [...weather.precipitation_sum];
    if (idx >= 0) { precip[idx + 1] = 0; precip[idx + 2] = 0; }
    const shadow = decide({ weather: { ...weather, precipitation_sum: precip }, arrosages, reglages, today, contraintes });
    if (shadow.etat === 'arroser' || shadow.etat === 'avant-depart') {
      return {
        push: true, etat: 'pluie',
        title: '🌧️ La pluie s\'en charge',
        body: `Pas besoin d'arroser aujourd'hui : ${round1(m.pluie_48h)} mm attendus sous 48 h.`,
      };
    }
  }

  // rien / attends / presque / fait / absent / pluie-sans-besoin → aucun push
  return { push: false, etat: d.etat };
}


async function main() {
  const force = process.env.FORCE === '1';

  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) throw new Error('VAPID_PRIVATE_KEY manquant (secret GitHub Actions).');
  if (!SB_SECRET) throw new Error('SB_SECRET manquant (clé service_role, secret GitHub Actions).');
  if (!VAPID_PUBLIC || VAPID_PUBLIC.startsWith('COLLE_')) throw new Error('VAPID_PUBLIC non renseigné dans config.js.');
  webpush.setVapidDetails('mailto:ernestchapl27@gmail.com', VAPID_PUBLIC, priv);

  // Tous les domiciles + tous les abonnements (clé secrète, bypass RLS), groupés.
  const domiciles = await getAllDomiciles();
  const allSubs = await getSubscriptions();
  const subsByDom = {};
  for (const s of allSubs) { if (s.domicile_id) (subsByDom[s.domicile_id] ||= []).push(s); }
  console.log(`${domiciles.length} domicile(s), ${allSubs.length} abonnement(s).`);

  let totalSent = 0, totalCleaned = 0;
  for (const dm of domiciles) {
    const tz = dm.timezone || 'Europe/Zurich';
    const h = localHour(tz);
    // Rappel à 6h LOCALE de chaque domicile (le cron tourne à 4h30/5h30 UTC).
    if (!force && h !== 6) { console.log(`[${dm.nom}] ${h}h local ≠ 6h → skip`); continue; }

    const today = localToday(tz);
    // Réglages du domicile (kc, objectif_manuel inclus) → même objectif que la page.
    const reg = {
      objectif_mm: Number(dm.objectif_mm),
      debit_mm_h: Number(dm.debit_mm_h),
      kc: dm.kc != null ? Number(dm.kc) : undefined,
      objectif_manuel: dm.objectif_manuel === true,
    };

    let weather, arrosages, contraintes;
    try {
      [weather, arrosages, contraintes] = await Promise.all([
        fetchWeatherData({ lat: dm.lat, lon: dm.lon, tz }),
        getArrosages(dm.id), getContraintes(dm.id),
      ]);
    } catch (e) { console.warn(`[${dm.nom}] données indisponibles : ${e.message}`); continue; }

    const plan = planNotification({ weather, arrosages, reglages: reg, today, contraintes });
    console.log(`[${dm.nom}] état=${plan.etat} push=${plan.push ? 'OUI' : 'non'}`);
    if (!plan.push) continue;

    const subs = subsByDom[dm.id] || [];
    const payload = JSON.stringify({ title: plan.title, body: plan.body });
    for (const row of subs) {
      try {
        await webpush.sendNotification(row.subscription, payload, { TTL: 3600, urgency: 'high' });
        totalSent++;
      } catch (e) {
        const code = e.statusCode;
        if (code === 404 || code === 410) {
          await deleteSubscription(row.endpoint).catch(() => {});
          totalCleaned++;
          console.log(`[${dm.nom}] abonnement mort (${code}) supprimé : ${row.auteur || '?'}`);
        } else {
          console.warn(`[${dm.nom}] échec push (${code}) pour ${row.auteur || '?'} : ${e.message}`);
        }
      }
    }
  }
  console.log(`Terminé : ${totalSent} envoyé(s), ${totalCleaned} nettoyé(s).`);
}

// N'exécute main() que lancé directement (pas à l'import pour les tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
}
