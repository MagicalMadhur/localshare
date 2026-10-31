const CACHE_NAME = 'localshare-v11';
const ASSETS = [
    './',
    './index.html',
    './style.css?v=11',
    './app.js?v=11',
    './manifest.json',
    './icon.svg'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    // Only handle GET requests originating from our own domain.
    // Non-GET requests (POST uploads, etc.) or cross-origin requests must bypass
    // the Service Worker so browser XMLHttpRequest/fetch streams upload progress in real-time.
    if (e.request.method !== 'GET') return;
    try {
        const url = new URL(e.request.url);
        if (url.origin !== self.location.origin) return;
    } catch (err) {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseClone));
                }
                return response;
            })
            .catch(() => caches.match(e.request))
    );
});
