# cmux-relay-agent

Stream your [cmux](https://github.com/manaflow-ai/cmux) terminal sessions to any device in real-time. Monitor AI coding agents (Claude Code, Codex CLI, Gemini CLI) from your phone.

## Quick Start

```bash
npx cmux-relay-agent
```

That's it. The agent will:

1. Open your browser to a pairing page
2. Sign in with GitHub (first time only)
3. Redirect to your live terminal dashboard

On subsequent runs, the saved token is reused — just run and go.

Access your terminal from any device at **https://cmux.gateway.myaddr.io**

## Requirements

- **cmux** — [Ghostty-based macOS terminal multiplexer](https://github.com/manaflow-ai/cmux)
- **Node.js** 20+

## CLI Options

```
npx cmux-relay-agent [options]
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--relay-url <url>` | `CMUX_RELAY_URL` | `wss://relay.gateway.myaddr.io/ws/agent` | Relay server URL |
| `--token <token>` | `CMUX_RELAY_TOKEN` | — | API token (auto-saved after pairing) |
| `--local` | — | — | Run in local mode (direct WebSocket, no relay) |
| `--port <port>` | `CMUX_RELAY_PORT` | `8080` | Local mode server port |
| `--host <host>` | `CMUX_RELAY_HOST` | `0.0.0.0` | Local mode bind address |
| `--socket <path>` | `CMUX_SOCKET_PATH` | `~/Library/Application Support/cmux/cmux.sock` | cmux Unix socket path |
| `--tls-cert <path>` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file |
| `--tls-key <path>` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file |
| `--acp-command <cmd>` | `CMUX_ACP_COMMAND` | — | ACP agent command (e.g. `claude-agent-acp`) |
| `--acp-args <args>` | `CMUX_ACP_ARGS` | — | ACP agent arguments (comma-separated) |
| `--acp-name <name>` | `CMUX_ACP_NAME` | derived from command | Display name for the ACP agent |

## Local Mode

Run without any cloud relay — works within your LAN:

```bash
npx cmux-relay-agent --local --port 8080
```

Then open `ws://<your-mac-ip>:8080` in a browser on the same network.

## Self-Hosted Relay

Point the agent to your own relay server:

```bash
npx cmux-relay-agent --relay-url wss://your-relay.example.com/ws/agent
```

See the [full repository](https://github.com/pallidev/cmux-relay) for relay server setup instructions.

## ACP Chat Mode

Interact with AI coding agents directly from your phone via the [Agent Client Protocol](https://github.com/AcpProtocol/acp). Supports any ACP-compatible agent — Claude Code, Codex, and more.

```bash
# Claude Code
npx cmux-relay-agent --acp-command claude-agent-acp

# Codex
npx cmux-relay-agent --acp-command codex-acp --acp-name Codex

# Custom agent with arguments
npx cmux-relay-agent --acp-command my-agent --acp-args "--model,o3" --acp-name "My Agent"
```

The web client shows a **Terminal / Chat** tab switcher. Chat mode provides:

- **Streaming responses** — See agent output in real-time
- **Tool call cards** — Collapsible cards showing tool usage with status indicators
- **Permission dialogs** — Approve or deny tool permission requests from your phone
- **Session auto-resume** — Automatically resumes the most recent session on restart
- **Multi-agent support** — Any ACP-compatible agent works via `--acp-command`

## Features

- **Real-time streaming** — Terminal output via WebSocket + PTY capture
- **ACP agent chat** — Interact with AI coding agents from mobile via Agent Client Protocol
- **P2P data transfer** — WebRTC DataChannel connects directly to the browser. Relay server only handles signaling.
- **Automatic fallback** — Seamless fallback to relay-forwarded WebSocket if P2P fails (NAT/firewall)
- **Bidirectional input** — Send commands from any device
- **End-to-end encryption** — Terminal data encrypted with AES-256-GCM via ECDH key exchange. The relay server cannot read your terminal content.
- **Multi-workspace** — Switch between all cmux workspaces
- **Split pane layout** — Pixel-perfect cmux pane positioning
- **Mobile optimized** — Touch-friendly terminal with tab navigation
- **Notifications** — In-app toasts for agent events
- **Auto-reconnect** — Exponential backoff with session recovery

## Security

Terminal input and output are encrypted end-to-end between the agent and your browser:

- **AES-256-GCM** — All terminal data encrypted before leaving your Mac
- **DTLS** — WebRTC DataChannel encrypted with DTLS for P2P connections
- **ECDH P-256** — Session keys established via key exchange; never sent in plaintext
- **Zero knowledge relay** — The relay server only sees encrypted blobs (or nothing at all in P2P mode), never your terminal content
- **No stored keys on server** — Encryption keys exist only on your Mac and in your browser session

The relay cannot decrypt your data — not now, not ever. [Full source code is open for audit](https://github.com/pallidev/cmux-relay).

## License

MIT
