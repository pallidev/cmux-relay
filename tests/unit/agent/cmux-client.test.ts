import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmuxClient } from '../../../packages/agent/src/cmux-client.js';

/**
 * Creates a mock JSON-RPC Unix socket server for testing.
 */
function createMockServer(
  socketPath: string,
  handler?: (req: any, respond: (result: unknown) => void) => void,
): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('connection', (sock: Socket) => {
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const req = JSON.parse(line);
            if (handler) {
              handler(req, (result) => {
                sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
              });
            } else {
              // Default handler
              sock.write(JSON.stringify({
                id: req.id,
                ok: true,
                result: { workspaces: [{ id: 'ws1', title: 'Test', index: 0 }] },
              }) + '\n');
            }
          } catch { /* skip malformed lines */ }
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
    server.on('error', reject);
  });
}

describe('CmuxClient', () => {
  const socketPath = join(tmpdir(), `cmux-unit-test-${process.pid}.sock`);
  let mockServer: NetServer;
  let client: CmuxClient;

  before(async () => {
    mockServer = await createMockServer(socketPath);
  });

  after(async () => {
    client?.disconnect();
    // Close all server connections before closing server
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  // ─── Connection state ───

  describe('connection state', () => {
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

    it('transitions to disconnected on disconnect', () => {
      client.disconnect();
      assert.equal(client.state, 'disconnected');
      assert.equal(client.isConnected(), false);
    });

    it('rejects requests when disconnected', async () => {
      client.disconnect();
      await assert.rejects(
        () => client.listWorkspaces(),
        { message: 'Not connected to cmux' },
      );
    });
  });

  // ─── JSON-RPC methods ───

  describe('JSON-RPC methods', () => {
    beforeEach(async () => {
      client = new CmuxClient(socketPath);
      await client.connect();
    });

    afterEach(() => {
      client?.disconnect();
    });

    it('listWorkspaces returns workspaces from server', async () => {
      // Default handler returns one workspace
      const workspaces = await client.listWorkspaces();
      assert.equal(workspaces.length, 1);
      assert.equal(workspaces[0].id, 'ws1');
      assert.equal(workspaces[0].title, 'Test');
    });

    it('listSurfaces returns surfaces', async () => {
      // Override handler for this test — need a separate server
      const surfSocket = join(tmpdir(), `cmux-surf-test-${Date.now()}.sock`);
      const surfServer = await createMockServer(surfSocket, (req, respond) => {
        if (req.method === 'surface.list') {
          respond({
            surfaces: [
              { id: 's1', title: 'Term', type: 'terminal', workspace_id: 'ws1' },
              { id: 's2', title: 'Browse', type: 'browser', workspace_id: 'ws1' },
            ],
          });
        } else {
          respond({});
        }
      });

      const c = new CmuxClient(surfSocket);
      await c.connect();
      try {
        const surfaces = await c.listSurfaces('ws1');
        assert.equal(surfaces.length, 2);
        assert.equal(surfaces[0].id, 's1');
        assert.equal(surfaces[1].type, 'browser');
      } finally {
        c.disconnect();
        await new Promise<void>(r => surfServer.close(() => r()));
      }
    });

    it('listPanes returns panes and containerFrame', async () => {
      const paneSocket = join(tmpdir(), `cmux-pane-test-${Date.now()}.sock`);
      const paneServer = await createMockServer(paneSocket, (req, respond) => {
        if (req.method === 'pane.list') {
          respond({
            panes: [
              {
                id: 'pane-1',
                index: 0,
                surface_ids: ['s1', 's2'],
                selected_surface_id: 's1',
                columns: 120,
                rows: 40,
                cell_width_px: 10,
                cell_height_px: 20,
                pixel_frame: { x: 0, y: 0, width: 1200, height: 800 },
                focused: true,
              },
            ],
            container_frame: { width: 1920, height: 1080 },
            workspace_id: 'ws1',
          });
        } else {
          respond({});
        }
      });

      const c = new CmuxClient(paneSocket);
      await c.connect();
      try {
        const result = await c.listPanes('ws1');
        assert.equal(result.panes.length, 1);
        assert.equal(result.panes[0].id, 'pane-1');
        assert.deepEqual(result.panes[0].surfaceIds, ['s1', 's2']);
        assert.equal(result.panes[0].selectedSurfaceId, 's1');
        assert.equal(result.panes[0].columns, 120);
        assert.equal(result.panes[0].rows, 40);
        assert.equal(result.panes[0].focused, true);
        assert.equal(result.panes[0].workspaceId, 'ws1');
        assert.deepEqual(result.containerFrame, { x: 0, y: 0, width: 1920, height: 1080 });
      } finally {
        c.disconnect();
        await new Promise<void>(r => paneServer.close(() => r()));
      }
    });

    it('readTerminalText returns decoded text', async () => {
      const textSocket = join(tmpdir(), `cmux-text-test-${Date.now()}.sock`);
      const encodedText = Buffer.from('Hello from terminal').toString('base64');
      let callCount = 0;
      const textServer = await createMockServer(textSocket, (req, respond) => {
        if (req.method === 'surface.read_text') {
          callCount++;
          if (callCount === 1 && req.params?.ansi === true) {
            // First call with ansi=true succeeds
            respond({ base64: encodedText });
          } else {
            respond({ base64: encodedText });
          }
        } else {
          respond({});
        }
      });

      const c = new CmuxClient(textSocket);
      await c.connect();
      try {
        const text = await c.readTerminalText('s1');
        assert.equal(text, 'Hello from terminal');
      } finally {
        c.disconnect();
        await new Promise<void>(r => textServer.close(() => r()));
      }
    });

    it('readTerminalText with scrollback passes scrollback param', async () => {
      const textSocket = join(tmpdir(), `cmux-scroll-test-${Date.now()}.sock`);
      let receivedParams: any = null;
      const textServer = await createMockServer(textSocket, (req, respond) => {
        if (req.method === 'surface.read_text') {
          receivedParams = req.params;
          respond({ base64: Buffer.from('scrollback text').toString('base64') });
        } else {
          respond({});
        }
      });

      const c = new CmuxClient(textSocket);
      await c.connect();
      try {
        await c.readTerminalText('s1', true);
        assert.ok(receivedParams);
        assert.equal(receivedParams.scrollback, true);
        assert.equal(receivedParams.surface_id, 's1');
      } finally {
        c.disconnect();
        await new Promise<void>(r => textServer.close(() => r()));
      }
    });

    it('sendText sends correct RPC', async () => {
      const sendSocket = join(tmpdir(), `cmux-send-test-${Date.now()}.sock`);
      let receivedReqs: any[] = [];
      const sendServer = await createMockServer(sendSocket, (req, respond) => {
        receivedReqs.push(req);
        respond({});
      });

      const c = new CmuxClient(sendSocket);
      await c.connect();
      try {
        await c.sendText('s1', 'ls -la\n');
        assert.equal(receivedReqs.length, 1);
        assert.equal(receivedReqs[0].method, 'surface.send_text');
        assert.equal(receivedReqs[0].params.surface_id, 's1');
        assert.equal(receivedReqs[0].params.text, 'ls -la\n');
      } finally {
        c.disconnect();
        await new Promise<void>(r => sendServer.close(() => r()));
      }
    });

    it('sendKey sends correct RPC', async () => {
      const keySocket = join(tmpdir(), `cmux-key-test-${Date.now()}.sock`);
      let receivedReqs: any[] = [];
      const keyServer = await createMockServer(keySocket, (req, respond) => {
        receivedReqs.push(req);
        respond({});
      });

      const c = new CmuxClient(keySocket);
      await c.connect();
      try {
        await c.sendKey('s1', 'Enter');
        assert.equal(receivedReqs.length, 1);
        assert.equal(receivedReqs[0].method, 'surface.send_key');
        assert.equal(receivedReqs[0].params.surface_id, 's1');
        assert.equal(receivedReqs[0].params.key, 'Enter');
      } finally {
        c.disconnect();
        await new Promise<void>(r => keyServer.close(() => r()));
      }
    });

    it('listNotifications returns mapped notifications', async () => {
      const notifSocket = join(tmpdir(), `cmux-notif-test-${Date.now()}.sock`);
      const notifServer = await createMockServer(notifSocket, (req, respond) => {
        if (req.method === 'notification.list') {
          respond({
            notifications: [
              {
                id: 'n1',
                title: 'Alert',
                subtitle: 'Sub',
                body: 'Body text',
                surface_id: 's1',
                workspace_id: 'ws1',
                is_read: false,
              },
            ],
          });
        } else {
          respond({});
        }
      });

      const c = new CmuxClient(notifSocket);
      await c.connect();
      try {
        const notifs = await c.listNotifications();
        assert.equal(notifs.length, 1);
        assert.equal(notifs[0].id, 'n1');
        assert.equal(notifs[0].title, 'Alert');
        assert.equal(notifs[0].subtitle, 'Sub');
        assert.equal(notifs[0].body, 'Body text');
        assert.equal(notifs[0].surfaceId, 's1');
        assert.equal(notifs[0].workspaceId, 'ws1');
        assert.equal(notifs[0].isRead, false);
      } finally {
        c.disconnect();
        await new Promise<void>(r => notifServer.close(() => r()));
      }
    });
  });

  // ─── Disconnect behavior ───

  describe('disconnect behavior', () => {
    it('fires onDisconnected callback when server closes connection', async () => {
      let disconnectedCalled = false;
      const discSocket = join(tmpdir(), `cmux-disc-test-${Date.now()}.sock`);
      const serverSockets: Socket[] = [];
      const discServer = createNetServer();
      discServer.on('connection', (sock) => {
        serverSockets.push(sock);
      });
      await new Promise<void>(r => discServer.listen(discSocket, r));

      const c = new CmuxClient(discSocket);
      await c.connect(() => { disconnectedCalled = true; });
      assert.equal(c.state, 'connected');

      // Wait a bit for connection to establish
      await new Promise(r => setTimeout(r, 50));

      // Destroy server-side socket
      for (const s of serverSockets) s.destroy();

      await new Promise(r => setTimeout(r, 200));
      assert.equal(c.state, 'disconnected');
      assert.equal(disconnectedCalled, true);

      c.disconnect();
      await new Promise<void>(r => discServer.close(() => r()));
    });

    it('reconnects after disconnect', async () => {
      const reconSocket = join(tmpdir(), `cmux-recon-test-${Date.now()}.sock`);
      const reconServer = await createMockServer(reconSocket);

      const c = new CmuxClient(reconSocket);
      await c.connect();
      assert.equal(c.state, 'connected');

      c.disconnect();
      assert.equal(c.state, 'disconnected');

      await c.connect();
      assert.equal(c.state, 'connected');

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
});
