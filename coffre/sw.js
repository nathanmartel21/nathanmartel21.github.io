/* Coffre — minimal PWA service worker. Caches the app shell so it opens offline.
   The vault ciphertext lives in localStorage (never touched here); the geo/IP
   access-check calls are cross-origin and never cached. */

const VERSION = 'coffre-v2';
const CORE = `${VERSION}-core`;
const ASSETS = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png'];

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
  if (url.origin !== self.location.origin) return;   // never cache cross-origin (geo/IP)
  e.respondWith(caches.match(request).then((c) => c || fetch(request)));
});

// --- Web Push: coffre security alerts ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || '🔐 Coffre', {
    body: data.body || '', icon: './icon-192.png', badge: './icon-192.png',
    tag: data.tag || 'coffre-alert', requireInteraction: true, vibrate: [80, 40, 80]
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  }));
});
