# 웹 클라이언트 연결 상태 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 클라이언트의 연결 과정을 단계별로 시각화하고, 재연결을 빠르게 감지한다.

**Architecture:** `useRelay` 훅에 `ConnectionPhase` 상태 머신을 추가하고, 이를 소비하는 `ConnectionOverlay` 컴포넌트를 새로 만든다. 기존 `status: RelayStatus`는 `phase`에서 파생되도록 유지해 MobileLayout 등 기존 소비자의 호환성을 보장한다.

**Tech Stack:** React, TypeScript, CSS (Catppuccin Mocha 테마 기존 변수 사용)

---

### Task 1: useRelay에 ConnectionPhase 상태 머신 추가

**Files:**
- Modify: `packages/web/src/hooks/useRelay.ts`

- [ ] **Step 1: ConnectionPhase 타입과 상수 정의 추가**

`useRelay.ts` 상단에 추가:

```typescript
export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'waiting-agent'
  | 'connected'
  | 'reconnecting'
  | 'error';

const PHASE_ORDER: ConnectionPhase[] = ['connecting', 'authenticating', 'waiting-agent', 'connected'];

function phaseIndex(p: ConnectionPhase): number {
  const i = PHASE_ORDER.indexOf(p);
  return i >= 0 ? i : -1;
}
```

- [ ] **Step 2: 기존 `status` state를 `phase`로 교체하고 새 상태 추가**

`useRelay` 함수 내에서 기존 `const [status, setStatus] = useState<RelayStatus>('disconnected');`를 다음으로 교체:

```typescript
const [phase, setPhase] = useState<ConnectionPhase>('idle');
const [highestPhase, setHighestPhase] = useState<ConnectionPhase | null>(null);
const [reconnectAttempt, setReconnectAttempt] = useState(0);
const [reconnectDelay, setReconnectDelay] = useState(0);
const [errorMessage, setErrorMessage] = useState<string | null>(null);
```

기존 `status`를 파생값으로 추가 (MobileLayout 등 기존 소비자 호환성):

```typescript
const status: RelayStatus = phase === 'connected' ? 'connected'
  : phase === 'idle' || phase === 'error' ? 'disconnected'
  : 'connecting';
```

`useEffect` 내부에서 `phase` 최신값을 읽기 위해 ref 추가:

```typescript
const phaseRef = useRef<ConnectionPhase>('idle');
const highestPhaseRef = useRef<ConnectionPhase | null>(null);
```

그리고 `setPhase` 호출 후 ref도 업데이트하는 헬퍼를 `useEffect` 내에 정의:

```typescript
const updatePhase = (p: ConnectionPhase) => {
  phaseRef.current = p;
  setPhase(p);
};

const updateHighestPhase = (p: ConnectionPhase | null) => {
  highestPhaseRef.current = p;
  setHighestPhase(p);
};
```

이후 모든 `setPhase(...)`는 `updatePhase(...)`로, `setHighestPhase(...)`는 `updateHighestPhase(...)`로 교체 (useEffect 클로저 내부에서만).

- [ ] **Step 3: `connect` 함수 내 상태 전환 로직 수정**

`connect` 내부의 `ws.onopen`에서 `setStatus('connected')` → `setPhase('authenticating')`으로 변경. auth 전송 로직 유지.

기존 `ws.onopen`:
```typescript
ws.onopen = () => {
  if (disposed) return;
  reconnectDelay = 1000;
  setStatus('connected');

  if (token) {
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
  }
  ...
};
```

변경:
```typescript
ws.onopen = () => {
  if (disposed) return;
  reconnectDelay = 1000;
  setPhase('authenticating');
  setErrorMessage(null);

  if (token) {
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
  }
  ...
};
```

`setStatus('connecting')` → `setPhase('connecting')`으로 변경 (connect 함수 시작부분).

- [ ] **Step 4: 메시지 수신 시 상태 전환 추가**

`handleMessage`의 `workspaces` case에 상태 전환 추가:

```typescript
case 'workspaces':
  setWorkspaces(msg.payload.workspaces);
  setPhase('connected');
  setHighestPhase('connected');
  setReconnectAttempt(0);
  break;
```

`surfaces` case에 `waiting-agent` 전환 추가:

```typescript
case 'surfaces':
  setSurfaces(prev => {
    const next = prev.filter(s => s.workspaceId !== msg.workspaceId);
    return [...next, ...msg.payload.surfaces];
  });
  if (phase !== 'connected') {
    setPhase('waiting-agent');
  }
  break;
```

참고: `surfaces` 메시지는 보통 `workspaces`보다 먼저 올 수 있으므로, 아직 `connected`가 아니면 `waiting-agent`로 설정.

- [ ] **Step 5: `ws.onclose`에서 재연결 상태 전환 추가**

기존 `ws.onclose`:
```typescript
ws.onclose = () => {
  if (disposed) return;
  wsRef.current = null;
  setStatus('disconnected');
  ...
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
};
```

변경:
```typescript
ws.onclose = (event) => {
  if (disposed) return;
  wsRef.current = null;

  // Track highest phase for reconnect UI
  const currentPhaseIdx = phaseIndex(phaseRef.current);
  if (currentPhaseIdx > phaseIndex(highestPhaseRef.current)) {
    highestPhaseRef.current = phaseRef.current;
  }

  setReconnectAttempt(prev => prev + 1);

  // Abnormal close: reconnect immediately (no backoff)
  if (event.code !== 1000) {
    setReconnectDelay(0);
    setPhase('reconnecting');
    reconnectTimer = setTimeout(connect, 300);
  } else {
    setReconnectDelay(reconnectDelay);
    setPhase('reconnecting');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }

  setE2eReady(false);
  e2eRef.current = null;
  cleanupWebRTC();
};
```

`phaseRef`와 `highestPhaseRef`를 `useEffect` 내 지역 변수로 추가:

```typescript
let phaseRef = { current: phase };
// Update ref on each phase change — use a callback pattern
const updatePhase = (p: ConnectionPhase) => {
  phaseRef.current = p;
  setPhase(p);
};
```

참고: `useEffect` 클로저 내에서 `setPhase` 호출 시 상태가 최신이 아닐 수 있으므로, ref를 통해 추적. 모든 `setPhase(...)` 호출을 `updatePhase(...)`로 교체.

- [ ] **Step 6: pong 타임아웃 추가**

`useEffect` 내 지역 변수에 추가:

```typescript
let pongTimer: ReturnType<typeof setTimeout> | null = null;
```

ping interval 내에 pong 타임아웃 설정:

```typescript
pingTimer = setInterval(() => {
  if (wsRef.current?.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify({ type: 'ping' }));
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      console.warn('[relay] Pong timeout — forcing reconnect');
      const oldWs = wsRef.current;
      wsRef.current = null;
      if (oldWs) { oldWs.onclose = null; oldWs.close(); }
      cleanupWebRTC();
      updatePhase('reconnecting');
      setReconnectAttempt(prev => prev + 1);
      reconnectTimer = setTimeout(connect, 1000);
    }, 10_000);
  }
}, 25_000);
```

`ws.onmessage`에서 pong 응답 처리 추가 (기존 `handleMessage` 호출 전):

```typescript
ws.onmessage = async (event) => {
  if (disposed) return;
  // Clear pong timeout on any message (server is alive)
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }

  const msg = JSON.parse(event.data as string);
  ...
};
```

cleanup 함수에 `pongTimer` 정리 추가:

```typescript
return () => {
  disposed = true;
  clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  ...
};
```

- [ ] **Step 7: `forceReconnect` 함수 업데이트**

```typescript
const forceReconnect = () => {
  clearTimeout(reconnectTimer);
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  const oldWs = wsRef.current;
  wsRef.current = null;
  if (oldWs) {
    oldWs.onclose = null;
    oldWs.close();
  }
  cleanupWebRTC();
  updatePhase('reconnecting');
  setReconnectDelay(300);
  setE2eReady(false);
  e2eRef.current = null;
  reconnectDelay = 1000;
  setTimeout(connect, 300);
};
```

- [ ] **Step 8: return 값에 phase 관련 상태 추가**

```typescript
return {
  status,       // 기존 — 호환성
  phase,
  highestPhase,
  reconnectAttempt,
  reconnectDelay,
  errorMessage,
  transport,
  workspaces, surfaces, panes, containerFrames,
  activeSurfaceId, activeWorkspaceId,
  notifications, e2eReady,
  selectSurface, requestWorkspaces, sendInput, sendResize,
  onOutput, onNotifications,
};
```

- [ ] **Step 9: `pnpm --filter web build` 실행해 typecheck 통과 확인**

Run: `pnpm --filter web build`
Expected: 빌드 성공 (phase 관련 필드를 아직 소비하지 않으므로 에러 없음)

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/hooks/useRelay.ts
git commit -m "feat(web): add ConnectionPhase state machine to useRelay hook"
```

---

### Task 2: ConnectionOverlay 컴포넌트 생성

**Files:**
- Create: `packages/web/src/components/ConnectionOverlay.tsx`
- Modify: `packages/web/src/index.css`

- [ ] **Step 1: ConnectionOverlay 컴포넌트 작성**

```tsx
import type { ConnectionPhase } from '../hooks/useRelay';

type TransportType = 'relay' | 'p2p';

interface ConnectionOverlayProps {
  phase: ConnectionPhase;
  highestPhase: ConnectionPhase | null;
  reconnectAttempt: number;
  reconnectDelay: number;
  errorMessage: string | null;
  transport: TransportType;
}

const STEPS = [
  { key: 'connecting', label: 'WebSocket 연결' },
  { key: 'authenticating', label: '인증' },
  { key: 'waiting-agent', label: 'Agent 연결 대기' },
] as const;

const STEP_KEYS = STEPS.map(s => s.key);

function stepIndex(phase: ConnectionPhase): number {
  return STEP_KEYS.indexOf(phase as typeof STEP_KEYS[number]);
}

function progressPercent(phase: ConnectionPhase): number {
  const idx = stepIndex(phase);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / STEPS.length) * 100);
}

export function ConnectionOverlay({
  phase,
  highestPhase,
  reconnectAttempt,
  reconnectDelay,
  errorMessage,
}: ConnectionOverlayProps) {
  if (phase === 'connected' || phase === 'idle') return null;

  const isReconnecting = phase === 'reconnecting';
  const isError = phase === 'error';
  const accent = isReconnecting ? 'var(--yellow)' : isError ? 'var(--red)' : 'var(--blue)';
  const gradient = isReconnecting
    ? 'linear-gradient(90deg, var(--yellow), var(--peach))'
    : isError
    ? 'linear-gradient(90deg, var(--red), var(--peach))'
    : 'linear-gradient(90deg, var(--blue), var(--mauve))';

  const title = isReconnecting ? '재연결 중' : isError ? '연결 실패' : '터미널 연결 중';
  const detail = isReconnecting
    ? reconnectDelay > 0 ? `${Math.ceil(reconnectDelay / 1000)}초 후 재시도...` : '연결 시도 중...'
    : isError
    ? errorMessage || '연결할 수 없습니다'
    : phase === 'connecting' ? 'WebSocket 연결 중...'
    : phase === 'authenticating' ? '인증 진행 중...'
    : 'Agent 응답 대기...';

  const highestIdx = highestPhase ? stepIndex(highestPhase) : -1;

  return (
    <div className="connection-overlay">
      <div className="connection-overlay-content">
        {/* Spinner */}
        <div className="connection-spinner" style={{ '--spinner-color': accent } as React.CSSProperties}>
          <svg width="48" height="48" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--bg-surface1)" strokeWidth="4"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--spinner-color)" strokeWidth="4"
              strokeDasharray="80 45" strokeLinecap="round"/>
          </svg>
        </div>

        <h3 className="connection-title" style={{ color: accent }}>{title}</h3>
        <p className="connection-detail">{detail}</p>

        {/* Progress bar */}
        <div className="connection-progress-track">
          <div className="connection-progress-bar"
            style={{
              background: gradient,
              width: isReconnecting ? '100%' : `${progressPercent(phase)}%`,
            }}
          />
        </div>

        {/* Steps */}
        <div className="connection-steps">
          {STEPS.map((step) => {
            const idx = STEP_KEYS.indexOf(step.key);
            const currentIdx = isReconnecting ? -1 : stepIndex(phase);
            const isComplete = isReconnecting ? idx <= highestIdx : idx < currentIdx;
            const isCurrent = isReconnecting ? false : idx === currentIdx;

            return (
              <div key={step.key}
                className={`connection-step ${isComplete ? 'complete' : isCurrent ? 'current' : 'pending'}`}>
                {isComplete ? '✓' : isCurrent ? '●' : '○'} {step.label}
              </div>
            );
          })}
        </div>

        {isReconnecting && reconnectAttempt > 0 && (
          <p className="connection-attempt">시도 {reconnectAttempt}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS 스타일 추가**

`packages/web/src/index.css`에 추가:

```css
/* Connection Overlay */
.connection-overlay {
  position: absolute;
  inset: 0;
  background: rgba(30, 30, 46, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.connection-overlay-content {
  text-align: center;
  max-width: 320px;
  width: 100%;
  padding: 0 1rem;
}

.connection-spinner {
  margin-bottom: 1.25rem;
  animation: spin 1.5s linear infinite;
}

.connection-spinner svg {
  display: block;
  margin: 0 auto;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.connection-title {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
  font-weight: 600;
}

.connection-detail {
  color: var(--text-sub);
  font-size: 0.8rem;
  margin: 0 0 1.25rem;
}

.connection-progress-track {
  background: var(--bg-surface0);
  border-radius: 999px;
  height: 3px;
  width: 100%;
  margin-bottom: 0.75rem;
  overflow: hidden;
}

.connection-progress-bar {
  height: 100%;
  border-radius: 999px;
  transition: width 0.5s ease;
}

.connection-steps {
  text-align: left;
  font-size: 0.72rem;
  line-height: 1.9;
}

.connection-step {
  color: var(--text-muted);
}

.connection-step.complete {
  color: var(--green);
}

.connection-step.current {
  color: var(--blue);
  font-weight: 600;
}

.connection-attempt {
  color: var(--text-muted);
  font-size: 0.65rem;
  margin-top: 0.75rem;
}
```

- [ ] **Step 3: `pnpm --filter web build`로 빌드 확인**

Run: `pnpm --filter web build`
Expected: 빌드 성공

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/ConnectionOverlay.tsx packages/web/src/index.css
git commit -m "feat(web): add ConnectionOverlay component with progress steps"
```

---

### Task 3: RelaySessionLayout에 ConnectionOverlay 적용 + 헤더 상태 개선

**Files:**
- Modify: `packages/web/src/components/RelaySessionLayout.tsx`

- [ ] **Step 1: import 추가**

```typescript
import { ConnectionOverlay } from './ConnectionOverlay';
import type { ConnectionPhase } from '../hooks/useRelay';
```

- [ ] **Step 2: useRelay에서 phase 관련 필드 destructuring**

기존:
```typescript
const {
  status,
  transport,
  ...
} = useRelay({ url: wsUrl, e2eEnabled: true });
```

변경:
```typescript
const {
  status,
  phase,
  highestPhase,
  reconnectAttempt,
  reconnectDelay,
  errorMessage,
  transport,
  ...
} = useRelay({ url: wsUrl, e2eEnabled: true });
```

- [ ] **Step 3: 헤더 상태 점 + 텍스트로 개선**

기존 헤더의 `<span className="status">` 부분:
```tsx
<span className="status">
  <span className={`status-dot ${status}`} />
</span>
<span className={`transport-badge ${transport}`}>{transport === 'p2p' ? 'P2P' : 'Relay'}</span>
```

변경:
```tsx
<span className="status">
  <span className={`status-dot ${status}`} />
  <span className="status-text">
    {status === 'connected' ? '연결됨' :
     phase === 'reconnecting' ? `재연결 (${Math.ceil(reconnectDelay / 1000)}s)` :
     phase === 'connecting' ? 'WebSocket 연결 중...' :
     phase === 'authenticating' ? '인증 중...' :
     phase === 'waiting-agent' ? 'Agent 대기...' :
     status === 'disconnected' ? '연결 끊김' : '연결 중...'}
  </span>
</span>
<span className={`transport-badge ${transport}`}>{transport === 'p2p' ? 'P2P' : 'Relay'}</span>
```

- [ ] **Step 4: ConnectionOverlay를 `<main className="terminal-area">` 안에 추가**

`<main className="terminal-area">` 바로 뒤에 추가:

```tsx
<main className="terminal-area">
  <ConnectionOverlay
    phase={phase}
    highestPhase={highestPhase}
    reconnectAttempt={reconnectAttempt}
    reconnectDelay={reconnectDelay}
    errorMessage={errorMessage}
    transport={transport}
  />
  {selectedWorkspaceId ? (
    ...
  )}
</main>
```

- [ ] **Step 5: `status-text` CSS 추가**

`index.css`의 `.status` 스타일 근처에 추가:

```css
.status-text {
  font-size: 0.7rem;
  color: var(--text-muted);
}
```

- [ ] **Step 6: 빌드 확인**

Run: `pnpm --filter web build`
Expected: 빌드 성공

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/RelaySessionLayout.tsx packages/web/src/index.css
git commit -m "feat(web): add ConnectionOverlay and status text to RelaySessionLayout"
```

---

### Task 4: Layout (Local mode)에 ConnectionOverlay 적용 + 헤더 상태 개선

**Files:**
- Modify: `packages/web/src/components/Layout.tsx`

RelaySessionLayout과 동일한 패턴 적용:

- [ ] **Step 1: import 추가 및 useRelay destructuring에 phase 필드 추가**

```typescript
import { ConnectionOverlay } from './ConnectionOverlay';
```

useRelay destructuring에 `phase, highestPhase, reconnectAttempt, reconnectDelay, errorMessage` 추가.

- [ ] **Step 2: 헤더 상태 점 + 텍스트로 개선**

RelaySessionLayout Task 3 Step 3과 동일한 마크업으로 교체.

- [ ] **Step 3: ConnectionOverlay를 `<main className="terminal-area">` 안에 추가**

RelaySessionLayout Task 3 Step 4와 동일.

- [ ] **Step 4: 빌드 확인**

Run: `pnpm --filter web build`
Expected: 빌드 성공

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Layout.tsx
git commit -m "feat(web): add ConnectionOverlay and status text to Layout"
```

---

### Task 5: MobileLayout에 phase 적용

**Files:**
- Modify: `packages/web/src/components/MobileLayout.tsx`

- [ ] **Step 1: useRelay destructuring에 phase 필드 추가**

기존 `status`는 유지하고 `phase, highestPhase, reconnectAttempt, reconnectDelay, errorMessage` 추가.

- [ ] **Step 2: 헤더 상태 텍스트 추가**

기존 `<span className="status">` 부분에 status-text 추가 (Task 3 Step 3과 동일 패턴).

- [ ] **Step 3: ConnectionOverlay를 터미널 영역에 추가**

MobileLayout의 터미널 영역 `<main>` 내부에 `<ConnectionOverlay>` 추가.

- [ ] **Step 4: 빌드 확인**

Run: `pnpm --filter web build`
Expected: 빌드 성공

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/MobileLayout.tsx
git commit -m "feat(web): add ConnectionOverlay and status text to MobileLayout"
```

---

### Task 6: 최종 검증

- [ ] **Step 1: 전체 빌드**

Run: `pnpm --filter web build`
Expected: 성공

- [ ] **Step 2: dev 서버로 수동 테스트**

Run: `pnpm dev:web`

확인 항목:
- 웹 접속 시 ConnectionOverlay 표시 (3단계 진행 바 + 상태 텍스트)
- 연결 완료 시 오버레이 fade-out
- 헤더에 "연결됨" + P2P/Relay 배지 표시
- agent 종료 시 재연결 오버레이 (노란색) + 카운트다운
- 탭 숨김 → 복귀 시 재연결 동작
