// sw.js – simple app-shell cache for dev

const CACHE_NAME = 'osm-route-planner-v1';

// Use only files you are 100% sure exist right now.
// We can add icons etc. later once they’re in place.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest'
  // './icons/icon-192.png',
  // './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        // Log but don't block install completely
        console.error('SW install: cache.addAll failed', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

// Cache-first for app shell; network for everything else
self.addEventListener('fetch', (event) => {
  const { request } = event;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request);
    })
  );
});
