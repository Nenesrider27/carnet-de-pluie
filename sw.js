// sw.js — service worker : cache hors-ligne de l'app + (étape 4) réception des push.
// Bump VERSION à chaque déploiement pour invalider l'ancien cache.
const VERSION = 'cp-v11';

// Coquille de l'app (même origine) préchargée à l'installation.
const CORE = [
  './', './index.html', './styles.css', './app.js', './engine.js', './store.js', './weather.js',
  './config.js', './auth.js', './domicile.js', './geocode.js', './vendor/auth-js.js',
  './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // APIs dynamiques : jamais mises en cache par le SW.
  // L'app gère elle-même l'offline (cache localStorage + bandeaux).
  if (url.hostname.endsWith('open-meteo.com') || url.hostname.endsWith('supabase.co')) return;

  // Google Fonts : immuables → cache-first (dispo hors-ligne après 1re visite).
  if (url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Même origine (coquille app) : cache-first depuis le cache VERSIONNÉ.
  // Crucial : HTML, JS et CSS proviennent TOUS du même déploiement (une version
  // de cache = un déploiement atomique) → jamais de mélange ancien-JS/nouveau-HTML.
  // La mise à jour se fait via le bump de VERSION (nouveau SW → nouveau cache).
  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (e) {
    if (req.mode === 'navigate') return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
    return Response.error();
  }
}

// --- Notifications push (câblées à l'étape 4) --------------------------
self.addEventListener('push', (e) => {
  let data = { title: 'Carnet de pluie', body: '' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    lang: 'fr',
    tag: 'carnet-de-pluie',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
