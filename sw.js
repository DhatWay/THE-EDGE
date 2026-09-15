// ============================================================
// EDGE — Service Worker v2
// App shell is precached so every page opens offline.
// Network-first at runtime so a reload always gets fresh code.
// ============================================================

const VERSION = 'edge-v2';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const SHELL_FILES = [
  './',
  './index.html',
  './matchups.html',
  './picks.html',
  './parlay.html',
  './analysis.html',
  './algorithms.html',
  './power.html',
  './lines.html',
  './intelligence.html',
  './history.html',
  './performance.html',
  './betting.html',
  './settings.html',
  './admin.html',
  './diagnostic.html',
  './data.html',
  './power-engine.js',
  './algorithms.js',
  './governor.js',
  './physics.js',
  './claude.js',
  './context-builder.js',
  './team-aliases.js',
  './orchestrator.js',
  './learning.js',
  './parlay.js',
  './trends-engine.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One bad URL must not fail the whole install.
      await Promise.all(SHELL_FILES.map(f =>
        cache.add(new Request(f, { cache: 'reload' })).catch(() => {})
      ));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin app files: network first, cache as the offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Read-only Supabase and ESPN data: serve from cache when the network is
  // gone so dashboards still render something truthful and timestamped.
  if (isCacheableApi(url)) {
    event.respondWith(networkFirstApi(req));
  }
});

function isCacheableApi(url) {
  return url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/')
      || url.hostname === 'site.api.espn.com';
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cached = await cache.match(req) || await cache.match('./index.html');
    if (cached) return cached;
    throw e;
  }
}

async function networkFirstApi(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Edge-Offline': '1' },
    });
  }
}