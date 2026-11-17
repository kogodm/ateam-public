// Minimal service worker: exists so Chrome treats the app as installable
// (its PWA install prompt historically requires one). Pure pass-through —
// no caching: the UI is served by the desktop / relay and must stay fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
