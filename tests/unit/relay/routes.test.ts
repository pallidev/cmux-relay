import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleGithubAuth,
  handleGithubCallback,
  handleVapidKey,
  handlePairInfo,
  handlePairApprove,
  handlePairReject,
  handleAuthMe,
  handleListTokens,
  handleCreateToken,
  handleDeleteToken,
  handleListSessions,
  handlePushSubscribe,
  handlePushUnsubscribe,
  type RouteContext,
} from '../../../packages/relay/src/routes.js';
import { SessionRegistry } from '../../../packages/relay/src/session-registry.js';
import { PairingRegistry } from '../../../packages/relay/src/pairing-registry.js';
import { initDatabase, upsertUser, createApiToken } from '../../../packages/relay/src/db.js';
import { createSessionJwt } from '../../../packages/relay/src/auth.js';
import type Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';

const JWT_SECRET = 'test-relay-secret-key-at-least-32-chars';

function mockReq(overrides?: {
  url?: string;
  method?: string;
  cookie?: string;
  auth?: string;
  body?: string;
  userAgent?: string;
}): IncomingMessage {
  const headers: Record<string, string> = { host: 'localhost' };
  if (overrides?.cookie) headers.cookie = overrides.cookie;
  if (overrides?.auth) headers.authorization = overrides.auth;
  if (overrides?.userAgent) headers['user-agent'] = overrides.userAgent;

  return {
    url: overrides?.url ?? '/',
    method: overrides?.method || 'GET',
    headers,
    socket: { remoteAddress: '127.0.0.1' } as any,
    on(event: string, handler: (...args: any[]) => void) {
      if (event === 'data' && overrides?.body) handler(Buffer.from(overrides.body));
      if (event === 'end') handler();
    },
  } as unknown as IncomingMessage;
}

interface MockResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  writeHead(code: number, hdrs?: Record<string, string>): MockResponse;
  end(data?: string | Buffer): MockResponse;
}

function mockRes(): MockResponse {
  const result: MockResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    writeHead(code: number, hdrs?: Record<string, string>) {
      result.statusCode = code;
      if (hdrs) Object.assign(result.headers, hdrs);
      return result;
    },
    end(data?: string | Buffer) {
      result.body = typeof data === 'string' ? data : '';
      return result;
    },
  };
  return result;
}

function makeContext(overrides: {
  req?: IncomingMessage;
  res?: MockResponse;
  params?: Record<string, string>;
  user?: { sub: string; username: string } | null;
  db: Database.Database;
  registry: SessionRegistry;
  pairing: PairingRegistry;
}): RouteContext {
  return {
    req: overrides.req ?? mockReq(),
    res: (overrides.res ?? mockRes()) as unknown as ServerResponse,
    params: overrides.params ?? {},
    user: overrides.user !== undefined ? overrides.user : null,
    db: overrides.db,
    registry: overrides.registry,
    pairing: overrides.pairing,
  };
}

describe('routes', () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let pairing: PairingRegistry;

  before(() => {
    process.env.RELAY_JWT_SECRET = JWT_SECRET;
    process.env.GITHUB_CLIENT_ID = 'test-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    process.env.VAPID_PUBLIC_KEY_CACHE = 'test-vapid-key';
    db = initDatabase(':memory:');
  });

  after(() => {
    delete process.env.RELAY_JWT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.VAPID_PUBLIC_KEY_CACHE;
    db.close();
  });

  beforeEach(() => {
    registry = new SessionRegistry();
    pairing = new PairingRegistry('http://localhost:3000');
  });

  // ─── handleVapidKey ───

  describe('handleVapidKey', () => {
    it('returns VAPID public key when configured', async () => {
      const res = mockRes();
      const ctx = makeContext({ req: mockReq(), res, db, registry, pairing });
      await handleVapidKey(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.publicKey, 'test-vapid-key');
    });

    it('returns 503 when VAPID key not configured', async () => {
      const original = process.env.VAPID_PUBLIC_KEY_CACHE;
      delete process.env.VAPID_PUBLIC_KEY_CACHE;

      const res = mockRes();
      const ctx = makeContext({ req: mockReq(), res, db, registry, pairing });
      await handleVapidKey(ctx);
      assert.equal(res.statusCode, 503);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Push not configured');

      process.env.VAPID_PUBLIC_KEY_CACHE = original;
    });
  });

  // ─── handlePairInfo ───

  describe('handlePairInfo', () => {
    it('returns pairing info for valid code', async () => {
      const agentWs = { send: () => {}, readyState: 1 } as any;
      const { code } = pairing.createPairing(agentWs);

      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code },
        db,
        registry,
        pairing,
      });
      await handlePairInfo(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.code, code);
      assert.equal(body.exists, true);
    });

    it('returns exists=false for unknown code', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code: 'UNKNOWN' },
        db,
        registry,
        pairing,
      });
      await handlePairInfo(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.exists, false);
    });
  });

  // ─── handlePairApprove ───

  describe('handlePairApprove', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code: 'ABC123' },
        user: null,
        db,
        registry,
        pairing,
      });
      await handlePairApprove(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('approves valid pairing', async () => {
      const user = upsertUser(db, 'gh-approve-test', 'approveuser', null);
      const agentWs = { send: () => {}, readyState: 1, on: () => {} } as any;
      const { code } = pairing.createPairing(agentWs);

      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePairApprove(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });

    it('returns 404 for unknown pairing code', async () => {
      const user = upsertUser(db, 'gh-approve-404', 'approve404user', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code: 'NOTEXIST' },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePairApprove(ctx);
      assert.equal(res.statusCode, 404);
    });
  });

  // ─── handlePairReject ───

  describe('handlePairReject', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code: 'ABC123' },
        user: null,
        db,
        registry,
        pairing,
      });
      await handlePairReject(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('rejects valid pairing', async () => {
      const agentWs = { send: () => {}, readyState: 1, on: () => {} } as any;
      const { code } = pairing.createPairing(agentWs);
      const user = upsertUser(db, 'gh-reject-test', 'rejectuser', null);

      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePairReject(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });

    it('returns 404 for unknown pairing code', async () => {
      const user = upsertUser(db, 'gh-reject-404', 'reject404user', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { code: 'NOTEXIST' },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePairReject(ctx);
      assert.equal(res.statusCode, 404);
    });
  });

  // ─── handleAuthMe ───

  describe('handleAuthMe', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({ req: mockReq(), res, user: null, db, registry, pairing });
      await handleAuthMe(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('returns user info when authenticated', async () => {
      const user = upsertUser(db, 'gh-me-test', 'meuser', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleAuthMe(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.userId, user.id);
      assert.equal(body.username, 'meuser');
    });
  });

  // ─── handleListTokens ───

  describe('handleListTokens', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({ req: mockReq(), res, user: null, db, registry, pairing });
      await handleListTokens(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('returns empty list for user with no tokens', async () => {
      const user = upsertUser(db, 'gh-list-tokens-empty', 'listempty', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleListTokens(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 0);
    });

    it('returns tokens for authenticated user', async () => {
      const user = upsertUser(db, 'gh-list-tokens', 'listtokens', null);
      createApiToken(db, user.id, 'test-token');
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleListTokens(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.length, 1);
      assert.equal(body[0].name, 'test-token');
    });
  });

  // ─── handleCreateToken ───

  describe('handleCreateToken', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: '{}' }),
        res,
        user: null,
        db,
        registry,
        pairing,
      });
      await handleCreateToken(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('creates token and returns 201', async () => {
      const user = upsertUser(db, 'gh-create-token-route', 'createtokenroute', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: JSON.stringify({ name: 'my-new-token' }) }),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleCreateToken(ctx);
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.token);
      assert.ok(body.token.startsWith('sk_crx_'));
    });
  });

  // ─── handleDeleteToken ───

  describe('handleDeleteToken', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { id: 'some-id' },
        user: null,
        db,
        registry,
        pairing,
      });
      await handleDeleteToken(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('deletes token and returns 200', async () => {
      const user = upsertUser(db, 'gh-delete-token-route', 'deletetokenroute', null);
      createApiToken(db, user.id, 'to-delete');

      // Get token ID
      const tokens = db.prepare('SELECT id FROM api_tokens WHERE user_id = ?').all(user.id) as { id: string }[];
      const tokenId = tokens[0].id;

      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { id: tokenId },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleDeleteToken(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });

    it('returns 404 for unknown token', async () => {
      const user = upsertUser(db, 'gh-delete-token-404', 'deletetoken404', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        params: { id: 'nonexistent-id' },
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleDeleteToken(ctx);
      assert.equal(res.statusCode, 404);
    });
  });

  // ─── handleListSessions ───

  describe('handleListSessions', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({ req: mockReq(), res, user: null, db, registry, pairing });
      await handleListSessions(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('returns sessions for authenticated user', async () => {
      const user = upsertUser(db, 'gh-sessions-route', 'sessionsroute', null);
      const agentWs = { send: () => {}, readyState: 1, on: () => {}, close: () => {} } as any;
      registry.registerAgent(user.id, agentWs);

      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleListSessions(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
    });

    it('returns empty array when no sessions', async () => {
      const user = upsertUser(db, 'gh-no-sessions', 'nosessions', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq(),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handleListSessions(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 0);
    });
  });

  // ─── handlePushSubscribe ───

  describe('handlePushSubscribe', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: '{}' }),
        res,
        user: null,
        db,
        registry,
        pairing,
      });
      await handlePushSubscribe(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('subscribes with valid data', async () => {
      const user = upsertUser(db, 'gh-push-sub', 'pushsub', null);
      const subscription = {
        endpoint: 'https://push.example.com/subscribe/123',
        keys: { p256dh: 'key123', auth: 'auth123' },
      };
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: JSON.stringify(subscription), userAgent: 'TestAgent/1.0' }),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePushSubscribe(ctx);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });

    it('returns 400 for invalid subscription', async () => {
      const user = upsertUser(db, 'gh-push-sub-invalid', 'pushinvalid', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: JSON.stringify({ endpoint: '', keys: {} }) }),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePushSubscribe(ctx);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Invalid subscription');
    });
  });

  // ─── handlePushUnsubscribe ───

  describe('handlePushUnsubscribe', () => {
    it('returns 401 when not authenticated', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: '{}' }),
        res,
        user: null,
        db,
        registry,
        pairing,
      });
      await handlePushUnsubscribe(ctx);
      assert.equal(res.statusCode, 401);
    });

    it('returns 404 for nonexistent subscription', async () => {
      const user = upsertUser(db, 'gh-push-unsub-404', 'pushunsub404', null);
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ body: JSON.stringify({ endpoint: 'https://push.example.com/nonexist' }) }),
        res,
        user: { sub: user.id, username: user.username },
        db,
        registry,
        pairing,
      });
      await handlePushUnsubscribe(ctx);
      assert.equal(res.statusCode, 404);
    });
  });

  // ─── handleGithubAuth ───

  describe('handleGithubAuth', () => {
    it('redirects to GitHub authorization URL', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ url: '/api/auth/github' }),
        res,
        db,
        registry,
        pairing,
      });
      await handleGithubAuth(ctx);
      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.Location?.includes('github.com'));
    });

    it('includes pair parameter in state when provided', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ url: '/api/auth/github?pair=ABCD1234' }),
        res,
        db,
        registry,
        pairing,
      });
      await handleGithubAuth(ctx);
      assert.equal(res.statusCode, 302);
      // State is stored internally; we just verify redirect happened
      assert.ok(res.headers.Location);
    });
  });

  // ─── handleGithubCallback ───

  describe('handleGithubCallback', () => {
    it('returns 400 when code is missing', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ url: '/api/auth/github/callback?state=abc' }),
        res,
        db,
        registry,
        pairing,
      });
      await handleGithubCallback(ctx);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Invalid OAuth callback');
    });

    it('returns 400 when state is missing', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ url: '/api/auth/github/callback?code=abc' }),
        res,
        db,
        registry,
        pairing,
      });
      await handleGithubCallback(ctx);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Invalid OAuth callback');
    });

    it('returns 400 for invalid state', async () => {
      const res = mockRes();
      const ctx = makeContext({
        req: mockReq({ url: '/api/auth/github/callback?code=abc&state=invalid' }),
        res,
        db,
        registry,
        pairing,
      });
      await handleGithubCallback(ctx);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Invalid OAuth state');
    });
  });
});
