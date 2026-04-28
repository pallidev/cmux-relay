# Mobile Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모바일 사파리/크롬에서 PWA 푸시 알림을 수신하고, 알림 클릭 시 해당 workspace/pane으로 자동 이동한다.

**Architecture:** Relay 서버에 VAPID 기반 Web Push 인프라를 추가하고, 웹 클라이언트를 PWA로 전환한다. Agent가 보낸 알림은 기존 WS 경로 + 새로운 Push 경로 양쪽으로 전달된다. 알림 클릭 시 Service Worker가 IndexedDB에 navigation 데이터를 저장하고, 앱이 열릴 때 이를 읽어 자동 이동한다.

**Tech Stack:** web-push (npm), VAPID, Service Worker API, IndexedDB, manifest.json

---

## Task 1: Relay DB — push_subscriptions 테이블 추가

**Files:**
- Modify: `packages/relay/src/db.ts:21-45`

- [ ] **Step 1: push_subscriptions 인터페이스와 테이블 추가**

`packages/relay/src/db.ts`의 `initDatabase` 함수 내 `db.exec()`에 테이블 추가, 파일 하단에 CRUD 함수 추가:

```typescript
// initDatabase의 db.exec() 안에 추가:
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
```

파일 하단에 추가:

```typescript
export interface PushSubscriptionRecord {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  user_agent: string | null;
  created_at: string;
}

export function upsertPushSubscription(
  db: Database.Database,
  userId: string,
  endpoint: string,
  p256dh: string,
  authKey: string,
  userAgent?: string,
): string {
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET p256dh = ?, auth_key = ?, user_agent = ? WHERE id = ?')
      .run(p256dh, authKey, userAgent ?? null, existing.id);
    return existing.id;
  }
  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth_key, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, endpoint, p256dh, authKey, userAgent ?? null);
  return id;
}

export function getPushSubscriptionsForUser(db: Database.Database, userId: string): PushSubscriptionRecord[] {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as PushSubscriptionRecord[];
}

export function deletePushSubscription(db: Database.Database, userId: string, endpoint: string): boolean {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
  return result.changes > 0;
}
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/relay typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/relay/src/db.ts
git commit -m "feat(relay): add push_subscriptions table and CRUD functions"
```

---

## Task 2: Relay — VAPID 키 관리 + push-sender 모듈

**Files:**
- Create: `packages/relay/src/push-sender.ts`
- Modify: `packages/relay/package.json`

- [ ] **Step 1: web-push 의존성 설치**

Run: `cd packages/relay && pnpm add web-push && pnpm add -D @types/web-push`

- [ ] **Step 2: push-sender.ts 작성**

`packages/relay/src/push-sender.ts`:

```typescript
import webpush from 'web-push';
import type Database from 'better-sqlite3';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPushSubscriptionsForUser } from './db.js';
import type { PushSubscriptionRecord } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PushNotificationPayload {
  title: string;
  body: string;
  workspaceId?: string;
  surfaceId?: string;
}

export function initVapidKeys(): { publicKey: string; privateKey: string; subject: string } {
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@cmux-relay.dev';

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject };
  }

  const keyPath = resolve(__dirname, '../.vapid-keys.json');
  if (existsSync(keyPath)) {
    const keys = JSON.parse(readFileSync(keyPath, 'utf-8')) as { publicKey: string; privateKey: string };
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    return { ...keys, subject };
  }

  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');

  // Convert raw DER to proper VAPID format (needs to be raw x/y coordinates)
  // web-push generateVAPIDKeys is the proper way:
  const vapidKeys = webpush.generateVAPIDKeys();
  writeFileSync(keyPath, JSON.stringify(vapidKeys, null, 2));
  webpush.setVapidDetails(subject, vapidKeys.publicKey, vapidKeys.privateKey);
  console.log('[relay] Generated new VAPID keys, saved to', keyPath);
  return { ...vapidKeys, subject };
}

export function sendPushToUser(
  db: Database.Database,
  userId: string,
  payload: PushNotificationPayload,
): void {
  const subscriptions = getPushSubscriptionsForUser(db, userId);
  const data = JSON.stringify(payload);

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key },
    };

    webpush.sendNotification(pushSubscription, data, {
      TTL: 86400,
      urgency: 'high',
    }).catch((err: Error) => {
      if (err.statusCode === 410) {
        // Subscription expired, remove it
        const dbAny = db as any;
        dbAny.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        console.log(`[relay] Removed expired push subscription: ${sub.endpoint.slice(0, 60)}...`);
      } else {
        console.error('[relay] Push send error:', err.message);
      }
    });
  }
}
```

- [ ] **Step 3: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/relay typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/push-sender.ts packages/relay/package.json pnpm-lock.yaml
git commit -m "feat(relay): add VAPID key management and push-sender module"
```

---

## Task 3: Relay — Push 구독 HTTP API + 세션 레지스트리 훅

**Files:**
- Modify: `packages/relay/src/http-handler.ts`
- Modify: `packages/relay/src/session-registry.ts`
- Modify: `packages/relay/src/index.ts`

- [ ] **Step 1: http-handler.ts에 push 구독 API 추가**

`packages/relay/src/http-handler.ts`의 import에 추가:

```typescript
import { upsertPushSubscription, deletePushSubscription } from './db.js';
```

`handleHttpRequest` 함수 내, `// Pairing endpoints` 주석 **이전**에 추가:

```typescript
  // Push subscription endpoints
  if (path === '/api/push/vapid-key' && req.method === 'GET') {
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY_CACHE;
    if (!vapidPublicKey) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Push not configured' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: vapidPublicKey }));
    return;
  }
```

인증이 필요한 섹션 (기존 `const user = await authenticateRequest(req);` 이후)에 추가:

```typescript
  if (path === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { endpoint: string; keys: { p256dh: string; auth: string } };
    if (!parsed.endpoint || !parsed.keys?.p256dh || !parsed.keys?.auth) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid subscription' }));
      return;
    }
    const userAgent = req.headers['user-agent'] || undefined;
    upsertPushSubscription(db, user.sub, parsed.endpoint, parsed.keys.p256dh, parsed.keys.auth, userAgent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/api/push/subscribe' && req.method === 'DELETE') {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { endpoint: string };
    const deleted = deletePushSubscription(db, user.sub, parsed.endpoint);
    res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(deleted ? { ok: true } : { error: 'Not found' }));
    return;
  }
```

- [ ] **Step 2: session-registry.ts에 push 전송 훅 추가**

`packages/relay/src/session-registry.ts` 수정. import 추가:

```typescript
import type Database from 'better-sqlite3';
import { sendPushToUser } from './push-sender.js';
```

`SessionRegistry` 클래스에 db 프로퍼티와 push 알림 훅 추가:

```typescript
export class SessionRegistry {
  private sessions = new Map<string, ActiveSession>();
  private agentMap = new Map<WebSocket, string>();
  private clientMap = new Map<WebSocket, string>();
  private db: Database.Database | null = null;

  setDatabase(db: Database.Database): void {
    this.db = db;
  }
```

`handleAgentMessage` 메서드의 `msg.type === 'agent.data'` 블록 내, 클라이언트 전달 **이후**에 push 전송 추가:

```typescript
    if (msg.type === 'agent.data') {
      const payload = JSON.stringify(msg.payload);
      const clientCount = session.clients.filter(c => c.ws.readyState === WebSocket.OPEN).length;
      console.log(`[relay] Forwarding ${(msg.payload as any).type} to ${clientCount} clients (session=${sessionId})`);
      for (const client of session.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }

      // Send push notifications for notification messages when no clients connected
      if ((msg.payload as any).type === 'notifications' && clientCount === 0 && this.db) {
        const notifs = (msg.payload as any).payload?.notifications as Array<{ title: string; subtitle: string; body: string; workspaceId?: string; surfaceId?: string }>;
        if (notifs && notifs.length > 0) {
          for (const n of notifs) {
            sendPushToUser(this.db, session.userId, {
              title: n.title,
              body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body,
              workspaceId: n.workspaceId,
              surfaceId: n.surfaceId,
            });
          }
        }
      }
    }
```

- [ ] **Step 3: index.ts에 VAPID 초기화와 DB 전달 추가**

`packages/relay/src/index.ts`의 import에 추가:

```typescript
import { initVapidKeys } from './push-sender.js';
```

`const db = initDatabase(DB_PATH);` 이후에 추가:

```typescript
// Initialize VAPID keys for push notifications
const vapidKeys = initVapidKeys();
process.env.VAPID_PUBLIC_KEY_CACHE = vapidKeys.publicKey;
registry.setDatabase(db);
```

서버 시작 로그에 VAPID 정보 추가:

```typescript
console.log(`[relay] Push notifications: ${vapidKeys.publicKey ? 'enabled' : 'disabled'}`);
```

- [ ] **Step 4: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/relay typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/http-handler.ts packages/relay/src/session-registry.ts packages/relay/src/index.ts
git commit -m "feat(relay): add push subscription API and notification push hook"
```

---

## Task 4: Web — PWA manifest + Service Worker

**Files:**
- Create: `packages/web/public/manifest.json`
- Create: `packages/web/public/sw.js`
- Modify: `packages/web/index.html`

- [ ] **Step 1: manifest.json 작성**

`packages/web/public/manifest.json`:

```json
{
  "name": "cmux-relay",
  "short_name": "cmux-relay",
  "description": "Monitor and control cmux terminals from mobile",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#1a1a2e",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

- [ ] **Step 2: Service Worker 작성**

`packages/web/public/sw.js`:

```js
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
  const title = data.title || 'cmux-relay';
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
      if (workspaceId) {
        await savePendingNavigation({ workspaceId, surfaceId });
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The app will re-subscribe on next load; this is a best-effort update
  event.waitUntil(
    self.registration.pushManager.getSubscription().then(() => {
      // Subscription will be re-sent by the client on next connect
    }),
  );
});
```

- [ ] **Step 3: index.html에 PWA 메타 태그 추가**

`packages/web/index.html`의 `<head>` 내에 `<title>` 이후 추가:

```html
    <link rel="manifest" href="/manifest.json" />
    <meta name="theme-color" content="#1a1a2e" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
```

- [ ] **Step 4: 플레이스홀더 아이콘 생성 (SVG → PNG 대체로 단순 placeholder)**

모바일 테스트를 위해 최소한의 PNG 아이콘이 필요. 실제 아이콘은 추후 교체하고, placeholder로 투명 1x1 PNG 생성:

Run: `cd packages/web/public && echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > icon-192.png && cp icon-192.png icon-512.png`

- [ ] **Step 5: 타입체크 + 빌드 확인**

Run: `pnpm --filter @cmux-relay/web build`
Expected: PASS (빌드 성공)

- [ ] **Step 6: Commit**

```bash
git add packages/web/public/manifest.json packages/web/public/sw.js packages/web/public/icon-192.png packages/web/public/icon-512.png packages/web/index.html
git commit -m "feat(web): add PWA manifest, service worker, and meta tags"
```

---

## Task 5: Web — 클라이언트 push 유틸리티

**Files:**
- Create: `packages/web/src/lib/push.ts`

- [ ] **Step 1: push.ts 작성**

`packages/web/src/lib/push.ts`:

```typescript
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
        applicationServerKey: publicKey,
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
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/push.ts
git commit -m "feat(web): add client push subscription utilities"
```

---

## Task 6: Web — MobileLayout에 push 구독 + pending navigation 처리

**Files:**
- Modify: `packages/web/src/components/MobileLayout.tsx`

- [ ] **Step 1: MobileLayout에 push 초기화 + pending navigation 로직 추가**

import 추가:

```typescript
import { registerServiceWorker, subscribePush, getPendingNavigation } from '../lib/push';
```

`MobileLayout` 함수 컴포넌트 내, `const relayUrl = ...` 이후에 push 초기화 useEffect 추가:

```typescript
  // Register service worker and push subscription
  useEffect(() => {
    if (status !== 'connected') return;
    registerServiceWorker().then((reg) => {
      if (reg && Notification.permission === 'granted') {
        subscribePush(reg);
      }
    });
  }, [status]);
```

기존 브라우저 알림 권한 요청 useEffect를 수정 (`status === 'connected'` 조건에서 권한 요청 후 push 구독):

```typescript
  // Browser notification permission request on connect
  useEffect(() => {
    if (status === 'connected' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(async (p) => {
        if (p === 'granted') {
          const reg = await registerServiceWorker();
          if (reg) await subscribePush(reg);
          if (pendingBrowserNotifs.current.length > 0) {
            for (const n of pendingBrowserNotifs.current) {
              new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
            }
            pendingBrowserNotifs.current = [];
          }
        }
      });
    }
  }, [status]);
```

pending navigation 처리를 위한 useEffect 추가 (컴포넌트 마운트 시 한 번만):

```typescript
  // Handle pending navigation from push notification click
  useEffect(() => {
    getPendingNavigation().then((nav) => {
      if (nav) {
        if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
        if (nav.surfaceId) {
          setSelectedSurfaceId(nav.surfaceId);
          // selectSurface will be called in the surface selection effect
        }
      }
    });
  }, []);
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/MobileLayout.tsx
git commit -m "feat(web): add push subscription and pending navigation to MobileLayout"
```

---

## Task 7: Web — Layout에 push 구독 + pending navigation 처리

**Files:**
- Modify: `packages/web/src/components/Layout.tsx`

- [ ] **Step 1: Layout에 push 초기화 + pending navigation 로직 추가**

import 추가:

```typescript
import { registerServiceWorker, subscribePush, getPendingNavigation } from '../lib/push';
```

`Layout` 함수 컴포넌트 내, 기존 브라우저 알림 useEffect 수정:

```typescript
  // Browser notification + push subscription
  const pushInitialized = useRef(false);

  useEffect(() => {
    if (status !== 'connected' || pushInitialized.current) return;
    pushInitialized.current = true;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(async (p) => {
        if (p === 'granted') {
          const reg = await registerServiceWorker();
          if (reg) await subscribePush(reg);
          if (pendingBrowserNotifs.current.length > 0) {
            for (const n of pendingBrowserNotifs.current) {
              new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
            }
            pendingBrowserNotifs.current = [];
          }
        }
      });
    } else if (Notification.permission === 'granted') {
      registerServiceWorker().then((reg) => {
        if (reg) subscribePush(reg);
      });
    }
  }, [status]);
```

pending navigation 처리를 위한 useEffect 추가:

```typescript
  // Handle pending navigation from push notification click
  useEffect(() => {
    getPendingNavigation().then((nav) => {
      if (nav) {
        if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
        if (nav.surfaceId) selectSurface(nav.surfaceId);
      }
    });
  }, []);
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/Layout.tsx
git commit -m "feat(web): add push subscription and pending navigation to Layout"
```

---

## Task 8: Web — RelaySessionLayout에도 pending navigation 처리

**Files:**
- Modify: `packages/web/src/components/RelaySessionLayout.tsx`

- [ ] **Step 1: RelaySessionLayout에 push 초기화 로직 추가**

`RelaySessionLayout` 컴포넌트 파일 읽기 후, push 초기화 + pending navigation 처리를 MobileLayout과 동일한 패턴으로 추가. 이 컴포넌트는 cloud mode 터미널 페이지에서 사용됨.

import 추가:

```typescript
import { registerServiceWorker, subscribePush, getPendingNavigation } from '../lib/push';
```

컴포넌트 내에 연결 시 push 구독 + pending navigation 처리 추가 (MobileLayout과 동일 패턴).

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm --filter @cmux-relay/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/RelaySessionLayout.tsx
git commit -m "feat(web): add push subscription and pending navigation to RelaySessionLayout"
```

---

## Task 9: 전체 검증

- [ ] **Step 1: 전체 타입체크**

Run: `pnpm -r run typecheck`
Expected: 모든 패키지 PASS

- [ ] **Step 2: 전체 테스트**

Run: `pnpm test:unit`
Expected: 기존 테스트 모두 PASS

- [ ] **Step 3: 빌드 확인**

Run: `pnpm --filter @cmux-relay/web build`
Expected: 빌드 성공, dist/에 manifest.json, sw.js 포함 확인

- [ ] **Step 4: 수동 테스트 체크리스트**

1. `pnpm dev:relay` 시작 → VAPID 키 자동 생성 확인 (로그에 "Generated new VAPID keys")
2. `pnpm dev:web` 시작 → `/` 접속 → DevTools Application 탭에서 manifest 확인
3. Service Worker 등록 확인 (DevTools → Application → Service Workers)
4. 알림 권한 허용 → Push 구독 생성 → `/api/push/subscribe` POST 확인
5. 모바일 사파리에서 접속 → "홈 화면에 추가" 가능 확인
6. Agent에서 알림 발생 → 모바일 시스템 알림 수신 확인
7. 알림 클릭 → 앱 열림 → 해당 workspace/pane 자동 선택 확인

- [ ] **Step 5: 최종 Commit**

```bash
git add -A
git commit -m "feat: complete mobile push notification system"
```
