# Contributing to cmux-relay

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/pallidev/cmux-relay.git
cd cmux-relay
pnpm install
pnpm -r run typecheck
```

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run type checking: `pnpm -r run typecheck`
4. Run tests: `pnpm test`
5. Open a pull request

## Project Structure

- `packages/agent/` — Mac agent (cmux client + PTY capture + WebSocket)
- `packages/relay/` — Relay server (auth + session matching + signaling)
- `packages/web/` — React + xterm.js web client
- `packages/shared/` — Protocol types (zero-dependency)

## Conventions

- TypeScript strict mode
- pnpm workspace monorepo
- No `Buffer` in browser code — use `btoa`/`atob`
- Protocol changes go in `packages/shared/src/protocol.ts` first

## Reporting Issues

Use [GitHub Issues](https://github.com/pallidev/cmux-relay/issues) with the provided templates.
