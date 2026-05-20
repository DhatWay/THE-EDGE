const CACHE = 'edge-v1';

const STATIC = [
  '/',
  '/index.html',
  '/matchups.html',
  '/picks.html',
  '/analysis.html',
  '/algorithms.html',
  '/power.html',
  '/lines.html',
  '/history.html',
  '/performance.html',
  '/betting.html',
  '/settings.html',
  '/admin.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API calls, cache first for static
  if (e.request.url.includes('api.')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
