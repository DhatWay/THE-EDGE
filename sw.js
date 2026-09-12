// ============================================================
// EDGE — Service Worker
// Network-first for everything. Cache is offline fallback only.
// No version numbers to bump. Updates are instant on reload.
// ============================================================

const CACHE = 'edge-runtime-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clear any old caches from previous SW versions
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET. Skip anything else (POST to Supabase, etc.)
  if (req.method !== 'GET') return;

  // Skip cross-origin (ESPN, Odds API, Supabase, fonts)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // Try the network first. Always.
    const fresh = await fetch(req, { cache: 'no-store' });
    // Cache the fresh copy for offline use
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    // Network failed (offline). Fall back to cache.
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}