import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { encodeMessage, decodeMessage } from '../../../packages/shared/dist/index.js';
import type { AgentOutgoing } from '../../../packages/shared/dist/index.js';

describe('WebRTC keepalive relay fallback', () => {
  let httpServer: ReturnType<typeof createHttpServer>;
  let wss: WebSocketServer;
  let agentWs: import('ws').WebSocket | null = null;

  function createRelayServer(): Promise<number> {
    return new Promise((resolve) => {
      httpServer = createHttpServer();
      wss = new WebSocketServer({ server: httpServer });
      wss.on('connection', (ws) => {
        agentWs = ws;
        ws.on('message', (raw) => {
          const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const msg = decodeMessage<AgentOutgoing>(data);
          if (msg.type === 'agent.register') {
            ws.send(encodeMessage({ type: 'session.created', sessionId: 'test-session-kp' }));
          }
        });
      });
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(port);
      });
    });
  }

  afterEach(async () => {
    agentWs = null;
    if (wss) {
      for (const ws of wss.clients) ws.close();
      wss.close();
    }
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  });

  it('sends data via relay when WebRTC is not connected', async () => {
    const serverPort = await createRelayServer();
    const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
    const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

    await conn.connect();

    const relayMessages: string[] = [];
    agentWs!.on('message', (raw) => {
      relayMessages.push(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    });

    // Simulate client connected — creates WebRTCTransport (offer sent, never answered)
    agentWs!.send(encodeMessage({ type: 'client.connected' }));
    await new Promise((r) => setTimeout(r, 100));

    // Send output — P2P not active, should go through relay
    conn.send({ type: 'output', surfaceId: 's1', payload: { data: 'dGVzdA==' } });
    await new Promise((r) => setTimeout(r, 100));

    const dataMsg = relayMessages.find(m => {
      const parsed = decodeMessage<any>(m);
      return parsed.type === 'agent.data';
    });
    assert.ok(dataMsg, 'Should send data via relay when WebRTC not connected');

    conn.disconnect();
  });

  it('sends notifications via relay when WebRTC is not connected', async () => {
    const serverPort = await createRelayServer();
    const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
    const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

    await conn.connect();

    const relayMessages: string[] = [];
    agentWs!.on('message', (raw) => {
      relayMessages.push(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    });

    agentWs!.send(encodeMessage({ type: 'client.connected' }));
    await new Promise((r) => setTimeout(r, 100));

    conn.send({ type: 'notifications', payload: { notifications: [{ id: 'n1', title: 'Test' }] } });
    await new Promise((r) => setTimeout(r, 100));

    const notifMsg = relayMessages.find(m => {
      const parsed = decodeMessage<any>(m);
      return parsed.type === 'agent.data' && parsed.payload?.type === 'notifications';
    });
    assert.ok(notifMsg, 'Notification should be sent via relay when WebRTC not active');

    conn.disconnect();
  });

  it('falls back to relay after keepalive timeout', async () => {
    const serverPort = await createRelayServer();
    const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
    // Short keepalive: ping every 200ms, timeout after 100ms
    const conn = new RelayConnection(
      `ws://localhost:${serverPort}`,
      'test-token',
      undefined,
      { pingInterval: 200, pingTimeout: 100 },
    );

    await conn.connect();

    const relayMessages: string[] = [];
    agentWs!.on('message', (raw) => {
      relayMessages.push(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    });

    agentWs!.send(encodeMessage({ type: 'client.connected' }));
    await new Promise((r) => setTimeout(r, 100));

    // Wait for keepalive timeout: 200ms (ping) + 100ms (timeout) + margin
    await new Promise((r) => setTimeout(r, 500));

    // After timeout, transport.isActive() should be false, so send goes through relay
    conn.send({ type: 'output', surfaceId: 's1', payload: { data: 'dGVzdA==' } });
    await new Promise((r) => setTimeout(r, 100));

    const dataMsg = relayMessages.find(m => {
      const parsed = decodeMessage<any>(m);
      return parsed.type === 'agent.data' && parsed.payload?.type === 'output';
    });
    assert.ok(dataMsg, 'Should fall back to relay after keepalive timeout');

    conn.disconnect();
  });
});
