// ============================================================
// sw.js  –  Star Track Service Worker
// Cache-first for local assets · Network-first for CDN
// ============================================================

const CACHE_VERSION = 'startrack-v12';
const CDN_CACHE     = 'startrack-cdn-v1';

const LOCAL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/astronomy.js',
  './js/renderer.js',
  './js/data/stars.js',
  './js/data/constellations.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/astronomy-engine@2/astronomy.browser.min.js',
  'https://fonts.googleapis.com/css2?family=Antonio:wght@400;700&family=Share+Tech+Mono&display=swap',
];

// ── Install: pre-cache all local assets ─────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(LOCAL_ASSETS))
      // Don't call skipWaiting() here — wait for user confirmation (update banner)
  );
});

// ── Activate: purge old caches, notify clients ──────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => {
      // Tell all open tabs a new version is now active
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED' }));
      });
      return self.clients.claim();
    })
  );
});

// ── Message: allow client to trigger skipWaiting ────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Fetch: cache-first local, network-first CDN ─────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  // CDN resources: network-first, fall back to cache
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (!res || res.status !== 200) return res;
          const clone = res.clone();
          caches.open(CDN_CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Local assets: cache-first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
