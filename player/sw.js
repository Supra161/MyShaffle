// Чтобы плеер открывался без интернета
const SHELL = 'mymusic-shell-v2';
const FILES = ['./', './index.html', './app.js?v=2', './manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  // сначала сеть (чтобы получать обновления), без сети — сохранённая копия
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(SHELL).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(r => r || caches.match('./index.html'))));
});
