/* Speed Math service worker: keeps the app shell cached so it installs on a
   home screen and practice mode works offline. Network-first, so updates
   arrive whenever the device is online. Live races always need the server. */
const VERSION = 'v1';
const CACHE = `speed-math-${VERSION}`;
const SHELL = ['/', '/index.html', '/styles.css', '/shared.js', '/app.js', '/questions.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/healthz' || url.pathname === '/ws') return;
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/'))) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
