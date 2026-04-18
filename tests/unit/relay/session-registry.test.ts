import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../../../packages/relay/src/session-registry.js';
import { MockWebSocket } from '../../helpers/mock-ws.js';

function mockReq(overrides?: { headers?: Record<string, string>; remoteAddress?: string }) {
  return {
    headers: overrides?.headers ?? {},
    socket: { remoteAddress: overrides?.remoteAddress ?? '127.0.0.1' },
  } as any;
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  it('registerAgent creates session and sends session.created', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    // sessionId should be a 16-char hex string (randomBytes(8).toString('hex'))
    assert.match(sessionId, /^[0-9a-f]{16}$/);

    // Agent should receive session.created message
    const msgs = agentWs.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'session.created');
    assert.equal((msgs[0] as any).sessionId, sessionId);
  });

  it('connectClient adds client to existing session', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);
    agentWs.clear();

    const clientWs = new MockWebSocket();
    const result = registry.connectClient(sessionId, clientWs as any, mockReq());

    assert.equal(result, true);

    // Agent should be notified of client.connected
    const msgs = agentWs.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'client.connected');
  });

  it('connectClient returns false for non-existent session', () => {
    const clientWs = new MockWebSocket();
    const result = registry.connectClient('nonexistent', clientWs as any, mockReq());

    assert.equal(result, false);
  });

  it('disconnectClient removes client and notifies agent', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);
    agentWs.clear();

    const clientWs = new MockWebSocket();
    registry.connectClient(sessionId, clientWs as any, mockReq());
    agentWs.clear();

    registry.disconnectClient(clientWs as any);

    // Agent should be notified of client.disconnected
    const msgs = agentWs.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'client.disconnected');
  });

  it('disconnectClient is no-op for unknown ws', () => {
    const unknownWs = new MockWebSocket();
    // Should not throw
    registry.disconnectClient(unknownWs as any);
  });

  it('disconnectAgent removes session and disconnects all clients', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    const client1 = new MockWebSocket();
    const client2 = new MockWebSocket();
    registry.connectClient(sessionId, client1 as any, mockReq());
    registry.connectClient(sessionId, client2 as any, mockReq());

    registry.disconnectAgent(agentWs as any);

    // Both clients should be closed
    assert.equal(client1.readyState, MockWebSocket.CLOSED);
    assert.equal(client2.readyState, MockWebSocket.CLOSED);

    // Subsequent connectClient should fail since session is gone
    const newClient = new MockWebSocket();
    const result = registry.connectClient(sessionId, newClient as any, mockReq());
    assert.equal(result, false);
  });

  it('disconnectAgent is no-op for unknown ws', () => {
    const unknownWs = new MockWebSocket();
    // Should not throw
    registry.disconnectAgent(unknownWs as any);
  });

  it('handleAgentMessage forwards agent.data to all clients', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    const client1 = new MockWebSocket();
    const client2 = new MockWebSocket();
    registry.connectClient(sessionId, client1 as any, mockReq());
    registry.connectClient(sessionId, client2 as any, mockReq());

    const payload = { type: 'output', surfaceId: 's1', payload: { data: 'aGVsbG8=' } };
    const rawData = JSON.stringify({ type: 'agent.data', payload });

    registry.handleAgentMessage(agentWs as any, rawData);

    // Both clients should receive the forwarded payload
    const msgs1 = client1.getSentJSON();
    assert.equal(msgs1.length, 1);
    assert.equal(msgs1[0].type, 'output');
    assert.equal(msgs1[0].payload.data, 'aGVsbG8=');

    const msgs2 = client2.getSentJSON();
    assert.equal(msgs2.length, 1);
    assert.equal(msgs2[0].type, 'output');
  });

  it('handleAgentMessage ignores heartbeat', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    const clientWs = new MockWebSocket();
    registry.connectClient(sessionId, clientWs as any, mockReq());

    const rawData = JSON.stringify({ type: 'agent.heartbeat' });
    registry.handleAgentMessage(agentWs as any, rawData);

    // Client should not receive anything
    assert.equal(clientWs.sentMessages.length, 0);
  });

  it('handleAgentMessage is no-op for unregistered agent', () => {
    const unknownWs = new MockWebSocket();
    const rawData = JSON.stringify({ type: 'agent.data', payload: { type: 'output' } });
    // Should not throw
    registry.handleAgentMessage(unknownWs as any, rawData);
  });

  it('handleClientMessage forwards to agent as client.data', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);
    agentWs.clear();

    const clientWs = new MockWebSocket();
    registry.connectClient(sessionId, clientWs as any, mockReq());
    agentWs.clear();

    const clientMsg = { type: 'input', surfaceId: 's1', payload: { data: 'bHM=' } };
    const rawData = JSON.stringify(clientMsg);

    registry.handleClientMessage(clientWs as any, rawData);

    // Agent should receive wrapped client.data message
    const msgs = agentWs.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'client.data');
    assert.deepEqual((msgs[0] as any).payload, clientMsg);
  });

  it('handleClientMessage is no-op for unregistered client', () => {
    const unknownWs = new MockWebSocket();
    const rawData = JSON.stringify({ type: 'input', surfaceId: 's1', payload: { data: '' } });
    // Should not throw
    registry.handleClientMessage(unknownWs as any, rawData);
  });

  it('getSessionsForUser returns correct sessions', () => {
    const agent1 = new MockWebSocket();
    const agent2 = new MockWebSocket();
    const agent3 = new MockWebSocket();

    const sid1 = registry.registerAgent('user-A', agent1 as any);
    const sid2 = registry.registerAgent('user-A', agent2 as any);
    const sid3 = registry.registerAgent('user-B', agent3 as any);

    const sessionsA = registry.getSessionsForUser('user-A');
    assert.equal(sessionsA.length, 2);
    const ids = sessionsA.map(s => s.sessionId).sort();
    assert.deepEqual(ids, [sid1, sid2].sort());

    const sessionsB = registry.getSessionsForUser('user-B');
    assert.equal(sessionsB.length, 1);
    assert.equal(sessionsB[0].sessionId, sid3);

    const sessionsC = registry.getSessionsForUser('user-C');
    assert.equal(sessionsC.length, 0);
  });

  it('getSessionsForUser includes viewer info', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    const clientWs = new MockWebSocket();
    registry.connectClient(sessionId, clientWs as any, mockReq({
      headers: { 'user-agent': 'TestBrowser/1.0' },
      remoteAddress: '10.0.0.5',
    }));

    const sessions = registry.getSessionsForUser('user-1');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].viewers.length, 1);
    assert.equal(sessions[0].viewers[0].ip, '10.0.0.5');
    assert.equal(sessions[0].viewers[0].userAgent, 'TestBrowser/1.0');
  });

  it('connectClient uses x-forwarded-for header for IP', () => {
    const agentWs = new MockWebSocket();
    const sessionId = registry.registerAgent('user-1', agentWs as any);

    const clientWs = new MockWebSocket();
    registry.connectClient(sessionId, clientWs as any, mockReq({
      headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
    }));

    const sessions = registry.getSessionsForUser('user-1');
    assert.equal(sessions[0].viewers[0].ip, '203.0.113.50');
  });
});
