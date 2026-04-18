# cmux-relay Cloud Service Design

## Context

cmux-relay는 현재 자가 호스팅 터미널 스트리밍 도구다. 사용자가 로컬에서 서버를 실행하고 같은 네트워크에서 웹으로 접속하는 구조다.

이것을 중앙 릴레이 서비스로 진화시킨다. 다른 사용자가 로컬에 에이전트를 실행하면, Mac mini에서 호스팅하는 중앙 릴레이 + 웹을 통해 외부에서 터미널에 접속할 수 있게 한다.

## Architecture

```
[사용자 로컬 PC]
  cmux (Ghostty) ←socket→ Local Agent ──outbound WS──→
                                                    ↓
                                          [Mac mini: jaz.duckdns.org]
                                            ├── nginx (리버스 프록시)
                                            │   ├── cmux.jaz.duckdns.org → 웹 클라이언트
                                            │   └── relay.jaz.duckdns.org → 릴레이 서버
                                            ├── Central Relay Server (Node.js)
                                            │   ├── 세션 ID 매칭
                                            │   ├── 에이전트/클라이언트 WS 브릿지
                                            │   ├── GitHub OAuth
                                            │   └── API 토큰 관리
                                            └── SQLite (사용자, 토큰)
                                                    ↑
                                          웹 브라우저 (모바일/PC)
                                            cmux.jaz.duckdns.org/s/{sessionId}
```

## Package Structure

```
packages/
  shared/    # 프로토콜 타입 (확장)
  agent/     # 기존 server → 이름 변경, 릴레이 연결 모드 추가
  web/       # 기존, 릴레이 서버 연결로 수정
  relay/     # 신규: 중앙 릴레이 서버
```

## Component Design

### 1. Central Relay Server (`packages/relay`)

세션 ID 기반 매칭으로 에이전트-클라이언트를 연결하고 데이터를 투명하게 브릿지한다.

**HTTP Endpoints:**

```
GET  /api/auth/github            GitHub OAuth 시작
GET  /api/auth/github/callback   OAuth 콜백, JWT 발급
GET  /api/auth/me                현재 사용자 정보
POST /api/tokens                 API 토큰 생성 (에이전트용)
DELETE /api/tokens/:id            API 토큰 삭제
GET  /api/sessions               내 활성 세션 목록
```

**WebSocket Endpoints:**

```
WS /ws/agent?token={apiToken}              에이전트 연결
WS /ws/client?token={jwt}&session={id}     웹 클라이언트 연결
```

**세션 ID 흐름:**

1. 사용자 GitHub 로그인 → API 토큰 발급 (`sk_crx_...`)
2. 로컬에서 `cmux-relay agent --token sk_crx_...` 실행
3. 에이전트가 릴레이에 연결 → 세션 ID 발급
4. 에이전트가 URL 출력: `https://cmux.jaz.duckdns.org/s/{sessionId}`
5. 웹 브라우저에서 접속 → 릴레이가 세션 매칭 → 데이터 브릿지

**의존성:**
- `ws` - WebSocket 서버
- `better-sqlite3` - 로컬 SQLite
- `jose` - JWT (ESM 네이티브)
- `arctic` - GitHub OAuth

### 2. Local Agent (`packages/agent`)

기존 `packages/server`를 수정. cmux 연결은 그대로, 클라이언트 통신은 중앙 릴레이로 우회.

**유지 (변경 없음):**
- `cmux-client.ts` - cmux Unix socket 연결
- `pty-capture.ts` - PTY 캡처
- `input-handler.ts` - 입력 포워딩
- `session-store.ts` - 로컬 세션 상태

**변경:**
- WebSocket 서버 실행 → 릴레이에 아웃바운드 WebSocket 연결
- JWT 발급/검증 → API 토큰으로 릴레이 인증
- HTTP 서버 제거

**CLI:**

```bash
# 클라우드 모드 (릴레이 서버 연결)
cmux-relay agent --token sk_crx_abc123

# 로컬 모드 (기존 방식, 하위호환)
cmux-relay agent --local --port 8080

# 환경변수
CMUX_RELAY_TOKEN=sk_crx_abc123 cmux-relay agent
```

### 3. Web Client (`packages/web`)

릴레이 서버 URL로 WebSocket 연결. 세션 ID는 URL path에서 추출.

**변경점:**
- WebSocket URL: `wss://relay.jaz.duckdns.org/ws/client?session={sessionId}`
- 인증: GitHub OAuth JWT (기존 자체 JWT → GitHub OAuth JWT)
- URL 라우팅: `/s/{sessionId}` 경로 지원
- 환경변수로 릴레이/웹 URL 설정 가능

## Protocol

### Agent ↔ Relay (신규)

```
Agent → Relay:
  { type: "agent.register" }                          # 세션 등록
  { type: "agent.data", payload: <ServerMessage> }    # 클라이언트에게 전달
  { type: "agent.heartbeat" }                          # 연결 유지

Relay → Agent:
  { type: "session.created", sessionId: string }      # 세션 ID 발급
  { type: "client.connected" }                         # 클라이언트 연결
  { type: "client.disconnected" }                      # 클라이언트 연결 해제
  { type: "client.data", payload: <ClientMessage> }   # 클라이언트 입력
```

### Client ↔ Relay (기존과 유사)

```
Client → Relay:
  { type: "auth", payload: { token: "<github-jwt>" } }
  { type: "workspaces.list" }
  { type: "surface.select", surfaceId: "..." }
  { type: "input", surfaceId: "...", payload: { data: "<base64>" } }
  { type: "resize", surfaceId: "...", payload: { cols: 120, rows: 40 } }

Relay → Client:
  { type: "workspaces", payload: { workspaces: [...] } }
  { type: "surfaces", workspaceId: "...", payload: { surfaces: [...] } }
  { type: "panes", workspaceId: "...", payload: { panes: [...], containerFrame: {...} } }
  { type: "output", surfaceId: "...", payload: { data: "<base64>" } }
  { type: "surface.active", surfaceId: "...", workspaceId: "..." }
  { type: "notifications", payload: { notifications: [...] } }
  { type: "error", payload: { message: "..." } }
```

릴레이는 터미널 데이터 메시지를 투명하게 전달. 라우팅만 담당.

## Auth

### GitHub OAuth Flow

```
1. 브라우저 → GET /api/auth/github → GitHub 로그인
2. GitHub → GET /api/auth/github/callback → JWT 발급 + HttpOnly 쿠키
3. 웹 클라이언트가 JWT로 WebSocket 인증
```

### API Token Flow (에이전트용)

```
1. 로그인 후 → POST /api/tokens → API 토큰 발급 (sk_crx_...)
2. 로컬: cmux-relay agent --token sk_crx_...
3. 에이전트가 API 토큰으로 릴레이 WebSocket 인증
4. 릴레이가 토큰 소유자 확인 → 세션 생성
```

## Database Schema (SQLite)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,  -- SHA-256 of token
  name TEXT,                         -- e.g. "my-macbook"
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

활성 세션은 인메모리로 관리. 서버 재시작 시 에이전트가 자동 재연결하여 세션 복구.

## Tech Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| Relay Server | Node.js + ws | 기존 서버와 동일 런타임 |
| HTTP Routing | Node.js 내장 http | 규모 작음, 프레임워크 불필요 |
| Database | SQLite (better-sqlite3) | Mac mini 로컬, 파일 기반 |
| Auth | GitHub OAuth + JWT (jose) | 개발자 친화적 |
| Web Hosting | nginx | Mac mini에서 직접 서브 |
| TLS | Let's Encrypt / DuckDNS TLS | nginx에서 처리 |
| Web Client | Vite + React + xterm.js | 기존 그대로 |

## MVP Scope

### 포함

- 중앙 릴레이 서버 (`packages/relay`)
- 로컬 에이전트 (`packages/agent`) - 릴레이 연결 모드
- 웹 클라이언트 - 릴레이 서버 연결
- GitHub OAuth 인증
- API 토큰 관리
- 세션 ID 기반 매칭
- 에이전트-클라이언트 데이터 브릿지
- 로컬 모드 하위호환

### 제외 (후속 작업)

- 결제 시스템
- 팀/협업 기능
- 다중 세션 (1사용자 다수 에이전트)
- sish 기반 standalone 터널링
- 관리자 대시보드
- 사용량 모니터링

## Verification

1. 릴레이 서버를 Mac mini에서 실행
2. 다른 PC에서 에이전트 실행 → 릴레이에 연결 → 세션 ID 획득
3. 모바일 브라우저에서 세션 URL 접속 → 터미널 출력 확인
4. 모바일에서 터미널 입력 → 로컬 cmux에 반영되는지 확인
5. 에이전트/릴레이 연결 끊김 후 자동 재연결 확인
6. GitHub OAuth 로그인/로그아웃 플로우 확인
7. API 토큰 발급/사용/삭제 확인
