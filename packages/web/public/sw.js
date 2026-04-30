/// <reference lib="webworker" />

const DB_NAME = 'cmux-relay-sw';
const DB_VERSION = 1;
const NAV_STORE = 'pending-nav';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NAV_STORE)) {
        db.createObjectStore(NAV_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingNavigation(data) {
  const db = await openDB();
  const tx = db.transaction(NAV_STORE, 'readwrite');
  tx.objectStore(NAV_STORE).put(data, 'latest');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', () => {
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'CmuxRelay';
  const options = {
    body: data.body || '',
    data: {
      workspaceId: data.workspaceId || null,
      surfaceId: data.surfaceId || null,
    },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { workspaceId, surfaceId } = event.notification.data || {};

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // Send navigation data directly to the already-open client
          if (workspaceId) {
            client.postMessage({ type: 'NAVIGATE', workspaceId, surfaceId });
          }
          return client.focus();
        }
      }
      // No existing client — save for app to read on launch
      if (workspaceId) {
        await savePendingNavigation({ workspaceId, surfaceId });
      }
      return self.clients.openWindow('/terminal');
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', () => {
  // Client will re-subscribe on next connect
});
