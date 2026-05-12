# 커밋, Push 및 GitHub Release 도입

## Context

- 4개 커밋이 origin/main에 push되지 않은 상태
- 10개 수정 파일 + 1개 신규 파일이 uncommitted (ANSI color 보존, 재연결 안정화, P2P 상태 표시)
- GitHub tag/release가 한 번도 생성되지 않음
- 유명 오픈소스처럼 release별로 변경 사항을 추적하고 싶음

## Step 1: 미커밋 변경사항 커밋

현재 uncommitted 파일들을 두 그룹으로 나누어 커밋:

**커밋 A — ANSI color 보존 + 재연결 안정화 (agent + tests)**
```
packages/agent/src/index.ts                     — PTY capture surface ID routing fix
tests/integration.test.ts                       — ANSI color pipeline test
tests/unit/agent/cmux-client.test.ts            — ANSI preservation + ansi=true param + fallback tests
tests/unit/agent/terminal-write-output.test.ts  — ANSI color writeOutput tests
tests/e2e/ansi-color.spec.ts                    — Playwright E2E ANSI color rendering tests (신규)
```

**커밋 B — 웹 클라이언트 연결 상태 UI 개선**
```
packages/web/src/hooks/useRelay.ts              — 재연결 무한루프 수정, P2P 상태 추적, connection timeout backoff
packages/web/src/components/ConnectionOverlay.tsx — authenticating 단계 제거
packages/web/src/components/Layout.tsx           — P2P 상태 표시, 연결됨 문구 제거
packages/web/src/components/MobileLayout.tsx     — 동일
packages/web/src/components/RelaySessionLayout.tsx — 동일
packages/web/src/index.css                      — connection step 스타일
```

## Step 2: origin/main에 push

4개 기존 커밋 + 2개 신규 커밋 = 총 6개 커밋 push.

## Step 3: GitHub Release 생성 (v0.2.12)

Agent 버전(0.2.12)을 기준으로 `v0.2.12` 태그 생성.

`gh release create` 사용. changelog는 0.2.8 이후 커밋을 기반으로 작성:

### What's Changed

**Agent**
- Network change detection and fast reconnect (IPv4/IPv6 변경 감지)
- PTY capture surface ID routing fix
- ANSI color preservation in terminal output (`ansi=true` parameter)

**Web Client**
- Detailed connection status UI (WebSocket 연결 → Agent 연결 대기 단계 표시)
- P2P connection attempt status in header (비차단, relay와 병렬)
- Reconnection infinite loop fix (중복 connect 방지, exponential backoff)
- Notification click navigation fix on mobile PWA
- Ping timer leak fix in forceReconnect

## Step 4: 향후 Release 자동화 (선택)

현재는 수동 `gh release create`로 충분. 추후 필요시:
- `git tag -a v0.2.x -m "..."` + `gh release create` 스크립트화
- 또는 GitHub Actions + conventional commits 기반 자동 release (semantic-release, release-please 등)

지금은 Step 1-3까지만 진행.

## 검증

1. `git status` — 워킹트리 깨끗한지 확인
2. `git log origin/main..HEAD` — push 후 차이 없는지 확인
3. `gh release view v0.2.12` — release 페이지 확인
4. GitHub Releases 페이지에서 changelog 표시 확인
