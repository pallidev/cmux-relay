# cmux-relay

cmux(Ghostty 기반 macOS 터미널)의 세션을 모바일에서 실시간 모니터링/제어하는 셀프 호스팅 터미널 스트리밍 도구.

## Architecture

### Cloud Mode (기본)

```
Agent (Mac) ──signaling──► Relay Server ◄──signaling──► Web Client (Browser)
   │    │                        │
   │    └─── WebRTC DataChannel (P2P direct) ──────────►│
   │
   ├── cmux Unix Socket      ├── GitHub OAuth
   ├── PTY Capture           ├── SQLite
   └── Terminal polling       └── Session matching
```

- **Agent**: cmux Unix socket + PTY 캡처 + relay 서버로 WebSocket 연결. npm 배포 (`npx cmux-relay-agent`)
- **Relay**: 인증 + 세션 매칭 + WebRTC 시그널링 브릿지. 실제 터미널 데이터는 전송하지 않음
- **Web**: React + xterm.js. relay 서버에서 정적 호스팅 또는 nginx로 서빙
- **P2P**: WebRTC DataChannel로 agent↔browser 직접 연결. relay는 시그널링(SDP/ICE 교환)만 담당
- **Fallback**: P2P 연결 실패시(NAT 제한 등) 기존 relay WebSocket 경유로 자동 전환

### Local Mode (`--local`)

```
Agent (Mac) ◄──WS──► Browser (LAN)
   │
   ├── cmux Unix Socket
   ├── PTY Capture
   ├── HTTP Server (web UI 서빙)
   └── WebSocket Server
```

- Agent가 직접 WebSocket + HTTP 서버 실행. relay 없이 LAN 내에서 동작
- 인증: "Connect (Local)" 버튼으로 JWT 쿠키 발급 (`/api/local/auth`)

## Commands

```bash
pnpm install                    # 의존성 설치
pnpm -r run typecheck           # 전체 타입체크

# 개발 서버
pnpm dev                        # Agent (cmux → relay, 기본 포트 8080)
pnpm dev:relay                  # Relay 서버 (포트 3001)
pnpm dev:web                    # 웹 클라이언트 (http://localhost:3000)

# 빌드
pnpm --filter web build         # 웹 클라이언트 프로덕션 빌드
pnpm --filter @cmux-relay/shared build  # shared 패키지 빌드

# 테스트
pnpm test                       # 전체 테스트
pnpm test:unit                  # 단위 테스트만
pnpm test:integration           # 통합 테스트만

# Agent CLI
npx cmux-relay-agent                          # 클라우드 모드
npx cmux-relay-agent --local --port 9090      # 로컬 모드
npx cmux-relay-agent --relay-url wss://...    # 커스텀 relay
```

## Project Structure

```
packages/shared/   # WebSocket 프로토콜 타입, 메시지 정의 (zero-dependency)
packages/agent/    # Mac 에이전트: cmux client + PTY capture + WS server + relay connection
packages/relay/    # 릴레이 서버: 세션 매칭 + GitHub OAuth + SQLite + WS 브릿지
packages/web/      # React + Vite + xterm.js (모바일 반응형)
tests/             # 테스트 (단위/통합/E2E)
```

## Key Files

| 파일 | 역할 |
|---|---|
| **Agent** | |
| `packages/agent/src/index.ts` | 진입점. CLI 파싱, local/cloud 모드 분기 |
| `packages/agent/src/cmux-client.ts` | cmux Unix socket v2 JSON-RPC 클라이언트 |
| `packages/agent/src/ws-server.ts` | Local mode WebSocket + HTTP 서버 |
| `packages/agent/src/session-store.ts` | 인메모리 세션/클라이언트/알림 관리 |
| `packages/agent/src/relay-connection.ts` | Cloud mode relay 서버 WebSocket 연결 + WebRTC P2P 통합 |
| `packages/agent/src/webrtc-transport.ts` | WebRTC DataChannel 전송 계층 (node-datachannel) |
| `packages/agent/src/message-handler.ts` | 클라이언트 메시지 라우팅 (cloud mode) |
| `packages/agent/src/input-handler.ts` | 웹 입력 → cmux 포워딩 |
| `packages/agent/src/pty-capture.ts` | mkfifo 기반 PTY 출력 캡처 |
| `packages/agent/src/auth.ts` | JWT 생성/검증 |
| **Relay** | |
| `packages/relay/src/index.ts` | 릴레이 서버 진입점 |
| `packages/relay/src/ws-handler.ts` | Agent/Client WebSocket 연결 처리 |
| `packages/relay/src/http-handler.ts` | REST API + GitHub OAuth 콜백 |
| `packages/relay/src/session-registry.ts` | 세션 등록/매칭/데이터 브릿지 |
| `packages/relay/src/pairing-registry.ts` | 페어링 코드 생성/승인/거부 |
| `packages/relay/src/github-oauth.ts` | GitHub OAuth 플로우 (Arctic) |
| `packages/relay/src/db.ts` | SQLite 사용자/API 토큰 관리 |
| `packages/relay/src/auth.ts` | JWT 세션 생성/검증 |
| **Shared** | |
| `packages/shared/src/protocol.ts` | 모든 WebSocket 메시지 타입 정의 |
| `packages/shared/src/types.ts` | Workspace, Surface, Pane, Notification 타입 |
| **Web** | |
| `packages/web/src/App.tsx` | 라우팅: `/pair/:code`, `/terminal`, `/` |
| `packages/web/src/hooks/useRelay.ts` | React WebSocket + WebRTC 훅 (transport 상태 포함) |
| `packages/web/src/components/Layout.tsx` | Local mode 터미널 UI |
| `packages/web/src/components/RelaySessionLayout.tsx` | Cloud mode 터미널 UI |
| `packages/web/src/components/LoginPage.tsx` | GitHub 로그인 + Local 모드 감지 |

## cmux Socket API

Agent가 사용하는 cmux v2 JSON-RPC 메서드:

- `workspace.list` — 활성 워크스페이스 조회
- `surface.list` — 워크스페이스 내 탭/분할 조회
- `surface.list_panes` — 워크스페이스 내 분할 레이아웃 조회
- `debug.terminal.read_text` — 현재 터미널 화면 텍스트 읽기
- `surface.send_text` — 터미널에 텍스트 입력
- `surface.send_key` — 특수키 입력
- `notification.list` — cmux 알림 조회

Socket 경로: `CMUX_SOCKET_PATH` env 또는 `~/Library/Application Support/cmux/cmux.sock`

## WebSocket Protocol

### Client → Agent (Local) / Client → Relay → Agent (Cloud)

`auth`, `workspaces.list`, `surface.select`, `input`, `resize`

### Agent → Client (Local direct / Cloud via relay)

`workspaces`, `surfaces`, `panes`, `surface.active`, `output`, `notifications`, `error`

### Agent ↔ Relay (Cloud mode)

- `agent.register` / `session.created` — 세션 등록
- `agent.data` / `client.data` — 양방향 데이터 브릿지
- `agent.heartbeat` — keepalive (30초)
- `agent.pair` / `pairing.wait` / `pairing.approved` / `pairing.rejected` — 페어링 플로우
- `client.connected` / `client.disconnected` — 클라이언트 연결 상태

### WebRTC 시그널링 (agent.data / client.data로 전달)

- `webrtc.offer` — Agent → Client: SDP offer (P2P 연결 시도)
- `webrtc.answer` — Client → Agent: SDP answer
- `webrtc.ice-candidate` — 양방향: ICE candidate 교환 (trickle ICE)

P2P 연결 성공시 터미널 데이터는 DataChannel로 직접 전송. 실패시 relay WebSocket으로 fallback.

모든 메시지 JSON. 터미널 데이터는 base64 인코딩.

프로토콜 변경 시 `packages/shared/src/protocol.ts`에 타입을 먼저 추가.

## Web Routing

| 경로 | 컴포넌트 | 설명 |
|---|---|---|
| `/pair/:code` | PairPage | 에이전트 페어링 승인 |
| `/terminal` | TerminalPage → RelaySessionLayout | 터미널 뷰 (API로 세션 조회) |
| `/` | HomePage | Local → Layout / Cloud → DashboardPage |

Local mode 감지: `/api/mode` → `{mode: "local"}` 시 "Connect (Local)" 버튼 표시

## Testing

```bash
pnpm test                # 전체 테스트 (순차 실행)
pnpm test:unit           # 단위 테스트 (agent + relay)
pnpm test:integration    # 통합 테스트 (WS 서버 + 클라이언트)
npx playwright test      # Playwright E2E 테스트
```

- `node:test` + `tsx`로 실행 (별도 프레임워크 없음)
- **단위 테스트**: `tests/unit/agent/` (6파일), `tests/unit/relay/` (3파일)
- **통합 테스트**: `tests/integration.test.ts` — mock 서버에서 WS 프로토콜 검증
- **E2E 테스트**: `tests/e2e/` — Playwright 브라우저 테스트
  - `webrtc-p2p.spec.ts` — node-datachannel(agent) ↔ RTCPeerConnection(browser) P2P 연결 검증
  - `mobile-scroll.spec.ts` — 터미널 스크롤 동작
  - `notification-toast.spec.ts` — 알림 토스트
- **E2E 테스트 (cmux)**: `tests/e2e-agent.test.ts` — 실제 cmux 소켓 필요
- 테스트는 랜덤 포트에서 격리된 서버 인스턴스 사용

## Conventions

- **TypeScript strict mode** — 모든 패키지
- **pnpm workspace** — monorepo
- **브라우저 코드에서 `Buffer` 금지** — `btoa`/`atob` 사용
- **의존성 최소** — shared 패키지는 zero-dependency
- **Agent 빌드** — esbuild로 CJS 번들링 (`"type": "module"` 없음)
- **WebRTC** — Agent: `node-datachannel`, Browser: native `RTCPeerConnection`, 시그널링은 relay WebSocket 경유

## Git

- main 브랜치에 직접 push
- GitHub: `pallidev/cmux-relay`, SSH remote (`git@pallidev:pallidev/cmux-relay.git`)

## Docs

- [WebRTC P2P Architecture](docs/webrtc-p2p-architecture.md) — P2P 연결 아키텍처, 장단점, 기술 스택
