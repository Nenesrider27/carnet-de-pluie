// app.js — couche présentation.
// La LOGIQUE d'arrosage vit dans engine.js ; l'ACCÈS (cloisonné par domicile) dans
// store.js ; la SESSION dans auth.js ; l'ÉTAT du domicile courant dans domicile.js.
// Ici : orchestration, gate d'authentification, sélecteur de domicile, cache
// localStorage (offline + affichage instantané), DOM.
import { decide, DEFAULTS, CONSTANTS, addDays, projectWeek, computeObjectif, round1 } from './engine.js';
import { configureStore, getMyDomiciles, createDomicile, patchDomicile, getMembers, setMyPrenom,
  createInvitation, listInvitations, revokeInvitation, acceptInvitation, removeMember,
  getArrosages, upsertArrosage, purgeBefore, getContraintes, addContrainte, purgeContraintesBefore,
  upsertSubscription } from './store.js';
import { fetchWeatherData } from './weather.js';
import { VAPID_PUBLIC, CHAT_URL, SUPA_KEY } from './config.js';
import * as auth from './auth.js';
import * as dom from './domicile.js';
import { geocodeAddress, geocodeAddressPrecise, currentPosition, reverseGeocode } from './geocode.js';

// store.js utilise le JWT de l'utilisateur connecté (RLS) ; apikey = clé publishable.
configureStore(async () => {
  const t = await auth.accessToken();
  return t ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + t } : { apikey: SUPA_KEY };
});

// --- Config météo ------------------------------------------------------
const WEATHER_TTL = 3 * 3600 * 1000; // 3 h : quota API (ne pas re-fetch à chaque ouverture)

// --- Utilitaires -------------------------------------------------------
const $ = (id) => document.getElementById(id);
const readLS = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let storagePersistent = null;
async function ensurePersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      storagePersistent = await navigator.storage.persisted();
      if (!storagePersistent) storagePersistent = await navigator.storage.persist();
    }
  } catch { storagePersistent = null; }
  updateStorageStatus();
}
function updateStorageStatus() {
  const el = $('storage-status'); if (!el) return;
  if (storagePersistent === true) el.textContent = '💾 Stockage persistant activé.';
  else if (storagePersistent === false) el.textContent = '⚠️ iOS n\'a pas accordé de stockage persistant.';
  else el.textContent = '';
}

// Date « aujourd'hui » dans le fuseau du domicile courant (multi-fuseaux propre).
function todayLocal() {
  const tz = dom.currentLoc().tz || 'Europe/Zurich';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
const fmtLong = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(isoToDate(iso));
const fmtShort = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(isoToDate(iso));
const fmtWeekday = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(isoToDate(iso));
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`;
}

// --- État applicatif (du DOMICILE COURANT) ----------------------------
let weather = null, weatherTs = null, weatherOffline = false;
let arrosages = [];
let reglages = { ...DEFAULTS };
let contraintes = [];
let dataTs = null, dataOffline = false;
let lastFailedSave = null;
let currentArroserMinutes = 0;

const getPrenom = () => dom.myPrenom();

// --- Chargement des données (namespacées par domicile) ----------------
function loadCache() {
  const ca = readLS(dom.nsKey('arrosages'), null); arrosages = Array.isArray(ca) ? ca : [];
  const cc = readLS(dom.nsKey('contraintes'), null); contraintes = Array.isArray(cc) ? cc : [];
  const cw = readLS(dom.nsKey('weather2'), null); if (cw?.data) { weather = cw.data; weatherTs = cw.ts; } else { weather = null; weatherTs = null; }
  reglages = dom.currentReglages() || { ...DEFAULTS };
  dataTs = null; dataOffline = false; weatherOffline = false; // fraîcheur remise à zéro pour ce domicile
}

async function loadWeather(force = false) {
  const id = dom.currentId();
  const cacheFresh = weather && Array.isArray(weather.et0) && weatherTs && (Date.now() - weatherTs) < WEATHER_TTL;
  if (!force && cacheFresh) { weatherOffline = false; return; }
  try {
    const w = await fetchWeatherData(dom.currentLoc());
    if (dom.currentId() !== id) return;   // domicile changé pendant le fetch
    weather = w;
    weatherTs = Date.now();
    weatherOffline = false;
    writeLS(dom.nsKeyFor(id, 'weather2'), { data: weather, ts: weatherTs });
  } catch (e) {
    if (dom.currentId() !== id) return;
    weatherOffline = true;
    console.warn('[météo] fetch échoué :', e.message);
  }
}

// Supabase = source de vérité. Purge 14 j (best-effort), puis lit arrosages + contraintes.
// Les réglages viennent du domicile lui-même (dom.currentReglages()).
async function syncData() {
  const id = dom.currentId();
  if (!id) return;
  const today = todayLocal();
  try {
    purgeBefore(id, addDays(today, -14)).catch((e) => console.warn('[purge]', e.message));
    purgeContraintesBefore(id, today).catch((e) => console.warn('[purge-contr]', e.message));
    const [arr, contr] = await Promise.all([getArrosages(id), getContraintes(id)]);
    if (dom.currentId() !== id) return;   // domicile changé pendant le fetch → ne pas polluer l'autre
    arrosages = Array.isArray(arr) ? arr : [];
    writeLS(dom.nsKeyFor(id, 'arrosages'), arrosages);
    contraintes = Array.isArray(contr) ? contr : [];
    writeLS(dom.nsKeyFor(id, 'contraintes'), contraintes);
    reglages = dom.currentReglages() || { ...DEFAULTS };
    dataTs = Date.now();
    dataOffline = false;
  } catch (e) {
    dataOffline = true;
    console.warn('[supabase] sync échoué :', e.message);
  }
}

// --- Rendu -------------------------------------------------------------
const ICONS = { arroser: '💧', presque: '🌱', attends: '⏳', fait: '✅', rien: '✅', pluie: '🌧️', erreur: '⚠️', 'avant-depart': '🧳', absent: '🚪' };

function renderClimateBanner(m) {
  const el = $('climate-banner');
  if (!el) return;
  if (!m || !m.ok) { el.hidden = true; return; }
  const manuel = m.objectif_source === 'manuel';
  if (m.objectif_source === 'fallback') {
    el.className = 'climate-banner cb-fallback';
    el.innerHTML = `⚠️ Objectif par défaut (${m.objectif} mm) — données ET₀ indisponibles.`;
    el.hidden = false;
  } else if (m.canicule) {
    el.className = 'climate-banner cb-hot';
    el.innerHTML = manuel
      ? `🔥 Canicule — sessions resserrées · objectif manuel <b>${m.objectif} mm</b>.`
      : (m.objectif > m.obj_ref
        ? `🔥 Canicule — objectif relevé à <b>${m.objectif} mm</b> (vs ${m.obj_ref} en temps normal) · sessions resserrées.`
        : `🔥 Canicule à venir — objectif <b>${m.objectif} mm</b> · sessions resserrées.`);
    el.hidden = false;
  } else if (!manuel && m.et0_mean3 != null && m.et0_mean3 <= 3 && m.objectif < m.obj_ref) {
    el.className = 'climate-banner cb-cool';
    el.innerHTML = `🌥️ Temps frais — objectif abaissé à <b>${m.objectif} mm</b> (vs ${m.obj_ref} en temps normal).`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function render() {
  const today = todayLocal();
  $('dateToday').textContent = cap(fmtLong(today));

  const nOff = $('notice-offline'); nOff.classList.remove('show');
  $('notice-error').classList.remove('show');

  if (!weather) {
    renderVerdictError('Météo indisponible', 'Vérifie ta connexion, puis rouvre l\'app.', 'Aucune donnée météo — impossible de calculer une recommandation.');
    $('week-line').textContent = '';
    renderClimateBanner(null);
  } else {
    if (weatherOffline && weatherTs) {
      nOff.textContent = `Hors ligne — météo du ${new Date(weatherTs).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}`;
      nOff.classList.add('show');
    }
    const decision = decide({ weather, arrosages, reglages, today, contraintes });
    if (decision.etat === 'erreur') {
      renderVerdictError('Météo incomplète', 'La date du jour est absente des données.', 'Impossible de situer aujourd\'hui dans les prévisions.');
      $('week-line').textContent = '';
      renderClimateBanner(null);
    } else {
      renderVerdict(decision, reglages);
      renderWeekLine(decision);
      renderClimateBanner(decision.metrics);
    }
  }
  renderWeek();
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
  $('v-actions').hidden = true;
  $('v-second').hidden = true;
}

function renderVerdict(d, reg) {
  const m = d.metrics;
  setState('state-' + d.etat);
  $('v-icon').textContent = ICONS[d.etat] || '💧';
  const actionState = d.etat === 'arroser' || d.etat === 'avant-depart';
  $('v-tip').hidden = d.etat !== 'arroser';
  $('v-actions').hidden = !actionState;
  if (actionState) currentArroserMinutes = d.minutes;
  $('v-second').hidden = true;

  let title = '', subtitle = '', why = '';
  if (d.etat === 'arroser') {
    title = `Arroser <span class="acc--big">${d.minutes} min</span>`;
    subtitle = `Session de ${round1(d.session_mm)} mm, au débit de ${reg.debit_mm_h} mm/h.`;
    why = `Il manque ${round1(m.deficit)} mm pour l'objectif de ${m.objectif} mm cette semaine.`;
    // Transparence : pourquoi on arrose malgré une éventuelle pluie annoncée.
    if (d.filet) {
      const dry = m.dryDays >= 99 ? 'Pas d\'eau récente' : `${m.dryDays} jour${m.dryDays > 1 ? 's' : ''} sans eau`;
      why += ` ${dry} — on n'attend plus la pluie annoncée (elle pourrait ne pas tomber).`;
    } else if (m.pluie_prevue_brute >= CONSTANTS.RAIN_SOON_MM && m.pluie_prevue < m.pluie_prevue_brute * 0.6) {
      why += ` Pluie annoncée (${round1(m.pluie_prevue_brute)} mm) mais peu probable — pas prise en compte.`;
    }
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
    why = `Pluie et arrosages couvrent l'objectif de ${m.objectif} mm. Rien à ajouter.`;
  } else if (d.etat === 'pluie') {
    title = 'La pluie s\'en charge';
    subtitle = `${round1(m.pluie_48h)} mm attendus sous 48 h.`;
    why = 'Inutile d\'arroser juste avant une pluie annoncée. Recontrôle après.';
  } else if (d.etat === 'avant-depart') {
    title = `Arrose avant de partir <span class="acc--big">${d.minutes} min</span>`;
    subtitle = 'Tu pars bientôt et personne n\'arrosera — fais-le avant de filer.';
    why = `Chaleur prévue et pas de pluie pendant ton absence (déficit ~${round1(d.deficitFin)} mm au retour). Autant partir tranquille.`;
  } else if (d.etat === 'absent') {
    title = 'Tu es absent';
    subtitle = 'Personne au jardin aujourd\'hui.';
    why = 'Rien à faire d\'ici — la reco reprendra à ton retour.';
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

const WK_ICONS = { arroser: '💧', pluie: '🌧️', attends: '⏳', fait: '✅', rien: '✅', presque: '🌱', inconnu: '·', 'avant-depart': '🧳', absent: '🚪' };
function renderWeek() {
  const el = $('week');
  const key = $('week-key');
  if (!weather) { el.hidden = true; if (key) key.hidden = true; return; }
  if (key) key.hidden = false;
  const today = todayLocal();
  const wk = projectWeek({ weather, arrosages, reglages, today, contraintes });
  el.hidden = false;
  el.innerHTML = wk.map((d, i) => {
    const cls = 'wk-cell' + (i === 0 ? ' today' : '') + (d.etat === 'inconnu' ? ' inconnu' : '');
    const day = i === 0 ? 'auj.'
      : new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(isoToDate(d.jour)).replace('.', '');
    const min = (d.etat === 'arroser' || d.etat === 'avant-depart') && d.minutes ? `${d.minutes}'` : '';
    const wi = weather.time.indexOf(d.jour);
    const et0v = wi >= 0 && Array.isArray(weather.et0) && typeof weather.et0[wi] === 'number' ? round1(weather.et0[wi]) : null;
    const et0Txt = et0v != null ? `<span class="wk-et0" title="évapotranspiration ${et0v} mm/j">${et0v}</span>` : '';
    return `<div class="${cls}"><span class="wk-day">${day}</span><span class="wk-icon">${WK_ICONS[d.etat] || '·'}</span><span class="wk-min">${min}</span>${et0Txt}</div>`;
  }).join('');
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
  const today = todayLocal();
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

function renderSyncNote() {
  const el = $('sync-note'); if (!el) return;
  const me = getPrenom();
  const today = todayLocal();
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
async function recordArrosage(date, min) {
  const id = dom.currentId();
  const existing = arrosages.find((r) => r.jour === date);
  const total = (existing?.minutes || 0) + min;
  const row = await upsertArrosage({ domicileId: id, jour: date, minutes: total, auteur: getPrenom() });
  if (dom.currentId() !== id) return { total, existed: !!existing }; // domicile changé : écrit en DB, ne pas polluer l'état courant
  arrosages = arrosages.filter((r) => r.jour !== date).concat(row);
  writeLS(dom.nsKeyFor(id, 'arrosages'), arrosages);
  dataTs = Date.now(); dataOffline = false;
  return { total, existed: !!existing };
}

async function saveArrosage() {
  const fb = $('save-feedback');
  fb.className = 'save-feedback';
  const date = $('in-date').value;
  const min = parseInt($('in-min').value, 10);
  const today = todayLocal();

  if (!date) return failSave('Choisis un jour.');
  if (date > today) return failSave('Pas de date future.');
  if (!Number.isFinite(min) || min <= 0) return failSave('Entre un nombre de minutes valide.');

  const btn = $('btn-save');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Envoi…';
  fb.className = 'save-feedback'; fb.textContent = '';
  try {
    const { total, existed } = await recordArrosage(date, min);
    lastFailedSave = null;
    $('in-min').value = '';
    fb.className = 'save-feedback ok';
    fb.textContent = existed
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

async function recordToday(min) {
  const today = todayLocal();
  try {
    const { total } = await recordArrosage(today, min);
    toast(total !== min ? `✓ ${min} min ajoutées (${total} min aujourd'hui)` : `✓ ${min} min enregistrées`);
    render();
    return true;
  } catch (e) {
    console.warn('[recordToday] échec :', e.message);
    toast('❌ Échec — hors ligne ? Rien enregistré.');
    return false;
  }
}

// --- Toast -------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 3400);
}

// --- Chrono d'arrosage -------------------------------------------------
let chrono = null;
let audioCtx = null;

function startChrono(minutes) {
  if (!minutes || minutes <= 0) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
  chrono = { targetSec: minutes * 60, startMs: Date.now(), minutes, interval: null, finished: false };
  $('chrono-label').textContent = 'Arrosage en cours';
  $('chrono-time').classList.remove('done');
  $('chrono-sub').textContent = `Objectif : ${minutes} min`;
  $('chrono-stop').textContent = '■ Stop & enregistrer';
  $('chrono').hidden = false;
  tickChrono();
  chrono.interval = setInterval(tickChrono, 250);
}

function tickChrono() {
  if (!chrono) return;
  const elapsed = (Date.now() - chrono.startMs) / 1000;
  const remaining = Math.max(0, chrono.targetSec - elapsed);
  const mm = Math.floor(remaining / 60), ss = Math.floor(remaining % 60);
  $('chrono-time').textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  $('chrono-bar-fill').style.width = Math.min(100, (elapsed / chrono.targetSec) * 100) + '%';
  if (remaining <= 0 && !chrono.finished) finishChrono();
}

async function finishChrono() {
  chrono.finished = true;
  clearInterval(chrono.interval);
  playAlarm();
  $('chrono-time').textContent = '00:00';
  $('chrono-time').classList.add('done');
  $('chrono-label').textContent = 'Terminé !';
  $('chrono-sub').textContent = `Session de ${chrono.minutes} min`;
  $('chrono-bar-fill').style.width = '100%';
  $('chrono-stop').textContent = 'Fermer';
  await recordToday(chrono.minutes);
}

async function stopChrono() {
  if (!chrono) return;
  if (chrono.finished) { closeChrono(); return; }
  clearInterval(chrono.interval);
  const min = Math.max(1, Math.round((Date.now() - chrono.startMs) / 60000));
  closeChrono();
  await recordToday(min);
}

function cancelChrono() { closeChrono(); }

function closeChrono() {
  if (chrono?.interval) clearInterval(chrono.interval);
  chrono = null;
  $('chrono').hidden = true;
}

function playAlarm() {
  if (document.visibilityState !== 'visible') return;
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      const t = t0 + i * 0.5;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.05);
      g.gain.linearRampToValueAtTime(0, t + 0.4);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.45);
    }
  } catch {}
}

function failSave(msg) {
  const fb = $('save-feedback');
  fb.className = 'save-feedback err';
  fb.textContent = msg;
}

function retrySave() {
  if (!lastFailedSave) return;
  $('in-date').value = lastFailedSave.date;
  $('in-min').value = lastFailedSave.min;
  saveArrosage();
}

// --- Réglages (du domicile courant) -----------------------------------
async function saveReglages() {
  const fb = $('reglages-feedback');
  const debit = parseFloat($('in-debit').value);
  const kc = parseFloat($('in-kc').value);
  const manuel = $('in-manuel').checked;
  const obj = parseFloat($('in-obj').value);
  const prenom = $('in-prenom').value.trim();

  if (!Number.isFinite(debit) || debit <= 0) { fb.className = 'save-feedback err'; fb.textContent = 'Débit invalide.'; return; }
  if (!Number.isFinite(kc) || kc <= 0) { fb.className = 'save-feedback err'; fb.textContent = 'Kc invalide.'; return; }
  if (manuel && (!Number.isFinite(obj) || obj <= 0)) { fb.className = 'save-feedback err'; fb.textContent = 'Objectif manuel invalide.'; return; }

  const btn = $('btn-reglages');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Envoi…';
  fb.className = 'save-feedback'; fb.textContent = '';
  try {
    // Prénom : membership du domicile courant.
    if (prenom && prenom !== dom.myPrenom()) {
      await setMyPrenom(dom.currentId(), dom.getUserId(), prenom);
    }
    const patch = { debit_mm_h: debit, kc, objectif_manuel: manuel };
    if (manuel && Number.isFinite(obj)) patch.objectif_mm = obj;
    await patchDomicile(dom.currentId(), patch);
    await refreshDomiciles();          // recharge le domicile (réglages + prénom à jour)
    reglages = dom.currentReglages() || { ...DEFAULTS };
    fb.className = 'save-feedback ok';
    fb.textContent = '✓ Réglages enregistrés.';
    fillSettings();
    render();
  } catch (e) {
    console.warn('[reglages] échec :', e.message);
    fb.className = 'save-feedback err';
    fb.textContent = 'Échec de synchro (hors ligne ?).';
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function fillSettings() {
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('in-obj', reglages.objectif_mm);
  set('in-debit', reglages.debit_mm_h);
  set('in-kc', reglages.kc ?? DEFAULTS.kc);
  set('in-prenom', getPrenom());
  const manuel = !!reglages.objectif_manuel;
  const chk = $('in-manuel'); if (chk && document.activeElement !== chk) chk.checked = manuel;
  const mf = $('manuel-field'); if (mf) mf.hidden = !manuel;
  const oc = $('obj-computed');
  if (oc) {
    const o = weather ? computeObjectif({ weather, reglages, today: todayLocal() }) : null;
    if (!o) oc.textContent = 'Objectif de la semaine : —';
    else if (o.source === 'manuel') oc.innerHTML = `Objectif manuel : <b>${o.objectif} mm</b>/semaine.`;
    else if (o.source === 'fallback') oc.innerHTML = `Objectif : <b>${o.objectif} mm</b> — par défaut (ET₀ indisponible).`;
    else oc.innerHTML = `Objectif de la semaine : <b>${o.objectif} mm</b> — calculé depuis l'ET₀ (Σ7 j ${o.et0_7j} mm × Kc ${o.kc}).`;
  }
}

function initForm() {
  const today = todayLocal();
  const di = $('in-date'); di.value = today; di.max = today;
  fillSettings();
  $('btn-save').addEventListener('click', saveArrosage);
  $('btn-reglages').addEventListener('click', saveReglages);
  $('in-min').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveArrosage(); });
  $('in-manuel').addEventListener('change', (e) => { const mf = $('manuel-field'); if (mf) mf.hidden = !e.target.checked; });
  $('chat-send').addEventListener('click', chatSend);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend(); });
  $('btn-chrono').addEventListener('click', () => startChrono(currentArroserMinutes));
  $('btn-done').addEventListener('click', async () => {
    const b = $('btn-done'); b.disabled = true;
    await recordToday(currentArroserMinutes);
    b.disabled = false;
  });
  $('chrono-stop').addEventListener('click', stopChrono);
  $('chrono-cancel').addEventListener('click', cancelChrono);
}

// =====================================================================
// AUTHENTIFICATION (écran de connexion / inscription)
// =====================================================================
let authMode = 'signin'; // 'signin' | 'signup'
function showAuth() {
  $('auth').hidden = false;
  $('app-main').hidden = true;
  setAuthError('');
}
function hideAuth() { $('auth').hidden = true; $('app-main').hidden = false; }
function setAuthError(msg) { const el = $('auth-error'); if (el) { el.textContent = msg || ''; el.hidden = !msg; } }
function setAuthMode(mode) {
  authMode = mode;
  $('auth-title').textContent = mode === 'signup' ? 'Créer un compte' : 'Connexion';
  $('auth-submit').textContent = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
  $('auth-toggle').innerHTML = mode === 'signup'
    ? 'Déjà un compte ? <a href="#" id="auth-toggle-link">Se connecter</a>'
    : 'Pas de compte ? <a href="#" id="auth-toggle-link">En créer un</a>';
  $('auth-forgot').hidden = mode === 'signup';
  $('auth-toggle-link').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(mode === 'signup' ? 'signin' : 'signup'); });
  setAuthError('');
}

async function submitAuth() {
  const email = $('auth-email').value.trim();
  const pass = $('auth-pass').value;
  if (!email || !pass) return setAuthError('Renseigne ton email et ton mot de passe.');
  const btn = $('auth-submit'); btn.disabled = true; const label = btn.textContent; btn.textContent = '…';
  setAuthError('');
  try {
    let user = null;
    if (authMode === 'signup') {
      const data = await auth.signUp(email, pass);
      if (!data?.session) {
        // Email de confirmation requis (config) → pas de session immédiate.
        setAuthError('Compte créé. Vérifie ta boîte mail pour confirmer, puis connecte-toi.');
        setAuthMode('signin');
        return;
      }
      user = data.user;
    } else {
      const data = await auth.signIn(email, pass);
      user = data.user;
    }
    if (user) await enterApp(user);   // entrée immédiate (ne pas attendre un reload)
  } catch (e) {
    setAuthError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function doForgot() {
  const email = $('auth-email').value.trim();
  if (!email) return setAuthError('Entre ton email d\'abord.');
  try { await auth.resetPassword(email); setAuthError('Email de réinitialisation envoyé (si un compte existe).'); }
  catch (e) { setAuthError(e.message); }
}

function initAuthUI() {
  setAuthMode('signin');
  $('auth-submit').addEventListener('click', submitAuth);
  $('auth-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('auth-forgot').addEventListener('click', (e) => { e.preventDefault(); doForgot(); });
  $('btn-signout').addEventListener('click', async () => { await auth.signOut(); location.reload(); });
}

// =====================================================================
// DOMICILES (sélecteur, création, partage)
// =====================================================================
async function refreshDomiciles() {
  const list = await getMyDomiciles(dom.getUserId());
  dom.setDomiciles(list);
  renderDomicileSelector();
}

function renderDomicileSelector() {
  const sel = $('domicile-select');
  if (!sel) return;
  const list = dom.getDomiciles();
  sel.innerHTML = list.map((d) => `<option value="${d.id}"${d.id === dom.currentId() ? ' selected' : ''}>${escapeHtml(d.nom)}</option>`).join('')
    + '<option value="__add__">➕ Ajouter un domicile…</option>';
}

async function onDomicileChange(e) {
  const v = e.target.value;
  if (v === '__add__') { renderDomicileSelector(); openDomicileForm(); return; }
  dom.setCurrent(v);
  reglages = dom.currentReglages() || { ...DEFAULTS };
  loadCache();
  fillSettings();
  render();
  await Promise.all([loadWeather(true), syncData()]);
  fillSettings();
  render();
}

// --- Création / édition d'un domicile ---
let picked = null; // { lat, lon, timezone, label }
function openDomicileForm() {
  $('domicile-form').hidden = false;
  $('df-nom').value = '';
  $('df-adresse').value = '';
  $('df-results').innerHTML = '';
  $('df-coords').textContent = '';
  $('df-error').textContent = '';
  picked = null;
  resetDebit();
  setTimeout(() => $('df-nom').focus(), 60);
}
function closeDomicileForm() { $('domicile-form').hidden = true; }

// --- Débit d'arrosage (mm/h) : 3 chemins (type / mesure / connu) ---------
let debitMode = 'type';
function setDebitMode(mode) {
  debitMode = mode;
  document.querySelectorAll('#debit-seg .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.debitMode === mode));
  document.querySelectorAll('.debit-panel').forEach((p) => { p.hidden = p.dataset.panel !== mode; });
  refreshDebit();
}
// Débit résultant du chemin actif (null si l'utilisateur doit encore renseigner).
function computeDebit() {
  if (debitMode === 'connu') {
    const v = parseFloat($('df-debit-val').value);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }
  if (debitMode === 'mesure') {
    const mm = parseFloat($('df-mes-mm').value), min = parseFloat($('df-mes-min').value);
    if (Number.isFinite(mm) && mm > 0 && Number.isFinite(min) && min > 0) return Math.round((mm / min) * 60);
    return null;
  }
  const v = parseFloat($('df-debit-type').value); // type : toujours une valeur
  return Number.isFinite(v) ? v : 15;
}
function refreshDebit() {
  const d = computeDebit();
  const el = $('df-debit-summary');
  if (el) el.innerHTML = d ? `Débit retenu : <b>${d} mm/h</b>` : 'Débit retenu : <b>—</b> (renseigne une valeur)';
}
function resetDebit() {
  setDebitMode('type');
  $('df-debit-type').value = '15';
  $('df-mes-mm').value = ''; $('df-mes-min').value = ''; $('df-debit-val').value = '';
  refreshDebit();
}

async function searchAddress() {
  const q = $('df-adresse').value.trim();
  if (!q) return;
  const box = $('df-results'); box.innerHTML = '<div class="df-hint">Recherche…</div>';
  try {
    let list = await geocodeAddress(q);
    if (!list.length) list = await geocodeAddressPrecise(q); // repli précision rue
    if (!list.length) { box.innerHTML = '<div class="df-hint">Aucun résultat.</div>'; return; }
    box.innerHTML = '';
    list.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'df-result';
      b.textContent = r.label;
      b.addEventListener('click', () => pickLocation(r.lat, r.lon, r.timezone, r.label));
      box.appendChild(b);
    });
  } catch (e) { box.innerHTML = `<div class="df-hint">Erreur de recherche : ${escapeHtml(e.message)}</div>`; }
}

async function useMyPosition() {
  const box = $('df-results'); box.innerHTML = '<div class="df-hint">Localisation…</div>';
  try {
    const { lat, lon } = await currentPosition();
    const rev = await reverseGeocode(lat, lon);
    pickLocation(lat, lon, null, rev?.label || `${lat}, ${lon}`);
    box.innerHTML = '';
  } catch (e) { box.innerHTML = `<div class="df-hint">${escapeHtml(e.message)}</div>`; }
}

function pickLocation(lat, lon, tz, label) {
  picked = { lat, lon, timezone: tz || 'Europe/Zurich', label };
  $('df-coords').innerHTML = `📍 <b>${escapeHtml(label)}</b><br><span class="df-latlon">${lat}, ${lon}</span>`;
  if (!$('df-nom').value.trim()) $('df-nom').value = String(label).split(',')[0].trim();
  $('df-results').innerHTML = '';
}

async function saveDomicile() {
  const nom = $('df-nom').value.trim();
  const err = $('df-error');
  if (!nom) { err.textContent = 'Donne un nom à ce domicile.'; return; }
  if (!picked) { err.textContent = 'Choisis un emplacement (adresse ou « ma position »).'; return; }
  const debit = computeDebit();
  if (!debit) { err.textContent = 'Renseigne le débit d\'arrosage (ou choisis un type).'; return; }
  const btn = $('df-save'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Création…';
  err.textContent = '';
  try {
    const created = await createDomicile({
      ownerId: dom.getUserId(), nom, adresse: picked.label,
      lat: picked.lat, lon: picked.lon, timezone: picked.timezone,
      debit_mm_h: debit,
    });
    await refreshDomiciles();
    dom.setCurrent(created.id);
    renderDomicileSelector();
    closeDomicileForm();
    loadCache();
    fillSettings();
    render();
    await Promise.all([loadWeather(true), syncData()]);
    fillSettings();
    render();
    toast(`✓ Domicile « ${nom} » ajouté`);
  } catch (e) {
    err.textContent = 'Échec : ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// --- Partage (invitations + membres) ---
async function openShare() {
  $('share-panel').hidden = false;
  $('share-link-box').hidden = true;
  await renderMembers();
  await renderInvitations();
}
function closeShare() { $('share-panel').hidden = true; }

async function renderMembers() {
  const el = $('share-members');
  try {
    const members = await getMembers(dom.currentId());
    el.innerHTML = members.map((m) => {
      const me = m.user_id === dom.getUserId();
      const canRemove = dom.isAdmin() && !me && m.role !== 'owner';
      const rm = canRemove ? `<button class="link-btn" data-remove="${m.user_id}">retirer</button>` : '';
      return `<li><span>${escapeHtml(m.prenom || '(sans nom)')} <span class="who">${m.role}${me ? ' · toi' : ''}</span></span>${rm}</li>`;
    }).join('');
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await removeMember(dom.currentId(), b.dataset.remove); await renderMembers(); }
      catch (e) { toast('❌ ' + e.message); b.disabled = false; }
    }));
  } catch (e) { el.innerHTML = `<li class="df-hint">${escapeHtml(e.message)}</li>`; }
}

async function renderInvitations() {
  const el = $('share-invites');
  if (!dom.isAdmin()) { el.innerHTML = ''; $('btn-gen-invite').hidden = true; return; }
  $('btn-gen-invite').hidden = false;
  try {
    const invs = await listInvitations(dom.currentId());
    const active = invs.filter((i) => !i.revoked && new Date(i.expires_at) > new Date());
    el.innerHTML = active.length
      ? active.map((i) => `<li><span class="who">expire ${new Date(i.expires_at).toLocaleDateString('fr-FR')}</span> <button class="link-btn" data-copy="${i.token}">copier le lien</button> <button class="link-btn" data-revoke="${i.token}">révoquer</button></li>`).join('')
      : '<li class="df-hint">Aucune invitation active.</li>';
    el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyInviteLink(b.dataset.copy)));
    el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await revokeInvitation(b.dataset.revoke); await renderInvitations(); }
      catch (e) { toast('❌ ' + e.message); b.disabled = false; }
    }));
  } catch (e) { el.innerHTML = `<li class="df-hint">${escapeHtml(e.message)}</li>`; }
}

function inviteUrl(token) {
  // Fragment (#) : jamais envoyé aux serveurs/CDN ni en Referer → pas de fuite du token.
  return `${location.origin}${location.pathname}#token=${token}`;
}
async function generateInvite() {
  const btn = $('btn-gen-invite'); btn.disabled = true;
  try {
    const inv = await createInvitation(dom.currentId(), 'member');
    const url = inviteUrl(inv.token);
    $('share-link').value = url;
    $('share-link-box').hidden = false;
    await renderInvitations();
    copyInviteLink(inv.token);
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; }
}
async function copyInviteLink(token) {
  const url = inviteUrl(token);
  try { await navigator.clipboard.writeText(url); toast('🔗 Lien copié — partage-le'); }
  catch { $('share-link').value = url; $('share-link-box').hidden = false; toast('🔗 Lien prêt à copier'); }
}

function initDomicileUI() {
  $('domicile-select').addEventListener('change', onDomicileChange);
  $('df-search').addEventListener('click', searchAddress);
  $('df-adresse').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchAddress(); } });
  $('df-mypos').addEventListener('click', useMyPosition);
  $('df-save').addEventListener('click', saveDomicile);
  $('df-cancel').addEventListener('click', closeDomicileForm);
  // Débit d'arrosage : segmented control + recalcul en direct.
  document.querySelectorAll('#debit-seg .seg-btn').forEach((b) => b.addEventListener('click', () => setDebitMode(b.dataset.debitMode)));
  $('df-debit-type').addEventListener('change', refreshDebit);
  ['df-mes-mm', 'df-mes-min', 'df-debit-val'].forEach((id) => $(id).addEventListener('input', refreshDebit));
  $('btn-share').addEventListener('click', openShare);
  $('share-close').addEventListener('click', closeShare);
  $('btn-gen-invite').addEventListener('click', generateInvite);
  $('share-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('share-link').value); toast('🔗 Lien copié'); } catch {} });
}

// Après connexion : traite un lien d'invitation en attente, charge les domiciles.
function pendingInviteToken() {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  return fromHash || new URL(location.href).searchParams.get('token'); // rétro-compat anciens liens ?token=
}
function clearInviteToken() {
  const u = new URL(location.href);
  u.searchParams.delete('token');
  const hp = new URLSearchParams(u.hash.replace(/^#/, '')); hp.delete('token');
  const hash = hp.toString() ? '#' + hp.toString() : '';
  history.replaceState(null, '', u.pathname + (u.search || '') + hash);
}

async function enterApp(user) {
  dom.setUser(user.id);
  hideAuth();
  // Invitation en attente ?
  let joinedId = null;
  const token = pendingInviteToken();
  if (token) {
    try { const j = await acceptInvitation(token); joinedId = Array.isArray(j) ? j[0]?.domicile_id : j?.domicile_id; toast('✓ Tu as rejoint un domicile partagé'); }
    catch (e) { toast('Invitation : ' + e.message); }
    clearInviteToken();
  }
  await refreshDomiciles();
  if (joinedId) { dom.setCurrent(joinedId); renderDomicileSelector(); } // sélectionner le domicile rejoint
  if (!dom.getDomiciles().length) {
    // Aucun domicile → invite à en créer un.
    openDomicileForm();
    $('df-error').textContent = 'Bienvenue ! Crée ton premier domicile pour commencer.';
    return;
  }
  loadCache();
  initPush();
  fillSettings();
  render();
  await Promise.all([loadWeather(), syncData()]);
  fillSettings();
  render();
}

// =====================================================================
// Assistant (chat Claude via Edge Function)
// =====================================================================
let chatHistory = [];
let chatSending = false;
const VERDICT_LABEL = {
  arroser: 'arroser', 'avant-depart': 'arroser avant de partir', presque: 'presque bon',
  attends: 'attends', fait: 'fait pour aujourd\'hui', rien: 'rien à faire',
  pluie: 'la pluie s\'en charge', absent: 'absent', erreur: 'météo indisponible',
};

function chatContext() {
  const today = todayLocal();
  const d0 = dom.current();
  let m = null, etat = 'inconnu', minutes = null;
  if (weather) {
    const d = decide({ weather, arrosages, reglages, today, contraintes });
    m = d.metrics; etat = VERDICT_LABEL[d.etat] || d.etat; minutes = d.minutes ?? null;
  }
  const membres = (d0?.domicile_members || []).map((x) => x.prenom).filter(Boolean).join(', ');
  return {
    today, verdict: etat, minutes,
    domicile: d0?.nom || null,
    lieu: d0?.adresse || null,
    membres: membres || null,
    objectif_mm: m?.objectif ?? null,
    pluie_prevue: m ? round1(m.pluie_prevue) : null,
    pluie_48h: m ? round1(m.pluie_48h) : null,
    debit_mm_h: reglages.debit_mm_h,
    arrosages_recents: [...arrosages].sort((a, b) => (a.jour < b.jour ? 1 : -1)).slice(0, 5).map((a) => `${a.jour} ${a.minutes}min`).join(', ') || 'aucun',
    contraintes: contraintes.map((c) => `${c.type} ${c.debut}→${c.fin}`).join(', ') || 'aucune',
  };
}

function chatBubble(role, text) {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

const CHAT_HISTORY_MAX = 16;
function trimmedChatHistory() {
  let h = chatHistory.slice(-CHAT_HISTORY_MAX);
  while (h.length && h[0].role !== 'user') h = h.slice(1);
  return h;
}

async function chatSend() {
  if (chatSending) return;
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  chatBubble('user', text);
  chatSending = true;
  const btn = $('chat-send'); btn.disabled = true;
  const thinking = chatBubble('bot', '…');
  try {
    const jwt = await auth.accessToken();
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + (jwt || SUPA_KEY) },
      body: JSON.stringify({ messages: trimmedChatHistory(), context: chatContext() }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('HTTP ' + res.status)); }
    const data = await res.json();
    thinking.remove();
    const reply = (data.reply && data.reply.trim())
      || (data.action?.resume ? `Je te propose : ${data.action.resume}` : '(réponse vide)');
    chatHistory.push({ role: 'assistant', content: reply });
    chatBubble('bot', reply);
    if (data.action && data.action.type === 'absence') renderChatAction(data.action);
  } catch (e) {
    if (chatHistory[chatHistory.length - 1]?.role === 'user') chatHistory.pop();
    if (!input.value) input.value = text;
    thinking.remove();
    console.warn('[chat]', e.message);
    chatBubble('bot', '⚠️ Assistant indisponible (' + e.message + '). Réessaie dans un instant.');
  } finally {
    chatSending = false; btn.disabled = false;
  }
}

function renderChatAction(action) {
  const log = $('chat-log');
  const wrap = document.createElement('div');
  wrap.className = 'chat-action';
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = '✓ Appliquer : ' + (action.resume || `absence ${action.debut} → ${action.fin}`);
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Enregistrement…';
    const dejaLa = () => contraintes.some((c) => c.type === 'absence' && c.debut === action.debut && c.fin === action.fin);
    try {
      if (!dejaLa()) {
        await addContrainte({ domicileId: dom.currentId(), type: 'absence', debut: action.debut, fin: action.fin, note: action.resume, auteur: getPrenom() });
      }
    } catch (e) {
      b.disabled = false; b.textContent = '✓ Appliquer';
      chatBubble('bot', '⚠️ Échec de l\'enregistrement : ' + e.message);
      return;
    }
    try { await syncData(); render(); } catch { /* re-synchro au prochain retour */ }
    wrap.className = 'chat-action done';
    wrap.textContent = '✓ Enregistré — le dashboard est à jour.';
  });
  wrap.appendChild(b);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// =====================================================================
// INIT
// =====================================================================
async function init() {
  await ensurePersistentStorage();
  initForm();
  initAuthUI();
  initDomicileUI();

  // Réagit aux changements de session (connexion, refresh, déconnexion).
  auth.onAuthChange((event) => {
    // Reset COMPLET de l'état à la déconnexion (pas de fuite de données/chat entre comptes).
    if (event === 'SIGNED_OUT') location.reload();
  });

  const session = await auth.getSession();
  if (session?.user) {
    await enterApp(session.user);
  } else {
    // Pas de session : on montre le login (le token d'invitation éventuel est
    // conservé dans l'URL et traité après connexion).
    showAuth();
    if (pendingInviteToken()) setAuthError('Connecte-toi ou crée un compte pour rejoindre le domicile partagé.');
  }
}

// Service worker : cache hors-ligne + réception des push.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || swReloaded) return;
    swReloaded = true;
    window.location.reload();
  });
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
    await upsertSubscription(sub, { userId: dom.getUserId(), domicileId: dom.currentId(), auteur: getPrenom() });
    btn.textContent = '🔔 Notifications activées';
    hint.textContent = 'Tu recevras un rappel le matin quand il faut arroser.';
  } catch (e) {
    console.warn('[push]', e.message);
    hint.textContent = 'Échec de l\'activation. Réessaie dans un instant.';
    btn.disabled = false;
  }
}

// Re-synchro quand la page redevient visible.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && dom.currentId()) {
    await Promise.all([loadWeather(), syncData()]);
    fillSettings();
    render();
  }
});

init();
