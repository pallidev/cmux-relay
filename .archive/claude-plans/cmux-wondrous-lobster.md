# cmux 터미널 스크롤백 동기화

## Context

현재 웹 클라이언트는 agent가 1초마다 폴링하는 **현재 보이는 화면**만 수신합니다. 사용자가 xterm.js에서 위로 스크롤해도, 연결 이후에 캡처된 화면만 볼 수 있고 cmux 터미널의 실제 스크롤백 히스토리(연결 전 내용, 폴링 사이에 스크롤된 내용)는 볼 수 없습니다.

cmux socket API의 `surface.read_text`는 `scrollback: true` 파라미터로 전체 스크롤백 버퍼를 반환할 수 있습니다. 이를 활용해 웹 클라이언트에서 스크롤백을 볼 수 있게 합니다.

## 구현 방안

### 1. 프로토콜 메시지 추가

**`packages/shared/src/protocol.ts`**

```typescript
// Client → Agent: 스크롤백 요청
export interface ScrollbackRequestMessage {
  type: 'scrollback.request';
  surfaceId: string;
}

// Agent → Client: 스크롤백 데이터 (전체 히스토리)
export interface RelayScrollbackMessage {
  type: 'output.scrollback';
  surfaceId: string;
  payload: { data: string } | EncryptedPayload;
}
```

- `ScrollbackRequestMessage` → `ClientOutgoing` 유니온에 추가
- `RelayScrollbackMessage` → `RelayToClient` 유니온에 추가

### 2. surface.select 시 스크롤백 전송

**`packages/agent/src/ws-server.ts`** (local mode) — `surface.select` 핸들러 수정:
- `readTerminalText(surfaceId, false)` → `readTerminalText(surfaceId, true)` 로 변경
- 메시지 타입을 `output` → `output.scrollback` 으로 변경

**`packages/agent/src/message-handler.ts`** (cloud mode) — 동일하게 수정

### 3. scrollback.request 메시지 처리

**`packages/agent/src/ws-server.ts`** (local mode):
```typescript
case 'scrollback.request': {
  if (deps.cmux) {
    const text = await deps.cmux.readTerminalText(msg.surfaceId, true);
    if (text) {
      send(ws, {
        type: 'output.scrollback',
        surfaceId: msg.surfaceId,
        payload: { data: Buffer.from(text).toString('base64') },
      });
    }
  }
  break;
}
```

**`packages/agent/src/message-handler.ts`** (cloud mode) — 동일하게 처리

### 4. useRelay 훅 — 스크롤백 메시지 처리

**`packages/web/src/hooks/useRelay.ts`**:
- `handleMessage`에 `output.scrollback` 케이스 추가
- `onScrollback` 콜백 추가 (output 콜백과 별도)
- `requestScrollback(surfaceId)` 함수 추가
- E2E 암호화 지원 (output과 동일한 방식)

### 5. Terminal 컴포넌트 — 스크롤백 렌더링

**`packages/web/src/components/Terminal.tsx`**:

**terminalRegistry 확장**: `writeScrollback(surfaceId, data)` 함수 추가

**writeScrollback 로직**:
1. `t.reset()` 으로 터미널 초기화
2. 스크롤백+현재 화면 전체 내용을 `t.write(text)` 로 출력
3. 오버플로우는 자동으로 xterm scrollback 버퍼에 저장됨
4. `t.scrollToBottom()` 으로 현재 화면 위치로 이동
5. 상태 플래그 업데이트:
   - `hasWritten = true`
   - `scrollbackLoaded = true` (다음 output에서 scrollback 중복 방지)
   - `previousText` 업데이트하지 않음

**scrollbackLoaded 플래그 처리** (`writeOutput` 수정):
- `scrollbackLoaded = true` 일 때 다음 `output` 메시지:
  - 기존 방식(previousText를 scrollback에 push) 대신
  - `\x1b[H` + 새 텍스트 + `\x1b[J` 로 visible area만 덮어쓰기
  - `scrollbackLoaded = false` 로 리셋
  - `previousText = text` 업데이트
- 이후 정상 폴링 주기에서는 기존 방식대로 동작

**상단 스크롤 감지**:
- `onScroll` 핸들러에서 `viewportY <= 0` 감지
- 최초 1회만 `onScrollbackRequest?.(surfaceId)` 호출
- 스크롤백 수신 후 플래그 리셋

### 6. Layout/RelaySessionLayout — 연결

**`packages/web/src/components/Layout.tsx`** (local mode):
- `useRelay`에서 `onScrollback` 콜백 연결
- `requestScrollback`을 Terminal 컴포넌트에 전달

**`packages/web/src/components/RelaySessionLayout.tsx`** (cloud mode):
- 동일하게 연결

## 수정 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `packages/shared/src/protocol.ts` | `ScrollbackRequestMessage`, `RelayScrollbackMessage` 추가 |
| `packages/agent/src/ws-server.ts` | surface.select 시 scrollback 전송 + scrollback.request 처리 |
| `packages/agent/src/message-handler.ts` | surface.select 시 scrollback 전송 + scrollback.request 처리 |
| `packages/web/src/hooks/useRelay.ts` | output.scrollback 처리, onScrollback/requestScrollback 추가 |
| `packages/web/src/components/Terminal.tsx` | writeScrollback 로직, 상단 스크롤 감지, scrollbackLoaded 플래그 |
| `packages/web/src/components/Layout.tsx` | scrollback 콜백 연결 |
| `packages/web/src/components/RelaySessionLayout.tsx` | scrollback 콜백 연결 |

## 검증 방법

1. `pnpm -r run typecheck` — 타입 체크 통과
2. Agent + Web 개발 서버 실행:
   - `pnpm dev:relay` → relay 서버 시작
   - `pnpm dev` → agent 시작 (cmux 연결)
   - 웹 브라우저에서 터미널 접속
3. surface 선택 시:
   - 터미널 전체 히스토리(스크롤백)가 로드되는지 확인
   - 위로 스크롤해서 이전 명령어 출력 확인
   - 아래로 스크롤해서 현재 프롬프트 확인
4. 폴링 업데이트 시:
   - 새 터미널 출력이 정상적으로 표시되는지
   - 스크롤백 내용이 유지되는지
   - 중복 콘텐츠가 없는지
5. 입력 시:
   - 명령어 입력 후 결과가 정상 표시
   - 스크롤백이 유지되는지
