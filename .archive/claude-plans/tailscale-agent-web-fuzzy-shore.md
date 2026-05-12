# WebRTC P2P Transport 구현 계획

## Context

현재 cloud mode에서 모든 터미널 데이터(agent↔browser)가 relay 서버를 경유한다. 이를 WebRTC DataChannel로 직접 P2P 연결하여, relay는 인증+시그널링만 담당하고 실제 데이터는 agent와 browser 간 직접 전송되도록 한다.

```
[변경 전] Agent ──data──► Relay ──data──► Browser
[변경 후] Agent ──signaling──► Relay ──signaling──► Browser  (초기 연결만)
          Agent ◄═══WebRTC DataChannel═══► Browser            (데이터 직접)
```

## 핵심 결정사항

- **Agent WebRTC**: `node-datachannel` (C++ 바인딩, macOS ARM64 지원, 성숙도 높음)
- **Browser WebRTC**: Native `RTCPeerConnection` API (추가 의존성 없음)
- **시그널링**: 기존 relay 서버의 `agent.data`/`client.data` 채널로 SDP + ICE 교환
- **Fallback**: WebRTC 연결 실패시 기존 WebSocket relay 경유로 자동 전환
- **STUN**: Google 무료 STUN 서버 사용 (`stun:stun.l.google.com:19302`)

---

## Step 1: Shared 프로토콜 타입 추가

**파일**: `packages/shared/src/protocol.ts`

WebRTC 시그널링 메시지 타입 추가:

```typescript
// RelayToClient에 추가
| { type: 'webrtc.offer'; sdp: string }
| { type: 'webrtc.answer'; sdp: string }
| { type: 'webrtc.ice-candidate'; candidate: string; mid: string }

// ClientToRelay에 추가
| { type: 'webrtc.answer'; sdp: string }
| { type: 'webrtc.ice-candidate'; candidate: string; mid: string }
```

---

## Step 2: Agent에 WebRTC 전송 계층 추가

### 2a. 의존성 추가

**파일**: `packages/agent/package.json`
- `node-datachannel` 추가

### 2b. WebRTC 전송 모듈 생성

**신규 파일**: `packages/agent/src/webrtc-transport.ts`

```typescript
export class WebRTCTransport {
  // PeerConnection 생성, DataChannel 관리
  // offer 생성 → SDP + ICE candidates 반환
  // answer 수신 → 연결 완료
  // DataChannel.onMessage → 기존 message-handler로 라우팅
  // send() → DataChannel로 메시지 전송
  // 연결 실패시 fallback 콜백
}
```

핵심 API:
- `createOffer()` → `{ sdp, iceCandidates[] }` 반환
- `handleAnswer(sdp: string)` → 연결 완료
- `addIceCandidate(candidate, mid)` → ICE 후보 추가
- `send(message: string)` → DataChannel로 전송
- `onMessage(cb)` → 수신 콜백
- `onOpen(cb)` → DataChannel 열림
- `onError(cb)` → 연결 실패 (fallback 트리거)
- `close()` → 정리

### 2c. RelayConnection에 WebRTC 통합

**파일**: `packages/agent/src/relay-connection.ts`

- `client.connected` 수신시 WebRTC offer 생성 후 relay로 전송
- `client.data`에서 `webrtc.answer`, `webrtc.ice-candidate` 처리
- DataChannel 열리면 데이터 전송을 WebRTC로 전환
- 기존 WebSocket 연결은 시그널링용으로 유지

### 2d. SessionStore 전송 전환

**파일**: `packages/agent/src/session-store.ts`

- 클라이언트별 전송 상태 추가: `ws` | `webrtc`
- `sendToClient()` → WebRTC 전송 우선, 실패시 WS fallback

---

## Step 3: Web 클라이언트에 WebRTC 추가

### 3a. useRelay 훅에 WebRTC 통합

**파일**: `packages/web/src/hooks/useRelay.ts`

```typescript
// Native RTCPeerConnection 사용 (추가 의존성 없음)
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});
```

시그널링 흐름:
1. WebSocket으로 `webrtc.offer` 수신
2. RTCPeerConnection 생성, remote description 설정
3. Answer 생성 → relay로 전송
4. ICE candidates 교환
5. DataChannel 열리면 데이터 수신을 DataChannel로 전환
6. WebSocket은 시그널링+fallback으로 유지

- `webrtc.offer` 수신 → P2P 연결 시도
- DataChannel `onmessage` → 기존 output/workspaces 등 핸들링
- `send()` → DataChannel 우선, 실패시 WebSocket fallback

### 3b. 연결 상태 UI 표시

**파일**: `packages/web/src/components/Layout.tsx`, `RelaySessionLayout.tsx`
- P2P / Relay 연결 상태 표시 (선택적)

---

## Step 4: Relay 서버 최소 변경

**파일**: `packages/relay/src/session-registry.ts`, `ws-handler.ts`

변경 내용:
- `agent.data`에서 `webrtc.*` 타입 메시지를 client로 forward (기존 로직으로 자동 처리됨)
- `client.data`에서 `webrtc.*` 타입 메시지를 agent로 forward (기존 로직으로 자동 처리됨)

relay는 메시지 타입을 해석하지 않고 투명하게 전달하므로, **거의 변경 없이 동작**할 것으로 예상. `agent.data`/`client.data` 브릿지만 확인.

---

## Step 5: 테스트

### 단위 테스트
- `tests/unit/agent/webrtc-transport.test.ts` — offer/answer/ICE 흐름 mock 테스트
- WebRTC fallback 로직 테스트 (연결 실패시 WS 전환)

### 통합 테스트
- `tests/integration.test.ts`에 WebRTC 시그널링 흐름 추가
- Signaling 메시지가 relay를 통해 정확히 전달되는지 검증

### 수동 테스트
1. `pnpm dev:relay` → relay 서버 실행
2. `pnpm dev` → agent 실행 (cmux 필요)
3. `pnpm dev:web` → 웹 클라이언트 접속
4. 브라우저 콘솔에서 WebRTC 연결 상태 확인
5. 터미널 출력이 P2P로 전송되는지 확인
6. 네트워크 탭에서 relay로는 signaling만, 데이터는 직접 전송 확인

---

## 구현 순서

1. **Step 1** → shared 프로토콜 타입 (기반 작업)
2. **Step 2b** → agent WebRTC 전송 모듈 (핵심)
3. **Step 4** → relay 전달 확인 (최소 변경)
4. **Step 3a** → web 클라이언트 WebRTC (핵심)
5. **Step 2c, 2d** → agent 통합 (전송 전환 로직)
6. **Step 5** → 테스트
7. **Step 3b** → UI 상태 배지 (P2P / Relay 표시)
