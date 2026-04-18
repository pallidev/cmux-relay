/**
 * Integration test for cmux-relay
 *
 * Tests:
 * 1. CmuxClient connection state management + JSON-RPC
 * 2. Client auth (valid/invalid tokens)
 * 3. Workspace/surface management (store updates → client notifications)
 * 4. Output streaming (store sends output → subscribed clients receive it)
 * 5. Input forwarding (client input → InputHandler called)
 * 6. Multi-client broadcast
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SessionStore } from '../packages/agent/src/session-store.js';
import { createWSServer } from '../packages/agent/src/ws-server.js';
import { CmuxClient } from '../packages/agent/src/cmux-client.js';
import type { IInputHandler } from '../packages/agent/src/input-handler.js';
import jwt from 'jsonwebtoken';

// ─── Shared constants ───
const JWT_SECRET = 'test-secret';

function signToken(role: string): string {
  return jwt.sign({ role, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET);
}

// ─── Mock InputHandler ───

function createMockInputHandler(): IInputHandler & {
  inputs: Array<{ surfaceId: string; data: string }>;
  resizes: Array<{ surfaceId: string; cols: number; rows: number }>;
} {
  const inputs: Array<{ surfaceId: string; data: string }> = [];
  const resizes: Array<{ surfaceId: string; cols: number; rows: number }> = [];

  return {
    inputs,
    resizes,
    async handleInput(surfaceId: string, data: string) {
      inputs.push({ surfaceId, data });
    },
    async handleResize(surfaceId: string, cols: number, rows: number) {
      resizes.push({ surfaceId, cols, rows });
    },
  };
}

// ─── Helpers ───

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout (${timeout}ms) waiting for "${type}"`));
    }, timeout);

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

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function disconnect(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === 3) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// ─── Tests ───

describe('cmux-relay integration', () => {
  let httpServer: Server;
  let port: number;
  let store: SessionStore;
  let inputHandler: ReturnType<typeof createMockInputHandler>;

  before(async () => {
    process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;

    store = new SessionStore();
    inputHandler = createMockInputHandler();

    httpServer = await createWSServer(0, '127.0.0.1', { store, inputHandler });
    const addr = httpServer.address() as { port: number } | null;
    if (!addr || typeof addr.port !== 'number') {
      throw new Error('Server did not bind to a port');
    }
    port = addr.port;
    console.log(`Test server on port ${port}`);
  });

  after(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    delete process.env.CMUX_RELAY_JWT_SECRET;
  });

  // ─── Client auth ───

  it('client rejected with invalid token', async () => {
    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: 'garbage' } });

    const msg = await waitForMessage(ws, 'error');
    assert.equal(msg.payload.message, 'Invalid token');
    await disconnect(ws);
  });

  it('client authenticates and gets workspaces + surfaces', async () => {
    store.updateWorkspaces([
      { id: 'ws1', title: 'Test Workspace' },
    ]);
    store.updateSurfaces('ws1', [
      { id: 'surf1', title: 'terminal', type: 'terminal', workspaceId: 'ws1' },
    ]);

    const ws = await connect(port);

    // Register listeners before auth since server sends both messages rapidly
    const [wsMsg, surfMsg] = await Promise.all([
      waitForMessage(ws, 'workspaces'),
      waitForMessage(ws, 'surfaces'),
      (() => { send(ws, { type: 'auth', payload: { token: signToken('client') } }); return Promise.resolve(); })(),
    ]);

    assert.ok(Array.isArray(wsMsg.payload.workspaces));
    assert.equal(wsMsg.payload.workspaces.length, 1);
    assert.equal(wsMsg.payload.workspaces[0].title, 'Test Workspace');

    assert.ok(Array.isArray(surfMsg.payload.surfaces));
    assert.equal(surfMsg.payload.surfaces.length, 1);
    assert.equal(surfMsg.payload.surfaces[0].id, 'surf1');

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws1', []);
  });

  it('unauthenticated client gets error', async () => {
    const ws = await connect(port);
    send(ws, { type: 'workspaces.list' });

    const msg = await waitForMessage(ws, 'error');
    assert.equal(msg.payload.message, 'Not authenticated');
    await disconnect(ws);
  });

  // ─── Workspace/surface management ───

  it('client can request workspace list', async () => {
    store.updateWorkspaces([
      { id: 'lst', title: 'Listable' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces'); // initial push on auth

    send(ws, { type: 'workspaces.list' });
    const list = await waitForMessage(ws, 'workspaces');
    assert.ok(list.payload.workspaces.some((w: any) => w.id === 'lst'));

    await disconnect(ws);
    store.updateWorkspaces([]);
  });

  it('client can select a surface', async () => {
    store.updateWorkspaces([
      { id: 'ws-sel', title: 'Select Workspace' },
    ]);
    store.updateSurfaces('ws-sel', [
      { id: 'sel', title: 'selectable', type: 'terminal', workspaceId: 'ws-sel' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    send(ws, { type: 'surface.select', surfaceId: 'sel' });
    const active = await waitForMessage(ws, 'surface.active');
    assert.equal(active.surfaceId, 'sel');
    assert.equal(active.workspaceId, 'ws-sel');

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-sel', []);
  });

  // ─── Output streaming ───

  it('output sent to subscribed clients', async () => {
    store.updateWorkspaces([
      { id: 'ws-out', title: 'Out Workspace' },
    ]);
    store.updateSurfaces('ws-out', [
      { id: 's-out', title: 'out-test', type: 'terminal', workspaceId: 'ws-out' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');
    send(ws, { type: 'surface.select', surfaceId: 's-out' });
    await waitForMessage(ws, 'surface.active');

    const payload = Buffer.from('Hello cmux!').toString('base64');
    store.sendToClientsWithSurface('s-out', {
      type: 'output',
      surfaceId: 's-out',
      payload: { data: payload },
    });

    const out = await waitForMessage(ws, 'output');
    assert.equal(out.payload.data, payload);
    assert.equal(Buffer.from(out.payload.data, 'base64').toString(), 'Hello cmux!');

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-out', []);
  });

  it('output not sent to client watching different surface', async () => {
    store.updateWorkspaces([
      { id: 'ws-leak', title: 'Leak Workspace' },
    ]);
    store.updateSurfaces('ws-leak', [
      { id: 'A', title: 'A', type: 'terminal', workspaceId: 'ws-leak' },
      { id: 'B', title: 'B', type: 'terminal', workspaceId: 'ws-leak' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');
    send(ws, { type: 'surface.select', surfaceId: 'A' });
    await waitForMessage(ws, 'surface.active');

    // Send output for B — client watches A
    store.sendToClientsWithSurface('B', {
      type: 'output',
      surfaceId: 'B',
      payload: { data: 'nope' },
    });

    const leaked = await Promise.race([
      waitForMessage(ws, 'output', 300).then(() => true).catch(() => false),
      new Promise<boolean>(r => setTimeout(() => r(false), 400)),
    ]);
    assert.equal(leaked, false, 'Should NOT receive output for unsubscribed surface');

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-leak', []);
  });

  // ─── Input forwarding ───

  it('client input forwarded to InputHandler', async () => {
    store.updateWorkspaces([
      { id: 'ws-in', title: 'In Workspace' },
    ]);
    store.updateSurfaces('ws-in', [
      { id: 's-in', title: 'in-test', type: 'terminal', workspaceId: 'ws-in' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    const inputB64 = Buffer.from('ls -la\n').toString('base64');
    send(ws, { type: 'input', surfaceId: 's-in', payload: { data: inputB64 } });

    await new Promise(r => setTimeout(r, 100));
    assert.equal(inputHandler.inputs.length, 1);
    assert.equal(inputHandler.inputs[0].surfaceId, 's-in');
    assert.equal(inputHandler.inputs[0].data, inputB64);

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-in', []);
    inputHandler.inputs.length = 0;
  });

  it('client resize forwarded to InputHandler', async () => {
    store.updateWorkspaces([
      { id: 'ws-rsz', title: 'Resize Workspace' },
    ]);
    store.updateSurfaces('ws-rsz', [
      { id: 's-rsz', title: 'rsz-test', type: 'terminal', workspaceId: 'ws-rsz' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    send(ws, { type: 'resize', surfaceId: 's-rsz', payload: { cols: 120, rows: 50 } });

    await new Promise(r => setTimeout(r, 100));
    assert.equal(inputHandler.resizes.length, 1);
    assert.equal(inputHandler.resizes[0].surfaceId, 's-rsz');
    assert.equal(inputHandler.resizes[0].cols, 120);
    assert.equal(inputHandler.resizes[0].rows, 50);

    await disconnect(ws);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-rsz', []);
    inputHandler.resizes.length = 0;
  });

  // ─── Workspace update notifications ───

  it('workspace update notifies clients', async () => {
    store.updateWorkspaces([
      { id: 'u1', title: 'initial' },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    const first = await waitForMessage(ws, 'workspaces');
    assert.equal(first.payload.workspaces.length, 1);

    store.updateWorkspaces([
      { id: 'u1', title: 'renamed' },
      { id: 'u2', title: 'added' },
    ]);
    store.broadcastToClients({
      type: 'workspaces',
      payload: { workspaces: store.getAllWorkspaces() },
    });

    const updated = await waitForMessage(ws, 'workspaces');
    assert.equal(updated.payload.workspaces.length, 2);
    const titles = updated.payload.workspaces.map((w: any) => w.title).sort();
    assert.deepEqual(titles, ['added', 'renamed']);

    await disconnect(ws);
    store.updateWorkspaces([]);
  });

  // ─── Multi-client ───

  it('new connection replaces existing client', async () => {
    store.updateWorkspaces([
      { id: 'ws-excl', title: 'Exclusive Workspace' },
    ]);
    store.updateSurfaces('ws-excl', [
      { id: 'excl', title: 'excl', type: 'terminal', workspaceId: 'ws-excl' },
    ]);

    const c1 = await connect(port);
    send(c1, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(c1, 'workspaces');

    // c2 connects — should replace c1
    const c2 = await connect(port);
    send(c2, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(c2, 'workspaces');

    // c1 should be disconnected
    const c1Closed = await new Promise<boolean>(r => {
      c1.on('close', () => r(true));
      setTimeout(() => r(false), 500);
    });
    assert.equal(c1Closed, true, 'First client should be disconnected');

    // c2 should still work
    send(c2, { type: 'surface.select', surfaceId: 'excl' });
    const active = await waitForMessage(c2, 'surface.active');
    assert.equal(active.surfaceId, 'excl');

    await disconnect(c2);
    store.updateWorkspaces([]);
    store.updateSurfaces('ws-excl', []);
  });

  // ─── Notifications ───

  it('client receives existing notifications on auth', async () => {
    store.updateNotifications([
      {
        id: 'notif-1',
        title: 'Claude Code',
        subtitle: 'Waiting',
        body: 'Claude is waiting for your input',
        surfaceId: 'surf-notif',
        workspaceId: 'ws-notif',
        isRead: false,
      },
    ]);

    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });

    const msg = await waitForMessage(ws, 'notifications');
    assert.ok(Array.isArray(msg.payload.notifications));
    assert.equal(msg.payload.notifications.length, 1);
    assert.equal(msg.payload.notifications[0].title, 'Claude Code');
    assert.equal(msg.payload.notifications[0].subtitle, 'Waiting');
    assert.equal(msg.payload.notifications[0].surfaceId, 'surf-notif');
    assert.equal(msg.payload.notifications[0].workspaceId, 'ws-notif');

    await disconnect(ws);
    store.updateNotifications([]);
  });

  it('new notifications broadcast to authenticated clients', async () => {
    const ws = await connect(port);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    // Broadcast a new notification
    store.broadcastToClients({
      type: 'notifications',
      payload: {
        notifications: [{
          id: 'notif-bcast',
          title: 'Test',
          subtitle: 'Alert',
          body: 'Something happened',
          surfaceId: 's1',
          workspaceId: 'w1',
          isRead: false,
        }],
      },
    });

    const msg = await waitForMessage(ws, 'notifications');
    assert.equal(msg.payload.notifications.length, 1);
    assert.equal(msg.payload.notifications[0].id, 'notif-bcast');
    assert.equal(msg.payload.notifications[0].title, 'Test');

    await disconnect(ws);
  });

  it('no notifications sent when store has none', async () => {
    store.updateNotifications([]);

    const ws = await connect(port);
    // Collect messages for a short time
    const messages: any[] = [];
    const handler = (data: WebSocket.Data) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* skip */ }
    };
    ws.on('message', handler);

    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    // Wait a bit for any pending messages
    await new Promise(r => setTimeout(r, 100));
    ws.off('message', handler);

    const notifMsgs = messages.filter(m => m.type === 'notifications');
    assert.equal(notifMsgs.length, 0, 'Should NOT send notifications message when there are none');

    await disconnect(ws);
  });
});

// ─── CmuxClient tests ───

describe('CmuxClient connection management', () => {
  let mockServer: ReturnType<typeof createNetServer>;
  let socketPath: string;
  let client: CmuxClient;
  let mockHandler: ((sock: Socket) => void) | null = null;

  // Mock JSON-RPC handler
  const jsonRpcHandler = (sock: Socket) => {
    sock.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const req = JSON.parse(line);
          if (mockHandler) {
            mockHandler(sock);
          } else {
            // Default: respond with workspaces
            sock.write(JSON.stringify({
              id: req.id,
              ok: true,
              result: { workspaces: [{ id: 'ws1', title: 'Test', index: 0 }] },
            }) + '\n');
          }
        } catch { /* skip */ }
      }
    });
  };

  before(async () => {
    socketPath = join(tmpdir(), `cmux-test-${process.pid}.sock`);
    mockServer = createNetServer();
    mockServer.on('connection', jsonRpcHandler);

    await new Promise<void>((resolve) => {
      mockServer.listen(socketPath, resolve);
    });
  });

  after(async () => {
    client?.disconnect();
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it('starts in disconnected state', () => {
    client = new CmuxClient(socketPath);
    assert.equal(client.state, 'disconnected');
    assert.equal(client.isConnected(), false);
  });

  it('transitions to connected on successful connect', async () => {
    const connectPromise = client.connect();
    assert.equal(client.state, 'connecting');

    await connectPromise;
    assert.equal(client.state, 'connected');
    assert.equal(client.isConnected(), true);
  });

  it('prevents duplicate connect calls', async () => {
    const stateBefore = client.state;
    await client.connect(); // Should no-op
    assert.equal(client.state, stateBefore);
  });

  it('sends JSON-RPC and receives response', async () => {
    const workspaces = await client.listWorkspaces();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].id, 'ws1');
    assert.equal(workspaces[0].title, 'Test');
  });

  it('rejects requests when disconnected', async () => {
    client.disconnect();
    assert.equal(client.state, 'disconnected');
    assert.equal(client.isConnected(), false);

    await assert.rejects(
      () => client.listWorkspaces(),
      { message: 'Not connected to cmux' },
    );
  });

  it('fires onDisconnected callback when server closes connection', async () => {
    let disconnectedCalled = false;
    const c = new CmuxClient(socketPath);

    await c.connect(() => { disconnectedCalled = true; });
    assert.equal(c.state, 'connected');

    // Disconnect and reconnect to get a fresh socket we can track
    c.disconnect();

    // Track server-side sockets
    const serverSockets: Socket[] = [];
    const trackHandler = (s: Socket) => { serverSockets.push(s); };

    mockServer.on('connection', trackHandler);
    await c.connect(() => { disconnectedCalled = true; });

    // Wait for the connection to establish
    await new Promise(r => setTimeout(r, 100));

    // Destroy the server-side socket
    for (const s of serverSockets) s.destroy();
    mockServer.off('connection', trackHandler);

    // Wait for close event
    await new Promise(r => setTimeout(r, 200));
    assert.equal(c.state, 'disconnected');
    assert.equal(disconnectedCalled, true);

    c.disconnect();
  });

  it('reconnects after disconnect', async () => {
    const sockPath = join(tmpdir(), `cmux-recon-${Date.now()}.sock`);
    const reconServer = createNetServer();
    reconServer.on('connection', jsonRpcHandler);
    await new Promise<void>(r => reconServer.listen(sockPath, r));

    const c = new CmuxClient(sockPath);
    await c.connect();
    assert.equal(c.state, 'connected');
    assert.equal(c.isConnected(), true);

    c.disconnect();
    assert.equal(c.state, 'disconnected');
    assert.equal(c.isConnected(), false);

    await c.connect();
    assert.equal(c.state, 'connected');
    assert.equal(c.isConnected(), true);

    c.disconnect();
    await new Promise<void>(r => reconServer.close(() => r()));
  });

  it('handles server not available', async () => {
    const badClient = new CmuxClient(join(tmpdir(), `nonexistent-${Date.now()}.sock`));
    await assert.rejects(
      () => badClient.connect(),
      /Cannot connect to cmux socket/,
    );
    assert.equal(badClient.state, 'disconnected');
  });
});
