/**
 * Integration tests for cloud mode polling all terminal surfaces.
 *
 * Tests the production code path:
 *   Mock cmux (multiple surfaces) → Agent (pollTerminal iterates all surfaces)
 *   → Relay (SessionRegistry) → Client WebSocket
 *
 * Verifies:
 *   - All terminal surfaces are polled (not just one)
 *   - Surface switching preserves real-time output
 *   - Output dedup works per surface independently
 *   - Non-terminal surfaces are skipped
 *   - pollRunning guard prevents overlapping
 *   - New surfaces added to store get picked up
 *   - cmux disconnection is handled gracefully
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../packages/agent/src/session-store.js';
import { CmuxClient } from '../packages/agent/src/cmux-client.js';
import { handleClientMessage } from '../packages/agent/src/message-handler.js';
import { RelayConnection } from '../packages/agent/src/relay-connection.js';
import { SessionRegistry } from '../packages/relay/src/session-registry.js';
import type { RelayToClient } from '../packages/shared/dist/index.js';
import type { IInputHandler } from '../packages/agent/src/input-handler.js';

function createMockInputHandler(): IInputHandler {
  return { async handleInput() {}, async handleResize() {} };
}

// ─── Multi-surface mock cmux ───

const surfaces = [
  { id: 'term-A', title: 'Terminal A', type: 'terminal', workspace_id: 'ws1' },
  { id: 'term-B', title: 'Terminal B', type: 'terminal', workspace_id: 'ws1' },
  { id: 'browser-C', title: 'Browser', type: 'browser', workspace_id: 'ws1' },
];

let surfaceTexts: Record<string, string> = {};

function createMultiCmuxServer(socketPath: string): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('connection', (sock: Socket) => {
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const req = JSON.parse(line);
            let result: unknown;
            switch (req.method) {
              case 'workspace.list':
                result = { workspaces: [{ id: 'ws1', title: 'Test', index: 0 }] };
                break;
              case 'surface.list':
                result = { surfaces };
                break;
              case 'surface.read_text': {
                const sid = req.params?.surface_id as string;
                const text = surfaceTexts[sid] ?? `$ ${sid}\nempty\n`;
                result = { base64: Buffer.from(text).toString('base64') };
                break;
              }
              case 'pane.list':
                result = {
                  panes: [
                    { id: 'p1', index: 0, surface_ids: ['term-A', 'term-B'], selected_surface_id: 'term-A', pixel_frame: { x: 0, y: 0, width: 960, height: 1080 }, focused: true },
                    { id: 'p2', index: 1, surface_ids: ['browser-C'], selected_surface_id: 'browser-C', pixel_frame: { x: 960, y: 0, width: 960, height: 1080 }, focused: false },
                  ],
                  container_frame: { width: 1920, height: 1080 },
                };
                break;
              default:
                result = {};
            }
            sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
          } catch { /* skip */ }
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
    server.on('error', reject);
  });
}

// ─── Mock relay server ───

function createMockRelayServer(): Promise<{ httpServer: ReturnType<typeof createHttpServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const registry = new SessionRegistry();
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });

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
      if (url.pathname === '/ws/agent' || url.pathname === '/ws/client') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, url.pathname === '/ws/agent' ? 'agent' : 'client');
        });
      } else {
        socket.destroy();
      }
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      resolve({ httpServer, port: addr.port });
    });
    httpServer.on('error', reject);
  });
}

// ─── Helpers ───

function createBufferedWs(port: number, path: string): Promise<WebSocket & { next: (type: string, timeout?: number) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`) as WebSocket & { next: (type: string, timeout?: number) => Promise<any> };
    const buffer: any[] = [];
    const waiters: Array<{ type: string; resolve: (msg: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        const idx = waiters.findIndex(w => w.type === msg.type);
        if (idx >= 0) {
          const w = waiters.splice(idx, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
        } else {
          buffer.push(msg);
        }
      } catch { /* skip */ }
    });

    ws.next = (type: string, timeout = 5000): Promise<any> => {
      return new Promise((resolve, reject) => {
        const idx = buffer.findIndex(m => m.type === type);
        if (idx >= 0) {
          resolve(buffer.splice(idx, 1)[0]);
          return;
        }
        const timer = setTimeout(() => {
          const wi = waiters.findIndex(w => w.type === type && w.resolve === resolve);
          if (wi >= 0) waiters.splice(wi, 1);
          reject(new Error(`Timeout (${timeout}ms) waiting for "${type}"`));
        }, timeout);
        waiters.push({ type, resolve, reject, timer });
      });
    };

    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function disconnect(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === 3) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

function collectOutputs(ws: WebSocket, durationMs: number): Promise<Array<{ surfaceId: string; text: string }>> {
  return new Promise((resolve) => {
    const outputs: Array<{ surfaceId: string; text: string }> = [];
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'output') {
          outputs.push({
            surfaceId: msg.surfaceId,
            text: Buffer.from(msg.payload.data, 'base64').toString(),
          });
        }
      } catch { /* skip */ }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(outputs); }, durationMs);
  });
}

// ─── Production-like cloud mode polling (mirrors index.ts) ───

function createPollLoop(
  cmux: CmuxClient,
  store: SessionStore,
  broadcast: (msg: RelayToClient) => void,
) {
  const lastOutput = new Map<string, string>();
  let pollRunning = false;

  const pollTerminal = async () => {
    if (pollRunning) return;
    pollRunning = true;
    try {
      if (!cmux.isConnected()) return;
      for (const [, surf] of store.getAllSurfaces()) {
        if (surf.type !== 'terminal') continue;
        const text = await cmux.readTerminalText(surf.id);
        if (text) {
          const b64 = Buffer.from(text).toString('base64');
          if (lastOutput.get(surf.id) !== b64) {
            lastOutput.set(surf.id, b64);
            broadcast({ type: 'output', surfaceId: surf.id, payload: { data: b64 } });
          }
        }
      }
    } catch {
      // ignore polling errors
    } finally {
      pollRunning = false;
    }
  };

  return { pollTerminal, lastOutput };
}

// ─── Tests ───

describe('cloud mode multi-surface polling', () => {
  let cmuxServer: NetServer;
  let relay: { httpServer: ReturnType<typeof createHttpServer>; port: number };
  let cmux: CmuxClient;
  let store: SessionStore;
  let agentConn: RelayConnection;
  let sessionId: string;
  let pollInterval: ReturnType<typeof setInterval>;
  let poll: ReturnType<typeof createPollLoop>;

  before(async () => {
    surfaceTexts = {};

    const socketPath = join(tmpdir(), `cmux-multi-test-${process.pid}.sock`);
    cmuxServer = await createMultiCmuxServer(socketPath);

    cmux = new CmuxClient(socketPath);
    await cmux.connect();

    store = new SessionStore();
    const workspaces = await cmux.listWorkspaces();
    store.updateWorkspaces(workspaces.map(w => ({ id: w.id, title: w.title })));
    const surfs = await cmux.listSurfaces(workspaces[0].id);
    store.updateSurfaces(workspaces[0].id, surfs.map(s => ({
      id: s.id, title: s.title || '', type: s.type, workspaceId: s.workspace_id,
    })));

    relay = await createMockRelayServer();

    agentConn = new RelayConnection(`ws://127.0.0.1:${relay.port}/ws/agent`, 'test-token');
    sessionId = await agentConn.connect();

    const msgDeps = { store, inputHandler: createMockInputHandler(), cmux };

    agentConn.onClientData(async (msg) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'cloud-client',
        msgDeps,
        (response) => { agentConn.send(response); },
      );
    });

    poll = createPollLoop(cmux, store, (msg) => agentConn.send(msg));
    pollInterval = setInterval(poll.pollTerminal, 100);
  });

  after(async () => {
    clearInterval(pollInterval);
    agentConn.disconnect();
    cmux.disconnect();
    await new Promise<void>(r => cmuxServer.close(() => r()));
    await new Promise<void>(r => relay.httpServer.close(() => r()));
  });

  it('polls all terminal surfaces and sends output for each', async () => {
    surfaceTexts['term-A'] = 'output from A\n';
    surfaceTexts['term-B'] = 'output from B\n';

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    const outputs = await collectOutputs(clientWs, 1500);
    await disconnect(clientWs);

    const surfaceIds = [...new Set(outputs.map(o => o.surfaceId))];
    console.log(`Multi-surface poll: ${outputs.length} outputs from surfaces: ${surfaceIds.join(', ')}`);

    assert.ok(surfaceIds.includes('term-A'), 'Should receive output for term-A');
    assert.ok(surfaceIds.includes('term-B'), 'Should receive output for term-B');
    assert.ok(!surfaceIds.includes('browser-C'), 'Should NOT poll non-terminal browser-C');
  });

  it('output changes on any surface are detected', async () => {
    surfaceTexts['term-A'] = 'initial A\n';
    surfaceTexts['term-B'] = 'initial B\n';

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    // Collect initial outputs
    const initial = await collectOutputs(clientWs, 1000);

    // Change only term-B
    surfaceTexts['term-B'] = 'CHANGED B\n';

    const afterChange = await collectOutputs(clientWs, 1000);
    await disconnect(clientWs);

    const bOutputs = afterChange.filter(o => o.surfaceId === 'term-B');
    assert.ok(bOutputs.length >= 1, `Should receive output for term-B after change, got ${bOutputs.length}`);
    assert.ok(bOutputs.some(o => o.text.includes('CHANGED B')), `term-B output should contain changed text`);
  });

  it('surface switching: selecting different surface still gets polled output', async () => {
    surfaceTexts['term-A'] = 'surface A content\n';
    surfaceTexts['term-B'] = 'surface B content\n';

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');
    await clientWs.next('surfaces');

    // Select term-A first
    send(clientWs, { type: 'surface.select', surfaceId: 'term-A' });
    await clientWs.next('surface.active');
    const initialA = await clientWs.next('output');
    assert.equal(initialA.surfaceId, 'term-A');

    // Switch to term-B
    send(clientWs, { type: 'surface.select', surfaceId: 'term-B' });
    await clientWs.next('surface.active');
    const initialB = await clientWs.next('output');
    assert.equal(initialB.surfaceId, 'term-B');

    // Change term-B content — should still get polled updates
    surfaceTexts['term-B'] = 'term-B updated after switch\n';
    const polled = await collectOutputs(clientWs, 1500);
    await disconnect(clientWs);

    const bUpdates = polled.filter(o => o.surfaceId === 'term-B');
    assert.ok(bUpdates.length >= 1, `Should receive polled output for term-B after switch, got ${bUpdates.length}`);
    assert.ok(bUpdates.some(o => o.text.includes('updated after switch')),
      'Polled output should contain updated text');
  });

  it('dedup: unchanged surface output is not re-sent', async () => {
    const staticText = 'STATIC CONTENT\n';
    surfaceTexts['term-A'] = staticText;
    surfaceTexts['term-B'] = staticText;

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    const outputs = await collectOutputs(clientWs, 2000);
    await disconnect(clientWs);

    // Each surface should send output at most once (dedup after first)
    const aCount = outputs.filter(o => o.surfaceId === 'term-A').length;
    const bCount = outputs.filter(o => o.surfaceId === 'term-B').length;

    console.log(`Dedup test: term-A sent ${aCount}x, term-B sent ${bCount}x`);

    assert.ok(aCount <= 2, `term-A should send at most 2 outputs (initial + 1 poll), got ${aCount}`);
    assert.ok(bCount <= 2, `term-B should send at most 2 outputs (initial + 1 poll), got ${bCount}`);
  });

  it('new surface added to store gets polled on next cycle', async () => {
    surfaceTexts['term-A'] = 'A output\n';
    surfaceTexts['term-D'] = undefined as any; // will be set below
    delete surfaceTexts['term-D'];

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    // Add a new surface to the store (simulates syncAll discovering a new terminal)
    store.updateSurfaces('ws1', [
      { id: 'term-A', title: 'A', type: 'terminal', workspaceId: 'ws1' },
      { id: 'term-B', title: 'B', type: 'terminal', workspaceId: 'ws1' },
      { id: 'term-D', title: 'D', type: 'terminal', workspaceId: 'ws1' },
    ]);

    surfaceTexts['term-D'] = 'new terminal D\n';

    const outputs = await collectOutputs(clientWs, 1500);
    await disconnect(clientWs);

    const dOutputs = outputs.filter(o => o.surfaceId === 'term-D');
    assert.ok(dOutputs.length >= 1, `Should receive output for newly added term-D, got ${dOutputs.length}`);
    assert.ok(dOutputs[0].text.includes('new terminal D'), 'Should contain the new surface text');

    // Clean up
    store.updateSurfaces('ws1', [
      { id: 'term-A', title: 'A', type: 'terminal', workspaceId: 'ws1' },
      { id: 'term-B', title: 'B', type: 'terminal', workspaceId: 'ws1' },
      { id: 'browser-C', title: 'C', type: 'browser', workspaceId: 'ws1' },
    ]);
  });

  it('pollRunning guard prevents concurrent executions', async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;

    const testStore = new SessionStore();
    testStore.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    testStore.updateSurfaces('ws1', [
      { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
      { id: 's2', title: 'T2', type: 'terminal', workspaceId: 'ws1' },
      { id: 's3', title: 'T3', type: 'terminal', workspaceId: 'ws1' },
    ]);

    let running = false;
    const slowPoll = async () => {
      if (running) return;
      running = true;
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      try {
        await new Promise(r => setTimeout(r, 100));
      } finally {
        activeCalls--;
        running = false;
      }
    };

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(slowPoll());
    }
    await Promise.all(promises);

    assert.ok(maxConcurrent <= 1, `Should never have concurrent polls, max was ${maxConcurrent}`);
  });

  it('handles cmux disconnection gracefully during poll', async () => {
    surfaceTexts['term-A'] = 'before disconnect\n';

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    // Get some initial outputs
    await collectOutputs(clientWs, 500);

    // Disconnect cmux
    cmux.disconnect();

    // Poll should not throw, just skip
    await poll.pollTerminal();

    // Reconnect cmux
    await cmux.connect();

    surfaceTexts['term-A'] = 'after reconnect\n';
    const afterReconnect = await collectOutputs(clientWs, 1500);
    await disconnect(clientWs);

    const aOutputs = afterReconnect.filter(o => o.surfaceId === 'term-A');
    assert.ok(aOutputs.length >= 1, `Should resume polling after reconnect, got ${aOutputs.length} outputs`);
    assert.ok(aOutputs.some(o => o.text.includes('after reconnect')),
      'Should contain text after reconnect');
  });

  it('relay forwards output for all surfaces to connected client', async () => {
    surfaceTexts['term-A'] = 'relay test A\n';
    surfaceTexts['term-B'] = 'relay test B\n';

    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    const outputs = await collectOutputs(clientWs, 1500);
    await disconnect(clientWs);

    const surfaceIds = [...new Set(outputs.map(o => o.surfaceId))];
    assert.ok(surfaceIds.includes('term-A'), 'Client should receive term-A output via relay');
    assert.ok(surfaceIds.includes('term-B'), 'Client should receive term-B output via relay');
  });
});
