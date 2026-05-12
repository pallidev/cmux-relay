# 로컬 터널 서비스 설치 계획

## Context

ngrok과 같은 로컬 터널 서비스를 이 Mac에서 구축하고자 함. frps(서버) + frpc(클라이언트) 모두 이 Mac에서 로컬 실행. 개발용 로컬 터널링이 주 목적.

## 대안 조사 결과 및 추천

| 항목 | frp | Piko | Bore | Rathole |
|------|-----|------|------|---------|
| Stars | ~90k | ~3k | ~8k | ~9k |
| 언어 | Go | Go | Rust | Rust |
| 프로토콜 | TCP/UDP/HTTP/HTTPS/P2P | HTTP/HTTPS/TCP | TCP만 | TCP/UDP |
| 대시보드 | O | X | X | X |
| 부하분산 | O | O | X | X |
| 암호화 | TLS | JWT | Secret | TLS |
| 유지보수 | 매우 활발 | 활발 | 활발 | 활발 |

### 추천: **frp (fatedier/frp)**

이유:
1. 압도적 커뮤니티 (90k+ stars)
2. 가장 완전한 기능 (ngrok 대비 기능 우위)
3. 웹 대시보드 제공
4. Homebrew로 간편 설치
5. 기존 홈서버 스택(Nginx + DuckDNS + SSL)과 자연스럽게 연동 가능

## 구현 계획

### Step 1: frp 설치

```bash
brew install frp
```

frps(서버), frpc(클라이언트) 바이너리 설치됨.

### Step 2: frps 서버 설정 파일 생성

파일: `/opt/homebrew/etc/frp/frps.toml`

```toml
bindPort = 7000
vhostHTTPPort = 7080

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "<생성된_비밀번호>"

auth.token = "<openssl rand -hex 32로 생성>"
```

포트 할당:
| 포트 | 용도 |
|------|------|
| 7000 | frps 바인딩 (frpc 연결 포트) |
| 7080 | HTTP 가상호스트 (Nginx와 연동) |
| 7500 | 대시보드 (localhost만) |

### Step 3: frpc 클라이언트 설정 파일 생성

파일: `/opt/homebrew/etc/frp/frpc.toml`

```toml
serverAddr = "127.0.0.1"
serverPort = 7000
auth.token = "<서버와 동일한 토큰>"

# 예시 터널
[[proxies]]
name = "app-tunnel"
type = "http"
localIP = "127.0.0.1"
localPort = 8080
customDomains = ["tunnel.jjongin.duckdns.org"]
```

### Step 4: 서비스 시작 및 검증

```bash
brew services start frps
brew services start frpc
curl http://127.0.0.1:7500  # 대시보드 확인
```

### Step 5: 기존 Nginx와 연동 (선택)

`tunnel.jjongin.duckdns.org` 서버 블록을 Nginx에 추가하여 frp vhost 포트(7080)로 프록시.

### Step 6: 노트 작성

`00-Inbox/frp-tunnel-setup.md`에 Obsidian 마크다운으로 설치 가이드 작성. 기존 home-server 시리즈(`[[home-server-guide]]`)와 위키링크로 연결.

## 주요 파일 경로

- `/opt/homebrew/etc/frp/frps.toml` — 서버 설정 (신규 생성)
- `/opt/homebrew/etc/frp/frpc.toml` — 클라이언트 설정 (신규 생성)
- `/opt/homebrew/etc/nginx/nginx.conf` — 기존 Nginx 설정 (선택적 수정)
- `/Users/jong-in/Documents/mynote/00-Inbox/frp-tunnel-setup.md` — 문서 (신규 생성)
- `/Users/jong-in/Documents/mynote/01-Projects/home-server/home-server-guide.md` — 시리즈 인덱스 (업데이트)

## 검증 방법

1. `brew services list | grep frp` — 서비스 실행 확인
2. `curl http://127.0.0.1:7500` — 대시보드 접속 확인
3. 로컬 서비스(예: python http.server) 띄우고 터널링 동작 테스트
4. Nginx 연동 시 `https://tunnel.jjongin.duckdns.org` 접속 확인
