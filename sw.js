// Service Worker — offline support for language-hub.
//
// Strategy:
//   - /api/*               → network-only. Never cache API responses (would
//                            stale-cache grader/coach/Gemini results into
//                            chaos). When offline, these requests just fail
//                            with the existing error UI.
//   - HTML / navigations   → network-first, fall back to cache. So you always
//                            see the latest code when online, but offline
//                            you still get the last visited HTML.
//   - Everything else      → cache-first (fonts, icon, manifest). These rarely
//                            change; serving from cache is the offline win.
//
// Cache is versioned (LH_CACHE_VERSION). On a new deploy bump this; the
// activate handler cleans up old caches.
//
// Kill switch: if the service worker itself is broken, push a sw.js that
// just calls self.registration.unregister() in its install handler and
// every client will self-heal on next visit.

const LH_CACHE_VERSION = 'lh-cache-v1';

// Minimum resources to cache on install so the site loads from cache when
// offline. We add to this lazily as the user navigates.
const PRECACHE = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(LH_CACHE_VERSION).then(cache => cache.addAll(PRECACHE)).catch(() => {})
  );
  // Activate this SW immediately on first install so the user gets offline
  // support without needing to refresh the page.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete any caches from prior versions
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== LH_CACHE_VERSION).map(k => caches.delete(k)));
    // Take control of any open pages immediately
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Allow the page to tell us to activate a waiting SW immediately
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // We only handle GETs. POST (e.g. /api/*) goes through untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API calls — they're dynamic and offline-cached results
  // would be misleading (e.g. a stale grader response).
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin requests (CDNs, fonts, Supabase): cache-first.
  if (url.origin !== self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // HTML / navigations → network-first so deploys are picked up immediately.
  if (req.mode === 'navigate' || (req.destination === 'document') ||
      (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Everything else → cache-first.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    // Stash a copy for offline use. Don't cache opaque/redirected responses.
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const cache = await caches.open(LH_CACHE_VERSION);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    // Offline — try the cache.
    const cached = await caches.match(req);
    if (cached) return cached;
    // Last resort — serve the cached root so the user still sees the app shell.
    const root = await caches.match('/');
    if (root) return root;
    // Truly nothing cached. Let the browser show its offline page.
    throw e;
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(LH_CACHE_VERSION);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    // Don't transform the failure — let the browser handle it as a network error.
    throw e;
  }
}
