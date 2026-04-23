/**
 * Integration test for real-time terminal output flow.
 *
 * Sets up a mock cmux Unix socket server that returns changing terminal text,
 * then tests the full pipeline: cmux → pollTerminal → WSServer → WebSocket client.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { SessionStore } from '../packages/agent/src/session-store.js';
import { createWSServer } from '../packages/agent/src/ws-server.js';
import { CmuxClient } from '../packages/agent/src/cmux-client.js';
import { handleClientMessage } from '../packages/agent/src/message-handler.js';
import type { IInputHandler } from '../packages/agent/src/input-handler.js';

const JWT_SECRET = 'test-secret';

function signToken(role: string): string {
  return jwt.sign({ role, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET);
}

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
                // Return different text each call to simulate real-time changes
                readTextCallCount++;
                const text = `Line ${readTextCallCount}: Hello at ${Date.now()}\n`;
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

// ─── Helpers ───

function waitForMessage(ws: WebSocket, type: string, timeout = 5000): Promise<any> {
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

describe('real-time terminal output', () => {
  let cmuxServer: NetServer;
  let httpServer: Server;
  let wsPort: number;
  let store: SessionStore;
  let cmux: CmuxClient;
  let pollInterval: ReturnType<typeof setInterval>;

  before(async () => {
    process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;
    readTextCallCount = 0;

    // 1. Start mock cmux server
    const socketPath = join(tmpdir(), `cmux-realtime-test-${process.pid}.sock`);
    cmuxServer = await createMockCmuxServer(socketPath);

    // 2. Connect CmuxClient
    cmux = new CmuxClient(socketPath);
    await cmux.connect();

    // 3. Populate store with initial data from cmux
    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);

    store = new SessionStore();
    store.updateWorkspaces(workspaces.map(w => ({
      id: w.id, title: w.title,
    })));
    store.updateSurfaces(workspaces[0].id, surfaces.map(s => ({
      id: s.id,
      title: s.title || '',
      type: s.type,
      workspaceId: s.workspace_id,
    })));

    // 4. Start WSServer
    httpServer = await createWSServer(0, '127.0.0.1', {
      store,
      inputHandler: createMockInputHandler(),
      cmux,
    });
    const addr = httpServer.address() as { port: number } | null;
    if (!addr) throw new Error('Server did not bind');
    wsPort = addr.port;

    // 5. Start pollTerminal (100ms for fast test)
    const lastOutput = new Map<string, string>();
    const pollTerminal = async () => {
      try {
        if (!cmux.isConnected()) return;
        const activeIds = store.getActiveSurfaceIds();
        if (activeIds.size === 0) return;

        const wss = await cmux.listWorkspaces();
        for (const w of wss) {
          const surfs = await cmux.listSurfaces(w.id);
          for (const surf of surfs) {
            if (surf.type === 'terminal' && activeIds.has(surf.id)) {
              const text = await cmux.readTerminalText(surf.id);
              if (text) {
                const b64 = Buffer.from(text).toString('base64');
                if (lastOutput.get(surf.id) !== b64) {
                  lastOutput.set(surf.id, b64);
                  store.sendToClientsWithSurface(surf.id, {
                    type: 'output',
                    surfaceId: surf.id,
                    payload: { data: b64 },
                  });
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
    };
    pollInterval = setInterval(pollTerminal, 100);
  });

  after(async () => {
    clearInterval(pollInterval);
    cmux.disconnect();
    await new Promise<void>(r => cmuxServer.close(() => r()));
    await new Promise<void>(r => httpServer.close(() => r()));
    delete process.env.CMUX_RELAY_JWT_SECRET;
  });

  it('client receives multiple output updates after surface.select', async () => {
    const ws = await connect(wsPort);

    // Auth
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');

    // Select surface — this triggers initial output from ws-server
    send(ws, { type: 'surface.select', surfaceId: 'surf1' });
    await waitForMessage(ws, 'surface.active');

    // Initial output from surface.select handler
    const initial = await waitForMessage(ws, 'output', 2000);
    assert.ok(initial.payload.data, 'Should receive initial output');

    const initialText = Buffer.from(initial.payload.data, 'base64').toString();
    console.log('Initial output:', initialText.trim());

    // Now wait for subsequent output from pollTerminal
    // Since mock returns different text each call, we should get updates
    const outputs: string[] = [initialText];

    const collectOutputs = new Promise<string[]>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'output') {
            const text = Buffer.from(msg.payload.data, 'base64').toString();
            outputs.push(text);
            if (outputs.length >= 3) {
              ws.off('message', handler);
              resolve(outputs);
            }
          }
        } catch { /* skip */ }
      };
      ws.on('message', handler);

      // Timeout fallback
      setTimeout(() => {
        ws.off('message', handler);
        resolve(outputs);
      }, 3000);
    });

    const allOutputs = await collectOutputs;
    console.log(`Received ${allOutputs.length} outputs:`, allOutputs.map(t => t.trim()));

    assert.ok(
      allOutputs.length >= 2,
      `Should receive at least 2 distinct outputs (initial + polled), got ${allOutputs.length}`,
    );

    // Verify outputs are different (mock returns different text each call)
    const unique = new Set(allOutputs);
    assert.ok(
      unique.size >= 2,
      `Outputs should be different, but got ${unique.size} unique values`,
    );

    await disconnect(ws);
  });

  it('writeOutput dedup logic: same content blocked, different content passes', () => {
    // Simulate the exact writeOutput logic from Terminal.tsx
    let lastB64 = '';
    const renders: string[] = [];

    const writeOutput = (base64Data: string) => {
      if (base64Data === lastB64) return;
      lastB64 = base64Data;
      const bytes = atob(base64Data);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      );
      renders.push(text);
    };

    // First write: should render
    const text1 = 'Hello World\n';
    writeOutput(Buffer.from(text1).toString('base64'));
    assert.equal(renders.length, 1);
    assert.equal(renders[0], text1);

    // Same content: should be blocked
    writeOutput(Buffer.from(text1).toString('base64'));
    assert.equal(renders.length, 1, 'Same base64 should be deduped');

    // Different content: should render
    const text2 = 'Hello World 2\n';
    writeOutput(Buffer.from(text2).toString('base64'));
    assert.equal(renders.length, 2);
    assert.equal(renders[1], text2);

    // Back to original content: should render (it's different from lastB64)
    writeOutput(Buffer.from(text1).toString('base64'));
    assert.equal(renders.length, 3, 'Going back to old content should still render');
  });

  it('writeOutput handles rapid sequential updates without losing data', () => {
    let lastB64 = '';
    const renders: string[] = [];

    const writeOutput = (base64Data: string) => {
      if (base64Data === lastB64) return;
      lastB64 = base64Data;
      const bytes = atob(base64Data);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      );
      renders.push(text);
    };

    // Simulate rapid updates (like polling every 100ms)
    for (let i = 0; i < 10; i++) {
      const text = `Output ${i}\n`;
      writeOutput(Buffer.from(text).toString('base64'));
    }

    assert.equal(renders.length, 10, 'All unique updates should render');
    assert.equal(renders[9], 'Output 9\n');
  });

  it('agent dedup + client dedup interaction: no output lost', async () => {
    // Simulate both agent-side and client-side dedup
    // Agent only sends when content changes, client only renders when base64 changes

    // Agent-side dedup
    const agentLastOutput = new Map<string, string>();
    const sentByAgent: string[] = [];

    const agentSend = (surfaceId: string, b64: string) => {
      if (agentLastOutput.get(surfaceId) !== b64) {
        agentLastOutput.set(surfaceId, b64);
        sentByAgent.push(b64);
      }
    };

    // Client-side dedup (writeOutput logic)
    let clientLastB64 = '';
    const clientRenders: string[] = [];

    const clientReceive = (b64: string) => {
      if (b64 === clientLastB64) return;
      clientLastB64 = b64;
      const bytes = atob(b64);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      );
      clientRenders.push(text);
    };

    // Simulate 20 polls with alternating: same, same, change, same, change...
    const screens = [
      'Screen A\n', 'Screen A\n', 'Screen B\n',
      'Screen B\n', 'Screen B\n', 'Screen C\n',
      'Screen C\n', 'Screen D\n', 'Screen D\n',
    ];

    for (const screen of screens) {
      const b64 = Buffer.from(screen).toString('base64');
      agentSend('surf1', b64);
    }

    // Agent should have sent 4 unique screens (A, B, C, D)
    assert.equal(sentByAgent.length, 4, 'Agent should send only changed screens');

    // Client receives all agent sends
    for (const b64 of sentByAgent) {
      clientReceive(b64);
    }

    // Client should have rendered all 4
    assert.equal(clientRenders.length, 4, 'Client should render all agent-sent screens');
    assert.deepEqual(clientRenders, ['Screen A\n', 'Screen B\n', 'Screen C\n', 'Screen D\n']);
  });
});

// ─── Cloud mode (message-handler) tests ───

describe('cloud mode real-time output via message-handler', () => {
  let cmuxServer: NetServer;
  let httpServer: Server;
  let wsPort: number;
  let store: SessionStore;
  let cmux: CmuxClient;
  let pollInterval: ReturnType<typeof setInterval>;
  const cloudActiveSurfaceIdRef = { current: null as string | null };

  // Simulates a running counter script in terminal
  let counterValue = 0;

  before(async () => {
    process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;
    counterValue = 0;

    // Mock cmux: returns screen with incrementing counter
    const socketPath = join(tmpdir(), `cmux-cloud-test-${process.pid}.sock`);
    cmuxServer = await new Promise<NetServer>((resolve, reject) => {
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
                  result = { surfaces: [{ id: 'surf1', title: 'term', type: 'terminal', workspace_id: 'ws1' }] };
                  break;
                case 'surface.read_text': {
                  // Counter increments each call — simulates real-time script output
                  counterValue++;
                  const text = `$ counter\nCounter: ${counterValue}\n$ _`;
                  result = { base64: Buffer.from(text).toString('base64') };
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
      server.listen(socketPath, () => resolve(server));
      server.on('error', reject);
    });

    cmux = new CmuxClient(socketPath);
    await cmux.connect();

    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);

    store = new SessionStore();
    store.updateWorkspaces(workspaces.map(w => ({ id: w.id, title: w.title })));
    store.updateSurfaces(workspaces[0].id, surfaces.map(s => ({
      id: s.id, title: s.title || '', type: s.type, workspaceId: s.workspace_id,
    })));

    httpServer = await createWSServer(0, '127.0.0.1', {
      store,
      inputHandler: createMockInputHandler(),
      cmux,
    });
    const addr = httpServer.address() as { port: number } | null;
    if (!addr) throw new Error('Server did not bind');
    wsPort = addr.port;

    // Start pollTerminal at 100ms — mirrors cloud mode logic (cloudActiveSurfaceId)
    const lastOutput = new Map<string, string>();
    const pollTerminal = async () => {
      try {
        if (!cmux.isConnected()) return;
        if (!cloudActiveSurfaceIdRef.current) return;
        const text = await cmux.readTerminalText(cloudActiveSurfaceIdRef.current);
        if (text) {
          const b64 = Buffer.from(text).toString('base64');
          if (lastOutput.get(cloudActiveSurfaceIdRef.current) !== b64) {
            lastOutput.set(cloudActiveSurfaceIdRef.current, b64);
            store.sendToClientsWithSurface(cloudActiveSurfaceIdRef.current, {
              type: 'output', surfaceId: cloudActiveSurfaceIdRef.current, payload: { data: b64 },
            });
          }
        }
      } catch { /* ignore */ }
    };
    pollInterval = setInterval(pollTerminal, 100);
  });

  after(async () => {
    clearInterval(pollInterval);
    cmux.disconnect();
    await new Promise<void>(r => cmuxServer.close(() => r()));
    await new Promise<void>(r => httpServer.close(() => r()));
    delete process.env.CMUX_RELAY_JWT_SECRET;
  });

  it('cloud mode: message-handler sends visible screen only (no scrollback)', async () => {
    const sendBuffer: unknown[] = [];
    const send = (msg: unknown) => {
      sendBuffer.push(msg);
      // Track active surface for poll (same as cloud mode in index.ts)
      if ((msg as any).type === 'surface.active') {
        cloudActiveSurfaceIdRef.current = (msg as any).surfaceId;
      }
    };

    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 'surf1', title: 't', type: 'terminal', workspaceId: 'ws1' }]);

    await handleClientMessage(
      JSON.stringify({ type: 'surface.select', surfaceId: 'surf1' }),
      'test-client',
      { store, inputHandler: createMockInputHandler(), cmux },
      send,
    );

    // Find output message
    const outputMsg = sendBuffer.find((m: any) => (m as any).type === 'output') as any;
    assert.ok(outputMsg, 'Should send output message');

    const text = Buffer.from(outputMsg.payload.data, 'base64').toString();
    console.log('Cloud mode initial output:', text.trim(), `(${text.length} chars)`);

    assert.ok(text.length < 10000, `Output should be small (< 10KB), got ${text.length} chars`);
    assert.ok(text.includes('Counter:'), 'Should contain counter output');
  });

  it('real-time script: client sees incrementing counter values', async () => {
    const ws = await connect(wsPort);
    send(ws, { type: 'auth', payload: { token: signToken('client') } });
    await waitForMessage(ws, 'workspaces');
    send(ws, { type: 'surface.select', surfaceId: 'surf1' });
    await waitForMessage(ws, 'surface.active');

    // Collect outputs for 3 seconds
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
      ws.on('message', handler);
      setTimeout(() => { ws.off('message', handler); resolve(); }, 3000);
    });

    await collectDone;
    await disconnect(ws);

    console.log(`Real-time script: ${outputs.length} outputs received`);
    for (const o of outputs.slice(0, 5)) {
      console.log('  ', o.trim().slice(0, 60));
    }

    assert.ok(outputs.length >= 3, `Should receive at least 3 outputs, got ${outputs.length}`);

    // Extract counter values and verify they increment
    const counterValues = outputs.map(o => {
      const match = o.match(/Counter: (\d+)/);
      return match ? parseInt(match[1]) : null;
    }).filter((v): v is number => v !== null);

    console.log('Counter values:', counterValues);

    assert.ok(counterValues.length >= 2, 'Should have at least 2 counter values');
    // Verify values are different (terminal content is changing)
    const uniqueValues = new Set(counterValues);
    assert.ok(uniqueValues.size >= 2, `Counter should change over time, got values: ${[...uniqueValues]}`);
  });
});
