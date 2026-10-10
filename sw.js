// Network-first app shell cache: always fresh when online, still opens when the con Wi-Fi dies.
const CACHE = 'nycc-hunt-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const cacheable = e.request.method === 'GET' &&
    (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com');
  // Firestore traffic goes to firestore.googleapis.com and is never cached here.
  if (!cacheable) return;
  // Same-origin files revalidate every load (cheap 304s) so phones never run a stale app version.
  const req = url.origin !== location.origin ? e.request
    : e.request.mode === 'navigate' ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
