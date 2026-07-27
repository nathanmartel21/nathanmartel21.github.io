/* Meilleur plein — minimal PWA service worker.
   Caches the app shell so it opens instantly / offline. Fuel-price API calls
   (data.economie.gouv.fr) are always fetched live, never cached. */

const VERSION = 'essence-v1';
const CORE = `${VERSION}-core`;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CORE)
    .then((c) => Promise.allSettled(ASSETS.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CORE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never cache the live fuel-price API.
  if (url.hostname.endsWith('economie.gouv.fr')) return;

  // App shell: same-origin → cache-first, fall back to network.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(request).then((c) => c || fetch(request)));
  }
});
