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

## How It Works

```
┌───────────────────────────────────────┐    WebSocket    ┌──────────────────┐
│            Server (your Mac)          │ ◄─────────────► │ Web Client        │
│                                       │                 │ (phone browser)   │
│  ┌─────────────┐  ┌───────────────┐  │                 │ • xterm.js        │
│  │ cmux Socket │  │ PTY Capture   │  │                 │ • Mobile UX       │
│  │ (JSON-RPC)  │  │ (mkfifo)      │  │                 │ • Keyboard input  │
│  └──────┬──────┘  └───────┬───────┘  │                 └──────────────────┘
│         │                 │          │
│         └────┬────────────┘          │
│              ▼                       │
│  ┌───────────────────────────────┐   │
│  │     WebSocket Server          │   │
│  │  • JWT auth  • Sessions       │   │
│  │  • Streaming • Input relay    │   │
│  │  • Notifications  • TLS      │   │
│  └───────────────────────────────┘   │
└───────────────────────────────────────┘
```

## Features

### Core

- **Real-time streaming** — Terminal output flows from cmux to your browser via WebSocket + mkfifo PTY capture
- **Bidirectional input** — Type commands from your phone, they reach cmux instantly
- **Split pane layout** — Replicates cmux's actual split pane arrangement with pixel-perfect positioning
- **Multi-workspace** — See all cmux workspaces and switch between them
- **Self-hosted** — Runs on your machine. No cloud dependency, no third-party service
- **Single process** — One command to start everything (cmux client + PTY capture + WebSocket server)

### Mobile Experience

- **Dedicated mobile layout** — Single terminal full-screen view optimized for touch devices
- **Swipe navigation** — Swipe left/right to switch between workspaces
- **Tab bar** — Horizontal tab bar for switching between surfaces in a workspace
- **Touch-optimized** — Header navigation with workspace counter (`1/4`)

### Notifications

- **cmux notification polling** — Polls cmux for notifications every 2 seconds
- **Browser push notifications** — Native OS notifications via the Notification API
- **In-app toast popups** — Color-coded slide-in toasts (info/success/warning/error) with auto-dismiss
- **Notification panel** — Desktop sidebar panel showing full notification history with read/unread state
- **Click-to-navigate** — Click a toast or notification to jump to the relevant workspace/surface

### Security & Connectivity

- **JWT authenticated** — Token-based access control with auto-generated client tokens
- **TLS support** — Optional HTTPS/WSS via `--tls-cert` and `--tls-key` flags
- **Token via URL** — Pass `?token=xxx` in the URL for quick mobile setup

### UI

- **Catppuccin Mocha dark theme** — Consistent dark theme with CSS custom properties
- **Responsive design** — Desktop sidebar layout + mobile full-screen layout with automatic detection
- **Glass-morphism login** — Modern login card with backdrop blur and gradient styling

## Quick Start

### Prerequisites

- [cmux](https://github.com/manaflow-ai/cmux) installed and running
- Node.js 20+
- pnpm

### Install

```bash
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
```

### Run

**1. Start the server:**

```bash
pnpm dev
# → Connects to cmux, starts WebSocket server on ws://0.0.0.0:8080
# → Prints a client token
```

**2. Open the web client:**

```
http://<your-mac-ip>:8080
```

Or run the web dev server separately (for development with HMR):

```bash
pnpm dev:web
# → http://localhost:3000
```

**3. Connect** — Enter the client token printed by the server, or append it to the URL:

```
http://<your-mac-ip>:8080?token=<your-token>
```

### CLI Options

```bash
pnpm start -- --port 9090 --host 127.0.0.1 --socket /custom/cmux.sock --tls-cert cert.pem --tls-key key.pem
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--port` | `CMUX_RELAY_PORT` | `8080` | WebSocket server port |
| `--host` | `CMUX_RELAY_HOST` | `0.0.0.0` | Bind address |
| `--socket` | `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix socket path |
| `--tls-cert` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file path |
| `--tls-key` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file path |

## Architecture

### Server (`packages/server`)

A single Node.js process that:

1. **Connects to cmux** via Unix domain socket using the v2 JSON-RPC protocol:

   | Action | cmux API Method |
   |--------|----------------|
   | List workspaces | `workspace.list` |
   | List surfaces/tabs | `surface.list` |
   | Read terminal screen | `debug.terminal.read_text` |
   | Send keyboard input | `surface.send_text` / `surface.send_key` |
   | List notifications | `notification.list` |

2. **Captures PTY output** using `mkfifo` named pipes. Falls back to polling `debug.terminal.read_text` if pipe creation fails.

3. **Polls notifications** from cmux every 2 seconds and broadcasts new ones to all connected clients.

4. **Serves WebSocket connections** for web clients with JWT authentication and session management. Optionally serves over TLS.

### Web Client (`packages/web`)

React + [xterm.js](https://xtermjs.org/) single-page app:

- **Desktop**: Sidebar with workspace list + split pane layout matching cmux's actual arrangement
- **Mobile**: Full-screen terminal with swipe workspace navigation and surface tab bar
- Terminal rendering with full ANSI escape sequence support
- In-app toast notifications + browser push notification support
- Catppuccin Mocha dark theme with glass-morphism UI elements

## WebSocket Protocol

All messages are JSON over WebSocket. Terminal data is base64-encoded.

**Client → Server:**
```jsonc
{ "type": "auth", "payload": { "token": "..." } }                          // Authenticate
{ "type": "workspaces.list" }                                                // Request workspace list
{ "type": "surface.select", "surfaceId": "..." }                            // Subscribe to surface output
{ "type": "input", "surfaceId": "...", "payload": { "data": "<base64>" } }  // Send keystrokes
{ "type": "resize", "surfaceId": "...", "payload": { "cols": 120, "rows": 40 } }
```

**Server → Client:**
```jsonc
{ "type": "workspaces", "payload": { "workspaces": [...] } }                // Workspace list
{ "type": "surfaces", "workspaceId": "...", "payload": { "surfaces": [...] } }  // Surface list per workspace
{ "type": "panes", "workspaceId": "...", "payload": { "panes": [...], "containerFrame": {...} } }  // Pane layout
{ "type": "output", "surfaceId": "...", "payload": { "data": "<base64>" } }     // Terminal output stream
{ "type": "surface.active", "surfaceId": "...", "workspaceId": "..." }          // Surface activation confirm
{ "type": "notifications", "payload": { "notifications": [...] } }               // cmux notifications
{ "type": "error", "payload": { "message": "..." } }                             // Error
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CMUX_RELAY_PORT` | `8080` | WebSocket server port |
| `CMUX_RELAY_HOST` | `0.0.0.0` | Server bind address |
| `CMUX_RELAY_JWT_SECRET` | `cmux-relay-dev-secret` | JWT signing secret |
| `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix socket path |
| `CMUX_RELAY_TLS_CERT` | — | TLS certificate file path |
| `CMUX_RELAY_TLS_KEY` | — | TLS private key file path |

## Project Structure

```
cmux-relay/
├── packages/
│   ├── shared/     # Protocol types and message definitions (zero-dependency)
│   ├── server/     # Server — cmux client + PTY capture + WebSocket + auth + TLS
│   └── web/        # React + xterm.js web client (desktop + mobile layouts)
├── tests/          # Integration tests (node:test + tsx)
└── package.json    # pnpm workspace root
```

### Key Files

| File | Role |
|------|------|
| `packages/shared/src/protocol.ts` | WebSocket message type definitions (Client ↔ Server) |
| `packages/shared/src/types.ts` | Shared data types (Workspace, Surface, Pane, Notification) |
| `packages/server/src/ws-server.ts` | WebSocket server, client message routing |
| `packages/server/src/cmux-client.ts` | cmux Unix socket v2 JSON-RPC client |
| `packages/server/src/pty-capture.ts` | mkfifo-based PTY output capture |
| `packages/server/src/input-handler.ts` | Web client input → cmux forwarding |
| `packages/server/src/session-store.ts` | In-memory session/client/notification state |
| `packages/server/src/auth.ts` | JWT token generation and verification |
| `packages/web/src/hooks/useRelay.ts` | React WebSocket hook |
| `packages/web/src/components/Layout.tsx` | Desktop layout (sidebar + split pane) |
| `packages/web/src/components/MobileLayout.tsx` | Mobile layout (full-screen + swipe) |
| `packages/web/src/components/Terminal.tsx` | xterm.js terminal component |

## Development

```bash
pnpm install              # Install dependencies
pnpm -r run typecheck     # Type-check all packages
pnpm test                 # Run integration tests
pnpm --filter web build   # Build web client for production
```

## Differences from SessionCast

| | SessionCast | cmux-relay |
|---|---|---|
| Terminal | tmux | cmux (Ghostty) |
| Platform | Cross-platform | macOS |
| Hosting | Cloud SaaS | Self-hosted |
| Auth | Google OAuth2 | JWT tokens |
| Server language | Java / Spring Boot | Node.js / TypeScript |
| Processes | Agent + Relay (separate) | Single process |
| Notifications | — | cmux notifications + browser push |
| Mobile UX | — | Dedicated mobile layout with swipe navigation |
| TLS | — | Optional built-in TLS |
| Source | Closed source | Open source (MIT) |

## License

[MIT](LICENSE)
