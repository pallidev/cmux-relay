import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { handleHttpRequest } from '../../../packages/relay/src/http-handler.js';
import { SessionRegistry } from '../../../packages/relay/src/session-registry.js';
import { PairingRegistry } from '../../../packages/relay/src/pairing-registry.js';
import { initDatabase, upsertUser, createApiToken } from '../../../packages/relay/src/db.js';
import { createSessionJwt } from '../../../packages/relay/src/auth.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';

const JWT_SECRET = 'test-relay-secret-key-at-least-32-chars';

function mockReq(url: string, opts?: { method?: string; cookie?: string; auth?: string; body?: string }): IncomingMessage {
  const headers: Record<string, string> = { host: 'localhost' };
  if (opts?.cookie) headers.cookie = opts.cookie;
  if (opts?.auth) headers.authorization = opts.auth;

  const req = {
    url,
    method: opts?.method || 'GET',
    headers,
    socket: { remoteAddress: '127.0.0.1' } as any,
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === 'data' && opts?.body) handler(Buffer.from(opts.body));
      if (event === 'end') handler();
    },
  } as unknown as IncomingMessage;
  return req;
}

function mockRes(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string> } {
  let body = '';
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    body,
    headers,
    writeHead(code: number, hdrs?: Record<string, string>) {
      (this as any).statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
      return this;
    },
    end(data?: string | Buffer) {
      (this as any).body = typeof data === 'string' ? data : '';
      return this;
    },
  } as any;
}

describe('http-handler', () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let pairing: PairingRegistry;

  before(() => {
    process.env.RELAY_JWT_SECRET = JWT_SECRET;
    process.env.GITHUB_CLIENT_ID = 'test-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    db = initDatabase(':memory:');
  });

  after(() => {
    delete process.env.RELAY_JWT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    db.close();
  });

  beforeEach(() => {
    registry = new SessionRegistry();
    pairing = new PairingRegistry('http://localhost:3000');
  });

  afterEach(() => {
    pairing.close();
  });

  describe('unauthenticated routes', () => {
    it('returns 401 for unknown path without auth', async () => {
      const req = mockReq('/api/unknown');
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 401);
    });

    it('returns 404 for unknown path with auth', async () => {
      const user = upsertUser(db, 'gh-404-test', 'notfound', null);
      const userJwt = await createSessionJwt(user.id, user.username);
      const req = mockReq('/api/unknown', { cookie: `relay_jwt=${userJwt}` });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 404);
    });

    it('redirects to GitHub for /api/auth/github', async () => {
      const req = mockReq('/api/auth/github');
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.Location?.includes('github.com'));
    });

    it('returns 400 for invalid OAuth callback (missing params)', async () => {
      const req = mockReq('/api/auth/github/callback');
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse((res as any).body);
      assert.equal(body.error, 'Invalid OAuth callback');
    });

    it('returns 400 for invalid OAuth state', async () => {
      const req = mockReq('/api/auth/github/callback?code=abc&state=invalid');
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 400);
      const body = JSON.parse((res as any).body);
      assert.equal(body.error, 'Invalid OAuth state');
    });

    it('returns pairing info for /api/pair/:code', async () => {
      const agentWs = { send: () => {}, readyState: 1 } as any;
      const { code } = pairing.createPairing(agentWs);

      const req = mockReq(`/api/pair/${code}`);
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.equal(body.code, code);
      assert.equal(body.exists, true);
    });
  });

  describe('authenticated routes', () => {
    let jwt: string;

    beforeEach(async () => {
      const user = upsertUser(db, 'gh-auth-test', 'authuser', null);
      jwt = await createSessionJwt(user.id, user.username);
    });

    it('returns user info for /api/auth/me', async () => {
      const req = mockReq('/api/auth/me', { cookie: `relay_jwt=${jwt}` });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.equal(body.username, 'authuser');
    });

    it('returns 401 without auth', async () => {
      const req = mockReq('/api/auth/me');
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 401);
    });

    it('authenticates via Bearer token', async () => {
      const req = mockReq('/api/auth/me', { auth: `Bearer ${jwt}` });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
    });

    it('lists API tokens for /api/tokens GET', async () => {
      const user = upsertUser(db, 'gh-tokens-test', 'tokenuser', null);
      const userJwt = await createSessionJwt(user.id, user.username);
      createApiToken(db, user.id, 'my-token');

      const req = mockReq('/api/tokens', { cookie: `relay_jwt=${userJwt}` });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].name, 'my-token');
    });

    it('creates API token for /api/tokens POST', async () => {
      const user = upsertUser(db, 'gh-create-token', 'createtoken', null);
      const userJwt = await createSessionJwt(user.id, user.username);

      const req = mockReq('/api/tokens', {
        method: 'POST',
        cookie: `relay_jwt=${userJwt}`,
        body: JSON.stringify({ name: 'new-token' }),
      });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 201);
      const body = JSON.parse((res as any).body);
      assert.ok(body.token);
      assert.ok(body.token.startsWith('sk_crx_'));
    });

    it('deletes API token for /api/tokens/:id DELETE', async () => {
      const user = upsertUser(db, 'gh-delete-token', 'deletetoken', null);
      const userJwt = await createSessionJwt(user.id, user.username);
      createApiToken(db, user.id, 'to-delete');

      // Get token ID
      const listReq = mockReq('/api/tokens', { cookie: `relay_jwt=${userJwt}` });
      const listRes = mockRes();
      await handleHttpRequest(listReq, listRes, db, registry, pairing);
      const tokens = JSON.parse((listRes as any).body);
      const tokenId = tokens[0].id;

      const req = mockReq(`/api/tokens/${tokenId}`, {
        method: 'DELETE',
        cookie: `relay_jwt=${userJwt}`,
      });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
    });

    it('returns sessions for /api/sessions GET', async () => {
      const user = upsertUser(db, 'gh-sessions-test', 'sessionuser', null);
      const userJwt = await createSessionJwt(user.id, user.username);
      const rawToken = createApiToken(db, user.id, 'agent-token');

      // Register an agent to create a session
      const agentWs = { send: () => {}, readyState: 1, on: () => {}, close: () => {} } as any;
      registry.registerAgent(user.id, agentWs);

      const req = mockReq('/api/sessions', { cookie: `relay_jwt=${userJwt}` });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.ok(Array.isArray(body));
    });

    it('approves pairing with auth', async () => {
      const agentWs = { send: () => {}, readyState: 1, on: () => {} } as any;
      const { code } = pairing.createPairing(agentWs);

      const req = mockReq(`/api/pair/${code}/approve`, {
        method: 'POST',
        cookie: `relay_jwt=${jwt}`,
      });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.equal(body.ok, true);
    });

    it('rejects pairing with auth', async () => {
      const agentWs = { send: () => {}, readyState: 1, on: () => {} } as any;
      const { code } = pairing.createPairing(agentWs);

      const req = mockReq(`/api/pair/${code}/reject`, {
        method: 'POST',
        cookie: `relay_jwt=${jwt}`,
      });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse((res as any).body);
      assert.equal(body.ok, true);
    });

    it('returns 401 for pairing approve without auth', async () => {
      const agentWs = { send: () => {}, readyState: 1, on: () => {} } as any;
      const { code } = pairing.createPairing(agentWs);

      const req = mockReq(`/api/pair/${code}/approve`, { method: 'POST' });
      const res = mockRes();
      await handleHttpRequest(req, res, db, registry, pairing);
      assert.equal(res.statusCode, 401);
    });
  });
});
