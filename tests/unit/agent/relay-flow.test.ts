import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayConnection } from '../../../packages/agent/src/relay-connection.js';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import { handleClientMessage } from '../../../packages/agent/src/message-handler.js';
import { decodeMessage } from '../../../packages/shared/dist/index.js';
import type { RelayToAgent, RelayToClient, ClientOutgoing } from '../../../packages/shared/dist/index.js';

/**
 * Test the full agent → relay → client data flow using a mock relay server.
 */
describe('Agent → Relay data flow', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let activeWs: WebSocket | null = null;
  let relayReceived: string[] = [];

  /** Connect a relay and complete handshake. Ensures session.created goes to the right socket. */
  function connectRelay(sessionId: string): Promise<RelayConnection> {
    return new Promise((resolve, reject) => {
      const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');

      const onConnection = (ws: WebSocket) => {
        activeWs = ws;
        relayReceived = [];
        ws.on('message', (raw) => {
          relayReceived.push(raw.toString());
        });
        // Wait for agent.register, then respond
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'session.created', sessionId }));
        });
        wss.off('connection', onConnection);
      };
      wss.on('connection', onConnection);

      relay.connect().then(() => resolve(relay)).catch(reject);
    });
  }

  before(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    activeWs?.close();
    await new Promise<void>(r => httpServer.close(() => r()));
  });

  beforeEach(() => {
    relayReceived = [];
  });

  it('agent registers with relay using token', async () => {
    const relay = await connectRelay('test-session-123');

    const registerMsg = decodeMessage<RelayToAgent>(relayReceived[0] || '{}');
    assert.equal(registerMsg.type, 'agent.register');

    relay.disconnect();
  });

  it('agent sends data to relay via agent.data', async () => {
    const store = new SessionStore();
    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' }]);

    const relay = await connectRelay('flow-test');
    relayReceived = [];

    relay.send({ type: 'workspaces', payload: { workspaces: store.getAllWorkspaces() } });

    await new Promise(r => setTimeout(r, 50));

    const agentDataMsg = relayReceived
      .map(m => { try { return JSON.parse(m); } catch { return null; } })
      .find((m: any) => m?.type === 'agent.data');

    assert.ok(agentDataMsg, 'Should send agent.data message');
    assert.equal(agentDataMsg.payload.type, 'workspaces');
    assert.equal(agentDataMsg.payload.payload.workspaces[0].id, 'ws1');

    relay.disconnect();
  });

  it('agent receives client.data and processes via MessageHandler', async () => {
    const store = new SessionStore();
    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' }]);

    const inputs: Array<{ surfaceId: string; data: string }> = [];
    const mockInputHandler = {
      async handleInput(surfaceId: string, data: string) { inputs.push({ surfaceId, data }); },
      async handleResize() {},
    };

    const agentSent: RelayToClient[] = [];
    const relay = await connectRelay('flow-test-2');

    relay.onClientData(async (msg: ClientOutgoing) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'test-client',
        { store, inputHandler: mockInputHandler },
        (response) => { agentSent.push(response); },
      );
    });

    relayReceived = [];

    activeWs!.send(JSON.stringify({
      type: 'client.data',
      payload: { type: 'surface.select', surfaceId: 's1' },
    }));

    await new Promise(r => setTimeout(r, 100));

    assert.ok(agentSent.length > 0, 'MessageHandler should produce responses');

    const surfaceActive = agentSent.find(m => m.type === 'surface.active');
    assert.ok(surfaceActive, 'Should include surface.active');
    assert.equal(surfaceActive.surfaceId, 's1');
    assert.equal(surfaceActive.workspaceId, 'ws1');

    const surfacesMsg = agentSent.find(m => m.type === 'surfaces');
    assert.ok(surfacesMsg, 'Should include surfaces for workspace');

    relay.disconnect();
  });

  it('agent forwards input from client to InputHandler', async () => {
    const store = new SessionStore();
    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' }]);

    const inputs: Array<{ surfaceId: string; data: string }> = [];
    const mockInputHandler = {
      async handleInput(surfaceId: string, data: string) { inputs.push({ surfaceId, data }); },
      async handleResize() {},
    };

    const relay = await connectRelay('input-test');

    relay.onClientData(async (msg: ClientOutgoing) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'test-client',
        { store, inputHandler: mockInputHandler },
        () => {},
      );
    });

    const inputData = Buffer.from('ls -la\n').toString('base64');
    activeWs!.send(JSON.stringify({
      type: 'client.data',
      payload: { type: 'input', surfaceId: 's1', payload: { data: inputData } },
    }));

    await new Promise(r => setTimeout(r, 100));
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].surfaceId, 's1');
    assert.equal(inputs[0].data, inputData);

    relay.disconnect();
  });

  it('agent sends output data through relay to client', async () => {
    const relay = await connectRelay('output-test');
    relayReceived = [];

    const outputData = Buffer.from('Hello from terminal').toString('base64');
    relay.send({
      type: 'output',
      surfaceId: 's1',
      payload: { data: outputData },
    });

    await new Promise(r => setTimeout(r, 50));

    const agentDataMsg = relayReceived
      .map(m => { try { return JSON.parse(m); } catch { return null; } })
      .find((m: any) => m?.type === 'agent.data');

    assert.ok(agentDataMsg);
    assert.equal(agentDataMsg.payload.type, 'output');
    assert.equal(agentDataMsg.payload.surfaceId, 's1');
    assert.equal(agentDataMsg.payload.payload.data, outputData);

    relay.disconnect();
  });
});
