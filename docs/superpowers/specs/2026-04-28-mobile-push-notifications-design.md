# Mobile Push Notifications Design

## Context

cmux-relay의 알림 시스템은 데스크톱 브라우저에서만 `new Notification()` API를 사용해 시스템 알림을 표시한다. 모바일 사파리(iOS 16.4+)와 모바일 크롬에서는 PWA(서비스 워커 + manifest)가 필요하다. 또한 알림 클릭 시 해당 workspace/pane으로 자동 이동하는 기능이 필요하다.

## Architecture

```
Agent → Relay(WS) → Client(WS, foreground)
                  → Push Service(FCM/APNs, background)
                                  → Service Worker → showNotification()
                                  → click → open app → WS reconnect → navigate
```

## Components

### 1. PWA Setup

**manifest.json** (`packages/web/public/manifest.json`):
- `name`: "cmux-relay"
- `display`: "standalone"
- `theme_color`, `background_color`
- `icons`: 192x192, 512x512 (SVG 기반 생성)

**HTML 변경** (`packages/web/index.html`):
- `<link rel="manifest" href="/manifest.json">` 추가
- `<meta name="theme-color">` 추가
- Apple PWA 메타 태그 추가

### 2. Service Worker

**`packages/web/public/sw.js`**:
- `install`: 활성화, 클라이언트 claim
- `push`: 푸시 수신 시 `showNotification()` (title, body, data에 workspaceId/surfaceId 포함)
- `notificationclick`: 알릭 클릭 시 `clients.openWindow()` + IndexedDB에 pending navigation 데이터 저장
- `pushsubscriptionchange`: 구독 만료/변경 시 relay에 갱신 요청

### 3. Relay Server - Push Infrastructure

**VAPID 키** (환경 변수):
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- 키가 없으면 서버 시작 시 자동 생성

**DB 스키마** (`packages/relay/src/db.ts`):
```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**REST API** (`packages/relay/src/http-handler.ts`):
- `POST /api/push/subscribe`: push 구독 등록/갱신 (인증 필요)
- `DELETE /api/push/subscribe`: push 구독 해제

**Push 전송** (`packages/relay/src/push-sender.ts`):
- `web-push` npm 패키지 사용
- `sendPushNotification(userId, payload)` 함수
- payload: `{ title, body, workspaceId, surfaceId }`
- TTL 24시간, urgency: high

**알림 훅** (`packages/relay/src/session-registry.ts`):
- agent가 `notifications` 메시지를 보내면, 연결된 클라이언트 외에 push_subscriptions 테이블의 구독에도 push 전송

### 4. Web Client - Push Subscription

**`packages/web/src/lib/push.ts`**:
- `registerServiceWorker()`: SW 등록
- `subscribePush(vapidPublicKey)`: PushSubscription 획득 → relay에 POST
- `getPendingNavigation()`: IndexedDB에서 pending navigation 데이터 읽기 후 삭제

**useRelay 훅 변경** (`packages/web/src/hooks/useRelay.ts`):
- 연결 시 push 구독 상태 확인 및 구독
- 앱 로드 시 `getPendingNavigation()` 호출하여 자동 이동

### 5. Notification Click → Navigation

흐름:
1. Service Worker가 push 수신 → `showNotification({data: {workspaceId, surfaceId}})`
2. 사용자 클릭 → `notificationclick` 핸들러
3. IndexedDB `pending-nav` 스토어에 `{workspaceId, surfaceId}` 저장
4. `clients.openWindow('/')` 로 앱 열기
5. 앱 로드 시 IndexedDB 확인 → workspace/surface 자동 선택

**MobileLayout / Layout 변경**:
- 마운트 시 `getPendingNavigation()` 확인
- 데이터 있으면 `setSelectedWorkspaceId`, `setSelectedSurfaceId`, `selectSurface` 호출

## Files to Modify

| File | Change |
|---|---|
| `packages/web/public/manifest.json` | 새 파일 |
| `packages/web/public/sw.js` | 새 파일 |
| `packages/web/index.html` | manifest/meta 태그 추가 |
| `packages/web/src/lib/push.ts` | 새 파일 (SW 등록, push 구독, pending nav) |
| `packages/web/src/hooks/useRelay.ts` | push 구독 통합 |
| `packages/web/src/components/MobileLayout.tsx` | pending navigation 처리 |
| `packages/web/src/components/Layout.tsx` | pending navigation 처리 |
| `packages/relay/src/db.ts` | push_subscriptions 테이블 추가 |
| `packages/relay/src/http-handler.ts` | push 구독 API 엔드포인트 |
| `packages/relay/src/push-sender.ts` | 새 파일 (web-push 전송) |
| `packages/relay/src/session-registry.ts` | 알림 시 push 전송 훅 |
| `packages/relay/package.json` | web-push 의존성 추가 |

## Verification

1. `pnpm install` 후 relay 서버 시작 → VAPID 키 자동 생성 확인
2. 모바일 사파리에서 앱 접속 → "홈 화면에 추가" 가능 확인
3. PWA에서 알림 권한 요청 → 권한 허용
4. Agent에서 알림 발생 → 모바일에 시스템 알림 도착 확인
5. 알림 클릭 → 앱 열림 → 해당 workspace/pane으로 자동 이동 확인
6. 앱이 포그라운드일 때는 기존 WS 토스트 유지 확인
