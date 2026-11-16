// Service worker : l'appli s'ouvre même sans réseau.
const VERSION = 'hikaku-1.2.0';
const SHELL = [
  './', 'index.html', 'css/style.css', 'css/sage.css', 'css/manga.css', 'css/jpop.css',
  'js/app.js', 'js/db.js', 'js/id3.js', 'js/player.js', 'js/radio.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Fichiers de l'appli : réponse immédiate depuis le cache, mise à jour en arrière-plan.
// Tout le reste (radios, annuaire) passe directement par le réseau.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => {
      if (r.ok && r.type === 'basic') cache.put(req, r.clone());
      return r;
    }).catch(() => hit || Response.error());
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  })());
});
