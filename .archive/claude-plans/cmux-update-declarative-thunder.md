# ANSI Color Support for Web Client

## Context

cmux가 업데이트되어 `surface.read_text` API가 `ansi: true` 파라미터를 지원합니다. Agent 코드는 이미 `ansi: true`로 요청하도록 작성되어 있지만(`cmux-client.ts:162-189`), 이 기능이 올바르게 동작하는지 검증하는 테스트가 없습니다. 웹 클라이언트의 xterm.js는 ANSI SGR 코드를 네이티브로 렌더링하므로, 데이터 경로에서 ANSI sequence가 보존되면 색상이 표시되어야 합니다.

목표: ANSI 데이터가 전체 파이프라인(cmux → agent → web client → xterm)에서 보존됨을 테스트로 검증합니다.

## Plan

### Step 1: `readTerminalText` ANSI 단위 테스트 추가

**파일**: `tests/unit/agent/cmux-client.test.ts`

기존 mock server 패턴을 사용하여 새 테스트 케이스 추가:

- **`readTerminalText preserves ANSI escape sequences`**: mock server가 ANSI colored text(`\x1b[31mHello\x1b[0m`)를 base64로 반환 → `readTerminalText()`가 ANSI sequence를 보존한 채 반환하는지 검증
- **`readTerminalText ansi=true is sent in params`**: mock server가 `ansi: true` 파라미터를 받았는지 검증
- **`readTerminalText falls back gracefully when ansi fails`**: `ansi: true` 요청이 에러나면 `ansiSupported=false`로 설정하고 plain text로 fallback하는 기존 동작 검증

### Step 2: `writeOutput` ANSI 처리 단위 테스트 추가

**파일**: `tests/unit/agent/terminal-write-output.test.ts`

기존 `createWriteOutputCapture()` 유틸리티 재사용:

- **`first write preserves ANSI sequences`**: ANSI colored 텍스트가 first write에서 escape code 손실 없이 전달되는지 검증
- **`subsequent writes preserve ANSI in screen update`**: 두 번째 write에서도 ANSI sequence가 scrollback push 로직에 의해 손실되지 않는지 검증
- **`ANSI data dedup works correctly`**: 동일한 ANSI colored 텍스트의 base64가 같으면 dedup, 다르면 통과
- **`mixed ANSI colors in one screen`**: 여러 색상 코드가 혼합된 텍스트가 올바르게 처리되는지 검증

### Step 3: E2E 테스트 — xterm ANSI 색상 렌더링

**파일**: `tests/e2e/ansi-color.spec.ts` (신규)

`mobile-scroll.spec.ts` 패턴을 따라 독립 HTML 페이지로 xterm.js 로드:

- HTTP server로 xterm.js, addon-fit.js, xterm.css 서빙
- 테스트 HTML에 `__writeOutput(base64Data)` 함수 노출 (production `writeOutput` 로직 복제)
- `__getColorAt(row, col)` 헬퍼로 xterm buffer의 색상 attribute 읽기

테스트 케이스:
1. **`colored text renders foreground color`**: `\x1b[31mHello\x1b[0m` → buffer에서 red foreground attribute 확인
2. **`multiple colors in one line`**: `\x1b[31mRed\x1b[32mGreen\x1b[34mBlue\x1b[0m` → 각 segment의 색상 확인
3. **`color preserved across screen updates`**: 첫 write에서 색상 표시 → 두 번째 write 후에도 색상 유지 확인
4. **`reset code clears color`**: `\x1b[31mRed\x1b[0mNormal` → "Red"는 빨강, "Normal"은 기본 색상 확인
5. **`background color renders correctly`**: `\x1b[41mRed BG\x1b[0m` → background color attribute 확인

### Step 4: 통합 테스트에 ANSI output 케이스 추가

**파일**: `tests/integration.test.ts`

기존 integration test 구조에 추가:
- **Agent가 ANSI 포함 output을 broadcast하면 client가 올바른 base64 데이터를 받음**: ANSI colored text를 base64로 인코딩 → output message로 전송 → client 측에서 수신한 데이터를 디코딩하여 ANSI sequence 보존 확인

## Files to Modify

| 파일 | 변경 내용 |
|---|---|
| `tests/unit/agent/cmux-client.test.ts` | ANSI readTerminalText 테스트 추가 |
| `tests/unit/agent/terminal-write-output.test.ts` | ANSI writeOutput 테스트 추가 |
| `tests/e2e/ansi-color.spec.ts` | 신규: xterm ANSI 색상 렌더링 E2E 테스트 |
| `tests/integration.test.ts` | ANSI output 통합 테스트 케이스 추가 |

## Existing Code to Reuse

- `tests/unit/agent/cmux-client.test.ts`: `createMockServer()` 패턴
- `tests/unit/agent/terminal-write-output.test.ts`: `createWriteOutputCapture()` 유틸리티
- `tests/e2e/mobile-scroll.spec.ts`: 독립 HTML + xterm 로드 + `__writeOutput` 패턴

## Verification

```bash
pnpm test:unit                       # 단위 테스트 통과
npx playwright test                  # E2E 테스트 통과
pnpm test                            # 전체 테스트 통과
```
