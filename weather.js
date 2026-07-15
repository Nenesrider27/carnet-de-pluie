// weather.js — fetch météo Open-Meteo + repli ET₀ (module PARTAGÉ page + push).
// Une seule source pour l'URL, la normalisation et la logique de repli : la page
// (app.js) et le script matinal (scripts/morning-push.mjs) ne peuvent pas diverger.
// Aucune dépendance, fetch global (navigateur et Node ≥ 18).
//
// MULTI-DOMICILE : les coordonnées sont désormais un PARAMÈTRE (défaut = Anières
// pour rétro-compat). On n'impose plus le modèle suisse `meteoswiss_icon_ch2`
// (qui ne couvre que la Suisse) → on laisse Open-Meteo choisir le MEILLEUR modèle
// régional selon les coordonnées (« best_match » : ICON-CH2 en Suisse, AROME en
// France, etc.). Résolution ~1–2 km là où c'est disponible.

const DEFAULT_LOC = { lat: 46.2777, lon: 6.2234, tz: 'Europe/Zurich' };

// Choix du modèle météo selon les coordonnées. Les modèles NATIONAUX haute
// résolution assimilent le radar local et sont bien plus fiables que `best_match`
// (qui peut piocher un modèle global grossier — il a un jour « vu » 20 mm de
// pluie à Anières quand MétéoSuisse, avec le radar suisse, disait 0.1 mm réel).
export function pickModel(lat, lon) {
  if (lat >= 45.7 && lat <= 47.9 && lon >= 5.8 && lon <= 10.6) return 'meteoswiss_icon_ch2';   // Suisse (2 km)
  if (lat >= 41.0 && lat <= 51.5 && lon >= -5.5 && lon <= 9.8) return 'meteofrance_seamless';  // France métro (AROME/ARPEGE)
  return 'best_match';                                                                          // ailleurs : au mieux
}

// Nom lisible du modèle météo réellement utilisé pour ces coordonnées (affichage).
export function modelLabel(lat, lon) {
  const m = pickModel(lat, lon);
  if (m === 'meteoswiss_icon_ch2') return 'MétéoSuisse (ICON-CH2, 2 km)';
  if (m === 'meteofrance_seamless') return 'Météo-France (AROME)';
  return 'meilleur modèle local';
}

function forecastUrl(lat, lon, tz) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,et0_fao_evapotranspiration` +
    `&timezone=${encodeURIComponent(tz)}&past_days=7&forecast_days=5&models=${pickModel(lat, lon)}`;
}

// Repli ET₀ : même requête, ET₀ seul (si le modèle choisi a des lacunes sur l'ET₀).
function et0FallbackUrl(lat, lon, tz) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=et0_fao_evapotranspiration&timezone=${encodeURIComponent(tz)}&past_days=7&forecast_days=5`;
}

// Un seul trou (null) invalide la fenêtre 7 j du calcul d'objectif → on tente
// le repli dès la moindre lacune, pas seulement si tout est null.
export const et0HasGaps = (a) => !Array.isArray(a) || a.length === 0 || a.some((x) => x == null || !Number.isFinite(x));

// Fetch + normalisation pour UN domicile. Lève en cas d'échec réseau/réponse vide
// (l'appelant décide du cache/bandeau). Le repli ET₀ est best-effort et silencieux.
// loc = { lat, lon, tz } — défaut Anières.
export async function fetchWeatherData(loc = {}) {
  const { lat = DEFAULT_LOC.lat, lon = DEFAULT_LOC.lon, tz = DEFAULT_LOC.tz } = loc;
  const res = await fetch(forecastUrl(lat, lon, tz), { cache: 'no-store' });
  if (!res.ok) throw new Error('météo HTTP ' + res.status);
  const data = await res.json();
  if (!data?.daily?.time?.length) throw new Error('réponse météo vide');
  let et0 = data.daily.et0_fao_evapotranspiration;
  if (et0HasGaps(et0)) {
    try {
      const r2 = await fetch(et0FallbackUrl(lat, lon, tz), { cache: 'no-store' });
      if (r2.ok) {
        const d2 = await r2.json();
        const alt = d2?.daily?.et0_fao_evapotranspiration;
        if (!et0HasGaps(alt)) et0 = alt;
      }
    } catch { /* on garde la série principale (l'objectif se repliera sur 28 si besoin) */ }
  }
  return {
    time: data.daily.time,
    precipitation_sum: data.daily.precipitation_sum,
    precipitation_probability_max: data.daily.precipitation_probability_max,
    temperature_2m_max: data.daily.temperature_2m_max,
    et0,
  };
}
