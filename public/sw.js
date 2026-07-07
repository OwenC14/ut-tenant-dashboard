const CACHE_NAME = 'ut-dashboard-v1';
const SHELL = ['/dashboard.html', '/index.html', '/style.css', '/dashboard.js', '/login.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/auth/')) {
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
