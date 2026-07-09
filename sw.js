// sw.js — service worker : cache hors-ligne de l'app + (étape 4) réception des push.
// Bump VERSION à chaque déploiement pour invalider l'ancien cache.
const VERSION = 'cp-v1';

// Coquille de l'app (même origine) préchargée à l'installation.
const CORE = [
  './', './index.html', './styles.css', './app.js', './engine.js', './store.js',
  './config.js', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
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

  // Même origine : navigation → network-first (maj appliquée en ligne, cache si offline),
  // assets → stale-while-revalidate (affichage instantané + maj en arrière-plan).
  if (url.origin === self.location.origin) {
    e.respondWith(req.mode === 'navigate' ? networkFirst(req) : staleWhileRevalidate(req));
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
  } catch (e) { return hit || Response.error(); }
}

async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (e) {
    return (await c.match(req)) || (await c.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req);
  const net = fetch(req)
    .then((res) => { if (res.ok) c.put(req, res.clone()); return res; })
    .catch(() => hit);
  return hit || net;
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
