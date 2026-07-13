// scripts/morning-push.mjs — rappel matinal (GitHub Actions).
// Réutilise LE MÊME engine.js que la page : aucune logique de décision dupliquée.
// Le workflow tourne à 4h30 ET 5h30 UTC ; le script ne fait quelque chose que si
// l'heure locale Europe/Zurich est 6h (gère été/hiver sans magie). FORCE=1 bypass.
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';
import { decide, findTodayIdx, round1 } from '../engine.js';
import { getArrosages, getReglages, getContraintes, getSubscriptions, deleteSubscription } from '../store.js';
import { fetchWeatherData } from '../weather.js';
import { VAPID_PUBLIC } from '../config.js';


function zurichHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(d));
}
function zurichToday(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
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
  const h = zurichHour();
  if (!force && h !== 6) {
    console.log(`Heure locale Zurich = ${h}h ≠ 6h → rien à faire (l'autre créneau cron s'en chargera).`);
    return;
  }

  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) throw new Error('VAPID_PRIVATE_KEY manquant (secret GitHub Actions).');
  if (!VAPID_PUBLIC || VAPID_PUBLIC.startsWith('COLLE_')) throw new Error('VAPID_PUBLIC non renseigné dans config.js.');
  webpush.setVapidDetails('mailto:ernestchapl27@gmail.com', VAPID_PUBLIC, priv);

  const today = zurichToday();
  const [weather, arrosages, reglages, contraintes] = await Promise.all([
    fetchWeatherData(), getArrosages(), getReglages(), getContraintes(),
  ]);
  // ⚠️ Garder TOUS les réglages (kc, objectif_manuel inclus) : le push doit
  // calculer exactement le même objectif que la page (une seule logique).
  const reg = reglages ? {
    objectif_mm: Number(reglages.objectif_mm),
    debit_mm_h: Number(reglages.debit_mm_h),
    kc: reglages.kc != null ? Number(reglages.kc) : undefined,
    objectif_manuel: reglages.objectif_manuel === true,
  } : undefined;

  const plan = planNotification({ weather, arrosages, reglages: reg, today, contraintes });
  console.log(`État du jour : ${plan.etat} — push : ${plan.push ? 'OUI' : 'non'}`);
  if (!plan.push) return;

  const subs = await getSubscriptions();
  console.log(`${subs.length} abonnement(s) à notifier.`);
  const payload = JSON.stringify({ title: plan.title, body: plan.body });

  let sent = 0, cleaned = 0;
  for (const row of subs) {
    try {
      await webpush.sendNotification(row.subscription, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = e.statusCode;
      if (code === 404 || code === 410) {
        await deleteSubscription(row.endpoint).catch(() => {});
        cleaned++;
        console.log(`Abonnement mort (${code}) supprimé : ${row.auteur || '?'}`);
      } else {
        console.warn(`Échec push (${code}) pour ${row.auteur || '?'} : ${e.message}`);
      }
    }
  }
  console.log(`Terminé : ${sent} envoyé(s), ${cleaned} nettoyé(s).`);
}

// N'exécute main() que lancé directement (pas à l'import pour les tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
}
