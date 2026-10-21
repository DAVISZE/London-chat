const CACHE = 'london-family-v2';
const APP_SHELL = self.registration.scope;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([
      APP_SHELL,
      new URL('manifest.webmanifest', APP_SHELL).href,
      new URL('icon.svg', APP_SHELL).href,
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('london-family-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  const isNavigation = request.mode === 'navigate';
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {}));
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (isNavigation) return (await caches.match(APP_SHELL)) || Response.error();
      return Response.error();
    }
  })());
});

self.addEventListener('push', event => {
  const data = event.data?.json?.() || { title: 'London Family Tracker', body: 'Você tem uma nova atualização.' };
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: new URL('icon.svg', self.registration.scope).href,
  }));
});
