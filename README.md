<h1 align="center">cmux-relay</h1>

<p align="center">
  Stream your cmux terminal sessions to any device in real-time.<br/>
  Monitor AI coding agents (Claude Code, Codex CLI, Gemini CLI) from your phone.
</p>

<p align="center">
  <a href="https://github.com/pallidev/cmux-relay/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple" alt="Platform" />
  <img src="https://img.shields.io/badge/terminal-cmux-89b4fa" alt="cmux" />
</p>

<p align="center">
  <a href="./README.ko.md">한국어</a>
</p>

---

## Why cmux-relay?

You run AI coding agents like Claude Code in [cmux](https://github.com/manaflow-ai/cmux) (a Ghostty-based macOS terminal). When you step away from your desk, you still want to:

- **Monitor** agent progress in real-time from your phone
- **Send commands** when an agent needs your input
- **Switch** between multiple terminal sessions
- **Get notified** when an agent completes or encounters an error

## Quick Start

### Prerequisites

- [cmux](https://github.com/manaflow-ai/cmux) installed and running
- Node.js 20+
- pnpm

### Install & Run

```bash
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm dev -- --relay-url wss://relay.jaz.duckdns.org/ws/agent
```

That's it. The agent will:

1. Open your browser to a pairing page
2. Sign in with GitHub (first time only)
3. Auto-approve and redirect to your live terminal

On subsequent runs, the saved token is reused — just run `pnpm dev` and the browser opens directly to your terminal.

### Access from Any Device

After pairing, your terminal is live at:

```
https://cmux.jaz.duckdns.org/s/{sessionId}
```

Open this URL on your phone, tablet, or any browser. If you're already logged in, the root URL (`https://cmux.jaz.duckdns.org`) will redirect to your active session automatically.

### Local Mode

To run without the cloud relay (direct WebSocket on your LAN):

```bash
pnpm dev -- --local --port 8080
```

## How It Works

```
┌───────────────────────────────────────┐                  ┌──────────────────┐
│          Agent (your Mac)             │                  │ Web Client        │
│                                       │                  │ (any browser)     │
│  ┌─────────────┐  ┌───────────────┐  │                  │ • xterm.js        │
│  │ cmux Socket │  │ PTY Capture   │  │   Cloud Relay    │ • Mobile UX       │
│  │ (JSON-RPC)  │  │ (mkfifo)      │  │ ◄──────────────► │ • Keyboard input  │
│  └──────┬──────┘  └───────┬───────┘  │                  └──────────────────┘
│         │                 │          │
│         └────┬────────────┘          │
│              ▼                       │
│  ┌───────────────────────────────┐   │
│  │    RelayConnection (WS)       │   │
│  └───────────────────────────────┘   │
└───────────────────────────────────────┘
```

The agent connects outbound to the relay server — no inbound ports needed. The relay bridges agent ↔ web client connections.

## Features

### Core

- **Real-time streaming** — Terminal output via WebSocket + mkfifo PTY capture
- **Bidirectional input** — Type commands from any device
- **Split pane layout** — Pixel-perfect cmux pane positioning
- **Multi-workspace** — Switch between all cmux workspaces
- **Pairing code flow** — One-click GitHub login to link your agent
- **Auto-reconnect** — Exponential backoff with session recovery

### Mobile Experience

- **Full-screen terminal** — Optimized for touch devices
- **Swipe navigation** — Switch workspaces with left/right swipe
- **Tab bar** — Switch between surfaces in a workspace
- **Auto-redirect** — Login once, go straight to your terminal

### Notifications

- **cmux notification polling** — Polls every 2 seconds
- **Browser push notifications** — Native OS notifications
- **In-app toast popups** — Color-coded with auto-dismiss
- **Click-to-navigate** — Jump to relevant workspace/surface

### Security

- **GitHub OAuth** — Login with your GitHub account
- **JWT sessions** — HttpOnly cookie-based auth
- **API tokens** — SHA-256 hashed, auto-generated during pairing
- **TLS** — End-to-end HTTPS/WSS

## CLI Options

```bash
pnpm dev -- [options]
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--relay-url` | `CMUX_RELAY_URL` | — | Relay server WebSocket URL (cloud mode) |
| `--token` | `CMUX_RELAY_TOKEN` | — | API token (auto-saved after pairing) |
| `--local` | — | — | Run in local mode (direct WebSocket) |
| `--port` | `CMUX_RELAY_PORT` | `8080` | Local mode server port |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | Local mode bind address |
| `--socket` | `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix socket path |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file |

## Project Structure

```
cmux-relay/
├── packages/
│   ├── shared/     # Protocol types and message definitions (zero-dependency)
│   ├── agent/      # Agent — cmux client + PTY capture + relay connection
│   ├── relay/      # Relay server — session matching + auth + data bridge
│   └── web/        # React + xterm.js web client
├── tests/          # Integration tests
└── package.json    # pnpm workspace root
```

## Development

```bash
pnpm install              # Install dependencies
pnpm -r run typecheck     # Type-check all packages
pnpm test                 # Run integration tests
pnpm --filter web build   # Build web client for production
```

## License

[MIT](LICENSE)
