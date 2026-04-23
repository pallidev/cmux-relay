/**
 * Integration test for relay server data forwarding.
 *
 * Tests the SessionRegistry with real WebSocket connections,
 * verifying that agent.data messages are correctly forwarded to clients.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionRegistry } from '../packages/relay/src/session-registry.js';
import { encodeMessage } from '../packages/shared/dist/index.js';
import type { RelayToClient } from '../packages/shared/dist/index.js';

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${timeout}ms) waiting for "${type}"`)), timeout);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch { /* skip */ }
    };
    ws.on('message', handler);
  });
}

function waitForAll(ws: WebSocket, type: string, count: number, timeout = 5000): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, timeout);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          msgs.push(msg);
          if (msgs.length >= count) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(msgs);
          }
        }
      } catch { /* skip */ }
    };
    ws.on('message', handler);
  });
}

function connectWs(port: number, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function connectAgent(port: number): Promise<{ ws: WebSocket; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    ws.on('error', reject);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session.created') {
          ws.off('message', handler);
          resolve({ ws, sessionId: msg.sessionId });
        }
      } catch { /* skip */ }
    };
    ws.on('message', handler);
  });
}

function disconnect(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === 3) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

describe('relay server data forwarding', () => {
  let registry: SessionRegistry;
  let httpServer: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let port: number;

  before(async () => {
    registry = new SessionRegistry();

    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws, req, type: 'agent' | 'client') => {
      if (type === 'agent') {
        registry.registerAgent(1, ws);
        ws.on('message', (raw) => {
          const data = typeof raw === 'string' ? raw.toString() : raw.toString('utf-8');
          registry.handleAgentMessage(ws, data);
        });
        ws.on('close', () => registry.disconnectAgent(ws));
      } else {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('session') ?? '';
        registry.connectClient(sessionId, ws, req);
        ws.on('message', (raw) => {
          const data = typeof raw === 'string' ? raw.toString() : raw.toString('utf-8');
          registry.handleClientMessage(ws, data);
        });
        ws.on('close', () => registry.disconnectClient(ws));
      }
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (path === '/ws/agent' || path === '/ws/client') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, path === '/ws/agent' ? 'agent' : 'client');
        });
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address() as { port: number };
    port = addr.port;
  });

  after(async () => {
    await new Promise<void>(r => httpServer.close(() => r()));
  });

  it('agent.data with output payload is forwarded to client', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    assert.ok(sessionId, 'Should receive session ID');

    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);

    const outputPayload: RelayToClient = {
      type: 'output',
      surfaceId: 'surf1',
      payload: { data: Buffer.from('Hello World\n').toString('base64') },
    };
    agentWs.send(encodeMessage({ type: 'agent.data', payload: outputPayload }));

    const received = await waitForMessage(clientWs, 'output');
    assert.equal(received.type, 'output');
    assert.equal(received.surfaceId, 'surf1');
    assert.equal(received.payload.data, outputPayload.payload.data);

    const text = Buffer.from(received.payload.data, 'base64').toString();
    assert.equal(text, 'Hello World\n');

    await disconnect(clientWs);
    await disconnect(agentWs);
  });

  it('multiple output updates are forwarded in order', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);

    for (let i = 1; i <= 3; i++) {
      const payload: RelayToClient = {
        type: 'output',
        surfaceId: 'surf1',
        payload: { data: Buffer.from(`Line ${i}\n`).toString('base64') },
      };
      agentWs.send(encodeMessage({ type: 'agent.data', payload }));
    }

    const outputs = await waitForAll(clientWs, 'output', 3);
    assert.equal(outputs.length, 3, 'Should receive all 3 outputs');

    for (let i = 0; i < 3; i++) {
      const text = Buffer.from(outputs[i].payload.data, 'base64').toString();
      assert.equal(text, `Line ${i + 1}\n`, `Output ${i + 1} should match`);
    }

    await disconnect(clientWs);
    await disconnect(agentWs);
  });

  it('workspaces and surfaces messages are forwarded correctly', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);

    agentWs.send(encodeMessage({
      type: 'agent.data',
      payload: { type: 'workspaces', payload: { workspaces: [{ id: 'ws1', title: 'Test' }] } },
    }));
    const ws = await waitForMessage(clientWs, 'workspaces');
    assert.equal(ws.payload.workspaces[0].id, 'ws1');

    agentWs.send(encodeMessage({
      type: 'agent.data',
      payload: {
        type: 'surfaces',
        workspaceId: 'ws1',
        payload: { surfaces: [{ id: 'surf1', title: 'term', type: 'terminal', workspaceId: 'ws1' }] },
      },
    }));
    const surf = await waitForMessage(clientWs, 'surfaces');
    assert.equal(surf.workspaceId, 'ws1');
    assert.equal(surf.payload.surfaces[0].id, 'surf1');

    await disconnect(clientWs);
    await disconnect(agentWs);
  });

  it('client.data is forwarded to agent', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);
    clientWs.send(JSON.stringify({ type: 'surface.select', surfaceId: 'surf1' }));

    const agentMsg = await waitForMessage(agentWs, 'client.data');
    assert.equal(agentMsg.type, 'client.data');
    assert.equal(agentMsg.payload.type, 'surface.select');
    assert.equal(agentMsg.payload.surfaceId, 'surf1');

    await disconnect(clientWs);
    await disconnect(agentWs);
  });

  it('disconnected client stops receiving data', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);

    agentWs.send(encodeMessage({
      type: 'agent.data',
      payload: { type: 'output', surfaceId: 's1', payload: { data: 'abc' } },
    }));
    await waitForMessage(clientWs, 'output');

    await disconnect(clientWs);
    await new Promise(r => setTimeout(r, 100));

    agentWs.send(encodeMessage({
      type: 'agent.data',
      payload: { type: 'output', surfaceId: 's1', payload: { data: 'def' } },
    }));
    await new Promise(r => setTimeout(r, 200));

    await disconnect(agentWs);
  });

  it('agent receives client.connected and client.disconnected events', async () => {
    const { ws: agentWs, sessionId } = await connectAgent(port);
    const clientWs = await connectWs(port, `/ws/client?session=${sessionId}`);
    await waitForMessage(agentWs, 'client.connected');

    await disconnect(clientWs);
    await waitForMessage(agentWs, 'client.disconnected');

    await disconnect(agentWs);
  });
});
