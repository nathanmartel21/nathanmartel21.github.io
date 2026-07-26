/* Garmin Premium PWA service worker.
   Caches the app shell so the dashboard opens offline. User data lives in
   localStorage and POSTs to the relay backend are never cached. */

const VERSION = 'garmin-pwa-v9';
const CORE_CACHE = `${VERSION}-core`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// App-shell files (relative to the SW scope, i.e. /garmin/).
const CORE_ASSETS = [
  './',
  './index.html',
  './app.html',
  './graphs.html',
  './coach.html',
  './perf.html',
  './manifest.webmanifest',
  './icon.svg',
  './icons-192.png',
  './icons-512.png',
  './apple-touch-icon.png',
  './css/garmin.css?v=9',
  './js/config.js?v=9',
  './js/api.js?v=9',
  './js/import.js?v=9',
  './js/weather.js?v=9',
  './js/app.js?v=9',
  './js/ai.js?v=9',
  './js/ai-key.js?v=9',
  './js/ai-unlock.js?v=9',
  './js/analysis.js?v=9',
  './js/notifications.js?v=9',
  './js/demo.js?v=9',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      // Best-effort: a missing optional asset must not abort the install.
      .then((cache) => Promise.allSettled(CORE_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CORE_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// --- Web Push: hydration + session-of-the-day reminders ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Garmin Premium';
  const options = {
    body: data.body || '',
    icon: './icons-192.png',
    badge: './icons-192.png',
    tag: data.tag || 'garmin-reminder',
    data: { url: data.url || './app.html' },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './app.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never touch the relay login / data POSTs.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Page navigations: network-first, fall back to cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate.
  if (sameOrigin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Cross-origin CDN (Chart.js, Google Fonts): cache-first.
  if (/(jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)/.test(url.host)) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          return res;
        }).catch(() => cached)
      )
    );
  }
});
