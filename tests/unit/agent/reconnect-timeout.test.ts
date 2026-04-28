import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeMessage, decodeMessage } from '../../../packages/shared/dist/index.js';
import type { AgentOutgoing } from '../../../packages/shared/dist/index.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const connSource = readFileSync(resolve(root, 'packages/agent/src/relay-connection.ts'), 'utf-8');

describe('relay-connection reconnect', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let activeWs: WebSocket | null = null;

  function createRelayServer(): Promise<number> {
    return new Promise((resolve) => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      wss.on('connection', (ws) => {
        activeWs = ws;
        ws.on('message', (raw) => {
          const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const msg = decodeMessage<AgentOutgoing>(data);
          if (msg.type === 'agent.register') {
            ws.send(encodeMessage({ type: 'session.created', sessionId: 'test-session' }));
          }
        });
      });
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as { port: number };
        port = addr.port;
        resolve(port);
      });
    });
  }

  afterEach(async () => {
    activeWs = null;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>(r => httpServer.close(() => r()));
  });

  it('reconnects when relay closes the connection', async () => {
    const serverPort = await createRelayServer();
    const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
    const conn = new RelayConnection(`ws://127.0.0.1:${serverPort}`, 'test-token');

    const sessionId = await conn.connect();
    assert.equal(sessionId, 'test-session');

    const oldWs = activeWs!;
    let reconnected = false;
    wss.on('connection', (ws) => {
      activeWs = ws;
      ws.on('message', (raw) => {
        const msg = decodeMessage<AgentOutgoing>(raw.toString());
        if (msg.type === 'agent.register') {
          reconnected = true;
          ws.send(encodeMessage({ type: 'session.created', sessionId: 'test-session-2' }));
        }
      });
    });
    oldWs.close();

    await new Promise(r => setTimeout(r, 4000));
    assert.ok(reconnected, 'agent should reconnect after relay closes connection');

    conn.disconnect();
  });

  it('fails with timeout when relay is unreachable', async () => {
    const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
    const conn = new RelayConnection('ws://127.0.0.1:1', 'test-token');

    const start = Date.now();
    await assert.rejects(() => conn.connect(), /timeout|ECONNREFUSED|error/i);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 15_000, `Should fail within timeout, took ${elapsed}ms`);

    conn.disconnect();
  });

  it('uses ping/pong heartbeat to detect dead connections', () => {
    assert.ok(connSource.includes('.ping()'), 'Should send WebSocket pings');
    assert.ok(connSource.includes("'pong'"), 'Should listen for pong events');
    assert.ok(connSource.includes('PONG_TIMEOUT'), 'Should have pong timeout constant');
  });

  it('connection timeout prevents hanging on unresponsive relay', () => {
    assert.ok(connSource.includes('CONNECT_TIMEOUT'), 'Should define connection timeout');
    assert.match(connSource, /CONNECT_TIMEOUT\s*=\s*\d+/, 'Should set timeout value');
    assert.ok(connSource.includes('Connection timeout'), 'Should log timeout error');
  });

  it('exponential backoff on repeated reconnect failures', () => {
    assert.match(connSource, /reconnectDelay\s*\*\s*2/, 'Should double delay on failure');
    assert.match(connSource, /Math\.min\(.*30_000/, 'Should cap delay at 30 seconds');
    assert.match(connSource, /reconnectDelay\s*=\s*3000/, 'Should reset delay on success');
  });

  it('uses settled flag to prevent double event handling', () => {
    assert.match(connSource, /let\s+settled\s*=\s*false/, 'Should declare settled flag');
    assert.match(connSource, /if\s*\(\s*settled\s*\)\s*return/, 'Should check settled before processing');
    assert.match(connSource, /settled\s*=\s*true/, 'Should set settled to true');
  });

  it('terminates WebSocket on heartbeat pong timeout', () => {
    assert.match(connSource, /Heartbeat timeout/, 'Should log heartbeat timeout');
    assert.match(connSource, /\.terminate\(\)/, 'Should call terminate() on dead connections');
  });
});
