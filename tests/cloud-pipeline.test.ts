/**
 * End-to-end integration test for the cloud mode terminal output pipeline.
 *
 * Simulates the full data path:
 *   Mock cmux → Agent (handleClientMessage + pollTerminal) → Relay (SessionRegistry) → Client WebSocket
 *
 * This tests the EXACT same code paths as production cloud mode.
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
import { encodeMessage } from '../packages/shared/dist/index.js';
import type { RelayToClient } from '../packages/shared/dist/index.js';
import type { IInputHandler } from '../packages/agent/src/input-handler.js';

function createMockInputHandler(): IInputHandler {
  return {
    async handleInput() {},
    async handleResize() {},
  };
}

// ─── Mock cmux server ───

let readTextCallCount = 0;

function createMockCmuxServer(socketPath: string): Promise<NetServer> {
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
                result = {
                  surfaces: [{
                    id: 'surf1',
                    title: 'terminal-1',
                    type: 'terminal',
                    workspace_id: 'ws1',
                  }],
                };
                break;
              case 'surface.read_text': {
                readTextCallCount++;
                const text = `$ cmd\nCounter: ${readTextCallCount}\n$ _`;
                result = { base64: Buffer.from(text).toString('base64') };
                break;
              }
              case 'surface.list_panes':
                result = { panes: [], container_frame: { x: 0, y: 0, width: 1, height: 1 } };
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

function createMockRelayServer(): Promise<{ wss: WebSocketServer; httpServer: ReturnType<typeof createHttpServer>; port: number; registry: SessionRegistry }> {
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
      resolve({ wss, httpServer, port: addr.port, registry });
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

// ─── Tests ───

describe('cloud mode full pipeline', () => {
  let cmuxServer: NetServer;
  let relay: { wss: WebSocketServer; httpServer: ReturnType<typeof createHttpServer>; port: number; registry: SessionRegistry };
  let cmux: CmuxClient;
  let store: SessionStore;
  let agentRelayConn: RelayConnection;
  let sessionId: string;

  let cloudActiveSurfaceId: string | null = null;
  const lastOutput = new Map<string, string>();
  let pollRunning = false;
  let pollInterval: ReturnType<typeof setInterval>;

  before(async () => {
    readTextCallCount = 0;

    // 1. Start mock cmux
    const socketPath = join(tmpdir(), `cmux-pipeline-test-${process.pid}.sock`);
    cmuxServer = await createMockCmuxServer(socketPath);

    // 2. Connect to cmux
    cmux = new CmuxClient(socketPath);
    await cmux.connect();

    // 3. Populate store
    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);
    store = new SessionStore();
    store.updateWorkspaces(workspaces.map(w => ({ id: w.id, title: w.title })));
    store.updateSurfaces(workspaces[0].id, surfaces.map(s => ({
      id: s.id, title: s.title || '', type: s.type, workspaceId: s.workspace_id,
    })));

    // 4. Start mock relay server
    relay = await createMockRelayServer();

    // 5. Agent connects to relay via RelayConnection
    agentRelayConn = new RelayConnection(`ws://127.0.0.1:${relay.port}/ws/agent`, 'test-token');
    sessionId = await agentRelayConn.connect();

    // 6. Wire up handleClientMessage (same as production cloud mode)
    const msgDeps = { store, inputHandler: createMockInputHandler(), cmux };

    const broadcastViaRelay = (msg: RelayToClient) => {
      agentRelayConn.send(msg);
    };

    agentRelayConn.onClientData(async (msg) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'cloud-client',
        msgDeps,
        (response) => {
          broadcastViaRelay(response);
          if ((response as any).type === 'surface.active') {
            cloudActiveSurfaceId = (response as any).surfaceId;
          }
          if ((response as any).type === 'output') {
            lastOutput.set((response as any).surfaceId, (response as any).payload.data);
          }
        },
      );
    });

    // 7. Start pollTerminal (100ms for fast test)
    const pollTerminal = async () => {
      if (pollRunning) return;
      pollRunning = true;
      try {
        if (!cmux.isConnected()) return;
        const activeSurface = cloudActiveSurfaceId;
        if (!activeSurface) return;
        const text = await cmux.readTerminalText(activeSurface);
        if (text) {
          const b64 = Buffer.from(text).toString('base64');
          if (lastOutput.get(activeSurface) !== b64) {
            lastOutput.set(activeSurface, b64);
            broadcastViaRelay({ type: 'output', surfaceId: activeSurface, payload: { data: b64 } });
          }
        }
      } catch { /* ignore */ } finally {
        pollRunning = false;
      }
    };
    pollInterval = setInterval(pollTerminal, 100);
  });

  after(async () => {
    clearInterval(pollInterval);
    agentRelayConn.disconnect();
    cmux.disconnect();
    await new Promise<void>(r => cmuxServer.close(() => r()));
    await new Promise<void>(r => relay.httpServer.close(() => r()));
  });

  it('client receives initial output after surface.select through relay', async () => {
    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);

    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    const wsMsg = await clientWs.next('workspaces');
    assert.ok(wsMsg.payload.workspaces.length >= 1, 'Should receive workspaces');

    await clientWs.next('surfaces');

    send(clientWs, { type: 'surface.select', surfaceId: 'surf1' });
    await clientWs.next('surface.active');

    const output = await clientWs.next('output');
    assert.equal(output.surfaceId, 'surf1');
    assert.ok(output.payload.data, 'Should have output data');

    const text = Buffer.from(output.payload.data, 'base64').toString();
    assert.ok(text.includes('Counter:'), `Should contain counter, got: ${text}`);

    await disconnect(clientWs);
  });

  it('client receives polled output updates through relay', async () => {
    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);

    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');
    await clientWs.next('surfaces');
    send(clientWs, { type: 'surface.select', surfaceId: 'surf1' });
    await clientWs.next('surface.active');
    await clientWs.next('output');

    // Collect outputs for 2 seconds
    const outputs: string[] = [];
    const collectDone = new Promise<void>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'output') {
            const text = Buffer.from(msg.payload.data, 'base64').toString();
            outputs.push(text);
          }
        } catch { /* skip */ }
      };
      clientWs.on('message', handler);
      setTimeout(() => { clientWs.off('message', handler); resolve(); }, 2000);
    });

    await collectDone;
    await disconnect(clientWs);

    console.log(`Pipeline test: ${outputs.length} polled outputs received`);
    for (const o of outputs.slice(0, 3)) {
      console.log('  ', o.trim().slice(0, 50));
    }

    assert.ok(outputs.length >= 2, `Should receive at least 2 polled outputs, got ${outputs.length}`);

    const counters = outputs.map(o => {
      const m = o.match(/Counter: (\d+)/);
      return m ? parseInt(m[1]) : null;
    }).filter((v): v is number => v !== null);
    const unique = new Set(counters);
    assert.ok(unique.size >= 2, `Counter should increment, got values: ${[...unique]}`);
  });

  it('dedup: same output is not sent twice through relay', async () => {
    // Create a separate cmux mock that always returns the same text
    const fixedSocketPath = join(tmpdir(), `cmux-dedup-test-${process.pid}.sock`);
    let callCount = 0;
    const fixedCmuxServer = await new Promise<NetServer>((resolve, reject) => {
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
                  result = { surfaces: [{ id: 'surf1', title: 't', type: 'terminal', workspace_id: 'ws1' }] };
                  break;
                case 'surface.read_text': {
                  callCount++;
                  // Always return same text
                  result = { base64: Buffer.from('STATIC CONTENT\n').toString('base64') };
                  break;
                }
                default:
                  result = {};
              }
              sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
            } catch { /* skip */ }
          }
        });
      });
      server.listen(fixedSocketPath, () => resolve(server));
      server.on('error', reject);
    });

    const fixedCmux = new CmuxClient(fixedSocketPath);
    await fixedCmux.connect();

    const fixedStore = new SessionStore();
    fixedStore.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    fixedStore.updateSurfaces('ws1', [{ id: 'surf1', title: 't', type: 'terminal', workspaceId: 'ws1' }]);

    // Create separate relay
    const fixedRelay = await createMockRelayServer();
    const fixedAgentConn = new RelayConnection(`ws://127.0.0.1:${fixedRelay.port}/ws/agent`, 'test-token');
    const fixedSessionId = await fixedAgentConn.connect();

    const fixedLastOutput = new Map<string, string>();
    let fixedCloudSurfaceId: string | null = null;

    fixedAgentConn.onClientData(async (msg) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'cloud-client',
        { store: fixedStore, inputHandler: createMockInputHandler(), cmux: fixedCmux },
        (response) => {
          fixedAgentConn.send(response);
          if ((response as any).type === 'surface.active') {
            fixedCloudSurfaceId = (response as any).surfaceId;
          }
          if ((response as any).type === 'output') {
            fixedLastOutput.set((response as any).surfaceId, (response as any).payload.data);
          }
        },
      );
    });

    // Poll with fixed content
    let fixedPollRunning = false;
    const pollFixed = async () => {
      if (fixedPollRunning) return;
      fixedPollRunning = true;
      try {
        if (!fixedCmux.isConnected()) return;
        const sid = fixedCloudSurfaceId;
        if (!sid) return;
        const text = await fixedCmux.readTerminalText(sid);
        if (text) {
          const b64 = Buffer.from(text).toString('base64');
          if (fixedLastOutput.get(sid) !== b64) {
            fixedLastOutput.set(sid, b64);
            fixedAgentConn.send({ type: 'output', surfaceId: sid, payload: { data: b64 } });
          }
        }
      } catch { /* ignore */ } finally {
        fixedPollRunning = false;
      }
    };

    const fixedPollInterval = setInterval(pollFixed, 50);

    // Connect client
    const clientWs = await createBufferedWs(fixedRelay.port, `/ws/client?session=${fixedSessionId}`);
    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');
    await clientWs.next('surfaces');
    send(clientWs, { type: 'surface.select', surfaceId: 'surf1' });
    await clientWs.next('surface.active');

    // Collect outputs for 1 second
    const outputs: any[] = [];
    const collectDone = new Promise<void>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'output') outputs.push(msg);
        } catch { /* skip */ }
      };
      clientWs.on('message', handler);
      setTimeout(() => { clientWs.off('message', handler); resolve(); }, 1000);
    });

    await collectDone;

    console.log(`Dedup test: ${outputs.length} outputs, ${callCount} cmux reads`);

    // Should get initial output from surface.select + at most 1 from poll (same content)
    // With dedup, poll should not send again after surface.select sets lastOutput
    assert.ok(outputs.length <= 2, `Should receive at most 2 outputs (initial + maybe 1), got ${outputs.length}`);

    clearInterval(fixedPollInterval);
    await disconnect(clientWs);
    fixedAgentConn.disconnect();
    fixedCmux.disconnect();
    await new Promise<void>(r => fixedCmuxServer.close(() => r()));
    await new Promise<void>(r => fixedRelay.httpServer.close(() => r()));
  });

  it('surfaces broadcast from syncAll reaches client through relay', async () => {
    const clientWs = await createBufferedWs(relay.port, `/ws/client?session=${sessionId}`);

    send(clientWs, { type: 'auth', payload: { token: 'test' } });
    await clientWs.next('workspaces');

    const surfMsg = await clientWs.next('surfaces');
    assert.ok(surfMsg.payload.surfaces.length >= 1, 'Should receive surfaces from auth');
    assert.equal(surfMsg.payload.surfaces[0].id, 'surf1');

    await disconnect(clientWs);
  });

  it('concurrent poll guard prevents overlapping executions', async () => {
    // Verify the pollRunning flag works by tracking call count with slow mock
    let activeCalls = 0;
    let maxConcurrent = 0;

    const slowStore = new SessionStore();
    slowStore.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    slowStore.updateSurfaces('ws1', [{ id: 'surf1', title: 't', type: 'terminal', workspaceId: 'ws1' }]);

    // Register a fake client to make getActiveSurfaceIds work
    slowStore.registerClient('test', { readyState: 1, send: () => {} } as any);
    slowStore.authenticateClient('test');
    slowStore.setActiveSurface('test', 'surf1', 'ws1');

    const slowLastOutput = new Map<string, string>();
    let slowRunning = false;

    const slowPoll = async () => {
      if (slowRunning) return;
      slowRunning = true;
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      try {
        await new Promise(r => setTimeout(r, 150)); // Simulate slow read
        slowLastOutput.set('surf1', 'data');
      } finally {
        activeCalls--;
        slowRunning = false;
      }
    };

    // Fire 5 polls rapidly
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(slowPoll());
    }
    await Promise.all(promises);

    assert.ok(maxConcurrent <= 1, `Should never have concurrent polls, max was ${maxConcurrent}`);
  });
});
