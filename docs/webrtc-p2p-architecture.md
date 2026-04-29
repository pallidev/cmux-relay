# WebRTC P2P Architecture

## 개요

Cloud mode에서 agent와 web client 간 터미널 데이터를 WebRTC DataChannel로 직접 전송하는 P2P 아키텍처. Relay 서버는 인증과 시그널링(SDP/ICE 교환)만 담당하며, 실제 데이터는 agent↔browser 간 직접 전송.

## 연결 흐름

```
                 ┌─────────────┐
                 │ Relay Server │
                 │  (signaling) │
                 └──┬────────┬─┘
                    │        │
            SDP/ICE │        │ SDP/ICE
                    │        │
              ┌─────▼──┐  ┌──▼─────┐
              │ Agent  │  │  Web   │
              │ (Mac)  │  │(Browser)│
              │        │  │        │
              │ node-  │  │ native │
              │ data-  │◄─┤  RTC   │
              │channel │──►│PeerConn│
              └────────┘  └────────┘
                  ◄── DataChannel ──►
                (터미널 데이터 직접 전송)
```

### 시퀀스

```
Agent                          Relay                          Browser
  │                              │                              │
  │──── WS 연결 (인증) ────────►│                              │
  │                              │◄──── WS 연결 (인증) ────────│
  │                              │                              │
  │◄──── client.connected ──────│                              │
  │                              │                              │
  │── webrtc.offer (SDP) ──────►│──── offer 전달 ─────────────►│
  │                              │                              │
  │                              │◄── webrtc.answer (SDP) ─────│
  │◄── answer 전달 ─────────────│                              │
  │                              │                              │
  │── ice-candidate ───────────►│──── candidate 전달 ─────────►│
  │                              │◄── ice-candidate ───────────│
  │◄── candidate 전달 ──────────│                              │
  │                              │                              │
  │◄════════ DataChannel 열림 ════════════════════════════════►│
  │                              │                              │
  │◄── 터미널 데이터 (P2P) ────────────────────────────────────│
  │── 사용자 입력 (P2P) ──────────────────────────────────────►│
```

## 컴포넌트

### Agent: WebRTC Transport (`webrtc-transport.ts`)
- `node-datachannel` (C++ 바인딩) 기반 PeerConnection
- DataChannel 생성, SDP offer 생성
- Trickle ICE: ICE candidate를 수집 즉시 전달
- 연결 실패시 자동 fallback (relay WebSocket)

### Web: `useRelay` 훅
- 브라우저 네이티브 `RTCPeerConnection` API
- `webrtc.offer` 수신시 자동으로 answer 생성
- DataChannel 열리면 데이터 수신을 DataChannel로 전환
- WebSocket은 시그널링 + fallback으로 유지
- `transport` 상태: `'relay'` | `'p2p'`

### Relay: 변경 없음
- 기존 `agent.data`/`client.data` 브릿지로 `webrtc.*` 메시지를 투명하게 전달
- 메시지 타입을 해석하지 않음 — 새 프로토콜 타입 추가만으로 동작

## 장점

| 항목 | 설명 |
|---|---|
| **Relay 서버 부하 감소** | 터미널 데이터가 relay를 경유하지 않아 대역폭/비용 절감 |
| **지연시간 감소** | 데이터가 직접 전송되어 relay 경유보다 빠름 (1 hop 적음) |
| **확장성** | Relay는 시그널링만 처리하므로 동시 접속자 수 대폭 증가 가능 |
| **Relay 변경 최소** | Relay 서버 코드 수정 없이 새 프로토콜 타입만으로 동작 |
| **자동 Fallback** | NAT 환경에서 P2P 실패시 기존 relay 경유로 자동 전환 |
| **보안** | DataChannel은 DTLS로 자동 암호화. 시그널링은 기존 relay 인증(JWT/API token)으로 보호 |
| **모바일 호환** | 브라우저에 WebRTC가 내장되어 추가 앱 설치 불필요 |

## 단점

| 항목 | 설명 |
|---|---|
| **Symmetric NAT** | 양쪽 모두 symmetric NAT인 경우 P2P 불가 → relay fallback 동작 (TURN 서버 없음) |
| **초기 연결 지연** | SDP/ICE 교환에 1~2초 소요. 연결 완료 전까지 relay 경유로 동작 |
| **의존성 추가** | Agent에 `node-datachannel` (C++ 네이티브 바인딩) 추가. 빌드 환경 요구 |
| **IP 노출** | WebRTC ICE candidate에 공인 IP 포함 (STUN). 터미널 도구에서는 민감 이슈 아님 |
| **복잡도 증가** | WebRTC 연결 관리, ICE, fallback 로직이 추가됨 |
| **연결 불안정** | 모바일 네트워크 환경에서 P2P 연결이 끊길 수 있음 → fallback으로 복구 |

## Fallback 동작

```
P2P 시도 → 성공 → DataChannel로 데이터 전송
         → 실패 → relay WebSocket으로 데이터 전송 (기존 방식)
```

- P2P 실패 원인: Symmetric NAT, 방화벽, 네트워크 변경
- Fallback시 사용자 경험 변화 없음 (UI에 transport 상태 표시로만 구분)

## 기술 스택

| 구성요소 | 기술 |
|---|---|
| Agent WebRTC | `node-datachannel` v0.32.3 (C++ libdatachannel 바인딩) |
| Browser WebRTC | Native `RTCPeerConnection` API |
| STUN | Google public STUN (`stun:stun.l.google.com:19302`) |
| ICE | Trickle ICE (candidate를 수집 즉시 전달) |
| 암호화 | DTLS (DataChannel 기본 암호화) |

## 테스트

```bash
# Playwright E2E: agent↔browser P2P 연결 + 양방향 데이터 전송 검증
npx playwright test tests/e2e/webrtc-p2p.spec.ts
```

테스트 검증 항목:
- node-datachannel에서 SDP offer 생성
- 브라우저 RTCPeerConnection으로 answer 생성
- ICE candidate 교환
- DataChannel open
- Agent → Browser 데이터 전송
- Browser → Agent 데이터 전송
