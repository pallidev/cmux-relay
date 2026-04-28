const DB_NAME = 'cmux-relay-sw';
const DB_VERSION = 1;
const NAV_STORE = 'pending-nav';

function openDB(): Promise<IDBDatabase> {
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

export interface PendingNavigation {
  workspaceId: string;
  surfaceId: string | null;
}

export function onNavigateFromPush(callback: (nav: PendingNavigation) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'NAVIGATE') {
      callback({
        workspaceId: event.data.workspaceId,
        surfaceId: event.data.surfaceId ?? null,
      });
    }
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

export async function getPendingNavigation(): Promise<PendingNavigation | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(NAV_STORE, 'readwrite');
    const store = tx.objectStore(NAV_STORE);
    const req = store.get('latest');
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const result = req.result as PendingNavigation | undefined;
        if (result) {
          store.delete('latest');
        }
        resolve(result ?? null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => { db.close(); };
    });
  } catch {
    return null;
  }
}

export function getPendingNavigationFromStorage(): PendingNavigation | null {
  try {
    const raw = localStorage.getItem('cmux-relay-pending-nav');
    if (!raw) return null;
    localStorage.removeItem('cmux-relay-pending-nav');
    return JSON.parse(raw) as PendingNavigation;
  } catch {
    return null;
  }
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch (err) {
    console.error('[push] SW registration failed:', err);
    return null;
  }
}

export async function subscribePush(registration: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  if (!('PushManager' in window)) return null;

  try {
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const publicKey = await getVapidPublicKey();
      if (!publicKey) return null;

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await sendSubscriptionToServer(subscription);
    return subscription;
  } catch (err) {
    console.error('[push] Push subscription failed:', err);
    return null;
  }
}

async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) return null;
    const data = await res.json() as { publicKey: string };
    return data.publicKey;
  } catch {
    return null;
  }
}

async function sendSubscriptionToServer(subscription: PushSubscription): Promise<void> {
  const jwt = getJwt();
  if (!jwt) return;

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(subscription.toJSON()),
  });
}

export async function unsubscribePush(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) return;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const jwt = getJwt();
  if (jwt) {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  }
  await subscription.unsubscribe();
}

function getJwt(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
  return match ? match[1] : localStorage.getItem('cmux-relay-token') ?? null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const array = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    array[i] = rawData.charCodeAt(i);
  }
  return array;
}
