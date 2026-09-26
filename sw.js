// ============================================================
// EDGE — Service Worker v2
// App shell is precached so every page opens offline.
// Network-first at runtime so a reload always gets fresh code.
//
// v2 — VERSION bumped. Any browser that has the old service
// worker installed will not fetch new files until the cache
// name changes, because the install handler only runs when the
// script bytes differ and the activate handler keeps whichever
// caches match the current names. Bumping VERSION creates new
// cache names, so activate drops the old ones and the next load
// pulls the fresh modules. Every code fix deployed before this
// bump was sitting behind the old cache on any installed device.
//
// Every current engine is now precached. score-backfill,
// situations-engine, situation-results, backfill and the
// prop-trends file were all missing from v1, so a browser that
// loaded a page using one of them offline would 404 the script
// and the page would fail silently at the first call.
//
// The v3.1 fetch rules are retained:
//   · Only scoreboard reads are cacheable on ESPN. Teams,
//     rosters, summaries and injuries always go to the network
//     because a cached empty array there poisons the next run.
//   · The offline fallback is never stored, so a transient
//     network failure cannot become a permanent poisoned cache.
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
  './slate.html',
  './test-espn.html',
  './login.html',

  // Core rating and pipeline engines
  './rating-core.js',
  './power-engine.js',
  './algorithms.js',
  './governor.js',
  './physics.js',
  './claude.js',
  './context-builder.js',
  './team-aliases.js',

  // Rosters, injuries, ATS, trends
  './roster-engine.js',
  './roster-enrichment.js',
  './injury-fragmentation.js',
  './ats-tracker.js',
  './trends-engine.js',
  './prop-trends-engine.js',
  './box-score-fetcher.js',

  // Situations and scoring
  './situations-engine.js',
  './situation-results.js',
  './score-backfill.js',

  // Calibration
  './backfill.js',

  // Orchestration
  './orchestrator.js',
  './learning.js',
  './parlay.js',
  './auth.js',

  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
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

  // Same-origin app files: network first, cache as offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Supabase REST + ESPN scoreboard only. Everything else passes
  // straight through to the network untouched.
  if (isCacheableApi(url)) {
    event.respondWith(networkFirstApi(req));
  }
});

// Only these reads are safe to cache:
//   · Supabase /rest/v1/  — dashboards benefit from a stale read
//   · ESPN /scoreboard    — the one endpoint whose empty response is
//                           meaningful (no games today is real data)
//
// Everything else on ESPN — /teams, /roster, /summary, /injuries,
// /events/*/odds — must hit the network every time. Those endpoints
// do not have a meaningful empty response; a cached [] there
// silently breaks the roster build, the box score fetch, and the
// ATS odds resolver.
function isCacheableApi(url) {
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/')) {
    return true;
  }
  if (url.hostname === 'site.api.espn.com') {
    return /\/scoreboard\b/.test(url.pathname);
  }
  return false;
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
    // Only cache successful responses. A cached error or empty body
    // would poison the next run — that is exactly what broke the
    // roster build under v3.
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // The offline fallback is NOT stored. It is handed to the caller
    // once and forgotten, so the next attempt hits the real network.
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Edge-Offline': '1' },
    });
  }
}