# P2P DataChannel Keepalive Ping 추가

## Context

P2P(DataChannel) 연결이 유휴 상태에서 조용히 끊어지면, agent는 여전히 `isActive()=true`인 상태로 P2P로 데이터를 전송하지만 실제로는 도달하지 않음. 알림 등 중요 메시지가 블랙홀에 빠짐.

해결: 양방향 keepalive ping/pong을 추가해 dead connection을 감지하고 relay로 자동 폴백.

## 수정 파일

### 1. `packages/agent/src/webrtc-transport.ts` — Keepalive 메커니즘

- `PING_INTERVAL = 30_000`, `PING_TIMEOUT = 10_000` 상수 추가
- `startKeepalive()`: 30초마다 `{"type":"webrtc.ping"}` 전송, 10초 내 pong 없으면 `onError` 콜백 호출
- `stopKeepalive()`: 타이머 정리
- `handlePong()`: pong 수신 시 타임아웃 타이머 리셋
- ping 메시지는 `onMessage` 콜백으로 전파하지 않음 (내부 처리)
- `onOpen` 콜백에서 `startKeepalive()` 호출
- `close()`에서 `stopKeepalive()` 호출

### 2. `packages/agent/src/relay-connection.ts` — Keepalive 수명 관리

- `initWebRTC()`에서 transport 생성 시 변경 없음 (keepalive는 transport 내부에서 자동 시작)
- `cleanupWebRTC()`에서 기존과 동일하게 transport.close() 호출 (내부적으로 stopKeepalive)

### 3. `packages/web/src/hooks/useRelay.ts` — 브라우저 ping/pong 처리

- DataChannel `onmessage`에서 `webrtc.ping` 수신 시 `webrtc.pong` 응답 전송
- DataChannel `onopen` 시 브라우저 측에서도 keepalive 시작 (agent→browser ping만으로도 충분하므로 브라우저는 pong 응답만)
- relay WebSocket 메시지 핸들러에서도 `webrtc.pong` 처리 (DataChannel이 아닌 relay로 pong이 오는 경우)

## Keepalive 프로토콜

```
Agent (30s interval)  →  DataChannel  →  Browser
  {"type":"webrtc.ping"}

Browser (immediate)   →  DataChannel  →  Agent
  {"type":"webrtc.pong"}

Agent: pong 10초 내 미수신 → isActive=false, onError 콜백 → relay 폴백
```

기존 메시지 타입과 충돌 없음. `webrtc.ping`/`webrtc.pong`은 `ClientOutgoing`/`RelayToClient` 타입에 추가할 필요 없이 내부 처리.

## Verification

1. Agent 실행 후 P2P 연결 → 30초+ 유휴 상태 → 알림이 relay로 폴백되어 정상 수신
2. DataChannel 강제 종료(네트워크 변경 등) 시 40초 내 relay 폴백
3. 기존 P2P 정상 동작(터미널 output 등) 회귀 없음
4. `pnpm -r run typecheck` 통과
5. 기존 테스트 통과
