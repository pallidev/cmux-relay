import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayConnection } from '../../../packages/agent/src/relay-connection.js';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import { handleClientMessage } from '../../../packages/agent/src/message-handler.js';
import { decodeMessage } from '@cmux-relay/shared';
import type { RelayToAgent, RelayToClient, ClientOutgoing } from '@cmux-relay/shared';

/**
 * Test the full agent → relay → client data flow using a mock relay server.
 * Verifies:
 * 1. Agent registers with relay
 * 2. Agent receives client messages via relay (client.data)
 * 3. Agent processes them through MessageHandler
 * 4. Agent sends responses back through relay (agent.data)
 */
describe('Agent → Relay data flow', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let relayWs: WebSocket | null = null;

  // Messages received by the relay from the agent
  let relayReceived: string[] = [];

  before(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      relayWs = ws;
      relayReceived = [];
      ws.on('message', (raw) => {
        relayReceived.push(raw.toString());
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    relayWs?.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  beforeEach(() => {
    relayReceived = [];
  });

  it('agent registers with relay using token', async () => {
    const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');

    // Simulate relay sending session.created after receiving agent.register
    const sessionPromise = relay.connect();

    // Wait for agent to send agent.register
    await new Promise(r => setTimeout(r, 100));
    const registerMsg = decodeMessage<RelayToAgent>(relayReceived[relayReceived.length - 1] || '{}');

    // Relay responds with session.created
    relayWs!.send(JSON.stringify({ type: 'session.created', sessionId: 'test-session-123' }));

    const sessionId = await sessionPromise;
    assert.equal(sessionId, 'test-session-123');
    assert.equal(registerMsg.type, 'agent.register');

    relay.disconnect();
  });

  it('agent sends data to relay via agent.data', async () => {
    const store = new SessionStore();
    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' }]);

    const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');
    relayWs!.send(JSON.stringify({ type: 'session.created', sessionId: 'flow-test' }));
    await relay.connect();

    // Agent broadcasts workspace data via relay
    relay.send({ type: 'workspaces', payload: { workspaces: store.getAllWorkspaces() } });

    await new Promise(r => setTimeout(r, 50));

    const agentDataMsg = relayReceived
      .map(m => { try { return JSON.parse(m); } catch { return null; } })
      .find((m: any) => m?.type === 'agent.data');

    assert.ok(agentDataMsg, 'Should send agent.data message');
    assert.ok(agentDataMsg.payload);
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

    let agentSent: RelayToClient[] = [];
    const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');

    relay.onClientData(async (msg: ClientOutgoing) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'test-client',
        { store, inputHandler: mockInputHandler },
        (response) => { agentSent.push(response); },
      );
    });

    relayWs!.send(JSON.stringify({ type: 'session.created', sessionId: 'flow-test-2' }));
    await relay.connect();

    // Clear registration messages
    relayReceived = [];

    // Simulate client sending surface.select through relay
    relayWs!.send(JSON.stringify({
      type: 'client.data',
      payload: { type: 'surface.select', surfaceId: 's1' },
    }));

    await new Promise(r => setTimeout(r, 100));

    // Agent should have sent responses back through relay
    const agentDataMessages = relayReceived
      .map(m => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m: any) => m?.type === 'agent.data');

    // Also check the local agentSent array (responses from MessageHandler)
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

    const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');
    relay.onClientData(async (msg: ClientOutgoing) => {
      await handleClientMessage(
        JSON.stringify(msg),
        'test-client',
        { store, inputHandler: mockInputHandler },
        () => {},
      );
    });

    relayWs!.send(JSON.stringify({ type: 'session.created', sessionId: 'input-test' }));
    await relay.connect();

    const inputData = Buffer.from('ls -la\n').toString('base64');
    relayWs!.send(JSON.stringify({
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
    const store = new SessionStore();
    store.updateWorkspaces([{ id: 'ws1', title: 'Test' }]);
    store.updateSurfaces('ws1', [{ id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' }]);

    const relay = new RelayConnection(`ws://127.0.0.1:${port}`, 'test-token');
    relayWs!.send(JSON.stringify({ type: 'session.created', sessionId: 'output-test' }));
    await relay.connect();

    relayReceived = [];

    // Agent sends terminal output through relay
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
