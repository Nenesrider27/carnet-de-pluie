// app.js — couche présentation.
// La LOGIQUE d'arrosage vit dans engine.js ; l'ACCÈS partagé dans store.js.
// Ici : orchestration, cache localStorage (offline + affichage instantané), DOM.
import { decide, DEFAULTS, CONSTANTS, addDays } from './engine.js';
import { getArrosages, getReglages, upsertArrosage, patchReglages, purgeBefore, upsertSubscription } from './store.js';
import { VAPID_PUBLIC } from './config.js';

// --- Config météo ------------------------------------------------------
const LAT = 46.2777, LON = 6.2234;
const API_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&daily=precipitation_sum,precipitation_probability_max` +
  `&timezone=Europe%2FZurich&past_days=7&forecast_days=5&models=meteoswiss_icon_ch2`;

const LS = {
  weather: 'cp.weather',      // { data, ts }
  arrosages: 'cp.arrosages',  // [{ jour, minutes, auteur, updated_at }]  (cache de Supabase)
  reglages: 'cp.reglages',    // { objectif_mm, debit_mm_h }             (cache de Supabase)
  prenom: 'cp.prenom',        // string (identité LOCALE de l'appareil)
};

// --- Utilitaires -------------------------------------------------------
const $ = (id) => document.getElementById(id);
const readLS = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function todayZurich() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
const fmtLong = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(isoToDate(iso));
const fmtShort = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(isoToDate(iso));
const fmtWeekday = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(isoToDate(iso));
const round1 = (n) => Math.round(n * 10) / 10;
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`;
}

// --- État applicatif ---------------------------------------------------
let weather = null, weatherTs = null, weatherOffline = false;
let arrosages = [];               // source : Supabase (cache localStorage)
let reglages = { ...DEFAULTS };   // source : Supabase (cache localStorage)
let dataTs = null, dataOffline = false;
let lastFailedSave = null;        // { date, min } pour le bouton « Réessayer »

const getPrenom = () => readLS(LS.prenom, '') || '';

// --- Chargement des données -------------------------------------------
function loadCache() {
  const ca = readLS(LS.arrosages, null); if (Array.isArray(ca)) arrosages = ca;
  const cr = readLS(LS.reglages, null); if (cr) reglages = { ...DEFAULTS, ...cr };
  const cw = readLS(LS.weather, null); if (cw?.data) { weather = cw.data; weatherTs = cw.ts; }
}

async function loadWeather() {
  try {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data?.daily?.time?.length) throw new Error('réponse météo vide');
    weather = {
      time: data.daily.time,
      precipitation_sum: data.daily.precipitation_sum,
      precipitation_probability_max: data.daily.precipitation_probability_max,
    };
    weatherTs = Date.now();
    weatherOffline = false;
    writeLS(LS.weather, { data: weather, ts: weatherTs });
  } catch (e) {
    weatherOffline = true;
    console.warn('[météo] fetch échoué :', e.message);
  }
}

// Supabase = source de vérité. Purge 14 j (best-effort), puis lit réglages + arrosages.
async function syncData() {
  const today = todayZurich();
  try {
    purgeBefore(addDays(today, -14)).catch((e) => console.warn('[purge]', e.message));
    const [reg, arr] = await Promise.all([getReglages(), getArrosages()]);
    if (reg) {
      reglages = { objectif_mm: Number(reg.objectif_mm), debit_mm_h: Number(reg.debit_mm_h) };
      writeLS(LS.reglages, reglages);
    }
    arrosages = Array.isArray(arr) ? arr : [];
    writeLS(LS.arrosages, arrosages);
    dataTs = Date.now();
    dataOffline = false;
  } catch (e) {
    dataOffline = true;
    console.warn('[supabase] sync échoué :', e.message);
  }
}

// --- Rendu -------------------------------------------------------------
const ICONS = { arroser: '💧', presque: '🌱', attends: '⏳', fait: '✅', rien: '✅', pluie: '🌧️', erreur: '⚠️' };

function render() {
  const today = todayZurich();
  $('dateToday').textContent = cap(fmtLong(today));

  const nOff = $('notice-offline'); nOff.classList.remove('show');
  $('notice-error').classList.remove('show');

  if (!weather) {
    renderVerdictError('Météo indisponible', 'Vérifie ta connexion, puis rouvre l\'app.', 'Aucune donnée météo — impossible de calculer une recommandation.');
    $('week-line').textContent = '';
  } else {
    if (weatherOffline && weatherTs) {
      nOff.textContent = `Hors ligne — météo du ${new Date(weatherTs).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}`;
      nOff.classList.add('show');
    }
    const decision = decide({ weather, arrosages, reglages, today });
    if (decision.etat === 'erreur') {
      renderVerdictError('Météo incomplète', 'La date du jour est absente des données.', 'Impossible de situer aujourd\'hui dans les prévisions.');
      $('week-line').textContent = '';
    } else {
      renderVerdict(decision, reglages);
      renderWeekLine(decision);
    }
  }
  renderLog();
  renderGauge();
  renderStatus();
  renderSyncNote();
}

function setState(cls) { $('verdict').className = 'verdict ' + cls; }

function renderVerdictError(title, subtitle, why) {
  setState('state-erreur');
  $('v-icon').textContent = ICONS.erreur;
  $('v-title').textContent = title;
  $('v-subtitle').textContent = subtitle;
  $('v-why').textContent = why;
  $('v-readout').innerHTML = '';
  $('v-tip').hidden = true;
  $('v-second').hidden = true;
}

function renderVerdict(d, reg) {
  const m = d.metrics;
  setState('state-' + d.etat);
  $('v-icon').textContent = ICONS[d.etat] || '💧';
  $('v-tip').hidden = d.etat !== 'arroser';
  $('v-second').hidden = true;

  let title = '', subtitle = '', why = '';
  if (d.etat === 'arroser') {
    title = `Arroser <span class="acc--big">${d.minutes} min</span>`;
    subtitle = `Session de ${round1(d.session_mm)} mm, au débit de ${reg.debit_mm_h} mm/h.`;
    why = `Il manque ${round1(m.deficit)} mm pour l'objectif de ${reg.objectif_mm} mm cette semaine.`;
    if (d.deuxieme) {
      $('v-second').hidden = false;
      $('v-second').textContent = `↳ puis ~${d.deuxieme.minutes} min vers ${fmtShort(d.deuxieme.jour)} (déficit > ${CONSTANTS.MAX_SESSION_MM} mm, on fractionne).`;
    }
  } else if (d.etat === 'presque') {
    title = 'Presque bon';
    subtitle = `Déficit de ${round1(m.deficit)} mm.`;
    why = `Sous le seuil de ${CONSTANTS.MIN_SESSION_MM} mm pour une session utile — attends 1 à 2 jours.`;
  } else if (d.etat === 'attends') {
    title = `Attends <span class="acc--big">${fmtWeekday(d.prochainJour)}</span>`;
    const dj = fmtShort(d.prochainJour);
    subtitle = `Prochaine session ~${d.minutesProchaine} min le ${dj}${dj.endsWith('.') ? '' : '.'}`;
    const j = m.lastSignif.daysAgo;
    why = `Arrosé il y a ${j} jour${j > 1 ? 's' : ''} — le sol doit sécher en surface (~${CONSTANTS.SPACING_DAYS} j) pour forcer les racines à descendre.`;
  } else if (d.etat === 'fait') {
    title = 'C\'est fait';
    subtitle = 'Pour aujourd\'hui, le jardin est servi.';
    why = 'Tu as déjà arrosé aujourd\'hui. Laisse le sol travailler.';
  } else if (d.etat === 'rien') {
    title = 'Rien à faire';
    subtitle = 'Le jardin a ce qu\'il lui faut.';
    why = `Pluie et arrosages couvrent l'objectif de ${reg.objectif_mm} mm. Rien à ajouter.`;
  } else if (d.etat === 'pluie') {
    title = 'La pluie s\'en charge';
    subtitle = `${round1(m.pluie_48h)} mm attendus sous 48 h.`;
    why = 'Inutile d\'arroser juste avant une pluie annoncée. Recontrôle après.';
  }
  $('v-title').innerHTML = title;
  $('v-subtitle').textContent = subtitle;
  $('v-why').textContent = why;
  $('v-readout').innerHTML =
    `<span>Tombé 7j <b>${round1(m.pluie_recue)} mm</b></span>` +
    `<span>Prévu 3j <b>${round1(m.pluie_prevue)} mm</b></span>` +
    `<span>Arrosé <b>${round1(m.arrose_mm)} mm</b></span>` +
    `<span>Déficit <b>${round1(m.deficit)} mm</b></span>`;
}

function renderWeekLine(d) {
  const m = d.metrics;
  $('week-line').innerHTML = `Cette semaine : <b>${m.minutes7} min</b> arrosés (~${round1(m.arrose_mm)} mm).`;
}

function renderLog() {
  const rows = [...arrosages].sort((a, b) => (a.jour < b.jour ? 1 : -1));
  const ul = $('log-list');
  if (rows.length === 0) {
    ul.innerHTML = '<li class="log-empty">Aucun arrosage enregistré.</li>';
    return;
  }
  ul.innerHTML = rows.map((r) => {
    const who = r.auteur ? ` <span class="who">(${escapeHtml(r.auteur)})</span>` : '';
    return `<li><span class="day">${cap(fmtShort(r.jour))}</span><span class="amt">${r.minutes} min${who}</span></li>`;
  }).join('');
}

function renderGauge() {
  const g = $('gauge');
  if (!weather) { g.innerHTML = ''; return; }
  const today = todayZurich();
  const times = weather.time;
  const precip = weather.precipitation_sum || [];
  const probs = weather.precipitation_probability_max || [];
  const todayIdx = times.indexOf(today);
  const maxP = Math.max(...precip.filter((x) => typeof x === 'number'), 0);
  const scale = Math.max(maxP, 10);

  g.innerHTML = times.map((iso, i) => {
    const p = typeof precip[i] === 'number' ? precip[i] : null;
    const isToday = i === todayIdx;
    const isFore = todayIdx !== -1 ? i > todayIdx : false;
    let cls = 'bar';
    if (isToday) cls += ' today'; else if (isFore) cls += ' fore'; else cls += ' past';
    if (p !== null && p <= 0) cls += ' dry';
    const hPct = p && p > 0 ? Math.max(6, (p / scale) * 100) : 2;
    const valTxt = p && p > 0 ? `${round1(p)}` : '';
    const probTxt = (isFore || isToday) && typeof probs[i] === 'number' && probs[i] > 0 ? `${probs[i]}%` : '';
    const d = isoToDate(iso);
    const wd = new Intl.DateTimeFormat('fr-FR', { weekday: 'narrow', timeZone: 'UTC' }).format(d);
    return `<div class="${cls}" title="${cap(fmtShort(iso))} : ${p === null ? 'n/d' : round1(p) + ' mm'}">
      <span class="val">${valTxt}</span><span class="prob">${probTxt}</span>
      <span class="stem" style="height:${hPct}%"></span>
      <span class="lbl">${wd}<br>${d.getUTCDate()}</span></div>`;
  }).join('');
}

function renderStatus() {
  const parts = [];
  if (weatherTs) parts.push(`météo ${ago(weatherTs)}`);
  if (dataOffline) parts.push('historique hors ligne');
  else if (dataTs) parts.push(`synchro ${ago(dataTs)}`);
  $('synced').textContent = parts.length ? parts.join('  ·  ') : '';
}

// Ligne « [Prénom] a arrosé N min » quand l'AUTRE a arrosé récemment (synchro visible light).
function renderSyncNote() {
  const el = $('sync-note'); if (!el) return;
  const me = getPrenom();
  const today = todayZurich();
  const recent = [...arrosages]
    .filter((r) => r.auteur && r.auteur !== me && (r.jour === today || r.jour === addDays(today, -1)))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  if (!recent) { el.hidden = true; return; }
  const quand = recent.jour === today ? 'aujourd\'hui' : 'hier';
  el.textContent = `👩‍🌾 ${recent.auteur} a arrosé ${recent.minutes} min ${quand}.`;
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Enregistrer un arrosage (Supabase, échec honnête) ----------------
async function saveArrosage() {
  const fb = $('save-feedback');
  fb.className = 'save-feedback';
  const date = $('in-date').value;
  const min = parseInt($('in-min').value, 10);
  const today = todayZurich();

  if (!date) return failSave('Choisis un jour.');
  if (date > today) return failSave('Pas de date future.');
  if (!Number.isFinite(min) || min <= 0) return failSave('Entre un nombre de minutes valide.');

  const existing = arrosages.find((r) => r.jour === date);
  const total = (existing?.minutes || 0) + min;
  const prenom = getPrenom();

  const btn = $('btn-save');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Envoi…';
  fb.className = 'save-feedback'; fb.textContent = '';
  try {
    const row = await upsertArrosage({ jour: date, minutes: total, auteur: prenom });
    arrosages = arrosages.filter((r) => r.jour !== date).concat(row);
    writeLS(LS.arrosages, arrosages);
    dataTs = Date.now(); dataOffline = false;
    lastFailedSave = null;
    $('in-min').value = '';
    fb.className = 'save-feedback ok';
    fb.textContent = existing
      ? `✓ Ajouté. ${cap(fmtShort(date))} : ${total} min au total.`
      : `✓ Enregistré. ${cap(fmtShort(date))} : ${min} min.`;
    render();
  } catch (e) {
    console.warn('[save] échec :', e.message);
    lastFailedSave = { date, min };
    fb.className = 'save-feedback err';
    fb.innerHTML = 'Échec de l\'enregistrement (hors ligne ?). Rien n\'a été sauvegardé. ';
    const retry = document.createElement('button');
    retry.className = 'retry'; retry.textContent = 'Réessayer';
    retry.addEventListener('click', retrySave);
    fb.appendChild(retry);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function failSave(msg) {
  const fb = $('save-feedback');
  fb.className = 'save-feedback err';
  fb.textContent = msg;
}

// Réessai idempotent : on recalcule le total depuis l'état courant (l'upsert
// merge-duplicates remplace, donc rejouer ne double jamais).
function retrySave() {
  if (!lastFailedSave) return;
  $('in-date').value = lastFailedSave.date;
  $('in-min').value = lastFailedSave.min;
  saveArrosage();
}

// --- Réglages ----------------------------------------------------------
async function saveReglages() {
  const fb = $('reglages-feedback');
  const obj = parseFloat($('in-obj').value);
  const debit = parseFloat($('in-debit').value);
  const prenom = $('in-prenom').value.trim();

  if (!Number.isFinite(obj) || obj <= 0 || !Number.isFinite(debit) || debit <= 0) {
    fb.className = 'save-feedback err'; fb.textContent = 'Valeurs invalides.'; return;
  }
  writeLS(LS.prenom, prenom); // identité locale : toujours sauvée localement

  const btn = $('btn-reglages');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Envoi…';
  fb.className = 'save-feedback'; fb.textContent = '';
  try {
    const r = await patchReglages({ objectif_mm: obj, debit_mm_h: debit });
    reglages = { objectif_mm: Number(r.objectif_mm), debit_mm_h: Number(r.debit_mm_h) };
    writeLS(LS.reglages, reglages);
    fb.className = 'save-feedback ok';
    fb.textContent = '✓ Réglages enregistrés.';
    render();
  } catch (e) {
    console.warn('[reglages] échec :', e.message);
    fb.className = 'save-feedback err';
    fb.textContent = 'Prénom gardé localement, mais l\'objectif/débit n\'a pas pu être synchronisé (hors ligne ?).';
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// --- Formulaire / init -------------------------------------------------
function fillSettings() {
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('in-obj', reglages.objectif_mm);
  set('in-debit', reglages.debit_mm_h);
  set('in-prenom', getPrenom());
}

function initForm() {
  const today = todayZurich();
  const di = $('in-date'); di.value = today; di.max = today;
  fillSettings();
  $('btn-save').addEventListener('click', saveArrosage);
  $('btn-reglages').addEventListener('click', saveReglages);
  $('in-min').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveArrosage(); });
}

async function init() {
  loadCache();
  initForm();
  initPush();
  render();                 // cache-first : affichage immédiat
  await Promise.all([loadWeather(), syncData()]);
  fillSettings();           // rafraîchit objectif/débit depuis Supabase
  render();
}

// Service worker : cache hors-ligne + réception des push.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw]', e.message));
  });
}

// --- Notifications push ------------------------------------------------
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function initPush() {
  const box = $('push-setting');
  const btn = $('btn-push');
  const hint = $('push-hint');
  if (!box || !btn) return;

  // iOS : le push n'existe QUE dans la PWA installée (mode standalone).
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || !isStandalone()) { box.hidden = true; return; }
  box.hidden = false;

  if (!VAPID_PUBLIC || VAPID_PUBLIC.startsWith('COLLE_')) {
    btn.disabled = true;
    hint.textContent = 'Notifications pas encore configurées (clé VAPID manquante).';
    return;
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    hint.textContent = 'Notifications bloquées dans les réglages iOS de l\'app.';
    return;
  }
  navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => {
    if (sub) { btn.textContent = '🔔 Notifications activées'; btn.disabled = true; hint.textContent = 'Tu recevras un rappel le matin quand il faut arroser.'; }
  }).catch(() => {});

  btn.addEventListener('click', enablePush);
}

async function enablePush() {
  const btn = $('btn-push');
  const hint = $('push-hint');
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      hint.textContent = 'Permission refusée. Tu peux réessayer depuis les réglages iOS.';
      btn.disabled = false;
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
    await upsertSubscription(sub, getPrenom());
    btn.textContent = '🔔 Notifications activées';
    hint.textContent = 'Tu recevras un rappel le matin quand il faut arroser.';
  } catch (e) {
    console.warn('[push]', e.message);
    hint.textContent = 'Échec de l\'activation. Réessaie dans un instant.';
    btn.disabled = false;
  }
}

// Re-synchro quand la page redevient visible (l'arrosage de l'autre apparaît).
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await Promise.all([loadWeather(), syncData()]);
    fillSettings();
    render();
  }
});

init();
