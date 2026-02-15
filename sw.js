// Service Worker für No Spoiler League
// Strategie: Network First - immer zuerst vom Server laden

const CACHE_NAME = 'nospoiler-v2';

// Bei Installation: Nichts cachen, wir wollen immer frische Daten
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Bei Aktivierung: Alte Caches löschen
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch: Network First Strategie
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Für links.json und spielplan.json: IMMER vom Netzwerk
    if (url.pathname.includes('links.json') || 
        url.pathname.includes('spielplan.json') ||
        url.pathname.includes('tabelle.json')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return;
    }
    
    // Für HTML: Network First mit Fallback
    if (event.request.mode === 'navigate' || 
        url.pathname.endsWith('.html') ||
        url.pathname === '/' ||
        url.pathname === '') {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .then((response) => {
                    // Erfolgreiche Antwort cachen für Offline
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }
    
    // Für statische Assets (Bilder, CSS): Cache First
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                if (response) {
                    return response;
                }
                return fetch(event.request).then((response) => {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                    return response;
                });
            })
    );
});

// Nachricht zum Aktualisieren
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
