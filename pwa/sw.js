/* Service worker — the app shell, offline.
 *
 * Everything before the upload (staging files, checks, the generated README) is
 * local work, so it should not need the network. The shell is precached on
 * install; documents and scripts are network-first so an edit reaches people on
 * the next load, with the cache as the offline fallback; fonts, icons and images
 * are cache-first because they change only when the app does.
 *
 * Cross-origin requests are left alone: the Hub client, the Hub API and GitHub
 * must never be answered from a cache.
 */
const CACHE = 'hub-uploader-v4';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './hub-uploader.js',
  './manifest.json',
  './assets/icons.svg',
  './assets/hub-uploader-icon.svg',
  './assets/favicon-32.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/fonts/dmseriftext-latin.woff2',
  './assets/fonts/publicsans-latin.woff2',
];

self.addEventListener('install', (event) => {
  // Deliberately not addAll(): it is atomic, so a single stale path rejects the
  // whole batch and the app silently ends up with no offline shell at all. That
  // happened once already, when a font was renamed. One request each instead.
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(
      SHELL.map((url) => cache.add(url).catch((e) => {
        console.warn('[sw] not cached:', url, e && e.message);
      }))
    ))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isAsset = /\.(woff2?|png|jpe?g|svg|webp)$/.test(url.pathname) ||
                  url.pathname.endsWith('manifest.json');

  if (isAsset) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
  );
});
