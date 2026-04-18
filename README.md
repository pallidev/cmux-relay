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
https://cmux.jaz.duckdns.org
```

**What you need:** cmux, Node.js 20+. Nothing else.

### 2. Local Mode (LAN Direct)

Run without any cloud relay. The agent starts a local WebSocket server — works within your LAN.

```bash
# From source
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm dev -- --local --port 8080
```

Then open `ws://<your-mac-ip>:8080` in a browser on the same network.

**What you need:** cmux, Node.js 20+, pnpm. No internet required.

### 3. Self-Hosted (Own Relay Server)

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
│  cmux ─socket─► Agent    │  WS     │                      │
│  (Ghostty)     │         ├────────►│  Session matching    │
│                PTY       │         │  Data bridge         │
│                Capture   │         │  GitHub OAuth        │
│                          │         │  SQLite              │
└──────────────────────────┘         └──────┬───────────────┘
                                            │
                                     ┌──────▼───────────────┐
                                     │  Web Client           │
                                     │  (any browser)        │
                                     │  • xterm.js           │
                                     │  • Mobile UX          │
                                     └──────────────────────┘
```

The agent connects outbound to the relay — no inbound ports needed on your Mac. The relay bridges agent and web client connections.

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
│   ├── agent/      # Runs on your Mac — cmux client + PTY capture + relay connection
│   ├── relay/      # Runs on server — session matching + auth + data bridge
│   └── web/        # React + xterm.js web client
├── tests/          # Integration tests
└── package.json    # pnpm workspace root
```

| Who uses what | Packages needed |
|---|---|
| Agent user (`npx cmux-relay-agent`) | `agent` (published to npm, includes `shared`) |
| Local mode (`--local`) | `agent` + `shared` (from source) |
| Self-hosted | All packages (`agent` + `relay` + `web` + `shared`) |

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
npx cmux-relay-agent [options]
# or from source: pnpm dev -- [options]
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--relay-url` | `CMUX_RELAY_URL` | `wss://relay.jaz.duckdns.org/ws/agent` | Relay server URL |
| `--token` | `CMUX_RELAY_TOKEN` | — | API token (auto-saved after pairing) |
| `--local` | — | — | Run in local mode (direct WebSocket) |
| `--port` | `CMUX_RELAY_PORT` | `8080` | Local mode server port |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | Local mode bind address |
| `--socket` | `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix socket path |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file |

## Development

```bash
pnpm install              # Install dependencies
pnpm -r run typecheck     # Type-check all packages
pnpm test                 # Run integration tests
pnpm --filter web build   # Build web client for production
```

## License

[MIT](LICENSE)
