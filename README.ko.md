<h1 align="center">cmux-relay</h1>

<p align="center">
  cmux 터미널 세션을 모든 기기에서 실시간으로 스트리밍하세요.<br/>
  휴대폰에서 AI 코딩 에이전트(Claude Code, Codex CLI, Gemini CLI)를 모니터링하세요.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-relay-agent"><img src="https://img.shields.io/npm/v/cmux-relay-agent" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/cmux-relay-agent"><img src="https://img.shields.io/npm/dt/cmux-relay-agent" alt="npm downloads" /></a>
  <a href="https://github.com/pallidev/cmux-relay/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple" alt="Platform" />
  <img src="https://img.shields.io/badge/terminal-cmux-89b4fa" alt="cmux" />
</p>

<p align="center">
  <b>빠른 시작:</b><br/>
  <code>npx cmux-relay-agent</code>
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

## 빠른 시작

필요에 따라 세 가지 방법으로 사용할 수 있습니다.

### 1. 에이전트만 사용 (클라우드 릴레이)

가장 간단한 방법입니다. Mac에서 에이전트만 실행하면 공개 클라우드 릴레이에 연결되고, 모든 기기에서 터미널에 접속할 수 있습니다.

```bash
npx cmux-relay-agent
```

에이전트가:

1. 브라우저를 페어링 페이지로 자동 열기
2. GitHub 로그인 (최초 1회만)
3. 자동 승인 후 라이브 터미널로 이동

이후 실행 시 저장된 토큰을 재사용합니다 — `npx cmux-relay-agent`만 실행하면 브라우저가 바로 터미널로 열립니다.

모든 기기에서 접속:

```
https://cmux.gateway.myaddr.io
```

**필요한 것:** cmux, Node.js 20+. 그 외에는 아무것도 필요 없습니다.

### 2. 로컬 모드 (LAN 직접 연결)

클라우드 릴레이 없이 실행합니다. 에이전트가 로컬 WebSocket 서버를 시작하며, 같은 네트워크 내에서만 동작합니다.

```bash
# 소스에서 실행
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm dev -- --local --port 8080
```

같은 네트워크의 브라우저에서 `http://<Mac-IP>:8080`을 엽니다.

**필요한 것:** cmux, Node.js 20+, pnpm. 인터넷 연결 불필요.

### 3. 셀프 호스팅 (자체 릴레이 서버)

자체 릴레이 서버를 운영합니다. 팀, 사설 네트워크, 커스텀 도메인에 적합합니다.

```bash
# 클론 및 빌드
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install

# shared 패키지를 먼저 빌드
pnpm --filter @cmux-relay/shared build

# 릴레이 서버 시작
cd packages/relay && npx tsx src/index.ts
```

릴레이 서버에 필요한 것:

- **GitHub OAuth 앱** — `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` 환경변수 설정
- **리버스 프록시** — nginx 등으로 TLS(WSS) 및 라우팅 처리
- **SQLite** — 사용자/토큰 저장소 (자동 생성)

에이전트를 자체 릴레이에 연결:

```bash
npx cmux-relay-agent --relay-url wss://your-relay.example.com/ws/agent
```

또는 기본 릴레이 URL을 변경하여 agent 패키지를 빌드 및 배포합니다.

**필요한 것:** 에이전트 Mac과 클라이언트 브라우저 모두에서 접근 가능한 서버, TLS 인증서.

## 아키텍처

### 클라우드 모드 (기본)

```
┌──────────────────────────┐         ┌──────────────────────┐
│  내 Mac                  │         │  릴레이 서버          │
│                          │         │  (Mac Mini / VPS)    │
│  cmux ─소켓─► 에이전트   │ WS      │                      │
│  (Ghostty)    │          ├───────► │  인증 + 시그널링      │
│               PTY        │  SDP/   │  세션 매칭           │
│               캡처       │  ICE    │  GitHub OAuth        │
│                          │         │  SQLite              │
│                  WebRTC  │         └──────┬───────────────┘
│                  DataChannel              │         ▲
│                     ║                     │  SDP/ICE만
│                     ║                     ▼         ║
│                     ╚═══════════════════════════════╝
│                              P2P 직접 연결
└──────────────────────────┘
         │                                     │
         └──── WebRTC DataChannel (P2P) ──────┘
                            │
                     ┌──────▼───────────────┐
                     │  웹 클라이언트        │
                     │  (모든 브라우저)      │
                     │  • xterm.js           │
                     │  • 모바일 UX          │
                     └──────────────────────┘
```

에이전트가 릴레이 서버로 아웃바운드 연결합니다 — Mac에 인바운드 포트가 필요 없습니다. 터미널 데이터는 WebRTC P2P로 에이전트와 브라우저 간 **직접 전송**됩니다. 릴레이는 인증과 시그널링(SDP/ICE 교환)만 처리합니다. P2P 연결이 실패하면 릴레이 WebSocket으로 자동 전환됩니다.

### 로컬 모드

```
┌──────────────────────────┐         ┌──────────────────────┐
│  내 Mac                  │         │  브라우저 (LAN)      │
│                          │         │                      │
│  cmux ─소켓─► 에이전트   │  WS     │  ws://mac-ip:8080    │
│  (Ghostty)    │          ├────────►│                      │
│               PTY        │         │                      │
│               캡처       │         │                      │
└──────────────────────────┘         └──────────────────────┘
```

릴레이 서버 없이 에이전트가 직접 WebSocket 서버를 실행합니다. 같은 네트워크에서만 동작합니다.

## 패키지 구조

```
cmux-relay/
├── packages/
│   ├── shared/     # 프로토콜 타입 및 메시지 정의 (의존성 없음)
│   ├── agent/      # Mac에서 실행 — cmux 클라이언트 + PTY 캡처 + 릴레이 연결
│   ├── relay/      # 서버에서 실행 — 세션 매칭 + 인증 + 데이터 브릿지
│   └── web/        # React + xterm.js 웹 클라이언트
├── tests/          # 통합 테스트
└── package.json    # pnpm 워크스페이스 루트
```

| 사용자 유형 | 필요한 패키지 |
|---|---|
| 에이전트 사용자 (`npx cmux-relay-agent`) | `agent` (npm 배포, `shared` 포함) |
| 로컬 모드 (`--local`) | `agent` + `shared` (소스에서) |
| 셀프 호스팅 | 전체 패키지 (`agent` + `relay` + `web` + `shared`) |

## 기능

### 핵심

- **실시간 스트리밍** — WebSocket + mkfifo PTY 캡처
- **P2P 데이터 전송** — WebRTC DataChannel로 에이전트↔브라우저 직접 통신. 릴레이는 시그널링만 처리
- **자동 폴백** — P2P 실패시(NAT/방화벽) 릴레이 WebSocket으로 자동 전환
- **양방향 입력** — 모든 기기에서 명령 전송
- **분할 레이아웃** — 픽셀 단위 cmux 분할 위치 재현
- **멀티 워크스페이스** — 모든 cmux 워크스페이스 전환
- **페어링 코드 플로우** — 원클릭 GitHub 로그인으로 에이전트 연동
- **자동 재연결** — 지수 백오프 + 세션 복구

### 모바일 경험

- **전체화면 터미널** — 터치 기기 최적화
- **스와이프 내비게이션** — 좌우 스와이프로 워크스페이스 전환
- **탭 바** — 워크스페이스 내 서피스 전환
- **자동 리다이렉트** — 로그인 한 번, 바로 터미널로

### 알림

- **cmux 알림 폴링** — 2초 간격
- **모바일 푸시 알림** — PWA 설치 시 iOS/Android에서 시스템 알림 수신 (Web Push + VAPID)
- **인앱 토스트** — 색상 구분, 자동 닫힘
- **클릭 이동** — 알림 클릭 시 해당 워크스페이스/서피스로 자동 이동
- **설치 유도 배너** — 모바일 브라우저에서 PWA 설치 안내

### 보안

- **GitHub OAuth** — GitHub 계정으로 로그인
- **JWT 세션** — 쿠키 기반 인증 (30일 만료)
- **API 토큰** — SHA-256 해시, 페어링 시 자동 생성
- **TLS** — 종단간 HTTPS/WSS

## CLI 옵션

```bash
npx cmux-relay-agent [옵션]
# 또는 소스에서: pnpm dev -- [옵션]
```

| 플래그 | 환경변수 | 기본값 | 설명 |
|--------|---------|--------|------|
| `--relay-url` | `CMUX_RELAY_URL` | `wss://relay.gateway.myaddr.io/ws/agent` | 릴레이 서버 URL |
| `--token` | `CMUX_RELAY_TOKEN` | — | API 토큰 (페어링 후 자동 저장) |
| `--local` | — | — | 로컬 모드 실행 (직접 WebSocket) |
| `--port` | `CMUX_RELAY_PORT` | `8080` | 로컬 모드 서버 포트 |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | 로컬 모드 바인드 주소 |
| `--socket` | `CMUX_SOCKET_PATH` | `~/Library/Application Support/cmux/cmux.sock` | cmux Unix 소켓 경로 |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS 인증서 파일 |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS 개인키 파일 |

## 개발

```bash
pnpm install              # 의존성 설치
pnpm -r run typecheck     # 전체 타입체크
pnpm test                 # 통합 테스트 실행
pnpm --filter web build   # 웹 클라이언트 프로덕션 빌드
```

## 라이선스

[MIT](LICENSE)
