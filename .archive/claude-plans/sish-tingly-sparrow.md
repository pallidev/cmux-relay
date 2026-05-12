# sish Docker → Native 설치 전환

## Context

Docker Desktop 의존성으로 인해 데스크톱이 멈추면 sish도 중단되는 문제가 발생함. launchd 기반 native 설치로 전환하여 부팅 시 자동 시작되도록 개선.

## 현재 Docker 실행 설정 (마이그레이션할 설정)

```
--ssh-address=:2222
--http-address=:8080
--domain=jaz.duckdns.org
--https=false
--http-port-override=80
--bind-random-ports=false
--bind-random-subdomains=false
--authentication-keys-directory=/pubkeys  → ~/sish/pubkeys
--authentication-password=<비밀번호>
--private-keys-directory=/keys            → ~/sish/keys
--tcp-aliases=true
--verify-ssl=false
--debug=false
```

## 시스템 정보

- macOS arm64 (Apple Silicon)
- 기존 데이터: `~/sish/` (keys, pubkeys, password.txt)

## 작업 단계

### 1. sish 바이너리 설치
- GitHub Releases에서 `sish-2.22.1.darwin-arm64.tar.gz` 다운로드
- `/usr/local/bin/sish`에 설치

### 2. launchd 서비스 등록
- `~/Library/LaunchAgents/com.sish.plist` 생성
- 기존 Docker 플래그와 동일한 인자로 실행
- KeepAlive 설정으로 크래시 시 자동 재시작

### 3. Docker 컨테이너 정리
- 기존 sish Docker 컨테이너 중지 및 제거

### 4. 노트 업데이트
- `00-Inbox/sish-tunnel-setup.md` 문서를 native 설치 기준으로 업데이트

## 검증

1. `launchctl list | grep sish`로 서비스 등록 확인
2. `ssh -p 2222 localhost`로 로컬 접속 테스트
3. 외부 기기에서 터널 생성 테스트
