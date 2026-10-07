// Service Worker - Baba Veteranos v42: app shell e dependências locais offline.
const CACHE_NAME = 'baba-veteranos-v42';
const BASE_URL = new URL('./', self.registration.scope);
const APP_ROOT = BASE_URL.pathname;
const INDEX_URL = new URL('index.html', BASE_URL).href;
const INDEX_PATHNAME = new URL('index.html', BASE_URL).pathname;
const OFFLINE_URL = new URL('offline.html', BASE_URL).href;
const CORE_FILES = [
  './',
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'vendor/jspdf/jspdf.umd.min.js',
  'vendor/jspdf/jspdf.plugin.autotable.min.js',
  'vendor/firebase/firebase-app-compat.js',
  'vendor/firebase/firebase-database-compat.js',
  'vendor/firebase/firebase-auth-compat.js',
  'vendor/tailwind/tailwind.browser.js',
  'vendor/fontawesome/css/all.min.css',
  'vendor/fontawesome/webfonts/fa-brands-400.ttf',
  'vendor/fontawesome/webfonts/fa-brands-400.woff2',
  'vendor/fontawesome/webfonts/fa-regular-400.ttf',
  'vendor/fontawesome/webfonts/fa-regular-400.woff2',
  'vendor/fontawesome/webfonts/fa-solid-900.ttf',
  'vendor/fontawesome/webfonts/fa-solid-900.woff2',
  'vendor/fontawesome/webfonts/fa-v4compatibility.ttf',
  'vendor/fontawesome/webfonts/fa-v4compatibility.woff2'
].map(path => new URL(path, BASE_URL).href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('baba-veteranos-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const requestUrl = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok && requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith(APP_ROOT)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
          if (requestUrl.pathname === APP_ROOT || requestUrl.pathname === INDEX_PATHNAME) {
            await cache.put(INDEX_URL, response.clone());
          }
        }
        return response;
      } catch (_) {
        return (await caches.match(request, { ignoreSearch: true }))
          || (await caches.match(INDEX_URL))
          || (await caches.match(OFFLINE_URL));
      }
    })());
    return;
  }

  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith(APP_ROOT)) {
    event.respondWith((async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (_) {
        return new Response('Recurso indisponível sem conexão.', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
  }
});

self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'Nova notificação do Baba Veteranos',
      icon: new URL('icon-192.png', BASE_URL).href,
      badge: new URL('icon-192.png', BASE_URL).href,
      vibrate: [200, 100, 200],
      silent: false,
      data: { url: data.url || BASE_URL.href }
    };
    event.waitUntil(self.registration.showNotification(data.title || '⚽ Baba Veteranos', options));
  } catch (_) {}
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'SHOW_NOTIFICATION') return;
  const options = {
    body: event.data.body || '',
    icon: new URL('icon-192.png', BASE_URL).href,
    badge: new URL('icon-192.png', BASE_URL).href,
    vibrate: [200, 100, 200],
    silent: false,
    tag: event.data.tag || 'baba-notification',
    data: { url: event.data.url || BASE_URL.href }
  };
  self.registration.showNotification(event.data.title || '⚽ Baba Veteranos', options);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || BASE_URL.href;
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(windowClients => {
    const client = windowClients.find(item => item.url.includes(APP_ROOT));
    if (client) {
      client.focus();
      client.postMessage({ type: 'NOTIFICATION_CLICKED', tag: event.notification.tag });
    } else {
      self.clients.openWindow(url);
    }
  }));
});
