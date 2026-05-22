<h1 align="center">cmux-relay</h1>

<p align="center">
  Stream your cmux terminal sessions to any device in real-time.<br/>
  Monitor AI coding agents (Claude Code, Codex CLI, Gemini CLI) from your phone.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-relay-agent"><img src="https://img.shields.io/npm/v/cmux-relay-agent" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/cmux-relay-agent"><img src="https://img.shields.io/npm/dt/cmux-relay-agent" alt="npm downloads" /></a>
  <a href="https://github.com/pallidev/cmux-relay/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple" alt="Platform" />
  <img src="https://img.shields.io/badge/terminal-cmux-89b4fa" alt="cmux" />
  <img src="https://img.shields.io/badge/ACP-supported-89dceb?logo=agent" alt="ACP" />
</p>

<p align="center">
  <b>Quick start:</b><br/>
  <code>npx cmux-relay-agent</code><br/>
  <code>npx cmux-relay-agent --acp-command claude-agent-acp</code> <sup>with AI chat</sup>
</p>

<p align="center">
  <a href="./README.ko.md">한국어</a>
</p>

---

## Why cmux-relay?

You run AI coding agents like Claude Code in [cmux](https://github.com/manaflow-ai/cmux) (a Ghostty-based macOS terminal). When you step away from your desk, you still want to:

- **Monitor** agent progress in real-time from your phone
- **Chat with AI agents** directly from mobile via ACP (Agent Client Protocol)
- **Send commands** when an agent needs your input
- **Switch** between multiple terminal sessions
- **Get notified** when an agent completes or encounters an error

## Quick Start

There are three ways to use cmux-relay, depending on your needs.

### 1. Agent Only (Cloud Relay)

The simplest way. Just run the agent on your Mac — it connects to the public cloud relay, and you access your terminal from any device.

```bash
npx cmux-relay-agent
```

The agent will:

1. Open your browser to a pairing page
2. Sign in with GitHub (first time only)
3. Auto-approve and redirect to your live terminal

On subsequent runs, the saved token is reused — just run `npx cmux-relay-agent` and the browser opens directly to your terminal.

Access from any device at:

```
https://cmux.gateway.myaddr.io
```

**What you need:** cmux, Node.js 20+. Nothing else.

### 2. With AI Agent Chat (ACP)

Enable direct chat with your AI coding agent from mobile. Uses the [Agent Client Protocol](https://agentclientprotocol.com/) — works with any ACP-compatible agent.

```bash
npx cmux-relay-agent --acp-command claude-agent-acp
```

This spawns an ACP agent subprocess alongside your terminal streaming. On your phone:

1. Tap the **chat icon** on any terminal tab
2. Send messages directly to the AI agent
3. See real-time responses, tool calls, and permission requests
4. Each terminal tab gets its own independent chat session

**Supported agents:** `claude-agent-acp`, `codex-acp`, and any ACP-compatible agent.

**What you need:** An ACP-compatible agent installed (`npm install -g @agentclientprotocol/claude-agent-acp`).

### 3. Local Mode (LAN Direct)

Run without any cloud relay. The agent starts a local WebSocket server — works within your LAN.

```bash
# From source
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm dev -- --local --port 8080
```

Then open `http://<your-mac-ip>:8080` in a browser on the same network.

**What you need:** cmux, Node.js 20+, pnpm. No internet required.

### 4. Self-Hosted (Own Relay Server)

Run your own relay server for full control — useful for teams, private networks, or custom domains.

```bash
# Clone and build
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install

# Build shared package first
pnpm --filter @cmux-relay/shared build

# Start relay server
cd packages/relay && npx tsx src/index.ts
```

The relay server needs:

- **GitHub OAuth App** — Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` env vars
- **Reverse proxy** — nginx or similar for TLS (WSS) and routing
- **SQLite** — Auto-created for user/token storage

Then connect agents to your relay:

```bash
npx cmux-relay-agent --relay-url wss://your-relay.example.com/ws/agent
```

Or build and publish the agent package with your relay URL as default.

**What you need:** A server reachable from both the agent Mac and client browsers, with TLS.

## Architecture

### Cloud Mode (Default)

```
┌──────────────────────────┐         ┌──────────────────────┐
│  Your Mac                │         │  Relay Server        │
│                          │         │  (Mac Mini / VPS)    │
│  cmux ─socket─► Agent    │ WS      │                      │
│  (Ghostty)     │         ├───────► │  Auth + Signaling    │
│                PTY       │  SDP/   │  Session matching    │
│                Capture   │  ICE    │  GitHub OAuth        │
│                          │         │  SQLite              │
│                  WebRTC  │         └──────┬───────────────┘
│                  DataChannel              │         ▲
│                     ║                     │    SDP/ICE only
│                     ║                     ▼         ║
│                     ╚═══════════════════════════════╝
│                              P2P Direct
│                          │
│         ┌── ACP Agent ───┤
│         │  (claude-agent  │
│         │   -acp, etc.)   │
│         └────────────────┘
└──────────────────────────┘
         │                                     │
         └──── WebRTC DataChannel (P2P) ──────┘
                            │
                     ┌──────▼───────────────┐
                     │  Web Client           │
                     │  (any browser)        │
                     │  • xterm.js           │
                     │  • AI Chat (ACP)      │
                     │  • Mobile UX          │
                     └──────────────────────┘
```

The agent connects outbound to the relay — no inbound ports needed on your Mac. Terminal data flows **directly** between agent and browser via WebRTC P2P. The relay handles only authentication and signaling (SDP/ICE exchange). Falls back to relay-forwarded WebSocket if P2P fails.

### ACP Chat Architecture

```
Web Client (Browser)
  │
  ├─ Terminal View ──── xterm.js ─── cmux socket
  │
  └─ Chat View ──── WS/WebRTC ─── cmux-relay-agent ─── stdio JSON-RPC ─── ACP Agent
                                                               (claude-agent-acp)
```

Each terminal tab (surface) gets its own independent ACP session. Chat sessions are created lazily — only when you switch to chat view on a tab.

### Local Mode

```
┌──────────────────────────┐         ┌──────────────────────┐
│  Your Mac                │         │  Browser (LAN)       │
│                          │         │                      │
│  cmux ─socket─► Agent    │  WS     │  ws://mac-ip:8080    │
│  (Ghostty)     │         ├────────►│                      │
│                PTY       │         │                      │
│                Capture   │         │                      │
└──────────────────────────┘         └──────────────────────┘
```

No relay server — the agent runs its own WebSocket server. Only works on the same network.

## Package Structure

```
cmux-relay/
├── packages/
│   ├── shared/     # Protocol types and message definitions (zero-dependency)
│   ├── agent/      # Runs on your Mac — cmux client + PTY capture + relay connection + ACP bridge
│   ├── relay/      # Runs on server — session matching + auth + data bridge
│   └── web/        # React + xterm.js web client with ACP chat UI
├── tests/          # Integration tests
└── package.json    # pnpm workspace root
```

| Who uses what | Packages needed |
|---|---|
| Agent user (`npx cmux-relay-agent`) | `agent` (published to npm, includes `shared`) |
| Agent user + AI chat (`--acp-command`) | `agent` + ACP-compatible agent installed |
| Local mode (`--local`) | `agent` + `shared` (from source) |
| Self-hosted | All packages (`agent` + `relay` + `web` + `shared`) |

## Features

### Core

- **Real-time streaming** — Terminal output via WebSocket + mkfifo PTY capture
- **P2P data transfer** — WebRTC DataChannel for direct agent↔browser communication. Relay handles signaling only.
- **Automatic fallback** — If P2P fails (NAT/firewall), falls back to relay-forwarded WebSocket seamlessly
- **Bidirectional input** — Type commands from any device
- **Split pane layout** — Pixel-perfect cmux pane positioning
- **Multi-workspace** — Switch between all cmux workspaces
- **Pairing code flow** — One-click GitHub login to link your agent
- **Auto-reconnect** — Exponential backoff with session recovery

### AI Agent Chat (ACP)

- **Mobile AI chat** — Send prompts to Claude Code, Codex CLI, or any ACP-compatible agent from your phone
- **Per-surface sessions** — Each terminal tab has its own independent chat conversation
- **Real-time streaming** — See agent responses as they're generated, token by token
- **Tool call tracking** — Visual status for every tool call (reading files, running commands, etc.)
- **Permission requests** — Approve or deny agent tool usage directly from mobile
- **Session persistence** — Chat history is saved and restored on reconnect
- **Agent-agnostic** — Works with any ACP-compatible agent (`claude-agent-acp`, `codex-acp`, etc.)
- **Lazy session creation** — Chat sessions are created only when you switch to chat view

### Mobile Experience

- **Full-screen terminal** — Optimized for touch devices
- **Swipe navigation** — Switch workspaces with left/right swipe
- **Tab bar** — Switch between surfaces in a workspace
- **Terminal / Chat toggle** — Per-tab toggle between terminal view and AI chat
- **Auto-redirect** — Login once, go straight to your terminal

### Notifications

- **cmux notification polling** — Polls every 2 seconds
- **Mobile push notifications** — System notifications on iOS/Android via PWA (Web Push + VAPID)
- **In-app toast popups** — Color-coded with auto-dismiss
- **Click-to-navigate** — Tap a notification to jump to the relevant workspace/surface
- **Install prompt banner** — Guides mobile users to install the PWA

### Security

- **End-to-end encryption** — Terminal input/output encrypted with AES-256-GCM. The relay server cannot read your terminal data.
- **P2P encryption** — WebRTC DataChannel encrypted with DTLS. Even in P2P mode, data is encrypted in transit.
- **ECDH key exchange** — Session keys established via P-256 ECDH during each connection. Keys are never transmitted in plaintext.
- **GitHub OAuth** — Login with your GitHub account
- **JWT sessions** — Cookie-based auth (30-day expiry)
- **API tokens** — SHA-256 hashed, auto-generated during pairing
- **TLS** — End-to-end HTTPS/WSS

#### How E2E encryption works

```
Agent                              Relay                              Client (Browser)
  │                                   │                                   │
  │  Generates ECDH key pair          │                                   │
  │  Generates random session key     │                                   │
  │                                   │                                   │
  │                                   │   ◄── WebSocket connect ──────────│
  │                                   │                                   │
  │   ◄── client.data: e2e.init ─────│◄── e2e.init (client pubKey) ─────│
  │                                   │                                   │
  │  ECDH(agentPriv, clientPub) → KEK│                                   │
  │  AES(sessionKey, KEK) → token    │                                   │
  │                                   │                                   │
  │   ── agent.data: e2e.ack ───────►│── e2e.ack (agentPubKey, token) ──►│
  │                                   │                                   │
  │                                   │                  ECDH(clientPriv, agentPub) → KEK
  │                                   │                  Decrypt token → session key
  │                                   │                                   │
  │  ═══════════ All terminal data encrypted with AES-256-GCM ═════════════
  │   ── encrypted output ──────────►│── forward opaque blob ──────────►│
  │   ◄── encrypted input ──────────│◄─ encrypted input ───────────────│
```

**What the relay can see:**
- Connection metadata (IP addresses, timestamps)
- Message types (output, input, workspace info)
- Workspace/surface names (for navigation)

**What the relay cannot see:**
- Terminal content — encrypted with AES-256-GCM
- Keyboard input — encrypted before leaving the browser
- Session encryption keys — never stored on the relay

**Code audit:** All source code is open and auditable at [github.com/pallidev/cmux-relay](https://github.com/pallidev/cmux-relay). The relay server code (`packages/relay/`) has no crypto dependencies and never decrypts terminal data.

## cmux Socket Access Restriction

**Important:** Starting with cmux **0.64.6**, the Unix socket (`cmux.sock`) only accepts connections from processes launched *inside* cmux itself. External processes (including `cmux` CLI, Hermes, AI agents, or other tools) will receive a silent "Broken pipe" error.

### Symptoms

```
$ cmux list-workspaces
Error: Failed to write to socket (Broken pipe, errno 32)
```

Direct socket connection confirms the real error:

```
ERROR: Access denied — only processes started inside cmux can connect
```

### How to Fix

The restriction is controlled by `socketControlMode` in cmux settings:

```jsonc
// ~/.config/cmux/cmux.json
{
  "automation": {
    "socketControlMode": "open"   // Change from "cmuxOnly" (default)
  }
}
```

| Mode | Behavior |
|------|----------|
| `cmuxOnly` | **Default.** Only processes started inside cmux can connect. External tools are blocked. |
| `open` | Any process on the local machine can connect. Required for cmux-relay, AI agents, automation tools. |
| `password` | External processes must provide a password (`CMUX_SOCKET_PASSWORD` env or `--password` flag). |

### Impact on cmux-relay

- **cmux-relay agent** connects to cmux's Unix socket as an external process
- If `socketControlMode` is `cmuxOnly` (default), the agent **cannot** connect and will fail silently
- **You must set `socketControlMode` to `"open"` or `"password"`** for cmux-relay to work

After changing the setting, either restart cmux or run `cmux reload-config`.

### Why This Matters

This is a security feature — it prevents arbitrary processes from reading/writing your terminal sessions. However, it also breaks any external automation tooling that interacts with cmux. Always consider the security tradeoff when setting `socketControlMode` to `"open"`.

## CLI Options

```bash
npx cmux-relay-agent [options]
# or from source: pnpm dev -- [options]
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--relay-url` | `CMUX_RELAY_URL` | `wss://relay.gateway.myaddr.io/ws/agent` | Relay server URL |
| `--acp-command` | `CMUX_ACP_COMMAND` | — | ACP agent command (e.g. `claude-agent-acp`) |
| `--acp-args` | `CMUX_ACP_ARGS` | — | ACP agent arguments (comma-separated) |
| `--acp-name` | — | ACP command | Display name for the ACP agent |
| `--token` | `CMUX_RELAY_TOKEN` | — | API token (auto-saved after pairing) |
| `--local` | — | — | Run in local mode (direct WebSocket) |
| `--port` | `CMUX_RELAY_PORT` | `8080` | Local mode server port |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | Local mode bind address |
| `--socket` | `CMUX_SOCKET_PATH` | `~/Library/Application Support/cmux/cmux.sock` | cmux Unix socket path |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file |

## Keywords

`cmux` `terminal` `streaming` `mobile` `webrtc` `p2p` `xterm` `ghostty` `macos` `remote` `monitoring` `ai-agent` `claude-code` `codex` `agent-client-protocol` `acp` `developer-tools` `real-time` `terminal-emulator` `ssh-alternative` `pwa` `push-notifications` `e2e-encryption`

## Development

```bash
pnpm install              # Install dependencies
pnpm -r run typecheck     # Type-check all packages
pnpm test                 # Run integration tests
pnpm --filter web build   # Build web client for production
```

## License

[MIT](LICENSE)
