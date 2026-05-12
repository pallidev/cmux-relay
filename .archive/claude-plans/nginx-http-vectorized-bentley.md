# HTTP 421 (Misdirected Request) 원인 분석 및 수정 계획

## Context

모바일 브라우저(Samsung Browser, iPhone Safari)에서 `cmux.gateway.myaddr.io` 접속 시 HTTP 421 에러가 간헐적으로 발생. 총 55건 확인 (4/24 ~ 5/2). 원인은 **HTTP/2 Connection Coalescing**으로, 동일 인증서(`*.gateway.myaddr.io`)와 동일 IP를 공유하는 여러 서버 블록 간에 브라우저가 HTTP/2 연결을 재사용하면서 SNI와 `:authority` 불일치가 발생함.

## 원인 분석

### 요청 흐름
1. 브라우저가 `relay.gateway.myaddr.io`에 HTTP/2 연결 수립 (TLS SNI = relay)
2. `cmux.gateway.myaddr.io` 요청도 같은 연결에서 전송 (`:authority` = cmux)
3. nginx가 SNI(relay)와 `:authority`(cmux) 불일치 감지 → **421 반환**

### 근본 원인
`cmux-relay.conf`의 서버 블록에 `http2 on;`이 누락되어 있음:
- `nginx.conf`의 `gateway.myaddr.io` 서버: `http2 on;` ✓
- `nginx.conf`의 와일드카드 서버: `http2 on;` ✓
- `cmux-relay.conf`의 cmux 서버: `http2 on;` ✗
- `cmux-relay.conf`의 relay 서버: `http2 on;` ✗

nginx 1.25.1+에서는 `http2 on;`이 설정된 서버 블록끼리 HTTP/2 `:authority` 기반 라우팅이 가능함. 누락된 서버 블록은 HTTP/2 연결 재사용 시 421을 반환함.

## 수정 계획

### 파일: `/opt/homebrew/etc/nginx/servers/cmux-relay.conf`

**cmux 서버 블록** (1-63행):
- `listen 443 ssl;` 아래에 `http2 on;` 추가

**relay 서버 블록** (66-85행):
- `listen 443 ssl;` 아래에 `http2 on;` 추가

### 변경 내용

```nginx
# cmux 서버
server {
    listen 443 ssl;
    http2 on;                    # ← 추가
    server_name cmux.gateway.myaddr.io;
    ...
}

# relay 서버
server {
    listen 443 ssl;
    http2 on;                    # ← 추가
    server_name relay.gateway.myaddr.io;
    ...
}
```

## 검증

1. `sudo nginx -t` — 설정 문법 검사
2. `sudo nginx -s reload` — 설정 적용
3. 모바일 브라우저에서 `cmux.gateway.myaddr.io` 접속 후 421 에러 감시:
   ```bash
   tail -f /opt/homebrew/var/log/nginx/access.log | grep ' 421 '
   ```
