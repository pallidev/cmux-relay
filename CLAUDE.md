# cmux-relay

cmux(Ghostty 기반 macOS 터미널)의 세션을 모바일에서 실시간 모니터링/제어하는 셀프 호스팅 터미널 스트리밍 도구.

## Architecture

```
Server (Node.js) ←WebSocket→ Web Client (React/xterm.js)
   ├── WebSocket 서버 (클라이언트 연결)
   ├── cmux Unix Socket (터미널 세션)
   └── PTY Capture (터미널 출력)
```

- **Server**: cmux Unix socket + PTY 캡처 + WebSocket 서버를 하나의 프로세스에서 실행
- **Web**: React + xterm.js 모바일 터미널 UI

## Commands

```bash
pnpm install              # 의존성 설치
pnpm -r run typecheck     # 전체 타입체크
pnpm test                 # 통합 테스트 (node:test + tsx)
pnpm --filter web build   # 웹 클라이언트 프로덕션 빌드

# 개발 서버
pnpm dev                  # Server (cmux + WebSocket, ws://localhost:8080)
pnpm dev:web              # 웹 클라이언트 (http://localhost:3000)

# CLI 옵션
pnpm start -- --port 9090 --socket /custom/cmux.sock
```

## Project Structure

```
packages/shared/   # WebSocket 프로토콜 타입, 메시지 정의 (의존성 없음)
packages/server/   # 통합 서버: cmux client + PTY capture + WebSocket server + auth
packages/web/      # React + Vite + xterm.js (모바일 반응형)
tests/             # 통합 테스트 (node:test)
```

## Key Files

| 파일 | 역할 |
|---|---|
| `packages/shared/src/protocol.ts` | WebSocket 메시지 타입 정의 (Client ↔ Server) |
| `packages/server/src/ws-server.ts` | WebSocket 서버, 클라이언트 메시지 라우팅 |
| `packages/server/src/session-store.ts` | 인메모리 세션/클라이언트 관리 |
| `packages/server/src/cmux-client.ts` | cmux Unix socket v2 JSON-RPC 클라이언트 |
| `packages/server/src/pty-capture.ts` | mkfifo 기반 PTY 출력 캡처 |
| `packages/server/src/input-handler.ts` | 웹 클라이언트 입력 → cmux 포워딩 |
| `packages/web/src/hooks/useRelay.ts` | React WebSocket 훅 |

## cmux Socket API

Server가 사용하는 cmux v2 JSON-RPC 메서드:

- `workspace.list` — 활성 워크스페이스 조회
- `surface.list` — 워크스페이스 내 탭/분할 조회
- `debug.terminal.read_text` — 현재 터미널 화면 텍스트 읽기
- `surface.send_text` — 터미널에 텍스트 입력
- `surface.send_key` — 특수키 입력

Socket 경로: `CMUX_SOCKET_PATH` env 또는 `/tmp/cmux.sock`

## WebSocket Protocol

모든 메시지는 JSON. base64로 터미널 데이터 인코딩.

프로토콜 변경 시 `packages/shared/src/protocol.ts`에 타입을 먼저 추가하고, server/web에 반영.

## Testing

```bash
pnpm test  # WebSocket 서버 + 클라이언트 통합 테스트
```

- 테스트는 랜덤 포트에서 격리된 서버 인스턴스 사용
- `node:test` + `tsx`로 실행 (별도 테스트 프레임워크 없음)
- Mock InputHandler로 입력 포워딩 검증
- 실제 cmux 연결은 필요 없음

## Conventions

- **TypeScript strict mode** — 모든 패키지
- **ESM only** — `"type": "module"`
- **pnpm workspace** — monorepo
- **브라우저 코드에서 `Buffer` 금지** — `btoa`/`atob` 사용
- **의존성 최소** — shared 패키지는 zero-dependency

## Git

- main 브랜치에 직접 push
- GitHub: `pallidev/cmux-relay`, SSH remote (`git@pallidev:pallidev/cmux-relay.git`)
