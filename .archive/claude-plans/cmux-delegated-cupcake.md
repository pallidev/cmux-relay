# Unit Test 재구축

## Context

기존 통합 테스트(`tests/integration.test.ts`)가 `packages/server/` 경로를 참조하여 작동하지 않음. 코드가 `packages/agent/`와 `packages/relay/`로 분리됨. mocking 기반 유닛 테스트로 전면 재구축.

## 테스트 구조

```
tests/
  unit/
    agent/
      session-store.test.ts     # SessionStore 순수 유닛 테스트
      message-handler.test.ts   # MessageHandler mocking 테스트
      input-handler.test.ts     # InputHandler mocking 테스트
      cmux-client.test.ts       # CmuxClient mock Unix socket 테스트 (기존 것 이식)
      auth.test.ts              # JWT 생성/검증 테스트
    relay/
      session-registry.test.ts  # SessionRegistry mock WebSocket 테스트
      pairing-registry.test.ts  # PairingRegistry mock WebSocket 테스트
      db.test.ts                # DB CRUD 인메모리 SQLite 테스트
  integration.test.ts           # 기존 통합 테스트 (경로 수정)
```

## 테스트 상세

### 1. SessionStore (`tests/unit/agent/session-store.test.ts`)
순수 유닛 테스트, mocking 불필요:
- `updateWorkspaces` / `getAllWorkspaces` — CRUD
- `updateSurfaces` / `getSurfacesForWorkspace` / `getSurface` — 워크스페이스별 서페이스 관리
- `updatePanesForWorkspace` / `getPanesForWorkspace` / `getAllPanes` — 패널 관리
- `registerClient` / `disconnectAllClients` / `unregisterClient` — 클라이언트 등록/해제
- `authenticateClient` / `isClientAuthenticated` — 인증 상태
- `setActiveSurface` / `getActiveSurface` / `getActiveSurfaceIds` — 활성 서페이스 추적
- `broadcastToClients` — 인증된 클라이언트에만 브로드캐스트
- `sendToClientsWithSurface` — 해당 서페이스 구독 클라이언트만 필터링

### 2. MessageHandler (`tests/unit/agent/message-handler.test.ts`)
mock deps(store, inputHandler, cmux) 사용:
- `auth` → 워크스페이스, 서페이스, 패널, 알림 전송
- `workspaces.list` → 현재 워크스페이스 목록 응답
- `surface.select` → 활성 서페이스 설정, surface.active + surfaces 응답
- `surface.select` (terminal) → cmux.readTerminalText 호출하여 스크롤백 전송
- `input` → InputHandler.handleInput 호출, cmux에서 터미널 텍스트 읽어 output 전송
- `resize` → InputHandler.handleResize 호출
- 잘못된 JSON → 무시

### 3. InputHandler (`tests/unit/agent/input-handler.test.ts`)
mock CmuxClient 사용:
- `handleInput` → base64 디코딩 후 cmux.sendText 호출
- `handleInput` (cmux 오류) → 에러 무시
- `handleResize` → 로그만 출력 (현재 구현)

### 4. CmuxClient (`tests/unit/agent/cmux-client.test.ts`)
mock Unix socket 서버 사용 (기존 패턴 유지):
- disconnected → connecting → connected 상태 전이
- JSON-RPC 요청/응답
- disconnected 상태에서 요청 시 에러
- onDisconnected 콜백
- 재연결
- 서버 없을 때 에러

### 5. Auth (`tests/unit/agent/auth.test.ts`)
- `generateToken` / `verifyToken` — 정상 토큰
- `verifyToken` — 만료/잘못된 토큰 → null
- `generateClientToken` — 클라이언트 역할 토큰

### 6. SessionRegistry (`tests/unit/relay/session-registry.test.ts`)
mock WebSocket 사용 (data 송수신 추적):
- `registerAgent` → 세션 생성, session.created 메시지 전송
- `connectClient` → 클라이언트를 세션에 추가, agent에 client.connected 알림
- `disconnectClient` → 클라이언트 제거, agent에 client.disconnected 알림
- `disconnectAgent` → 세션 제거, 모든 클라이언트 연결 해제
- `handleAgentMessage` (agent.data) → 모든 클라이언트에 전달
- `handleAgentMessage` (heartbeat) → 무시
- `handleClientMessage` → agent에 client.data로 전달
- `getSessionsForUser` → 사용자별 세션 조회

### 7. PairingRegistry (`tests/unit/relay/pairing-registry.test.ts`)
mock WebSocket + 인메모리 DB:
- `createPairing` → 코드 생성, URL 반환
- `approvePairing` → 토큰 생성, agent에 pairing.approved 전송
- `rejectPairing` → agent에 pairing.rejected 전송
- `removeByWs` → 연결 해제 시 정리
- `getPairingInfo` → 존재 여부 확인

### 8. DB (`tests/unit/relay/db.test.ts`)
인메모리 SQLite (`:memory:`):
- `initDatabase` → 테이블 생성
- `upsertUser` → 생성 및 업데이트
- `createApiToken` / `validateApiToken` → 토큰 생성 및 검증
- `validateApiToken` (잘못된 토큰) → undefined
- `deleteApiToken` → 토큰 삭제
- `listApiTokens` → 사용자 토큰 목록

## mock WebSocket 헬퍼

```typescript
// tests/helpers/mock-ws.ts
// send 기록, readyState 제어, 이벤트 시뮬레이션
```

공통으로 사용할 mock WebSocket 구현:
- `sentMessages`: 전송된 메시지 기록
- `send(data)`: 메시지 기록
- `close()`: close 이벤트 트리거
- `readyState`: 제어 가능

## 수정 파일

| 파일 | 작업 |
|---|---|
| `tests/integration.test.ts` | import 경로 `packages/server/` → `packages/agent/` 수정 |
| `tests/unit/agent/session-store.test.ts` | 신규 |
| `tests/unit/agent/message-handler.test.ts` | 신규 |
| `tests/unit/agent/input-handler.test.ts` | 신규 |
| `tests/unit/agent/cmux-client.test.ts` | 신규 (기존 것 분리) |
| `tests/unit/agent/auth.test.ts` | 신규 |
| `tests/unit/relay/session-registry.test.ts` | 신규 |
| `tests/unit/relay/pairing-registry.test.ts` | 신규 |
| `tests/unit/relay/db.test.ts` | 신규 |
| `tests/helpers/mock-ws.ts` | 신규 (mock WebSocket 헬퍼) |
| `package.json` | test 스크립트 업데이트 (glob 패턴) |

## Verification

```bash
pnpm test                     # 전체 테스트 실행
pnpm -r run typecheck         # 타입체크
node --import tsx --test tests/unit/**/*.test.ts  # 유닛 테스트만
```
