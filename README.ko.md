<h1 align="center">cmux-relay</h1>

<p align="center">
  cmux 터미널 세션을 모든 기기에서 실시간으로 스트리밍하세요.<br/>
  휴대폰에서 AI 코딩 에이전트(Claude Code, Codex CLI, Gemini CLI)를 모니터링하세요.
</p>

<p align="center">
  <a href="https://github.com/pallidev/cmux-relay/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple" alt="Platform" />
  <img src="https://img.shields.io/badge/terminal-cmux-89b4fa" alt="cmux" />
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## 왜 cmux-relay인가?

[Cmux](https://github.com/manaflow-ai/cmux)(Ghostty 기반 macOS 터미널)에서 Claude Code 같은 AI 코딩 에이전트를 실행합니다. 자리를 비웠을 때도:

- **모니터링** — 휴대폰에서 에이전트 진행 상황을 실시간으로 확인
- **명령 전송** — 에이전트가 입력을 기다릴 때 휴대폰에서 명령 전송
- **세션 전환** — 여러 터미널 세션 간 전환
- **알림 수신** — 에이전트 완료 또는 에러 발생 시 알림

## 동작 원리

```
┌───────────────────────────────────────┐    WebSocket    ┌──────────────────┐
│            서버 (Mac)                  │ ◄─────────────► │ 웹 클라이언트      │
│                                       │                 │ (휴대폰 브라우저)  │
│  ┌─────────────┐  ┌───────────────┐  │                 │ • xterm.js        │
│  │ cmux 소켓   │  │ PTY 캡처      │  │                 │ • 모바일 UX       │
│  │ (JSON-RPC)  │  │ (mkfifo)      │  │                 │ • 키보드 입력     │
│  └──────┬──────┘  └───────┬───────┘  │                 └──────────────────┘
│         │                 │          │
│         └────┬────────────┘          │
│              ▼                       │
│  ┌───────────────────────────────┐   │
│  │     WebSocket 서버             │   │
│  │  • JWT 인증  • 세션 관리      │   │
│  │  • 스트리밍  • 입력 릴레이    │   │
│  │  • 알림      • TLS           │   │
│  └───────────────────────────────┘   │
└───────────────────────────────────────┘
```

## 기능

### 핵심

- **실시간 스트리밍** — WebSocket + mkfifo PTY 캡처로 cmux 터미널 출력을 브라우저로 실시간 전송
- **양방향 입력** — 휴대폰에서 타이핑하면 cmux에 즉시 전달
- **분할 레이아웃** — cmux의 실제 분할 배열을 픽셀 단위로 재현
- **멀티 워크스페이스** — 모든 cmux 워크스페이스 조회 및 전환
- **셀프 호스팅** — 내 Mac에서 실행. 클라우드 의존성 없음
- **단일 프로세스** — 하나의 명령으로 모든 것 시작 (cmux 클라이언트 + PTY 캡처 + WebSocket 서버)

### 모바일 경험

- **모바일 전용 레이아웃** — 터치 기기에 최적화된 단일 터미널 전체화면
- **스와이프 내비게이션** — 좌우 스와이프로 워크스페이스 전환
- **탭 바** — 워크스페이스 내 서피스 간 전환을 위한 가로 탭 바
- **터치 최적화** — 워크스페이스 카운터(`1/4`)가 표시되는 헤더 내비게이션

### 알림

- **cmux 알림 폴링** — 2초 간격으로 cmux 알림 조회
- **브라우저 푸시 알림** — Notification API를 통한 네이티브 OS 알림
- **인앱 토스트 팝업** — 색상 구분 슬라이드인 토스트(info/success/warning/error), 자동 닫힘
- **알림 패널** — 데스크탑 사이드바에서 읽음/안읽음 상태의 전체 알림 이력 표시
- **클릭 이동** — 토스트나 알림 클릭 시 해당 워크스페이스/서피스로 이동

### 보안 및 연결

- **JWT 인증** — 자동 생성 클라이언트 토큰 기반 접근 제어
- **TLS 지원** — `--tls-cert`, `--tls-key` 플래그로 HTTPS/WSS 사용 가능
- **URL 토큰 전달** — `?token=xxx`로 빠른 모바일 연결

### UI

- **Catppuccin Mocha 다크 테마** — CSS 커스텀 프로퍼티 기반 일관된 다크 테마
- **반응형 디자인** — 데스크탑 사이드바 레이아웃 + 모바일 전체화면 레이아웃 자동 감지
- **글래스모피즘 로그인** — 백드롭 블러와 그라디언트 스타일의 모던 로그인 카드

## 빠른 시작

### 사전 요구 사항

- [cmux](https://github.com/manaflow-ai/cmux) 설치 및 실행 중
- Node.js 20+
- pnpm

### 설치

```bash
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
```

### 실행

**1. 서버 시작:**

```bash
pnpm dev
# → cmux에 연결, ws://0.0.0.0:8080에서 WebSocket 서버 시작
# → 클라이언트 토큰 출력
```

**2. 웹 클라이언트 열기:**

```
http://<Mac-IP>:8080
```

또는 개발용으로 별도 웹 서버 실행 (HMR 지원):

```bash
pnpm dev:web
# → http://localhost:3000
```

**3. 연결** — 서버에서 출력한 토큰을 입력하거나 URL에 추가:

```
http://<Mac-IP>:8080?token=<토큰>
```

### CLI 옵션

```bash
pnpm start -- --port 9090 --host 127.0.0.1 --socket /custom/cmux.sock --tls-cert cert.pem --tls-key key.pem
```

| 플래그 | 환경변수 | 기본값 | 설명 |
|--------|---------|--------|------|
| `--port` | `CMUX_RELAY_PORT` | `8080` | WebSocket 서버 포트 |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | 바인드 주소 |
| `--socket` | `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix 소켓 경로 |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS 인증서 파일 경로 |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS 개인키 파일 경로 |

## 아키텍처

### 서버 (`packages/server`)

단일 Node.js 프로세스:

1. **cmux 연결** — Unix 도메인 소켓을 통한 v2 JSON-RPC 프로토콜:

   | 동작 | cmux API 메서드 |
   |------|----------------|
   | 워크스페이스 목록 | `workspace.list` |
   | 서피스/탭 목록 | `surface.list` |
   | 터미널 화면 읽기 | `debug.terminal.read_text` |
   | 키보드 입력 전송 | `surface.send_text` / `surface.send_key` |
   | 알림 목록 | `notification.list` |

2. **PTY 출력 캡처** — `mkfifo` 네임드 파이프 사용. 파이프 생성 실패 시 `debug.terminal.read_text` 폴링으로 대체.

3. **알림 폴링** — 2초 간격으로 cmux에서 알림을 조회하여 모든 연결된 클라이언트에 브로드캐스트.

4. **WebSocket 연결 서비스** — JWT 인증 및 세션 관리. 선택적으로 TLS 지원.

### 웹 클라이언트 (`packages/web`)

React + [xterm.js](https://xtermjs.org/) 싱글 페이지 앱:

- **데스크탑**: 워크스페이스 목록 사이드바 + cmux 실제 배열과 일치하는 분할 레이아웃
- **모바일**: 스와이프 워크스페이스 내비게이션과 서피스 탭 바가 있는 전체화면 터미널
- 전체 ANSI 이스케이프 시퀀스 지원 터미널 렌더링
- 인앱 토스트 알림 + 브라우저 푸시 알림 지원
- Catppuccin Mocha 다크 테마 + 글래스모피즘 UI

## WebSocket 프로토콜

모든 메시지는 JSON over WebSocket. 터미널 데이터는 base64 인코딩.

**클라이언트 → 서버:**
```jsonc
{ "type": "auth", "payload": { "token": "..." } }                          // 인증
{ "type": "workspaces.list" }                                                // 워크스페이스 목록 요청
{ "type": "surface.select", "surfaceId": "..." }                            // 서피스 출력 구독
{ "type": "input", "surfaceId": "...", "payload": { "data": "<base64>" } }  // 키 입력 전송
{ "type": "resize", "surfaceId": "...", "payload": { "cols": 120, "rows": 40 } }
```

**서버 → 클라이언트:**
```jsonc
{ "type": "workspaces", "payload": { "workspaces": [...] } }                // 워크스페이스 목록
{ "type": "surfaces", "workspaceId": "...", "payload": { "surfaces": [...] } }  // 워크스페이스별 서피스 목록
{ "type": "panes", "workspaceId": "...", "payload": { "panes": [...], "containerFrame": {...} } }  // 분할 레이아웃
{ "type": "output", "surfaceId": "...", "payload": { "data": "<base64>" } }     // 터미널 출력 스트림
{ "type": "surface.active", "surfaceId": "...", "workspaceId": "..." }          // 서피스 활성화 확인
{ "type": "notifications", "payload": { "notifications": [...] } }               // cmux 알림
{ "type": "error", "payload": { "message": "..." } }                             // 에러
```

## 설정

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `CMUX_RELAY_PORT` | `8080` | WebSocket 서버 포트 |
| `CMUX_RELAY_HOST` | `0.0.0.0` | 서버 바인드 주소 |
| `CMUX_RELAY_JWT_SECRET` | `cmux-relay-dev-secret` | JWT 서명 시크릿 |
| `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix 소켓 경로 |
| `CMUX_RELAY_TLS_CERT` | — | TLS 인증서 파일 경로 |
| `CMUX_RELAY_TLS_KEY` | — | TLS 개인키 파일 경로 |

## 프로젝트 구조

```
cmux-relay/
├── packages/
│   ├── shared/     # 프로토콜 타입 및 메시지 정의 (의존성 없음)
│   ├── server/     # 서버 — cmux 클라이언트 + PTY 캡처 + WebSocket + 인증 + TLS
│   └── web/        # React + xterm.js 웹 클라이언트 (데스크탑 + 모바일 레이아웃)
├── tests/          # 통합 테스트 (node:test + tsx)
└── package.json    # pnpm 워크스페이스 루트
```

### 주요 파일

| 파일 | 역할 |
|------|------|
| `packages/shared/src/protocol.ts` | WebSocket 메시지 타입 정의 (클라이언트 ↔ 서버) |
| `packages/shared/src/types.ts` | 공유 데이터 타입 (Workspace, Surface, Pane, Notification) |
| `packages/server/src/ws-server.ts` | WebSocket 서버, 클라이언트 메시지 라우팅 |
| `packages/server/src/cmux-client.ts` | cmux Unix 소켓 v2 JSON-RPC 클라이언트 |
| `packages/server/src/pty-capture.ts` | mkfifo 기반 PTY 출력 캡처 |
| `packages/server/src/input-handler.ts` | 웹 클라이언트 입력 → cmux 포워딩 |
| `packages/server/src/session-store.ts` | 인메모리 세션/클라이언트/알림 상태 |
| `packages/server/src/auth.ts` | JWT 토큰 생성 및 검증 |
| `packages/web/src/hooks/useRelay.ts` | React WebSocket 훅 |
| `packages/web/src/components/Layout.tsx` | 데스크탑 레이아웃 (사이드바 + 분할 레이아웃) |
| `packages/web/src/components/MobileLayout.tsx` | 모바일 레이아웃 (전체화면 + 스와이프) |
| `packages/web/src/components/Terminal.tsx` | xterm.js 터미널 컴포넌트 |

## 개발

```bash
pnpm install              # 의존성 설치
pnpm -r run typecheck     # 전체 타입체크
pnpm test                 # 통합 테스트 실행
pnpm --filter web build   # 웹 클라이언트 프로덕션 빌드
```

## SessionCast와의 차이점

| | SessionCast | cmux-relay |
|---|---|---|
| 터미널 | tmux | cmux (Ghostty) |
| 플랫폼 | 크로스 플랫폼 | macOS |
| 호스팅 | 클라우드 SaaS | 셀프 호스팅 |
| 인증 | Google OAuth2 | JWT 토큰 |
| 서버 언어 | Java / Spring Boot | Node.js / TypeScript |
| 프로세스 | Agent + Relay (분리) | 단일 프로세스 |
| 알림 | — | cmux 알림 + 브라우저 푸시 |
| 모바일 UX | — | 스와이프 내비게이션이 있는 전용 모바일 레이아웃 |
| TLS | — | 선택적 내장 TLS |
| 소스 | 클로즈드 소스 | 오픈 소스 (MIT) |

## 라이선스

[MIT](LICENSE)
