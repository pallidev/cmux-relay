# 웹 클라이언트 연결 상태 개선 설계

## Context

Agent에 NetworkMonitor를 추가해 네트워크 변경 시 빠른 재연결이 가능해졌지만, 웹 클라이언트는 여전히 `connecting` / `connected` / `disconnected` 세 가지 상태만 노출합니다. 사용자는 연결 과정에서 무엇이 진행 중인지 알 수 없고, 재연결 시 언제 복구되는지 불명확합니다.

연결 과정을 단계별 상태로 세분화하고, 진행 바 + 상세 상태 텍스트를 보여주어 연결 경험을 개선합니다.

## 연결 상태 정의

```typescript
type ConnectionPhase =
  | 'idle'              // 연결 시도 전
  | 'connecting'        // WebSocket 연결 중
  | 'authenticating'    // auth 메시지 전송 후 응답 대기
  | 'waiting-agent'     // workspace/surface 데이터 대기
  | 'connected'         // 정상 연결 완료
  | 'reconnecting'      // 재연결 중 (이전 단계 정보 유지)
  | 'error';            // 연결 불가
```

진행 바는 3단계 기준: `connecting`(33%) → `authenticating`(66%) → `waiting-agent`(100%).

재연결 시 `reconnecting` 상태에서 이전에 도달했던 최고 단계(`highestPhase`)를 기억해 체크마크로 표시합니다.

## UI 컴포넌트

### ConnectionOverlay

`RelaySessionLayout`과 `Layout`에서 공통 사용하는 전체 화면 오버레이 컴포넌트.

Props:
```typescript
interface ConnectionOverlayProps {
  phase: ConnectionPhase;
  highestPhase: ConnectionPhase | null;  // 재연결 시 체크마크 표시용
  reconnectAttempt: number;
  reconnectDelay: number;
  errorMessage: string | null;
  transport: TransportType;
}
```

동작:
- `connected`가 아닐 때 터미널 위에 반투명 오버레이 표시
- 스피너: 초기 연결 시 파란색, 재연결 시 노란색, 에러 시 빨간색
- 단계 목록: 완료된 단계는 녹색 체크마크, 현재 단계는 색상 강조, 미래 단계는 회색
- 진행 바: 현재 단계에 따라 0/25/50/75/100%
- 재연결 시: "N초 후 재시도..." 카운트다운 + 시도 횟수 표시
- `connected` 전환 시 fade-out 애니메이션

### 헤더 상태 개선

기존 `status-dot`을 확장해 점 옆에 상태 텍스트 추가:
- 연결됨: 녹색 점 + "연결됨" + transport 배지(P2P/Relay)
- 연결 중: 노란색 점(펄스) + "WebSocket 연결 중..."
- 재연결 중: 노란색 점 + "재연결 (3초 후)"
- 오류: 빨간색 점 + "연결 끊김"

## useRelay 훅 변경

기존 `status: RelayStatus`를 `phase: ConnectionPhase`로 교체.

추가 상태:
```typescript
const [phase, setPhase] = useState<ConnectionPhase>('idle');
const [highestPhase, setHighestPhase] = useState<ConnectionPhase | null>(null);
const [reconnectAttempt, setReconnectAttempt] = useState(0);
const [reconnectDelay, setReconnectDelay] = useState(0);
const [errorMessage, setErrorMessage] = useState<string | null>(null);
```

상태 전환 로직:
1. `ws.onopen` → `phase = 'authenticating'` (WebSocket 연결 완료, 인증 시작)
2. auth 메시지 전송 후 첫 메시지 수신 → `phase = 'waiting-agent'`
3. `workspaces` 메시지 수신 → `phase = 'connected'`
4. `ws.onclose` → `phase = 'reconnecting'`, `reconnectAttempt++`
5. 재연결 성공 시 `reconnectAttempt = 0`

기존 `status`는 `phase` 기반으로 파생:
```typescript
const status = phase === 'connected' ? 'connected'
  : phase === 'idle' ? 'disconnected'
  : 'connecting';
```
기존 `status`를 사용하는 곳이 있으면 호환성을 위해 유지.

## 재연결 개선

1. **비정상 종료 즉시 재연결**: `ws.onclose`에서 `code !== 1000`이면 backoff 무시하고 즉시 재연결
2. **pong 타임아웃**: 25초 ping 전송 후 10초 내 pong(`ws.onmessage`에서 `type === 'pong'` 또는 `ws.on('pong')`) 미수신 시 강제 재연결
3. **visibility 재연결 유지**: 기존 동작 (탭 숨김 > 3초 후 복귀 시 재연결)

## 수정 파일

| 파일 | 변경 |
|---|---|
| `packages/web/src/hooks/useRelay.ts` | `phase` 상태 머신, pong 타임아웃, 비정상 종료 즉시 재연결, 추가 상태 노출 |
| `packages/web/src/components/ConnectionOverlay.tsx` | **신규** — 전체 화면 로딩 오버레이 |
| `packages/web/src/components/RelaySessionLayout.tsx` | ConnectionOverlay 적용, 헤더 상태 개선 |
| `packages/web/src/components/Layout.tsx` | ConnectionOverlay 적용, 헤더 상태 개선 |

## 검증

1. `pnpm --filter web build` 통과
2. 수동 테스트:
   - agent 실행 → 웹 접속 → 단계별 진행 바 + 상태 텍스트 확인
   - 연결 완료 후 오버레이 fade-out 확인
   - agent 종료 → 재연결 오버레이 표시 + 카운트다운 확인
   - 네트워크 끊김 → 비정상 종료 감지 후 즉시 재연결 확인
   - 탭 숨김 → 3초 후 복귀 → 재연결 확인
   - P2P 전환 시 헤더 배지 변경 확인
