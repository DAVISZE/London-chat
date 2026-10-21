const CACHE = 'london-family-v1';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([self.registration.scope, new URL('manifest.webmanifest', self.registration.scope).href, new URL('icon.svg', self.registration.scope).href]))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(self.registration.scope))));
});
self.addEventListener('push', event => {
  const data = event.data?.json?.() || { title: 'London Family Tracker', body: 'Você tem uma nova atualização.' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.svg' }));
});
