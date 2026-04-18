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

Access your terminal from any device at **https://cmux.jaz.duckdns.org**

## Requirements

- **cmux** — [Ghostty-based macOS terminal multiplexer](https://github.com/manaflow-ai/cmux)
- **Node.js** 20+

## CLI Options

```
npx cmux-relay-agent [options]
```

| Flag | Env Variable | Default | Description |
|------|-------------|---------|-------------|
| `--relay-url <url>` | `CMUX_RELAY_URL` | `wss://relay.jaz.duckdns.org/ws/agent` | Relay server URL |
| `--token <token>` | `CMUX_RELAY_TOKEN` | — | API token (auto-saved after pairing) |
| `--local` | — | — | Run in local mode (direct WebSocket, no relay) |
| `--port <port>` | `CMUX_RELAY_PORT` | `8080` | Local mode server port |
| `--host <host>` | `CMUX_RELAY_HOST` | `0.0.0.0` | Local mode bind address |
| `--socket <path>` | `CMUX_SOCKET_PATH` | `~/Library/Application Support/cmux/cmux.sock` | cmux Unix socket path |
| `--tls-cert <path>` | `CMUX_RELAY_TLS_CERT` | — | TLS certificate file |
| `--tls-key <path>` | `CMUX_RELAY_TLS_KEY` | — | TLS private key file |

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

## Features

- **Real-time streaming** — Terminal output via WebSocket + PTY capture
- **Bidirectional input** — Send commands from any device
- **Multi-workspace** — Switch between all cmux workspaces
- **Split pane layout** — Pixel-perfect cmux pane positioning
- **Mobile optimized** — Touch-friendly terminal with tab navigation
- **Notifications** — In-app toasts for agent events
- **Auto-reconnect** — Exponential backoff with session recovery

## License

MIT
