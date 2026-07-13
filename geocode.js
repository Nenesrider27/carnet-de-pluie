// geocode.js — Aide au réglage du domicile : trouver ses coordonnées.
// =====================================================================
// Petit module de géocodage pour l'écran « Réglages » : l'utilisateur tape
// une adresse (ou clique « Ma position ») et on en tire un couple lat/lon
// à passer à la météo. AUCUNE dépendance, `fetch` global (navigateur ET
// Node ≥ 18, car les tests importent ce module et mockent `fetch`).
//
// Deux fournisseurs, deux usages :
//   - Open-Meteo (PRIMAIRE)  : même maison que la météo, CORS ouvert, sans clé,
//     sans quota gênant. Suffisant à l'échelle ville/village.
//   - Nominatim/OSM (FALLBACK): précision « rue », mais politique d'usage stricte
//     (voir en tête de geocodeAddressPrecise). À n'appeler QU'AU SUBMIT.
//
// La grille météo d'Open-Meteo (modèle ICON CH2) a une maille d'environ 2 km :
// inutile de viser le numéro de rue, la commune suffit très largement. D'où le
// choix d'Open-Meteo en primaire et le round4 (~11 m) sur les coordonnées.
// =====================================================================

// --- Arrondi coordonnées ------------------------------------------------
// 4 décimales ≈ 11 m au sol. Largement en-dessous de la maille météo (~2 km),
// et ça évite de trimballer 15 décimales inutiles dans le stockage/les URLs.
export function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// --- PRIMAIRE : géocodage Open-Meteo ------------------------------------
// Recherche au niveau ville/village (PAS la rue complète) — c'est le point
// fort d'Open-Meteo et c'est amplement suffisant vu la grille de 2 km.
// API publique, CORS ouvert, sans clé — même fournisseur que la météo.
// Renvoie un tableau d'objets normalisés (jusqu'à 5 propositions) :
//   { label, lat, lon, timezone, admin, country }
//   - label   : nom lisible « Ville, Région, Pays » (parties vides retirées)
//   - lat/lon : arrondis à 4 décimales (round4)
//   - timezone: fuseau IANA renvoyé par l'API (ex. 'Europe/Zurich')
//   - admin   : région/canton (champ admin1)
//   - country : pays lisible
// `results` absent ou vide → [] (pas d'erreur : « aucune correspondance »).
// Échec réseau ou HTTP non-ok → LÈVE une Error explicite (l'appelant affiche
// un bandeau ; on ne masque jamais une panne derrière un tableau vide).
export async function geocodeAddress(query) {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(query)}&count=5&language=fr&format=json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('géocodage HTTP ' + res.status);
  const data = await res.json();

  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) return [];

  return results.map((r) => {
    // Label lisible : on assemble les parties non vides pour éviter
    // « Anières, , Suisse » quand admin1 manque.
    const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
    return {
      label,
      lat: round4(r.latitude),
      lon: round4(r.longitude),
      timezone: r.timezone,
      admin: r.admin1,
      country: r.country,
    };
  });
}

// --- FALLBACK : précision « rue » via Nominatim (OpenStreetMap) ---------
// POLITIQUE D'USAGE OSM — à respecter scrupuleusement (service gratuit et
// bénévole ; un abus fait bannir l'IP) :
//   - MAX 1 requête/seconde (pas de rafale, pas de bulk).
//   - À N'APPELER QU'AU SUBMIT du formulaire — JAMAIS en autocomplétion ni
//     « à la frappe ». (L'autocomplétion, c'est le rôle d'Open-Meteo ci-dessus.)
//   - ATTRIBUTION obligatoire : afficher « © OpenStreetMap » à côté du résultat.
//   - Un Referer identifiant l'app est attendu ; dans un navigateur il est
//     envoyé automatiquement (domaine de la page) — rien à faire côté code.
// Renvoie un tableau normalisé (jusqu'à 5 propositions) :
//   { label: display_name, lat: round4(Number(lat)), lon: round4(Number(lon)) }
// Échec réseau ou HTTP non-ok → LÈVE une Error explicite.
export async function geocodeAddressPrecise(query) {
  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&limit=5`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('géocodage précis HTTP ' + res.status);
  const data = await res.json();

  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    label: r.display_name,
    lat: round4(Number(r.lat)),
    lon: round4(Number(r.lon)),
  }));
}

// --- Géocodage inverse : coordonnées → label lisible (best-effort) ------
// Utile après « Ma position » pour montrer à l'utilisateur OÙ on l'a situé.
// zoom=14 ≈ niveau village/quartier — cohérent avec la grille météo, inutile
// de descendre au numéro. Politique OSM identique (voir ci-dessus) : usage
// ponctuel, au clic, pas en boucle.
// BEST-EFFORT : ne LÈVE JAMAIS. Renvoie { label } sur succès, sinon null
// (un libellé manquant ne doit pas casser le réglage des coordonnées).
export async function reverseGeocode(lat, lon) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse' +
      `?lat=${lat}&lon=${lon}&format=jsonv2&zoom=14&addressdetails=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.display_name) return null;
    return { label: data.display_name };
  } catch {
    return null; // best-effort : une panne réseau ne casse rien.
  }
}

// --- Géolocalisation du navigateur (« Ma position ») --------------------
// Enveloppe l'API callback `navigator.geolocation.getCurrentPosition` dans
// une Promise, avec une haute précision et un timeout raisonnable.
// Résout { lat, lon } arrondis (round4). Rejette avec un message CLAIR selon
// le code d'erreur (1/2/3) pour guider l'utilisateur.
//
// NOTE : ce module est aussi importé sous Node (par les tests) où `navigator`
// n'existe pas — d'où la garde sur globalThis.navigator, qui rejette proprement
// plutôt que de planter sur un accès à `undefined`.
export async function currentPosition() {
  const nav = globalThis.navigator;
  if (!nav || !nav.geolocation) {
    throw new Error("La géolocalisation n'est pas disponible sur cet appareil.");
  }

  return new Promise((resolve, reject) => {
    nav.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: round4(pos.coords.latitude),
          lon: round4(pos.coords.longitude),
        });
      },
      (err) => {
        // Codes standard de PositionError : 1=PERMISSION_DENIED,
        // 2=POSITION_UNAVAILABLE, 3=TIMEOUT.
        let msg;
        switch (err?.code) {
          case 1:
            msg = 'Autorise la localisation, ou tape ton adresse.';
            break;
          case 2:
            msg = 'Position indisponible pour le moment. Réessaie ou tape ton adresse.';
            break;
          case 3:
            msg = 'La localisation a mis trop de temps. Réessaie ou tape ton adresse.';
            break;
          default:
            msg = 'Impossible de te localiser. Tape ton adresse.';
        }
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}
