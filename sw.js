// Service Worker - BABA VETERANOS v2 - Cache atualizado
const CACHE_NAME = 'baba-veteranos-v2';
const urlsToCache = [
  '/Baba-veteranos/',
  '/Baba-veteranos/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    }).then(() => clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate' || 
      (event.request.url.includes('/Baba-veteranos/') && event.request.url.endsWith('.html'))) {
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).catch(() => response);
    })
  );
});

self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'Nova notificação do Baba Veteranos',
      icon: '/Baba-veteranos/icon.png',
      badge: '/Baba-veteranos/icon.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/Baba-veteranos/' }
    };
    event.waitUntil(
      self.registration.showNotification(
        data.title || '⚽ Baba Veteranos',
        options
      )
    );
  } catch (e) {}
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const options = {
      body: event.data.body || '',
      icon: '/Baba-veteranos/icon.png',
      badge: '/Baba-veteranos/icon.png',
      vibrate: [200, 100, 200],
      tag: event.data.tag || 'baba-notification',
      data: { url: event.data.url || '/Baba-veteranos/' }
    };
    self.registration.showNotification(
      event.data.title || '⚽ Baba Veteranos',
      options
    );
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/Baba-veteranos/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      const client = windowClients.find(c => c.url.includes('/Baba-veteranos/'));
      if (client) {
        client.focus();
        client.postMessage({ type: 'NOTIFICATION_CLICKED', tag: event.notification.tag });
      } else {
        clients.openWindow(url);
      }
    })
  );
});