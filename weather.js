// weather.js — fetch météo MétéoSuisse + repli ET₀ (module PARTAGÉ page + push).
// Une seule source pour l'URL, la normalisation et la logique de repli :
// la page (app.js) et le script matinal (scripts/morning-push.mjs) ne peuvent
// pas diverger. Aucune dépendance, fetch global (navigateur et Node ≥ 18).

const LAT = 46.2777, LON = 6.2234;

export const API_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,et0_fao_evapotranspiration` +
  `&timezone=Europe%2FZurich&past_days=7&forecast_days=5&models=meteoswiss_icon_ch2`;

// Repli ET₀ : modèle global (si le modèle suisse a des lacunes sur l'ET₀).
export const ET0_FALLBACK_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&daily=et0_fao_evapotranspiration&timezone=Europe%2FZurich&past_days=7&forecast_days=5`;

// Un seul trou (null) invalide la fenêtre 7 j du calcul d'objectif → on tente
// le repli global dès la moindre lacune, pas seulement si tout est null.
export const et0HasGaps = (a) => !Array.isArray(a) || a.length === 0 || a.some((x) => x == null || !Number.isFinite(x));

// Fetch + normalisation. Lève en cas d'échec réseau/réponse vide (l'appelant
// décide du cache/bandeau). Le repli ET₀ est best-effort et silencieux.
export async function fetchWeatherData() {
  const res = await fetch(API_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('météo HTTP ' + res.status);
  const data = await res.json();
  if (!data?.daily?.time?.length) throw new Error('réponse météo vide');
  let et0 = data.daily.et0_fao_evapotranspiration;
  if (et0HasGaps(et0)) {
    try {
      const r2 = await fetch(ET0_FALLBACK_URL, { cache: 'no-store' });
      if (r2.ok) {
        const d2 = await r2.json();
        const alt = d2?.daily?.et0_fao_evapotranspiration;
        if (!et0HasGaps(alt)) et0 = alt;
      }
    } catch { /* on garde la série suisse (l'objectif se repliera sur 28 si besoin) */ }
  }
  return {
    time: data.daily.time,
    precipitation_sum: data.daily.precipitation_sum,
    precipitation_probability_max: data.daily.precipitation_probability_max,
    temperature_2m_max: data.daily.temperature_2m_max,
    et0,
  };
}
