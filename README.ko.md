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

## 빠른 시작

### 사전 요구 사항

- [cmux](https://github.com/manaflow-ai/cmux) 설치 및 실행 중
- Node.js 20+
- pnpm

### 설치 및 실행

```bash
# 방법 1: 한 줄 실행 (권장)
npx @cmux-relay/agent

# 방법 2: 소스에서 실행
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm dev
```

끝입니다. 에이전트가:

1. 브라우저를 페어링 페이지로 자동 열기
2. GitHub 로그인 (최초 1회만)
3. 자동 승인 후 라이브 터미널로 이동

이후 실행 시 저장된 토큰을 재사용합니다 — `pnpm dev` (또는 `npx @cmux-relay/agent`)만 실행하면 브라우저가 바로 터미널로 열립니다.

### 모든 기기에서 접속

페어링 후 터미널이 활성화됩니다:

```
https://cmux.jaz.duckdns.org/s/{sessionId}
```

휴대폰, 태블릿, 어떤 브라우저에서든 이 URL을 열면 됩니다. 이미 로그인한 상태면 루트 URL(`https://cmux.jaz.duckdns.org`)에서 자동으로 활성 세션으로 이동합니다.

### 로컬 모드

클라우드 릴레이 없이 LAN에서 직접 실행:

```bash
pnpm dev -- --local --port 8080
```

## 동작 원리

```
┌───────────────────────────────────────┐                  ┌──────────────────┐
│          에이전트 (Mac)                │                  │ 웹 클라이언트      │
│                                       │                  │ (모든 브라우저)    │
│  ┌─────────────┐  ┌───────────────┐  │                  │ • xterm.js        │
│  │ cmux 소켓   │  │ PTY 캡처      │  │   클라우드 릴레이  │ • 모바일 UX       │
│  │ (JSON-RPC)  │  │ (mkfifo)      │  │ ◄──────────────► │ • 키보드 입력     │
│  └──────┬──────┘  └───────┬───────┘  │                  └──────────────────┘
│         │                 │          │
│         └────┬────────────┘          │
│              ▼                       │
│  ┌───────────────────────────────┐   │
│  │    RelayConnection (WS)       │   │
│  └───────────────────────────────┘   │
└───────────────────────────────────────┘
```

에이전트가 릴레이 서버로 아웃바운드 연결 — 인바운드 포트 불필요. 릴레이가 에이전트 ↔ 웹 클라이언트 연결을 브릿지합니다.

## 기능

### 핵심

- **실시간 스트리밍** — WebSocket + mkfifo PTY 캡처
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
- **브라우저 푸시 알림** — 네이티브 OS 알림
- **인앱 토스트** — 색상 구분, 자동 닫힘
- **클릭 이동** — 해당 워크스페이스/서피스로 이동

### 보안

- **GitHub OAuth** — GitHub 계정으로 로그인
- **JWT 세션** — HttpOnly 쿠키 기반 인증
- **API 토큰** — SHA-256 해시, 페어링 시 자동 생성
- **TLS** — 종단간 HTTPS/WSS

## CLI 옵션

```bash
pnpm dev -- [옵션]
```

| 플래그 | 환경변수 | 기본값 | 설명 |
|--------|---------|--------|------|
| `--relay-url` | `CMUX_RELAY_URL` | `wss://relay.jaz.duckdns.org/ws/agent` | 릴레이 서버 URL |
| `--token` | `CMUX_RELAY_TOKEN` | — | API 토큰 (페어링 후 자동 저장) |
| `--local` | — | — | 로컬 모드 실행 (직접 WebSocket) |
| `--port` | `CMUX_RELAY_PORT` | `8080` | 로컬 모드 서버 포트 |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | 로컬 모드 바인드 주소 |
| `--socket` | `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix 소켓 경로 |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS 인증서 파일 |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS 개인키 파일 |

## 프로젝트 구조

```
cmux-relay/
├── packages/
│   ├── shared/     # 프로토콜 타입 및 메시지 정의 (의존성 없음)
│   ├── agent/      # 에이전트 — cmux 클라이언트 + PTY 캡처 + 릴레이 연결
│   ├── relay/      # 릴레이 서버 — 세션 매칭 + 인증 + 데이터 브릿지
│   └── web/        # React + xterm.js 웹 클라이언트
├── tests/          # 통합 테스트
└── package.json    # pnpm 워크스페이스 루트
```

## 개발

```bash
pnpm install              # 의존성 설치
pnpm -r run typecheck     # 전체 타입체크
pnpm test                 # 통합 테스트 실행
pnpm --filter web build   # 웹 클라이언트 프로덕션 빌드
```

## 라이선스

[MIT](LICENSE)
