import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import { InputHandler } from '../../../packages/agent/src/input-handler.js';
import { createWSServer } from '../../../packages/agent/src/ws-server.js';
import { encodeMessage, decodeMessage } from '../../../packages/shared/dist/index.js';
import type { ServerDeps } from '../../../packages/agent/src/ws-server.js';
import type { ClientOutgoing } from '../../../packages/shared/dist/index.js';
import { generateToken } from '../../../packages/agent/src/auth.js';

const JWT_SECRET = 'test-jwt-secret-for-ws-server';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

class MockInputHandler {
  handledInputs: { surfaceId: string; data: string }[] = [];
  handleInput(surfaceId: string, data: string): void {
    this.handledInputs.push({ surfaceId, data });
  }
  handleResize(surfaceId: string, cols: number, rows: number): void {}
}

describe('ws-server (local mode)', () => {
  let store: SessionStore;
  let inputHandler: MockInputHandler;
  let server: Awaited<ReturnType<typeof createWSServer>>;
  let port: number;

  before(() => {
    process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;
  });

  after(() => {
    delete process.env.CMUX_RELAY_JWT_SECRET;
  });

  beforeEach(async () => {
    store = new SessionStore();
    inputHandler = new MockInputHandler();
    const deps: ServerDeps = {
      store,
      inputHandler: inputHandler as any,
    };
    port = await getFreePort();
    server = await createWSServer(port, '127.0.0.1', deps, undefined, true);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function wsConnect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function wsMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve) => {
      ws.once('message', (raw) => {
        resolve(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      });
    });
  }

  function collectMessages(ws: WebSocket, count: number, timeout = 2000): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const msgs: string[] = [];
      const timer = setTimeout(() => reject(new Error(`Timeout: got ${msgs.length}/${count}`)), timeout);
      ws.on('message', (raw) => {
        msgs.push(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        if (msgs.length >= count) {
          clearTimeout(timer);
          resolve(msgs);
        }
      });
    });
  }

  describe('HTTP endpoints', () => {
    it('returns mode=local for /api/mode', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/mode`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { mode: 'local' });
    });

    it('issues JWT for /api/local/auth', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/local/auth`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie?.includes('relay_jwt='));
    });
  });

  describe('WebSocket client', () => {
    it('rejects unauthenticated messages', async () => {
      const ws = await wsConnect();
      ws.send(encodeMessage({ type: 'workspaces.list' }));
      const msg = await wsMessage(ws);
      const parsed = JSON.parse(msg);
      assert.equal(parsed.type, 'error');
      assert.ok(parsed.payload.message.includes('Not authenticated'));
      ws.close();
    });

    it('authenticates with valid token', async () => {
      const token = generateToken();
      const ws = await wsConnect();

      const msgs = collectMessages(ws, 1);
      ws.send(encodeMessage({ type: 'auth', payload: { token } }));
      const responses = await msgs;
      const parsed = JSON.parse(responses[0]);
      assert.equal(parsed.type, 'workspaces');
      ws.close();
    });

    it('rejects invalid token', async () => {
      const ws = await wsConnect();
      ws.send(encodeMessage({ type: 'auth', payload: { token: 'invalid' } }));
      const msg = await wsMessage(ws);
      const parsed = JSON.parse(msg);
      assert.equal(parsed.type, 'error');
      ws.close();
    });

    it('responds to workspaces.list after auth', async () => {
      const token = generateToken();
      const ws = await wsConnect();

      // Authenticate first
      const authMsgs = collectMessages(ws, 1);
      ws.send(encodeMessage({ type: 'auth', payload: { token } }));
      await authMsgs;

      // Now request workspaces
      const wsMsgs = collectMessages(ws, 1);
      ws.send(encodeMessage({ type: 'workspaces.list' }));
      const responses = await wsMsgs;
      const parsed = JSON.parse(responses[0]);
      assert.equal(parsed.type, 'workspaces');
      ws.close();
    });

    it('handles input messages', async () => {
      const token = generateToken();
      const ws = await wsConnect();

      const authMsgs = collectMessages(ws, 1);
      ws.send(encodeMessage({ type: 'auth', payload: { token } }));
      await authMsgs;

      // Set up workspace data for surface.select
      store.updateWorkspaces([{ id: 'ws1', name: 'test', is_active: true, is_focused: true, last_activated_at: 0 }]);
      store.updateSurfaces('ws1', [{ id: 's1', name: 'term', type: 'terminal', surface_id: 's1', workspace_id: 'ws1', width: 80, height: 24, active: true, shell: '/bin/zsh' }]);

      ws.send(encodeMessage({ type: 'input', surfaceId: 's1', payload: { data: btoa('ls') } }));
      // No crash = success
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(inputHandler.handledInputs.length, 1);
      assert.equal(inputHandler.handledInputs[0].surfaceId, 's1');
      ws.close();
    });
  });
});
