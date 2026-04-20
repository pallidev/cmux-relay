import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWsHandler } from '../../../packages/relay/src/ws-handler.js';
import { SessionRegistry } from '../../../packages/relay/src/session-registry.js';
import { PairingRegistry } from '../../../packages/relay/src/pairing-registry.js';
import { initDatabase, createApiToken, upsertUser } from '../../../packages/relay/src/db.js';
import { MockWebSocket } from '../../helpers/mock-ws.js';
import { encodeMessage } from '../../../packages/shared/dist/index.js';
import type Database from 'better-sqlite3';
import type { IncomingMessage } from 'node:http';

const JWT_SECRET = 'test-relay-secret-key-at-least-32-chars';

function mockReq(url: string): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' } as any,
  } as IncomingMessage;
}

describe('ws-handler', () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let pairing: PairingRegistry;
  let wss: ReturnType<typeof createWsHandler>;

  before(() => {
    process.env.RELAY_JWT_SECRET = JWT_SECRET;
    db = initDatabase(':memory:');
  });

  after(() => {
    delete process.env.RELAY_JWT_SECRET;
    db.close();
  });

  beforeEach(() => {
    registry = new SessionRegistry();
    pairing = new PairingRegistry('http://localhost:3000');
    wss = createWsHandler(db, registry, pairing);
  });

  afterEach(() => {
    pairing.close();
  });

  describe('agent connection with token', () => {
    it('registers agent when token is valid', () => {
      const user = upsertUser(db, 'gh-1', 'user1', null);
      const rawToken = createApiToken(db, user.id, 'test-token');

      const ws = new MockWebSocket();
      const params = new URLSearchParams({ token: rawToken });

      wss.emit('connection', ws as any, mockReq('/ws/agent'), 'agent', params);

      const msgs = ws.getSentJSON();
      const sessionCreated = msgs.find((m: any) => m.type === 'session.created');
      assert.ok(sessionCreated, 'should receive session.created message');
      assert.ok((sessionCreated as any).sessionId);
    });

    it('closes connection when token is invalid', () => {
      const ws = new MockWebSocket();
      const params = new URLSearchParams({ token: 'invalid-token' });

      wss.emit('connection', ws as any, mockReq('/ws/agent'), 'agent', params);

      assert.equal(ws.readyState, 3); // CLOSED
    });
  });

  describe('agent connection without token (pairing)', () => {
    it('initiates pairing flow on agent.pair message', () => {
      const ws = new MockWebSocket();
      const params = new URLSearchParams();

      wss.emit('connection', ws as any, mockReq('/ws/agent'), 'agent', params);

      ws.simulateMessage(encodeMessage({ type: 'agent.pair' }));

      const msgs = ws.getSentJSON();
      const pairingWait = msgs.find((m: any) => m.type === 'pairing.wait');
      assert.ok(pairingWait, 'should receive pairing.wait message');
      assert.ok((pairingWait as any).code);
      assert.ok((pairingWait as any).url);
    });

    it('closes on agent.register without token', () => {
      const ws = new MockWebSocket();
      const params = new URLSearchParams();

      wss.emit('connection', ws as any, mockReq('/ws/agent'), 'agent', params);
      ws.simulateMessage(encodeMessage({ type: 'agent.register' }));

      assert.equal(ws.readyState, 3);
    });
  });

  describe('client connection', () => {
    it('closes when session ID is missing', () => {
      const ws = new MockWebSocket();
      const params = new URLSearchParams();

      wss.emit('connection', ws as any, mockReq('/ws/client'), 'client', params);

      assert.equal(ws.readyState, 3);
    });

    it('closes when session does not exist', () => {
      const ws = new MockWebSocket();
      const params = new URLSearchParams({ session: 'nonexistent' });

      wss.emit('connection', ws as any, mockReq('/ws/client'), 'client', params);

      assert.equal(ws.readyState, 3);
    });

    it('connects to existing session', () => {
      const agentWs = new MockWebSocket();
      const user = upsertUser(db, 'gh-2', 'user2', null);
      const rawToken = createApiToken(db, user.id, 'test-token-2');
      const agentParams = new URLSearchParams({ token: rawToken });

      wss.emit('connection', agentWs as any, mockReq('/ws/agent'), 'agent', agentParams);

      const sessionCreated = agentWs.getSentJSON().find((m: any) => m.type === 'session.created') as any;
      assert.ok(sessionCreated);

      // Now connect a client to that session
      const clientWs = new MockWebSocket();
      const clientParams = new URLSearchParams({ session: sessionCreated.sessionId });

      wss.emit('connection', clientWs as any, mockReq('/ws/client'), 'client', clientParams);

      assert.equal(clientWs.readyState, 1); // Still OPEN

      // Agent should be notified of client connection
      const clientConnected = agentWs.getSentJSON().find((m: any) => m.type === 'client.connected');
      assert.ok(clientConnected, 'agent should receive client.connected');
    });

    it('relays client messages to agent', () => {
      const agentWs = new MockWebSocket();
      const user = upsertUser(db, 'gh-3', 'user3', null);
      const rawToken = createApiToken(db, user.id, 'test-token-3');
      const agentParams = new URLSearchParams({ token: rawToken });

      wss.emit('connection', agentWs as any, mockReq('/ws/agent'), 'agent', agentParams);
      const sessionCreated = agentWs.getSentJSON().find((m: any) => m.type === 'session.created') as any;

      const clientWs = new MockWebSocket();
      const clientParams = new URLSearchParams({ session: sessionCreated.sessionId });
      wss.emit('connection', clientWs as any, mockReq('/ws/client'), 'client', clientParams);

      agentWs.clear();

      clientWs.simulateMessage(encodeMessage({ type: 'input', surfaceId: 's1', payload: { data: 'aGVsbG8=' } }));

      const agentMsgs = agentWs.getSentJSON();
      const relayed = agentMsgs.find((m: any) => m.type === 'client.data');
      assert.ok(relayed, 'agent should receive client.data');
    });
  });

  describe('agent disconnect', () => {
    it('removes agent from registry on close', () => {
      const agentWs = new MockWebSocket();
      const user = upsertUser(db, 'gh-4', 'user4', null);
      const rawToken = createApiToken(db, user.id, 'test-token-4');
      const agentParams = new URLSearchParams({ token: rawToken });

      wss.emit('connection', agentWs as any, mockReq('/ws/agent'), 'agent', agentParams);
      const sessionCreated = agentWs.getSentJSON().find((m: any) => m.type === 'session.created') as any;

      // Connect a client
      const clientWs = new MockWebSocket();
      const clientParams = new URLSearchParams({ session: sessionCreated.sessionId });
      wss.emit('connection', clientWs as any, mockReq('/ws/client'), 'client', clientParams);

      // Agent disconnects
      agentWs.close();

      // Client should be closed too
      assert.equal(clientWs.readyState, 3);
    });
  });
});
