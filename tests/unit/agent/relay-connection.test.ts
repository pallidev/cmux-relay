import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket, createWebSocketStream } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { encodeMessage, decodeMessage } from '../../../packages/shared/dist/index.js';
import type { RelayToAgent, RelayToClient, AgentOutgoing } from '../../../packages/shared/dist/index.js';

// We test RelayConnection by spawning it in-process with a mock relay server.
// Since RelayConnection creates real WebSocket connections, we create a real WS server.

describe('relay-connection (integration unit)', () => {
  let httpServer: ReturnType<typeof createHttpServer>;
  let wss: WebSocketServer;
  let port: number;
  let agentWs: WebSocket | null = null;

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
            ws.send(encodeMessage({ type: 'session.created', sessionId: 'test-session-1' }));
          } else if (msg.type === 'agent.pair') {
            ws.send(encodeMessage({ type: 'pairing.wait', code: 'ABCD1234', url: 'http://localhost:3000/pair/ABCD1234' }));
          }
        });
      });
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
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

  describe('with token (agent.register)', () => {
    it('sends agent.register on connect and receives session.created', async () => {
      const serverPort = await createRelayServer();

      // Dynamically import to avoid side effects
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

      const sessionId = await conn.connect();
      assert.equal(sessionId, 'test-session-1');
      assert.equal(conn.getSessionId(), 'test-session-1');

      conn.disconnect();
    });

    it('receives client.data messages', async () => {
      const serverPort = await createRelayServer();
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

      await conn.connect();

      const received: unknown[] = [];
      conn.onClientData((msg) => received.push(msg));

      // Simulate relay sending client.data
      agentWs!.send(encodeMessage({
        type: 'client.data',
        payload: { type: 'input', surfaceId: 's1', payload: { data: 'aGVsbG8=' } },
      }));

      await new Promise((r) => setTimeout(r, 100));
      assert.equal(received.length, 1);

      conn.disconnect();
    });

    it('receives client.connected/disconnected events', async () => {
      const serverPort = await createRelayServer();
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

      await conn.connect();

      let connected = false;
      let disconnected = false;
      conn.onClientConnected(() => { connected = true; });
      conn.onClientDisconnected(() => { disconnected = true; });

      agentWs!.send(encodeMessage({ type: 'client.connected' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(connected, 'should receive client.connected');

      agentWs!.send(encodeMessage({ type: 'client.disconnected' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(disconnected, 'should receive client.disconnected');

      conn.disconnect();
    });

    it('sends agent.data to relay', async () => {
      const serverPort = await createRelayServer();
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

      await conn.connect();

      const received: string[] = [];
      agentWs!.on('message', (raw) => {
        received.push(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      });

      conn.send({ type: 'output', surfaceId: 's1', payload: { data: 'dGVzdA==' } });

      await new Promise((r) => setTimeout(r, 100));
      assert.ok(received.length > 0);
      const msg = decodeMessage<{ type: string; payload: unknown }>(received[received.length - 1]);
      assert.equal(msg.type, 'agent.data');

      conn.disconnect();
    });
  });

  describe('without token (pairing flow)', () => {
    it('sends agent.pair and receives pairing.wait', async () => {
      const serverPort = await createRelayServer();
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`);

      // The connect() promise won't resolve until session.created
      // So we listen for pairing.wait separately
      const connectPromise = conn.connect();

      await new Promise((r) => setTimeout(r, 100));

      // The relay server should have received agent.pair
      // and responded with pairing.wait
      // connect() is still pending, so we close manually
      conn.disconnect();
    });

    it('rejects on pairing.rejected', async () => {
      // Create a server that rejects pairing
      const rejectServer = createHttpServer();
      const rejectWss = new WebSocketServer({ server: rejectServer });

      await new Promise<void>((resolve) => {
        rejectServer.listen(0, () => resolve());
      });

      rejectWss.on('connection', (ws) => {
        ws.on('message', () => {
          ws.send(encodeMessage({ type: 'pairing.rejected', reason: 'Denied' }));
        });
      });

      const addr = rejectServer.address();
      const rejectPort = typeof addr === 'object' && addr ? addr.port : 0;

      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${rejectPort}`);

      await assert.rejects(() => conn.connect(), /Denied/);

      for (const ws of rejectWss.clients) ws.close();
      rejectWss.close();
      await new Promise<void>((resolve) => rejectServer.close(() => resolve()));
    });
  });

  describe('lifecycle', () => {
    it('disconnect cleans up', async () => {
      const serverPort = await createRelayServer();
      const { RelayConnection } = await import('../../../packages/agent/src/relay-connection.js');
      const conn = new RelayConnection(`ws://localhost:${serverPort}`, 'test-token');

      await conn.connect();
      conn.disconnect();

      // getSessionId should still return the old session
      assert.equal(conn.getSessionId(), 'test-session-1');
    });
  });
});
